import type {Node} from '@babel/types';
import {isRenderFunction,unwrapExpression,nodeName} from './ast.js';
import {evaluate,UNKNOWN,type ExpressionContext} from './expression.js';

/** Prove an identity relationship from a tiny, pure source body. Names such as
 * withInstall/memo are not evidence; mutations, calls and branches are rejected. */
export function identityArgument(fn:Node,args?:readonly Node[],context?:ExpressionContext):number|undefined{
 if(!isRenderFunction(fn)||fn.async||fn.generator||fn.params.some(p=>p.type!=='Identifier'))return;
 const aliases=new Map<string,string>();
 const available=new Set(fn.params.flatMap(p=>p.type==='Identifier'?[p.name]:[]));
 const metadata=new Set<string>();
 const env=Object.fromEntries(fn.params.map((p,i)=>[nodeName(p)!,args&&i>=args.length?undefined:UNKNOWN]));
 const install=(node:Node):boolean=>{
  if(node.type!=='AssignmentExpression'||node.operator!=='='||node.left.type!=='MemberExpression'||node.left.computed||nodeName(node.left.property)!=='install'||node.left.object.type!=='Identifier'||!available.has(node.left.object.name)||!isRenderFunction(node.right)||node.right.async||node.right.generator)return false;
  metadata.add(node.left.object.name);return true;
 };
 let result:Node|undefined=fn.body;
 if(fn.body.type==='BlockStatement'){
  result=undefined;
  for(const statement of fn.body.body){
   if(statement.type==='VariableDeclaration'&&statement.kind==='const'){
    for(const declaration of statement.declarations){const init=unwrapExpression(declaration.init);if(declaration.id.type!=='Identifier'||init?.type!=='Identifier'||!available.has(init.name))return;aliases.set(declaration.id.name,init.name);available.add(declaration.id.name);}
   }else if(statement.type==='ReturnStatement'&&statement.argument&&!result)result=statement.argument;
   else if(args&&statement.type==='ExpressionStatement'&&install(statement.expression))continue;
   else if(args&&statement.type==='IfStatement'){
    let test:Node=statement.test;
    if(test.type==='SequenceExpression'){if(!test.expressions.slice(0,-1).every(install))return;test=test.expressions.at(-1)!;}
    const value=evaluate(test,{code:context?.code??'',env,bindings:{}});
    // Only a statically absent optional extension is discarded. Any active or
    // unknown branch could replace render/layout properties and stays opaque.
    if(value===UNKNOWN||value||statement.alternate)return;
   }
   else return;
  }
 }
 result=unwrapExpression(result);if(result?.type!=='Identifier')return;
 let name=result.name;const seen=new Set<string>();
 while(aliases.has(name)&&!seen.has(name)){seen.add(name);name=aliases.get(name)!;}
 for(const modified of metadata){let target=modified;while(aliases.has(target))target=aliases.get(target)!;if(target!==name)return;}
 const index=fn.params.findIndex(p=>p.type==='Identifier'&&p.name===name);
 return index<0?undefined:index;
}
