import type { DirectiveNode, TemplateChildNode as VueNode } from '@vue/compiler-dom';
import type { RenderContext } from './context.js';
import { UNKNOWN, bindPattern, evaluateString, parseSourceExpression } from './expression.js';
import type { RenderHost } from './render-host.js';
import { parseVueLoop } from './vue-syntax.js';

const syntax = new WeakMap<VueNode[], { node: VueNode; slot?: DirectiveNode; loop?:DirectiveNode; nodes: VueNode[] }[]>();

/** Share template classification, while resolving dynamic names per instance. */
export function templateSlots(nodes: VueNode[]) {
  let entries = syntax.get(nodes);
  if (!entries) {
    entries = nodes.map(node => {
      const props=node.type===1&&node.tag==='template'?node.props:[];
      const slot=props.find((prop):prop is DirectiveNode=>prop.type===7&&prop.name==='slot');
      const loop=slot?props.find((prop):prop is DirectiveNode=>prop.type===7&&prop.name==='for'):undefined;
      return { node, slot, loop, nodes: slot?.arg?.type === 4 && node.type === 1 ? node.children : [node] };
    });
    syntax.set(nodes, entries);
  }
  return entries;
}

export function slotName(host: RenderHost, slot: DirectiveNode | undefined, ctx: RenderContext, node: VueNode): string | undefined {
  if (!slot?.arg) return 'default';
  const name = slot.arg.type === 4 && slot.arg.isStatic ? slot.arg.content
    : evaluateString(slot.arg.type === 4 ? slot.arg.content : '', ctx);
  if (typeof name === 'string') return name;
  host.diagnose('SLOT_UNKNOWN', 'Dynamic slot name needs a finite source value', ctx, node);
}

export function slotParameter(host: RenderHost, slot: DirectiveNode | undefined, ctx: RenderContext, node: VueNode) {
  if (slot?.exp?.type !== 4 || !slot.exp.content) return;
  const fn = parseSourceExpression(`(${slot.exp.content})=>0`, ctx);
  if (fn?.type === 'ArrowFunctionExpression') return fn.params[0];
  host.diagnose('SLOT_UNKNOWN', 'Cannot parse scoped slot parameters', ctx, node);
}

/** Expand only named slot declarations over a finite source key list. */
export function expandedTemplateSlots(host:RenderHost,nodes:VueNode[],ctx:RenderContext){
 const result:(ReturnType<typeof templateSlots>[number]&{context:RenderContext})[]=[];
 for(const entry of templateSlots(nodes)){
  if(!entry.loop){result.push({...entry,context:ctx});continue}
  const loop=parseVueLoop(entry.loop.exp?.type===4?entry.loop.exp.content:undefined,ctx);
  const list=loop?evaluateString(loop.source,ctx):UNKNOWN,params=loop?.params;
  if(!Array.isArray(list)||list.length>256||!params){host.diagnose('SLOT_UNKNOWN','Named slot repetition needs a finite source key list',ctx,entry.node);continue}
  for(let index=0;index<list.length;index++){const context={...ctx,env:{...ctx.env}};bindPattern(params[0],list[index],context.env);if(params[1])bindPattern(params[1],index,context.env);result.push({...entry,context})}
 }
 return result;
}
