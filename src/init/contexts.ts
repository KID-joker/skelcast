import path from 'node:path';
import {parse as parseSFC} from '@vue/compiler-sfc';
import {parse as parseDOM} from '@vue/compiler-dom';
import type {SkeletonTarget} from '../types.js';
import type {InitChange,InitDiagnostic} from './types.js';
import {applyEdits,type Edit} from './ast.js';
import {resolveSource,relativePath,type SourceFile} from './scan.js';
import {componentName} from '../compiler/components.js';
import {digest} from '../compiler/styles.js';

/** Carry a finite call-site identifier, never runtime response values. The
 * existing reusable component and its slots stay in place; no wrapper is added. */
export async function requestContexts(root:string,configRoot:string,files:SourceFile[],changes:InitChange[],targets:SkeletonTarget[],aliases:Record<string,string>,diagnostics:InitDiagnostic[]) {
 const contexts=new Map<string,NonNullable<SkeletonTarget['contexts']>>();
 const edits=new Map<string,Edit[]>(),codes=new Map(files.map(file=>[file.file,changes.find(c=>c.file===file.file)?.after??file.code]));
 const add=(file:string,edit:Edit)=>{const list=edits.get(file)??[];if(!list.some(e=>e.start===edit.start&&e.text===edit.text))list.push(edit);edits.set(file,list)};
 const requests=targets.filter(t=>t.kind==='request'&&t.region&&t.source.endsWith('.vue'));
 for(const source of files) {
  if(!source.vue)continue;
  const code=codes.get(source.file)!,sfc=parseSFC(code).descriptor;if(!sfc.template)continue;
  const imports=new Map<string,string>();
  for(const[name,request]of source.imports){const file=await resolveSource(root,source.file,request,aliases);if(file)imports.set(componentName(name),file)}
  let ordinal=0;
  const visit=(nodes:import('@vue/compiler-dom').TemplateChildNode[],loop=false)=>{for(const node of nodes)if(node.type===1){
   const repeated=loop||node.props.some(p=>p.type===7&&p.name==='for');
   const imported=imports.get(componentName(node.tag));
   const matched=requests.filter(t=>path.resolve(configRoot,t.source)===path.resolve(root,imported??''));
   if(matched.length){
    if(repeated){diagnostics.push({code:'REQUEST_CONTEXT_UNKNOWN',file:source.file,line:node.loc.start.line,message:'A repeated component call needs explicit finite contexts; do not reuse one unknown instance layout'});}
    else {
     const attr=node.props.find(p=>p.type===6&&p.name==='data-sk-context');
     const bound=node.props.some(p=>p.type===7&&p.name==='bind'&&p.arg?.type===4&&p.arg.content==='data-sk-context');
     if(!bound){
      const key=attr?.type===6?attr.value?.content:`c${digest(`${source.file}:${node.tag}:${ordinal++}`).slice(0,12)}`;
      if(key&&/^[a-zA-Z0-9_-]+$/.test(key)){
       if(!attr)add(source.file,{start:sfc.template!.loc.start.offset+node.loc.start.offset+1+node.tag.length,end:sfc.template!.loc.start.offset+node.loc.start.offset+1+node.tag.length,text:` data-sk-context="${key}"`});
       for(const target of matched){const mapping=contexts.get(target.id)??{...target.contexts};mapping[key]={source:relativePath(configRoot,path.resolve(root,source.file))};contexts.set(target.id,mapping)}
      }
     }
    }
   }
   visit(node.children,repeated);
  }};
  visit(parseDOM(sfc.template.content).children);
 }
 for(const target of requests){
  if(!contexts.has(target.id))continue;
  const file=relativePath(root,path.resolve(configRoot,target.source)),code=codes.get(file);if(!code)continue;
  const sfc=parseSFC(code).descriptor;if(!sfc.template)continue;
  const visit=(nodes:import('@vue/compiler-dom').TemplateChildNode[])=>{for(const node of nodes)if(node.type===1){
   const managed=node.props.some(p=>p.type===7&&p.name==='bind'&&p.arg?.type===4&&p.arg.content==='artifact'&&p.exp?.type===4&&p.exp.content===target.region);
   if(managed){
    const context=node.props.find(p=>(p.type===6?p.name:p.arg?.type===4?p.arg.content:'')==='context');
    const expression="typeof $attrs['data-sk-context'] === 'string' ? $attrs['data-sk-context'] : undefined";
    if(!context){const offset=sfc.template!.loc.start.offset+node.loc.start.offset+1+node.tag.length;add(file,{start:offset,end:offset,text:` :context="${expression}"`})}
    else if(context.type===7&&context.exp?.type===4&&context.exp.content==="$attrs['data-sk-context']"){const offset=sfc.template!.loc.start.offset;add(file,{start:offset+context.exp.loc.start.offset,end:offset+context.exp.loc.end.offset,text:expression})}
   }
   visit(node.children);
  }};visit(parseDOM(sfc.template.content).children);
 }
 for(const[file,list]of edits){const after=applyEdits(codes.get(file)!,list),existing=changes.find(c=>c.file===file);if(existing)existing.after=after;else changes.push({file,before:files.find(f=>f.file===file)!.code,after,reason:'Connect finite source call-site context to reusable request boundaries'})}
 return contexts;
}
