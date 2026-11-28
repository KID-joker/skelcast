import type * as t from '@babel/types';
import { applyEdits, boundaryImports, createConditionAnalyzer, importOffset, isLoader, loadingName, slice, uniqueName } from './ast.js';
import { declarationBindings, endOf, nodeName, startOf, isRenderFunction, parseSource, unwrapExpression, walk, type Ast } from '../compiler/ast.js';
import { type AnalysisContext, type ComponentInfo, type FileAnalysis } from './types.js';
import { targetBuilder } from './targets.js';
import { policyBindings, containsLiveJSX, liveJSX, fixedShellJSX } from './policy.js';

// Page discovery and codemods share immutable source syntax within an init run.
const componentCache = new WeakMap<t.File, readonly ComponentInfo[]>();

export function reactComponents(ast: t.File): readonly ComponentInfo[] {
  const cached = componentCache.get(ast);
  if (cached) return cached;
  const functions = new Map<string, ComponentInfo['node']>();
  const exports = new Map<string, string>();
  let anonymous: ComponentInfo['node'] | undefined;
  for (const s of ast.program.body) {
    const d = s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration' ? s.declaration ?? s : s;
    const bindings = [...declarationBindings(d)];
    for (const [name, fn] of bindings) if (isRenderFunction(fn)) functions.set(name, fn);
    if (s.type === 'ExportDefaultDeclaration') {
      const value = unwrapExpression(s.declaration);
      if (value?.type === 'Identifier') exports.set(value.name, 'default');
      else if (isRenderFunction(value)) {
        if (value.type !== 'ArrowFunctionExpression' && value.id) { functions.set(value.id.name, value); exports.set(value.id.name, 'default'); }
        else anonymous = value;
      }
    }
    if (s.type === 'ExportNamedDeclaration') {
      for (const [name] of bindings) exports.set(name, name);
      for (const spec of s.specifiers ?? []) if (spec.type === 'ExportSpecifier') exports.set(nodeName(spec.local)!, nodeName(spec.exported)!);
    }
  }
  const result = [...functions].filter(([name]) => /^[A-Z]/.test(name)).map(([name, node]) => ({ name, node, exported: exports.get(name) ?? name }));
  if (anonymous) result.push({ name: 'default', exported: 'default', node: anonymous });
  const components = result.filter(({ node }) => {
    let jsx = false;
    walk(node.body, n => { if (n !== node.body && isRenderFunction(n)) return false; if (['JSXElement', 'JSXFragment'].includes(n.type)) jsx = true; });
    return jsx;
  });
  componentCache.set(ast, components);
  return components;
}
interface EarlyLoader { guard: t.IfStatement; returned: t.ReturnStatement }
interface Region { node: Ast; pending: string; content: string; bindings: Record<string, boolean>; early?: EarlyLoader[] }
export function analyzeReact(ctx: AnalysisContext): FileAnalysis {
  const { sameCondition, pureCondition, pendingCondition } = createConditionAnalyzer();
  const result: FileAnalysis = { edits: [], targets: [], diagnostics: [] };
  const code = ctx.source, ast = ctx.ast ?? parseSource(code, ctx.file);
  const components = reactComponents(ast);
  const policies = policyBindings(ast,ctx.existing.componentPolicies);
  const boundaryNames = boundaryImports(ast, 'react');
  const boundary = [...boundaryNames][0] ?? uniqueName(code, '__SkelCastBoundary');
  const isBoundary = (node: Ast): node is t.JSXElement => node.type === 'JSXElement' && boundaryNames.has(nodeName(node.openingElement.name) ?? '');
  const pendingOf = (node: t.JSXElement) => {
    const prop = node.openingElement.attributes.find(a => a.type === 'JSXAttribute' && nodeName(a.name) === 'pending');
    return prop?.type === 'JSXAttribute' && prop.value?.type === 'JSXExpressionContainer' ? slice(code, prop.value.expression) : '';
  };
  const { imports, add: addTarget } = targetBuilder(ctx, result.targets);
  let artifactIndex = 0;
  for (const component of components) {
    const fn = component.node;
    if (fn.async) { result.diagnostics.push({ code: 'ASYNC_COMPONENT', file: ctx.file, message: `Skipped async component ${component.name}; SSR needs a framework adapter` }); continue; }
    const body = fn.body;
    const regions: Region[] = [];
    const knownFlags = new Set<string>();
    const dataFlags = new Map<string, string>();
    walk(body, n => {
      if (n !== body && isRenderFunction(n)) return false;
      if (n.type === 'VariableDeclarator') {
        if (n.id.type === 'ObjectPattern') {
          const properties = n.id.properties.filter(p => p.type === 'ObjectProperty');
          const flag = properties.find(p => loadingName(nodeName(p.key) ?? '') && p.value.type === 'Identifier');
          for (const prop of properties) {
            if (loadingName(nodeName(prop.key) ?? '') && prop.value.type === 'Identifier') knownFlags.add(prop.value.name);
            if (flag && /^(?:data|items|result|records)$/.test(nodeName(prop.key) ?? '') && prop.value.type === 'Identifier') dataFlags.set(prop.value.name, flag.value.type === 'Identifier' ? flag.value.name : '');
          }
        }
        if (n.id.type === 'ArrayPattern' && n.id.elements[0]?.type === 'Identifier' && loadingName(n.id.elements[0].name) && n.init?.type === 'CallExpression' && n.init.arguments[0]?.type === 'BooleanLiteral') knownFlags.add(n.id.elements[0].name);
      }
    });
    const mainReturn = body.type === 'BlockStatement' ? [...body.body].reverse().find((n): n is t.ReturnStatement => n.type === 'ReturnStatement' && !!n.argument) : undefined;
    const root = mainReturn?.argument ?? (body.type !== 'BlockStatement' ? body : undefined);
    if (!root) { result.diagnostics.push({ code: 'COMPLEX_RETURNS', file: ctx.file, message: `No simple final return in ${component.name}` }); continue; }
    const managed = (ancestors: Ast[], pending: string) => ancestors.some(n => isBoundary(n) && sameCondition(pendingOf(n), pending));
    const early: EarlyLoader[] = [];
    if (body.type === 'BlockStatement') for (const s of body.body) {
      if (s.type !== 'IfStatement' || s.alternate || !pendingCondition(slice(code, s.test), knownFlags)) continue;
      const ret = s.consequent.type === 'ReturnStatement' ? s.consequent : s.consequent.type === 'BlockStatement' && s.consequent.body.length === 1 ? s.consequent.body[0] : undefined;
      if (ret?.type === 'ReturnStatement' && ret.argument && isBoundary(unwrapExpression(ret.argument)!)) continue;
      if (ret?.type === 'ReturnStatement' && isLoader(ret.argument, code)) early.push({ guard: s, returned: ret });
    }
    if (early.length === 1) {
      const s = early[0], pending = slice(code, s.guard.test);
      regions.push({ node: root, pending, content: slice(code, root), bindings: { [pending]: false }, early });
    } else if (early.length > 1) result.diagnostics.push({ code: 'MULTIPLE_EARLY_LOADERS', file: ctx.file, message: `Multiple early loading guards in ${component.name}; preserved for manual review` });
    if (!early.length) walk(root, (node, ancestors) => {
      if (node !== root && isRenderFunction(node)) return false;
      if (node.type === 'ConditionalExpression' && pendingCondition(slice(code, node.test), knownFlags) && !managed(ancestors, slice(code, node.test)) && !managed(ancestors, `!(${slice(code, node.test)})`)) {
        const a = isLoader(node.consequent, code), b = isLoader(node.alternate, code);
        if (a !== b) {
          const test = slice(code, node.test);
          regions.push({ node, pending: a ? test : `!(${test})`, content: `{${test} ? ${a ? 'null' : slice(code, node.consequent)} : ${b ? 'null' : slice(code, node.alternate)}}`, bindings: { [test]: !a } });
          return false;
        }
        result.diagnostics.push({ code: 'AMBIGUOUS_LOADING_BRANCH', file: ctx.file, line: node.loc?.start.line ?? 1, message: 'Loading condition has no unambiguous placeholder branch; preserved' });
      }
      if (node.type === 'JSXElement') {
        const tag = nodeName(node.openingElement.name) ?? '';
        const attr = node.openingElement.attributes.find(a => a.type === 'JSXAttribute' && nodeName(a.name) === 'loading' && a.value?.type === 'JSXExpressionContainer');
        if (!isBoundary(node) && attr?.type === 'JSXAttribute' && attr.value?.type === 'JSXExpressionContainer' && !/button|input|select|link/i.test(tag)) {
          const pending = slice(code, attr.value.expression);
          if (pureCondition(pending) && !managed(ancestors, pending)) { regions.push({ node, pending, content: slice(code, node), bindings: { [pending]: false } }); return false; }
        }
      }
      if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression') && (node.callee.type === 'MemberExpression' || node.callee.type === 'OptionalMemberExpression') && nodeName(node.callee.property) === 'map') {
        let data = node.callee.object;
        while (data.type === 'MemberExpression' || data.type === 'OptionalMemberExpression') data = data.object;
        const pending = dataFlags.get(nodeName(data) ?? '');
        if (!pending || managed(ancestors, pending)) return;
        const nearestBoundary = ancestors.map(isBoundary).lastIndexOf(true);
        const container = ancestors.slice(nearestBoundary + 1).reverse().find(n => n.type === 'JSXElement' && /^(?:main|section|article|div|ul|ol)$/.test(nodeName(n.openingElement.name) ?? ''));
        let containsBoundary = false;
        if (container) walk(container, n => { if (isBoundary(n)) containsBoundary = true; });
        if (containsBoundary) return;
        if (container && !regions.some(r => startOf(r.node) <= startOf(container) && endOf(r.node) >= endOf(container))) {
          regions.push({ node: container, pending, content: slice(code, container), bindings: { [pending]: false } });
        }
      }
    });
    const narrowed: Region[] = [];
    const narrow = (region: Region) => {
      if(!containsLiveJSX(region.node,policies)){narrowed.push(region);return;}
      if(region.early?.length){result.diagnostics.push({code:'LIVE_CONTENT_IN_BOUNDARY',file:ctx.file,line:region.node.loc?.start.line??1,message:'Early loading return contains live content; move the loading guard to its data region to keep the widget mounted'});return;}
      const partition = (node:Ast):boolean => {
        if(liveJSX(node,policies))return true;
        if(!containsLiveJSX(node,policies)){
          if(node.type==='JSXText'||node.type==='JSXExpressionContainer'&&node.expression.type==='JSXEmptyExpression'||fixedShellJSX(node))return true;
          if(node.type!=='JSXElement'&&node.type!=='JSXExpressionContainer')return false;
          narrowed.push({...region,node,content:slice(code,node)});return true;
        }
        if(node.type==='JSXFragment')return node.children.every(partition);
        if(node.type!=='JSXElement'||!/^(?:main|section|article|div|form)$/.test(nodeName(node.openingElement.name)??''))return false;
        const loading=node.openingElement.attributes.find(a=>a.type==='JSXAttribute'&&nodeName(a.name)==='loading');
        if(loading)result.edits.push({start:startOf(loading),end:endOf(loading),text:''});
        return node.children.every(partition);
      };
      const start=narrowed.length,editStart=result.edits.length;
      if(!partition(region.node)){narrowed.length=start;result.edits.length=editStart;result.diagnostics.push({code:'LIVE_CONTENT_IN_BOUNDARY',file:ctx.file,line:region.node.loc?.start.line??1,message:'Live content shares a conditional or component layout with loading data; narrow this boundary in source'});}
    };
    for(const region of regions)narrow(region);
    walk(root,n=>{if(isBoundary(n)&&containsLiveJSX(n,policies))result.diagnostics.push({code:'LIVE_CONTENT_IN_BOUNDARY',file:ctx.file,line:n.loc?.start.line??1,message:'Existing boundary contains live content; move the widget outside it or split its data regions'});});
    const selected: Region[] = [];
    let selectedEnd = -Infinity;
    for (const region of narrowed.sort((a, b) => startOf(a.node) - startOf(b.node) || endOf(b.node) - endOf(a.node))) {
      if (endOf(region.node) <= selectedEnd) continue;
      selected.push(region);
      selectedEnd = endOf(region.node);
    }
    const existingPage = ctx.existing.targets.some(target => target.kind === 'page' && ast.program.body.some(statement => statement.type === 'ImportDeclaration' && statement.source.value === `virtual:skelcast/${target.id}` && statement.specifiers.some(s => s.local.name === target.region)) && (!target.export || target.export === component.exported));
    const isPage = !existingPage && !isBoundary(root) && ctx.page && (component.exported === 'default' || /Page$/.test(component.name) || components.length === 1);
    const pageBindings: Record<string, boolean> = {};
    let pageRegion = false;
    const add = (node: Ast, kind: 'page' | 'request', pending: string, content: string, bindings: Record<string, boolean>, early?: EarlyLoader[]) => {
      const suffix = kind === 'page' ? 'page' : `${component.name === 'default' ? '' : `${component.name.toLowerCase()}.`}loading-${++artifactIndex}`;
      const artifact = addTarget({ suffix, kind, bindings, export: component.exported });
      let child = content;
      if (child && !child.startsWith('{') && !/^\s*</.test(child)) child = `{${child}}`;
      result.edits.push({ start: startOf(node), end: endOf(node), text: `<${boundary} artifact={${artifact}} pending={${pending}}>{/* skelcast:init */}${child}</${boundary}>` });
      for (const { returned: ret } of early ?? []) {
        if (!ret.argument) continue;
        result.edits.push({ start: startOf(ret.argument), end: endOf(ret.argument), text: `<${boundary} artifact={${artifact}} pending={${pending}} />` });
      }
    };
    for (const region of selected) {
      if (startOf(region.node) !== startOf(root) && region.node.type === 'JSXElement' && ['tr', 'td', 'th', 'tbody', 'thead', 'tfoot', 'li', 'option'].includes(nodeName(region.node.openingElement.name) ?? '')) {
        result.diagnostics.push({ code: 'UNSAFE_CONTAINER', file: ctx.file, message: 'Preserved table/list item boundary; select its enclosing block manually' }); continue;
      }
      Object.assign(pageBindings, region.bindings);
      const kind = isPage && region.node === root ? 'page' : 'request';
      if (kind === 'page') pageRegion = true;
      // Early guards keep business evaluation order; only their return value changes.
      add(region.node, kind, region.pending, region.content, region.bindings, region.early);
    }
    if (isPage && containsLiveJSX(root,policies))result.diagnostics.push({code:'PAGE_LIVE_CONTENT',file:ctx.file,message:'Keep live widgets and page shell mounted; generate independent request regions instead of a whole-page boundary'});
    if (isPage && !pageRegion && !early.length && !containsLiveJSX(root,policies)) {
      const artifact = addTarget({ suffix: 'page', kind: 'page', bindings: pageBindings, export: component.exported });
      result.edits.push({ start: startOf(root), end: startOf(root), text: `<${boundary} artifact={${artifact}} pending={false}>{/* skelcast:init */}{` }, { start: endOf(root), end: endOf(root), text: `}</${boundary}>` });
    }
  }
  if (result.targets.length) {
    const offset = importOffset(ast);
    result.edits.push({ start: offset, end: offset, text: `\n${boundaryNames.size ? '' : `import { LoadingBoundary as ${boundary} } from 'skelcast/react';\n`}${imports.join('\n')}\n` });
    parseSource(applyEdits(code, result.edits), ctx.file);
  }
  return result;
}
