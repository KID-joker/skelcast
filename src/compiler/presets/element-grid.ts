import { digest } from '../styles.js';
import type { Presentation } from './types.js';

const fields = ['span', 'offset', 'push', 'pull'] as const;
const breakpoints = { xs: 0, sm: 768, md: 992, lg: 1200, xl: 1920 };
const units = (value: unknown): number | undefined => {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 24 ? number : undefined;
};

/** Element's gutter is padding inside columns, not an extra flex gap. */
export function elementRow(props: Record<string, unknown>, children: string): Presentation {
  const gutter = typeof props.gutter === 'number' && Number.isFinite(props.gutter) ? props.gutter : 0;
  const justify = ['start', 'end', 'center', 'space-around', 'space-between', 'space-evenly'].includes(String(props.justify)) ? String(props.justify) : 'start';
  const align = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[String(props.align)] ?? 'flex-start';
  return {
    tag: 'div', children,
    style: `--sk-el-half-gutter:${gutter / 2}px;display:flex;flex-wrap:wrap;position:relative;box-sizing:border-box;min-width:0;margin-left:${-gutter / 2}px;margin-right:${-gutter / 2}px;justify-content:${justify === 'start' || justify === 'end' ? `flex-${justify}` : justify};align-items:${align}`,
    notes: props.gutter != null && !(typeof props.gutter === 'number' && Number.isFinite(props.gutter)) ? ['Unresolved row gutter; provide a finite numeric binding'] : undefined,
  };
}

export function elementColumn(props: Record<string, unknown>, children: string): Presentation {
  const notes: string[] = [];
  const declarations = (values: Record<string, unknown>) => fields.flatMap(field => {
    const value = units(values[field]);
    if (value === undefined) return [];
    const percent = `${value / 24 * 100}%`;
    if (field === 'span') return [`display:${value === 0 ? 'none' : 'block'}`, `flex:0 0 ${percent}`, `max-width:${percent}`];
    return [field === 'offset' ? `margin-left:${percent}` : `position:relative;${field === 'push' ? 'left' : 'right'}:${percent}`];
  }).join(';');
  const steps = Object.entries(breakpoints).flatMap(([name, width]) => {
    const value = props[name];
    const values = units(value) !== undefined ? { span: value } : value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
    if (value != null && !values) notes.push(`Unresolved ${name} column layout; provide finite grid bindings`);
    if (values) for (const field of fields) if (values[field] != null && units(values[field]) === undefined) notes.push(`Unresolved ${name}.${field} column layout; provide finite grid bindings`);
    return values ? [[width, declarations(values)] as const] : [];
  });
  for (const field of fields) if (props[field] != null && units(props[field]) === undefined) notes.push(`Unresolved column ${field}; provide finite grid bindings`);
  // Zero base offsets do not create positioning classes in Element Plus. In
  // particular, a default left:0 would incorrectly cancel a positive pull.
  const base = declarations({ span: 24, ...Object.fromEntries(fields.filter(field => units(props[field]) !== undefined && (field === 'span' || units(props[field])! > 0)).map(field => [field, props[field]])) });
  const className = `sk-el-col-${digest(JSON.stringify([base, steps])).slice(0, 12)}`;
  const css = `.${className}{box-sizing:border-box;min-width:0;padding-left:var(--sk-el-half-gutter,0px);padding-right:var(--sk-el-half-gutter,0px);${base}}` + steps.map(([width, style]) => width === 0 ? `.${className}{${style}}` : `@media(min-width:${width}px){.${className}{${style}}}`).join('');
  return { tag: 'div', children, className, css, notes };
}
