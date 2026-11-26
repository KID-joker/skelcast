import type * as t from '@babel/types';
import{parseExpression}from'@babel/parser';
import{isRenderFunction,nodeName,unwrapExpression,walk}from'./ast.js';
import{UNKNOWN,SOURCE_INITIAL,evaluate,expressionText,safeKey,type Value}from'./expression.js';
import type{RenderContext}from'./context.js';

export function patternNames(node:t.Node):string[]{
 if(node.type==='Identifier')return[node.name];
 if(node.type==='AssignmentPattern')return patternNames(node.left);
 if(node.type==='RestElement')return patternNames(node.argument);
 if(node.type==='ObjectPattern')return node.properties.flatMap(p=>patternNames(p.type==='RestElement'?p.argument:p.value));
 if(node.type==='ArrayPattern')return node.elements.flatMap(p=>p?patternNames(p):[]);
 return[];
}
function path(node:t.Node|undefined|null):string|undefined{
 const value=unwrapExpression(node);
 if(value?.type==='Identifier')return value.name;
 if((value?.type==='MemberExpression'||value?.type==='OptionalMemberExpression')&&!value.computed){const base=path(value.object),key=nodeName(value.property);return base&&safeKey(key)?base+'.'+key:undefined;}
}
/** Initial presentation facts travel separately from actual expression values.
 * Only explicit presentation consumers may project them into a loading frame. */
export function initialExpression(node:t.Node,ctx:RenderContext):Value{
 const facts=ctx.initialValues;if(!facts)return UNKNOWN;
 const bindings={...ctx.bindings};let found=false;
 walk(node,(n,ancestors)=>{
  const key=path(n);if(!key)return;
  const root=key.split('.')[0];
  if(ancestors.some(a=>isRenderFunction(a)&&a.params.some(p=>patternNames(p).includes(root))))return;
  const text=expressionText(n,ctx);if(Object.hasOwn(bindings,text))return;
  const prefix=Object.keys(facts).filter(name=>key===name||key.startsWith(name+'.')).sort((a,b)=>b.length-a.length)[0];
  if(!prefix)return;
  let value=facts[prefix];
  for(const part of key.slice(prefix.length).split('.').filter(Boolean)){
   if(!safeKey(part)||!value||typeof value!=='object'){value=UNKNOWN;break;}
   const descriptor=Object.getOwnPropertyDescriptor(value,part);value=descriptor&&'value'in descriptor?descriptor.value:UNKNOWN;
  }
  if(value!==UNKNOWN){bindings[text]=value;found=true;}
 });
 return found?evaluate(node,{...ctx,bindings}):UNKNOWN;
}
export function initialString(text:string,ctx:RenderContext):Value{
 try{return initialExpression(parseExpression(text,{plugins:['typescript']}),{...ctx,code:text});}catch{return UNKNOWN;}
}
export function presentationInputs(props:Record<string,Value>){
 const values:Record<string,Value>={},initial:Record<string,Value>={};
 for(const[key,value]of Object.entries(props)){
  if(value&&typeof value==='object'&&Object.hasOwn(value,SOURCE_INITIAL)){
   initial[key]=(value as{[SOURCE_INITIAL]:Value})[SOURCE_INITIAL];
   values[key]=Object.keys(value).length?Object.fromEntries(Object.entries(value)):UNKNOWN;
  }else{values[key]=value;initial[key]=value;}
 }
 return{values,initial};
}
