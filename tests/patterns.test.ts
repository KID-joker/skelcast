import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExpression } from '@babel/parser';
import { prepareRenderFunction } from '../src/compiler/branches.js';
import { bindPattern, evaluateString, UNKNOWN, type Value } from '../src/compiler/expression.js';
import { bindSlotArgument } from '../src/compiler/regions.js';
import type { RenderContext } from '../src/compiler/context.js';

function parameter(source: string) {
  const fn = parseExpression(`(${source}) => 0`);
  assert.equal(fn.type, 'ArrowFunctionExpression');
  if (fn.type !== 'ArrowFunctionExpression') throw new Error('Expected function');
  return fn.params[0];
}

test('components, declarations and slots retain their distinct default-value policies', () => {
  const code = '({ size = 24, nested: { depth = 2 } }) => size';
  const fn = parseExpression(code);
  for (const [props, component, slot] of [
    [{ nested: {} }, 24, 24],
    [{ size: undefined, nested: {} }, undefined, 24],
    [{ size: UNKNOWN, nested: {} }, 24, UNKNOWN],
    [{ size: null, nested: {} }, null, null],
    [{ size: 48, nested: {} }, 48, 48],
  ] as const) {
    const ctx = { code, env: {} as Record<string, Value>, bindings: {} };
    prepareRenderFunction(fn, ctx, props, () => {});
    assert.equal(ctx.env.size, component);
    assert.equal(ctx.env.depth, UNKNOWN, 'component defaults remain top-level only');
    bindSlotArgument(parameter('{ size = 24, nested: { depth = 2 } }'), props, ctx as RenderContext);
    assert.equal(ctx.env.size, slot);
    assert.equal(ctx.env.depth, 2);
  }
  assert.deepEqual(evaluateString('[{}].map(({ size = 24 }) => size)', { code: '', env: {}, bindings: {} }), [UNKNOWN]);
});

test('slot destructuring keeps aliases, computed keys, rest and lexical initial facts', () => {
  const pattern = parameter('{ [key]: renamed = 7, nested: [first = 3], ...rest }');
  // Default expressions use the original source positions.
  const ctx = {
    code: '({ [key]: renamed = 7, nested: [first = 3], ...rest }) => 0',
    env: { key: 'size' } as Record<string, Value>, bindings: {},
    initialValues: { renamed: 99, 'renamed.width': 100, first: 99, rest: 99, unrelated: 80 },
  } as unknown as RenderContext;
  const value = JSON.parse('{"nested":[],"other":9,"__proto__":1,"constructor":2}');
  bindSlotArgument(pattern, value, ctx);
  assert.equal(ctx.env.renamed, 7);
  assert.equal(ctx.env.first, 3);
  assert.deepEqual(ctx.env.rest, { other: 9 });
  assert.deepEqual(ctx.initialValues, { unrelated: 80 });

  const env: Record<string, Value> = { rest: 'unchanged' };
  bindPattern(pattern, value, env);
  assert.equal(env.renamed, UNKNOWN);
  assert.equal(env.first, undefined);
  assert.equal(env.rest, 'unchanged', 'plain declaration binding still ignores rest');
});

test('component defaults retain binding order and explicit expression overrides', () => {
  const code = '({ first = 1, second = first + 1 }) => second';
  const ctx = { code, env: {} as Record<string, Value>, bindings: { 'first + 1': 9 } };
  prepareRenderFunction(parseExpression(code), ctx, {}, () => {});
  assert.deepEqual(ctx.env, { first: 1, second: 9 });
});
