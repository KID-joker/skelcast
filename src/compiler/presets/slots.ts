import type { RenderContext, SourceSlot } from '../context.js';
import type { RenderHost } from '../render-host.js';
import { templateSlots, slotName } from '../vue-slots.js';

/** Render in preset-declared order: nested table columns and evidence depend on
 * that order. Each frontend retains its existing slot/default rules. */
export async function renderPresetSlots(
  host: RenderHost,
  source: SourceSlot,
  names: readonly string[],
  ctx: RenderContext,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const templates = new Map<string, import('@vue/compiler-dom').TemplateChildNode[]>();
  if (source.framework === 'vue') for (const entry of templateSlots(source.nodes)) {
    const name = slotName(host, entry.slot, source.context, entry.node);
    if (name === undefined) continue;
    const group = templates.get(name);
    if (group) group.push(...entry.nodes); else templates.set(name, [...entry.nodes]);
  }
  for (const name of names) {
    switch (source.framework) {
      case 'render': {
        const slot = source.slots?.[name];
        result[name] = slot ? await host.renderSlot(slot, ctx)
          : name === 'default' ? await host.renderSlot(source, ctx) : '';
        break;
      }
      case 'jsx':
        result[name] = name === 'default' ? await host.jsxNodes(source.nodes, ctx) : '';
        break;
      case 'vue':
        result[name] = await host.vueNodes(templates.get(name) ?? [], ctx);
        break;
    }
  }
  return result;
}
