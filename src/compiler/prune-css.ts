import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import {parse} from '@vue/compiler-dom';

/** Static markup cannot acquire new component classes. Only reject selectors
 * whose positive class constraints are impossible; unknown pseudos/ancestors,
 * attributes, tags and negative selectors remain conservative. */
export function pruneCSS(css:string,html:string):string{
 const classes=new Set(['dark','light']);
 const visit=(node:ReturnType<typeof parse>|ReturnType<typeof parse>['children'][number]|import('@vue/compiler-dom').SimpleExpressionNode)=>{
  if(node.type===1)for(const prop of node.props)if(prop.type===6&&prop.name==='class')for(const name of (prop.value?.content??'').split(/\s+/))classes.add(name);
  if('children'in node)for(const child of node.children)if(typeof child==='object')visit(child);
 };
 visit(parse(html));
 const possible=(node:selectorParser.Node):boolean=>{
  if(node.type==='class')return classes.has(node.value);
  if(node.type==='pseudo'){
   if([':is',':where',':has'].includes(node.value))return !node.nodes?.length||node.nodes.some(possible);
   return true;
  }
  return !('nodes'in node)||!node.nodes||node.nodes.every(possible);
 };
 const root=postcss.parse(css);
 root.walkRules(rule=>{
  for(let parent:typeof rule.parent|undefined=rule.parent;parent;parent=parent.parent as typeof rule.parent)if(parent.type==='atrule'&&/keyframes$/i.test(parent.name))return;
  try{const selectors=selectorParser().astSync(rule.selector);selectors.nodes=selectors.nodes.filter(possible);if(!selectors.nodes.length)rule.remove();else rule.selector=selectors.toString();}catch{/* Unrecognized syntax is retained. */}
 });
 // Font-face data is often the largest entry CSS payload. A literal family can
 // be removed only when it is absent from all remaining CSS and inline styles.
 const fonts:import('postcss').AtRule[]=[];root.walkAtRules('font-face',rule=>{fonts.push(rule);});
 const copy=root.clone();copy.walkAtRules('font-face',rule=>{rule.remove();});
 const references=(copy.toString()+'\n'+html).toLowerCase();
 const variables=new Map<string,string[]>();copy.walkDecls(d=>{if(d.prop.startsWith('--'))variables.set(d.prop,[...variables.get(d.prop)??[],d.value]);});
 const unresolved=(value:string,seen=new Set<string>()):boolean=>[...value.matchAll(/var\(\s*(--[\w-]+)/g)].some(([,name])=>{if(seen.has(name)||!variables.has(name))return true;return variables.get(name)!.some(v=>unresolved(v,new Set(seen).add(name)));});
 let unknownFont=/\bfont(?:-family)?\s*:[^;{}]*var\(/i.test(html);
 copy.walkDecls(/^(?:font|font-family)$/i,d=>{if(unresolved(d.value))unknownFont=true;});
 for(const font of fonts){let family='';font.walkDecls('font-family',d=>{family=d.value.trim().replace(/^(['"])(.*)\1$/,'$2').toLowerCase();});if(!unknownFont&&family&&!references.includes(family))font.remove();}
 root.walkAtRules(rule=>{if(rule.nodes&&!rule.nodes.length&&!['layer'].includes(rule.name))rule.remove();});
 root.walkComments(comment=>{comment.remove();});
 return root.toString();
}
