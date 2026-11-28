import { nodeName, unwrapExpression, isRenderFunction } from './ast.js';
import { renderComponent } from './component-render.js';
import { UNKNOWN, bindPattern, evaluate, expressionText, type Ast, type Value } from './expression.js';
import { nonVisual, unknownGeometry } from './html.js';
import { slotValue, type RenderContext, type SourceSlot } from './context.js';
import type { RenderHost } from './render-host.js';
import { boundaryContentContext } from './branches.js';
import { renderCall } from './render-call.js';
import { planCollection } from './collections.js';
import { renderBranch } from './render-branches.js';
import { renderGraphic } from './output.js';
import { supportedBody } from './vue-syntax.js';

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
  if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression' || node.type === 'ArrayExpression') return renderBranch.call(this, node, ctx, 'jsx');
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
  const reference = tag.includes('-') ? await this.componentReference(tag, ctx) : undefined;
  if (/^[A-Z]/.test(tag) || opening.name.type === 'JSXMemberExpression' || reference) {
    let source: SourceSlot = { nodes: node.children, context: ctx, framework: 'jsx' };
    const vue = !!ctx.module.descriptor || [...ctx.module.imports.values()].some(ref => ref.request === 'vue');
    const content = node.children.filter(child => child.type !== 'JSXText' || child.value.trim());
    const object = content.length === 1 && content[0].type === 'JSXExpressionContainer' ? content[0].expression : undefined;
    if (vue && object?.type === 'ObjectExpression') {
      const slots: Record<string, SourceSlot> = {};
      for (const property of object.properties) {
        if (property.type !== 'ObjectProperty' || property.computed || !isRenderFunction(property.value) || property.value.async || property.value.generator || property.value.params.length > 1 || !supportedBody(property.value.body)) {
          this.diagnose('SLOT_UNKNOWN','JSX slot needs a finite source render function',ctx,property); continue;
        }
        const name = nodeName(property.key);
        if (name) slots[name] = { framework:'render',nodes:[],context:ctx,parameter:property.value.params[0],renderFunction:property.value };
      }
      source = { framework:'render',nodes:[],context:ctx,slots };
      props.__skSlots = slots;
    } else if (node.children.length) {
      props.children = { [slotValue]: source };
      if (vue) props.__skSlots = { default: source };
    }
    this.record('component', tag, 'Expand source component', ctx, node);
    const preset = await renderComponent(this, tag, props, source, node, reference);
    if (preset !== undefined) return preset;
    return this.fallback(ctx, node, `No source adapter for ${tag}`, props);
  }
  if (!tag || tag.includes('-')) return this.fallback(ctx, node, `Unsupported element ${tag || 'dynamic component'}`, props);
  if (nonVisual.has(tag)&&tag!=='iframe') return '';
  if (tag === 'img') return this.image(props, ctx, node);
  const graphic = renderGraphic(this, tag, props, ctx, node);
  if (graphic !== undefined) return graphic;
  const children = tag === 'p' && this.masked(ctx) && this.hints.lines != null ? this.text(ctx, node, true) : await this.jsxNodes(node.children, ctx);
  return this.element(tag, props, children, ctx, node);
}
