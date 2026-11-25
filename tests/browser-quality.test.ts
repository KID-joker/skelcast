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

test('equal outer boxes cannot hide internal column drift or missing repeated anchors', () => {
  const real = { ...content, anchors: { 'anchor:column': [{ x: 0, y: 0, width: 100, height: 100 }, { x: 120, y: 0, width: 280, height: 100 }], 'id:footer': [{ x: 0, y: 150, width: 400, height: 50 }] } };
  const generated = { ...content, anchors: { 'anchor:column': [{ x: 0, y: 0, width: 200, height: 100 }, { x: 220, y: 0, width: 180, height: 100 }] } };
  const result = compareLayouts(real, generated);
  assert.equal(result.delta.width, 0);
  assert.equal(result.delta.height, 0);
  assert.deepEqual(result.anchors, { compared: 2, mismatched: 2, missing: 1 });
  assert.deepEqual(result.issues.map(issue => issue.code), ['ANCHOR_MISMATCH', 'ANCHOR_MISMATCH', 'ANCHOR_MISSING']);
});
