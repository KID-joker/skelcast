import {UNKNOWN} from '../expression.js';
import {elementTabs,elementTabPane} from './element-tabs.js';
import {elementAlert,elementTree,elementUpload,collectionFrames} from './element-collections.js';
import { elementTable, elementTableColumn } from './element-table.js';
import type { ComponentPreset, ComponentRole } from './types.js';
import { elementRow, elementColumn } from './element-grid.js';
import { elementCard, elementStatistic, elementScrollbar, elementTimeline } from './element-geometry.js';
import{elementPagination}from'./element-pagination.js';
import { elementForm, elementFormItem, elementDescriptions, elementDescriptionItem } from './element-form.js';
import {
  button,
  choice,
  imagePlaceholder,
  input,
  calendar,
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
  'treeselect', 'selectv2', 'cascader',
  'checkboxgroup', 'radiogroup', 'alert', 'upload', 'divider',
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
  'tooltip',
  'dialog', 'drawer', 'alert', 'tree', 'upload', 'watermark', 'tabs', 'tabpane',
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
        checkboxgroup: 'checkbox-group', radiogroup: 'radio-group', tabpane: 'tab-pane',
        treeselect: 'tree-select', selectv2: 'select-v2',
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
  skipSlots: (name, props) => name === 'elicon' || ['eldialog','eldrawer'].includes(name) && props.modelValue !== true,
  maskSlots: name => name === 'eltablecolumn',
  frames: collectionFrames,
  slots: (name) => name==='eltabpane'?['label','default']:name==='eltree'?['empty']:name==='elupload'?['default','trigger','tip']:name==='elalert'?['title','default']:  (name==='eltablecolumn'?['default','header']:name==='eldropdown'?['default'] : name === 'elformitem' ? ['default','label'] : name === 'elcalendar' ? ['header'] : ['default', 'header', 'footer', 'prefix', 'suffix', 'title']),
  present(name, props, text, hints, policy) {
    const n = name.replace(/^el/, '');
    if (n === 'alert') return elementAlert(props,policy.slots,text);
    if (n === 'tree') return elementTree(props,hints,policy.frames??[],text,!policy.preserve);
    if (n === 'upload') return elementUpload(props,policy.slots,policy.frames??[],text,hints,!policy.preserve);
    if (n === 'watermark') return {tag:'div',className:'el-watermark',style:'position:relative',children:policy.slots.default};
    if (n === 'tooltip') return { tag: 'span', style: 'display:contents', children: policy.slots.default };
    if (n === 'treeselect' || n === 'selectv2' || n === 'cascader') return input(props);
    if (n === 'dialog' || n === 'drawer') return props.modelValue === true
      ? { tag: 'div', style: `position:fixed;z-index:2000;${n === 'drawer' ? `right:0;top:0;height:100%;width:${dimension(props.size, '30%')}` : `top:15vh;left:25%;width:${dimension(props.width, '50%')}`};background:var(--el-bg-color,#fff);padding:20px;box-sizing:border-box`, children: policy.children, notes: ['Open overlay uses declared dimensions; teleport placement and focus behavior are not reconstructed.'] }
      : { tag: 'div', style: 'display:none', children: '', notes: props.modelValue === false || props.modelValue === undefined ? [] : ['Overlay visibility is unknown; retain an out-of-flow footprint rather than adding a block to normal page layout.'] };
    if (n === 'form') return elementForm(props, policy.children);
    if (n === 'formitem') return elementFormItem(props, policy.slots.default, policy.slots.label);
    if (n === 'descriptions') return elementDescriptions(props, policy.children);
    if (n === 'descriptionsitem') return elementDescriptionItem(props, policy.children);
    if (n === 'checkboxgroup' || n === 'radiogroup') return { tag: 'div', className: `el-${n === 'checkboxgroup' ? 'checkbox' : 'radio'}-group`, style: 'display:inline-flex;align-items:center;flex-wrap:wrap;min-height:32px', children: policy.children };
    if (n === 'tabs') return elementTabs(props,policy.children);
    if (n === 'tabpane') return elementTabPane(props,policy.slots);
    if (n === 'button') {
      const size=props.size==='small'?24:props.size==='large'?40:32;
      const icon=props.icon&&props.icon!==UNKNOWN?'<i data-sk-layout class="el-icon" style="display:inline-flex;width:1em;height:1em;flex-shrink:0"></i>':'';
      const view=button(icon+policy.children,props,`${size}px`);
      return{...view,className:`el-button${props.circle===true?' is-circle':''}${props.link===true?' is-link':''}`,style:view.style+`;box-sizing:border-box;font-size:${size===24?'12px':'var(--el-font-size-base,14px)'};line-height:1;white-space:nowrap`+(props.circle===true?`;width:${size}px;padding:${size===24?5:size===40?12:8}px;border-radius:50%`:'')+(props.link===true?';padding:2px;min-height:0;height:auto;border-color:transparent':'')};
    }
    if (n === 'dropdown') return {tag:'div',className:'el-dropdown',style:'display:inline-flex;align-items:center;vertical-align:top', children: policy.children};
    if (n === 'link') return {tag:'a',className:'el-link',children:`<span data-sk-layout class="el-link__inner">${policy.children}</span>`,css:':where(.el-link){display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;position:relative;text-decoration:none;outline:none;padding:0;font-size:var(--el-link-font-size,14px);font-weight:500}'};
    if (n === 'datepicker' || n === 'timepicker') return { tag: 'div', className: `el-date-editor el-date-editor--${n === 'datepicker' ? 'date' : 'time'}`, style: 'display:inline-flex;width:220px;max-width:100%;height:var(--sk-el-control-height,32px);flex-shrink:0', children: '<input data-sk-layout disabled tabindex="-1" style="width:100%;min-width:0;height:100%;box-sizing:border-box;padding:4px 11px;border:1px solid #d9d9d9;border-radius:4px;font:inherit">' };
    if (['input', 'inputnumber', 'select'].includes(n)) { const view = input(props); return props.type === 'textarea' ? { ...view, style: view.style!.replace('height:80px', `height:${(typeof props.rows === 'number' ? props.rows : 2) * 21 + 10}px`) } : view; }
    if (n === 'option')
      return { tag: 'option', children: policy.children || escape(scalar(props.label ?? props.value)) };
    if (n === 'calendar') return calendar(policy.children);
    if (n === 'checkbox' || n === 'radio') { const view = choice(n, policy.children); return { ...view, className: `el-${n}`, style: view.style + ';gap:8px;white-space:nowrap;flex-shrink:0;height:32px', children: view.children.replace('<input ', '<input style="width:14px;height:14px;margin:0;box-sizing:border-box" '), css: ':where(.el-checkbox,.el-radio){font-size:14px;margin-right:30px}:where(.el-checkbox:last-child,.el-radio:last-child){margin-right:0}' }; }
    if (n === 'pagination')return elementPagination(props,policy.children);
    if (n === 'switch') {
      const height=props.size==='small'?24:props.size==='large'?40:32;
      const width=props.size==='small'?30:props.size==='large'?50:40;
      return {tag:'span',className:'el-switch',style:`display:inline-flex;align-items:center;vertical-align:middle;box-sizing:border-box;height:${height}px;min-width:${width}px;font-size:${props.size==='small'?12:14}px;line-height:${height-12}px`,children:`<span data-sk-layout style="display:inline-block;box-sizing:border-box;width:${width}px;height:${height/2+4}px;border:1px solid #dcdfe6;border-radius:12px"></span>`};
    }
    if (n === 'slider')
      return {
        tag: 'div',
        style: 'min-height:24px;min-width:120px;border:1px solid #dcdfe6;border-radius:4px', children: policy.children,
      };
    if (n === 'icon')
      return {
        tag: 'span',
        style: 'display:inline-block;width:1em;height:1em;border:1px solid currentColor;border-radius:2px',
        children: '',
      };
    if (n === 'card') return elementCard(props, policy.slots, text);
    if (n === 'table') return elementTable(props, policy.columns.resolve(policy.children), text(), hints, policy.mask);
    if (n === 'tablecolumn') return elementTableColumn(props, policy.slots.default, policy.columns,policy.slots.header);
    if (n === 'image' || n === 'avatar') return imagePlaceholder(props.size, n === 'avatar' ? '40px' : '160px', n === 'avatar' ? '40px' : '120px');
    // Countdown delegates its public layout and title/prefix/suffix slots to
    // Statistic. Timer/date functions do not affect that static structure.
    if (n === 'statistic' || n === 'countdown') return elementStatistic(props,policy.slots,text());
    if (n === 'tag' || n === 'text')
      return {
        tag: 'span',
        className:n==='tag'?'el-tag':undefined,
        style: n === 'tag' ? 'display:inline-flex;align-items:center;justify-content:center;height:24px;padding:0 9px;line-height:1;font-size:12px' : '',
        children: policy.children || text(),
      };
    if (n === 'progress') {
      const round = props.type === 'circle' || props.type === 'dashboard';
      const size = dimension(props.width,'126px');
      return {tag:'div',className:`el-progress el-progress--${round ? 'circle' : 'line'}`,style:round ? `display:inline-block;width:${size};height:${size}` : `height:${dimension(props.strokeWidth,'6px')};width:100%`,leaf:true,children:''};
    }
    if (n === 'row') return elementRow(props, policy.children);
    if (n === 'col') return elementColumn(props, policy.children);
    if (n === 'space' || n === 'buttongroup')
      return { tag: 'div', className:n==='space'?'el-space':'el-button-group', style: `display:inline-flex;${props.direction === 'vertical' ? 'flex-direction:column;' : ''}flex-wrap:${props.wrap===true?'wrap':'nowrap'};min-width:0;align-items:center;gap:${dimension(props.size,n==='space'?'8px':'0px')}`, children: policy.children };
    if (n === 'divider')
      return { tag: 'div', className:'el-divider el-divider--horizontal', style: 'display:block;width:100%;height:1px;margin:24px 0;border-top:1px solid var(--el-border-color,#dcdfe6);position:relative', children: policy.children?`<div data-sk-layout data-sk-control class="el-divider__text is-${scalar(props.contentPosition,'center')}" style="position:absolute;${props.contentPosition==='left'?'left:20px':props.contentPosition==='right'?'right:20px':'left:50%;transform:translateX(-50%)'};top:-.5em;padding:0 20px;background:var(--el-fill-color-blank,#fff);font-size:14px;line-height:1">${policy.children}</div>`:'' };
    if (n === 'scrollbar') return elementScrollbar(props,policy.children);
    if(n==='timeline'||n==='timelineitem')return elementTimeline(n,props,policy.children,text);
    if (n === 'container') return { tag: 'section', style: 'display:flex;min-width:0;flex:1', children: policy.children };
    if (n === 'aside')
      return { tag: 'aside', style: `flex-shrink:0;width:${dimension(props.width, '200px')}`, children: policy.children };
    if (n === 'configprovider') return { tag: 'div', style: 'display:contents', children: policy.children };
    if (layouts.has(n)) return { tag: n === 'main' ? 'main' : 'div', style: 'min-width:0', children: policy.children };
  },
};
