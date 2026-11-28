import {parse,type ElementNode} from '@vue/compiler-dom';
import type {Presentation} from './types.js';
import {escape,scalar} from './shared.js';
/** Pane markers carry finite headers without dropping the source body. */
export function elementTabPane(props:Record<string,unknown>,slots:Record<string,string>):Presentation{
 return{tag:'section',className:'el-tab-pane',style:'min-width:0',children:`<template data-sk-tab-header data-name="${escape(scalar(props.name))}">${slots.label||escape(scalar(props.label))}</template>${slots.default??''}`};
}
export function elementTabs(props:Record<string,unknown>,children:string):Presentation{
 const panes:{header:string;body:string;name:string}[]=[];
 const collect=(nodes:ReturnType<typeof parse>['children'])=>{for(const node of nodes)if(node.type===1){const header=node.children.find((n):n is ElementNode=>n.type===1&&n.tag==='template'&&n.props.some(p=>p.type===6&&p.name==='data-sk-tab-header'));if(header){const name=header.props.find(p=>p.type===6&&p.name==='data-name');panes.push({header:header.children.map(n=>n.loc.source).join(''),body:node.children.filter(n=>n!==header).map(n=>n.loc.source).join(''),name:name?.type===6?name.value?.content??'':''})}else collect(node.children)}};collect(parse(children).children);
 const selected=props.modelValue??props.activeName??(panes[0]?.name||'0');
 const index=panes.findIndex((pane,index)=>(pane.name||String(index))===String(selected));
 const position=['left','right','bottom'].includes(String(props.tabPosition))?String(props.tabPosition):'top',vertical=position==='left'||position==='right';
 const headers=panes.map((pane,index)=>`<div data-sk-layout data-sk-control class="el-tabs__item is-${position}${(pane.name||String(index))===String(selected)?' is-active':''}" style="display:inline-flex;align-items:center;flex-shrink:0;height:40px;padding:0 20px;font-size:14px;box-sizing:border-box">${pane.header}</div>`).join('');
 const header=`<div data-sk-layout class="el-tabs__header is-${position}" style="margin:${vertical?'0 10px 0 0':'0 0 15px'};flex-shrink:0"><div data-sk-layout class="el-tabs__nav-wrap is-${position}" style="border-bottom:2px solid var(--el-border-color-light,#e4e7ed);overflow:hidden"><div data-sk-layout class="el-tabs__nav is-${position}" style="display:flex;${vertical?'flex-direction:column':'white-space:nowrap'}">${headers}</div></div></div>`;
 const body=`<div data-sk-layout class="el-tabs__content" style="min-width:0;overflow:hidden;${props.type==='border-card'?'padding:15px':''}">${panes.map((pane,i)=>`<div data-sk-layout class="el-tab-pane" style="${i===(index<0?0:index)?'':'display:none'}">${pane.body}</div>`).join('')}</div>`;
 return{tag:'div',className:`el-tabs el-tabs--${position}${props.type?' el-tabs--'+scalar(props.type):''}`,style:`min-width:0;${vertical?'display:flex;':''}${props.type==='border-card'?'border:1px solid var(--el-border-color,#dcdfe6);':''}`,children:position==='bottom'?body+header:header+body,notes:props.modelValue!==undefined&&typeof props.modelValue!=='string'&&typeof props.modelValue!=='number'?['Active tab is unknown; the first finite pane is shown. Declare active-state variants for other panes.']:[]};
}
