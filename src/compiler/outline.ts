import type { RenderHost } from './render-host.js';
import type { RenderContext, SourceNode, SourceSlot } from './context.js';
import { evaluate, evaluateString, bindPattern, type Ast } from './expression.js';
import { nodeName, isRenderFunction } from './ast.js';
import type * as t from '@babel/types';
import { parseVueLoop, vueHelper } from './vue-syntax.js';
import { styleString } from './html.js';
import { resolvePreset } from './presets/index.js';
import type { TableColumn } from './presets/columns.js';
import { dimension, scalar } from './presets/shared.js';
import { tableOutline } from './presets/table.js';
import type { TemplateChildNode } from '@vue/compiler-dom';
import type { ComponentReference } from './presets/types.js';
import { configuredPolicy, importedPolicy } from '../policy.js';

export const tableNames = new Set(['eltable', 'table', 'ndatatable']);
const columnNames = new Set(['eltablecolumn', 'table.column', 'tablecolumn']);

/** Unknown internal dimensions do not turn an identified region into a generic fallback. */
export function shallowPresentation(host:RenderHost,tag:string,reference?:ComponentReference):boolean{
  const policy=configuredPolicy(host.options.componentPolicies,tag)??(reference&&importedPolicy(reference.request,reference.exported));
  return !!policy||['table','svg','canvas'].includes(tag)||tableNames.has(resolvePreset(host.options.componentPresets,reference)?.name??'');
}

/** Read bounded declarations only. Never render table cells, helpers or slots. */
export async function outlineColumns(host: RenderHost, source: SourceSlot, native = false): Promise<TableColumn[]> {
  const columns: TableColumn[] = [];
  let visited = 0;
  const add = (props: Record<string, unknown>) => columns.push({label:scalar(props.label ?? props.title),field:'',width:dimension(props.width ?? props.minWidth,'')});
  const jsxProps = (node: t.JSXElement, ctx: RenderContext): Record<string, unknown> => Object.fromEntries(node.openingElement.attributes.flatMap(a => a.type === 'JSXAttribute' ? [[nodeName(a.name),!a.value ? true : a.value.type === 'StringLiteral' ? a.value.value : a.value.type === 'JSXExpressionContainer' ? evaluate(a.value.expression,ctx) : undefined]] : []));
  const literal = (nodes: (Ast | TemplateChildNode)[]): string => nodes.map(n => n.type === 2 ? n.content : n.type === 'JSXText' ? n.value.trim() : n.type==='StringLiteral'?n.value:'').join(' ').trim();
  const visit = async (nodes: (Ast | TemplateChildNode)[], ctx: RenderContext, skipLoop = false): Promise<void> => {
    for (const node of nodes) {
      if (++visited > 128 || columns.length >= 6) return;
      let tag: string | undefined, children: any[] = [], props: Record<string, unknown> = {};
      if (node.type === 1) {
        if(node.props.some(p=>p.type===7&&['if','show'].includes(p.name)&&p.exp?.type===4&&evaluateString(p.exp.content,ctx)===false))continue;
        const loop=node.props.find(p=>p.type===7&&p.name==='for');
        if(!skipLoop&&loop?.type===7&&loop.exp?.type===4){
          const syntax=parseVueLoop(loop.exp.content,ctx),params=syntax?.params;
          const list=syntax?evaluateString(syntax.source,ctx):undefined;
          if(Array.isArray(list)&&params)for(const[item,index]of list.slice(0,6).map((item,index)=>[item,index] as const)){
            const local={...ctx,env:{...ctx.env}};bindPattern(params[0],item,local.env);bindPattern(params[1],index,local.env);await visit([node],local,true);
          }
          continue;
        }
        tag = node.tag; children = node.children;
        props = Object.fromEntries(node.props.flatMap(p => p.type === 6 ? [[p.name,p.value?.content??true]] : p.name === 'bind' && p.arg?.type === 4 && p.arg.isStatic ? [[p.arg.content,evaluateString(p.exp?.type===4?p.exp.content:'',ctx)]] : []));
      } else if (node.type === 'JSXElement') {tag=nodeName(node.openingElement.name);children=node.children;props=jsxProps(node,ctx);}
      else if (node.type === 'JSXFragment') {await visit(node.children,ctx);continue;}
      else if (node.type === 'ArrayExpression') {await visit(node.elements.filter((n): n is Exclude<typeof n,null>=>n!==null),ctx);continue;}
      else if (node.type === 'CallExpression') {
        // Native h() declarations are syntax, not application function calls.
        if(!vueHelper(ctx.module,node.callee,'h'))continue;
        const identity=node.arguments[0];
        const name=(identity:Ast|undefined):string|undefined=>identity?.type==='MemberExpression'&&!identity.computed?`${name(identity.object)}.${nodeName(identity.property)}`:nodeName(identity);
        tag=identity?.type==='StringLiteral'?identity.value:name(identity);
        const value=evaluate(node.arguments[1],ctx);props=value&&typeof value==='object'?value as Record<string,unknown>:{};
        const child=node.arguments[2];children=child?.type==='ArrayExpression'?child.elements.filter(Boolean):child?[child]:[];
      }
      if (!tag) continue;
      if(tag==='slot'&&source.framework==='vue'){
        const forwarded=ctx.slots?.[typeof props.name==='string'?props.name:'default'];
        if(forwarded)await visit(forwarded.nodes,forwarded.context);
        continue;
      }
      if (native) {
        if (tag === 'th') {add({...props,label:literal(children)});continue;}
        if (['thead','tr','template'].includes(tag)) await visit(children,ctx);
      } else {
        const ref=await host.componentReference(tag,ctx);
        const preset=resolvePreset(host.options.componentPresets,ref);
        if (preset && columnNames.has(preset.name)) {
          const before=columns.length;
          // Only directly nested column declarations; cell wrappers stay opaque.
          const nested=children.filter(child=>child.type===1||child.type==='JSXElement');
          for(const child of nested){
            const name=child.type===1?child.tag:nodeName(child.openingElement.name);
            const resolved=name?resolvePreset(host.options.componentPresets,await host.componentReference(name,ctx)):undefined;
            if(resolved&&columnNames.has(resolved.name))await visit([child],ctx);
          }
          if(columns.length===before)add(props);
        } else if (['template','thead','tr'].includes(tag)) await visit(children,ctx);
      }
    }
  };
  const selected=source.framework==='render'?source.slots?.default??source:source;
  const fn=isRenderFunction(selected.renderFunction)?selected.renderFunction:undefined;
  const body=fn?.body.type==='BlockStatement'?fn.body.body.length===1&&fn.body.body[0].type==='ReturnStatement'?fn.body.body[0].argument:undefined:fn?.body;
  await visit(body?[body]:selected.nodes,selected.context);
  return columns;
}

export async function nativeTableOutline(host: RenderHost, props: Record<string, unknown>, source: SourceSlot, node: SourceNode): Promise<string | undefined> {
  if(!host.masked(source.context))return;
  const columns=await outlineColumns(host,source,true);
  const view=tableOutline(props,columns,host.hints,true);
  host.record('component','table','Use a bounded table outline; skip body cells and callbacks',source.context,node);
  return host.element(view.tag,{...props,class:[props.class??props.className,view.className],className:undefined,style:`${view.style};${styleString(props.style)}`},view.children,source.context,node,{layout:true,outline:true});
}
