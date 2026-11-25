import type * as t from '@babel/types';
import { isRenderFunction, nodeName } from './ast.js';
import { UNKNOWN, bindPattern, evaluate, type ExpressionContext, type Value } from './expression.js';

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
