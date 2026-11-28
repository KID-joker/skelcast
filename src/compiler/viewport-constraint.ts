import type * as t from '@babel/types';
import{VISITOR_KEYS}from'@babel/types';
import{isRenderFunction,nodeName,unwrapExpression,walk}from'./ast.js';
import type{ModuleInfo}from'./context.js';
import{vueHelper}from'./vue-syntax.js';
import{type Value}from'./expression.js';

type Fn=t.FunctionDeclaration|t.FunctionExpression|t.ArrowFunctionExpression;
const property=(node:t.Node|undefined|null,key:string)=>!!node&&(node.type==='MemberExpression'||node.type==='OptionalMemberExpression')&&!node.computed&&nodeName(node.property)===key;
const identifier=(node:t.Node|undefined|null,name:string)=>node?.type==='Identifier'&&node.name===name;
function canonical(node:unknown):string{
 const clean=(value:unknown):unknown=>{
  if(Array.isArray(value))return value.map(clean);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!['start','end','loc','extra','leadingComments','trailingComments','innerComments'].includes(key)).map(([key,value])=>[key,clean(value)]));
 };return JSON.stringify(clean(node));
}
function result(fn:Fn):t.Node|undefined{
 if(fn.body.type!=='BlockStatement')return fn.body;
 if(fn.body.body.some(s=>s.type!=='VariableDeclaration'&&s.type!=='ReturnStatement'))return;
 const last=fn.body.body.at(-1);return last?.type==='ReturnStatement'?last.argument??undefined:undefined;
}

/** Prove a table's own viewport-bottom constraint from its ref, source writes
 * and lifecycle activation. No DOM, lifecycle or business function is executed. */
export function tableViewportOffset(mod:ModuleInfo,setup:Fn,table:t.CallExpression,evaluate:(node:t.Node)=>Value):number|undefined{
 if(setup.body.type!=='BlockStatement'||Object.hasOwn(mod.env,'window'))return;
 const definitions=new Map<string,t.Node|null>(),functions=new Map<string,Fn>();
 for(const statement of setup.body.body){
  if(statement.type==='VariableDeclaration')for(const d of statement.declarations)if(d.id.type==='Identifier'){definitions.set(d.id.name,d.init??null);if(isRenderFunction(d.init))functions.set(d.id.name,d.init);}
  if(statement.type==='FunctionDeclaration'&&statement.id){definitions.set(statement.id.name,statement);functions.set(statement.id.name,statement);}
 }
 if(definitions.has('window'))return;
 const helper=(node:t.Node,name:string)=>{
  const root=node.type==='Identifier'?node.name:node.type==='MemberExpression'&&node.object.type==='Identifier'?node.object.name:undefined;
  return (!root||!definitions.has(root))&&vueHelper(mod,node,name);
 };
 const local=(fn:Fn)=>{
  const defs=new Map(definitions),declared=new Set<string>(),assigned=new Map<string,t.Node[]>();
  if(fn.body.type==='BlockStatement')for(const s of fn.body.body)if(s.type==='VariableDeclaration')for(const d of s.declarations)if(d.id.type==='Identifier'){declared.add(d.id.name);defs.set(d.id.name,d.init??null);}
  walk(fn.body,(node,ancestors)=>{if(ancestors.some(isRenderFunction))return;if(node.type==='AssignmentExpression'&&node.operator==='='&&node.left.type==='Identifier'&&declared.has(node.left.name)){const list=assigned.get(node.left.name)??[];list.push(node.right);assigned.set(node.left.name,list);}});
  for(const[name,list]of assigned)defs.set(name,list.length===1?list[0]:null);
  return defs;
 };
 const resolve=(node:t.Node,defs:Map<string,t.Node|null>,seen=new Set<string>()):t.Node=>{
  const value=unwrapExpression(node)??node;
  if(value.type!=='Identifier'||seen.has(value.name)||seen.size>24)return value;
  const next=defs.get(value.name);return next?resolve(next,defs,new Set(seen).add(value.name)):value;
 };
 const nullish=(node:t.Node)=>node.type==='NullLiteral'||identifier(node,'undefined')||node.type==='UnaryExpression'&&node.operator==='void'&&node.argument.type==='NumericLiteral';
 const optionalGuard=(node:t.Node):boolean=>{
  if(node.type==='BinaryExpression')return['==','===','!=','!=='].includes(node.operator)&&(nullish(node.left)||nullish(node.right));
  return false;
 };
 const instance=(node:t.Node,defs:Map<string,t.Node|null>)=>{const value=resolve(node,defs);return value.type==='CallExpression'&&helper(value.callee,'getCurrentInstance')&&!value.arguments.length;};
 const proxy=(node:t.Node,defs:Map<string,t.Node|null>,depth=0):boolean=>{
  if(depth>24)return false;const value=resolve(node,defs);
  if(property(value,'proxy')&&(value.type==='MemberExpression'||value.type==='OptionalMemberExpression'))return instance(value.object,defs);
  if(value.type==='ConditionalExpression'&&optionalGuard(value.test))return nullish(value.consequent)?proxy(value.alternate,defs,depth+1):nullish(value.alternate)&&proxy(value.consequent,defs,depth+1);
  return false;
 };
 const props=table.arguments[1];let ref:t.Node|undefined;
 const last=props?.type==='CallExpression'&&helper(props.callee,'mergeProps')?props.arguments.at(-1):props;
 if(last?.type==='ObjectExpression')for(const p of last.properties){if(p.type==='SpreadElement')ref=undefined;else if(p.type==='ObjectProperty'&&!p.computed&&nodeName(p.key)==='ref')ref=p.value;}
 if(!ref)return;
 const getter=new Set<string>();
 for(const[name,fn]of functions){
  const returned=result(fn);if(!returned)continue;const defs=local(fn);
  const linked=(node:t.Node,depth=0):boolean=>{
   if(depth>24)return false;const value=resolve(node,defs);
   if(value.type==='ConditionalExpression'&&optionalGuard(value.test))return nullish(value.consequent)?linked(value.alternate,depth+1):nullish(value.alternate)&&linked(value.consequent,depth+1);
   return (value.type==='MemberExpression'||value.type==='OptionalMemberExpression')&&value.computed&&canonical(value.property)===canonical(ref)&&property(value.object,'$refs')&&(value.object.type==='MemberExpression'||value.object.type==='OptionalMemberExpression')&&proxy(value.object.object,defs);
  };
  if(linked(returned))getter.add(name);
 }
 const ownRefs=(node:t.Node,defs:Map<string,t.Node|null>,depth=0):boolean=>{
  if(depth>16)return false;const value=resolve(node,defs);
  if(!property(value,'$refs')||value.type!=='MemberExpression'&&value.type!=='OptionalMemberExpression')return false;
  const object=resolve(value.object,defs);
  return object.type==='CallExpression'&&object.callee.type==='Identifier'&&getter.has(object.callee.name)&&!object.arguments.length&&defs.get(object.callee.name)===functions.get(object.callee.name);
 };
 const ownRoot=(node:t.Node,defs:Map<string,t.Node|null>):boolean=>{
  const value=resolve(node,defs);
  if(!property(value,'tableWrapper')||value.type!=='MemberExpression'&&value.type!=='OptionalMemberExpression')return false;
  const object=resolve(value.object,defs);
  if(object.type!=='CallExpression'||object.callee.type!=='Identifier'||object.arguments.length)return false;
  const fn=functions.get(object.callee.name),returned=fn&&result(fn);
  return !!fn&&defs.get(object.callee.name)===fn&&!!returned&&ownRefs(returned,local(fn));
 };
 const candidates=new Map<string,number>();
 for(const[name,fn]of functions){
  if(fn.params.length||fn.body.type!=='BlockStatement')continue;
  const defs=local(fn);if(defs.has('window'))continue;
  let writes=0;const values=new Set<number>();
  walk(fn.body,(node,ancestors)=>{
   if(ancestors.some(isRenderFunction)||node.type!=='AssignmentExpression'||node.operator!=='='||!property(node.left,'height')||node.left.type!=='MemberExpression'||!property(node.left.object,'style')||node.left.object.type!=='MemberExpression')return;
   const target=node.left.object.object;if(!ownRoot(target,defs))return;
   writes++;
   if(ancestors.some(a=>['IfStatement','ConditionalExpression','LogicalExpression','ForStatement','ForInStatement','ForOfStatement','WhileStatement','SwitchCase'].includes(a.type)))return;
   const rhs=node.right;if(rhs.type!=='BinaryExpression'||rhs.operator!=='+'||rhs.right.type!=='StringLiteral'||rhs.right.value!=='px')return;
   const subtraction=rhs.left;if(subtraction.type!=='BinaryExpression'||subtraction.operator!=='-')return;
   const viewport=subtraction.left;if(viewport.type!=='BinaryExpression'||viewport.operator!=='-'||!property(viewport.left,'innerHeight')||viewport.left.type!=='MemberExpression'||!identifier(viewport.left.object,'window'))return;
   const top=resolve(viewport.right,defs);
   if(!property(top,'top')||top.type!=='MemberExpression')return;
   const rect=resolve(top.object,defs);if(rect.type!=='CallExpression'||!property(rect.callee,'getBoundingClientRect')||rect.callee.type!=='MemberExpression'||rect.arguments.length||!ownRoot(rect.callee.object,defs)||canonical(resolve(rect.callee.object,defs))!==canonical(resolve(target,defs)))return;
   const offset=resolve(subtraction.right,defs),value=evaluate(offset);
   if(typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=100000)values.add(value);
  });
  if(writes===1&&values.size===1)candidates.set(name,[...values][0]);
 }
 if(!candidates.size)return;
 let selected:number|undefined,conflict=false;
 const visit=(node:t.Node,guards:t.Node[],budget:{remaining:number})=>{
  if(--budget.remaining<0)return;
  if(node.type==='IfStatement'){
   visit(node.test,guards,budget);visit(node.consequent,[...guards,node.test],budget);return;
  }
  if(node.type==='CallExpression'){
   if(node.callee.type==='Identifier'&&candidates.has(node.callee.name)&&!node.arguments.length&&guards.length){
    const active=guards.every(guard=>{
     const test=guard.type==='SequenceExpression'?guard.expressions.at(-1)!:guard;
     return evaluate(test)===true;
    });
    if(active){const value=candidates.get(node.callee.name)!;if(selected!==undefined&&selected!==value)conflict=true;selected=value;}
   }
   if(helper(node.callee,'nextTick'))for(const arg of node.arguments)if(isRenderFunction(arg)&&!arg.params.length)visit(arg.body,guards,budget);
  }
  for(const key of VISITOR_KEYS[node.type]??[]){const child=(node as unknown as Record<string,unknown>)[key];for(const item of Array.isArray(child)?child:[child])if(item&&typeof item==='object'&&'type'in item&&!isRenderFunction(item as t.Node))visit(item as t.Node,guards,budget);}
 };
 walk(setup.body,(node,ancestors)=>{if(ancestors.some(isRenderFunction))return;if(node.type==='CallExpression'&&helper(node.callee,'onMounted')&&isRenderFunction(node.arguments[0])&&!node.arguments[0].params.length)visit(node.arguments[0].body,[],{remaining:3000});});
 return conflict?undefined:selected;
}
