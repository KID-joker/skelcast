import type{Presentation}from'./types.js';
import{SOURCE_INITIAL}from'../expression.js';
import{escape,scalar}from'./shared.js';

/** Public control groups retain their intrinsic widths and source flex wrapping.
 * Unknown totals/localized labels use neutral glyph frames, never invented data. */
export function elementPagination(props:Record<string,unknown>,children:string):Presentation{
 const initial=props&&Object.hasOwn(props,SOURCE_INITIAL)?(props as{[SOURCE_INITIAL]:Record<string,unknown>})[SOURCE_INITIAL]:{};
 const field=(key:string)=>props[key]!=null&&typeof props[key]!=='symbol'?props[key]:initial?.[key];
 const small=field('size')==='small'||field('small')===true,large=field('size')==='large';
 const buttonSize=small?24:large?40:32,background=field('background')===true;
 const layout=scalar(field('layout'),'prev, pager, next, jumper, ->, total').split(',').map(s=>s.trim());
 const current=typeof field('currentPage')==='number'?Math.max(1,Math.floor(field('currentPage')as number)):1;
 const part=(name:string)=>{
  if(name==='total')return'<span data-sk-layout class="el-pagination__total"><span data-sk-layout data-sk-leaf style="display:inline-block;width:48px;height:14px"></span></span>';
  if(name==='sizes')return`<span data-sk-layout class="el-pagination__sizes"><span data-sk-layout class="el-select" data-sk-control style="display:inline-flex;align-items:center;justify-content:space-between;width:${small?100:128}px;height:${buttonSize}px;padding:0 11px;border:1px solid #dcdfe6;border-radius:4px"><span data-sk-layout>${typeof field('pageSize')==='number'?escape(field('pageSize')):'—'}</span><span data-sk-layout>⌄</span></span></span>`;
  if(name==='prev'||name==='next')return`<button data-sk-layout class="btn-${name}" disabled tabindex="-1" data-sk-control>${name==='prev'?'‹':'›'}</button>`;
  if(name==='pager')return`<ul data-sk-layout class="el-pager"><li data-sk-layout data-sk-control>${current}</li></ul>`;
  if(name==='jumper')return`<span data-sk-layout class="el-pagination__jump"><span data-sk-layout class="el-pagination__goto" data-sk-leaf style="display:inline-block;width:20px;height:14px"></span><input data-sk-layout class="el-pagination__editor" disabled tabindex="-1" value="${current}" style="width:56px;height:${buttonSize}px;border:1px solid #dcdfe6;border-radius:4px;text-align:center"><span data-sk-layout class="el-pagination__classifier" data-sk-leaf style="display:inline-block;width:14px;height:14px"></span></span>`;
  return name==='slot'?children:'';
 };
 const divider=layout.indexOf('->'),before=divider<0?layout:layout.slice(0,divider),after=divider<0?[]:layout.slice(divider+1);
 let html=before.map(part).join('');if(after.length)html+=`<div data-sk-layout class="el-pagination__rightwrapper">${after.map(part).join('')}</div>`;
 // First/last group margin behavior also applies when flex items wrap.
 html=html.replace(/^<([a-z]+)( data-sk-layout)? class="([^"]*)"/,(_,tag:string,layout:string|undefined,classes:string)=>`<${tag}${layout??''} class="${classes} is-first"`);
 return{tag:'div',className:`el-pagination${background?' is-background':''}${small?' el-pagination--small':large?' el-pagination--large':''}`,children:html,
  style:'display:flex;align-items:center;font-size:14px;white-space:nowrap',
  css:`:where(.el-pagination__total,.el-pagination__sizes,.el-pagination__jump){margin-left:16px;font-weight:400}:where(.el-pagination__total){display:inline-flex;align-items:center;line-height:21px;height:21px}:where(.el-pagination__jump){display:flex;align-items:center}:where(.el-pagination__goto){margin-right:8px}:where(.el-pagination__classifier){margin-left:8px}:where(.el-pagination .btn-prev,.el-pagination .btn-next,.el-pagination .el-pager li){display:flex;align-items:center;justify-content:center;box-sizing:border-box;border:0;padding:0 4px;min-width:${buttonSize}px;height:${buttonSize}px;line-height:${buttonSize}px;font-size:${small?12:14}px;border-radius:2px}:where(.el-pagination .btn-prev){margin-left:16px}:where(.el-pagination.is-background .btn-prev){margin:0 4px 0 16px}:where(.el-pagination.is-background .btn-next,.el-pagination.is-background .el-pager li){margin:0 4px}:where(.el-pagination .el-pager){display:flex;align-items:center;padding:0;margin:0;list-style:none}:where(.el-pagination>.is-first){margin-left:0}:where(.el-pagination__rightwrapper){display:flex;align-items:center;justify-content:flex-end;flex:1}`,
  notes:['Pagination retains declared control groups and wrapping; unknown totals, page counts and localized labels use a neutral frame.']};
}
