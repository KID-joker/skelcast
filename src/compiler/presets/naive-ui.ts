import { table } from './table.js';
import { button, input, calendar, readonly, escape, formItem } from './shared.js';
import { UNKNOWN } from '../expression.js';
import type { ComponentPreset, Presentation } from './types.js';

/** Finite presentation primitives; never imports or invokes Naive UI. */
function naivePresentation(name: string, props: Record<string, unknown>, text: () => string, policy: { readonly children: string; mask: boolean }): Presentation | undefined {
  if (name === 'nicon') {
    const size = typeof props.size === 'number' || typeof props.size === 'string' && /^\d+(?:px)?$/.test(props.size) ? `${parseFloat(String(props.size))}px` : '1em';
    return {tag:'span',style:`display:inline-block;width:${size};height:${size};flex-shrink:0;border:1px solid currentColor;border-radius:2px`,children:''};
  }
  if (name === 'nimage') return { tag: 'span', style: 'display:inline-block;width:160px;height:120px;flex-shrink:0', leaf: true, children: '' };
  if (name === 'nconfigprovider') return { tag: 'div', style: 'display:contents', children: policy.children };
  if (name === 'ncode') {
    if (!policy.mask && typeof props.code === 'string') return {tag:'pre',style:'margin:0;font-size:14px;line-height:1.6;font-family:monospace;min-width:0',children:escape(props.code)};
    const code = typeof props.code === 'string' ? props.trim === false ? props.code : props.code.trim() : undefined;
    const lines = code === undefined ? ['', '', ''] : (code.replace(/\r?\n$/, '').split(/\r?\n/)).slice(0, 40);
    return { tag: 'pre', style: 'margin:0;font-size:14px;line-height:1.6;font-family:monospace;min-width:0', children: lines.map(line => `<span data-sk-layout data-sk-code-line style="display:block;height:1.6em"><span data-sk-layout${policy.mask ? ' data-sk-leaf' : ''} style="display:inline-block;height:.85em;vertical-align:middle;width:${Math.max(1, Math.min(100, line.length || 1))}ch;max-width:100%"></span></span>`).join('') };
  }
  if (name === 'ndivider') return { tag: 'hr', style: props.vertical === true || props.vertical === '' ? 'display:inline-block;flex-shrink:0;margin:0 8px;border:0;width:1px;height:1em' : 'margin:20px 0;border:0;height:1px', children: '' };
  if (['ninput', 'ninputnumber', 'nselect', 'ndatepicker', 'ncolorpicker'].includes(name)) return input(props,'34px');
  if (['nswitch', 'ncheckbox', 'nradio', 'nslider', 'nprogress'].includes(name)) return { tag: 'span', style: `display:inline-block;width:${name === 'nswitch' ? '40px' : name === 'ncheckbox' || name === 'nradio' ? '16px' : '100%'};height:18px;${name==='nprogress'?'':'border:1px solid #d9d9d9;border-radius:4px'}`, leaf: name === 'nprogress', children: '' };
  if (name === 'nbutton') return button(policy.children,props,'34px');
  if (name === 'ncalendar') return calendar(policy.children);
  if (name === 'ncard') return { tag: 'section', style: 'display:block;padding:20px 24px;border:1px solid #dce1e7;border-radius:4px', children: (props.title ? text() : '') + policy.children };
  if (name === 'ninputgroup') return { tag: 'div', style: 'display:flex;align-items:stretch;width:100%', children: policy.children };
  if (name === 'ninputgrouplabel') return { tag: 'div', style: 'display:flex;align-items:center;padding:0 12px;min-height:34px', children: policy.children };
  if (name === 'nformitem') return formItem(policy.children, props.label);
  if (name === 'ngrid') {
    const gap = (key: string, kebab: string) => /^\d+(?:\.\d+)?$/.test(String(props[key] ?? props[kebab] ?? 0)) ? Math.min(200, Number(props[key] ?? props[kebab] ?? 0)) : 0;
    const gaps = `column-gap:${gap('xGap', 'x-gap')}px;row-gap:${gap('yGap', 'y-gap')}px`;
    const cols = props.cols ?? 24;
    if (/^\d+$/.test(String(cols)) && Number(cols) >= 1 && Number(cols) <= 24) return { tag: 'div', style: `display:grid;min-width:0;grid-template-columns:repeat(${cols},minmax(0,1fr));${gaps}`, children: policy.children };
    if (typeof cols !== 'string') return;
    const sizes: Record<string, number> = { xs: 0, s: 640, m: 1024, l: 1280, xl: 1536, xxl: 1920 };
    const steps: [number, number][] = [];
    for (const token of cols.trim().split(/\s+/)) {
      const match = token.match(/^(?:(\d+|xs|s|m|l|xl|xxl):)?(\d+)$/);
      if (!match || Number(match[2]) < 1 || Number(match[2]) > 24) return;
      steps.push([match[1] ? sizes[match[1]] ?? Number(match[1]) : 0, Number(match[2])]);
    }
    steps.sort((a, b) => a[0] - b[0]);
    const screen = props.responsive === 'screen';
    const cls = 'sk-naive-grid-' + steps.map(step => step.join('-')).join('-') + `-${gap('xGap', 'x-gap')}-${gap('yGap', 'y-gap')}-${screen ? 'screen' : 'self'}`;
    const css = `.${cls}{display:grid;min-width:0;grid-template-columns:repeat(24,minmax(0,1fr));${gaps}}` + steps.map(([width, count]) => `${screen ? '@media' : '@container'} (min-width:${width}px){.${cls}{grid-template-columns:repeat(${count},minmax(0,1fr))}}`).join('');
    return { tag: 'div', style: screen ? 'min-width:0' : 'min-width:0;container-type:inline-size', children: `<div data-sk-layout class="${cls}">${policy.children}</div>`, css };
  }
  if (name === 'ngi' || name === 'ngriditem') return { tag: 'div', style: `min-width:0;grid-column:span ${/^\d+$/.test(String(props.span)) ? Math.max(1, Math.min(24, Number(props.span))) : 1}`, children: policy.children };
  if (name === 'nspace') return { tag: 'div', style: `display:flex;flex-wrap:wrap;gap:12px;flex-direction:${props.vertical && props.vertical !== UNKNOWN ? 'column' : 'row'}`, children: policy.children };
  if (['ntooltip', 'npopover', 'nellipsis'].includes(name)) return { tag: 'span', children: policy.children };
  if (name === 'nh2' || name === 'nh3') return { tag: name.slice(1), children: policy.children };
  if (name === 'ntag') return { tag: 'span', style: 'display:inline-block;padding:2px 8px', children: policy.children };
  if (name === 'nstatistic') return { tag: 'div', style: 'display:block;min-height:60px', children: text() + text() };
  if (name === 'nscrollbar') {
    const horizontal = props['x-scrollable'] === true || props.xScrollable === true;
    return { tag: 'div', style: `display:block;min-width:0;max-width:100%;overflow-x:${horizontal ? 'auto' : 'hidden'};overflow-y:auto`, children: horizontal ? `<div data-sk-layout style="min-width:max-content">${policy.children}</div>` : policy.children };
  }
  if (['nform', 'nalert'].includes(name)) return { tag: 'div', style: 'display:block', children: policy.children };
  if (name === 'ntable') return { tag: 'table', style: 'width:100%;border-collapse:collapse', children: policy.children };
}


export const naiveUIPreset: ComponentPreset = {
  id: 'naive-ui',
  package: 'naive-ui',
  role: (name,props) => ['nbutton','ninput','ninputnumber','nselect','ndatepicker','ncolorpicker','nswitch','ncheckbox','nradio','nslider','ncalendar','ninputgrouplabel','nicon'].includes(name) ? readonly(props)&&['ninput','ninputnumber'].includes(name)?'data':'control' : ['nimage','ncode','nstatistic','ntag','nprogress','nh2','nh3','ndatatable'].includes(name) ? 'data' : ['nconfigprovider','ndivider','ncard','ninputgroup','ngrid','ngi','ngriditem','nspace','ntooltip','npopover','nellipsis','nscrollbar','nform','nformitem','nalert','ntable'].includes(name) ? 'layout' : undefined,
  slots: name => name==='ncalendar'?['header']: ['ntooltip', 'npopover'].includes(name) ? ['trigger'] : ['default', 'header', 'footer', 'label'],
  present: (name,props,text,hints,policy) => name==='ndatatable'?table(props,policy.columns.resolve(policy.children),text(),hints,policy.mask):naivePresentation(name,props,text,policy),
};
