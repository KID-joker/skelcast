import type { ComponentPreset, ComponentRole } from './types.js';
import {
  button,
  input,
  calendar,
  card,
  column,
  table,
  libraryExport,
  readonly,
  dimension,
  escape,
  scalar,
} from './shared.js';

const controls = new Set([
  'button',
  'buttongroup',
  'input',
  'inputnumber',
  'select',
  'option',
  'datepicker',
  'timepicker',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'pagination',
  'calendar',
  'link',
  'icon',
]);
const data = new Set(['table', 'image', 'avatar', 'statistic', 'tag', 'progress', 'text']);
const layouts = new Set([
  'card',
  'tablecolumn',
  'row',
  'col',
  'container',
  'header',
  'aside',
  'main',
  'footer',
  'space',
  'form',
  'formitem',
  'divider',
  'scrollbar',
  'configprovider',
  'descriptions',
  'descriptionsitem',
]);
const all = [...controls, ...data, ...layouts];
const deep = Object.fromEntries(
  all.map((name) => [
    'components/' +
      ({
        buttongroup: 'button-group',
        inputnumber: 'input-number',
        datepicker: 'date-picker',
        timepicker: 'time-picker',
        configprovider: 'config-provider',
        tablecolumn: 'table-column',
        formitem: 'form-item',
        descriptionsitem: 'descriptions-item',
      }[name] ?? name),
    'El' + name,
  ]),
);
function role(name: string, props: Record<string, unknown>): ComponentRole | undefined {
  const n = name.replace(/^el/, '');
  return controls.has(n)
    ? readonly(props) && ['input', 'inputnumber'].includes(n)
      ? 'data'
      : 'control'
    : data.has(n)
    ? 'data'
    : layouts.has(n)
    ? 'layout'
    : undefined;
}
export const elementPlusPreset: ComponentPreset = {
  id: 'element-plus',
  package: 'element-plus',
  resolve: (ref) => libraryExport(ref, 'element-plus', deep),
  role,
  slots: (name) => (name === 'eltablecolumn' ? ['default'] : name === 'elcalendar' ? ['header'] : ['default', 'header', 'footer', 'prefix', 'suffix']),
  present(name, props, children, text, hints) {
    const n = name.replace(/^el/, '');
    if (n === 'button' || n === 'link') return button(children, props);
    if (['input', 'inputnumber', 'select', 'datepicker', 'timepicker'].includes(n)) return input(props);
    if (n === 'option')
      return { tag: 'option', children: children || escape(scalar(props.label ?? props.value)) };
    if (n === 'calendar') return calendar(children);
    if (n === 'checkbox' || n === 'radio')
      return {
        tag: 'label',
        style: 'display:inline-flex;align-items:center;gap:6px',
        children: `<input type="${n}" disabled tabindex="-1">${children}`,
      };
    if (n === 'switch' || n === 'slider' || n === 'pagination')
      return {
        tag: 'div',
        style: `min-height:24px;min-width:${
          n === 'switch' ? '40px' : '120px'
        };border:1px solid #dcdfe6;border-radius:4px`,
        children,
      };
    if (n === 'icon')
      return {
        tag: 'span',
        style: 'display:inline-block;width:1em;height:1em;border:1px solid currentColor;border-radius:2px',
        children: '',
      };
    if (n === 'card') return card(children, props.header, text);
    if (n === 'table') return table(props, children, text, hints);
    if (n === 'tablecolumn') return column(props, children);
    if (n === 'image' || n === 'avatar')
      return {
        tag: 'span',
        leaf: true,
        style: `display:inline-block;width:${dimension(
          props.size,
          n === 'avatar' ? '40px' : '160px',
        )};height:${dimension(props.size, n === 'avatar' ? '40px' : '120px')};flex-shrink:0`,
        children: '',
      };
    if (n === 'statistic')
      return {
        tag: 'div',
        style: 'min-height:60px',
        children: (props.title ? `<div>${escape(scalar(props.title))}</div>` : '') + text,
      };
    if (n === 'tag' || n === 'text')
      return {
        tag: 'span',
        style: n === 'tag' ? 'display:inline-block;padding:2px 8px' : '',
        children: children || text,
      };
    if (n === 'progress') return { tag: 'div', style: 'height:16px;width:100%', leaf: true, children: '' };
    if (n === 'row' || n === 'space' || n === 'buttongroup')
      return { tag: 'div', style: 'display:flex;flex-wrap:wrap;min-width:0;gap:12px', children };
    if (n === 'col')
      return {
        tag: 'div',
        style: `min-width:0;flex:0 1 ${
          typeof props.span === 'number' ? (Math.max(1, Math.min(24, props.span)) / 24) * 100 : 100
        }%`,
        children,
      };
    if (n === 'formitem')
      return {
        tag: 'div',
        style: 'display:flex;flex-direction:column;gap:6px;margin-bottom:18px',
        children:
          (props.label
            ? `<label style="color:var(--skeleton-control-color,#606266)">${escape(
                scalar(props.label),
              )}</label>`
            : '') + children,
      };
    if (n === 'divider')
      return { tag: 'div', style: 'height:1px;margin:20px 0;background:#e4e7ed', children: '' };
    if (n === 'descriptionsitem')
      return {
        tag: 'div',
        style: 'display:flex;gap:12px;padding:8px 0',
        children:
          `<span style="color:var(--skeleton-control-color,#606266)">${escape(scalar(props.label))}</span>` +
          children,
      };
    if (n === 'scrollbar') return { tag: 'div', style: 'min-width:0;max-width:100%;overflow:auto', children };
    if (n === 'container') return { tag: 'section', style: 'display:flex;min-width:0;flex:1', children };
    if (n === 'aside')
      return { tag: 'aside', style: `flex-shrink:0;width:${dimension(props.width, '200px')}`, children };
    if (n === 'configprovider') return { tag: 'div', style: 'display:contents', children };
    if (layouts.has(n)) return { tag: n === 'main' ? 'main' : 'div', style: 'min-width:0', children };
  },
};
