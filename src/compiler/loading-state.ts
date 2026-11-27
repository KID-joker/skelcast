import type * as t from '@babel/types';
import {nodeName,walk} from './ast.js';
import {evaluateString,parseSourceExpression,UNKNOWN,type ExpressionContext} from './expression.js';
import type {RenderContext,ModuleInfo} from './context.js';
import { hasStateBinding } from './branches.js';

interface CollectionFacts { aliases: Map<string, string>; updated: Set<string> }
// Render contexts copy ModuleInfo but retain its immutable import table.
const cache = new WeakMap<ModuleInfo['imports'], CollectionFacts>();
function path(node:t.Node|undefined|null,refs=new Set<string>()):string|undefined{
 if(node?.type==='Identifier')return node.name;
 if(node?.type!=='MemberExpression'||node.computed)return;
 const root=path(node.object,refs),key=nodeName(node.property);
 if(!root||!key)return;
 return key==='value'&&refs.has(root)?root:root+'.'+key;
}
/** Prove collection/count aliases written from the same response scope. This
 * records syntax only: request handlers, callbacks and requests are never run. */
function collectionFacts(mod:ModuleInfo):CollectionFacts{
 const previous=cache.get(mod.imports);if(previous)return previous;
 const refs=new Set<string>();
 for(const s of mod.ast.program.body)if(s.type==='VariableDeclaration')for(const d of s.declarations)if(d.id.type==='Identifier'&&d.init?.type==='CallExpression'&&d.init.callee.type==='Identifier'){
  const imported=mod.imports.get(d.init.callee.name);if(imported?.request==='vue'&&['ref','shallowRef'].includes(imported.exported))refs.add(d.id.name);
 }
 const scopes=new Map<t.Node,{target:string;source:string}[]>();
 walk(mod.ast,(node,ancestors)=>{
  if(node.type!=='AssignmentExpression'||node.operator!=='=')return;
  const scope=[...ancestors].reverse().find(n=>['ArrowFunctionExpression','FunctionExpression','FunctionDeclaration','ObjectMethod'].includes(n.type));
  const target=path(node.left,refs);if(!scope||!target)return;
  let list=scopes.get(scope);if(!list)scopes.set(scope,list=[]);
  const source=path(node.right,refs);if(source)list.push({target,source});
  if(node.right.type==='ObjectExpression')for(const prop of node.right.properties)if(prop.type==='ObjectProperty'&&!prop.computed){const key=nodeName(prop.key),source=path(prop.value,refs);if(key&&source)list.push({target:target+'.'+key,source});}
 });
 const result=new Map<string,string>(),conflicts=new Set<string>();
 const add=(name:string,value:string)=>{if(result.has(name)&&result.get(name)!==value)conflicts.add(name);else result.set(name,value);};
 for(const assignments of scopes.values())for(const collection of assignments)for(const count of assignments)if(count.source===collection.source+'.length')add(count.target,collection.target+'.length');
 for(const name of conflicts)result.delete(name);
 const facts={aliases:result,updated:new Set([...scopes.values()].flatMap(list=>list.map(a=>a.target)))};
 cache.set(mod.imports,facts);return facts;
}
function rootPath(node:t.Node|undefined):string|undefined{
 while(node?.type==='CallExpression'&&node.callee.type==='MemberExpression'&&!node.callee.computed&&['slice','filter','map','toReversed'].includes(nodeName(node.callee.property)??''))node=node.callee.object;
 return path(node);
}
export function collectionRoot(text:string,ctx?:ExpressionContext):string|undefined{
 return rootPath(parseSourceExpression(text,ctx));
}
export function loadingPresence(text:string,ctx:RenderContext):{root:string;present:boolean}|undefined{
 if(!ctx.loading)return;
 try{
  const test=parseSourceExpression(text,ctx);
  if(test?.type!=='BinaryExpression')return;
  const lengthPath=(node:t.Node)=>{if(node.type==='MemberExpression'&&!node.computed&&nodeName(node.property)==='length'&&node.object.start!=null&&node.object.end!=null){const root=rootPath(node.object);return root?root+'.length':undefined;}return path(node);};
  let value=lengthPath(test.left),number=test.right.type==='NumericLiteral'?test.right.value:undefined,operator:string=test.operator;
  if(number===undefined&&test.left.type==='NumericLiteral'){number=test.left.value;value=lengthPath(test.right);operator=({'<':'>','<=':'>=','>':'<','>=':'<='} as Record<string,string>)[operator]??operator;}
  if(!value||number===undefined)return;
  value=collectionFacts(ctx.module).aliases.get(value)??value;
  if(!value.endsWith('.length'))return;
  const root=value.slice(0,-7);
  if((operator==='>'&&number===0)||(operator==='>='&&number===1)||(operator==='!=='&&number===0)||(operator==='!='&&number===0))return{root,present:true};
  if((['===','==','<='].includes(operator)&&number===0)||(operator==='<'&&number===1))return{root,present:false};
 }catch{/* Permission/business guards are not projection candidates. */}
}
export function projectsCollection(root:string|undefined,ctx:RenderContext):boolean{
 if(!root||!ctx.loading||ctx.control)return false;
 return !!ctx.projectedCollections?.has(root)||collectionFacts(ctx.module).updated.has(root);
}
export function repeatCapacity(text:string,ctx:RenderContext):number{
 if(ctx.bindings&&Object.hasOwn(ctx.bindings,text))return 4;
 try{let node:t.Node|undefined=parseSourceExpression(text,ctx);while(node?.type==='CallExpression'&&node.callee.type==='MemberExpression'){
  if(nodeName(node.callee.property)==='slice'&&node.arguments.length===2){const a=node.arguments[0],b=node.arguments[1];if(a.start!=null&&a.end!=null&&b.start!=null&&b.end!=null){const from=evaluateString(text.slice(a.start,a.end),ctx),to=evaluateString(text.slice(b.start,b.end),ctx);if(typeof from==='number'&&typeof to==='number'&&Number.isInteger(to-from)&&to>from)return Math.min(24,to-from);}}
  node=node.callee.object;
 }}catch{/* Default is finite, not an inferred result count. */}
 return 4;
}
export function collectionEmpty(root:string|undefined,ctx:RenderContext):boolean{const value=root?evaluateString(root,ctx):UNKNOWN;return Array.isArray(value)&&value.length===0;}

/** Share loading eligibility; each frontend supplies its own collection syntax
 * and decides whether the projected context should reach subsequent siblings. */
export function loadingBranch(text: string, ctx: RenderContext, includes: (root: string, present: boolean) => boolean) {
 const boundState = hasStateBinding(text, ctx);
 const presence = boundState ? undefined : loadingPresence(text, ctx);
 const projected = presence && projectsCollection(presence.root, ctx) && collectionEmpty(presence.root, ctx)
  && includes(presence.root, presence.present) ? presence : undefined;
 return { boundState, projected };
}

export function projectCollection(ctx: RenderContext, root: string): RenderContext {
 return { ...ctx, projectedCollections: new Set([...ctx.projectedCollections ?? [], root]) };
}

export function exclusiveChoice(text:string,ctx?:ExpressionContext):{key:string;value:string}|undefined{
 try{const node=parseSourceExpression(text,ctx);if(node?.type!=='BinaryExpression'||node.operator!=='===')return;
  const key=path(node.left),value=node.right;
  if(key&&['StringLiteral','NumericLiteral','BooleanLiteral'].includes(value.type)&&'value'in value)return{key,value:JSON.stringify(value.value)};
 }catch{/* Only proven scalar equalities are mutually exclusive. */}
}
