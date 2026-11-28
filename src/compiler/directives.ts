import type * as t from '@babel/types';
import {isRenderFunction,nodeName,unwrapExpression,walk} from './ast.js';
import {evaluate,UNKNOWN,type Value} from './expression.js';
import type {ModuleInfo,RenderContext} from './context.js';
import type {ComponentReference} from './presets/types.js';

function object(mod:ModuleInfo,node:t.Node|undefined):t.ObjectExpression|undefined {let value=node;const seen=new Set<string>();while(value?.type==='Identifier'&&!seen.has(value.name)){seen.add(value.name);value=mod.functions.get(value.name)}return value?.type==='ObjectExpression'?value:undefined}
function root(node:t.Node):string|undefined{return node.type==='Identifier'?node.name:node.type==='CallExpression'&&node.callee.type==='MemberExpression'?root(node.callee.object):undefined}
/** Statically read direct registrations and local plugin install registries. */
export function directiveRegistrations(mod:ModuleInfo,definition?:t.Node){
 const directives:{name:string;reference:ComponentReference}[]=[],plugins:ComponentReference[]=[];
 let body:t.Node=mod.ast,apps=new Set<string>();
 if(definition){const installer=object(mod,definition)?.properties.find(p=>p.type!=='SpreadElement'&&nodeName(p.key)==='install');const fn=installer?.type==='ObjectMethod'?installer:installer?.type==='ObjectProperty'&&isRenderFunction(installer.value)?installer.value:undefined;if(!fn||fn.params[0]?.type!=='Identifier')return{directives,plugins};body=fn.body;apps.add(fn.params[0].name)}
 else for(const declaration of mod.ast.program.body.flatMap(statement=>statement.type==='VariableDeclaration'?statement.declarations:[])){const init=declaration.init;if(declaration.id.type==='Identifier'&&init?.type==='CallExpression'&&init.callee.type==='Identifier'&&mod.imports.get(init.callee.name)?.request==='vue'&&mod.imports.get(init.callee.name)?.exported==='createApp')apps.add(declaration.id.name)}
 walk(body,(node,ancestors)=>{
  if(node.type!=='CallExpression'||node.callee.type!=='MemberExpression'||!apps.has(root(node.callee.object)??''))return;
  const[first,second]=node.arguments,method=nodeName(node.callee.property);
  if(method==='use'&&first?.type==='Identifier'){const ref=mod.imports.get(first.name);if(ref?.file)plugins.push(ref)}
  if(method!=='directive')return;
  if(first?.type==='StringLiteral'&&second?.type==='Identifier'){const ref=mod.imports.get(second.name);if(ref)directives.push({name:first.value,reference:ref});return}
  if(first?.type!=='Identifier'||second?.type!=='MemberExpression'||!second.computed||second.object.type!=='Identifier'||second.property.type!=='Identifier'||second.property.name!==first.name)return;
  const callback=[...ancestors].reverse().find(a=>isRenderFunction(a)),loop=[...ancestors].reverse().find(a=>a.type==='CallExpression'&&a.callee.type==='MemberExpression'&&nodeName(a.callee.property)==='forEach');
  if(!callback||!isRenderFunction(callback)||callback.params[0]?.type!=='Identifier'||callback.params[0].name!==first.name||loop?.type!=='CallExpression'||loop.callee.type!=='MemberExpression')return;
  const keys=loop.callee.object;
  if(keys.type!=='CallExpression'||keys.callee.type!=='MemberExpression'||nodeName(keys.callee.object)!=='Object'||nodeName(keys.callee.property)!=='keys'||nodeName(keys.arguments[0])!==second.object.name)return;
  const table=object(mod,mod.functions.get(second.object.name));
  for(const property of table?.properties??[])if(property.type==='ObjectProperty'&&!property.computed&&property.value.type==='Identifier'){const name=nodeName(property.key),ref=mod.imports.get(property.value.name);if(name&&ref)directives.push({name,reference:ref})}
 });return{directives,plugins};
}
export interface DirectiveEffects {style:Record<string,Value>;unknown:boolean;visibility:boolean;eventOnly:boolean}
/** Interpret initial DOM style assignments; event bodies are deliberately opaque.
 * All changes roll back if any initial DOM operation is not proven. */
export function directiveEffects(mod:ModuleInfo,definition:t.Node,ctx:RenderContext,value:Value):DirectiveEffects{
 const output:DirectiveEffects={style:{},unknown:false,visibility:false,eventOnly:true};
 const options=object(mod,definition),hooks=options?options.properties.filter(p=>p.type!=='SpreadElement'&&['created','beforeMount','mounted'].includes(nodeName(p.key)??'')).map(p=>p.type==='ObjectMethod'?p:p.type==='ObjectProperty'&&isRenderFunction(p.value)?p.value:undefined):isRenderFunction(definition)?[definition]:[];
 if(!hooks.length)return{...output,unknown:true,eventOnly:false};
 for(const fn of hooks){if(!fn||fn.params[0]?.type!=='Identifier'){output.unknown=true;continue}const el=fn.params[0].name,binding=fn.params[1]?.type==='Identifier'?fn.params[1].name:undefined;
  const env={...mod.env,...(binding?{[binding]:{value}}:{})};
  const ec={...ctx,code:mod.code,env};
  const path=(node:t.Node):string|undefined=>node.type==='Identifier'?node.name:node.type==='MemberExpression'&&!node.computed?`${path(node.object)}.${nodeName(node.property)}`:undefined;
  const annotation=fn.params[0].typeAnnotation;const type=annotation?.type==='TSTypeAnnotation'&&annotation.typeAnnotation.type==='TSTypeReference'&&annotation.typeAnnotation.typeName.type==='Identifier'?annotation.typeAnnotation.typeName.name:undefined;
  const contract=mod.ast.program.body.find(node=>node.type==='TSInterfaceDeclaration'&&node.id.name===type&&node.extends?.some(base=>nodeName(base.expression)==='HTMLElement'));
  const metadata=new Set(contract?.type==='TSInterfaceDeclaration'?contract.body.body.flatMap(member=>member.type==='TSPropertySignature'&&!member.computed&& !['style','className','textContent','innerHTML','outerHTML','hidden','disabled','value','width','height','src','href','id'].includes(nodeName(member.key)??'')?[nodeName(member.key)]:[]):[]);
  const handlers=new Set<string>();walk(fn.body,(node,ancestors)=>{if(ancestors.some(a=>a!==fn&&isRenderFunction(a)))return false;if(node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&nodeName(node.callee.object)===el&&nodeName(node.callee.property)==='addEventListener'&&node.arguments[1])handlers.add(path(node.arguments[1])??'')});
  const visit=(node:t.Node):void=>{
   if(isRenderFunction(node)||node.type==='ObjectMethod')return;
   if(node.type==='BlockStatement'){node.body.forEach(visit);return}
   if(node.type==='ExpressionStatement'){visit(node.expression);return}
   if(node.type==='VariableDeclaration'){for(const declaration of node.declarations){if(isRenderFunction(declaration.init))continue;if(declaration.id.type!=='Identifier'){output.unknown=true;continue}const result=evaluate(declaration.init,ec);if(result===UNKNOWN)output.unknown=true;else env[declaration.id.name]=result}return}
   if(node.type==='AssignmentExpression'){
    const target=path(node.left),expression=unwrapExpression(node.right);
    if(target?.startsWith(el+'.style.')&&node.operator==='='){const result=evaluate(expression,ec);if(typeof result==='string'||typeof result==='number'){output.style[target.slice((el+'.style.').length)]=result;output.eventOnly=false}else output.unknown=true;return}
    if(target&&((handlers.has(target)&&isRenderFunction(expression))||target.startsWith(el+'.on')&&isRenderFunction(expression)))return;
    if(target?.startsWith(el+'.')&&metadata.has(target.slice(el.length+1))){let readonly=true;walk(node.right,n=>{if(['CallExpression','NewExpression','AwaitExpression','AssignmentExpression','UpdateExpression'].includes(n.type))readonly=false});if(readonly)return;}
    output.unknown=true;return;
   }
   if(node.type==='CallExpression'){
    if(node.callee.type==='MemberExpression'&&nodeName(node.callee.object)===el){const method=nodeName(node.callee.property);if(method==='addEventListener'||method==='removeEventListener')return;if(method==='remove'){output.visibility=true;output.eventOnly=false;return}}
    output.unknown=true;return;
   }
   if(node.type==='IfStatement'){
    const condition=evaluate(node.test,ec);
    if(condition!==UNKNOWN){const selected=condition?node.consequent:node.alternate;if(selected)visit(selected);return}
    // Invalid binding guards only throw; they don't create a presentation state.
    const guard=node.consequent.type==='ThrowStatement'||node.consequent.type==='BlockStatement'&&node.consequent.body.every(s=>s.type==='ThrowStatement');
    if(guard&&!node.alternate)return;
    output.unknown=true;walk(node,n=>{if(n.type==='CallExpression'&&n.callee.type==='MemberExpression'&&nodeName(n.callee.object)===el&&nodeName(n.callee.property)==='remove')output.visibility=true});return;
   }
   if(['ThrowStatement','AwaitExpression','NewExpression','ForStatement','WhileStatement','TryStatement'].includes(node.type)){output.unknown=true;return}
   if(node.type!=='EmptyStatement')output.unknown=true;
  };
  visit(fn.body);
 }
 if(output.unknown)output.style={};return output;
}
