import path from 'node:path';
import { componentName } from './components.js';
import type { SourceNode, SourceSlot } from './context.js';
import type { Value } from './expression.js';
import type { ComponentReference } from './presets/types.js';
import type { RenderHost } from './render-host.js';
import { isRenderFunction } from './ast.js';
import { supportedBody, visualSyntax } from './vue-syntax.js';
import { importedPolicy, configuredPolicy } from '../policy.js';
import { styleString } from './html.js';
import { dimension } from './presets/shared.js';

/** Keep frontend policies together: JSX/templates accept explicit adapters;
 * h() retains its source/preset path. Vue callers resolve references for slots. */
export async function renderComponent(host: RenderHost, tag: string, props: Record<string, Value>, slot: SourceSlot, node: SourceNode, reference?: ComponentReference): Promise<string | undefined> {
  const ctx = slot.context;
  reference ??= await host.componentReference(tag, ctx);
  const policy = configuredPolicy(host.options.componentPolicies,tag) ?? (reference && importedPolicy(reference.request, reference.exported));
  if (policy === 'live') {
    host.diagnose('LIVE_CONTENT_IN_BOUNDARY', `Keep ${tag} outside LoadingBoundary so the real component remains visible; static preserve cannot retain a live widget`, ctx, node);
    return '';
  }
  if (policy === 'graphic' && host.masked(ctx)) {
    host.record('component', tag, 'Use graphic container outline without expanding the widget', ctx, node);
    const dimensions=['width','height'].flatMap(key=>{const value=dimension(props[key],'');return value?[`${key}:${value}`]:[];});
    if(host.hints.minHeight!=null)dimensions.push(`min-height:${host.hints.minHeight}px`);
    return host.element('div', {...props,class:[props.class??props.className,'sk-graphic-outline'],className:undefined,style:[...dimensions,styleString(props.style)].join(';')}, '', ctx, node, {layout:true,leaf:true,outline:true});
  }
  const adapter = slot.framework !== 'render' ? host.target.adapters?.[tag] : undefined;
  if (adapter) {
    const file = path.resolve(host.root, adapter);
    await host.scan(file);
    return host.component(file, 'default', props, ctx, node);
  }
  reference ??= await host.componentReference(tag, ctx);
  if (reference?.file && (slot.framework === 'render' || /\.(vue|tsx|jsx|ts|js)$/.test(reference.file))) {
    return host.component(reference.file, reference.exported, props, ctx, node);
  }
  if (ctx.module.functions.has(tag)) {
    const fn = ctx.module.functions.get(tag);
    if (!isRenderFunction(fn) || fn.async || fn.generator || !supportedBody(fn.body)) return;
    const visual = visualSyntax(ctx.module, fn.body);
    if (!visual.jsx && !visual.h) return;
    const local = { ...ctx, env: { ...ctx.env }, depth: ctx.depth + 1 };
    if (local.depth > 16) return host.fallback(ctx, node, 'Component recursion limit reached');
    const body = host.prepareFunction(fn, local, props);
    return body ? host.vueExpression(body, local) : host.fallback(ctx, node, `Cannot expand ${tag}`);
  }
  if (slot.framework === 'vue' && componentName(tag) === 'routerlink') {
    return host.element('a', props, await host.vueNodes(slot.nodes, ctx), ctx, node);
  }
  return host.preset(tag, reference, props, slot, node);
}
