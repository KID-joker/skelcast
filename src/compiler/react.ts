import { nodeName } from './ast.js';
import path from 'node:path';
import { UNKNOWN, bindPattern, evaluate, expressionText, sourceCapacity, type Ast, type Value } from './expression.js';
import { nonVisual, unknownGeometry } from './html.js';
import { slotValue, type RenderContext, type SourceSlot } from './context.js';
import type { RenderHost } from './render-host.js';
import { boundaryContentContext, hasStateBinding } from './branches.js';
import { walk } from './ast.js';
import {collectionRoot,loadingPresence,projectsCollection,repeatCapacity,collectionEmpty} from './loading-state.js';
import {renderLocalCall,vueHelper} from './vue-render.js';
import {renderSlotCall} from './regions.js';

function repeatedContent(node: Ast): boolean {
  let found = false;
  walk(node, n => { if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && nodeName(n.callee.property) === 'map') found = true; });
  return found;
}
function hasCollection(node:Ast,root:string,ctx:RenderContext):boolean{let found=false;walk(node,n=>{if(n.type==='CallExpression'&&n.callee.type==='MemberExpression'&&nodeName(n.callee.property)==='map'&&collectionRoot(expressionText(n.callee.object,ctx))===root)found=true;});return found;}

export async function renderJSX(this: RenderHost, node: Ast | null | undefined, ctx: RenderContext): Promise<string> {
  if (!node) return '';
  const exhausted = this.budget(ctx, node);
  if (exhausted !== undefined) return exhausted;
  if ((node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression' || node.type === 'ParenthesizedExpression')) return this.jsx(node.expression, ctx);
  if (node.type === 'JSXFragment') return this.jsxNodes(node.children, ctx);
  if (node.type === 'JSXText') {
    // Match JSX's removal of indentation while retaining meaningful spaces.
    const lines = node.value.replace(/\t/g, ' ').split(/\r\n|\n|\r/);
    const value = lines.map((line, i) => (i ? line.replace(/^ +/, '') : line).replace(i < lines.length - 1 ? / +$/ : /$^/, '')).filter(Boolean).join(' ');
    return value ? this.contentText(value, ctx, node) : '';
  }
  if (node.type === 'JSXExpressionContainer') return node.expression.type === 'JSXEmptyExpression' ? '' : this.jsx(node.expression, ctx);
  if (node.type === 'ConditionalExpression') {
    let test = evaluate(node.test, ctx);
    const text=expressionText(node.test,ctx),presence=hasStateBinding(text,ctx)?undefined:loadingPresence(text,ctx);
    if(presence&&projectsCollection(presence.root,ctx)&&collectionEmpty(presence.root,ctx)&&(hasCollection(node.consequent,presence.root,ctx)||hasCollection(node.alternate,presence.root,ctx))){test=presence.present;ctx={...ctx,projectedCollections:new Set([...ctx.projectedCollections??[],presence.root])};this.diagnose('LOADING_PROJECTION','Render the source collection template for loading; response values remain unknown',ctx,node);}
    if (this.target.kind === 'request' && this.hints.state!=='source' && test !== UNKNOWN && !hasStateBinding(expressionText(node.test, ctx), ctx) && repeatedContent(test ? node.alternate : node.consequent) && !repeatedContent(test ? node.consequent : node.alternate)) this.diagnose('EMPTY_STATE', 'Source-default branch excludes repeated request content; declare a finite populated/empty variant when needed', ctx, node);
    this.record('branch', expressionText(node.test, ctx), test === UNKNOWN ? 'Default to consequent; override with bindings' : `Resolved to ${!!test}`, ctx, node);
    if (test === UNKNOWN) this.diagnose('BRANCH_DEFAULT', 'Unknown condition: chose consequent; supply bindings to select a branch', ctx, node);
    return this.jsx(test === UNKNOWN || test ? node.consequent : node.alternate, ctx);
  }
  if (node.type === 'LogicalExpression') {
    let left = evaluate(node.left, ctx);
    const text=expressionText(node.left,ctx),presence=hasStateBinding(text,ctx)?undefined:loadingPresence(text,ctx);
    if(node.operator==='&&'&&presence&&projectsCollection(presence.root,ctx)&&collectionEmpty(presence.root,ctx)&&(!presence.present||hasCollection(node.right,presence.root,ctx)))left=presence.present;
    if (left === UNKNOWN) { this.record('branch', expressionText(node.left, ctx), 'Include optional content by default', ctx, node); return this.jsx(node.right, ctx); }
    if (node.operator === '&&') return left ? this.jsx(node.right, ctx) : '';
    return left != null && (node.operator === '??' || left) ? this.jsx(node.left, ctx) : this.jsx(node.right, ctx);
  }
  if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression') && (node.callee.type === 'MemberExpression' || node.callee.type === 'OptionalMemberExpression') && nodeName(node.callee.property) === 'map') {
    const fn = node.arguments[0];
    if (fn?.type !== 'ArrowFunctionExpression' && fn?.type !== 'FunctionExpression') return this.fallback(ctx, node, 'Unsupported map callback');
    const list = evaluate(node.callee.object, ctx);
    const text=expressionText(node.callee.object,ctx),projected=collectionEmpty(text,ctx)&&!hasStateBinding(text,ctx)&&projectsCollection(collectionRoot(text),ctx);
    const bound=sourceCapacity(list);
    const count = this.hints.repeat ?? (projected?repeatCapacity(text,ctx):bound!=null?Math.min(24,bound):Array.isArray(list) ? Math.min(list.length, 24) : 4);
    if(bound!=null)this.diagnose('LOADING_PROJECTION','Use a representative source collection bound; later mutations, result count and item values remain unknown',ctx,node);
    if(projected)this.diagnose('LOADING_PROJECTION',`Render ${count} masked source items; this is loading capacity, not a response count`,ctx,node);
    if (this.target.kind === 'request' && this.hints.state!=='source' && count === 0 && !hasStateBinding(expressionText(node.callee.object, ctx), ctx)) this.diagnose('EMPTY_STATE', 'Source-default collection is empty; declare a finite populated/empty variant when needed', ctx, node);
    this.record('repeat', expressionText(node.callee.object, ctx), `Generate ${count} placeholders`, ctx, node);
    let html = '';
    for (let i = 0; i < count; i++) {
      const local = { ...ctx, env: { ...ctx.env } };
      bindPattern(fn.params[0], !projected&&Array.isArray(list) ? list[i] ?? UNKNOWN : UNKNOWN, local.env);
      bindPattern(fn.params[1], i, local.env);
      const body = fn.body.type === 'BlockStatement' ? fn.body.body.find(n => n.type === 'ReturnStatement')?.argument : fn.body;
      html += await this.jsx(body, local);
    }
    return html;
  }
  if (node.type === 'ArrayExpression') return this.jsxNodes(node.elements, ctx);
  if (node.type !== 'JSXElement') {
    if (['NullLiteral', 'BooleanLiteral'].includes(node.type)) return '';
    if (node.type === 'CallExpression'||node.type==='OptionalCallExpression') {
      const slot=await renderSlotCall(this,node,ctx);if(slot!==undefined)return slot;
      if(node.type==='CallExpression'){
        const html=await renderLocalCall.call(this,node,ctx);if(html!==undefined)return html;
        if(vueHelper(ctx.module,node.callee,'h'))return this.vueExpression(node,ctx);
      }
      return this.fallback(ctx, node, `Unknown render call: ${expressionText(node.callee, ctx)}`);
    }
    const value = evaluate(node, ctx);
    if (value && typeof value === 'object' && Object.hasOwn(value, slotValue)) return this.renderSlot((value as { [slotValue]: SourceSlot })[slotValue], ctx);
    this.record('text', expressionText(node, ctx), 'Replace content with text placeholder', ctx, node);
    return this.contentText(value, ctx, node);
  }
  const opening = node.openingElement;
  const tag = nodeName(opening.name) ?? '';
  const props: Record<string, Value> = Object.create(null);
  let unknownLayout = false;
  for (const a of opening.attributes) {
    if (a.type === 'JSXSpreadAttribute') {
      const value = evaluate(a.argument, ctx);
      if (value && value !== UNKNOWN && typeof value === 'object') Object.assign(props, value);
      else this.diagnose('SPREAD_UNKNOWN', 'Unknown spread props may affect layout', ctx, a);
      continue;
    }
    const name = nodeName(a.name) ?? '';
    const expression = a.value?.type === 'JSXExpressionContainer' ? a.value.expression : undefined;
    props[name] = !a.value ? true : a.value.type === 'StringLiteral' ? a.value.value : evaluate(expression, ctx);
    if (props[name] === UNKNOWN && ['className', 'style', 'width', 'height'].includes(name)) {
      const fallback = expression ? evaluate(expression, { ...ctx, defaultBranches: true }) : UNKNOWN;
      props[name] = fallback;
      this.diagnose('LAYOUT_UNKNOWN', fallback === UNKNOWN ? `Cannot resolve ${name}; using a local fallback` : `Unknown ${name} condition: use the first static branch`, ctx, a);
      if (fallback === UNKNOWN) unknownLayout = true;
    }
  }
  ctx = this.contentContext(ctx, props, tag);
  if (ctx.module.boundaries.has(tag)) {
    const pending = opening.attributes.find(a => a.type === 'JSXAttribute' && nodeName(a.name) === 'pending');
    const expression = pending?.type === 'JSXAttribute' && pending.value?.type === 'JSXExpressionContainer' ? expressionText(pending.value.expression, ctx) : '';
    return this.jsxNodes(node.children, {...(expression ? boundaryContentContext(ctx, expression) : ctx),loading:this.hints.state==='loading'||this.hints.state!=='source'&&!!expression&&expression!=='false'});
  }
  if (unknownGeometry(props.style)) unknownLayout = true;
  if (unknownLayout) return this.fallback(ctx, node, 'Unknown layout expression; add bindings or an adapter', this.attributes(props));
  if (/^[A-Z]/.test(tag) || opening.name.type === 'JSXMemberExpression') {
    if (node.children.length) props.children = { [slotValue]: { nodes: node.children, context: ctx, framework: 'jsx' } satisfies SourceSlot };
    this.record('component', tag, 'Expand source component', ctx, node);
    const adapter = this.target.adapters?.[tag];
    if (adapter) {
      const file = path.resolve(this.root, adapter); await this.scan(file);
      return this.component(file, 'default', props, ctx, node);
    }
    const imported = await this.componentReference(tag, ctx);
    if (imported?.file && /\.(tsx|jsx|vue|ts|js)$/.test(imported.file)) return this.component(imported.file, imported.exported, props, ctx, node);
    if (ctx.module.functions.has(tag)) {
      const local = { ...ctx, env: { ...ctx.env }, depth: ctx.depth + 1 };
      if (local.depth > 16) return this.fallback(ctx, node, 'Component recursion limit reached');
      const body = this.prepareFunction(ctx.module.functions.get(tag), local, props);
      return body ? this.jsx(body, local) : this.fallback(ctx, node, `Cannot expand ${tag}`);
    }
    const preset = await this.preset(tag, imported, props, { nodes: node.children, context: ctx, framework: 'jsx' }, node);
    if (preset !== undefined) return preset;
    return this.fallback(ctx, node, `No source adapter for ${tag}`, this.attributes(props));
  }
  if (!tag || tag.includes('-')) return this.fallback(ctx, node, `Unsupported element ${tag || 'dynamic component'}`, this.attributes(props));
  if (nonVisual.has(tag)) return '';
  if (tag === 'img') return this.image(props, ctx, node);
  const children = tag === 'p' && this.masked(ctx) && this.hints.lines != null ? this.text(ctx, node, true) : await this.jsxNodes(node.children, ctx);
  return this.element(tag, props, children, ctx, node);
}
