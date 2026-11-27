import { parse as parseDOM, type TemplateChildNode as VueNode } from '@vue/compiler-dom';
import { UNKNOWN, type Value } from './expression.js';
import { escapeHTML, voids, nonVisual, styleString, classString } from './html.js';
import { sourceIdAttribute, utilityAttribute } from './styles.js';
import type { RenderContext, SourceNode } from './context.js';
import type { ElementMarkers, RenderHost } from './render-host.js';
import { imageRatio } from './images.js';
import type { StyleOptions } from '../types.js';

// Keep source IDs out of the live document's ID namespace. Internal data-sk-*
// attributes are owned by the generator and cannot be supplied by source markup.
const layoutAttribute = (name: string) => name === 'id' || name === 'data-sk-anchor' || ['dir', 'lang'].includes(name) || /^data-(?!sk-)[\w.:-]+$/.test(name);

/** Normalize and filter independently of HTML serialization and source-ID tracking. */
export function outputAttribute(key: string, value: Value, styles?: StyleOptions): [string, Value] | undefined {
  if (value === UNKNOWN || value == null) return;
  if (key === 'className' || key === 'class') {
    const cls = classString(value);
    return cls ? ['class', cls] : undefined;
  }
  if (key === 'style') {
    const style = styleString(value);
    return style ? ['style', style] : undefined;
  }
  if (layoutAttribute(key) && ['string', 'number', 'boolean'].includes(typeof value)) return [key === 'id' ? sourceIdAttribute : key, value];
  if (['width', 'height', 'colSpan', 'rowSpan', 'viewBox'].includes(key)) return [key.toLowerCase(), value];
  if (styles?.unocss && utilityAttribute(key)) return [key, value === true ? '' : value];
  if (['rows', 'cols'].includes(key) && typeof value !== 'object') return [key, value];
  if (key === 'size' && /^\d+$/.test(String(value))) return ['size', value];
}

export function renderAttributes(this: RenderHost, props: Record<string, Value>): string {
  let attrs = '';
  for (const [key, value] of Object.entries(props)) {
    const attribute = outputAttribute(key, value, this.options.styles);
    if (attribute) attrs += ` ${attribute[0]}="${escapeHTML(attribute[1])}"`;
  }
  return attrs;
}
export function renderElement(this: RenderHost, tag: string, props: Record<string, Value>, children: string, ctx: RenderContext, node: SourceNode | undefined, markers: ElementMarkers = {}): string {
  for (const [key, value] of Object.entries(props)) {
    if (layoutAttribute(key) && (value === UNKNOWN || value != null && !['string', 'number', 'boolean'].includes(typeof value))) {
      this.diagnose('LAYOUT_ATTRIBUTE_UNKNOWN', `Cannot resolve ${key}; attribute selectors may not match. Supply an explicit binding`, ctx, node);
    }
  }
  const leaf = markers.leaf || this.masked(ctx) && ['img', 'input', 'textarea', 'button', 'select'].includes(tag);
  let attrs = `${this.attributes(props)}${markers.layout ? ' data-sk-layout' : ''}${markers.opaque ? ' data-sk-opaque' : ''}${leaf ? ' data-sk-leaf' : ''} data-sk-node="${this.nodeId(ctx, node)}"${ctx.scopes.map(s => ` ${s}`).join('')}`;
  if (ctx.control || ctx.mode === 'preserve') attrs += ' data-sk-control';
  if (props['data-sk-preserve'] != null) attrs += ' data-sk-preserve';
  if (tag === 'img') {
    const dimension = (value: unknown) => typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
    const width = dimension(props.width), height = dimension(props.height);
    const ratio = imageRatio(props['data-sk-image-ratio']);
    const intrinsic = props.__skImageSize as { width: number; height: number } | undefined;
    const size = ratio ? { width: ratio * 100, height: 100 } : intrinsic ?? (width > 0 && height > 0 ? { width, height } : { width: 400, height: 300 });
    if (props['data-sk-image-ratio'] != null && !ratio) this.diagnose('PLACEHOLDER_HINT', 'data-sk-image-ratio must be a positive number or WIDTH / HEIGHT', ctx, node);
    attrs += ` data-sk-image alt="" src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27${size.width}%27 height=%27${size.height}%27/%3E"`;
    if (ratio) attrs = / style="/.test(attrs)
      ? attrs.replace(/ style="([^"]*)"/, (_match, style: string) => ` style="${style};aspect-ratio:${ratio}"`)
      : `${attrs} style="aspect-ratio:${ratio}"`;
  }
  if (['input', 'textarea', 'button', 'select'].includes(tag)) {
    attrs += ' tabindex="-1"';
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
