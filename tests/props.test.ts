import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOURCE_INITIAL, UNKNOWN } from '../src/compiler/expression.js';
import { componentInputs } from '../src/compiler/props.js';

test('component inputs retain alias precedence, initial facts and default projection order', () => {
  const projected = { width: UNKNOWN, [SOURCE_INITIAL]: { width: 80 } };
  const defaults = { height: projected, limit: 4 };
  const props = { minHeight: 12, 'min-height': projected };
  const template = componentInputs(props, defaults, 'template');
  const setup = componentInputs(props, defaults, 'setup');
  assert.equal(template.values.height, projected, 'template defaults remain raw');
  assert.deepEqual(setup.values.height, { width: UNKNOWN });
  assert.deepEqual(template.values.minHeight, { width: UNKNOWN });
  assert.deepEqual(setup.values.minHeight, { width: UNKNOWN });
  assert.equal(template.values.minHeight, template.values['min-height']);
  assert.notEqual(setup.values.minHeight, setup.values['min-height'], 'setup aliases retain independent projected objects');
  assert.deepEqual(template.initial, { minHeight: 12, 'min-height': { width: 80 } });
  assert.deepEqual(setup.initial, { height: { width: 80 }, limit: 4, minHeight: { width: 80 }, 'min-height': { width: 80 } });
  const other = componentInputs({ 'min-height': 20, minHeight: 40 }, defaults, 'setup');
  assert.equal(other.values.minHeight, 40, 'the last source alias wins');
  assert.equal(props['min-height'], projected);
  assert.equal(defaults.height, projected);
});
