import type * as t from '@babel/types';
import type {ModuleInfo} from './context.js';
import {isRenderFunction,unwrapExpression} from './ast.js';
/** Follow only the exported Vite config and known syntax-only wrappers. */
export function viteConfigObjects(mod:ModuleInfo):t.ObjectExpression[]{
 const start=mod.ast.program.body.find(n=>n.type==='ExportDefaultDeclaration');
 const visit=(input:t.Node|undefined,seen=new Set<string>()):t.ObjectExpression[]=>{
  const node=unwrapExpression(input);if(!node)return[];
  if(node.type==='ObjectExpression')return[node];
  if(node.type==='Identifier'&&!seen.has(node.name))return visit(mod.functions.get(node.name),new Set(seen).add(node.name));
  if(node.type==='CallExpression'&&node.callee.type==='Identifier'){const ref=mod.imports.get(node.callee.name);if(ref&&(ref.request==='vite'&&ref.exported==='defineConfig'||ref.request==='skelcast/vite'&&ref.exported==='withSkelCast'))return visit(node.arguments[0],seen)}
  if(isRenderFunction(node)){if(node.body.type!=='BlockStatement')return visit(node.body,seen);if(node.body.body.some(n=>n.type==='IfStatement'||n.type==='SwitchStatement'||n.type==='TryStatement'))return[];return node.body.body.flatMap(statement=>statement.type==='ReturnStatement'?visit(statement.argument??undefined,seen):[])}
  return[];
 };return start?.type==='ExportDefaultDeclaration'?visit(start.declaration):[];
}
