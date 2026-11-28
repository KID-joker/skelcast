import type * as t from '@babel/types';
import {evaluate,SOURCE_NORMALIZED,UNKNOWN,type ExpressionContext} from './expression.js';
import {initialExpression} from './initial-state.js';
import {nodeName,walk} from './ast.js';
/** Boolean consumers can prove an outcome even when an operand is unknown.
 * Initial structural arrays stay separate from response/live expression values. */
export function sourceCondition(node:t.Node|undefined,ctx:ExpressionContext,depth=0):{value:boolean|typeof UNKNOWN;projected:boolean}{
 if(depth>40)return{value:UNKNOWN,projected:false};
 ctx={...ctx,budget:ctx.budget??{remaining:10000}};
 if(!node)return{value:UNKNOWN,projected:false};
 const known=evaluate(node,ctx);if(known!==UNKNOWN)return{value:!!known,projected:false};
 let normalized=false;
 walk(node,child=>{if((child.type==='MemberExpression'||child.type==='OptionalMemberExpression')&&nodeName(child.property)==='length'){const value=initialExpression(child.object,ctx);if(Array.isArray(value)&&Object.hasOwn(value,SOURCE_NORMALIZED))normalized=true}});
 if(normalized){const value=initialExpression(node,ctx);if(value!==UNKNOWN)return{value:!!value,projected:true}}
 if(node.type==='UnaryExpression'&&node.operator==='!'){const inner=sourceCondition(node.argument,ctx,depth+1);return{...inner,value:inner.value===UNKNOWN?UNKNOWN:!inner.value}}
 if(node.type==='LogicalExpression'&&['&&','||'].includes(node.operator)){
  const left=sourceCondition(node.left,ctx,depth+1),right=sourceCondition(node.right,ctx,depth+1),projected=left.projected||right.projected;
  if(node.operator==='&&'){if(left.value===false||right.value===false)return{value:false,projected};if(left.value===true&&right.value===true)return{value:true,projected}}
  else{if(left.value===true||right.value===true)return{value:true,projected};if(left.value===false&&right.value===false)return{value:false,projected}}
 }
 return{value:UNKNOWN,projected:false};
}
