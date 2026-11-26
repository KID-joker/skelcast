import type * as t from '@babel/types';
import {nodeName,walk,isRenderFunction} from './ast.js';
import type {ModuleInfo} from './context.js';
import type {ComponentReference} from './presets/types.js';
import {evaluate,SOURCE_INITIAL,UNKNOWN,type Value} from './expression.js';
import {resolvePreset} from './presets/index.js';
import {vueHelper} from './vue-render.js';
import{tableViewportOffset}from'./viewport-constraint.js';
type Fn=t.FunctionExpression|t.FunctionDeclaration|t.ArrowFunctionExpression;

/** Find a reachable, confirmed library table forwarded by an opaque wrapper.
 * This is a partial source presentation, never execution of setup or callbacks. */
export function tableWrapper(mod:ModuleInfo,setup:t.FunctionExpression|t.FunctionDeclaration|t.ArrowFunctionExpression,enabled:readonly string[]|undefined,props:Record<string,Value>={},loading=false):{reference:ComponentReference;columns?:Value[];viewportOffset?:number;pagination?:{reference:ComponentReference;props:Record<string,Value>}}|undefined{
 const parameter=setup.params[0];if(parameter?.type!=='Identifier'||setup.body.type!=='BlockStatement')return;
 const locals=new Set<string>();
 const bound=(node:t.Node)=>walk(node,n=>{if(n.type==='Identifier')locals.add(n.name);});setup.params.forEach(bound);
 for(const s of setup.body.body)if(s.type==='VariableDeclaration')for(const d of s.declarations)bound(d.id);
 const helper=(callee:t.Node,name:string)=>{const root=callee.type==='Identifier'?callee.name:callee.type==='MemberExpression'&&callee.object.type==='Identifier'?callee.object.name:undefined;return !root||!locals.has(root)?vueHelper(mod,callee,name):false;};
 const functions=new Map<string,t.FunctionExpression|t.FunctionDeclaration|t.ArrowFunctionExpression>();
 const columns=new Set<string>(),aliases=new Map<string,string>();
 for(const statement of setup.body.body)if(statement.type==='VariableDeclaration')for(const d of statement.declarations){
  if(d.id.type==='Identifier'&&isRenderFunction(d.init))functions.set(d.id.name,d.init);
  if(d.id.type==='ObjectPattern'&&d.init?.type==='CallExpression'&&helper(d.init.callee,'toRefs')&&d.init.arguments[0]?.type==='Identifier'&&d.init.arguments[0].name===parameter.name)for(const p of d.id.properties)if(p.type==='ObjectProperty'&&nodeName(p.key)==='columns'&&p.value.type==='Identifier')columns.add(p.value.name);
  if(d.id.type==='ObjectPattern'&&d.init?.type==='CallExpression'&&helper(d.init.callee,'toRefs')&&d.init.arguments[0]?.type==='Identifier'&&d.init.arguments[0].name===parameter.name)for(const p of d.id.properties)if(p.type==='ObjectProperty'&&p.value.type==='Identifier')aliases.set(p.value.name,nodeName(p.key)??'');
 }
 const forwarded=(node:t.Node|undefined):boolean=>{
  if(node?.type==='Identifier')return node.name===parameter.name;
  if(node?.type==='CallExpression'&&helper(node.callee,'mergeProps'))return node.arguments.some(a=>forwarded(a))&&!node.arguments.some(a=>a.type==='ObjectExpression'&&a.properties.some(p=>p.type==='ObjectProperty'&&['data','dataSource','columns'].includes(nodeName(p.key)??'')));
  return node?.type==='ObjectExpression'&&node.properties.some(p=>p.type==='SpreadElement'&&forwarded(p.argument))&&!node.properties.some(p=>p.type==='ObjectProperty'&&['data','dataSource','columns'].includes(nodeName(p.key)??''));
 };
 const vnode=(node:t.CallExpression)=>['h','createVNode'].some(name=>helper(node.callee,name));
 const columnCalls=new Map<Fn,t.CallExpression>();
 const columnRef=(node:t.Node)=>{let found=false;walk(node,n=>{if(n.type==='CallExpression'&&vnode(n)&&n.arguments[0]?.type==='Identifier'){const p=resolvePreset(enabled,mod.imports.get(n.arguments[0].name));if(p?.name==='eltablecolumn'){found=true;if(isRenderFunction(node))columnCalls.set(node,n);}}});return found;};
 const hasColumns=(node:t.Node|undefined)=>{
  if(!node)return false;let found=false;
  walk(node,n=>{if(n.type!=='CallExpression'||n.callee.type!=='MemberExpression'||nodeName(n.callee.property)!=='map')return;
   let input:t.Node=n.callee.object;
   if(input.type==='CallExpression'&&helper(input.callee,'unref')&&input.arguments[0])input=input.arguments[0];
   const source=input.type==='Identifier'&&columns.has(input.name)||input.type==='MemberExpression'&&input.object.type==='Identifier'&&input.object.name===parameter.name&&nodeName(input.property)==='columns';
   const callback=n.arguments[0],fn=callback?.type==='Identifier'?functions.get(callback.name):callback;
   if(source&&fn&&columnRef(fn))found=true;
  });return found;
 };
 const candidates=new Map<t.Node,ComponentReference>(),pagers=new Map<t.CallExpression,{reference:ComponentReference;guards:{test:t.Node;truthy:boolean;nullish?:boolean}[]}>(),seen=new Set<string>();
 const inspect=(node:t.Node)=>walk(node,(n,ancestors)=>{
  if(n.type!=='CallExpression')return;
  if(n.callee.type==='Identifier'&&functions.has(n.callee.name)&&!seen.has(n.callee.name)){seen.add(n.callee.name);inspect(functions.get(n.callee.name)!.body);}
  if(!vnode(n)||n.arguments[0]?.type!=='Identifier')return;
  const ref=mod.imports.get(n.arguments[0].name),preset=resolvePreset(enabled,ref);
  if(ref&&preset?.name==='elpagination'){
   const guards:{test:t.Node;truthy:boolean;nullish?:boolean}[]=[];
   ancestors.forEach((a,i)=>{const child=ancestors[i+1]??n;if(a.type==='ConditionalExpression')guards.push({test:a.test,truthy:child===a.consequent});if(a.type==='LogicalExpression'&&child===a.right)guards.push({test:a.left,truthy:a.operator==='&&',nullish:a.operator==='??'});});
   pagers.set(n,{reference:ref,guards});
  }
  if(!forwarded(n.arguments[1]))return;
  if(!ref||!preset||!['eltable','ndatatable','table','atable'].includes(preset.name))return;
  if(preset.name==='eltable'&&!hasColumns(n.arguments[2]))return;
  candidates.set(n,ref);
 });
 for(const statement of setup.body.body)if(statement.type==='ReturnStatement'&&statement.argument)inspect(statement.argument);
 if(candidates.size!==1)return;
 const result:{reference:ComponentReference;columns?:Value[];viewportOffset?:number;pagination?:{reference:ComponentReference;props:Record<string,Value>}}={reference:[...candidates.values()][0]};
 // Read a reachable pagination sibling only when its source props forwarding is
 // proved. Literal base styles survive unknown runtime style overrides, with
 // the wrapper's partial-presentation diagnostic retained by the caller.
 const frame=(value:Value)=>loading&&value&&typeof value==='object'&&Object.hasOwn(value,SOURCE_INITIAL)?(value as {[SOURCE_INITIAL]:Record<string,Value>})[SOURCE_INITIAL]:value;
 const sourceProps:Record<string,Value>={},originalProps:Record<string,Value>={};for(const[key,value]of Object.entries(props)){const camel=key.replace(/-([a-z])/g,(_,letter:string)=>letter.toUpperCase());sourceProps[key]=sourceProps[camel]=frame(value);originalProps[key]=originalProps[camel]=value;}
 const env:Record<string,Value>={...mod.env,[parameter.name]:sourceProps},bindings:Record<string,Value>={};
 for(const [alias,key]of aliases)env[alias]=Object.hasOwn(sourceProps,key)?sourceProps[key]:undefined;
 const value=(node:t.Node|undefined|null):Value=>{
  if(!node)return UNKNOWN;
  if(node.type==='CallExpression'&&helper(node.callee,'unref'))return value(node.arguments[0]);
  if(node.type==='CallExpression'&&helper(node.callee,'computed')&&isRenderFunction(node.arguments[0])&&node.arguments[0].body.type!=='BlockStatement')return value(node.arguments[0].body);
  if(node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&node.callee.object.type==='Identifier'&&node.callee.object.name==='Object'&&!Object.hasOwn(mod.env,'Object')&&nodeName(node.callee.property)==='assign'&&node.arguments[0]?.type==='ObjectExpression'){
   const first=value(node.arguments[0]);if(!first||typeof first!=='object')return UNKNOWN;
   const result={...first};for(const arg of node.arguments.slice(1)){const next=value(arg);if(next&&typeof next==='object')Object.assign(result,next);}return result;
  }
  walk(node,n=>{if(n!==node&&n.type==='CallExpression'&&helper(n.callee,'unref')&&n.start!=null&&n.end!=null)bindings[mod.code.slice(n.start,n.end)]=value(n.arguments[0]);});
  return evaluate(node,{code:mod.code,env,bindings,unwrapRefs:true});
 };
 for(const statement of setup.body.body)if(statement.type==='VariableDeclaration')for(const d of statement.declarations)if(d.id.type==='Identifier')env[d.id.name]=value(d.init);
 const table=[...candidates.keys()][0];
 if(table.type==='CallExpression'&&resolvePreset(enabled,result.reference)?.name==='eltable')result.viewportOffset=tableViewportOffset(mod,setup,table,value);
 if(Array.isArray(sourceProps.columns)&&columnCalls.size===1){
  const[fn,call]=[...columnCalls][0],input=fn.params[0],argument=call.arguments[1];
  const objects=argument?.type==='ObjectExpression'?[argument]:argument?.type==='CallExpression'&&helper(argument.callee,'mergeProps')?argument.arguments.filter((node):node is t.ObjectExpression=>node.type==='ObjectExpression'):[];
  if(input?.type==='Identifier')result.columns=sourceProps.columns.map((column,index)=>{
   if(!column||typeof column!=='object')return column;
   const copy:Record<string,Value>={...column},previous={...env},previousBindings={...bindings};env[input.name]=column;
   if(fn.params[1]?.type==='Identifier')env[fn.params[1].name]=index;
   for(const object of objects)for(const property of object.properties)if(property.type==='ObjectProperty'&&!property.computed&&['align','headerAlign','showOverflowTooltip'].includes(nodeName(property.key)??'')){
    const computed=value(property.value);if(typeof computed==='string'||typeof computed==='boolean')copy[nodeName(property.key)!]=computed;
   }
   for(const key of Object.keys(env))delete env[key];Object.assign(env,previous);for(const key of Object.keys(bindings))delete bindings[key];Object.assign(bindings,previousBindings);
   return copy;
  });
 }
 for(const [node,{reference,guards}]of pagers){
  if(guards.some(guard=>{const result=value(guard.test);return result===UNKNOWN||(guard.nullish?result!=null:!!result!==guard.truthy);} ))continue;
  const argument=node.arguments[1];if(argument?.type!=='CallExpression'||!helper(argument.callee,'mergeProps'))continue;
  let forwarded:Value=UNKNOWN,original:Value=UNKNOWN;
  const own:Record<string,Value>={};
  for(const item of argument.arguments){
   let source:t.Node=item;if(source.type==='CallExpression'&&helper(source.callee,'unref')&&source.arguments[0])source=source.arguments[0];
   const key=source.type==='Identifier'?aliases.get(source.name):source.type==='MemberExpression'&&source.object.type==='Identifier'&&source.object.name===parameter.name?nodeName(source.property):undefined;
   if(key){forwarded=Object.hasOwn(sourceProps,key)?sourceProps[key]:UNKNOWN;original=Object.hasOwn(originalProps,key)?originalProps[key]:UNKNOWN;}
   if(item.type==='ObjectExpression')for(const property of item.properties)if(property.type==='ObjectProperty'&&!property.computed&&['class','style','layout','pageSizes','size','small','background','pagerCount','hideOnSinglePage'].includes(nodeName(property.key)??''))own[nodeName(property.key)!]=value(property.value);
  }
  if(forwarded&&typeof forwarded==='object'&&typeof (forwarded as Record<string,Value>).pageSize==='number'&&typeof (forwarded as Record<string,Value>).currentPage==='number'){
   const props={...(original&&typeof original==='object'?original:forwarded),...own};
   if(original&&typeof original==='object'&&Object.hasOwn(original,SOURCE_INITIAL))Object.assign(props,{[SOURCE_INITIAL]:(original as{[SOURCE_INITIAL]:Value})[SOURCE_INITIAL]});
   result.pagination={reference,props};
  }
 }
 return result;
}
