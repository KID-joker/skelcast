import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareLayouts, type LayoutSnapshot } from '../src/browser.js';
test('source overflow is recorded as baseline while additional skeleton overflow still fails',()=>{
 const content:LayoutSnapshot={box:{x:0,y:0,width:300,height:200},visible:true,overflowX:8,placeholders:0,visiblePlaceholders:0};
 assert.equal(compareLayouts(content,{...content,placeholders:1,visiblePlaceholders:1}).needsReview,false);
 assert.ok(compareLayouts(content,{...content,overflowX:12}).issues.some(i=>i.code==='HORIZONTAL_OVERFLOW'));
});

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

test('matching outer geometry cannot hide missing native table columns or headers',()=>{
 const real={...content,tables:[{columns:11,headerRows:1}]},generated={...content,tables:[{columns:3,headerRows:1}]};
 assert.deepEqual(compareLayouts(real,generated).issues.map(issue=>issue.code),['TABLE_STRUCTURE_MISMATCH']);
 assert.ok(compareLayouts(real,{...content,tables:[]}).needsReview);
 assert.equal(compareLayouts(real,{...content,tables:[{columns:11,headerRows:1}]}).needsReview,false);
});

test('outline audits skip intentional internals while keeping outer and repeated external anchors checked',()=>{
 const box={x:0,y:0,width:100,height:40};
 const real:LayoutSnapshot={...content,tables:[{columns:10,headerRows:3}],anchors:{'anchor:table':[box],'anchor:item':[box,{...box,y:160}]},regions:[{kind:'table',key:'anchor:table',outline:false,anchors:[{key:'anchor:item',index:0}]}]};
 const generated:LayoutSnapshot={...content,tables:[{columns:3,headerRows:1,outline:true}],anchors:{'anchor:table':[box],'anchor:item':[{...box,y:160}]},regions:[{kind:'table',key:'anchor:table',outline:true,anchors:[]}]};
 assert.equal(compareLayouts(real,generated).needsReview,false);
 const displaced=structuredClone(generated);displaced.anchors!['anchor:item'][0].y=190;
 assert.deepEqual(compareLayouts(real,displaced).issues.map(issue=>issue.code),['ANCHOR_MISMATCH']);
 const missing=structuredClone(generated);delete missing.anchors!['anchor:table'];
 assert.ok(compareLayouts(real,missing).issues.some(issue=>issue.code==='ANCHOR_MISSING'));
 const unmatched={...generated,regions:[]};
 assert.ok(compareLayouts(real,unmatched).issues.some(issue=>issue.code==='ANCHOR_MISSING'));
 const nested={...real,tables:[{columns:10,headerRows:3},{columns:2,headerRows:1,parent:0}]};
 assert.equal(compareLayouts(nested,generated).needsReview,false);
 const ordinary={...generated,tables:[{columns:10,headerRows:3}]};
 assert.ok(compareLayouts(nested,ordinary).issues.some(issue=>issue.code==='TABLE_STRUCTURE_MISMATCH'));
});
