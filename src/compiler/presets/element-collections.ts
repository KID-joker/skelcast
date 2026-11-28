import {UNKNOWN,SOURCE_INITIAL,sourceObject} from '../expression.js';
import type {SkeletonHints} from '../../types.js';
import type {Presentation} from './types.js';
import {dimension,scalar,escape} from './shared.js';
type Props=Record<string,unknown>;
export interface TreeRow {data:unknown;label:unknown;level:number;leaf:boolean}
function initial(value:unknown,hints:SkeletonHints){return hints.state==='loading'&&value&&typeof value==='object'&&Object.hasOwn(value,SOURCE_INITIAL)?(value as {[SOURCE_INITIAL]:unknown})[SOURCE_INITIAL]:value}
export function treeRows(props:Props,hints:SkeletonHints):{rows:TreeRow[];unknown:boolean}{
 const input=initial(props.data,hints),options=props.props&&typeof props.props==='object'?props.props as Props:{};
 const child=typeof options.children==='string'?options.children:'children',label=typeof options.label==='string'?options.label:'label';
 const rows:TreeRow[]=[];let unknown=!Array.isArray(input),work=256;
 const expanded=Array.isArray(props.defaultExpandedKeys)?props.defaultExpandedKeys:[];
 const visit=(items:unknown[],level:number)=>{if(level>16){unknown=true;return}for(const data of items){if(--work<0){unknown=true;return}const record=data&&typeof data==='object'?data as Props:{},children=record[child];rows.push({data,label:typeof options.label==='string'||options.label===undefined?record[label]??UNKNOWN:UNKNOWN,level,leaf:!Array.isArray(children)||!children.length});if(Array.isArray(children)&&(props.defaultExpandAll===true||typeof props.nodeKey==='string'&&expanded.includes(record[props.nodeKey])))visit(children,level+1)}};
 if(Array.isArray(input))visit(input,0);else for(let i=0;i<(hints.repeat??4);i++)rows.push({data:UNKNOWN,label:UNKNOWN,level:0,leaf:true});
 return{rows,unknown};
}
export function collectionFrames(name:string,props:Props,hints:SkeletonHints){
 if(name==='eltree')return treeRows(props,hints).rows.map((row,index)=>({key:String(index),slot:'default',argument:sourceObject({data:row.data,node:sourceObject({data:row.data,label:row.label,level:row.level+1,isLeaf:row.leaf})})}));
 if(name==='elupload'){const files=initial(props.fileList,hints);return Array.isArray(files)?files.slice(0,256).map((file,index)=>({key:String(index),slot:'file',mask:true,argument:sourceObject({file})})):[]}
 return [];
}
export function elementTree(props:Props,hints:SkeletonHints,frames:{key:string;html:string}[],text:()=>string):Presentation{
 const{rows,unknown}=treeRows(props,hints),indent=dimension(props.indent,'18px');
 const children=rows.map((row,index)=>`<div data-sk-layout class="el-tree-node"><div data-sk-layout class="el-tree-node__content" style="height:var(--el-tree-node-content-height,26px);padding-left:calc(${row.level} * ${indent});display:flex;align-items:center;box-sizing:border-box"><span data-sk-layout class="el-tree-node__expand-icon${row.leaf?' is-leaf':''}" style="display:inline-flex;box-sizing:content-box;width:12px;height:12px;padding:6px;flex-shrink:0">${row.leaf?'':'›'}</span>${props.showCheckbox===true?'<input data-sk-layout data-sk-control type="checkbox" disabled tabindex="-1" style="width:14px;height:14px;margin:0 8px 0 0;flex-shrink:0">':''}${frames[index]?.html||`<span data-sk-layout class="el-tree-node__label">${typeof row.label==='string'||typeof row.label==='number'?`<span data-sk-text data-sk-measured data-sk-leaf data-sk-text-content="${escape(row.label)}"></span>`:text()}</span>`}</div></div>`).join('');
 return{tag:'div',className:'el-tree',style:'position:relative;min-width:0;font-size:14px;color:var(--el-text-color-regular,#606266)',children:children||'<div data-sk-layout data-sk-control class="el-tree__empty-block" style="min-height:60px;text-align:center;position:relative"><span style="line-height:60px">No data</span></div>',notes:unknown?['Tree data is unknown or exceeds the finite budget; rows are representative and runtime filters remain unknown.']:[]};
}
export function elementUpload(props:Props,slots:Record<string,string>,frames:{key:string;html:string}[],text:()=>string,hints:SkeletonHints):Presentation{
 const type=['picture','picture-card'].includes(String(props.listType))?String(props.listType):'text',input=initial(props.fileList,hints),files=Array.isArray(input)?input.slice(0,256):[];
 const rows=props.showFileList===false?'':files.map((file,index)=>{
  const data=file&&typeof file==='object'?file as Props:{};
  const value=frames[index]?.html|| (type==='text'?`<span data-sk-layout class="el-upload-list__item-name">${typeof data.name==='string'?`<span data-sk-text data-sk-measured data-sk-leaf data-sk-text-content="${escape(data.name)}"></span>`:text()}</span>`:'<span data-sk-layout data-sk-leaf style="display:block;width:100%;height:100%"></span>');
  return `<li data-sk-layout class="el-upload-list__item is-${escape(scalar(data.status,'success'))}" style="${type==='picture-card'?'display:inline-block;width:var(--el-upload-picture-card-size,148px);height:var(--el-upload-picture-card-size,148px);margin:0 8px 8px 0;vertical-align:top':type==='picture'?'height:92px;padding:10px 10px 10px 90px;margin-top:10px':'line-height:25px;margin-bottom:5px'};border-radius:6px;box-sizing:border-box;overflow:hidden">${value}</li>`;
 }).join('');
 let trigger=slots.trigger||slots.default||'';
 if(props.drag===true)trigger=`<div data-sk-layout class="el-upload-dragger" style="box-sizing:border-box;padding:var(--el-upload-dragger-padding-horizontal,40px) var(--el-upload-dragger-padding-vertical,10px);border:1px dashed var(--el-border-color,#dcdfe6);border-radius:6px;text-align:center;overflow:hidden">${trigger}</div>`;
 trigger=`<div data-sk-layout data-sk-control class="el-upload el-upload--${type}${props.drag===true?' is-drag':''}" style="${type==='picture-card'?'display:inline-flex;vertical-align:top;width:var(--el-upload-picture-card-size,148px);height:var(--el-upload-picture-card-size,148px);border:1px dashed var(--el-border-color-darker,#cdd0d6);border-radius:6px;box-sizing:border-box':props.drag===true?'display:block':'display:inline-flex'};align-items:center;justify-content:center">${trigger}</div>`;
 const list=`<ul data-sk-layout class="el-upload-list el-upload-list--${type}" style="list-style:none;padding:0;margin:${type==='picture-card'?'0':'10px 0 0'};${type==='picture-card'?'display:contents':''}">${rows}${type==='picture-card'?trigger:''}</ul>`;
 return{tag:'div',className:'el-upload-wrapper',children:type==='picture-card'?list:(trigger+(slots.trigger?slots.default:'')+(slots.tip||'')+(props.showFileList===false?'':list)),notes:input===UNKNOWN?['Upload file-list is unknown; preserve only the source-declared trigger without inventing files.']:[]};
}
export function elementAlert(props:Props,slots:Record<string,string>,text:()=>string):Presentation{
 const description=slots.default||escape(scalar(props.description)),title=slots.title||(props.title===UNKNOWN?text():escape(scalar(props.title))),has=!!description;
 return{tag:'div',className:`el-alert el-alert--${scalar(props.type,'info')} is-${scalar(props.effect,'light')}`,style:`width:100%;padding:8px 16px;box-sizing:border-box;border-radius:4px;display:flex;align-items:center;position:relative;overflow:hidden;font-size:14px;line-height:24px`,children:`${props.showIcon===true?`<span data-sk-layout class="el-alert__icon" style="display:inline-block;flex-shrink:0;width:${has?28:16}px;height:${has?28:16}px;margin-right:8px" data-sk-leaf></span>`:''}<div data-sk-layout class="el-alert__content" style="display:flex;flex-direction:column;gap:4px;min-width:0;flex:1"><span data-sk-layout class="el-alert__title${has?' is-bold':''}" style="font-size:${has?16:14}px;line-height:24px;${has?'font-weight:700':''}">${title}</span>${has?`<p data-sk-layout class="el-alert__description" style="font-size:14px;margin:0;line-height:24px">${description}</p>`:''}</div>${props.closable===false?'':'<span data-sk-layout data-sk-control class="el-alert__close-btn" style="flex-shrink:0;font-size:12px;margin-left:12px">×</span>'}`};
}
