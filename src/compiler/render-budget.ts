import type { Ast } from './expression.js';
import type { TemplateChildNode } from '@vue/compiler-dom';
import type { RenderContext } from './context.js';
import type { RenderHost } from './render-host.js';

export type RenderFrontend = 'jsx' | 'render' | 'template';

/** Weights are part of the finite-expansion contract, independent of delegation.
 * Vue expressions charge one unit for selection/calls and two for shared nodes.
 * A confirmed JSX h() adds its call unit after local/slot dispatch has declined it.
 * Keep that second checkpoint so exhaustion retains the same source node. */
export function renderBudget(
  host: RenderHost,
  node: Ast | TemplateChildNode,
  ctx: RenderContext,
  frontend: RenderFrontend,
  phase: 'node' | 'h' = 'node',
): string | undefined {
  if (phase === 'h') return frontend === 'jsx' ? host.budget(ctx, node) : undefined;
  const single = node.type === 'ConditionalExpression' || node.type === 'LogicalExpression'
    || node.type === 'ArrayExpression' || node.type === 'CallExpression'
    || node.type === 'OptionalCallExpression';
  return host.budget(ctx, node, frontend === 'render' && !single ? 2 : 1);
}
