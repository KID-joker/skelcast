import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateString, SOURCE_PROJECTION, UNKNOWN } from '../src/compiler/expression.js';
import { initialString } from '../src/compiler/initial-state.js';

const evaluate = (source: string, bindings: Record<string, unknown> = {}) => evaluateString(source, { code: '', env: {}, bindings });

test('finite method chains read each receiver once without sharing values across evaluations or callbacks', () => {
  let reads = 0;
  let items = [1, 2, 3];
  const env = Object.defineProperty({}, 'items', { get() { reads++; return items; }, enumerable: true });
  const context = { code: '', env, bindings: {}, expressions: new Map() };
  const chain = 'items' + '.slice(0)'.repeat(12);
  assert.deepEqual(evaluateString(chain, context), items);
  assert.equal(reads, 1);
  items = [4, 5];
  assert.deepEqual(evaluateString(chain, context), items);
  assert.equal(reads, 2);
  assert.deepEqual(evaluateString('items.map(item => [item].slice(0).map(n => n + 1))', { ...context, env: { items } }), [[5], [6]]);
  assert.equal(evaluateString('text.trim().trim()', { ...context, env: { text: ' value ' } }), 'value');
  assert.deepEqual(items, [4, 5]);
});

test('method receiver reuse retains member bindings and source capabilities before finite method dispatch', () => {
  let reads = 0;
  const env = Object.defineProperty({}, 'items', { get() { reads++; return [1, 2]; }, enumerable: true });
  const context = { code: '', env, bindings: { 'items.slice': { [SOURCE_PROJECTION]: 'bound' } } };
  assert.equal(evaluateString('items.slice(0)', context), 'bound');
  assert.equal(reads, 0);
  assert.equal(evaluateString('source.slice()', {
    code: '', env: { source: { slice: { [SOURCE_PROJECTION]: 'source' } } }, bindings: {},
  }), 'source');
  assert.deepEqual(evaluateString('items.slice(0)', { ...context, bindings: { 'items.slice': UNKNOWN } }), [1, 2]);
  assert.equal(reads, 1);
});

test('initial presentation expressions reuse syntax while retaining current facts and explicit bindings', () => {
  const ctx = { code: '', env: { size: UNKNOWN }, bindings: {}, initialValues: { size: 20 }, expressions: new Map() };
  const text = 'size + 1';
  assert.equal(evaluateString(text, ctx), UNKNOWN);
  const expression = ctx.expressions!.get(text);
  assert.ok(expression);
  assert.equal(initialString(text, ctx), 21);
  assert.equal(ctx.expressions!.get(text), expression);
  assert.equal(initialString(text, { ...ctx, initialValues: { size: 40 } }), 41);
  assert.equal(initialString(text, { ...ctx, bindings: { size: 60 } }), UNKNOWN);
  assert.equal(initialString('size +', ctx), UNKNOWN);
  assert.equal(ctx.expressions!.get('size +'), null);
});

test('primitive loose equality follows JavaScript coercion without changing strict equality', () => {
  const cases: [string, boolean][] = [
    ['0 == false', true], ['0 != false', false], ['"1" == 1', true],
    ['"" == false', true], ['"  " == 0', true], ['null == undefined', true],
    ['null == 0', false], ['"oops" == 0', false], ['0 === false', false],
    ['0 !== false', true], ['"1" === 1', false], ['true != "1"', false],
  ];
  for (const [source, expected] of cases) assert.equal(evaluate(source), expected, source);
  assert.equal(evaluate('left == right', { left: NaN, right: NaN }), false);
  assert.equal(evaluate('left == right', { left: 1n, right: '1' }), true);
});

test('loose equality never coerces objects or functions and propagates unknown values', () => {
  let calls = 0;
  const object = { valueOf() { calls++; throw new Error('business code'); } };
  for (const source of ['object == 0', 'object != 0', 'object == object']) assert.equal(evaluate(source, { object }), UNKNOWN);
  assert.equal(evaluate('missing == false'), UNKNOWN);
  assert.equal(calls, 0);
});

test('relational comparisons preserve primitive semantics without invoking business coercion', () => {
  let calls = 0;
  const object = { valueOf() { calls++; throw new Error('business code'); } };
  for (const source of ['object > 0', 'object < 0', 'object >= 0', 'object <= 0']) assert.equal(evaluate(source, { object }), UNKNOWN);
  for (const [source, expected] of [['null < 1', true], ['undefined < 1', false], ['false <= 0', true], ['"10" < "2"', true], ['"10" < 2', false]] as const) assert.equal(evaluate(source), expected, source);
  assert.equal(evaluate('left < right', { left: 1n, right: '1.5' }), false);
  assert.equal(calls, 0);
});
