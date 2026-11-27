import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { compileTarget } from '../src/compiler/index.js';
import { SourceFiles } from '../src/compiler/source-files.js';
import { StaticValues } from '../src/compiler/static-values.js';

test('scans and variants share source reads and ASTs while keeping binding environments independent', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'skelcast-cache-')));
  try {
    await writeFile(path.join(root, 'layout.css'), '.grid{display:grid}.list{display:flex}');
    await writeFile(path.join(root, 'View.tsx'), `import './layout.css';const mode='grid';export default()=> <main className={mode} data-layout={mode}>Original</main>`);
    await writeFile(path.join(root, 'View.vue'), `<script setup>const mode='grid'</script><template><main :class="mode" :data-layout="mode">Original</main></template><style src="./layout.css"/>`);
    const reads = t.mock.method(fs, 'readFile');
    const stats = t.mock.method(fs, 'stat');
    const asts = t.mock.method(SourceFiles.prototype, 'ast');
    syncBuiltinESMExports();
    try {
      for (const source of ['View.tsx', 'View.vue']) {
        reads.mock.resetCalls(); stats.mock.resetCalls(); asts.mock.resetCalls();
        const target = { id: 'cache', source, variants: { grid: { bindings: { mode: 'grid' } }, list: { bindings: { mode: 'list' } } } };
        const first = await compileTarget(root, target);
        const count = (file: string) => reads.mock.calls.filter(call => call.arguments[0] === path.join(root, file)).length;
        assert.equal(count(source), 1, 'scan and all variants read the source once');
        assert.equal(count('layout.css'), 1, 'shared styles are read once');
        assert.equal(stats.mock.calls.filter(call => call.arguments[0] === path.join(root, 'layout.css')).length, 1, 'scan, modules and variants share resolution probes');
        const parsed = asts.mock.calls.filter(call => call.arguments[0] === path.join(root, source));
        assert.ok(parsed.length > 1, 'the scan and modules both request syntax');
        assert.equal(new Set(parsed.map(call => call.result)).size, 1, 'all requests share the parsed AST');
        for (const mode of ['grid', 'list']) {
          assert.match(first.artifact.variants[mode].html, new RegExp(`class="${mode}" data-layout="${mode}"`));
          assert.match(first.artifact.variants[mode].css, new RegExp(`\\.${mode}\\s*\\{`));
        }
        assert.deepEqual(first.artifact.diagnostics, []);
        const text = await fs.readFile(path.join(root, source), 'utf8');
        await writeFile(path.join(root, source), text.replace('Original', 'Updated'));
        const second = await compileTarget(root, target);
        assert.notEqual(first.dependencies[source], second.dependencies[source]);
        assert.match(second.artifact.variants.grid.html, /Updated/);
      }
    } finally {
      reads.mock.restore(); stats.mock.restore(); asts.mock.restore(); syncBuiltinESMExports();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('repeated Vue components share syntax and static environments without sharing props, variants or later source edits', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'skelcast-template-cache-')));
  try {
    const source = `<script setup>import Child from './Child.vue';const groups=[{label:'First',limit:2},{label:'Second',limit:3}]</script><template><main><Child v-for="group in groups" :label="group.label" :limit="group.limit"/></main></template>`;
    await writeFile(path.join(root, 'View.vue'), source);
    await writeFile(path.join(root, 'Child.vue'), `<script setup>import{ref}from'vue';const props=defineProps(['label','limit']);const rows=ref([]);function receive(response){rows.value=response.items;}</script><template><section :data-label="label"><div v-if="rows.length>0"><article v-for="row in rows.slice(0,limit)">{{row.title}}</article></div></section></template>`);
    const templates = t.mock.method(SourceFiles.prototype, 'template');
    const environments = t.mock.method(StaticValues.prototype, 'environment');
    const target = { id: 'cache', source: 'View.vue', kind: 'request' as const, variants: { loading: {}, source: { state: 'source' as const }, empty: { bindings: { 'Child.vue::rows': [] } } } };
    const first = await compileTarget(root, target);
    const html = first.artifact.variants.loading.html;
    assert.equal((html.match(/<article /g) ?? []).length, 5);
    assert.match(html, /data-label="First"/);
    assert.match(html, /data-label="Second"/);
    for (const variant of ['source', 'empty']) assert.doesNotMatch(first.artifact.variants[variant].html, /<article /);
    const childTemplates = templates.mock.calls.filter(call => call.arguments[0] === path.join(root, 'Child.vue'));
    assert.equal(childTemplates.length, 6);
    assert.equal(new Set(childTemplates.map(call => call.result)).size, 1, 'instances and variants reuse one immutable template');
    const childEnvironments = await Promise.all(environments.mock.calls.filter(call => call.arguments[0].file === path.join(root, 'Child.vue')).map(call => call.result));
    assert.equal(childEnvironments.length, 6);
    assert.equal(new Set(childEnvironments).size, 3, 'instances reuse their compiler-local environment while variants remain independent');
    await writeFile(path.join(root, 'View.vue'), source.replace('limit:2', 'limit:1'));
    const second = await compileTarget(root, target);
    assert.equal((second.artifact.variants.loading.html.match(/<article /g) ?? []).length, 4);
    assert.notEqual(first.dependencies['View.vue'], second.dependencies['View.vue']);
    const nextEnvironments = await Promise.all(environments.mock.calls.filter(call => call.arguments[0].file === path.join(root, 'Child.vue')).slice(6).map(call => call.result));
    assert.ok(nextEnvironments.every(environment => !childEnvironments.includes(environment)), 'later compilations use fresh environments');
  } finally { await rm(root, { recursive: true, force: true }); }
});
