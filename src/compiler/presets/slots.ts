import type { DirectiveNode, TemplateChildNode } from '@vue/compiler-dom';
import type { RenderContext, SourceSlot } from '../context.js';
import type { RenderHost } from '../render-host.js';

function templateSlotNodes(nodes: TemplateChildNode[], name: string): TemplateChildNode[] {
  return nodes.flatMap(node => {
    const slot = node.type === 1 && node.tag === 'template'
      ? node.props.find((prop): prop is DirectiveNode => prop.type === 7 && prop.name === 'slot')
      : undefined;
    if (slot?.arg?.type === 4 && node.type === 1) return slot.arg.content === name ? node.children : [];
    return name === 'default' ? [node] : [];
  });
}

/** Render in preset-declared order: nested table columns and evidence depend on
 * that order. Each frontend retains its existing slot/default rules. */
export async function renderPresetSlots(
  host: RenderHost,
  source: SourceSlot,
  names: readonly string[],
  ctx: RenderContext,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
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
        result[name] = await host.vueNodes(templateSlotNodes(source.nodes, name), ctx);
        break;
    }
  }
  return result;
}
