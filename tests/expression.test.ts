import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateString, UNKNOWN } from '../src/compiler/expression.js';

const evaluate = (source: string, bindings: Record<string, unknown> = {}) => evaluateString(source, { code: '', env: {}, bindings });

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
