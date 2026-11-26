import path from 'node:path';
import { UNKNOWN,SOURCE_INITIAL, bindPattern, evaluateString, sourceCapacity, type Ast, type Value } from './expression.js';
import { nonVisual, unknownGeometry, styleString } from './html.js';
import { type RenderContext, type SourceSlot } from './context.js';
import type { RenderHost } from './render-host.js';
import { parseExpression } from '@babel/parser';
import { parse as parseDOM, type TemplateChildNode as VueNode, type DirectiveNode, type ExpressionNode } from '@vue/compiler-dom';
import { componentName } from './components.js';
import { boundaryContentContext, hasStateBinding } from './branches.js';
import {collectionRoot,loadingPresence,projectsCollection,repeatCapacity,collectionEmpty,exclusiveChoice} from './loading-state.js';
import{initialString}from'./initial-state.js';

const expression = (node: ExpressionNode | undefined): string | undefined => node?.type === 4 ? node.content : undefined;
const directive = (node: Extract<VueNode, { type: 1 }>, names: string[]): DirectiveNode | undefined =>
  node.props.find((prop): prop is DirectiveNode => prop.type === 7 && names.includes(prop.name));
const repeatedContent = (node: VueNode): boolean => node.type === 1 && (!!directive(node, ['for']) || node.children.some(repeatedContent));
function slotParameter(host:RenderHost,slot:DirectiveNode|undefined,ctx:RenderContext,node:VueNode):Ast|undefined{
 if(!expression(slot?.exp))return;
 try{const fn=parseExpression(`(${expression(slot?.exp)})=>0`,{plugins:['typescript']});if(fn.type==='ArrowFunctionExpression')return fn.params[0];}catch{host.diagnose('SLOT_UNKNOWN','Cannot parse scoped slot parameters',ctx,node);}
}
function slotName(host:RenderHost,slot:DirectiveNode|undefined,ctx:RenderContext,node:VueNode):string|undefined{
 if(!slot?.arg)return'default';
 const name=slot.arg.type===4&&slot.arg.isStatic?slot.arg.content:evaluateString(expression(slot.arg)??'',ctx);
 if(typeof name==='string')return name;
 host.diagnose('SLOT_UNKNOWN','Dynamic slot name needs a finite source value',ctx,node);
}

export async function renderVueNodes(this: RenderHost, nodes: VueNode[], ctx: RenderContext): Promise<string> {
  let html = '';
  let inChain = false, selected = false;
  const choices=new Map<string,string>();
  const roots=new Set<string>();
  const collect=(node:VueNode)=>{if(node.type!==1)return;const loop=expression(directive(node,['for'])?.exp)?.match(/\s+(?:in|of)\s+([\s\S]+)$/);if(loop){const root=collectionRoot(loop[1]);if(root)roots.add(root);}node.children.forEach(collect);};nodes.forEach(collect);
  for (const node of nodes) {
    const selection=this.selectVueNode(node,ctx);
    if(selection==='skip')continue;
    if (node.type === 3 || node.type === 2 && !node.content.trim()) continue;
    if (node.type === 1) {
      const condition = directive(node, ['if', 'else-if', 'else']);
      if (condition&&selection!=='ancestor'&&selection!=='target') {
        if (condition.name === 'if') { inChain = true; selected = false; }
        if (selected && inChain) continue;
        const expr = expression(condition.exp) ?? 'true';
        let result = evaluateString(expr, ctx);
        const exclusive=ctx.loading&&!ctx.control?exclusiveChoice(expr):undefined;
        if(exclusive){
          if(result===true||result===UNKNOWN&&!choices.has(exclusive.key))choices.set(exclusive.key,exclusive.value);
          else if(result===UNKNOWN&&choices.get(exclusive.key)!==exclusive.value){this.record('branch',expr,'Exclude an incompatible alternative in the representative loading frame',ctx,node);continue;}
        }
        const presence=hasStateBinding(expr,ctx)?undefined:loadingPresence(expr,ctx);
        if(presence&&roots.has(presence.root)&&collectionEmpty(presence.root,ctx)&&projectsCollection(presence.root,ctx)){
          result=presence.present;
          ctx={...ctx,projectedCollections:new Set([...ctx.projectedCollections??[],presence.root])};
          this.diagnose('LOADING_PROJECTION','Render the source collection template for loading; future result count and values remain unknown',ctx,node);
        }
        if (result !== UNKNOWN && !result) {
          if (this.target.kind === 'request' && this.hints.state!=='source' && repeatedContent(node) && !hasStateBinding(expr, ctx)) this.diagnose('EMPTY_STATE', 'Source-default branch excludes repeated request content; declare a finite populated/empty variant when needed', ctx, node);
          continue;
        }
        if (result === UNKNOWN) this.diagnose('BRANCH_DEFAULT', `Unknown condition ${expr}: include this branch`, ctx, node);
        this.record('branch', expr, result === UNKNOWN ? 'Include first unresolved branch' : `Resolved to ${!!result}`, ctx, node);
        selected = true;
      } else { inChain = false; selected = false; }
    } else if (node.type !== 2) { inChain = false; selected = false; }
    html += await this.vueNode(node, ctx);
  }
  return html;
}
export async function renderVueNode(this: RenderHost, node: VueNode, ctx: RenderContext, skipFor = false): Promise<string> {
  const selection=this.selectVueNode(node,ctx);
  if(selection==='skip')return'';
  const exhausted = this.budget(ctx, node);
  if (exhausted !== undefined) return exhausted;
  if (node.type === 2) return node.content.trim() ? this.contentText(node.content, ctx, node) : '';
  if (node.type === 5) { this.record('text', expression(node.content) ?? '', 'Resolve content policy for interpolation', ctx, node); return this.contentText(evaluateString(expression(node.content) ?? '', ctx), ctx, node); }
  if (node.type !== 1) return '';
  const loop = directive(node, ['for']);
  if (loop && !skipFor) {
    const match = expression(loop.exp)?.match(/^\s*(.*?)\s+(?:in|of)\s+([\s\S]+)$/);
    if (!match) return this.fallback(ctx, node, 'Unsupported v-for expression');
    let patterns: Ast[];
    try {
      const aliases = match[1].trim().replace(/^\(([\s\S]*)\)$/, '$1');
      const callback = parseExpression(`(${aliases}) => 0`, { plugins: ['typescript'] });
      if (callback.type !== 'ArrowFunctionExpression') throw new Error('Unsupported aliases');
      patterns = callback.params;
      if (!patterns.length || patterns.length > 3) throw new Error('Unsupported aliases');
    } catch { return this.fallback(ctx, node, 'Unsupported v-for aliases'); }
    const list = evaluateString(match[2], ctx);
    const bound=sourceCapacity(list);
    const entries = Array.isArray(list) ? list.map((value, index) => [value, index]) : bound==null&&list && list !== UNKNOWN && typeof list === 'object' ? Object.entries(list).map(([key, value]) => [value, key]) : undefined;
    const projected=collectionEmpty(match[2],ctx)&&!hasStateBinding(match[2],ctx)&&projectsCollection(collectionRoot(match[2]),ctx);
    const count = this.hints.repeat ?? (projected?repeatCapacity(match[2],ctx):bound!=null?Math.min(24,bound):entries ? Math.min(entries.length, 24) : typeof list === 'number' && Number.isFinite(list) ? Math.min(Math.max(0, Math.floor(list)), 24) : 4);
    if(bound!=null)this.diagnose('LOADING_PROJECTION','Use a representative source collection bound; later mutations, result count and item values remain unknown',ctx,node);
    if(projected)this.diagnose('LOADING_PROJECTION',`Render ${count} masked source items; this is loading capacity, not a predicted response`,ctx,node);
    if (this.target.kind === 'request' && this.hints.state!=='source' && count === 0 && !hasStateBinding(match[2], ctx)) this.diagnose('EMPTY_STATE', 'Source-default collection is empty; declare a finite populated/empty variant when needed', ctx, node);
    this.record('repeat', match[2], `Generate ${count} placeholders`, ctx, node);
    let html = '';
    for (let i = 0; i < count; i++) {
      const local: RenderContext = { ...ctx, env: { ...ctx.env } };
      bindPattern(patterns[0], !projected&&entries ? entries[i] ? entries[i][0] : UNKNOWN : typeof list === 'number' ? i + 1 : UNKNOWN, local.env);
      if (patterns[1]) bindPattern(patterns[1], entries ? entries[i]?.[1] ?? i : i, local.env);
      if (patterns[2]) bindPattern(patterns[2], i, local.env);
      html += await this.vueNode(node, local, true);
    }
    return html;
  }
  if(selection==='target'){
    const binding=node.props.find((p):p is DirectiveNode=>p.type===7&&p.name==='bind'&&p.arg?.type===4&&p.arg.content==='pending');
    const value=expression(binding?.exp);
    const content={...(value?boundaryContentContext(ctx,value):ctx),loading:this.hints.state==='loading'||this.hints.state!=='source'&&(value?value!=='false':!!ctx.loading)};
    return this.captureVueRegion(()=>this.vueNodes(node.children,content));
  }
  if(selection==='ancestor'&&node.tagType!==1&&node.tag!=='slot'){
    const policy=Object.fromEntries(node.props.flatMap(p=>p.type===6&&['data-sk-preserve','data-sk-mask'].includes(p.name)?[[p.name,p.value?.content??true]]:[]));
    return this.vueNodes(node.children,this.contentContext(ctx,policy));
  }
  const props: Record<string, Value> = Object.create(null);
  let unknownLayout = false;
  let htmlContent: string | undefined, textContent = false;
  let textValue: Value = UNKNOWN;
  for (const p of node.props) {
    if (p.type === 6) props[p.name] = p.value?.content ?? true;
    else if (p.name === 'bind' && !p.arg) {
      const spread = evaluateString(expression(p.exp) ?? '', ctx);
      if (spread && spread !== UNKNOWN && typeof spread === 'object' && !Array.isArray(spread)) Object.assign(props, spread);
      else this.diagnose('SPREAD_UNKNOWN', 'Cannot resolve Vue v-bind object; provide source bindings', ctx, node);
    }
    else if (p.name === 'bind' && p.arg?.type === 4 && p.arg.isStatic) {
      const key = p.arg.content;
      let value = evaluateString(expression(p.exp) ?? key, ctx);
      if(value===UNKNOWN&&ctx.loading&&node.tagType===1&&!['class','style'].includes(key)){
        const initial=initialString(expression(p.exp)??key,ctx);
        if(initial!==UNKNOWN){value={[SOURCE_INITIAL]:initial};this.diagnose('LOADING_PROJECTION','Use a source-declared initial component layout; runtime changes remain unknown',ctx,node);}
      }
      if (value === UNKNOWN && ['class', 'style', 'width', 'height'].includes(key)) {
        value = evaluateString(expression(p.exp) ?? key, { ...ctx, defaultBranches: true });
        this.diagnose('LAYOUT_UNKNOWN', value === UNKNOWN ? `Cannot resolve :${key}; using a local fallback` : `Unknown :${key} condition: use the first static branch`, ctx, node);
        if (value === UNKNOWN) unknownLayout = true;
      }
      props[key] = key === 'class' && props.class != null ? [props.class, value] : value;
    } else if (p.name === 'model') {
      if (!p.arg || p.arg.type === 4 && p.arg.isStatic) props[p.arg?.content ?? 'modelValue'] = evaluateString(expression(p.exp) ?? '', ctx);
    } else if (p.name === 'show') {
      const show = evaluateString(expression(p.exp) ?? '', ctx);
      const value=expression(p.exp)??'',presence=hasStateBinding(value,ctx)?undefined:loadingPresence(value,ctx);
      if(presence&&!presence.present&&projectsCollection(presence.root,ctx)&&collectionEmpty(presence.root,ctx))return '';
      if (show !== UNKNOWN && !show) return '';
    } else if (p.name === 'text') { textContent = true; textValue = evaluateString(expression(p.exp) ?? '', ctx); }
    else if (p.name === 'html') {
      const value = evaluateString(expression(p.exp) ?? '', ctx);
      if (typeof value !== 'string' || value.length > 32768) return this.fallback(ctx, node, 'Dynamic v-html content needs an adapter', this.attributes(props));
      htmlContent = value;
    }
    else if (!['if', 'else', 'else-if', 'for', 'on', 'slot', 'model', 'once', 'memo', 'bind'].includes(p.name)) this.diagnose('DIRECTIVE_UNKNOWN', `Custom directive v-${p.name} may affect layout`, ctx, node);
  }
  const fallthrough = ctx.fallthrough;
  if (fallthrough && fallthrough.node === node) {
    for (const [key, value] of Object.entries(fallthrough.props)) {
      if (key === 'class' && props.class != null) props.class = [props.class, value];
      else if (key === 'style' && props.style != null) props.style = `${styleString(props.style)};${styleString(value)}`;
      else props[key] = value;
    }
  }
  const tag = node.tag;
  ctx = this.contentContext(ctx, props, tag);
  if (ctx.module.boundaries.has(tag) || tag === 'loading-boundary') {
    const pending = node.props.find((p): p is DirectiveNode => p.type === 7 && p.name === 'bind' && p.arg?.type === 4 && p.arg.content === 'pending');
    const value = expression(pending?.exp);
    const content=()=>this.vueNodes(node.children, {...(value ? boundaryContentContext(ctx, value) : ctx),loading:this.hints.state==='loading'||this.hints.state!=='source'&&!!value&&value!=='false'});
    return content();
  }
  if (unknownGeometry(props.style)) unknownLayout = true;
  if (unknownLayout&&selection!=='ancestor') return this.fallback(ctx, node, 'Unknown layout expression; add bindings or an adapter', this.attributes(props));
  if (['template', 'transition', 'Transition', 'transition-group', 'TransitionGroup', 'KeepAlive', 'keep-alive'].includes(tag)) return this.vueNodes(node.children, ctx);
  if (tag === 'slot') {
    const name = typeof props.name === 'string' ? props.name : 'default';
    const argument={...props};delete argument.name;
    const initial={...argument};let projected=false;
    for(const p of node.props)if(p.type===7&&p.name==='bind'&&p.arg?.type===4&&p.arg.isStatic){const value=initialString(expression(p.exp)??p.arg.content,ctx);if(value!==UNKNOWN){initial[p.arg.content]=value;projected=true;}}
    return ctx.slots?.[name] ? this.renderSlot(ctx.slots[name], ctx,argument,projected?initial:UNKNOWN) : node.children.length ? this.vueNodes(node.children, ctx) : '';
  }
  if (tag === 'component') {
    if (typeof props.is !== 'string' || !/^[a-zA-Z][\w-]*$/.test(props.is)) return this.fallback(ctx, node, 'Dynamic component requires a finite adapter', this.attributes(props));
    this.record('component', expression(node.props.find((p): p is DirectiveNode => p.type === 7 && p.arg?.type === 4 && p.arg.content === 'is')?.exp) ?? 'is', `Select static component ${props.is}`, ctx, node);
    const selected = parseDOM(`<${props.is}/>`).children[0];
    if (selected?.type !== 1) return this.fallback(ctx, node, 'Unsupported dynamic component');
    return this.vueNode({ ...selected, children: node.children, loc: node.loc, props: node.props.filter((p) => p.name !== 'is' && !(p.type === 7 && p.arg?.type === 4 && p.arg.content === 'is') && p.name !== 'for') }, ctx, true);
  }
  const imported = await this.componentReference(tag, ctx);
  if (node.tagType === 1 || imported?.file) this.record('component', tag, 'Resolve source component or adapter', ctx, node);
  if (imported?.file || this.target.adapters?.[tag]) {
    const slots: Record<string, SourceSlot> = {};
    const defaults: VueNode[] = [];
    for (const child of node.children) {
      const slot = child.type === 1 && child.tag === 'template' ? directive(child, ['slot']) : undefined;
      if (slot && child.type === 1){
        const name=slotName(this,slot,ctx,child);if(name!==undefined)slots[name] = { nodes: child.children, context: ctx, framework: 'vue',parameter:slotParameter(this,slot,ctx,child) };
      }
      else defaults.push(child);
    }
    if (defaults.length){const own=directive(node,['slot']),name=slotName(this,own,ctx,node);if(name!==undefined)slots[name]={nodes:defaults,context:ctx,framework:'vue',parameter:slotParameter(this,own,ctx,node)};}
    props.__skSlots = slots;
    const adapter = this.target.adapters?.[tag];
    if (adapter) { const file = path.resolve(this.root, adapter); await this.scan(file); return this.component(file, 'default', props, ctx, node); }
  }
  if (imported?.file && /\.(vue|tsx|jsx|ts|js)$/.test(imported.file)) return this.component(imported.file, imported.exported, props, ctx, node);
  if (componentName(tag) === 'routerlink') return this.element('a', props, await this.vueNodes(node.children, ctx), ctx, node);
  const presentation = await this.preset(tag, imported, props, { nodes: node.children, context: ctx, framework: 'vue' }, node);
  if (presentation !== undefined) return presentation;
  if (node.tagType === 1) return this.fallback(ctx, node, `No source adapter for ${tag}`, this.attributes(props));
  if (nonVisual.has(tag)) return '';
  if (tag === 'img') return this.image(props, ctx, node);
  const children = htmlContent !== undefined ? this.staticHTML(htmlContent, ctx, node)
    : tag === 'p' && this.masked(ctx) && this.hints.lines != null ? this.text(ctx, node, true)
    : textContent ? this.contentText(textValue, ctx, node) : await this.vueNodes(node.children, ctx);
  if (['div', 'section', 'article', 'main', 'canvas'].includes(tag) && Object.hasOwn(props, 'ref') && htmlContent === undefined && !textContent && node.children.every((child) => child.type === 3 || child.type === 2 && !child.content.trim())) {
    // An empty imperative mount host has no source-visible internal tree.
    // Mask only its existing box; do not invent widget-specific geometry.
    this.diagnose('FALLBACK', 'Opaque native mount point: preserve source container geometry', ctx, node, this.nodeId(ctx, node));
    return this.element(tag, props, '', ctx, node).replace(' data-sk-node=', ` data-sk-opaque${this.masked(ctx) ? ' data-sk-leaf' : ''} data-sk-node=`);
  }
  return this.element(tag, props, children, ctx, node);
}
