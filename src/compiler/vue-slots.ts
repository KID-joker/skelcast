import type { DirectiveNode, TemplateChildNode as VueNode } from '@vue/compiler-dom';
import type { RenderContext } from './context.js';
import { evaluateString, parseSourceExpression } from './expression.js';
import type { RenderHost } from './render-host.js';

const syntax = new WeakMap<VueNode[], { node: VueNode; slot?: DirectiveNode; nodes: VueNode[] }[]>();

/** Share template classification, while resolving dynamic names per instance. */
export function templateSlots(nodes: VueNode[]) {
  let entries = syntax.get(nodes);
  if (!entries) {
    entries = nodes.map(node => {
      const slot = node.type === 1 && node.tag === 'template'
        ? node.props.find((prop): prop is DirectiveNode => prop.type === 7 && prop.name === 'slot') : undefined;
      return { node, slot, nodes: slot?.arg?.type === 4 && node.type === 1 ? node.children : [node] };
    });
    syntax.set(nodes, entries);
  }
  return entries;
}

export function slotName(host: RenderHost, slot: DirectiveNode | undefined, ctx: RenderContext, node: VueNode): string | undefined {
  if (!slot?.arg) return 'default';
  const name = slot.arg.type === 4 && slot.arg.isStatic ? slot.arg.content
    : evaluateString(slot.arg.type === 4 ? slot.arg.content : '', ctx);
  if (typeof name === 'string') return name;
  host.diagnose('SLOT_UNKNOWN', 'Dynamic slot name needs a finite source value', ctx, node);
}

export function slotParameter(host: RenderHost, slot: DirectiveNode | undefined, ctx: RenderContext, node: VueNode) {
  if (slot?.exp?.type !== 4 || !slot.exp.content) return;
  const fn = parseSourceExpression(`(${slot.exp.content})=>0`, ctx);
  if (fn?.type === 'ArrowFunctionExpression') return fn.params[0];
  host.diagnose('SLOT_UNKNOWN', 'Cannot parse scoped slot parameters', ctx, node);
}
