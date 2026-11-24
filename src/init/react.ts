import { applyEdits, importOffset, isFunction, isLoader, loadingName, parseCode, pendingCondition, pureCondition, slice, uniqueName, unwrap, walk, type Ast } from './ast.js';
import { targetId, type AnalysisContext, type ComponentInfo, type FileAnalysis } from './types.js';
import type { SkeletonTarget } from '../types.js';

export function reactComponents(ast: Ast): ComponentInfo[] {
  const functions = new Map<string, Ast>();
  const exports = new Map<string, string>();
  let anonymous: Ast | undefined;
  for (const s of ast.program.body) {
    const d = s.declaration ?? s;
    if (d.type === 'FunctionDeclaration' && d.id) functions.set(d.id.name, d);
    if (d.type === 'VariableDeclaration') for (const v of d.declarations) {
      let fn = unwrap(v.init);
      if (fn?.type === 'CallExpression' && ['memo', 'forwardRef'].includes(fn.callee.name)) fn = fn.arguments[0];
      if (v.id.type === 'Identifier' && isFunction(fn)) functions.set(v.id.name, fn);
    }
    if (s.type === 'ExportDefaultDeclaration') {
      const value = unwrap(s.declaration);
      if (value.type === 'Identifier') exports.set(value.name, 'default');
      else if (isFunction(value)) {
        if (value.id) { functions.set(value.id.name, value); exports.set(value.id.name, 'default'); }
        else anonymous = value;
      }
    }
    if (s.type === 'ExportNamedDeclaration') {
      if (d.id) exports.set(d.id.name, d.id.name);
      if (d.type === 'VariableDeclaration') for (const v of d.declarations) if (v.id.name) exports.set(v.id.name, v.id.name);
      for (const spec of s.specifiers ?? []) if (spec.local?.name) exports.set(spec.local.name, spec.exported.name);
    }
  }
  const result = [...functions].filter(([name]) => /^[A-Z]/.test(name)).map(([name, node]) => ({ name, node, exported: exports.get(name) ?? name }));
  if (anonymous) result.push({ name: 'default', exported: 'default', node: anonymous });
  return result.filter(({ node }) => {
    let jsx = false;
    walk(node.body, n => { if (n !== node.body && isFunction(n)) return false; if (['JSXElement', 'JSXFragment'].includes(n.type)) jsx = true; });
    return jsx;
  });
}
interface Region { node: Ast; pending: string; content: string; bindings: Record<string, boolean>; early?: Ast[] }
export function analyzeReact(ctx: AnalysisContext): FileAnalysis {
  const result: FileAnalysis = { edits: [], targets: [], diagnostics: [] };
  const code = ctx.source, ast = parseCode(code);
  const components = reactComponents(ast);
  const boundary = uniqueName(code, '__SkelCastBoundary');
  const imports: string[] = [];
  let artifactIndex = 0;
  for (const component of components) {
    const fn = component.node;
    if (fn.async) { result.diagnostics.push({ code: 'ASYNC_COMPONENT', file: ctx.file, message: `Skipped async component ${component.name}; SSR needs a framework adapter` }); continue; }
    const body = fn.body;
    if (slice(code, body).includes('/* skelcast:init */')) continue;
    let alreadyWrapped = false;
    walk(body, n => { if (n.type === 'JSXOpeningElement' && /SkelCastBoundary|LoadingBoundary/.test(n.name.name ?? '')) alreadyWrapped = true; });
    if (alreadyWrapped) { result.diagnostics.push({ code: 'ALREADY_INTEGRATED', file: ctx.file, message: `Preserved existing boundary in ${component.name}` }); continue; }
    const regions: Region[] = [];
    const knownFlags = new Set<string>();
    const dataFlags = new Map<string, string>();
    walk(body, n => {
      if (n !== body && isFunction(n)) return false;
      if (n.type === 'VariableDeclarator') {
        if (n.id.type === 'ObjectPattern') {
          const flag = n.id.properties.find((p: Ast) => loadingName(p.key?.name ?? '') && p.value?.type === 'Identifier');
          for (const prop of n.id.properties) {
            if (loadingName(prop.key?.name ?? '') && prop.value?.type === 'Identifier') knownFlags.add(prop.value.name);
            if (flag && /^(?:data|items|result|records)$/.test(prop.key?.name ?? '') && prop.value?.type === 'Identifier') dataFlags.set(prop.value.name, flag.value.name);
          }
        }
        if (n.id.type === 'ArrayPattern' && n.id.elements[0]?.name && loadingName(n.id.elements[0].name) && n.init?.type === 'CallExpression' && n.init.arguments[0]?.type === 'BooleanLiteral') knownFlags.add(n.id.elements[0].name);
      }
    });
    const mainReturn = body.type === 'BlockStatement' ? body.body.findLast((n: Ast) => n.type === 'ReturnStatement' && n.argument) : undefined;
    const root = mainReturn?.argument ?? (body.type !== 'BlockStatement' ? body : undefined);
    if (!root) { result.diagnostics.push({ code: 'COMPLEX_RETURNS', file: ctx.file, message: `No simple final return in ${component.name}` }); continue; }
    const early: Ast[] = [];
    if (body.type === 'BlockStatement') for (const s of body.body) {
      if (s.type !== 'IfStatement' || s.alternate || !pendingCondition(slice(code, s.test), knownFlags)) continue;
      const ret = s.consequent.type === 'ReturnStatement' ? s.consequent : s.consequent.type === 'BlockStatement' && s.consequent.body.length === 1 ? s.consequent.body[0] : undefined;
      if (ret?.type === 'ReturnStatement' && isLoader(ret.argument, code)) early.push(s);
    }
    if (early.length === 1) {
      const s = early[0], pending = slice(code, s.test);
      regions.push({ node: root, pending, content: slice(code, root), bindings: { [pending]: false }, early });
    } else if (early.length > 1) result.diagnostics.push({ code: 'MULTIPLE_EARLY_LOADERS', file: ctx.file, message: `Multiple early loading guards in ${component.name}; preserved for manual review` });
    if (!early.length) walk(root, (node, ancestors) => {
      if (node !== root && isFunction(node)) return false;
      if (node.type === 'ConditionalExpression' && pendingCondition(slice(code, node.test), knownFlags)) {
        const a = isLoader(node.consequent, code), b = isLoader(node.alternate, code);
        if (a !== b) {
          const test = slice(code, node.test);
          regions.push({ node, pending: a ? test : `!(${test})`, content: `{${test} ? ${a ? 'null' : slice(code, node.consequent)} : ${b ? 'null' : slice(code, node.alternate)}}`, bindings: { [test]: !a } });
          return false;
        }
        result.diagnostics.push({ code: 'AMBIGUOUS_LOADING_BRANCH', file: ctx.file, line: node.loc.start.line, message: 'Loading condition has no unambiguous placeholder branch; preserved' });
      }
      if (node.type === 'JSXElement') {
        const tag = node.openingElement.name.name ?? '';
        const attr = node.openingElement.attributes.find((a: Ast) => a.type === 'JSXAttribute' && a.name.name === 'loading' && a.value?.type === 'JSXExpressionContainer');
        if (attr && !/button|input|select|link/i.test(tag)) {
          const pending = slice(code, attr.value.expression);
          if (pureCondition(pending)) { regions.push({ node, pending, content: slice(code, node), bindings: { [pending]: false } }); return false; }
        }
      }
      if (['CallExpression', 'OptionalCallExpression'].includes(node.type) && ['MemberExpression', 'OptionalMemberExpression'].includes(node.callee.type) && node.callee.property.name === 'map') {
        let data = node.callee.object;
        while (['MemberExpression', 'OptionalMemberExpression'].includes(data.type)) data = data.object;
        const pending = dataFlags.get(data.name);
        if (!pending) return;
        const container = [...ancestors].reverse().find(n => n.type === 'JSXElement' && /^(?:main|section|article|div|ul|ol)$/.test(n.openingElement.name.name));
        if (container && !regions.some(r => r.node.start <= container.start && r.node.end >= container.end)) {
          regions.push({ node: container, pending, content: slice(code, container), bindings: { [pending]: false } });
        }
      }
    });
    const selected = regions.sort((a, b) => a.node.start - b.node.start || b.node.end - a.node.end).filter((r, i, all) => !all.slice(0, i).some(p => p.node.start <= r.node.start && p.node.end >= r.node.end));
    const isPage = ctx.page && (component.exported === 'default' || /Page$/.test(component.name) || components.length === 1);
    const pageBindings: Record<string, boolean> = {};
    let pageRegion = false;
    const add = (node: Ast, kind: 'page' | 'request', pending: string, content: string, bindings: Record<string, boolean>, early?: Ast[]) => {
      const id = targetId(ctx, kind === 'page' ? 'page' : `${component.name === 'default' ? '' : `${component.name.toLowerCase()}.`}loading-${++artifactIndex}`);
      const artifact = uniqueName(code + imports.join('\n'), `__skelcast${result.targets.length}`);
      imports.push(`import ${artifact} from 'virtual:skelcast/${id}';`);
      const target: SkeletonTarget = { id, source: ctx.file, export: component.exported, kind, region: artifact, hints: { bindings } };
      if (kind === 'page' && ctx.routes.length) target.route = ctx.routes.length === 1 ? ctx.routes[0] : ctx.routes;
      result.targets.push(target);
      let child = content;
      if (child && !child.startsWith('{') && !/^\s*</.test(child)) child = `{${child}}`;
      result.edits.push({ start: node.start, end: node.end, text: `<${boundary} artifact={${artifact}} pending={${pending}}>{/* skelcast:init */}${child}</${boundary}>` });
      for (const guard of early ?? []) {
        const ret = guard.consequent.type === 'ReturnStatement' ? guard.consequent : guard.consequent.body[0];
        result.edits.push({ start: ret.argument.start, end: ret.argument.end, text: `<${boundary} artifact={${artifact}} pending={${pending}} />` });
      }
    };
    for (const region of selected) {
      if (region.node.start !== root.start && ['tr', 'td', 'th', 'tbody', 'thead', 'tfoot', 'li', 'option'].includes(region.node.openingElement?.name?.name)) {
        result.diagnostics.push({ code: 'UNSAFE_CONTAINER', file: ctx.file, message: 'Preserved table/list item boundary; select its enclosing block manually' }); continue;
      }
      Object.assign(pageBindings, region.bindings);
      const kind = isPage && region.node === root ? 'page' : 'request';
      if (kind === 'page') pageRegion = true;
      // Early guards keep business evaluation order; only their return value changes.
      add(region.node, kind, region.pending, region.content, region.bindings, region.early);
    }
    if (isPage && !pageRegion && !early.length) {
      const id = targetId(ctx, 'page');
      const artifact = uniqueName(code + imports.join('\n'), `__skelcast${result.targets.length}`);
      imports.push(`import ${artifact} from 'virtual:skelcast/${id}';`);
      const target: SkeletonTarget = { id, source: ctx.file, export: component.exported, kind: 'page', region: artifact, hints: { bindings: pageBindings } };
      if (ctx.routes.length) target.route = ctx.routes.length === 1 ? ctx.routes[0] : ctx.routes;
      result.targets.push(target);
      result.edits.push({ start: root.start, end: root.start, text: `<${boundary} artifact={${artifact}} pending={false}>{/* skelcast:init */}{` }, { start: root.end, end: root.end, text: `}</${boundary}>` });
    }
  }
  if (result.targets.length) {
    const offset = importOffset(ast);
    result.edits.push({ start: offset, end: offset, text: `\nimport { LoadingBoundary as ${boundary} } from 'skelcast/react';\n${imports.join('\n')}\n` });
    parseCode(applyEdits(code, result.edits));
  }
  return result;
}
