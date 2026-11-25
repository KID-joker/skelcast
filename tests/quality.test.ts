import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadProject, syncProject, saveHints } from '../src/generator.js';
import { qualityProject, createQualityBaseline, compareQualityBaseline } from '../src/quality.js';
import { compileTarget } from '../src/compiler/index.js';

test('review metrics deduplicate variant diagnostics and baseline measures repaired locations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-quality-'));
  try {
    await writeFile(path.join(root, 'View.jsx'), `export default ()=> <main><section style={{width:privateWidth()}}/><aside style={{height:privateHeight()}}/></main>`);
    await writeFile(path.join(root, 'skelcast.config.mjs'), `export default {targets:[{id:'review',source:'View.jsx',variants:{one:{},two:{}}}]}`);
    let project = await loadProject(root);
    await syncProject(project);
    const initial = await qualityProject(project);
    const baseline = createQualityBaseline(initial);
    assert.ok(baseline.targets.review.locations.length >= 2);
    assert.ok(baseline.targets.review.locations.every(location => location.variants.length === 2));
    await saveHints(project, 'review', { bindings: { 'privateWidth()': 240 } });
    project = await loadProject(root);
    await syncProject(project);
    const after = await qualityProject(project);
    const progress = compareQualityBaseline(after, baseline).review;
    assert.ok(progress.resolved > 0);
    assert.equal(progress.added, 0);
    assert.ok(progress.remaining < progress.before);
    await saveHints(project, 'review', { bindings: { 'privateWidth()': 240, 'privateHeight()': 160 } });
    project = await loadProject(root);
    await syncProject(project);
    const repaired = await qualityProject(project);
    assert.equal(compareQualityBaseline(repaired, baseline).review.remaining, 0);
    assert.throws(() => compareQualityBaseline(repaired, { version: 1, targets: { broken: {} } } as any), /Invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('finite clsx and classnames imports resolve aliases without running helpers or shadowed business calls', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-classes-'));
  try {
    const cases = {
      'View.jsx': `import {clsx as cx} from 'clsx';const alias=cx;export default function View({wide=true}){return <main className={alias('grid',[false,{'cols-2':wide}],0)}/>}throw new Error('never run')`,
      'View.vue': `<script setup>import cx from 'classnames';const wide=true;const classes=cx('grid',{'cols-2':wide})</script><template><main :class="classes"/></template>`,
      'Fake.jsx': `import cx from 'fake-clsx';export default ()=> <main className={cx('grid')}/>` ,
      'Shadowed.jsx': `import cx from 'clsx';export default function View({cx}){return <main className={cx('grid')}/>} `,
      'Unknown.jsx': `import cx from 'clsx';export default function View({wide}){return <main className={cx('grid',{'cols-2':wide})}/>} `,
    };
    for (const [file, content] of Object.entries(cases)) await writeFile(path.join(root, file), content);
    for (const source of ['View.jsx', 'View.vue']) {
      const { artifact } = await compileTarget(root, { id: 'classes', source });
      assert.equal(artifact.diagnostics.length, 0);
      assert.match(artifact.variants.default.html, /class="grid cols-2"/);
    }
    for (const source of ['Fake.jsx', 'Shadowed.jsx', 'Unknown.jsx']) {
      const { artifact } = await compileTarget(root, { id: 'classes', source });
      assert.ok(artifact.diagnostics.some(item => item.code === 'LAYOUT_UNKNOWN'), source);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
