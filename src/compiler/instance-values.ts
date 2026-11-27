import { nodeName } from './ast.js';
import type { ModuleInfo } from './context.js';
import { UNKNOWN, bindPattern, evaluate, expressionText, sourceCapacity, type ExpressionContext, type Value } from './expression.js';

/** Module facts are shared; only instance bindings are written into this environment. */
export function bindSetupDeclarations(module: ModuleInfo, sourceValues: Record<string, Value>, context: ExpressionContext): void {
  for (const declaration of module.setupDeclarations) {
    const name = declaration.id.type === 'Identifier' ? declaration.id.name : undefined;
    const init = declaration.init;
    if (name && Object.hasOwn(sourceValues, name)) {
      const source = sourceValues[name];
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
    const fallback = name ? module.env[name] : undefined;
    bindPattern(declaration.id, value === UNKNOWN && sourceCapacity(fallback) != null ? fallback : value, context.env);
  }
}
