import { parse } from '@vue/compiler-dom';
import postcss from 'postcss';

/** Native width/height attributes do not size an opaque div. Convert only
 * explicit finite dimensions; leave class/media rules in control of CSS. */
export function fallbackAttributes(attrs: string, minHeight?: number): string {
  const element = parse(`<div${attrs}></div>`).children[0];
  if (element?.type !== 1) return attrs;
  const values = Object.fromEntries(element.props.filter(p => p.type === 6).map(p => [p.name, p.value?.content ?? '']));
  const style = postcss.parse(`a{${values.style ?? ''}}`).first!;
  const declarations = new Map<string, string>();
  if (style.type === 'rule') style.walkDecls(d => { declarations.set(d.prop, d.value); });
  for (const name of ['width', 'height']) {
    const value = values[name];
    if (!declarations.has(name) && value && /^(?:\d+(?:\.\d+)?)(?:px|%|rem|em|vw|vh)?$/.test(value)) declarations.set(name, /^\d+(?:\.\d+)?$/.test(value) ? `${value}px` : value);
  }
  if (!declarations.has('height') && (declarations.has('min-height') || declarations.has('aspect-ratio'))) declarations.set('--sk-fallback-height', 'auto');
  if (minHeight !== undefined) declarations.set('min-height', `${minHeight}px`);
  const css = [...declarations].map(([key, value]) => `${key}:${value}`).join(';').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return attrs.replace(/\s(?:style|width|height)="[^"]*"/g, '') + (css ? ` style="${css}"` : '');
}

/** A source min-height/aspect-ratio constrains an empty footprint. Change the
 * default fallback height, without overriding any actual source height rule. */
export function fallbackConstraints(css: string): string {
  const root = postcss.parse(css);
  root.walkRules(rule => {
    if (rule.selectors.some(s => s.includes('::'))) return;
    let parent: typeof rule.parent | typeof root.parent = rule.parent;
    while (parent) { if (parent.type === 'atrule' && /keyframes$/i.test(parent.name)) return; parent = parent.parent; }
    if(rule.nodes.some(n=>n.type==='decl'&&n.prop==='height'&&/^(?:\d+(?:\.\d+)?)(?:px|rem|em|vh|vw)$/.test(n.value))&&rule.nodes.some(n=>n.type==='decl'&&n.prop==='display'&&['flex','inline-flex','grid','inline-grid'].includes(n.value))){
      const frame=rule.clone({selector:rule.selectors.map(s=>`${s} > :where([data-sk-fallback])`).join(','),nodes:[]});
      frame.append({prop:'--sk-available-height',value:'100%'});frame.append({prop:'border-radius',value:'inherit'});rule.after(frame);
    }
    if (rule.nodes.some(n => n.type === 'decl' && n.prop === 'display' && /^inline(?:-flex|-grid|-block)?$/.test(n.value))) rule.append({prop:'--sk-inline-footprint',value:'1em'});
    if (!rule.nodes.some(n => n.type === 'decl' && ['min-height', 'aspect-ratio'].includes(n.prop))) return;
    const clone = rule.clone({ selector: rule.selectors.map(s => `${s}:where([data-sk-fallback])`).join(','), nodes: [] });
    clone.append({ prop: '--sk-fallback-height', value: 'auto' });
    rule.after(clone);
  });
  return root.toString();
}
