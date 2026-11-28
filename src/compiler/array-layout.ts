import type * as t from '@babel/types';
import { isRenderFunction, nodeName, walk } from './ast.js';

export interface ArrayLayout { children: string; defaults: Record<string, string | number | boolean | null> }
/** A finite shape projection, not execution of an async normalizer. Prove the
 * accumulator, recursive child traversal and leaf filter from source syntax. */
export function arrayLayout(fn: t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression, name?: string): ArrayLayout | undefined {
  if (!name) return;
  if (fn.async || fn.body.type !== 'BlockStatement' || fn.params[0]?.type !== 'Identifier' || fn.params[1]?.type !== 'AssignmentPattern' || fn.params[1].left.type !== 'Identifier' || fn.params[1].right.type !== 'ArrayExpression' || fn.params[1].right.elements.length) return;
  const input = fn.params[0].name, output = fn.params[1].left.name;
  const returned = fn.body.body.at(-1);
  if (returned?.type !== 'ReturnStatement' || returned.argument?.type !== 'CallExpression') return;
  const filter = returned.argument;
  if (filter.callee.type !== 'MemberExpression' || nodeName(filter.callee.object) !== output || nodeName(filter.callee.property) !== 'filter' || !isRenderFunction(filter.arguments[0])) return;
  const predicate = filter.arguments[0];
  if (predicate.params[0]?.type !== 'Identifier' || predicate.body.type !== 'UnaryExpression' || predicate.body.operator !== '!') return;
  const length = predicate.body.argument;
  if (length.type !== 'OptionalMemberExpression' || nodeName(length.property) !== 'length' || length.object.type !== 'MemberExpression' || nodeName(length.object.object) !== predicate.params[0].name) return;
  const children = nodeName(length.object.property); if (!children) return;
  const loop = fn.body.body[0];
  if (fn.body.body.length !== 2 || loop?.type !== 'ExpressionStatement' || loop.expression.type !== 'CallExpression') return;
  const call = loop.expression;
  if (call.callee.type !== 'MemberExpression' || nodeName(call.callee.object) !== input || nodeName(call.callee.property) !== 'forEach' || !isRenderFunction(call.arguments[0])) return;
  const callback = call.arguments[0];
  if (callback.params[0]?.type !== 'Identifier' || callback.body.type !== 'BlockStatement') return;
  const item = callback.params[0].name, defaults: ArrayLayout['defaults'] = {};
  let pushed = false, recursed = false, invalid = false;
  for (const statement of callback.body.body) {
    if (statement.type === 'IfStatement') {
      const test = statement.test, push = statement.consequent;
      if (test.type !== 'OptionalMemberExpression' || nodeName(test.property) !== 'length' || test.object.type !== 'MemberExpression' || nodeName(test.object.object) !== item || nodeName(test.object.property) !== children || push.type !== 'ExpressionStatement' || push.expression.type !== 'CallExpression') { invalid = true; break; }
      const value = push.expression;
      recursed = value.callee.type === 'MemberExpression' && nodeName(value.callee.object) === output && nodeName(value.callee.property) === 'push' && value.arguments[0]?.type === 'SpreadElement' && value.arguments[0].argument.type === 'CallExpression' && nodeName(value.arguments[0].argument.callee) === name && value.arguments[0].argument.arguments.length === 1 && value.arguments[0].argument.arguments[0]?.type === 'MemberExpression' && nodeName(value.arguments[0].argument.arguments[0].object) === item && nodeName(value.arguments[0].argument.arguments[0].property) === children;
      continue;
    }
    if (statement.type !== 'ExpressionStatement') { invalid = true; break; }
    const expression = statement.expression;
    if (expression.type === 'CallExpression' && expression.callee.type === 'MemberExpression' && nodeName(expression.callee.object) === output && nodeName(expression.callee.property) === 'push' && expression.arguments.length === 1 && nodeName(expression.arguments[0]) === item) { pushed = true; continue; }
    if (expression.type === 'AssignmentExpression' && expression.operator === '=' && expression.left.type === 'MemberExpression' && nodeName(expression.left.object) === item && expression.right.type === 'LogicalExpression' && expression.right.operator === '??' && expression.right.left.type === 'MemberExpression' && nodeName(expression.right.left.object) === item && nodeName(expression.right.left.property) === nodeName(expression.left.property)) {
      const value = expression.right.right, key = nodeName(expression.left.property);
      if (key && (value.type === 'BooleanLiteral' || value.type === 'StringLiteral' || value.type === 'NumericLiteral')) { defaults[key] = value.value; continue; }
    }
    // Awaited calls can change live fields. This recipe is exposed only as a
    // diagnostic-bearing initial presentation projection, never a live value.
    if (expression.type === 'AwaitExpression' && expression.argument.type === 'CallExpression') continue;
    invalid = true;
  }
  if (invalid || !pushed || !recursed) return;
  let extraWrite = false;
  walk(callback.body, n => { if (n.type === 'UpdateExpression') extraWrite = true; });
  return extraWrite ? undefined : { children, defaults };
}
