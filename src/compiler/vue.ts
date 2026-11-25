import path from 'node:path';
import { UNKNOWN, bindPattern, evaluateString, type Ast, type Value } from './expression.js';
import { nonVisual, unknownGeometry, styleString } from './html.js';
import { type RenderContext, type SourceSlot } from './context.js';
import type { RenderHost } from './render-host.js';
import { parseExpression } from '@babel/parser';
import { parse as parseDOM, type TemplateChildNode as VueNode, type DirectiveNode, type ExpressionNode } from '@vue/compiler-dom';
import { componentName } from './components.js';

const expression = (node: ExpressionNode | undefined): string | undefined => node?.type === 4 ? node.content : undefined;
const directive = (node: Extract<VueNode, { type: 1 }>, names: string[]): DirectiveNode | undefined =>
  node.props.find((prop): prop is DirectiveNode => prop.type === 7 && names.includes(prop.name));

export async function renderVueNodes(this: RenderHost, nodes: VueNode[], ctx: RenderContext): Promise<string> {
  let html = '';
  let inChain = false, selected = false;
  for (const node of nodes) {
    if (node.type === 3 || node.type === 2 && !node.content.trim()) continue;
    if (node.type === 1) {
      const condition = directive(node, ['if', 'else-if', 'else']);
      if (condition) {
        if (condition.name === 'if') { inChain = true; selected = false; }
        if (selected && inChain) continue;
        const expr = expression(condition.exp) ?? 'true';
        const result = evaluateString(expr, ctx);
        if (result !== UNKNOWN && !result) continue;
        if (result === UNKNOWN) this.diagnose('BRANCH_DEFAULT', `Unknown condition ${expr}: include this branch`, ctx, node);
        this.record('branch', expr, result === UNKNOWN ? 'Include first unresolved branch' : `Resolved to ${!!result}`, ctx, node);
        selected = true;
      } else { inChain = false; selected = false; }
    } else if (node.type !== 2) { inChain = false; selected = false; }
    html += await this.vueNode(node, ctx);
  }
  return html;
}
export async function renderVueNode(this: RenderHost, node: VueNode, ctx: RenderContext, skipFor = false): Promise<string> {
  const exhausted = this.budget(ctx, node);
  if (exhausted !== undefined) return exhausted;
  if (node.type === 2) return node.content.trim() ? this.contentText(node.content, ctx, node) : '';
  if (node.type === 5) { this.record('text', expression(node.content) ?? '', 'Resolve content policy for interpolation', ctx, node); return this.contentText(evaluateString(expression(node.content) ?? '', ctx), ctx, node); }
  if (node.type !== 1) return '';
  const loop = directive(node, ['for']);
  if (loop && !skipFor) {
    const match = expression(loop.exp)?.match(/^\s*(.*?)\s+(?:in|of)\s+([\s\S]+)$/);
    if (!match) return this.fallback(ctx, node, 'Unsupported v-for expression');
    let patterns: Ast[];
    try {
      const aliases = match[1].trim().replace(/^\(([\s\S]*)\)$/, '$1');
      const callback = parseExpression(`(${aliases}) => 0`, { plugins: ['typescript'] });
      if (callback.type !== 'ArrowFunctionExpression') throw new Error('Unsupported aliases');
      patterns = callback.params;
      if (!patterns.length || patterns.length > 3) throw new Error('Unsupported aliases');
    } catch { return this.fallback(ctx, node, 'Unsupported v-for aliases'); }
    const list = evaluateString(match[2], ctx);
    const entries = Array.isArray(list) ? list.map((value, index) => [value, index]) : list && list !== UNKNOWN && typeof list === 'object' ? Object.entries(list).map(([key, value]) => [value, key]) : undefined;
    const count = this.hints.repeat ?? (entries ? Math.min(entries.length, 24) : typeof list === 'number' && Number.isFinite(list) ? Math.min(Math.max(0, Math.floor(list)), 24) : 4);
    this.record('repeat', match[2], `Generate ${count} placeholders`, ctx, node);
    let html = '';
    for (let i = 0; i < count; i++) {
      const local: RenderContext = { ...ctx, env: { ...ctx.env } };
      bindPattern(patterns[0], entries ? entries[i] ? entries[i][0] : UNKNOWN : typeof list === 'number' ? i + 1 : UNKNOWN, local.env);
      if (patterns[1]) bindPattern(patterns[1], entries ? entries[i]?.[1] ?? i : i, local.env);
      if (patterns[2]) bindPattern(patterns[2], i, local.env);
      html += await this.vueNode(node, local, true);
    }
    return html;
  }
  const props: Record<string, Value> = Object.create(null);
  let unknownLayout = false;
  let htmlContent: string | undefined, textContent = false;
  for (const p of node.props) {
    if (p.type === 6) props[p.name] = p.value?.content ?? true;
    else if (p.name === 'bind' && !p.arg) {
      const spread = evaluateString(expression(p.exp) ?? '', ctx);
      if (spread && spread !== UNKNOWN && typeof spread === 'object' && !Array.isArray(spread)) Object.assign(props, spread);
      else this.diagnose('SPREAD_UNKNOWN', 'Cannot resolve Vue v-bind object; provide source bindings', ctx, node);
    }
    else if (p.name === 'bind' && p.arg?.type === 4 && p.arg.isStatic) {
      const key = p.arg.content;
      let value = evaluateString(expression(p.exp) ?? key, ctx);
      if (value === UNKNOWN && ['class', 'style', 'width', 'height'].includes(key)) {
        value = evaluateString(expression(p.exp) ?? key, { ...ctx, defaultBranches: true });
        this.diagnose('LAYOUT_UNKNOWN', value === UNKNOWN ? `Cannot resolve :${key}; using a local fallback` : `Unknown :${key} condition: use the first static branch`, ctx, node);
        if (value === UNKNOWN) unknownLayout = true;
      }
      props[key] = key === 'class' && props.class != null ? [props.class, value] : value;
    } else if (p.name === 'model') {
      if (!p.arg || p.arg.type === 4 && p.arg.isStatic) props[p.arg?.content ?? 'modelValue'] = evaluateString(expression(p.exp) ?? '', ctx);
    } else if (p.name === 'show') {
      const show = evaluateString(expression(p.exp) ?? '', ctx);
      if (show !== UNKNOWN && !show) return '';
    } else if (p.name === 'text') textContent = true;
    else if (p.name === 'html') {
      const value = evaluateString(expression(p.exp) ?? '', ctx);
      if (typeof value !== 'string' || value.length > 32768) return this.fallback(ctx, node, 'Dynamic v-html content needs an adapter', this.attributes(props));
      htmlContent = value;
    }
    else if (!['if', 'else', 'else-if', 'for', 'on', 'slot', 'model', 'once', 'memo', 'bind'].includes(p.name)) this.diagnose('DIRECTIVE_UNKNOWN', `Custom directive v-${p.name} may affect layout`, ctx, node);
  }
  const fallthrough = ctx.fallthrough;
  if (fallthrough && fallthrough.node === node) {
    for (const [key, value] of Object.entries(fallthrough.props)) {
      if (key === 'class' && props.class != null) props.class = [props.class, value];
      else if (key === 'style' && props.style != null) props.style = `${styleString(props.style)};${styleString(value)}`;
      else props[key] = value;
    }
  }
  const tag = node.tag;
  ctx = this.contentContext(ctx, props, tag);
  if (ctx.module.boundaries.has(tag) || tag === 'loading-boundary') return this.vueNodes(node.children, ctx);
  if (unknownGeometry(props.style)) unknownLayout = true;
  if (unknownLayout) return this.fallback(ctx, node, 'Unknown layout expression; add bindings or an adapter', this.attributes(props));
  if (['template', 'transition', 'Transition', 'transition-group', 'TransitionGroup', 'KeepAlive', 'keep-alive'].includes(tag)) return this.vueNodes(node.children, ctx);
  if (tag === 'slot') {
    const name = typeof props.name === 'string' ? props.name : 'default';
    return ctx.slots?.[name] ? this.renderSlot(ctx.slots[name], ctx) : node.children.length ? this.vueNodes(node.children, ctx) : '';
  }
  if (tag === 'component') {
    if (typeof props.is !== 'string' || !/^[a-zA-Z][\w-]*$/.test(props.is)) return this.fallback(ctx, node, 'Dynamic component requires a finite adapter', this.attributes(props));
    this.record('component', expression(node.props.find((p): p is DirectiveNode => p.type === 7 && p.arg?.type === 4 && p.arg.content === 'is')?.exp) ?? 'is', `Select static component ${props.is}`, ctx, node);
    const selected = parseDOM(`<${props.is}/>`).children[0];
    if (selected?.type !== 1) return this.fallback(ctx, node, 'Unsupported dynamic component');
    return this.vueNode({ ...selected, children: node.children, loc: node.loc, props: node.props.filter((p) => p.name !== 'is' && !(p.type === 7 && p.arg?.type === 4 && p.arg.content === 'is') && p.name !== 'for') }, ctx, true);
  }
  const imported = await this.componentReference(tag, ctx);
  if (imported?.file || this.target.adapters?.[tag]) {
    const slots: Record<string, SourceSlot> = {};
    const defaults: VueNode[] = [];
    for (const child of node.children) {
      const slot = child.type === 1 && child.tag === 'template' ? directive(child, ['slot']) : undefined;
      if (slot && child.type === 1) slots[expression(slot.arg) ?? 'default'] = { nodes: child.children, context: ctx, framework: 'vue' };
      else defaults.push(child);
    }
    if (defaults.length) slots.default = { nodes: defaults, context: ctx, framework: 'vue' };
    props.__skSlots = slots;
    const adapter = this.target.adapters?.[tag];
    if (adapter) { const file = path.resolve(this.root, adapter); await this.scan(file); return this.component(file, 'default', props, ctx, node); }
  }
  if (imported?.file && /\.(vue|tsx|jsx|ts|js)$/.test(imported.file)) return this.component(imported.file, imported.exported, props, ctx, node);
  if (componentName(tag) === 'routerlink') return this.element('a', props, await this.vueNodes(node.children, ctx), ctx, node);
  const presentation = await this.preset(tag, imported, props, { nodes: node.children, context: ctx, framework: 'vue' }, node);
  if (presentation !== undefined) return presentation;
  if (node.tagType === 1) return this.fallback(ctx, node, `No source adapter for ${tag}`, this.attributes(props));
  if (nonVisual.has(tag)) return '';
  const children = htmlContent !== undefined ? this.staticHTML(htmlContent, ctx, node) : textContent || tag === 'p' && this.masked(ctx) ? this.text(ctx, node, true) : await this.vueNodes(node.children, ctx);
  if (['div', 'section', 'article', 'main', 'canvas'].includes(tag) && Object.hasOwn(props, 'ref') && htmlContent === undefined && !textContent && node.children.every((child) => child.type === 3 || child.type === 2 && !child.content.trim())) {
    // An empty imperative mount host has no source-visible internal tree.
    // Mask only its existing box; do not invent widget-specific geometry.
    this.diagnose('FALLBACK', 'Opaque native mount point: preserve source container geometry', ctx, node, this.nodeId(ctx, node));
    return this.element(tag, props, '', ctx, node).replace(' data-sk-node=', ` data-sk-opaque${this.masked(ctx) ? ' data-sk-leaf' : ''} data-sk-node=`);
  }
  return this.element(tag, props, children, ctx, node);
}
