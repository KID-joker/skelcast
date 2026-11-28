import type { RenderContext, SourceSlot } from '../context.js';
import type { RenderHost } from '../render-host.js';
import { expandedTemplateSlots, slotName, slotParameter } from '../vue-slots.js';

/** Render in preset-declared order: nested table columns and evidence depend on
 * that order. Each frontend retains its existing slot/default rules. */
export async function renderPresetSlots(
  host: RenderHost,
  source: SourceSlot,
  names: readonly string[],
  ctx: RenderContext,
  argument: unknown = {},
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const templates = new Map<string, SourceSlot[]>();
  if (source.framework === 'vue') for (const entry of expandedTemplateSlots(host,source.nodes,source.context)) {
    const name = slotName(host, entry.slot, entry.context, entry.node);
    if (name === undefined) continue;
    const slot:SourceSlot={framework:'vue',context:entry.context,nodes:entry.nodes,parameter:slotParameter(host,entry.slot,entry.context,entry.node)};
    const group = templates.get(name);
    if (group) group.push(slot); else templates.set(name, [slot]);
  }
  for (const name of names) {
    switch (source.framework) {
      case 'render': {
        const slot = source.slots?.[name];
        result[name] = slot ? await host.renderSlot(slot, ctx, argument)
          : name === 'default' ? await host.renderSlot(source, ctx) : '';
        break;
      }
      case 'jsx':
        result[name] = name === 'default' ? await host.jsxNodes(source.nodes, ctx) : '';
        break;
      case 'vue':
        const selected=templates.get(name)??[];
        if(selected.every(slot=>!slot.parameter&&slot.context===source.context))result[name]=await host.vueNodes(selected.flatMap(slot=>slot.nodes as import('@vue/compiler-dom').TemplateChildNode[]),ctx);
        else {result[name]='';for(const slot of selected)result[name]+=await host.renderSlot(slot,ctx,argument);}
        break;
    }
  }
  return result;
}
