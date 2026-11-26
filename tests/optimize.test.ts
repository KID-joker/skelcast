import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArtifactOptimizer, sharedStyleModule } from '../src/compiler/optimize.js';
import type { SkeletonArtifact } from '../src/types.js';

const separator = '/* skelcast-shared-base */';
const base = '@keyframes pulse { to { opacity: 0.55; } }';
const artifact = (css = '.card { width: 100px; padding: 0px 0px 0px 0px; }'): SkeletonArtifact => ({
  id: 'cards', kind: 'request', render: 'shadow', defaultVariant: 'grid', source: 'View.vue',
  diagnostics: [], evidence: [], sources: { abc: { file: 'View.vue', line: 1 } },
  variants: Object.fromEntries(['grid', 'list'].map(name => [name, {
    html: '<div data-sk-artifact="cards"><article data-sk-node="abc" data-sk-layout><span data-sk-node="def" data-sk-leaf> x  y &nbsp; z </span></article></div>',
    css: css + separator + base, sourceIds: ['catalog'],
  }])),
});

test('production optimization minifies CSS and removes only source location attributes without mutating inspection data', () => {
  const original = artifact();
  const before = structuredClone(original);
  const result = createArtifactOptimizer().artifact(original);
  const { html, css } = result.variants.grid;
  assert.doesNotMatch(html, /data-sk-node/);
  assert.match(html, /data-sk-layout/);
  assert.match(html, /data-sk-leaf> x  y &nbsp; z <\/span>/);
  assert.match(css, /width:100px;padding:0/);
  assert.ok(css.includes(separator));
  assert.ok(css.length < original.variants.grid.css.length);
  assert.deepEqual(result.variants.grid.sourceIds, ['catalog']);
  assert.deepEqual(result.sources, {});
  assert.deepEqual(original, before);
});

test('production markers remain when CSS selectors or selector conditions depend on them', () => {
  for (const css of [
    '[data-sk-node] { width: 45px }',
    ':is([data-sk-node="abc"],.other) { height: 20px }',
    '[data-sk-\\6e ode] { width: 45px }',
    '@supports selector([data-sk-node]) { .card { width: 45px } }',
  ]) {
    assert.match(createArtifactOptimizer().artifact(artifact(css)).variants.grid.html, /data-sk-node="abc"/, css);
  }
});

test('shared production modules round-trip all variants with one base import', async () => {
  const optimizer = createArtifactOptimizer();
  const original = artifact();
  const shared = new Map<string, string>();
  const module = optimizer.module(original, css => {
    const url = 'data:text/javascript;base64,' + Buffer.from(sharedStyleModule(css)).toString('base64');
    shared.set(css, url);
    return url;
  });
  assert.equal(shared.size, 1);
  assert.equal((module.match(/import appendBase/g) ?? []).length, 1);
  const loaded = await import('data:text/javascript;base64,' + Buffer.from(module).toString('base64'));
  assert.deepEqual(loaded.default, optimizer.artifact(original));
});

test('invalid CSS is preserved with one warning instead of being dropped', () => {
  const warnings: string[] = [];
  const optimizer = createArtifactOptimizer(message => warnings.push(message));
  const css = 'a[ { width:1px }';
  const input = artifact();
  for (const view of Object.values(input.variants)) view.css = css;
  const result = optimizer.artifact(input);
  assert.equal(result.variants.grid.css, css);
  assert.match(result.variants.grid.html, /data-sk-node/);
  assert.equal(warnings.length, 1);
});

test('initial reuse omits the default HTML/CSS literals while retaining metadata and other variants', async () => {
  const optimizer = createArtifactOptimizer();
  const input = artifact();
  input.kind = 'page';
  input.variants.grid.html = '<main data-sk-artifact="cards">Default-only-markup</main>';
  input.variants.list.html = '<main data-sk-artifact="cards">Other-variant-markup</main>';
  const expected = optimizer.artifact(input);
  const initial = { ...expected.variants.grid, baseCSS: 'shared-from-initial' };
  const initialURL = 'data:text/javascript;base64,' + Buffer.from(`export default ${JSON.stringify(initial)}`).toString('base64');
  const module = optimizer.module(input, css => 'data:text/javascript;base64,' + Buffer.from(sharedStyleModule(css)).toString('base64'), initialURL);
  // The initial module URL holds the fixture; inspect only the artifact expression.
  const expression = module.slice(module.indexOf('\nexport default'));
  assert.doesNotMatch(expression, /Default-only-markup/);
  assert.match(expression, /initialView\.html/);
  assert.match(expression, /Other-variant-markup/);
  const loaded = await import('data:text/javascript;base64,' + Buffer.from(module).toString('base64'));
  assert.deepEqual(loaded.default, expected);
});

test('shared base modules can reuse the initial CSS without embedding another copy', async () => {
  const initialURL = 'data:text/javascript;base64,' + Buffer.from('export default {baseCSS:"from-shell"}').toString('base64');
  const module = sharedStyleModule('should-not-be-embedded', initialURL);
  assert.doesNotMatch(module, /should-not-be-embedded/);
  const loaded = await import('data:text/javascript;base64,' + Buffer.from(module).toString('base64'));
  assert.equal(loaded.default('.local{}'), '.local{}' + separator + 'from-shell');
});
