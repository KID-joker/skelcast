import type { Ast } from './expression.js';
import type { RenderContext } from './context.js';
import type { RenderHost } from './render-host.js';
import { renderJSXNode } from './render-node.js';

export async function renderJSX(this: RenderHost, node: Ast | null | undefined, ctx: RenderContext): Promise<string> {
  if (!node) return '';
  return this.budget(ctx, node) ?? renderJSXNode.call(this, node, ctx);
}
