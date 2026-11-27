import type * as t from '@babel/types';
import {isRenderFunction,nodeName,patternNames as names,unwrapExpression,walk} from './ast.js';
import {UNKNOWN,SOURCE_PROJECTION,SOURCE_INITIAL,SOURCE_TYPE_TEST,SOURCE_COLLECTION,SOURCE_CELL_GLYPHS,SOURCE_COPY,SOURCE_FUNCTION,SOURCE_VUE,sourceCapacity,bindPattern,evaluate,safeKey,type Value} from './expression.js';
import {ambiguousExport,type ModuleInfo} from './context.js';
import {sourceCopyRecipe,type CopyRecipe} from './copy-recipe.js';
import {resolveReexports} from './exports.js';

interface Declaration {pattern:t.VariableDeclarator['id'];expression:t.Node|null|undefined;constant:boolean}
interface Binding {module:ModuleInfo;name:string}
const identity=(b:Binding)=>JSON.stringify([b.module.file,b.name]);
const script=(file:string)=>/\.[cm]?[jt]sx?$/.test(file);
function rootName(node:t.Node|undefined|null):string|undefined{
 while(node?.type==='MemberExpression'||node?.type==='OptionalMemberExpression')node=node.object;
 return node?.type==='Identifier'?node.name:undefined;
}
function references(expression:t.Node,escape=false):Set<string>{
 const result=new Set<string>();
 walk(expression,(node,ancestors)=>{
  if(node.type!=='Identifier')return;
  const parent=ancestors.at(-1);
  if(escape&&(parent?.type==='CallExpression'||parent?.type==='OptionalCallExpression')&&parent.callee===node)return;
  if(parent?.type==='ObjectProperty'&&parent.key===node&&!parent.computed)return;
  if((parent?.type==='MemberExpression'||parent?.type==='OptionalMemberExpression')&&parent.property===node&&!parent.computed)return;
  if(ancestors.some(a=>isRenderFunction(a)&&a.params.some(p=>names(p).includes(node.name))))return;
  if(parent?.type==='VariableDeclarator'&&parent.id===node)return;
  result.add(node.name);
 });
 return result;
}

/** Resolve source declarations, not live ESM values. Loading a module means
 * parsing it through the compiler host; no module or application function runs. */
export class StaticValues {
 private indexes=new WeakMap<ModuleInfo,{declarations:Map<string,Declaration>;unsafe:Set<string>}>();
 private cache=new Map<string,Value>();
 private cycles=new Set<string>();
 private copies=new WeakMap<ModuleInfo,Map<t.Node,CopyRecipe|undefined>>();
 private environments=new WeakMap<ModuleInfo,{values:Record<string,Value>;cycles:number}>();
 constructor(private load:(file:string)=>Promise<ModuleInfo>,private external?:(request:string)=>Promise<ModuleInfo|undefined>){}
 /** Summarize independently declared fields of an unconditional return object.
  * Calls, callbacks and lifecycle handlers are never evaluated. Parameters and
  * anything written/escaped remain unknown, rather than assuming a hook result. */
 private async projection(mod:ModuleInfo,fn:t.FunctionDeclaration|t.FunctionExpression|t.ArrowFunctionExpression,seen:Set<string>,budget:{remaining:number}):Promise<Value>{
  let recipes=this.copies.get(mod);if(!recipes)this.copies.set(mod,recipes=new Map());
  if(!recipes.has(fn))recipes.set(fn,sourceCopyRecipe(mod,fn));
  const recipe=recipes.get(fn);if(recipe)return {[SOURCE_COPY]:recipe};
  if(fn.async||fn.generator)return UNKNOWN;
  const scalar=fn.body.type==='BlockStatement'&&fn.body.body.length===1&&fn.body.body[0].type==='ReturnStatement'?fn.body.body[0].argument:fn.body;
  if(scalar?.type==='BinaryExpression'&&['==','===','!=','!=='].includes(scalar.operator)){
   const left=scalar.left.type==='UnaryExpression'?scalar.left:scalar.right.type==='UnaryExpression'?scalar.right:undefined;
   const right=scalar.left.type==='StringLiteral'?scalar.left:scalar.right.type==='StringLiteral'?scalar.right:undefined;
   if(left?.operator==='typeof'&&left.argument.type==='Identifier'&&right&&['undefined','boolean','string','number','function','object','symbol','bigint'].includes(right.value)){
    const name=left.argument.name,index=fn.params.findIndex(p=>p.type==='Identifier'&&p.name===name);
    if(index>=0)return {[SOURCE_TYPE_TEST]:{index,type:right.value,negate:['!=','!=='].includes(scalar.operator)}};
   }
  }
  if(fn.body.type!=='BlockStatement')return UNKNOWN;
  const body=fn.body.body,returned=body.at(-1);
  if(returned?.type!=='ReturnStatement'||returned.argument?.type!=='ObjectExpression')return UNKNOWN;
  let invalid=false;
  for(const statement of body.slice(0,-1)){
   if(!['VariableDeclaration','FunctionDeclaration','ExpressionStatement','IfStatement'].includes(statement.type))return UNKNOWN;
   walk(statement,(node,ancestors)=>{if(ancestors.some(isRenderFunction))return;if(['ReturnStatement','ThrowStatement','AwaitExpression','YieldExpression'].includes(node.type))invalid=true;});
  }
  if(invalid)return UNKNOWN;
  const local:ModuleInfo={...mod,file:mod.file+'#return-'+fn.start,ast:{...mod.ast,program:{...mod.ast.program,body}},env:{...mod.env},functions:new Map(mod.functions)};
  for(const parameter of fn.params)for(const name of names(parameter))local.env[name]=UNKNOWN;
  // Lexical locals must shadow module constants even before their declaration.
  for(const statement of body)if(statement.type==='VariableDeclaration')for(const declaration of statement.declarations)for(const name of names(declaration.id))local.env[name]=UNKNOWN;
  const locals=new Set([...this.index(local).declarations.keys(),...fn.params.flatMap(names)]),outer=this.index(mod);
  for(const dependency of references(fn.body))if(!locals.has(dependency)&&(outer.declarations.has(dependency)||mod.imports.has(dependency)))local.env[dependency]=await this.local(mod,dependency,seen,budget);
  const index=this.index(local),env={...local.env};
  for(const dependency of references(returned.argument))if(index.declarations.has(dependency)||local.imports.has(dependency))env[dependency]=await this.local(local,dependency,seen,budget);
  return {[SOURCE_PROJECTION]:evaluate(returned.argument,{code:mod.code,env,bindings:{},budget})};
 }
 private index(mod:ModuleInfo){
  const previous=this.indexes.get(mod);if(previous)return previous;
  const declarations=new Map<string,Declaration>(),unsafe=new Set<string>();
  for(const statement of mod.ast.program.body){
   const decl=statement.type==='ExportNamedDeclaration'?statement.declaration:statement;
   if(decl?.type==='VariableDeclaration')for(const d of decl.declarations)for(const name of names(d.id))declarations.set(name,{pattern:d.id,expression:d.init,constant:decl.kind==='const'});
  }
  walk(mod.ast,node=>{
   if(node.type==='AssignmentExpression'||node.type==='UpdateExpression'||node.type==='UnaryExpression'&&node.operator==='delete'){
    const target=node.type==='AssignmentExpression'?node.left:node.argument;
    for(const name of target.type==='ObjectPattern'||target.type==='ArrayPattern'?names(target):[rootName(target)])if(name)unsafe.add(name);
   }
   if(node.type!=='CallExpression')return;
   const callee=node.callee;
   if(callee.type==='MemberExpression'&&!callee.computed&&['push','pop','shift','unshift','splice','sort','reverse','copyWithin','fill','set','add','delete','clear'].includes(nodeName(callee.property)??'')){
    const name=rootName(callee.object);if(name)unsafe.add(name);
   }
   // Passing an object to opaque code can mutate it. Finite standard operations
   // and Vue source wrappers are interpreted separately by the evaluator.
   const member=callee.type==='MemberExpression'&&!callee.computed?nodeName(callee.property):undefined;
   const finite=member&&['map','find','slice','concat','toReversed','reverse','keys','values','entries','from','of','trim'].includes(member);
   const reference=callee.type==='Identifier'?mod.imports.get(callee.name):undefined;
   if(!finite&&reference?.request!=='vue')for(const argument of node.arguments)for(const name of references(argument,true)){
    const value=mod.env[name],primitive=value!==UNKNOWN&&(value==null||['string','number','boolean'].includes(typeof value));
    if(!primitive&&(declarations.has(name)||mod.imports.has(name)))unsafe.add(name);
   }
  });
  // Aliases of a mutated/escaped object are unsafe too, in either direction.
  for(let pass=0;pass<declarations.size;pass++){
   let changed=false;
   for(const [name,d]of declarations){const source=rootName(unwrapExpression(d.expression));if(source&&(unsafe.has(name)||unsafe.has(source))){if(!unsafe.has(name)||!unsafe.has(source))changed=true;unsafe.add(name);unsafe.add(source);}}
   if(!changed)break;
  }
  const index={declarations,unsafe};this.indexes.set(mod,index);return index;
 }
 private async binding(mod:ModuleInfo,name:string,seen:Set<string>,budget:{remaining:number}):Promise<Binding|typeof ambiguousExport|undefined>{
  const key=identity({module:mod,name});if(seen.has(key)||seen.size>64||--budget.remaining<0)return;
  const next=new Set(seen).add(key);
  const follow=async(ref:{file?:string;exported:string},exported=ref.exported)=>ref.file&&script(ref.file)?this.binding(await this.load(ref.file),exported,next,budget):undefined;
  if(name==='*')return{module:mod,name};
  const local=mod.exports.get(name);
  if(local!==undefined){const ref=mod.imports.get(local);return ref?follow(ref):{module:mod,name:local};}
  // Destructured exported constants are not component exports, but are data.
  for(const statement of mod.ast.program.body)if(statement.type==='ExportNamedDeclaration'&&statement.declaration?.type==='VariableDeclaration')for(const decl of statement.declaration.declarations)if(names(decl.id).includes(name))return{module:mod,name};
  return resolveReexports(mod,name,follow,(left,right)=>identity(left)===identity(right));
 }
 private async exported(mod:ModuleInfo,name:string,seen:Set<string>,budget:{remaining:number}):Promise<Value>{
  const binding=await this.binding(mod,name,new Set(),budget);
  return binding&&binding!==ambiguousExport?this.local(binding.module,binding.name,seen,budget):UNKNOWN;
 }
 private async namespace(mod:ModuleInfo,seen:Set<string>,budget:{remaining:number}):Promise<Value>{
  const keys=new Set<string>();let overflow=false;
  const add=(key:string)=>{if(!safeKey(key))return;if(!keys.has(key)&&keys.size>=256)overflow=true;else keys.add(key);};
  const collect=async(m:ModuleInfo,visited=new Set<string>(),includeDefault=false):Promise<void>=>{
   if(visited.has(m.file))return;
   if(visited.size>64||--budget.remaining<0){overflow=true;return;}const next=new Set(visited).add(m.file);
   for(const key of [...m.exports.keys(),...m.reexports.keys()])if(includeDefault||key!=='default')add(key);
   for(const statement of m.ast.program.body)if(statement.type==='ExportNamedDeclaration'&&statement.declaration?.type==='VariableDeclaration')for(const d of statement.declaration.declarations)for(const key of names(d.id))add(key);
   for(const ref of m.exportAll)if(ref.file&&script(ref.file))await collect(await this.load(ref.file),next);
  };
  await collect(mod,new Set(),true);const result:Record<string,Value>=Object.create(null);
  if(overflow)return UNKNOWN;
  for(const name of keys){const b=await this.binding(mod,name,new Set(),budget);if(b&&b!==ambiguousExport)result[name]=await this.local(b.module,b.name,seen,budget);}
  return budget.remaining<0?UNKNOWN:result;
 }
 private async local(mod:ModuleInfo,name:string,seen:Set<string>,budget:{remaining:number}):Promise<Value>{
  const key=identity({module:mod,name});
  if(seen.has(key)){for(const dependency of seen)this.cycles.add(dependency);return UNKNOWN;}
  if(this.cycles.has(key)||seen.size>64||--budget.remaining<0)return UNKNOWN;
  if(this.cache.has(key))return this.cache.get(key);
  const next=new Set(seen).add(key),index=this.index(mod);
  if(index.unsafe.has(name)){
   // Vue state has a source-declared initial frame, distinct from live state.
   // Retain it only as metadata for loading capacity; member reads stay unknown.
   const declaration=index.declarations.get(name),expression=unwrapExpression(declaration?.expression);
   if(declaration?.constant&&expression?.type==='ArrayExpression'&&expression.elements.length>0&&expression.elements.length<=256&&!expression.elements.some(e=>e?.type==='SpreadElement')){
    // Keep literal glyph prototypes separate from expression values. Only a
    // masked table cell may use them to reserve declared text wrapping; they
    // cannot drive branches, attributes, callbacks, URLs or live value reads.
    const glyphs=expression.elements.map(row=>row?.type==='ObjectExpression'&&row.properties.every(p=>p.type==='ObjectProperty'&&!p.computed)?Object.fromEntries(row.properties.flatMap(p=>p.type==='ObjectProperty'&&safeKey(nodeName(p.key))?[[nodeName(p.key)!,p.value.type==='StringLiteral'||p.value.type==='NumericLiteral'?p.value.value:UNKNOWN]]:[])):UNKNOWN);
    return {[SOURCE_COLLECTION]:expression.elements.length,[SOURCE_CELL_GLYPHS]:glyphs};
   }
   if(expression?.type==='CallExpression'&&expression.callee.type==='Identifier'){
    const ref=mod.imports.get(expression.callee.name);
    if(ref?.request==='vue'&&['ref','shallowRef','reactive'].includes(ref.exported)&&expression.arguments[0]?.type==='ObjectExpression'){
     const initial=evaluate(expression.arguments[0],{code:mod.code,env:mod.env,bindings:{},budget});
     if(initial&&typeof initial==='object'&&!Array.isArray(initial))return Object.assign(Object.fromEntries(Object.keys(initial).map(key=>[key,UNKNOWN])),{[SOURCE_INITIAL]:initial});
    }
   }
   return UNKNOWN;
  }
  if(name==='*')return this.namespace(mod,next,budget);
  const ref=mod.imports.get(name);
  if(ref){
   if(ref.request==='vue'){
    const helpers=['ref','shallowRef','reactive','readonly','unref','toRefs','computed'];
    if(helpers.includes(ref.exported))return{[SOURCE_VUE]:ref.exported};
    if(ref.exported==='*')return Object.fromEntries(helpers.map(name=>[name,{[SOURCE_VUE]:name}]));
   }
   if(mod.env[name]!==UNKNOWN&&Object.hasOwn(mod.env,name))return mod.env[name];
   const imported=ref.file&&script(ref.file)?await this.load(ref.file):!ref.file?await this.external?.(ref.request):undefined;
   return imported?this.exported(imported,ref.exported,next,budget):UNKNOWN;
  }
  const declaration=index.declarations.get(name);
  let expression=declaration?.expression;
  const fn=mod.functions.get(name);
  if(!expression&&isRenderFunction(fn)){const value=await this.projection(mod,fn,next,budget);return value===UNKNOWN?{[SOURCE_FUNCTION]:true}:value;}
  if(name==='default'){
   const statement=mod.ast.program.body.find(n=>n.type==='ExportDefaultDeclaration');
   if(statement?.type==='ExportDefaultDeclaration'&&statement.declaration.type!=='FunctionDeclaration'&&statement.declaration.type!=='ClassDeclaration')expression=statement.declaration;
  }
  if(declaration&&!declaration.constant)return UNKNOWN;
  if(!expression)return UNKNOWN;
  if(isRenderFunction(expression)){const value=await this.projection(mod,expression,next,budget);return value===UNKNOWN?{[SOURCE_FUNCTION]:true}:value;}
  const env={...mod.env};
  const dependencies=references(expression);
  for(const dependency of dependencies){
   const other=index.declarations.get(dependency);
   if(other&&other.expression!==expression&&(other.expression?.start??0)>=(expression.start??Infinity)){env[dependency]=UNKNOWN;continue;}
   if(index.declarations.has(dependency)||mod.imports.has(dependency))env[dependency]=await this.local(mod,dependency,next,budget);
  }
  let value=evaluate(expression,{code:mod.code,env,bindings:{},budget});
  if(value===UNKNOWN){
   const capacity=(node:t.Node,depth=0):number|undefined=>{
    if(depth>16)return;
    const known=sourceCapacity(evaluate(node,{code:mod.code,env,bindings:{},budget}));if(known!=null)return known;
    if(node.type!=='CallExpression'||node.callee.type!=='MemberExpression'||node.callee.computed)return;
    const method=nodeName(node.callee.property);
    if(['map','filter'].includes(method??''))return capacity(node.callee.object,depth+1);
    if(method==='slice'&&node.arguments.length===2){const from=evaluate(node.arguments[0],{code:mod.code,env,bindings:{},budget}),to=evaluate(node.arguments[1],{code:mod.code,env,bindings:{},budget});if(typeof from==='number'&&typeof to==='number'&&Number.isInteger(from)&&Number.isInteger(to)&&from>=0&&to>from&&to-from<=256)return Math.min(to-from,capacity(node.callee.object,depth+1)??256);}
   };
   const count=capacity(expression);if(count!=null)value={[SOURCE_COLLECTION]:count};
  }
  if(this.cycles.has(key))return UNKNOWN;
  let result=value;
  if(declaration){const bound:Record<string,Value>={};bindPattern(declaration.pattern,value,bound);result=Object.hasOwn(bound,name)?bound[name]:UNKNOWN;}
  if(result!==UNKNOWN)this.cache.set(key,result);
  return result;
 }
 async environment(mod:ModuleInfo):Promise<Record<string,Value>>{
  const previous=this.environments.get(mod),cycles=this.cycles.size;
  if(previous?.cycles===cycles)return previous.values;
  const result:Record<string,Value>={},budget={remaining:10000};
  for(const [name]of mod.imports)result[name]=await this.local(mod,name,new Set(),budget);
  for(const [name,fn]of mod.functions)if(isRenderFunction(fn))result[name]=await this.local(mod,name,new Set(),budget);
  for(const [name,decl]of this.index(mod).declarations)if(decl.constant){
   const value=await this.local(mod,name,new Set(),budget);
   if(value!==UNKNOWN||this.index(mod).unsafe.has(name))result[name]=value;
  }
  // Exhausted work can resolve further on a later pass through the value cache.
  // New cycle facts can also invalidate values already collected in this pass.
  if(budget.remaining>=0&&this.cycles.size===cycles)this.environments.set(mod,{values:result,cycles});
  return result;
 }
}
