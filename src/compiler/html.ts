import { UNKNOWN, type Ast } from './expression.js';

export const escapeHTML = (v: unknown) => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
export const nonVisual = new Set(['script', 'style', 'link', 'meta', 'iframe', 'object', 'embed']);
export const unitless = new Set(['opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'order', 'gridColumn', 'gridRow', 'aspectRatio']);
export const cssName = (name: string) => name.startsWith('--') ? name : name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
export const unknownGeometry = (value: unknown) => value && typeof value === 'object' && Object.entries(value).some(([key, v]) => v === UNKNOWN && /width|height|gap|display|position|margin|padding|flex|grid|inset|^top$|^right$|^bottom$|^left$|aspect|transform/i.test(key));
export function styleString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value).filter(([, v]) => v !== UNKNOWN && v != null).map(([k, v]) => `${cssName(k)}:${typeof v === 'number' && v !== 0 && !unitless.has(k) && !k.startsWith('--') ? `${v}px` : v}`).join(';');
}
export function classString(value: unknown): string {
  if (value === UNKNOWN || value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(classString).filter(Boolean).join(' ');
  if (typeof value === 'object') return Object.entries(value).filter(([, v]) => v !== UNKNOWN && !!v).map(([k]) => k).join(' ');
  return '';
}
export function visit(node: unknown, fn: (node: Ast) => void): void {
  if (!node || typeof node !== 'object') return;
  if ('type' in node && typeof node.type === 'string') fn(node);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'tokens', 'comments', 'leadingComments', 'trailingComments'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(v => visit(v, fn));
    else if (value && typeof value === 'object') visit(value, fn);
  }
}
