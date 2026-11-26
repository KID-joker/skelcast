import type { Presentation } from './types.js';
import { dimension, escape, scalar } from './shared.js';
import { classString, styleString } from '../html.js';

/** Public Element Plus DOM/CSS contracts. Low-specificity defaults let source
 * theme variables and component body/header overrides retain their geometry. */
export function elementCard(props: Record<string, unknown>, slots: Record<string,string>, text: string): Presentation {
  const header = slots.header || (scalar(props.header) ? text : '');
  const footer = slots.footer || (scalar(props.footer) ? text : '');
  return {
    tag: 'div', className: 'el-card',
    children: (header ? `<div class="el-card__header ${escape(classString(props.headerClass))}">${header}</div>` : '')
      + `<div class="el-card__body ${escape(classString(props.bodyClass))}" style="${escape(styleString(props.bodyStyle))}">${slots.default ?? ''}</div>`
      + (footer ? `<div class="el-card__footer ${escape(classString(props.footerClass))}">${footer}</div>` : ''),
    css: `:where(.el-card){--el-card-padding:20px;--el-card-border-radius:4px;--el-card-border-color:var(--el-border-color-light,#e4e7ed);display:flex;flex-direction:column;min-width:0;overflow:hidden;border:1px solid var(--el-card-border-color);border-radius:var(--el-card-border-radius)}
:where(.el-card__header){padding:calc(var(--el-card-padding) - 2px) var(--el-card-padding);border-bottom:1px solid var(--el-card-border-color)}
:where(.el-card__body){padding:var(--el-card-padding);flex-grow:1;overflow:auto}
:where(.el-card__footer){padding:calc(var(--el-card-padding) - 2px) var(--el-card-padding);border-top:1px solid var(--el-card-border-color)}`,
  };
}

export function elementStatistic(props: Record<string,unknown>, slots: Record<string,string>, text: string): Presentation {
  const title = slots.title || escape(scalar(props.title));
  const prefix = slots.prefix || escape(scalar(props.prefix));
  const suffix = slots.suffix || escape(scalar(props.suffix));
  return {
    tag:'div',className:'el-statistic',
    children: (title ? `<div class="el-statistic__head">${title}</div>` : '')
      + `<div class="el-statistic__content" style="${escape(styleString(props.valueStyle))}">`
      + (prefix ? `<span class="el-statistic__prefix">${prefix}</span>` : '')
      + `<span class="el-statistic__number">${text}</span>`
      + (suffix ? `<span class="el-statistic__suffix">${suffix}</span>` : '') + '</div>',
    css: `:where(.el-statistic__head){font-weight:var(--el-statistic-title-font-weight,400);font-size:var(--el-statistic-title-font-size,var(--el-font-size-extra-small,12px));margin-bottom:4px;line-height:20px}
:where(.el-statistic__content){font-weight:var(--el-statistic-content-font-weight,400);font-size:var(--el-statistic-content-font-size,var(--el-font-size-extra-large,20px))}
:where(.el-statistic__prefix){display:inline-block;margin-right:4px}
:where(.el-statistic__suffix){display:inline-block;margin-left:4px}`,
    notes: props.formatter ? ['Statistic formatter callbacks are not executed; the value uses a finite text placeholder.'] : undefined,
  };
}

export function elementScrollbar(props:Record<string,unknown>, children:string):Presentation {
  const height=dimension(props.height,''), maxHeight=dimension(props.maxHeight,'');
  return {tag:'div',className:'el-scrollbar',style:`min-width:0;max-width:100%;overflow:hidden;${height ? `height:${height};` : ''}`,
    children:`<div class="el-scrollbar__wrap" style="overflow:auto;height:100%;${maxHeight ? `max-height:${maxHeight};` : ''}"><div class="el-scrollbar__view">${children}</div></div>`};
}

export function elementTimeline(name:string,props:Record<string,unknown>,children:string,text:string):Presentation {
  if(name==='timeline')return{tag:'ul',className:'el-timeline is-start',children,css:':where(.el-timeline){font-size:var(--el-font-size-base,14px);margin:0;padding:0 0 0 40px;list-style:none}',notes:props.direction&&props.direction!=='start'?['Alternate/end timeline placement uses a representative start-aligned frame.']:undefined};
  const timestamp=props.hideTimestamp===true||props.timestamp===undefined?'':`<div class="el-timeline-item__timestamp ${props.placement==='top'?'is-top':'is-bottom'}">${text}</div>`;
  return{tag:'li',className:'el-timeline-item is-start',style:'position:relative;padding-bottom:20px;list-style:none',children:
    `<div class="el-timeline-item__tail" style="position:absolute;height:100%;left:4px;border-left:2px solid var(--el-border-color-light,#e4e7ed)"></div><span class="el-timeline-item__node" data-sk-leaf style="position:absolute;left:-1px;top:4px;width:12px;height:12px;border-radius:50%"></span><div class="el-timeline-item__wrapper" style="position:relative;top:-3px;padding-left:28px">${props.placement==='top'?timestamp:''}<div class="el-timeline-item__content">${children}</div>${props.placement==='top'?'':timestamp}</div>`,
    css:':where(.el-timeline-item__timestamp){font-size:var(--el-font-size-small,12px);line-height:1}:where(.el-timeline-item__timestamp.is-top){margin-bottom:8px;padding-top:4px}:where(.el-timeline-item__timestamp.is-bottom){margin-top:8px}'};
}
