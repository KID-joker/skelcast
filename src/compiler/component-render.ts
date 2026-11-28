import path from 'node:path';
import { componentName } from './components.js';
import type { SourceNode, SourceSlot } from './context.js';
import type { Value } from './expression.js';
import type { ComponentReference } from './presets/types.js';
import type { RenderHost } from './render-host.js';

/** Keep frontend policies together: JSX/templates accept explicit adapters;
 * h() retains its source/preset path. Vue callers resolve references for slots. */
export async function renderComponent(host: RenderHost, tag: string, props: Record<string, Value>, slot: SourceSlot, node: SourceNode, reference?: ComponentReference): Promise<string | undefined> {
  const ctx = slot.context;
  const adapter = slot.framework !== 'render' ? host.target.adapters?.[tag] : undefined;
  if (adapter) {
    const file = path.resolve(host.root, adapter);
    await host.scan(file);
    return host.component(file, 'default', props, ctx, node);
  }
  if (slot.framework === 'jsx') reference = await host.componentReference(tag, ctx);
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
