import { nodeName } from './ast.js';
import type { ModuleInfo } from './context.js';
import { UNKNOWN, SOURCE_INITIAL, SOURCE_ARRAY_LAYOUT, SOURCE_FIELDS, bindPattern, evaluate, expressionText, sourceCapacity, type ExpressionContext, type Value } from './expression.js';
import type * as t from '@babel/types';
import { initialExpression } from './initial-state.js';

function captureInitial(pattern: t.Node, value: Value, facts: Record<string, Value>): void {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, SOURCE_INITIAL)) return;
  const initial = (value as { [SOURCE_INITIAL]: Value })[SOURCE_INITIAL];
  if (pattern.type === 'Identifier') facts[pattern.name] = initial;
  if (pattern.type === 'ObjectPattern' && initial && typeof initial === 'object') for (const property of pattern.properties) {
    const key = property.type === 'ObjectProperty' && !property.computed ? nodeName(property.key) : undefined;
    if (key && property.type === 'ObjectProperty' && Object.hasOwn(initial, key)) captureInitial(property.value, { [SOURCE_INITIAL]: (initial as Record<string, Value>)[key] }, facts);
  }
}

/** Module facts are shared; only instance bindings are written into this environment. */
export function bindSetupDeclarations(module: ModuleInfo, sourceValues: Record<string, Value>, context: ExpressionContext): void {
  for (const declaration of module.setupDeclarations) {
    const name = declaration.id.type === 'Identifier' ? declaration.id.name : undefined;
    const init = declaration.init;
    if (name && Object.hasOwn(context.bindings, name)) { context.env[name] = context.bindings[name]; continue; }
    if (name && Object.hasOwn(sourceValues, name)) {
      const source = sourceValues[name];
      if (source && typeof source === 'object' && (Object.hasOwn(source, SOURCE_ARRAY_LAYOUT) || Object.hasOwn(source, SOURCE_FIELDS))) { context.env[name] = source; continue; }
      const capacity = sourceCapacity(source) != null;
      const opaque = source === UNKNOWN && ['ObjectExpression', 'ArrayExpression', 'Identifier'].includes(init?.type ?? '');
      const literal = source !== UNKNOWN && init && ['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral'].includes(init.type)
        && !Object.hasOwn(context.bindings, expressionText(init, context));
      if (capacity || opaque || literal) {
        context.env[name] = source;
        continue;
      }
    }
    const expression = declaration.id.type === 'ObjectPattern' && init?.type === 'CallExpression' && nodeName(init.callee) === 'toRefs'
      ? init.arguments[0] : init;
    const value = evaluate(expression, context);
    if (context.initialValues) captureInitial(declaration.id, value, context.initialValues);
    if (name && Array.isArray(value) && context.initialValues) context.initialValues[name] = value;
    if (name && expression && context.initialValues && value === UNKNOWN) {
      const initial = initialExpression(expression, context);
      if (initial !== UNKNOWN) context.initialValues[name] = initial;
    }
    const fallback = name ? module.env[name] : undefined;
    bindPattern(declaration.id, value === UNKNOWN && sourceCapacity(fallback) != null ? fallback : value, context.env);
  }
}
