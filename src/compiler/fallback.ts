import postcss from 'postcss';
import type { Value } from './expression.js';
import { UNKNOWN } from './expression.js';
import { styleString } from './html.js';

/** Native width/height attributes do not size an opaque div. Convert only
 * explicit finite dimensions; leave class/media rules in control of CSS. */
export function fallbackProps(props: Record<string, Value>, minHeight?: number): Record<string, Value> {
  const { width, height, style: sourceStyle, ...attrs } = props;
  const style = postcss.parse(`a{${styleString(sourceStyle)}}`).first as postcss.Rule;
  const declared = new Set<string>();
  style.walkDecls(declaration => { declared.add(declaration.prop); });
  const set = (prop: string, value: string) => {
    if (!declared.has(prop)) style.append({ prop, value });
    else style.walkDecls(prop, declaration => { declaration.value = value; declaration.important = false; });
    declared.add(prop);
  };
  for (const name of ['width', 'height']) {
    const raw = name === 'width' ? width : height;
    const value = raw == null || raw === UNKNOWN ? '' : String(raw);
    if (!declared.has(name) && /^(?:\d+(?:\.\d+)?)(?:px|%|rem|em|vw|vh)?$/.test(value)) set(name, /^\d+(?:\.\d+)?$/.test(value) ? `${value}px` : value);
  }
  if (!declared.has('height') && (declared.has('min-height') || declared.has('aspect-ratio'))) set('--sk-fallback-height', 'auto');
  if (minHeight !== undefined) set('min-height', `${minHeight}px`);
  const declarations: string[] = [];
  style.walkDecls(declaration => { declarations.push(`${declaration.prop}:${declaration.value}${declaration.important ? '!important' : ''}`); });
  return { ...attrs, style: declarations.join(';') };
}

/** Add fallback geometry to the stylesheet already owned by the compiler. */
export function applyFallbackConstraints(root: postcss.Root): void {
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
}
