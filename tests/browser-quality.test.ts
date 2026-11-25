import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareLayouts, type LayoutSnapshot } from '../src/browser.js';

const content: LayoutSnapshot = { box: { x: 20, y: 30, width: 400, height: 200 }, visible: true, overflowX: 0, placeholders: 0, visiblePlaceholders: 0 };
test('visual geometry reports height drift, displaced following content and invisible overflowing placeholders', () => {
  const skeleton: LayoutSnapshot = { ...content, box: { ...content.box, height: 320 }, placeholders: 6, visiblePlaceholders: 0, overflowX: 80 };
  const result = compareLayouts(content, skeleton);
  assert.equal(result.needsReview, true);
  assert.equal(result.delta.followingContentShift, 120);
  assert.deepEqual(result.issues.map(issue => issue.code).sort(), ['HEIGHT_MISMATCH', 'HORIZONTAL_OVERFLOW', 'PLACEHOLDERS_INVISIBLE']);
});
test('visual tolerances allow small geometry differences and control-only skeletons', () => {
  assert.equal(compareLayouts(content, { ...content, box: { ...content.box, height: 207 } }).needsReview, false);
  assert.equal(compareLayouts(content, { ...content, box: { ...content.box, height: 207 } }, { tolerancePx: 1, toleranceRatio: 0 }).needsReview, true);
  assert.throws(() => compareLayouts(content, content, { tolerancePx: NaN }), /finite nonnegative/);
  assert.throws(() => compareLayouts(content, content, { toleranceRatio: -1 }), /finite nonnegative/);
});
