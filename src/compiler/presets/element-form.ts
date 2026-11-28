import {parse} from '@vue/compiler-dom';
import { dimension, escape, scalar } from './shared.js';
import type { Presentation } from './types.js';

export function elementForm(props: Record<string, unknown>, children: string): Presentation {
  const top = props.labelPosition === 'top';
  return {
    tag: 'div', className: 'el-form', children,
    style: `width:100%;--sk-el-label-width:${dimension(props.labelWidth, 'auto')};--sk-el-form-direction:${top ? 'column' : 'row'};--sk-el-label-align:${props.labelPosition === 'left' ? 'left' : 'right'};--sk-el-control-height:${props.size === 'small' ? '24px' : props.size === 'large' ? '40px' : '32px'}`,
  };
}
export function elementFormItem(props: Record<string, unknown>, children: string, labelSlot = ''): Presentation {
  const label = props.label == null ? '' : scalar(props.label);
  return {
    tag: 'div', className: 'el-form-item',
    style: 'display:flex;flex-direction:var(--sk-el-form-direction,row);margin-bottom:var(--sk-el-item-margin,18px);min-width:0',
    children: `${label || labelSlot ? `<label data-sk-layout class="el-form-item__label" style="box-sizing:border-box;flex-shrink:0;width:${dimension(props.labelWidth, 'var(--sk-el-label-width,auto)')};padding-right:12px;text-align:var(--sk-el-label-align,right);line-height:var(--sk-el-control-height,32px)">${labelSlot || escape(label)}</label>` : ''}<div data-sk-layout class="el-form-item__content" style="--sk-el-item-margin:0px;display:flex;flex-wrap:wrap;align-items:center;flex:1;min-width:0;line-height:var(--sk-el-control-height,32px)">${children}</div>`,
  };
}
export function elementDescriptions(props: Record<string, unknown>, children: string): Presentation {
  const columns=typeof props.column==='number'&&props.column>0?Math.min(24,props.column):3,border=props.border===true,vertical=props.direction==='vertical';
  const cells:{label:string;body:string;span:number;width:string;minWidth:string;labelWidth:string}[]=[];
  const collect=(nodes:ReturnType<typeof parse>['children'])=>{for(const node of nodes)if(node.type===1){const attrs=Object.fromEntries(node.props.flatMap(p=>p.type===6?[[p.name,p.value?.content??'']]:[]));if('data-sk-description-item'in attrs)cells.push({label:attrs['data-label']??'',body:node.children.map(n=>n.loc.source).join(''),span:Math.max(1,Math.min(columns,Number(attrs['data-span'])||1)),width:attrs['data-width']??'',minWidth:attrs['data-min-width']??'',labelWidth:attrs['data-label-width']??''});else collect(node.children)}};collect(parse(children).children);
  const rows:typeof cells[]=[];let row:typeof cells=[],count=0;
  for(const cell of cells){if(count+cell.span>columns){rows.push(row);row=[];count=0}row.push(cell);count+=cell.span;if(count===columns){rows.push(row);row=[];count=0}}if(row.length)rows.push(row);
  const padding=border?props.size==='small'?'4px 7px':props.size==='large'?'12px 15px':'8px 11px':props.size==='small'?'0 0 8px':props.size==='large'?'0 0 16px':'0 0 12px';
  const style=(cell:typeof cells[number],label=false)=>`padding:${padding};line-height:23px;font-size:${props.size==='small'?12:14}px;box-sizing:border-box;text-align:left;${border?'border:1px solid var(--el-border-color-lighter,#ebeef5);':''}${label&&border?'font-weight:700;background:var(--el-fill-color-light,#f5f7fa);':''}${(label?cell.labelWidth||dimension(props.labelWidth,'')||cell.width:cell.width)?'width:'+(label?cell.labelWidth||dimension(props.labelWidth,'')||cell.width:cell.width)+';':''}${cell.minWidth?'min-width:'+cell.minWidth+';':''}`;
  const content=rows.map(row=>{const label=(cell:typeof cells[number],span:number)=>`<${vertical?'th':'td'} data-sk-layout data-sk-control class="el-descriptions__cell el-descriptions__label${border?' is-bordered-label':''}" ${vertical?'colspan="'+span+'"':''} style="${style(cell,true)}">${escape(cell.label)}</${vertical?'th':'td'}>`;const body=(cell:typeof cells[number],span:number)=>`<td data-sk-layout class="el-descriptions__cell el-descriptions__content" colspan="${vertical?span:border?span*2-1:span}" style="${style(cell)}">${!border&&!vertical?`<span data-sk-layout data-sk-control class="el-descriptions__label" style="margin-right:16px">${escape(cell.label)}</span>`:''}${cell.body}</td>`;const spans=row.map((cell,index)=>index===row.length-1?cell.span+columns-row.reduce((sum,c)=>sum+c.span,0):cell.span);return vertical?`<tr>${row.map((cell,i)=>label(cell,spans[i])).join('')}</tr><tr>${row.map((cell,i)=>body(cell,spans[i])).join('')}</tr>`:`<tr>${row.map((cell,i)=>(border?label(cell,1):'')+body(cell,spans[i])).join('')}</tr>`}).join('');
  const title=scalar(props.title);
  return{tag:'div',className:'el-descriptions',style:'width:100%;box-sizing:border-box;font-size:14px',children:`${title?`<div data-sk-layout class="el-descriptions__header" style="display:flex;align-items:center;margin-bottom:${props.size==='large'?20:props.size==='small'?12:16}px"><div data-sk-layout class="el-descriptions__title" style="font-size:16px;font-weight:700">${escape(title)}</div></div>`:''}<div data-sk-layout class="el-descriptions__body"><table data-sk-layout class="el-descriptions__table${border?' is-bordered':''}" style="width:100%;border-collapse:collapse;table-layout:${props.tableLayout==='fixed'?'fixed':'auto'}"><tbody>${content}</tbody></table></div>`};
}
export function elementDescriptionItem(props: Record<string, unknown>, children: string): Presentation {
 return{tag:'template',children:`<template data-sk-description-item data-label="${escape(scalar(props.label))}" data-span="${escape(scalar(props.span,'1'))}" data-width="${escape(dimension(props.width,''))}" data-min-width="${escape(dimension(props.minWidth,''))}" data-label-width="${escape(dimension(props.labelWidth,''))}">${children}</template>`};
}
