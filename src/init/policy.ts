import type { File } from '@babel/types';
import type { ComponentPolicy } from '../policy.js';
import { enabledMarker, importedPolicy } from '../policy.js';
import { nodeName, walk, type Ast } from '../compiler/ast.js';
import type { ElementNode, TemplateChildNode } from '@vue/compiler-dom';

export function policyBindings(ast: File, configured: Record<string,ComponentPolicy> = {}): Map<string,ComponentPolicy> {
  const policies = new Map(Object.entries(configured));
  for(const statement of ast.program.body)if(statement.type==='ImportDeclaration'&&statement.importKind!=='type')for(const spec of statement.specifiers){
    const exported=spec.type==='ImportDefaultSpecifier'?'default':spec.type==='ImportSpecifier'?nodeName(spec.imported):undefined;
    const policy=exported&&importedPolicy(statement.source.value,exported);
    if(policy&&!policies.has(spec.local.name))policies.set(spec.local.name,policy);
    if(spec.type==='ImportNamespaceSpecifier')for(const exported of ['Editor','DiffEditor','EditorContent']){
      const policy=importedPolicy(statement.source.value,exported);if(policy)policies.set(`${spec.local.name}.${exported}`,policy);
    }
  }
  return policies;
}
const normalized = (name:string) => name.replace(/-/g,'').toLowerCase();
function liveName(name:string,policies:Map<string,ComponentPolicy>):boolean{
  return [...policies].some(([tag,policy])=>policy==='live'&&normalized(tag)===normalized(name));
}
export function liveJSX(node:Ast, policies:Map<string,ComponentPolicy>):boolean{
  return node.type==='JSXElement'&&(liveName(nodeName(node.openingElement.name)??'',policies)||node.openingElement.attributes.some((a:Ast)=>a.type==='JSXAttribute'&&['data-sk-live','contentEditable','contenteditable'].includes(nodeName(a.name)??'')&&(!a.value||a.value.type==='StringLiteral'&&(enabledMarker(a.value.value)||nodeName(a.name)!=='data-sk-live'&&a.value.value==='plaintext-only')||a.value.type==='JSXExpressionContainer'&&!(a.value.expression.type==='BooleanLiteral'&&!a.value.expression.value))));
}
export function containsLiveJSX(node:Ast,policies:Map<string,ComponentPolicy>):boolean{
  let found=false;walk(node,n=>{if(n.type==='JSXAttribute'||n.type==='JSXSpreadAttribute')return false;if(liveJSX(n,policies)){found=true;return false;}});return found;
}
export function liveVue(node:ElementNode,policies:Map<string,ComponentPolicy>):boolean{
  return liveName(node.tag,policies)||node.props.some(p=>p.type===6&&['data-sk-live','contenteditable'].includes(p.name)&&(enabledMarker(p.value?.content??true)||p.name==='contenteditable'&&p.value?.content==='plaintext-only')||p.type===7&&p.name==='bind'&&p.arg?.type===4&&['data-sk-live','contenteditable'].includes(p.arg.content)&&p.exp?.type===4&&!['false','null','undefined'].includes(p.exp.content.trim()));
}
export function containsLiveVue(nodes:TemplateChildNode[],policies:Map<string,ComponentPolicy>):boolean{
  return nodes.some(node=>node.type===1&&(liveVue(node,policies)||containsLiveVue(node.children,policies)));
}
export const shellTags = /^(?:h[1-6]|p|nav|label|button|input|textarea|select|option)$/;

/** A semantic tag alone does not prove its content is independent of a request. */
export function fixedShellJSX(node:Ast):boolean{
  if(node.type!=='JSXElement'||!shellTags.test(nodeName(node.openingElement.name)??''))return false;
  if(node.openingElement.attributes.some(a=>a.type==='JSXAttribute'&&nodeName(a.name)==='data-sk-mask'))return false;
  if(/^(?:button|input|textarea|select|option)$/.test(nodeName(node.openingElement.name)??''))return true;
  const fixed=(child:Ast):boolean=>child.type==='JSXText'||child.type==='JSXExpressionContainer'&&['JSXEmptyExpression','StringLiteral'].includes(child.expression.type)||child.type==='JSXElement'&&child.children.every(fixed);
  return node.children.every(fixed);
}
export function fixedShellVue(node:ElementNode):boolean{
  if(!shellTags.test(node.tag)||node.props.some(p=>p.name==='data-sk-mask'))return false;
  if(/^(?:button|input|textarea|select|option)$/.test(node.tag))return true;
  const fixed=(child:TemplateChildNode):boolean=>child.type===2||child.type===3||child.type===1&&!child.props.some(p=>p.type===7)&&child.children.every(fixed);
  return !node.props.some(p=>p.type===7&&['text','html','for','if','else-if','else'].includes(p.name))&&node.children.every(fixed);
}
