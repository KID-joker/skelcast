import { parse as parseSFC } from '@vue/compiler-sfc';
import { parse as parseDOM, type ElementNode, type TemplateChildNode, type DirectiveNode } from '@vue/compiler-dom';
import { applyEdits, startOf, nodeName, importOffset, loadingName, objectConfig, parseCode, pendingCondition, pureCondition, uniqueName, walk, type Edit } from './ast.js';
import { targetId, type AnalysisContext, type FileAnalysis } from './types.js';
import type { SkeletonTarget } from '../types.js';

const directive = (node: ElementNode, name: string) => node.props.find((p): p is DirectiveNode => p.type === 7 && p.name === name);
const contentOf = (text: string, node: ElementNode) => text.slice(node.loc.start.offset, node.loc.end.offset);
const loader = (node: ElementNode) => /loader|loading|spinner|skeleton|progress/i.test(node.tag ?? '') || /loading|加载|请稍候/i.test((node.children ?? []).filter(n => n.type === 2).map(n => n.content).join(''));
export function analyzeVue(ctx: AnalysisContext): FileAnalysis {
  const result: FileAnalysis = { edits: [], targets: [], diagnostics: [] };
  const { descriptor, errors } = parseSFC(ctx.source, { filename: ctx.file });
  if (errors.length) throw new Error(String(errors[0]));
  const template = descriptor.template;
  if (!template || template.src || template.lang && template.lang !== 'html') {
    result.diagnostics.push({ code: 'VUE_TEMPLATE_UNSUPPORTED', file: ctx.file, message: 'External or preprocessed templates need an adapter' }); return result;
  }
  if (template.content.includes('<!-- skelcast:init -->')) return result;
  const scripts = [descriptor.script, descriptor.scriptSetup].filter(Boolean);
  const flags = new Set<string>();
  for (const script of scripts) walk(parseCode(script!.content), n => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern') for (const p of n.id.properties) if (p.type === 'ObjectProperty' && loadingName(nodeName(p.key) ?? '') && p.value.type === 'Identifier') flags.add(p.value.name);
  });
  if (scripts.some(s => s!.src)) { result.diagnostics.push({ code: 'VUE_SCRIPT_EXTERNAL', file: ctx.file, message: 'External scripts need manual boundary registration' }); return result; }
  if (/<(?:LoadingBoundary|_?_*SkelCastBoundary)\b/.test(template.content)) {
    result.diagnostics.push({ code: 'ALREADY_INTEGRATED', file: ctx.file, message: 'Preserved existing Vue loading boundary' }); return result;
  }
  const boundary = uniqueName(ctx.source, 'SkelCastBoundary');
  const text = template.content;
  const ast = parseDOM(text);
  const edits: Edit[] = [];
  const imports: string[] = [];
  const allBindings: Record<string, boolean> = {};
  let index = 0;
  const rootNodes = ast.children.filter(n => n.type !== 3 && !(n.type === 2 && !n.content.trim()));
  const add = (start: number, end: number, html: string, pending: string, bindings: Record<string, boolean>, kind: 'page' | 'request') => {
    const id = targetId(ctx, kind === 'page' ? 'page' : `loading-${++index}`);
    const artifact = uniqueName(ctx.source + imports.join('\n'), `__skelcast${result.targets.length}`);
    imports.push(`import ${artifact} from 'virtual:skelcast/${id}';`);
    const target: SkeletonTarget = { id, source: ctx.file, kind, region: artifact, hints: { bindings } };
    if (kind === 'page' && ctx.routes.length) target.route = ctx.routes.length === 1 ? ctx.routes[0] : ctx.routes;
    result.targets.push(target); Object.assign(allBindings, bindings);
    edits.push({ start, end, text: `<${boundary} :artifact="${artifact}" :pending="${pending.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"><!-- skelcast:init -->${html}</${boundary}>` });
  };
  const scan = (nodes: TemplateChildNode[]) => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.type !== 1) continue;
      if (['tr', 'td', 'th', 'tbody', 'thead', 'tfoot', 'li', 'option'].includes(node.tag)) {
        if (directive(node, 'loading')) result.diagnostics.push({ code: 'UNSAFE_CONTAINER', file: ctx.file, message: 'Select the enclosing table/list container for a block boundary' });
        continue;
      }
      const condition = directive(node, 'if');
      const expr = condition?.exp?.type === 4 ? condition.exp.content : undefined;
      if (expr && pendingCondition(expr, flags)) {
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
          let html = contentOf(text, content);
          if (firstIsLoader) {
            const offset = elseDirective.loc.start.offset - content.loc.start.offset;
            html = html.slice(0, offset) + `v-if="!(${expr.replace(/"/g, '&quot;')})"` + html.slice(offset + elseDirective.loc.source.length);
          }
          const root = ctx.page && rootNodes.length === 2 && rootNodes[0] === node && rootNodes[1] === alternate;
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
      if (pending && !/button|input|select|link/i.test(node.tag) && pureCondition(pending)) {
        let html = contentOf(text, node);
        if (loading) {
          const offset = loading.loc.start.offset - node.loc.start.offset;
          html = html.slice(0, offset) + html.slice(offset + loading.loc.source.length);
        }
        add(node.loc.start.offset, node.loc.end.offset, html, pending, { [pending]: false }, ctx.page && rootNodes.length === 1 && rootNodes[0] === node ? 'page' : 'request'); continue;
      }
      scan(node.children ?? []);
    }
  };
  scan(ast.children);
  if (ctx.page && !result.targets.some(t => t.kind === 'page')) {
    const id = targetId(ctx, 'page');
    const artifact = uniqueName(ctx.source + imports.join('\n'), `__skelcast${result.targets.length}`);
    imports.push(`import ${artifact} from 'virtual:skelcast/${id}';`);
    const target: SkeletonTarget = { id, source: ctx.file, kind: 'page', region: artifact, hints: { bindings: allBindings } };
    if (ctx.routes.length) target.route = ctx.routes.length === 1 ? ctx.routes[0] : ctx.routes;
    result.targets.push(target);
    edits.push({ start: 0, end: 0, text: `<${boundary} :artifact="${artifact}" :pending="false"><!-- skelcast:init -->` }, { start: text.length, end: text.length, text: `</${boundary}>` });
  }
  if (!result.targets.length) return result;
  const importCode = `\nimport { LoadingBoundary as ${boundary} } from 'skelcast/vue';\n${imports.join('\n')}\n`;
  if (descriptor.scriptSetup) {
    const script = descriptor.scriptSetup;
    const offset = script.loc.start.offset + importOffset(parseCode(script.content));
    result.edits.push({ start: offset, end: offset, text: importCode });
  } else if (descriptor.script) {
    const script = descriptor.script;
    const scriptAST = parseCode(script.content), config = objectConfig(scriptAST);
    if (!config) { result.diagnostics.push({ code: 'VUE_OPTIONS_DYNAMIC', file: ctx.file, message: 'Cannot statically register a boundary in this Options API export' }); return { ...result, edits: [], targets: [] }; }
    const components = config.properties.find(p => p.type === 'ObjectProperty' && nodeName(p.key) === 'components');
    if (components && (components.type !== 'ObjectProperty' || components.value.type !== 'ObjectExpression')) { result.diagnostics.push({ code: 'VUE_COMPONENTS_DYNAMIC', file: ctx.file, message: 'Dynamic components registry needs manual integration' }); return { ...result, edits: [], targets: [] }; }
    const position = components?.type === 'ObjectProperty' ? startOf(components.value) + 1 : startOf(config) + 1;
    result.edits.push({ start: script.loc.start.offset + position, end: script.loc.start.offset + position, text: components ? ` ${boundary}, ` : ` components: { ${boundary} }, ` });
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
