import type { Diagnostic } from '../types.js';
import {sourceCondition} from './conditions.js';
import {directiveEffects} from './directives.js';
import { renderComponent } from './component-render.js';
import { UNKNOWN,SOURCE_NORMALIZED,SOURCE_INITIAL, bindPattern, evaluateString, parseSourceExpression, sourceCapacity, type Value } from './expression.js';
import { nonVisual, unknownGeometry, styleString } from './html.js';
import { type RenderContext, type SourceSlot } from './context.js';
import type { RenderHost } from './render-host.js';
import { parserOptions, type ElementNode, type TemplateChildNode as VueNode, type DirectiveNode, type ExpressionNode } from '@vue/compiler-dom';
import { boundaryContentContext } from './branches.js';
import { collectionRoot, loadingBranch, projectCollection, exclusiveChoice } from './loading-state.js';
import{initialString}from'./initial-state.js';
import { planCollection } from './collections.js';
import { renderBudget } from './render-budget.js';
import { renderAtomic } from './output.js';
import { expandedTemplateSlots, slotName, slotParameter } from './vue-slots.js';
import { nativeTableOutline, shallowPresentation } from './outline.js';
import { liveElement } from '../policy.js';
import { parseVueLoop } from './vue-syntax.js';

const expression = (node: ExpressionNode | undefined): string | undefined => node?.type === 4 ? node.content : undefined;
const directive = (node: Extract<VueNode, { type: 1 }>, names: string[]): DirectiveNode | undefined =>
  node.props.find((prop): prop is DirectiveNode => prop.type === 7 && names.includes(prop.name));
const repeatedContent = (node: VueNode): boolean => node.type === 1 && (!!directive(node, ['for']) || node.children.some(repeatedContent));
const rootCache = new WeakMap<VueNode[], Set<string>>();
/** Cache syntax only: loop values and branch choices still use the current context. */
function collectionRoots(nodes: VueNode[], ctx: RenderContext): Set<string> {
  let roots = rootCache.get(nodes);
  if (roots) return roots;
  roots = new Set<string>();
  for (const node of nodes) if (node.type === 1) {
    const loop = expression(directive(node, ['for'])?.exp)?.match(/\s+(?:in|of)\s+([\s\S]+)$/);
    const root = loop && collectionRoot(loop[1], ctx);
    if (root) roots.add(root);
    for (const childRoot of collectionRoots(node.children, ctx)) roots.add(childRoot);
  }
  rootCache.set(nodes, roots);
  return roots;
}

type VueProp = ElementNode['props'][number];
interface EvaluatedProp { prop: VueProp; key?: string; value: Value; projected: boolean }
const dynamicContentProp = (prop: VueProp) => prop.name !== 'is' && prop.name !== 'for' && !(prop.type === 7 && prop.arg?.type === 4 && prop.arg.content === 'is');

function assignProp(props: Record<string, Value>, prop: VueProp, key: string | undefined, value: Value): void {
  if (key != null) props[key] = prop.type === 7 && prop.name === 'bind' && key === 'class' && props.class != null ? [props.class, value] : value;
  else if (value && value !== UNKNOWN && typeof value === 'object' && !Array.isArray(value)) Object.assign(props, value);
}

/** Replay evaluated attributes in source order after a dynamic tag is known.
 * Only native width/height projections need reevaluation under their layout policy. */
function dynamicProps(host: RenderHost, entries: EvaluatedProp[], node: ElementNode, ctx: RenderContext) {
  const props: Record<string, Value> = Object.create(null);
  let unknownLayout = false;
  for (const entry of entries) {
    const { prop, key } = entry;
    let { value } = entry;
    if (prop.type === 7) {
      if (node.tagType !== 1 && entry.projected) {
        value = UNKNOWN;
        if (key === 'width' || key === 'height') {
          value = evaluateString(expression(prop.exp) ?? key, { ...ctx, defaultBranches: true });
          host.diagnose('LAYOUT_UNKNOWN', value === UNKNOWN ? `Cannot resolve :${key}; using a local fallback` : `Unknown :${key} condition: use the first static branch`, ctx, node);
          if (value === UNKNOWN) unknownLayout = true;
        }
      }
      if (node.tag === 'component' && key == null && value && typeof value === 'object' && 'is' in value && value.is === node.tag) {
        value = UNKNOWN;
        host.diagnose('SPREAD_UNKNOWN', 'Cannot resolve Vue v-bind object; provide source bindings', ctx, node);
      }
    }
    entry.value = value;
    assignProp(props, prop, key, value);
  }
  return { props, unknownLayout };
}

export async function renderVueNodes(this: RenderHost, nodes: VueNode[], ctx: RenderContext): Promise<string> {
  let html = '';
  let inChain = false, selected = false;
  const choices=new Map<string,string>();
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
        const conditionValue=sourceCondition(parseSourceExpression(expr,ctx),{...ctx,code:expr});
        let result=conditionValue.value;
        if(conditionValue.projected)this.diagnose('LOADING_PROJECTION','Use a normalized initial layout collection guard; live mutations remain unknown',ctx,node);
        const exclusive=ctx.loading&&!ctx.control?exclusiveChoice(expr,ctx):undefined;
        if(exclusive){
          if(result===true||result===UNKNOWN&&!choices.has(exclusive.key))choices.set(exclusive.key,exclusive.value);
          else if(result===UNKNOWN&&choices.get(exclusive.key)!==exclusive.value){this.record('branch',expr,'Exclude an incompatible alternative in the representative loading frame',ctx,node);continue;}
        }
        const { boundState, projected } = loadingBranch(expr, ctx, root => collectionRoots(nodes, ctx).has(root));
        if (projected) {
          result = projected.present;
          ctx = projectCollection(ctx, projected.root);
          this.diagnose('LOADING_PROJECTION','Render the source collection template for loading; future result count and values remain unknown',ctx,node);
        }
        if (result !== UNKNOWN && !result) {
          if (this.target.kind === 'request' && this.hints.state!=='source' && repeatedContent(node) && !boundState) this.diagnose('EMPTY_STATE', 'Source-default branch excludes repeated request content; declare a finite populated/empty variant when needed', ctx, node);
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
export async function renderVueNode(this: RenderHost, source: VueNode, ctx: RenderContext, skipFor = false): Promise<string> {
  const selection=this.selectVueNode(source,ctx);
  if(selection==='skip')return'';
  const exhausted = renderBudget(this, source, ctx, 'template');
  if (exhausted !== undefined) return exhausted;
  if (source.type === 2) return source.content.trim() ? this.contentText(source.content, ctx, source) : '';
  if (source.type === 5) { this.record('text', expression(source.content) ?? '', 'Resolve content policy for interpolation', ctx, source); return this.contentText(evaluateString(expression(source.content) ?? '', ctx), ctx, source); }
  if (source.type !== 1) return '';
  const node = source;
  if (liveElement(Object.fromEntries(node.props.flatMap(p=>p.type===6?[[p.name,p.value?.content??true]]:[])))) {
    this.diagnose('LIVE_CONTENT_IN_BOUNDARY','Keep this live region outside LoadingBoundary so its real content remains visible',ctx,node);
    return '';
  }
  const loop = directive(node, ['for']);
  if (loop && !skipFor) return renderVueLoop.call(this, node, loop, ctx);
  if(selection==='target'){
    const binding=node.props.find((p):p is DirectiveNode=>p.type===7&&p.name==='bind'&&p.arg?.type===4&&p.arg.content==='pending');
    const value=expression(binding?.exp);
    const content=boundaryContentContext(ctx,value,this.hints.state,!!ctx.loading);
    return this.captureVueRegion(()=>this.vueNodes(node.children,content),ctx);
  }
  if(selection==='ancestor'&&node.tagType!==1&&node.tag!=='slot'){
    const policy=Object.fromEntries(node.props.flatMap(p=>p.type===6&&['data-sk-preserve','data-sk-mask'].includes(p.name)?[[p.name,p.value?.content??true]]:[]));
    return this.vueNodes(node.children,this.contentContext(ctx,policy));
  }
  const attributes = evaluateVueProps.call(this, node, ctx);
  return typeof attributes === 'string' ? attributes : renderVueElement.call(this, source, ctx, selection, attributes);
}

async function renderVueLoop(this: RenderHost, node: ElementNode, loop: DirectiveNode, ctx: RenderContext): Promise<string> {
  const syntax = parseVueLoop(expression(loop.exp), ctx);
  if (!syntax) return this.fallback(ctx, node, 'Unsupported v-for expression');
  const patterns = syntax.params;
  if (!patterns?.length || patterns.length > 3) return this.fallback(ctx, node, 'Unsupported v-for aliases');
  let list = evaluateString(syntax.source, ctx);
  if (list === UNKNOWN || ctx.loading) {
    const initial = initialString(syntax.source, ctx);
    if (Array.isArray(initial) && (list===UNKNOWN || Object.hasOwn(initial,SOURCE_NORMALIZED))) { list = initial; this.diagnose('LOADING_PROJECTION', 'Use source-proven initial collection layout; later mutations and callback effects remain unknown', ctx, node); }
  }
  const bound=sourceCapacity(list);
  const array = Array.isArray(list) ? list : undefined;
  const object = !array && bound == null && list && list !== UNKNOWN && typeof list === 'object' ? list as Record<string, Value> : undefined;
  const keys = object ? Object.keys(object) : undefined;
  const length = array?.length ?? keys?.length ?? (typeof list === 'number' && Number.isFinite(list) ? Math.max(0, Math.floor(list)) : undefined);
  const { count, projected } = planCollection(this, syntax.source, list, ctx, node, length, 'predicted response');
  let html = '';
  for (let i = 0; i < count; i++) {
    const local: RenderContext = { ...ctx, env: { ...ctx.env } };
    const key = keys?.[i];
    const item = projected ? UNKNOWN : array ? i in array ? array[i] : UNKNOWN
      : object ? key !== undefined ? object[key] : UNKNOWN : typeof list === 'number' ? i + 1 : UNKNOWN;
    bindPattern(patterns[0], item, local.env);
    if (patterns[1]) bindPattern(patterns[1], key ?? i, local.env);
    if (patterns[2]) bindPattern(patterns[2], i, local.env);
    html += await this.vueNode(node, local, true);
  }
  return html;
}

interface VueAttributes {
  props: Record<string, Value>;
  values?: EvaluatedProp[];
  notes: Diagnostic[];
  unknownLayout: boolean;
  htmlContent?: string;
  textContent: boolean;
  textValue: Value;
}

/** Evaluate directives once, retaining source order for dynamic-tag replay. */
function evaluateVueProps(this: RenderHost, node: ElementNode, ctx: RenderContext): VueAttributes | string {
  const props: Record<string, Value> = Object.create(null);
  // A dynamic tag reuses evaluated attribute values; resolving its tag must not
  // parse synthetic markup or revisit loop/region and expression evaluation.
  const values: EvaluatedProp[] | undefined = node.tag === 'component' ? [] : undefined;
  // Record once and enrich the diagnostic when a dynamic component is known.
  const notes: Diagnostic[] = [];
  const diagnose = (code: string, message: string) => {
    const diagnostic = this.diagnose(code, message, ctx, node);
    if (values) notes.push(diagnostic);
  };
  const assign = (prop: VueProp, key: string | undefined, value: Value, projected = false) => {
    values?.push({ prop, key, value, projected });
    assignProp(props, prop, key, value);
  };
  let unknownLayout = false;
  let htmlContent: string | undefined, textContent = false;
  let textValue: Value = UNKNOWN;
  for (const p of node.props) {
    if (p.type === 6) assign(p, p.name, p.value?.content ?? true);
    else if (p.name === 'bind' && !p.arg) {
      const spread = evaluateString(expression(p.exp) ?? '', ctx);
      assign(p, undefined, spread);
      if (!spread || spread === UNKNOWN || typeof spread !== 'object' || Array.isArray(spread)) diagnose('SPREAD_UNKNOWN', 'Cannot resolve Vue v-bind object; provide source bindings');
    }
    else if (p.name === 'bind' && p.arg?.type === 4 && p.arg.isStatic) {
      const key = p.arg.content;
      let value = evaluateString(expression(p.exp) ?? key, ctx);
      if (key === 'style') {
        const responsive = this.viewportStyle(expression(p.exp) ?? key, ctx, node);
        if (responsive) { assign(p, 'class', responsive.className); value = {}; }
      }
      let projected = false;
      if(value===UNKNOWN&&node.tagType===1&&!['class','style'].includes(key)){
        const initial=initialString(expression(p.exp)??key,ctx);
        if(initial!==UNKNOWN&&(ctx.loading||Array.isArray(initial))){projected=true;value={[SOURCE_INITIAL]:initial};diagnose('LOADING_PROJECTION','Use a source-declared initial component layout; runtime changes remain unknown');}
      }
      if (value === UNKNOWN && ['class', 'style', 'width', 'height'].includes(key)) {
        value = evaluateString(expression(p.exp) ?? key, { ...ctx, defaultBranches: true });
        diagnose('LAYOUT_UNKNOWN', value === UNKNOWN ? `Cannot resolve :${key}; using a local fallback` : `Unknown :${key} condition: use the first static branch`);
        if (value === UNKNOWN) unknownLayout = true;
      }
      assign(p, key, value, projected);
    } else if (p.name === 'model') {
      if (!p.arg || p.arg.type === 4 && p.arg.isStatic) assign(p, p.arg?.content ?? 'modelValue', evaluateString(expression(p.exp) ?? '', ctx));
    } else if (p.name === 'show') {
      const responsive = this.viewportStyle(`({display:(${expression(p.exp) ?? 'true'})?'':'none'})`, ctx, node);
      if (responsive) { assign(p,'class',responsive.className); continue; }
      const condition=expression(p.exp)??'';const show = sourceCondition(parseSourceExpression(condition,ctx),{...ctx,code:condition}).value;
      const { projected } = loadingBranch(expression(p.exp) ?? '', ctx, (_root, present) => !present);
      if (projected) return '';
      if (show !== UNKNOWN && !show) return '';
    } else if (p.name === 'text') { textContent = true; textValue = evaluateString(expression(p.exp) ?? '', ctx); }
    else if (p.name === 'html') {
      const value = evaluateString(expression(p.exp) ?? '', ctx);
      if (typeof value !== 'string' || value.length > 32768) return this.fallback(ctx, node, 'Dynamic v-html content needs an adapter', props);
      htmlContent = value;
    }

  }
  return { props, values, notes, unknownLayout, htmlContent, textContent, textValue };
}

/** Resolve dynamic tags and dispatch the resulting component or native element. */
async function renderVueElement(
  this: RenderHost,
  source: ElementNode,
  ctx: RenderContext,
  selection: ReturnType<RenderHost['selectVueNode']>,
  attributes: VueAttributes,
): Promise<string> {
  let node = source;
  let { props, values, unknownLayout } = attributes;
  const { notes, htmlContent, textContent, textValue } = attributes;
  for(const directive of source.props) if(directive.type===7&&!['if','else','else-if','for','on','slot','model','once','memo','bind','show','text','html','pre','cloak'].includes(directive.name)) {
    const definition=await this.directiveSource(directive.name,ctx.module);
    const effects=definition?.fn?directiveEffects(definition.module,definition.fn,ctx,evaluateString(expression(directive.exp)??'',ctx)):undefined;
    const key=`v-${directive.name}.visible`,visibility=ctx.bindings[key];
    if(effects?.visibility&&typeof visibility==='boolean'){this.record('branch',key,'Use an explicitly declared directive visibility state; no permission store runs',ctx,source);if(!visibility)return'';continue;}
    if(!effects||effects.unknown||effects.visibility){const note=this.diagnose(effects?.visibility?'DIRECTIVE_VISIBILITY_UNKNOWN':'DIRECTIVE_UNKNOWN',`Custom directive v-${directive.name} ${effects?.visibility?'changes visibility; declare finite v-'+directive.name+'.visible variants':'has unresolved initial layout effects'}`,ctx,source);if(source.tag==='component'&&typeof props.is==='string')note.component=props.is;}
    else {if(Object.keys(effects.style).length)props.style=`${styleString(props.style)};${styleString(effects.style)}`;this.record('style',`v-${directive.name}`,effects.eventOnly?'Source-proven event-only directive does not alter initial layout':'Apply source-proven initial directive styles without running hooks or event handlers',ctx,source);}
  }
  const fallthrough = ctx.fallthrough;
  let tag = node.tag;
  for (;;) {
    // Replayed dynamic props are fresh. Merge root attrs after every replay,
    // retaining the original source node as the fallthrough owner.
    if (fallthrough && fallthrough.node === source) {
      for (const [key, value] of Object.entries(fallthrough.props)) {
        if (key === 'class' && props.class != null) props.class = [props.class, value];
        else if (key === 'style' && props.style != null) props.style = `${styleString(props.style)};${styleString(value)}`;
        else props[key] = value;
      }
    }
    ctx = this.contentContext(ctx, props, tag);
    if(liveElement(props)){
      this.diagnose('LIVE_CONTENT_IN_BOUNDARY','Keep this live region outside LoadingBoundary so its real content remains visible',ctx,node);
      return '';
    }
    if (ctx.module.boundaries.has(tag) || tag === 'loading-boundary') {
      const pending = node.props.find((p): p is DirectiveNode => p.type === 7 && p.name === 'bind' && p.arg?.type === 4 && p.arg.content === 'pending');
      const value = expression(pending?.exp);
      return this.vueNodes(node.children, boundaryContentContext(ctx, value, this.hints.state));
    }
    if (unknownGeometry(props.style)) unknownLayout = true;
    if (['template', 'transition', 'Transition', 'transition-group', 'TransitionGroup', 'KeepAlive', 'keep-alive'].includes(tag)) return this.vueNodes(node.children, ctx);
    if (tag === 'slot') {
      const name = typeof props.name === 'string' ? props.name : 'default';
      const argument={...props};delete argument.name;
      const initial={...argument};let projected=false;
      for(const p of node.props)if(p.type===7&&p.name==='bind'&&p.arg?.type===4&&p.arg.isStatic){const value=initialString(expression(p.exp)??p.arg.content,ctx);if(value!==UNKNOWN){initial[p.arg.content]=value;projected=true;}}
      return ctx.slots?.[name] ? this.renderSlot(ctx.slots[name], ctx,argument,projected?initial:UNKNOWN) : node.children.length ? this.vueNodes(node.children, ctx) : '';
    }
    if (tag === 'component') {
      const sourceRender = await this.sourceFunction(props.is, props, ctx, node);
      if (sourceRender !== undefined) return sourceRender;
      if (typeof props.is !== 'string' || !/^[a-zA-Z][\w-]*$/.test(props.is)) return this.fallback(ctx, node, 'Dynamic component requires a finite adapter', props);
      this.record('component', expression(node.props.find((p): p is DirectiveNode => p.type === 7 && p.arg?.type === 4 && p.arg.content === 'is')?.exp) ?? 'is', `Select static component ${props.is}`, ctx, node);
      tag = props.is;
      let tagType: ElementNode['tagType'] = 0;
      if (tag === 'slot') tagType = 2;
      else if (!parserOptions.isNativeTag!(tag)) tagType = 1;
      if (tagType === 1 && tag !== 'component') for (const note of notes) note.component = tag;
      node = { ...node, tag, tagType, props: node.props.filter(dynamicContentProp) } as ElementNode;
      if (this.selectVueNode(node, ctx) === 'skip') return '';
      const exhausted = renderBudget(this, node, ctx, 'template');
      if (exhausted !== undefined) return exhausted;
      values = values!.filter(entry => dynamicContentProp(entry.prop));
      const resolved = dynamicProps(this, values, node, ctx);
      props = resolved.props;
      unknownLayout ||= resolved.unknownLayout;
      continue;
    }
    break;
  }
  const imported = await this.componentReference(tag, ctx);
  if(unknownLayout&&selection!=='ancestor'&&!shallowPresentation(this,tag,imported))return this.fallback(ctx,node,'Unknown layout expression; add bindings or an adapter',props);
  if (node.tagType === 1 || imported?.file) this.record('component', tag, 'Resolve source component or adapter', ctx, node);
  if (imported?.file || this.target.adapters?.[tag]) {
    const slots: Record<string, SourceSlot> = {};
    const defaults: VueNode[] = [];
    for (const { node: child, slot, context } of expandedTemplateSlots(this,node.children,ctx)) {
      if (slot && child.type === 1){
        const name=slotName(this,slot,context,child);if(name!==undefined)slots[name] = { nodes: child.children, context, framework: 'vue',parameter:slotParameter(this,slot,context,child) };
      }
      else defaults.push(child);
    }
    if (defaults.length){const own=directive(node,['slot']),name=slotName(this,own,ctx,node);if(name!==undefined)slots[name]={nodes:defaults,context:ctx,framework:'vue',parameter:slotParameter(this,own,ctx,node)};}
    props.__skSlots = slots;
  }
  // Keep reference discovery (including native-name overrides and missing-file
  // dependencies), but plain native elements do not need component dispatch.
  if (node.tagType === 1 || imported || this.target.adapters?.[tag]) {
    const presentation = await renderComponent(this, tag, props, { nodes: node.children, context: ctx, framework: 'vue' }, node, imported);
    if (presentation !== undefined) return presentation;
  }
  if (node.tagType === 1) return this.fallback(ctx, node, `No source adapter for ${tag}`, props);
  if (nonVisual.has(tag)&&tag!=='iframe') return '';
  if (tag === 'img') return this.image(props, ctx, node);
  if(tag==='table'){
    const outline=await nativeTableOutline(this,props,{framework:'vue',nodes:node.children,context:ctx},node);
    if(outline!==undefined)return outline;
  }
  const graphic = renderAtomic(this, tag, props, ctx, node);
  if (graphic !== undefined) return graphic;
  const children = htmlContent !== undefined ? this.staticHTML(htmlContent, ctx, node)
    : tag === 'p' && this.masked(ctx) && this.hints.lines != null ? this.text(ctx, node, true)
    : textContent ? this.contentText(textValue, ctx, node) : await this.vueNodes(node.children, ctx);
  if (['div', 'section', 'article', 'main', 'canvas'].includes(tag) && Object.hasOwn(props, 'ref') && htmlContent === undefined && !textContent && node.children.every((child) => child.type === 3 || child.type === 2 && !child.content.trim())) {
    // An empty imperative mount host has no source-visible internal tree.
    // Mask only its existing box; do not invent widget-specific geometry.
    this.diagnose('FALLBACK', 'Opaque native mount point: preserve source container geometry', ctx, node, this.nodeId(ctx, node));
    return this.element(tag, props, '', ctx, node, { opaque: true, leaf: this.masked(ctx) });
  }
  return this.element(tag, props, children, ctx, node);
}
