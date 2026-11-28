import type { Ast } from './expression.js';
import type { RenderContext } from './context.js';
import type { RenderHost } from './render-host.js';
import { renderJSXNode } from './render-node.js';
import { renderBudget } from './render-budget.js';

export async function renderJSX(this: RenderHost, node: Ast | null | undefined, ctx: RenderContext): Promise<string> {
  if (!node) return '';
  return renderBudget(this, node, ctx, 'jsx') ?? renderJSXNode.call(this, node, ctx);
}
