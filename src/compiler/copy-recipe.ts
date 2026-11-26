import type * as t from '@babel/types';
import {isRenderFunction,nodeName,walk} from './ast.js';
import type {ModuleInfo} from './context.js';

export interface CopyRecipe {input:number;deep:boolean|{argument:number}}
type Fn=t.FunctionDeclaration|t.FunctionExpression|t.ArrowFunctionExpression;
const id=(node:t.Node|undefined|null,name:string)=>node?.type==='Identifier'&&node.name===name;
const member=(node:t.Node|undefined|null,root:string,key:string)=>node?.type==='MemberExpression'&&!node.computed&&id(node.object,root)&&nodeName(node.property)===key;
const statements=(node:t.Node)=>node.type==='BlockStatement'?node.body:node.type==='ExpressionStatement'?[node]:[];
function returned(fn:Fn):t.Node|undefined{
 if(fn.body.type!=='BlockStatement')return fn.body;
 const body=fn.body.body;return body.length===1&&body[0].type==='ReturnStatement'?body[0].argument??undefined:undefined;
}

/** Recognize a bounded structural-copy algorithm from source, not an export or
 * package name. Only its plain-object/array paths are proved. Other runtime
 * types, getters and unknown nested values are outside the recipe's domain. */
const analyzers=new WeakMap<ModuleInfo,(node:t.Node)=>CopyRecipe|undefined>();
export function sourceCopyRecipe(mod:ModuleInfo,fn:t.Node):CopyRecipe|undefined{
 let analyzer=analyzers.get(mod);if(!analyzer)analyzers.set(mod,analyzer=createAnalyzer(mod));
 return analyzer(fn);
}
function createAnalyzer(mod:ModuleInfo):(node:t.Node)=>CopyRecipe|undefined{
 const defs=new Map<string,t.Node>(),written=new Set<string>();
 for(const statement of mod.ast.program.body){
  const s=statement.type==='ExportNamedDeclaration'?statement.declaration:statement;
  if(s?.type==='FunctionDeclaration'&&s.id)defs.set(s.id.name,s);
  if(s?.type==='VariableDeclaration')for(const d of s.declarations)if(d.id.type==='Identifier'&&d.init)defs.set(d.id.name,d.init);
 }
 const builtin=(node:t.Node|undefined):boolean=>{
  let value=node;while(value?.type==='MemberExpression'||value?.type==='OptionalMemberExpression')value=value.object;
  const seen=new Set<string>();while(value?.type==='Identifier'&&!seen.has(value.name)){if(['Object','Array','Function','Reflect'].includes(value.name))return true;seen.add(value.name);const next=defs.get(value.name);if(next?.type!=='Identifier')break;value=next;}return false;
 };
 let intrinsicWrite=false;
 walk(mod.ast,node=>{
  let target:t.Node|undefined;
  if(node.type==='AssignmentExpression')target=node.left;
  if(node.type==='UpdateExpression')target=node.argument;
  // Rebinding a recipe/helper invalidates source identity. Property writes are
  // checked inside each selected algorithm path below.
  if(target?.type==='Identifier')written.add(target.name);
  if(target&&(target.type==='MemberExpression'||target.type==='OptionalMemberExpression')&&builtin(target))intrinsicWrite=true;
  if(node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&['assign','defineProperty','defineProperties','setPrototypeOf','set'].includes(nodeName(node.callee.property)??'')&&builtin(node.arguments[0]))intrinsicWrite=true;
 });
 if(intrinsicWrite)return()=>undefined;
 const resolve=(name:string,seen=new Set<string>()):t.Node|undefined=>{
  if(written.has(name)||seen.has(name)||seen.size>32)return;
  const value=defs.get(name);return value?.type==='Identifier'?resolve(value.name,new Set(seen).add(name)):value;
 };
 const functionOf=(node:t.Node|undefined):Fn|undefined=>{const value=node?.type==='Identifier'?resolve(node.name):node;return isRenderFunction(value)&&!value.async&&!value.generator&&value.params.every(p=>p.type==='Identifier')?value:undefined;};
 const params=(value:Fn)=>value.params.map(p=>nodeName(p)!);
 const ownCheck=(callee:t.Node,input:string,key:string):boolean=>{
  if(callee.type!=='CallExpression')return false;
  if(member(callee.callee,'Object','hasOwn')&&!defs.has('Object'))return id(callee.arguments[0],input)&&id(callee.arguments[1],key)&&callee.arguments.length===2;
  const helper=functionOf(callee.callee);if(!helper)return false;
  const [object,property]=params(helper),body=returned(helper);
  if(!object||!property||!id(callee.arguments[0],input)||!id(callee.arguments[1],key))return false;
  // The source value domain rejects own hasOwnProperty overrides.
  return body?.type==='ConditionalExpression'&&body.test.type==='LogicalExpression'&&body.test.operator==='&&'&&id(body.test.left,object)&&member(body.test.right,object,'hasOwnProperty')&&body.consequent.type==='CallExpression'&&member(body.consequent.callee,object,'hasOwnProperty')&&id(body.consequent.arguments[0],property)&&(body.alternate.type==='BooleanLiteral'&&body.alternate.value===false||body.alternate.type==='UnaryExpression'&&body.alternate.operator==='!'&&body.alternate.argument.type==='NumericLiteral'&&body.alternate.argument.value===1);
 };
 const callbackCall=(node:t.Node,input:string,callback:string,context:string|undefined,key:string):boolean=>{
  if(node.type==='ExpressionStatement')return callbackCall(node.expression,input,callback,context,key);
  if(node.type!=='CallExpression')return false;
  const viaCall=member(node.callee,callback,'call'),args=viaCall?node.arguments.slice(1):node.arguments;
  if(!viaCall&&!id(node.callee,callback)||viaCall&&(!context||!id(node.arguments[0],context)))return false;
  return args.length===3&&args[0].type==='MemberExpression'&&args[0].computed&&id(args[0].object,input)&&id(args[0].property,key)&&id(args[1],key)&&id(args[2],input);
 };
 const iterator=(node:t.Node,kind:'object'|'array'):boolean=>{
  const helper=functionOf(node);if(!helper||helper.body.type!=='BlockStatement')return false;
  const[input,callback,context]=params(helper);if(!input||!callback)return false;
  let body:t.Node=helper.body;
  if(body.type==='BlockStatement'&&body.body.length===1)body=body.body[0];
  if(body.type==='IfStatement'&&id(body.test,input)&&!body.alternate)body=body.consequent;
  if(kind==='object'){
   if(body.type!=='ForInStatement'||!id(body.right,input)||body.left.type!=='VariableDeclaration'||body.left.declarations.length!==1)return false;
   const key=nodeName(body.left.declarations[0].id);if(!key)return false;
   const list=statements(body.body);let expression:t.Node|undefined=list.length===1&&list[0].type==='ExpressionStatement'?list[0].expression:undefined;
   if(!expression&&body.body.type==='ExpressionStatement')expression=body.body.expression;
   return expression?.type==='LogicalExpression'&&expression.operator==='&&'&&ownCheck(expression.left,input,key)&&callbackCall(expression.right,input,callback,context,key);
  }
  const each=(candidate:t.Node)=>candidate.type==='ExpressionStatement'&&candidate.expression.type==='CallExpression'&&member(candidate.expression.callee,input,'forEach')&&candidate.expression.arguments.length>=1&&candidate.expression.arguments.length<=2&&id(candidate.expression.arguments[0],callback)&&(candidate.expression.arguments.length===1||!!context&&id(candidate.expression.arguments[1],context));
  if(each(body))return true;
  if(body.type!=='IfStatement'||!member(body.test,input,'forEach')||!each(body.consequent)||body.alternate?.type!=='ForStatement')return false;
  const loop=body.alternate,init=loop.init;
  if(init?.type!=='VariableDeclaration'||init.declarations.length!==2)return false;
  const[index,length]=init.declarations,key=nodeName(index.id),size=nodeName(length.id);
  return !!key&&!!size&&index.init?.type==='NumericLiteral'&&index.init.value===0&&member(length.init,input,'length')&&loop.test?.type==='BinaryExpression'&&loop.test.operator==='<'&&id(loop.test.left,key)&&id(loop.test.right,size)&&loop.update?.type==='UpdateExpression'&&loop.update.operator==='++'&&id(loop.update.argument,key)&&callbackCall(loop.body,input,callback,context,key);
 };
 const tag=(node:t.Node,input:string):boolean=>{
  if(node.type!=='CallExpression'||node.arguments.length!==1||!id(node.arguments[0],input)||node.callee.type!=='MemberExpression'||nodeName(node.callee.property)!=='call')return false;
  const base=node.callee.object.type==='Identifier'?resolve(node.callee.object.name):node.callee.object;
  return base?.type==='MemberExpression'&&!base.computed&&nodeName(base.property)==='toString'&&base.object.type==='MemberExpression'&&member(base.object,'Object','prototype')&&!defs.has('Object');
 };
 const rootProof=(candidate:Fn):boolean=>{
  const[input,deep]=params(candidate);if(!input||!deep||candidate.body.type!=='BlockStatement'||candidate.body.body.length!==2)return false;
  const[guard,end]=candidate.body.body;
  if(guard.type!=='IfStatement'||!id(guard.test,input)||guard.alternate||guard.consequent.type!=='SwitchStatement'||!tag(guard.consequent.discriminant,input)||end.type!=='ReturnStatement'||!id(end.argument,input))return false;
  const cases=guard.consequent.cases,allowed=new Set(['[object Object]','[object Array]','[object Arguments]','[object Date]','[object RegExp]','[object Set]','[object Map]']);
  if(cases.some(c=>c.test?.type!=='StringLiteral'||!allowed.has(c.test.value)))return false;
  const childCopy=(node:t.Node,value:string):boolean=>{
   if(node.type!=='CallExpression'||node.arguments.length!==2||!id(node.arguments[0],value)||!id(node.arguments[1],deep))return false;
   const helper=functionOf(node.callee);if(!helper)return false;
   const[child,flag]=params(helper),expression=returned(helper);
   return !!child&&!!flag&&expression?.type==='ConditionalExpression'&&id(expression.test,flag)&&id(expression.alternate,child)&&expression.consequent.type==='CallExpression'&&functionOf(expression.consequent.callee)===candidate&&expression.consequent.arguments.length===2&&id(expression.consequent.arguments[0],child)&&id(expression.consequent.arguments[1],flag);
  };
  const path=(kind:'object'|'array')=>{
   const index=cases.findIndex(c=>c.test?.type==='StringLiteral'&&c.test.value===(kind==='object'?'[object Object]':'[object Array]'));
   if(index<0)return false;let selected=cases[index];
   // Consecutive case labels may share one block.
   for(let i=index;!selected.consequent.length&&i+1<cases.length;)selected=cases[++i];
   if(selected.consequent.length!==1||selected.consequent[0].type!=='BlockStatement')return false;
   const body=selected.consequent[0].body;if(body[0]?.type!=='VariableDeclaration'||body[0].declarations.length!==1)return false;
   const expressions=body.length===2&&body[1].type==='ReturnStatement'&&body[1].argument?.type==='SequenceExpression'?body[1].argument.expressions:body.length===3&&body[1].type==='ExpressionStatement'&&body[2].type==='ReturnStatement'&&body[2].argument?[body[1].expression,body[2].argument]:[];
   const declaration=body[0].declarations[0],output=nodeName(declaration.id),initial=declaration.init;
   if(!output||expressions.length!==2||!id(expressions[1],output))return false;
   if(kind==='array'){if(initial?.type!=='ArrayExpression'||initial.elements.length)return false;}
   else if(!(initial?.type==='ObjectExpression'&&!initial.properties.length)&&(initial?.type!=='CallExpression'||!member(initial.callee,'Object','create')||defs.has('Object')||initial.arguments.length!==1||!member(initial.arguments[0],input,'__proto__')))return false;
   const call=expressions[0];if(call.type!=='CallExpression'||call.arguments.length!==2||!id(call.arguments[0],input)||!iterator(call.callee,kind))return false;
   const callback=functionOf(call.arguments[1]);if(!callback)return false;
   const[value,key]=params(callback);if(!value)return false;
   const list=callback.body.type==='BlockStatement'?callback.body.body:[],statement=list.length===1&&list[0].type==='ExpressionStatement'?list[0].expression:callback.body.type!=='BlockStatement'?callback.body:undefined;
   if(kind==='array')return statement?.type==='CallExpression'&&member(statement.callee,output,'push')&&statement.arguments.length===1&&childCopy(statement.arguments[0],value);
   return !!key&&statement?.type==='AssignmentExpression'&&statement.operator==='='&&statement.left.type==='MemberExpression'&&statement.left.computed&&id(statement.left.object,output)&&id(statement.left.property,key)&&childCopy(statement.right,value);
  };
  return path('object')&&path('array');
 };
 const summarize=(candidate:t.Node,seen=new Set<t.Node>()):CopyRecipe|undefined=>{
  const helper=functionOf(candidate);if(!helper||seen.has(helper)||seen.size>12)return;
  if(rootProof(helper))return{input:0,deep:{argument:1}};
  let expression=returned(helper);const p=params(helper);
  if(expression?.type==='LogicalExpression'&&expression.operator==='&&'&&id(expression.left,p[0]))expression=expression.right;
  if(expression?.type!=='CallExpression'||expression.callee.type!=='Identifier')return;
  const nested=resolve(expression.callee.name);if(!nested)return;
  const recipe=summarize(nested,new Set(seen).add(helper));if(!recipe)return;
  const argument=expression.arguments[recipe.input],input=p.findIndex(name=>id(argument,name));if(input<0)return;
  if(typeof recipe.deep==='boolean')return{input,deep:recipe.deep};
  const value=expression.arguments[recipe.deep.argument];
  if(value?.type==='BooleanLiteral')return{input,deep:value.value};
  if(value?.type==='UnaryExpression'&&value.operator==='!'&&value.argument.type==='NumericLiteral')return{input,deep:!value.argument.value};
  if(value===undefined)return{input,deep:false};
  const deep=p.findIndex(name=>id(value,name));return deep<0?undefined:{input,deep:{argument:deep}};
 };
 return summarize;
}
