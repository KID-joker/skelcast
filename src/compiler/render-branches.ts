import type * as t from '@babel/types';
import { nodeName, walk } from './ast.js';
import { UNKNOWN, evaluate, expressionText, type Ast } from './expression.js';
import type { RenderContext } from './context.js';
import type { RenderHost } from './render-host.js';
import { collectionRootNode, loadingBranch, projectCollection } from './loading-state.js';

const collectionCache = new WeakMap<Ast, Ast[]>();
/** Cache syntax only; receiver paths still use the current source context. */
function collectionSources(node: Ast): Ast[] {
  const previous = collectionCache.get(node);
  if (previous) return previous;
  const sources: Ast[] = [];
  walk(node, n => {
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && nodeName(n.callee.property) === 'map') sources.push(n.callee.object);
  });
  collectionCache.set(node, sources);
  return sources;
}
const repeatedContent = (node: Ast): boolean => collectionSources(node).length > 0;
const hasCollection = (node: Ast, root: string): boolean =>
  collectionSources(node).some(source => collectionRootNode(source) === root);

/** Share expression selection, retaining frontend diagnostics and loading rules.
 * Expansion accounting belongs to the caller, before entering this helper. */
export async function renderBranch(
  this: RenderHost,
  node: t.ConditionalExpression | t.LogicalExpression | t.ArrayExpression,
  ctx: RenderContext,
  framework: 'jsx' | 'render',
): Promise<string> {
  const render = (node: Ast | null | undefined) => framework === 'jsx' ? this.jsx(node, ctx) : this.vueExpression(node, ctx);
  if (node.type === 'ArrayExpression') {
    if (framework === 'jsx') return this.jsxNodes(node.elements, ctx);
    let html = '';
    for (const child of node.elements) html += await render(child);
    return html;
  }
  if (node.type === 'ConditionalExpression') {
    let test = evaluate(node.test, ctx);
    if (framework === 'jsx') {
      const text = expressionText(node.test, ctx);
      const { boundState, projected } = loadingBranch(text, ctx, root => hasCollection(node.consequent, root) || hasCollection(node.alternate, root));
      if (projected) {
        test = projected.present;
        ctx = projectCollection(ctx, projected.root);
        this.diagnose('LOADING_PROJECTION', 'Render the source collection template for loading; response values remain unknown', ctx, node);
      }
      if (this.target.kind === 'request' && this.hints.state !== 'source' && test !== UNKNOWN && !boundState && repeatedContent(test ? node.alternate : node.consequent) && !repeatedContent(test ? node.consequent : node.alternate)) this.diagnose('EMPTY_STATE', 'Source-default branch excludes repeated request content; declare a finite populated/empty variant when needed', ctx, node);
      this.record('branch', text, test === UNKNOWN ? 'Default to consequent; override with bindings' : `Resolved to ${!!test}`, ctx, node);
      if (test === UNKNOWN) this.diagnose('BRANCH_DEFAULT', 'Unknown condition: chose consequent; supply bindings to select a branch', ctx, node);
    } else if (test === UNKNOWN) this.diagnose('BRANCH_DEFAULT', 'Unknown render condition; chose consequent', ctx, node);
    return render(test === UNKNOWN || test ? node.consequent : node.alternate);
  }
  let left = evaluate(node.left, ctx);
  if (framework === 'jsx') {
    const { projected } = loadingBranch(expressionText(node.left, ctx), ctx, (root, present) => node.operator === '&&' && (!present || hasCollection(node.right, root)));
    if (projected) left = projected.present;
  }
  if (left === UNKNOWN) {
    if (framework === 'jsx') this.record('branch', expressionText(node.left, ctx), 'Include optional content by default', ctx, node);
    else this.diagnose('BRANCH_DEFAULT', 'Unknown render guard; include optional content', ctx, node);
    return render(node.right);
  }
  if (node.operator === '&&') return left ? render(node.right) : '';
  return render(left != null && (node.operator === '??' || left) ? node.left : node.right);
}
