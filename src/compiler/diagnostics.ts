import type { ElementNode } from '@vue/compiler-dom';
import type { Diagnostic } from '../types.js';
import { nodeName } from './ast.js';
import { UNKNOWN, evaluate, expressionText, parseSourceExpression, type Ast } from './expression.js';
import type { RenderContext, SourceNode } from './context.js';

/** Capture repair context while the original AST and expression environment exist. */
export function diagnosticDetails(ctx: RenderContext, source?: SourceNode): Pick<Diagnostic, 'expression' | 'component' | 'bindingExamples'> {
  if (!source || !('type' in source)) return {};
  const examples: Record<string, unknown> = Object.create(null);
  const example = (key: string): unknown => {
    const layout: Record<string, unknown> = { display: 'grid', position: 'relative', transform: 'none', flex: 1, flexDirection: 'row', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gridTemplateRows: 'auto', aspectRatio: '4 / 3', gap: 16, padding: 16, margin: 16 };
    return Object.hasOwn(layout, key) ? layout[key] : /class/i.test(key) ? 'your-layout-class' : key === 'style' ? { width: 320, minHeight: 96 } : /height/i.test(key) ? 96 : 320;
  };
  const inspect = (node: Ast | null | undefined, key: string, context = ctx): void => {
    if (!node) return;
    if (node.type === 'ObjectExpression') {
      for (const property of node.properties) {
        if (property.type === 'ObjectProperty') inspect(property.value, nodeName(property.key) ?? key, context);
      }
      return;
    }
    if (evaluate(node, context) !== UNKNOWN) return;
    const text = expressionText(node, context);
    if (text) {
      const candidate = evaluate(node, { ...context, defaultBranches: true });
      examples[text] = candidate === UNKNOWN ? example(key) : candidate;
    }
  };
  const start = source.start ?? source.loc?.start.offset;
  const end = source.end ?? source.loc?.end?.offset;
  let expression = start != null && end != null ? ctx.code.slice(start, end).slice(0, 1200) : undefined;
  let component: string | undefined;
  if (typeof source.type === 'string') {
    const node = source as Ast;
    const attributes = node.type === 'JSXElement' ? node.openingElement.attributes : node.type === 'JSXAttribute' ? [node] : [];
    if (node.type === 'JSXElement') {
      const tag = nodeName(node.openingElement.name);
      if (tag && (/^[A-Z]/.test(tag) || tag.includes('-'))) component = tag;
      expression = expressionText(node.openingElement, ctx);
    }
    for (const attribute of attributes) {
      if (attribute.type !== 'JSXAttribute' || attribute.value?.type !== 'JSXExpressionContainer') continue;
      const key = nodeName(attribute.name) ?? '';
      if (['className', 'style', 'width', 'height'].includes(key)) inspect(attribute.value.expression, key);
    }
  } else if (source.type === 1) {
    const node = source as ElementNode;
    if (node.tagType === 1 && node.tag !== 'component') component = node.tag;
    for (const property of node.props) {
      if (property.type !== 7 || property.name !== 'bind' || property.arg?.type !== 4 || property.exp?.type !== 4) continue;
      const key = property.arg.content;
      if (!['class', 'style', 'width', 'height'].includes(key)) continue;
      try {
        inspect(parseSourceExpression(property.exp.content, ctx), key, { ...ctx, code: property.exp.content });
      } catch { /* malformed expressions keep their source diagnostic */ }
    }
  }
  return { expression, ...(component ? { component } : {}), ...(Object.keys(examples).length ? { bindingExamples: examples } : {}) };
}
