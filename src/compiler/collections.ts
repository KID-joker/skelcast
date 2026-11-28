import { hasStateBinding } from './branches.js';
import type { RenderContext, SourceNode } from './context.js';
import { sourceCapacity, type Value } from './expression.js';
import { collectionEmpty, collectionRoot, projectsCollection, repeatCapacity } from './loading-state.js';
import type { RenderHost } from './render-host.js';

/** Frontends supply their finite source length; loading policy and diagnostics
 * are shared without changing framework-specific item/key binding. */
export function planCollection(
  host: RenderHost,
  text: string,
  list: Value,
  ctx: RenderContext,
  node: SourceNode,
  length = Array.isArray(list) ? list.length : undefined,
  response = 'response count',
) {
  const bound = sourceCapacity(list);
  const root = collectionRoot(text, ctx);
  const boundState = hasStateBinding(text, ctx);
  const projected = !boundState && projectsCollection(root, ctx) && collectionEmpty(root, ctx);
  let count = host.hints.repeat;
  if (count == null) {
    if (projected) count = repeatCapacity(text, ctx);
    else if (bound != null) count = Math.min(24, bound);
    else count = length == null ? 4 : Math.min(256, length);
  }
  if(host.hints.repeat==null&&bound==null&&length!=null&&length>256)host.diagnose('COLLECTION_LIMIT','Finite source collection exceeds the 256-item expansion budget; remaining items are omitted',ctx,node);
  if (bound != null) host.diagnose('LOADING_PROJECTION', 'Use a representative source collection bound; later mutations, result count and item values remain unknown', ctx, node);
  if (projected) host.diagnose('LOADING_PROJECTION', `Render ${count} masked source items; this is loading capacity, not a ${response}`, ctx, node);
  if (host.target.kind === 'request' && host.hints.state !== 'source' && count === 0 && !boundState) {
    host.diagnose('EMPTY_STATE', 'Source-default collection is empty; declare a finite populated/empty variant when needed', ctx, node);
  }
  host.record('repeat', text, `Generate ${count} placeholders`, ctx, node);
  return { count, projected };
}
