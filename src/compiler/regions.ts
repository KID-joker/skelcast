import type * as t from '@babel/types';
import type {ElementNode,TemplateChildNode} from '@vue/compiler-dom';
import {VISITOR_KEYS} from '@babel/types';
import {isRenderFunction,patternNames} from './ast.js';
import {UNKNOWN,bindPattern,evaluate,type Value} from './expression.js';
import { localRenderFunction, prepareLocalRenderCall } from './branches.js';
import {slotValue,type SourceSlot,type RenderContext} from './context.js';
import type {RenderHost} from './render-host.js';
import{initialExpression}from'./initial-state.js';
import{vueHelper}from'./vue-syntax.js';

/** A region is compiled in its lexical slot/loop context, without rendering its
 * surrounding application UI. Selection never changes guards inside the region. */
export class VueRegion {
 result:string|undefined;
 private suspended=0;
 // Template syntax is immutable; dynamic tag copies can reuse cached children.
 private containment=new WeakMap<TemplateChildNode,boolean>();
 constructor(readonly file:string,readonly node:ElementNode,readonly entry?:{file:string;node:ElementNode}){}
 private contains(node:TemplateChildNode):boolean{
  const cached=this.containment.get(node);if(cached!==undefined)return cached;
  const contains=node===this.node||node===this.entry?.node||node.type===1&&node.children.some(child=>this.contains(child));
  this.containment.set(node,contains);return contains;
 }
 carries(slot:SourceSlot,seen=new Set<SourceSlot>()):boolean{
  if(seen.has(slot)||seen.size>32)return false;const next=new Set(seen).add(slot);
  if(slot.context.module.file===this.file)return slot.framework==='vue'&&slot.nodes.some(node=>this.contains(node));
  return Object.values(slot.context.slots??{}).some(other=>this.carries(other,next));
 }
 mode(node:TemplateChildNode,ctx:RenderContext):'skip'|'ancestor'|'target'|undefined{
  if(this.suspended)return;
  if(this.result!==undefined)return'skip';
  if(ctx.module.file===this.file)return node===this.node?'target':this.contains(node)?'ancestor':'skip';
  if(ctx.module.file===this.entry?.file)return this.contains(node)?'ancestor':'skip';
  return Object.values(ctx.slots??{}).some(slot=>this.carries(slot))?'ancestor':'skip';
 }
 async capture(render:()=>Promise<string>){
  if(this.result!==undefined)return'';
  this.suspended++;try{this.result=await render();}finally{this.suspended--;}
  return'';
 }
 get active(){return!this.suspended;}
}

/** Slot arguments have their own lexical bindings, including aliases/defaults. */
export function bindSlotArgument(pattern:t.Node,value:Value,ctx:RenderContext):void{
 bindPattern(pattern,value,ctx.env,{context:ctx,onBind(name){
  for(const key of Object.keys(ctx.initialValues??{}))if(key===name||key.startsWith(name+'.'))delete ctx.initialValues![key];
 }});
}
export function bindSlotInitial(pattern:t.Node,initial:Value,ctx:RenderContext){
 if(initial===UNKNOWN)return;
 const local={...ctx,env:{...ctx.env},initialValues:undefined};bindSlotArgument(pattern,initial,local);
 ctx.initialValues??={};for(const name of patternNames(pattern))if(local.env[name]!==UNKNOWN)ctx.initialValues[name]=local.env[name];
}

export async function renderSlotCall(host:RenderHost,node:t.CallExpression|t.OptionalCallExpression,ctx:RenderContext,value:Value):Promise<string|undefined>{
 if(!value||typeof value!=='object'||!Object.hasOwn(value,slotValue))return;
 if(node.arguments.length>1||node.arguments.some(argument=>argument.type==='SpreadElement'))return host.fallback(ctx,node,'Scoped slot arguments need one finite source object');
 const argument=node.arguments[0]?evaluate(node.arguments[0],ctx):{};
 return host.renderSlot((value as {[slotValue]:SourceSlot})[slotValue],ctx,argument,node.arguments[0]?initialExpression(node.arguments[0],ctx):UNKNOWN);
}

/** Read reachable slot invocations from a returned presentation tree. Event
 * handlers, lifecycle callbacks and arbitrary application functions stay opaque. */
export async function projectSelectedSlots(host:RenderHost,body:t.Node,ctx:RenderContext):Promise<void>{
 let remaining=4000;
 const visit=async(node:t.Node,context:RenderContext,depth:number):Promise<void>=>{
  if(--remaining<0||depth>32)return;
  if(isRenderFunction(node)||node.type==='ObjectMethod'||node.type==='ClassMethod')return;
  if(node.type==='JSXAttribute')return;
  if(node.type==='ConditionalExpression'){
   const test=evaluate(node.test,context);
   if(test===UNKNOWN)host.diagnose('BRANCH_DEFAULT','Select source slot contexts from an unresolved render branch; runtime state remains unknown',context,node);
   if(test===UNKNOWN||test)await visit(node.consequent,context,depth+1);
   if(test===UNKNOWN||!test)await visit(node.alternate,context,depth+1);
   return;
  }
  if(node.type==='LogicalExpression'){
   const left=evaluate(node.left,context);
   await visit(node.left,context,depth+1);
   if(left===UNKNOWN||node.operator==='&&'&&!!left||node.operator==='||'&&!left||node.operator==='??'&&left==null)await visit(node.right,context,depth+1);
   return;
  }
  if(node.type==='CallExpression'||node.type==='OptionalCallExpression'){
   const callee=evaluate(node.callee,context);
   if(callee&&typeof callee==='object'&&Object.hasOwn(callee,slotValue)){
    const slot=(callee as {[slotValue]:SourceSlot})[slotValue];
    if(host.hasSelectedSlot(slot)){
     const argument=node.arguments.length===0?{}:node.arguments.length===1&&node.arguments[0].type!=='SpreadElement'?evaluate(node.arguments[0],context):UNKNOWN;
     await host.renderSlot(slot,context,argument,node.arguments[0]?initialExpression(node.arguments[0],context):UNKNOWN);
    }
    return;
   }
   const fn = localRenderFunction(callee);
   if(fn){
    const { local, body } = prepareLocalRenderCall(host, fn, node, context, bindSlotArgument);
    if(body)await visit(body,local,depth+1);
    return;
   }
   if(node.type==='CallExpression'&&vueHelper(context.module,node.callee,'h')&&node.arguments[0]?.type==='Identifier'){
    const reference=await host.componentReference(node.arguments[0].name,context);
    if(reference?.file){await host.vueExpression(node,context);return;}
   }
  }
  for(const key of VISITOR_KEYS[node.type]??[]){
   const child=(node as unknown as Record<string,unknown>)[key];
   if(Array.isArray(child)){for(const item of child)if(item&&typeof item==='object'&&'type'in item)await visit(item as t.Node,context,depth+1);}
   else if(child&&typeof child==='object'&&'type'in child)await visit(child as t.Node,context,depth+1);
  }
 };
 await visit(body,ctx,0);
}
