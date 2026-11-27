import path from 'node:path';
import { componentName } from './components.js';
import type { RenderContext, SourceNode, SourceSlot } from './context.js';
import type { Value } from './expression.js';
import type { ComponentReference } from './presets/types.js';
import type { RenderHost } from './render-host.js';

export async function renderAdapter(host: RenderHost, tag: string, props: Record<string, Value>, ctx: RenderContext, node: SourceNode): Promise<string | undefined> {
  const adapter = host.target.adapters?.[tag];
  if (!adapter) return;
  const file = path.resolve(host.root, adapter);
  await host.scan(file);
  return host.component(file, 'default', props, ctx, node);
}

/** Frontends retain their slot and adapter policies; source/preset dispatch is shared. */
export async function renderComponent(host: RenderHost, tag: string, reference: ComponentReference | undefined, props: Record<string, Value>, slot: SourceSlot, node: SourceNode): Promise<string | undefined> {
  const ctx = slot.context;
  if (reference?.file && (slot.framework === 'render' || /\.(vue|tsx|jsx|ts|js)$/.test(reference.file))) {
    return host.component(reference.file, reference.exported, props, ctx, node);
  }
  if (slot.framework === 'jsx' && ctx.module.functions.has(tag)) {
    const local = { ...ctx, env: { ...ctx.env }, depth: ctx.depth + 1 };
    if (local.depth > 16) return host.fallback(ctx, node, 'Component recursion limit reached');
    const body = host.prepareFunction(ctx.module.functions.get(tag), local, props);
    return body ? host.jsx(body, local) : host.fallback(ctx, node, `Cannot expand ${tag}`);
  }
  if (slot.framework === 'vue' && componentName(tag) === 'routerlink') {
    return host.element('a', props, await host.vueNodes(slot.nodes, ctx), ctx, node);
  }
  return host.preset(tag, reference, props, slot, node);
}
