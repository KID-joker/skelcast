import { parse as parseDOM, type TemplateChildNode as VueNode } from '@vue/compiler-dom';
import { UNKNOWN, type Value } from './expression.js';
import { escapeHTML, voids, nonVisual, styleString, classString } from './html.js';
import { sourceIdAttribute, utilityAttribute } from './styles.js';
import type { RenderContext, SourceNode } from './context.js';
import type { RenderHost } from './render-host.js';

// Keep source IDs out of the live document's ID namespace. Internal data-sk-*
// attributes are owned by the generator and cannot be supplied by source markup.
const layoutAttribute = (name: string) => name === 'id' || ['dir', 'lang'].includes(name) || /^data-(?!sk-)[\w.:-]+$/.test(name);

export function renderAttributes(this: RenderHost, props: Record<string, Value>): string {
  let attrs = '';
  for (const [key, value] of Object.entries(props)) {
    if (value === UNKNOWN || value == null) continue;
    if (key === 'className' || key === 'class') { const cls = classString(value); if (cls) attrs += ` class="${escapeHTML(cls)}"`; }
    else if (key === 'style') { const style = styleString(value); if (style) attrs += ` style="${escapeHTML(style)}"`; }
    else if (layoutAttribute(key) && ['string', 'number', 'boolean'].includes(typeof value)) attrs += ` ${key === 'id' ? sourceIdAttribute : key}="${escapeHTML(value)}"`;
    else if (['width', 'height', 'colSpan', 'rowSpan', 'viewBox'].includes(key)) attrs += ` ${key.toLowerCase()}="${escapeHTML(value)}"`;
    else if (this.options.styles?.unocss && utilityAttribute(key)) attrs += ` ${key}="${value === true ? '' : escapeHTML(value)}"`;
    else if (['rows', 'cols'].includes(key) && typeof value !== 'object') attrs += ` ${key}="${escapeHTML(value)}"`;
    else if (key === 'size' && /^\d+$/.test(String(value))) attrs += ` size="${escapeHTML(value)}"`;
  }
  return attrs;
}
export function renderElement(this: RenderHost, tag: string, props: Record<string, Value>, children: string, ctx: RenderContext, node: SourceNode | undefined): string {
  for (const [key, value] of Object.entries(props)) {
    if (layoutAttribute(key) && (value === UNKNOWN || value != null && !['string', 'number', 'boolean'].includes(typeof value))) {
      this.diagnose('LAYOUT_ATTRIBUTE_UNKNOWN', `Cannot resolve ${key}; attribute selectors may not match. Supply an explicit binding`, ctx, node);
    }
  }
  let attrs = `${this.attributes(props)} data-sk-node="${this.nodeId(ctx, node)}"${ctx.scopes.map(s => ` ${s}`).join('')}`;
  if (ctx.control || ctx.mode === 'preserve') attrs += ' data-sk-control';
  if (props['data-sk-preserve'] != null) attrs += ' data-sk-preserve';
  if (tag === 'img') attrs += ` data-sk-image${this.masked(ctx) ? ' data-sk-leaf' : ''}` + '  alt="" src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27400%27 height=%27300%27/%3E"';
  if (['input', 'textarea', 'button', 'select'].includes(tag)) {
    attrs += `${this.masked(ctx) ? ' data-sk-leaf' : ''} tabindex="-1"`;
    for (const key of ['type','placeholder','value','checked','disabled','readonly','multiple','min','max','step']) {
      let value = props[key] ?? (key === 'value' ? props.modelValue : key === 'readonly' ? props.readOnly : undefined);
      if (value === UNKNOWN || value == null || value === false || typeof value === 'object' || typeof value === 'symbol') continue;
      if ((key === 'value' || key === 'placeholder') && this.masked(ctx) || key === 'value' && props.type === 'password') continue;
      if (key === 'type' && tag === 'button' && !['button','submit','reset'].includes(String(value))) value = 'button';
      attrs += ` ${key}="${escapeHTML(value === true ? '' : value)}"`;
    }
  }
  return voids.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${children}</${tag}>`;
}
export function renderStaticHTML(this: RenderHost, source: string, ctx: RenderContext, origin: SourceNode): string {
  this.record('component', 'v-html', 'Replace bounded static HTML content with inert semantic placeholders', ctx, origin);
  const render = (node: VueNode): string => {
    const exhausted = this.budget(ctx, origin);
    if (exhausted !== undefined) return exhausted;
    if (node.type === 2 || node.type === 5) {
      const value = node.type === 2 ? node.content : node.content.type === 4 ? node.content.content : '';
      if (!this.masked(ctx)) return escapeHTML(value);
      // Keep word lengths and whitespace so prose can wrap naturally at the
      // container width. No original text reaches the output.
      return value.trim() ? `<span data-sk-node="${this.nodeId(ctx, origin)}" data-sk-prose data-sk-leaf style="box-decoration-break:clone;-webkit-box-decoration-break:clone">${escapeHTML(value.replace(/[^\s]/g, 'x'))}</span>` : ' ';
    }
    if (node.type !== 1 || nonVisual.has(node.tag)) return '';
    // HTML inserted with v-html is inert HTML, never a Vue template. Do not
    // interpret directives, components, event handlers, URLs or interpolation.
    if (node.tagType !== 0) return this.fallback(ctx, origin, `Unsupported static HTML element ${node.tag}`);
    const props = Object.fromEntries(node.props.filter(p => p.type === 6).map((p) => [p.name, p.value?.content ?? true]));
    return this.element(node.tag, props, node.children.map(render).join(''), ctx, origin);
  };
  try { return parseDOM(source, { delimiters: ['\u0000', '\u0000'] }).children.map(render).join(''); }
  catch { return this.fallback(ctx, origin, 'Static HTML could not be parsed'); }
}
