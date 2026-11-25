import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileTarget } from '../src/compiler/index.js';
import { buildRepairGuide } from '../src/repairs.js';

async function fixture(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-repairs-'));
  try {
    for (const [file, code] of Object.entries(files)) await writeFile(path.join(root, file), code);
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const [source, code] of [
  ['View.tsx', `const layout=privateLayout(); throw new Error('never execute');\nexport default ()=> <section style={{width:layout.width}}/>`],
  ['View.vue', `<script setup>const layout=privateLayout();throw new Error('never execute')</script>\n<template><section :style="{width:layout.width}"/></template>`],
]) test(`${source}: fallback captures the unresolved expression and reviewable bindings that repair it`, async () => {
  await fixture({ [source]: code }, async root => {
    const target = { id: 'layout', source };
    const { artifact } = await compileTarget(root, target);
    const diagnostic = artifact.diagnostics.find(d => d.code === 'FALLBACK')!;
    assert.ok(diagnostic.node);
    assert.match(diagnostic.expression!, /layout.width/);
    assert.equal(diagnostic.file, source);
    assert.equal(diagnostic.line, 2);
    const guide = buildRepairGuide(artifact, diagnostic.node!, 'default', target);
    const example = guide.examples.find(example => example.kind === 'binding')!;
    assert.deepEqual({ ...example.bindings }, { [`${source}::layout.width`]: 320 });
    assert.equal(guide.source?.line, 2);
    const repaired = await compileTarget(root, { ...target, hints: { bindings: example.bindings } });
    assert.doesNotMatch(repaired.artifact.variants.default.html, /data-sk-fallback/);
    assert.match(repaired.artifact.variants.default.html, /width:320px/);
  });
});

test('missing exports identify the caller and supply an adapter preserving existing mappings', async () => {
  await fixture({
    'View.tsx': `import Chart from './Broken';\nexport default ()=> <Chart/>`,
    'Broken.tsx': `export const other = 1; throw new Error('never execute')`,
  }, async root => {
    const target = { id: 'chart', source: 'View.tsx', adapters: { Other: 'Other.tsx' } };
    const { artifact } = await compileTarget(root, target);
    const diagnostic = artifact.diagnostics.find(d => d.code === 'FALLBACK')!;
    assert.equal(diagnostic.file, 'View.tsx');
    assert.equal(diagnostic.line, 2);
    assert.equal(diagnostic.component, 'Chart');
    const guide = buildRepairGuide(artifact, diagnostic.node!, 'default', target);
    assert.ok(guide.evidence.some(e => e.expression === 'Chart'));
    const example = guide.examples.find(example => example.kind === 'adapter')!;
    assert.match(example.files[1].code, /"Other": "Other.tsx"/);
    assert.match(example.files[1].code, /"Chart": "src\/skeletons\/ChartSkeleton.tsx"/);
    await writeFile(path.join(root, 'Adapter.tsx'), example.files[0].code);
    const repaired = await compileTarget(root, { ...target, adapters: { Chart: 'Adapter.tsx' } });
    assert.equal(repaired.artifact.diagnostics.length, 0);
  });
});

test('repair context stays scoped to its node and variant, including variant overrides', async () => {
  await fixture({ 'View.tsx': `const layout=privateLayout(); export default ()=> <section style={{width:layout.width,height:layout.height}}/>` }, async root => {
    const target = { id: 'layout', source: 'View.tsx', variants: { wide: { bindings: { 'layout.width': 600 } }, tall: { bindings: { 'layout.height': 480 } } } };
    const { artifact } = await compileTarget(root, target);
    const diagnostic = artifact.diagnostics.find(d => d.code === 'FALLBACK')!;
    const wide = buildRepairGuide(artifact, diagnostic.node!, 'wide', target);
    const tall = buildRepairGuide(artifact, diagnostic.node!, 'tall', target);
    assert.deepEqual({ ...wide.examples[0].bindings }, { 'View.tsx::layout.height': 96 });
    assert.deepEqual({ ...tall.examples[0].bindings }, { 'View.tsx::layout.width': 320 });
    assert.equal(buildRepairGuide(artifact, 'different-node', 'wide').diagnostics.length, 0);
    const overridden = buildRepairGuide(artifact, diagnostic.node!, 'wide', { ...target, variants: { wide: { bindings: { 'View.tsx::layout.height': 200 } } } });
    assert.equal(overridden.examples[0].bindings, undefined);
    assert.match(overridden.examples[0].description, /edit its configuration/);
  });
});

test('unknown render calls retain their source without suggesting ineffective bindings', async () => {
  await fixture({ 'View.tsx': `export default ()=> <main>{renderPrivateLayout()}</main>` }, async root => {
    const { artifact } = await compileTarget(root, { id: 'call', source: 'View.tsx' });
    const diagnostic = artifact.diagnostics.find(d => d.code === 'FALLBACK')!;
    assert.equal(diagnostic.expression, 'renderPrivateLayout()');
    const guide = buildRepairGuide(artifact, diagnostic.node!, 'default');
    assert.deepEqual(guide.examples.map(example => example.kind), ['source']);
  });
});

test('Vue component evidence and adapter examples follow the selected fallback node', async () => {
  await fixture({ 'View.vue': `<script setup>import VendorChart from 'private-vendor'</script><template><VendorChart/></template>` }, async root => {
    const { artifact } = await compileTarget(root, { id: 'chart', source: 'View.vue' });
    const diagnostic = artifact.diagnostics.find(d => d.code === 'FALLBACK')!;
    const guide = buildRepairGuide(artifact, diagnostic.node!, 'default');
    assert.ok(guide.evidence.some(e => e.node === diagnostic.node && e.expression === 'VendorChart'));
    assert.equal(guide.examples[0].files[0].name, 'src/skeletons/VendorChartSkeleton.vue');
  });
});
