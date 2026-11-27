import { nodeName, unwrapExpression, walk } from './ast.js';
import { renderComponent } from './component-render.js';
import { UNKNOWN, bindPattern, evaluate, expressionText, type Ast, type Value } from './expression.js';
import { nonVisual, unknownGeometry } from './html.js';
import { slotValue, type RenderContext, type SourceSlot } from './context.js';
import type { RenderHost } from './render-host.js';
import { boundaryContentContext } from './branches.js';
import { collectionRootNode, loadingBranch, projectCollection } from './loading-state.js';
import { renderCall } from './vue-render.js';
import { planCollection } from './collections.js';

const collectionCache = new WeakMap<Ast, Ast[]>();
/** Cache syntax only; receiver paths are resolved with the current source context. */
function collectionSources(node: Ast): Ast[] {
  const previous = collectionCache.get(node);
  if (previous) return previous;
  const sources: Ast[] = [];
  walk(node, n => {
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && nodeName(n.callee.property) === 'map') sources.push(n.callee.object);
  });
  collectionCache.set(node, sources);
  return sources;
}
const repeatedContent = (node: Ast): boolean => collectionSources(node).length > 0;
const hasCollection = (node: Ast, root: string): boolean =>
  collectionSources(node).some(source => collectionRootNode(source) === root);

export async function renderJSX(this: RenderHost, node: Ast | null | undefined, ctx: RenderContext): Promise<string> {
  if (!node) return '';
  return this.budget(ctx, node) ?? renderJSXNode.call(this, node, ctx);
}

/** Shared node rendering; each frontend accounts for its own expansion cost. */
export async function renderJSXNode(this: RenderHost, node: Ast, ctx: RenderContext): Promise<string> {
  const expression = unwrapExpression(node, 1);
  if (expression !== node) return this.jsx(expression, ctx);
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
    const text = expressionText(node.test, ctx);
    const { boundState, projected } = loadingBranch(text, ctx, root => hasCollection(node.consequent, root) || hasCollection(node.alternate, root));
    if (projected) {
      test = projected.present;
      ctx = projectCollection(ctx, projected.root);
      this.diagnose('LOADING_PROJECTION', 'Render the source collection template for loading; response values remain unknown', ctx, node);
    }
    if (this.target.kind === 'request' && this.hints.state!=='source' && test !== UNKNOWN && !boundState && repeatedContent(test ? node.alternate : node.consequent) && !repeatedContent(test ? node.consequent : node.alternate)) this.diagnose('EMPTY_STATE', 'Source-default branch excludes repeated request content; declare a finite populated/empty variant when needed', ctx, node);
    this.record('branch', text, test === UNKNOWN ? 'Default to consequent; override with bindings' : `Resolved to ${!!test}`, ctx, node);
    if (test === UNKNOWN) this.diagnose('BRANCH_DEFAULT', 'Unknown condition: chose consequent; supply bindings to select a branch', ctx, node);
    return this.jsx(test === UNKNOWN || test ? node.consequent : node.alternate, ctx);
  }
  if (node.type === 'LogicalExpression') {
    let left = evaluate(node.left, ctx);
    const text = expressionText(node.left, ctx);
    const { projected } = loadingBranch(text, ctx, (root, present) => node.operator === '&&' && (!present || hasCollection(node.right, root)));
    if (projected) left = projected.present;
    if (left === UNKNOWN) { this.record('branch', expressionText(node.left, ctx), 'Include optional content by default', ctx, node); return this.jsx(node.right, ctx); }
    if (node.operator === '&&') return left ? this.jsx(node.right, ctx) : '';
    return left != null && (node.operator === '??' || left) ? this.jsx(node.left, ctx) : this.jsx(node.right, ctx);
  }
  if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression') && (node.callee.type === 'MemberExpression' || node.callee.type === 'OptionalMemberExpression') && nodeName(node.callee.property) === 'map') {
    const fn = node.arguments[0];
    if (fn?.type !== 'ArrowFunctionExpression' && fn?.type !== 'FunctionExpression') return this.fallback(ctx, node, 'Unsupported map callback');
    const list = evaluate(node.callee.object, ctx);
    const text = expressionText(node.callee.object, ctx);
    const { count, projected } = planCollection(this, text, list, ctx, node);
    const body = fn.body.type === 'BlockStatement' ? fn.body.body.find(n => n.type === 'ReturnStatement')?.argument : fn.body;
    let html = '';
    for (let i = 0; i < count; i++) {
      const local = { ...ctx, env: { ...ctx.env } };
      bindPattern(fn.params[0], !projected&&Array.isArray(list) ? list[i] ?? UNKNOWN : UNKNOWN, local.env);
      bindPattern(fn.params[1], i, local.env);
      html += await this.jsx(body, local);
    }
    return html;
  }
  if (node.type === 'ArrayExpression') return this.jsxNodes(node.elements, ctx);
  if (node.type !== 'JSXElement') {
    if (['NullLiteral', 'BooleanLiteral'].includes(node.type)) return '';
    if (node.type === 'CallExpression'||node.type==='OptionalCallExpression') {
      return renderCall.call(this, node, ctx, 'jsx');
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
    return this.jsxNodes(node.children, boundaryContentContext(ctx, expression, this.hints.state));
  }
  if (unknownGeometry(props.style)) unknownLayout = true;
  if (unknownLayout) return this.fallback(ctx, node, 'Unknown layout expression; add bindings or an adapter', props);
  if (/^[A-Z]/.test(tag) || opening.name.type === 'JSXMemberExpression') {
    if (node.children.length) props.children = { [slotValue]: { nodes: node.children, context: ctx, framework: 'jsx' } satisfies SourceSlot };
    this.record('component', tag, 'Expand source component', ctx, node);
    const preset = await renderComponent(this, tag, props, { nodes: node.children, context: ctx, framework: 'jsx' }, node);
    if (preset !== undefined) return preset;
    return this.fallback(ctx, node, `No source adapter for ${tag}`, props);
  }
  if (!tag || tag.includes('-')) return this.fallback(ctx, node, `Unsupported element ${tag || 'dynamic component'}`, props);
  if (nonVisual.has(tag)) return '';
  if (tag === 'img') return this.image(props, ctx, node);
  const children = tag === 'p' && this.masked(ctx) && this.hints.lines != null ? this.text(ctx, node, true) : await this.jsxNodes(node.children, ctx);
  return this.element(tag, props, children, ctx, node);
}
