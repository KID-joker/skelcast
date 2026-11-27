import type * as t from '@babel/types';
import { isRenderFunction, nodeName, walk } from './ast.js';
import { UNKNOWN, bindPattern, evaluate, parseSourceExpression, type ExpressionContext, type Value } from './expression.js';
import type { SkeletonHints } from '../types.js';
import type { RenderContext } from './context.js';

/** Explicit state bindings also count when they name an input to a condition. */
export function hasStateBinding(text: string, context: ExpressionContext): boolean {
  if (Object.hasOwn(context.bindings, text)) return true;
  let found = false;
  try {
    walk(parseSourceExpression(text, context), (node, ancestors) => {
      const parent = ancestors.at(-1);
      if (node.type === 'Identifier' && parent?.type === 'MemberExpression' && !parent.computed && parent.property === node) return;
      if (node.type === 'Identifier' || node.type === 'MemberExpression') if (Object.hasOwn(context.bindings, text.slice(node.start!, node.end!))) found = true;
    });
  } catch { /* Opaque expressions require an exact binding. */ }
  return found;
}

export function loadingFrame(state: SkeletonHints['state'], fallback: boolean): boolean {
  return state === 'loading' || state !== 'source' && fallback;
}

/** Nested boundaries contribute their content branch to a page skeleton. Selected
 * Vue regions may inherit loading when pending is absent; other boundaries do not. */
export function boundaryContentContext(context: RenderContext, pending: string | undefined, state: SkeletonHints['state'], fallbackLoading = false): RenderContext {
  const loading = loadingFrame(state, pending ? pending !== 'false' : fallbackLoading);
  if (!pending) return { ...context, loading };
  const bindings = { ...context.bindings, [pending]: false };
  try {
    let expression = parseSourceExpression(pending, context);
    let value = false;
    while (expression?.type === 'UnaryExpression' && expression.operator === '!') {
      expression = expression.argument;
      value = !value;
      bindings[pending.slice(expression.start!, expression.end!)] = value;
    }
  } catch { /* An opaque pending expression remains a single finite binding. */ }
  return { ...context, bindings, loading };
}

function branchReturn(branch: t.Statement | null | undefined): t.ReturnStatement | undefined {
  if (branch?.type === 'ReturnStatement') return branch;
  if (branch?.type === 'BlockStatement') return branch.body.find(node => node.type === 'ReturnStatement');
}

/** Bind presentation props and select a supported return without calling business code. */
export function prepareRenderFunction(
  fn: t.Node | undefined,
  context: ExpressionContext,
  props: Record<string, Value>,
  unknownGuard: (node: t.Expression) => void,
): t.Expression | undefined {
  if (!isRenderFunction(fn)) return;
  const parameter = fn.params[0];
  bindPattern(parameter, props, context.env);
  if (parameter?.type === 'ObjectPattern') {
    for (const property of parameter.properties) {
      if (property.type !== 'ObjectProperty' || property.value.type !== 'AssignmentPattern') continue;
      const key = nodeName(property.key);
      if (key != null && (!Object.hasOwn(props, key) || props[key] === UNKNOWN)) {
        bindPattern(property.value.left, evaluate(property.value.right, context), context.env);
      }
    }
  }
  if (fn.body.type !== 'BlockStatement') return fn.body;
  for (const statement of fn.body.body) {
    if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations) {
        bindPattern(declaration.id, evaluate(declaration.init, context), context.env);
      }
    }
    if (statement.type === 'ReturnStatement') return statement.argument ?? undefined;
    if (statement.type !== 'IfStatement') continue;
    const condition = evaluate(statement.test, context);
    if (condition === UNKNOWN) {
      unknownGuard(statement.test);
      continue;
    }
    const returned = branchReturn(condition ? statement.consequent : statement.alternate);
    if (returned) return returned.argument ?? undefined;
  }
}
