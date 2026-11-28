import type * as t from '@babel/types';
import {nodeName,walk,isRenderFunction} from './ast.js';
import type {ModuleInfo} from './context.js';
import type {ComponentReference} from './presets/types.js';
import {evaluate,SOURCE_INITIAL,UNKNOWN,type ExpressionContext,type Value} from './expression.js';
import {resolvePreset} from './presets/index.js';
import {vueHelper,setupSyntax} from './vue-syntax.js';
import{tableViewportOffset}from'./viewport-constraint.js';
import { camelizeProp } from './props.js';
type Fn=t.FunctionExpression|t.FunctionDeclaration|t.ArrowFunctionExpression;
interface TableProjection {
 reference: ComponentReference;
 columns?: Value[];
 viewportOffset?: number;
 pagination?: { reference: ComponentReference; props: Record<string, Value> };
}

/** Find a reachable, confirmed library table forwarded by an opaque wrapper.
 * This is a partial source presentation, never execution of setup or callbacks. */
export function tableWrapper(mod:ModuleInfo,setup:Fn,enabled:readonly string[]|undefined,props:Record<string,Value>={},loading=false):TableProjection|undefined{
 const parameter=setup.params[0];if(parameter?.type!=='Identifier'||setup.body.type!=='BlockStatement')return;
 const { declarations } = setupSyntax(setup.body);
 // Index source forwarding before evaluating any instance props.
 const locals=new Set<string>();
 const bound=(node:t.Node)=>walk(node,n=>{if(n.type==='Identifier')locals.add(n.name);});setup.params.forEach(bound);
 for(const declaration of declarations)bound(declaration.id);
 const helper=(callee:t.Node,name:string)=>{const root=callee.type==='Identifier'?callee.name:callee.type==='MemberExpression'&&callee.object.type==='Identifier'?callee.object.name:undefined;return !root||!locals.has(root)?vueHelper(mod,callee,name):false;};
 const functions=new Map<string,t.FunctionExpression|t.FunctionDeclaration|t.ArrowFunctionExpression>();
 const columns=new Set<string>(),aliases=new Map<string,string>();
 for(const d of declarations){
  if(d.id.type==='Identifier'&&isRenderFunction(d.init))functions.set(d.id.name,d.init);
  if(d.id.type==='ObjectPattern'&&d.init?.type==='CallExpression'&&helper(d.init.callee,'toRefs')&&d.init.arguments[0]?.type==='Identifier'&&d.init.arguments[0].name===parameter.name){
   for(const property of d.id.properties){
    if(property.type!=='ObjectProperty'||property.value.type!=='Identifier')continue;
    const key=nodeName(property.key)??'';
    aliases.set(property.value.name,key);
    if(key==='columns')columns.add(property.value.name);
   }
  }
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
 const candidates=new Map<t.CallExpression,{reference:ComponentReference;name:string}>(),pagers=new Map<t.CallExpression,{reference:ComponentReference;guards:{test:t.Node;truthy:boolean;nullish?:boolean}[]}>(),seen=new Set<string>();
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
  candidates.set(n,{reference:ref,name:preset.name});
 });
 for(const statement of setup.body.body)if(statement.type==='ReturnStatement'&&statement.argument)inspect(statement.argument);
 if(candidates.size!==1)return;
 const [table, candidate] = [...candidates][0];
 const result: TableProjection = { reference: candidate.reference };
 // Read a reachable pagination sibling only when its source props forwarding is
 // proved. Literal base styles survive unknown runtime style overrides, with
 // the wrapper's partial-presentation diagnostic retained by the caller.
 const frame=(value:Value)=>loading&&value&&typeof value==='object'&&Object.hasOwn(value,SOURCE_INITIAL)?(value as {[SOURCE_INITIAL]:Record<string,Value>})[SOURCE_INITIAL]:value;
 const sourceProps:Record<string,Value>={},originalProps:Record<string,Value>={};for(const[key,value]of Object.entries(props)){const camel=camelizeProp(key);sourceProps[key]=sourceProps[camel]=frame(value);originalProps[key]=originalProps[camel]=value;}
 const env:Record<string,Value>={...mod.env,[parameter.name]:sourceProps},bindings:Record<string,Value>={};
 for(const [alias,key]of aliases)env[alias]=Object.hasOwn(sourceProps,key)?sourceProps[key]:undefined;
 const context:ExpressionContext={code:mod.code,env,bindings,unwrapRefs:true};
 const layout = { helper, objectAssign: !Object.hasOwn(mod.env, 'Object') };
 const value = (node: t.Node | undefined | null, scope = context): Value => evaluate(node, scope, 0, layout);
 for(const d of declarations)if(d.id.type==='Identifier')env[d.id.name]=value(d.init);
 if(candidate.name==='eltable')result.viewportOffset=tableViewportOffset(mod,setup,table,value);
 if(Array.isArray(sourceProps.columns)&&columnCalls.size===1){
  const[fn,call]=[...columnCalls][0],input=fn.params[0],argument=call.arguments[1];
  const objects=argument?.type==='ObjectExpression'?[argument]:argument?.type==='CallExpression'&&helper(argument.callee,'mergeProps')?argument.arguments.filter((node):node is t.ObjectExpression=>node.type==='ObjectExpression'):[];
  if(input?.type==='Identifier')result.columns=sourceProps.columns.map((column,index)=>{
   if(!column||typeof column!=='object')return column;
   const copy:Record<string,Value>={...column};
   const local:ExpressionContext={...context,env:{...env,[input.name]:column},bindings:{...bindings},nodeValues:new Map(context.nodeValues)};
   if(fn.params[1]?.type==='Identifier')local.env[fn.params[1].name]=index;
   for(const object of objects)for(const property of object.properties)if(property.type==='ObjectProperty'&&!property.computed&&['align','headerAlign','showOverflowTooltip'].includes(nodeName(property.key)??'')){
    const computed=value(property.value,local);if(typeof computed==='string'||typeof computed==='boolean')copy[nodeName(property.key)!]=computed;
   }
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
