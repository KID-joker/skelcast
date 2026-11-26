import type { ComponentPreset, ComponentRole } from './types.js';
import { elementRow, elementColumn } from './element-grid.js';
import { elementCard, elementStatistic, elementScrollbar, elementTimeline } from './element-geometry.js';
import{elementPagination}from'./element-pagination.js';
import {
  button,
  input,
  calendar,
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
  'dropdown',
]);
const data = new Set(['table', 'image', 'avatar', 'statistic', 'countdown', 'tag', 'progress', 'text']);
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
  'timeline',
  'timelineitem',
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
        timelineitem: 'timeline-item',
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
  slots: (name) => (['eltablecolumn','eldropdown'].includes(name) ? ['default'] : name === 'elcalendar' ? ['header'] : ['default', 'header', 'footer', 'prefix', 'suffix', 'title']),
  present(name, props, children, text, hints, policy) {
    const n = name.replace(/^el/, '');
    if (n === 'button') return button(children, props);
    if (n === 'dropdown') return {tag:'div',className:'el-dropdown',style:'display:inline-flex;align-items:center;vertical-align:top',children};
    if (n === 'link') return {tag:'a',className:'el-link',children:`<span class="el-link__inner">${children}</span>`,css:':where(.el-link){display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;position:relative;text-decoration:none;outline:none;padding:0;font-size:var(--el-link-font-size,14px);font-weight:500}'};
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
    if (n === 'pagination')return elementPagination(props,children);
    if (n === 'switch' || n === 'slider')
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
    if (n === 'card') return elementCard(props, policy?.slots ?? {default:children}, text);
    if (n === 'table') return table(props, children, text, hints,true,policy?.mask??true);
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
    // Countdown delegates its public layout and title/prefix/suffix slots to
    // Statistic. Timer/date functions do not affect that static structure.
    if (n === 'statistic' || n === 'countdown') return elementStatistic(props,policy?.slots ?? {},text);
    if (n === 'tag' || n === 'text')
      return {
        tag: 'span',
        className:n==='tag'?'el-tag':undefined,
        style: n === 'tag' ? 'display:inline-flex;align-items:center;justify-content:center;height:24px;padding:0 9px;line-height:1;font-size:12px' : '',
        children: children || text,
      };
    if (n === 'progress') {
      const round = props.type === 'circle' || props.type === 'dashboard';
      const size = dimension(props.width,'126px');
      return {tag:'div',className:`el-progress el-progress--${round ? 'circle' : 'line'}`,style:round ? `display:inline-block;width:${size};height:${size}` : `height:${dimension(props.strokeWidth,'6px')};width:100%`,leaf:true,children:''};
    }
    if (n === 'row') return elementRow(props, children);
    if (n === 'col') return elementColumn(props, children);
    if (n === 'space' || n === 'buttongroup')
      return { tag: 'div', style: 'display:flex;flex-wrap:wrap;min-width:0;gap:12px', children };
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
    if (n === 'scrollbar') return elementScrollbar(props,children);
    if(n==='timeline'||n==='timelineitem')return elementTimeline(n,props,children,text);
    if (n === 'container') return { tag: 'section', style: 'display:flex;min-width:0;flex:1', children };
    if (n === 'aside')
      return { tag: 'aside', style: `flex-shrink:0;width:${dimension(props.width, '200px')}`, children };
    if (n === 'configprovider') return { tag: 'div', style: 'display:contents', children };
    if (layouts.has(n)) return { tag: n === 'main' ? 'main' : 'div', style: 'min-width:0', children };
  },
};
