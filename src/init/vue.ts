import { parse as parseSFC } from '@vue/compiler-sfc';
import { parse as parseDOM, type ElementNode, type TemplateChildNode, type DirectiveNode } from '@vue/compiler-dom';
import { applyEdits, boundaryImports, createConditionAnalyzer, importOffset, loadingName, objectConfig, uniqueName, type Edit } from './ast.js';
import { startOf, nodeName, parseSource, walk } from '../compiler/ast.js';
import { type AnalysisContext, type FileAnalysis } from './types.js';
import { targetBuilder } from './targets.js';
import { policyBindings, containsLiveVue, liveVue, fixedShellVue } from './policy.js';

const directive = (node: ElementNode, name: string) => node.props.find((p): p is DirectiveNode => p.type === 7 && p.name === name);
const contentOf = (text: string, node: ElementNode) => text.slice(node.loc.start.offset, node.loc.end.offset);
const loader = (node: ElementNode) => /loader|loading|spinner|skeleton|progress/i.test(node.tag ?? '') || /loading|加载|请稍候/i.test((node.children ?? []).filter(n => n.type === 2).map(n => n.content).join(''));
export function analyzeVue(ctx: AnalysisContext): FileAnalysis {
  const { sameCondition, pureCondition, pendingCondition } = createConditionAnalyzer();
  const result: FileAnalysis = { edits: [], targets: [], diagnostics: [] };
  const { descriptor, errors } = ctx.sfc ?? parseSFC(ctx.source, { filename: ctx.file });
  if (errors.length) throw new Error(String(errors[0]));
  const template = descriptor.template;
  if (!template || template.src || template.lang && template.lang !== 'html') {
    result.diagnostics.push({ code: 'VUE_TEMPLATE_UNSUPPORTED', file: ctx.file, message: 'External or preprocessed templates need an adapter' }); return result;
  }
  const scripts = [descriptor.script, descriptor.scriptSetup].filter((script): script is NonNullable<typeof descriptor.script> => script != null);
  // A single script has the same local offsets as the scan AST. With both
  // script forms, edits need block-local offsets rather than the combined AST.
  const scriptAsts = new Map(scripts.map(script => [script, scripts.length === 1 && ctx.ast ? ctx.ast : parseSource(script.content, ctx.file, script.lang === 'jsx' || script.lang === 'tsx')]));
  const scriptAst = (script: NonNullable<typeof descriptor.script>) => scriptAsts.get(script)!;
  const policies = new Map([...Object.entries(ctx.existing.componentPolicies??{}),...scripts.flatMap(script=>[...policyBindings(scriptAst(script),ctx.existing.componentPolicies)])]);
  const boundaryNames = new Set<string>();
  for (const script of scripts) for (const name of boundaryImports(scriptAst(script), 'vue')) boundaryNames.add(name);
  const normalize = (name: string) => name.replace(/-/g, '').toLowerCase();
  const registeredNames = new Set([...boundaryNames].map(normalize));
  let optionBoundary: string | undefined;
  if (descriptor.script) {
    const config = objectConfig(scriptAst(descriptor.script));
    const components = config?.properties.find(p => p.type === 'ObjectProperty' && nodeName(p.key) === 'components');
    if (components?.type === 'ObjectProperty' && components.value.type === 'ObjectExpression') {
      for(const prop of components.value.properties)if(prop.type==='ObjectProperty'){
        const name=nodeName(prop.key),policy=policies.get(nodeName(prop.value)??'');
        if(name&&policy)policies.set(name,policy);
      }
      for (const prop of components.value.properties) if (prop.type === 'ObjectProperty' && boundaryNames.has(nodeName(prop.value) ?? '')) {
        const name = nodeName(prop.key)!;
        registeredNames.add(normalize(name));
        optionBoundary ??= name;
      }
    }
  }
  const isBoundary = (node: ElementNode) => registeredNames.has(normalize(node.tag));
  const flags = new Set<string>();
  for (const script of scripts) walk(scriptAst(script), n => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern') for (const p of n.id.properties) if (p.type === 'ObjectProperty' && loadingName(nodeName(p.key) ?? '') && p.value.type === 'Identifier') flags.add(p.value.name);
  });
  if (scripts.some(s => s.src)) { result.diagnostics.push({ code: 'VUE_SCRIPT_EXTERNAL', file: ctx.file, message: 'External scripts need manual boundary registration' }); return result; }
  const boundary = descriptor.scriptSetup ? [...boundaryNames][0] ?? uniqueName(ctx.source, 'SkelCastBoundary') : optionBoundary ?? uniqueName(ctx.source, 'SkelCastBoundary');
  const reuseImport = !!optionBoundary || !!descriptor.scriptSetup && boundaryNames.size > 0;
  const text = template.content;
  const ast = parseDOM(text);
  const edits: Edit[] = [];
  const { imports, add: addTarget } = targetBuilder(ctx, result.targets);
  const allBindings: Record<string, boolean> = {};
  let index = 0;
  const rootNodes = ast.children.filter(n => n.type !== 3 && !(n.type === 2 && !n.content.trim()));
  const hasPage = rootNodes.some(n => n.type === 1 && isBoundary(n));
  const add = (start: number, end: number, html: string, pending: string, bindings: Record<string, boolean>, kind: 'page' | 'request') => {
    const artifact = addTarget({ suffix: kind === 'page' ? 'page' : `loading-${++index}`, kind, bindings });
    Object.assign(allBindings, bindings);
    edits.push({ start, end, text: `<${boundary} :artifact="${artifact}" :pending="${pending.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"><!-- skelcast:init -->${html}</${boundary}>` });
  };
  const scan = (nodes: TemplateChildNode[], managed: string[] = []) => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.type !== 1) continue;
      if (isBoundary(node)) {
        if(containsLiveVue(node.children,policies))result.diagnostics.push({code:'LIVE_CONTENT_IN_BOUNDARY',file:ctx.file,line:template.loc.start.line+node.loc.start.line-1,message:'Existing boundary contains live content; move the widget outside it or split its data regions'});
        const pending = node.props.find((p): p is DirectiveNode => p.type === 7 && p.name === 'bind' && p.arg?.type === 4 && p.arg.content === 'pending');
        scan(node.children, pending?.exp?.type === 4 ? [...managed, pending.exp.content] : managed);
        continue;
      }
      if(liveVue(node,policies))continue;
      if (['tr', 'td', 'th', 'tbody', 'thead', 'tfoot', 'li', 'option'].includes(node.tag)) {
        if (directive(node, 'loading')) result.diagnostics.push({ code: 'UNSAFE_CONTAINER', file: ctx.file, message: 'Select the enclosing table/list container for a block boundary' });
        continue;
      }
      const condition = directive(node, 'if');
      const expr = condition?.exp?.type === 4 ? condition.exp.content : undefined;
      if (expr && pendingCondition(expr, flags) && !managed.some(value => sameCondition(value, expr) || sameCondition(value, `!(${expr})`) || sameCondition(expr, `!(${value})`))) {
        let j = i + 1;
        while (j < nodes.length) {
          const sibling = nodes[j];
          if (sibling.type !== 3 && !(sibling.type === 2 && !sibling.content.trim())) break;
          j++;
        }
        const alternate = nodes[j];
        const elseDirective = alternate?.type === 1 ? directive(alternate, 'else') : undefined;
        if (alternate?.type === 1 && elseDirective && loader(node) !== loader(alternate)) {
          const firstIsLoader = loader(node), content = firstIsLoader ? alternate : node;
          const pending = firstIsLoader ? expr : `!(${expr})`;
          if(containsLiveVue([content],policies)){
            result.diagnostics.push({code:'LIVE_CONTENT_IN_BOUNDARY',file:ctx.file,line:template.loc.start.line+content.loc.start.line-1,message:'Loading branch contains live content; move its guard to the data region before adding a boundary'});
            i=j;continue;
          }
          let html = contentOf(text, content);
          if (firstIsLoader) {
            const offset = elseDirective.loc.start.offset - content.loc.start.offset;
            html = html.slice(0, offset) + `v-if="!(${expr.replace(/"/g, '&quot;')})"` + html.slice(offset + elseDirective.loc.source.length);
          }
          const root = !hasPage && ctx.page && rootNodes.length === 2 && rootNodes[0] === node && rootNodes[1] === alternate;
          add(node.loc.start.offset, alternate.loc.end.offset, html, pending, { [expr]: !firstIsLoader }, root ? 'page' : 'request');
          i = j; continue;
        }
        if (loader(node) && !elseDirective) {
          result.diagnostics.push({ code: 'UNPAIRED_LOADING', file: ctx.file, line: template.loc.start.line + node.loc.start.line - 1, message: 'Loading placeholder has no matching content branch; preserved' });
        }
      }
      const loading = directive(node, 'loading');
      const boundLoading = node.props.find((p): p is DirectiveNode => p.type === 7 && p.name === 'bind' && p.arg?.type === 4 && p.arg.content === 'loading');
      const expression = (loading ?? boundLoading)?.exp;
      const pending = expression?.type === 4 ? expression.content : undefined;
      if (pending && !/button|input|select|link/i.test(node.tag) && pureCondition(pending) && !managed.some(value => sameCondition(value, pending))) {
        if(containsLiveVue([node],policies)){
          const selected:ElementNode[]=[];
          const removals:Edit[]=[];
          const partition=(child:TemplateChildNode):boolean=>{
            if(child.type!==1)return true;
            if(liveVue(child,policies))return true;
            if(!containsLiveVue([child],policies)){if(!fixedShellVue(child))selected.push(child);return true;}
            if(!/^(?:main|section|article|div|form)$/.test(child.tag)||child.props.some(p=>p.type===7&&['if','else','else-if','for','show'].includes(p.name)))return false;
            const original=child.props.find(p=>p.type===7&&(p.name==='loading'||p.name==='bind'&&p.arg?.type===4&&p.arg.content==='loading'));
            if(original)removals.push({start:original.loc.start.offset,end:original.loc.end.offset,text:''});
            return child.children.every(partition);
          };
          if(partition(node)){
            edits.push(...removals);
            for(const child of selected)add(child.loc.start.offset,child.loc.end.offset,contentOf(text,child),pending,{[pending]:false},'request');
          }else result.diagnostics.push({code:'LIVE_CONTENT_IN_BOUNDARY',file:ctx.file,line:template.loc.start.line+node.loc.start.line-1,message:'Live content shares a conditional or component layout with loading data; narrow this boundary in source'});
          continue;
        }
        let html = contentOf(text, node);
        if (loading) {
          const offset = loading.loc.start.offset - node.loc.start.offset;
          html = html.slice(0, offset) + html.slice(offset + loading.loc.source.length);
        }
        add(node.loc.start.offset, node.loc.end.offset, html, pending, { [pending]: false }, !hasPage && ctx.page && rootNodes.length === 1 && rootNodes[0] === node ? 'page' : 'request'); continue;
      }
      scan(node.children ?? [], managed);
    }
  };
  scan(ast.children);
  if(ctx.page&&!hasPage&&containsLiveVue(ast.children,policies))result.diagnostics.push({code:'PAGE_LIVE_CONTENT',file:ctx.file,message:'Keep live widgets and page shell mounted; generate independent request regions instead of a whole-page boundary'});
  if (ctx.page && !hasPage && !result.targets.some(t => t.kind === 'page') && !containsLiveVue(ast.children,policies)) {
    result.diagnostics.push({ code: 'PAGE_PREVIEW_ONLY', file: ctx.file, message: 'Page preview has no source-proven pending state. Existing request boundaries remain independent; connect an explicit pending state for real page loading.' });
    const artifact = addTarget({ suffix: 'page', kind: 'page', bindings: allBindings });
    edits.push({ start: 0, end: 0, text: `<${boundary} :artifact="${artifact}" :pending="false"><!-- skelcast:init -->` }, { start: text.length, end: text.length, text: `</${boundary}>` });
  }
  if (!result.targets.length) return result;
  const importCode = `\n${reuseImport ? '' : `import { LoadingBoundary as ${boundary} } from 'skelcast/vue';\n`}${imports.join('\n')}\n`;
  if (descriptor.scriptSetup) {
    const script = descriptor.scriptSetup;
    const offset = script.loc.start.offset + importOffset(scriptAst(script));
    result.edits.push({ start: offset, end: offset, text: importCode });
  } else if (descriptor.script) {
    const script = descriptor.script;
    const scriptAST = scriptAst(script), config = objectConfig(scriptAST);
    if (!config) { result.diagnostics.push({ code: 'VUE_OPTIONS_DYNAMIC', file: ctx.file, message: 'Cannot statically register a boundary in this Options API export' }); return { ...result, edits: [], targets: [] }; }
    const components = config.properties.find(p => p.type === 'ObjectProperty' && nodeName(p.key) === 'components');
    if (components && (components.type !== 'ObjectProperty' || components.value.type !== 'ObjectExpression')) { result.diagnostics.push({ code: 'VUE_COMPONENTS_DYNAMIC', file: ctx.file, message: 'Dynamic components registry needs manual integration' }); return { ...result, edits: [], targets: [] }; }
    const position = components?.type === 'ObjectProperty' ? startOf(components.value) + 1 : startOf(config) + 1;
    if (!reuseImport) result.edits.push({ start: script.loc.start.offset + position, end: script.loc.start.offset + position, text: components ? ` ${boundary}, ` : ` components: { ${boundary} }, ` });
    const offset = script.loc.start.offset + importOffset(scriptAST);
    result.edits.push({ start: offset, end: offset, text: importCode });
  } else result.edits.push({ start: 0, end: 0, text: `<script setup>${importCode}</script>\n` });
  result.edits.push(...edits.map(e => ({ ...e, start: e.start + template.loc.start.offset, end: e.end + template.loc.start.offset })));
  const changed = applyEdits(ctx.source, result.edits);
  const checked = parseSFC(changed, { filename: ctx.file });
  if (checked.errors.length) throw new Error(String(checked.errors[0]));
  parseDOM(checked.descriptor.template!.content);
  return result;
}
