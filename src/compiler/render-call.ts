import type * as t from '@babel/types';
import { isRenderFunction, nodeName } from './ast.js';
import { UNKNOWN, SOURCE_RENDER_FILE, evaluate, expressionText, type Ast } from './expression.js';
import { slotValue, type RenderContext, type SourceSlot } from './context.js';
import { nonVisual, unknownGeometry } from './html.js';
import type { RenderHost } from './render-host.js';
import { renderSlotCall } from './regions.js';
import { renderComponent } from './component-render.js';
import { localRenderFunction, prepareLocalRenderCall } from './branches.js';
import { vueHelper, supportedBody } from './vue-syntax.js';
import { renderBudget } from './render-budget.js';
import { renderAtomic } from './output.js';
import { nativeTableOutline, shallowPresentation } from './outline.js';
import { liveElement } from '../policy.js';

async function renderLocalCall(this:RenderHost,node:t.CallExpression,ctx:RenderContext,value:unknown):Promise<string|undefined>{
  const fn = localRenderFunction(value);
  if(!fn)return;
  if (value && typeof value === 'object' && Object.hasOwn(value,SOURCE_RENDER_FILE) && (value as {[SOURCE_RENDER_FILE]:string})[SOURCE_RENDER_FILE]!==ctx.module.file) return this.sourceFunction(value, node.arguments[0] ? evaluate(node.arguments[0],ctx) as Record<string,unknown> : {}, ctx, node);
  if(ctx.depth>16||node.arguments.some(a=>a.type==='SpreadElement'))return this.fallback(ctx,node,'Local source render recursion or arguments exceed the finite limit');
  const { local, body } = prepareLocalRenderCall(this, fn, node, ctx);
  return body?.type==='CallExpression'&&vueHelper(ctx.module,body.callee,'h')?this.vueExpression(body,local):this.jsx(body,local);
}

/** Classify a call once, then render it directly instead of crossing frontends. */
export async function renderCall(this: RenderHost, node: t.CallExpression | t.OptionalCallExpression, ctx: RenderContext, framework: 'jsx' | 'render'): Promise<string> {
  const calleeValue = evaluate(node.callee, ctx);
  if (node.type === 'CallExpression') {
    const local = await renderLocalCall.call(this, node, ctx, calleeValue);
    if (local !== undefined) return local;
  }
  const slot = await renderSlotCall(this, node, ctx, calleeValue);
  if (slot !== undefined) return slot;
  if (ctx.dataSlot && !vueHelper(ctx.module, node.callee, 'h')) {
    this.diagnose('PRESET_LIMIT', 'Unresolved table data-slot call uses a text placeholder; custom return geometry remains unknown', ctx, node);
    return this.contentText(evaluate(node, ctx), ctx, node);
  }
  if (node.type === 'OptionalCallExpression') return framework === 'render'
    ? calleeValue == null && node.optional ? '' : this.fallback(ctx, node, 'Unresolved optional render call needs a finite binding')
    : this.fallback(ctx, node, `Unknown render call: ${expressionText(node.callee, ctx)}`);
  if (!vueHelper(ctx.module, node.callee, 'h')) return this.fallback(ctx, node, `Unknown render call: ${expressionText(node.callee, ctx)}`);
  const exhausted = renderBudget(this, node, ctx, framework, 'h');
  if (exhausted !== undefined) return exhausted;
  const tagNode = node.arguments[0];
  const name = (value: Ast | undefined): string | undefined => value?.type === 'MemberExpression' && !value.computed ? `${name(value.object)}.${nodeName(value.property)}` : value ? nodeName(value) : undefined;
  const tagValue = evaluate(tagNode, ctx);
  const native = typeof tagValue === 'string';
  const tag = native ? tagValue : name(tagNode);
  if (!tag || !/^[\w.-]+$/.test(tag)) return this.fallback(ctx, node, 'Dynamic h() component needs a finite binding or adapter');
  if (native && tag.includes('-')) return this.fallback(ctx, node, 'Custom elements need an inert source adapter');
  const propsNode = node.arguments[1];
  const childNode = node.arguments.length > 2 ? node.arguments[2] : propsNode && (propsNode.type === 'ArrayExpression' || propsNode.type === 'StringLiteral' || propsNode.type === 'CallExpression' && vueHelper(ctx.module, propsNode.callee, 'h')) ? propsNode : undefined;
  const value = propsNode && propsNode !== childNode && propsNode.type !== 'NullLiteral' ? evaluate(propsNode, ctx) : {};
  if (!value || value === UNKNOWN || typeof value !== 'object' || Array.isArray(value)) return this.fallback(ctx, node, 'Unresolved h() props need a finite binding');
  const props: Record<string, unknown> = { ...value };
  if(liveElement(props)){
    this.diagnose('LIVE_CONTENT_IN_BOUNDARY','Keep this live region outside LoadingBoundary so its real content remains visible',ctx,node);
    return '';
  }
  if (propsNode?.type === 'ObjectExpression') for (const prop of propsNode.properties) if (prop.type === 'SpreadElement' && evaluate(prop.argument, ctx) === UNKNOWN) this.diagnose('SPREAD_UNKNOWN', 'Unresolved h() spread props may affect layout', ctx, prop);
  const local = this.contentContext(ctx, props, native ? tag : '');
  const ref=!native?await this.componentReference(tag,ctx):undefined;
  if ((unknownGeometry(props.style) || ['class', 'style', 'width', 'height'].some(key => props[key] === UNKNOWN))&&!shallowPresentation(this,tag,ref)&&!Object.values(ctx.slots??{}).some(slot=>this.hasSelectedSlot(slot))) return this.fallback(local, node, 'Unresolved h() layout props', props);
  const slots: Record<string, SourceSlot> = {};
  const forward=(value:unknown)=>{
    if(!value||value===UNKNOWN||typeof value!=='object'||Array.isArray(value))return false;
    for(const [key,slot]of Object.entries(value)){
      if(!slot||typeof slot!=='object'||!Object.hasOwn(slot,slotValue))return false;
      slots[key]=(slot as {[slotValue]:SourceSlot})[slotValue];
    }
    return true;
  };
  if (childNode?.type === 'ObjectExpression') {
    for (const property of childNode.properties) {
      if(property.type==='SpreadElement'){
        if(!forward(evaluate(property.argument,ctx)))return this.fallback(local,node,'Unresolved forwarded h() slots need an adapter');
        continue;
      }
      if(property.type==='ObjectProperty'&&!property.computed){
        const value=evaluate(property.value,ctx),key=nodeName(property.key);
        if(key&&value&&typeof value==='object'&&Object.hasOwn(value,slotValue)){slots[key]=(value as {[slotValue]:SourceSlot})[slotValue];continue;}
      }
      if (property.type !== 'ObjectProperty' || property.computed || !isRenderFunction(property.value) || property.value.params.length>1 || property.value.async || !supportedBody(property.value.body)) return this.fallback(local, node, 'Dynamic/scoped h() slots need an adapter');
      const key = nodeName(property.key);
      const slotContext = { ...local, env: { ...local.env } };
      if (key) slots[key] = { framework: 'render', nodes: [], context: slotContext,parameter:property.value.params[0],renderFunction:property.value };
    }
  } else if (childNode && !forward(evaluate(childNode,ctx))) slots.default = { framework: 'render', nodes: [childNode], context: local };
  const children = async () => slots.default ? this.renderSlot(slots.default, local) : '';
  if (!native) {
    if (vueHelper(ctx.module, tagNode!, 'Fragment')) return children();
    props.__skSlots = slots;
    const presentation = await renderComponent(this, tag, props, { framework: 'render', nodes: [], slots, context: local }, node, ref);
    if (presentation !== undefined) return presentation;
    return this.fallback(local, node, `No source adapter for ${tag}`, props);
  }
  if (nonVisual.has(tag)&&tag!=='iframe') return '';
  if (tag === 'img') return this.image(props, local, node);
  if(tag==='table'){
    const outline=await nativeTableOutline(this,props,{framework:'render',nodes:childNode?[childNode]:[],context:local},node);
    if(outline!==undefined)return outline;
  }
  const graphic = renderAtomic(this, tag, props, local, node);
  if (graphic !== undefined) return graphic;
  if (Object.hasOwn(props, 'innerHTML')) return typeof props.innerHTML === 'string' ? this.element(tag, props, this.staticHTML(props.innerHTML, local, node), local, node) : this.fallback(local, node, 'Unknown h() innerHTML needs a finite binding');
  const content = Object.hasOwn(props, 'textContent') ? this.contentText(props.textContent, local, node) : await children();
  const opaque = !content && ['div', 'section', 'article', 'main', 'canvas'].includes(tag) && Object.hasOwn(props, 'ref');
  const html = this.element(tag, props, content, local, node, { opaque, leaf: opaque && this.masked(local) });
  if (opaque) {
    this.diagnose('FALLBACK', 'Opaque native mount point: preserve source container geometry', local, node);
  }
  return html;
}
