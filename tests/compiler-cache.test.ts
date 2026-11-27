import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { compileTarget } from '../src/compiler/index.js';
import { SourceFiles } from '../src/compiler/source-files.js';
import { StaticValues } from '../src/compiler/static-values.js';
import { checkProject, projectFromConfig, readArtifact, syncProject } from '../src/generator.js';

test('one project sync shares source syntax across targets while preserving bindings and later edits', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'skelcast-target-cache-')));
  try {
    await writeFile(path.join(root, 'layout.css'), '.grid{display:grid}.list{display:flex}');
    await writeFile(path.join(root, 'View.vue'), `<script setup>import Child from './Child.vue';const mode='grid'</script><template><main :class="mode"><Child :label="mode"/></main></template><style src="./layout.css"/>`);
    const child = `<script setup>defineProps(['label'])</script><template><p>{{label}} Original</p></template>`;
    await writeFile(path.join(root, 'Child.vue'), child);
    const project = await projectFromConfig(root, { targets: [
      { id: 'first', source: 'View.vue', hints: { bindings: { mode: 'grid' } } },
      { id: 'second', source: 'View.vue', hints: { bindings: { mode: 'list' } }, variants: { normal: {}, override: { bindings: { mode: 'grid' } } } },
    ] });
    const reads = t.mock.method(fs, 'readFile');
    const asts = t.mock.method(SourceFiles.prototype, 'ast');
    const templates = t.mock.method(SourceFiles.prototype, 'template');
    syncBuiltinESMExports();
    try {
      assert.deepEqual((await syncProject(project)).map(row => row.state), ['generated', 'generated']);
      for (const file of ['View.vue', 'Child.vue', 'layout.css']) {
        assert.equal(reads.mock.calls.filter(call => call.arguments[0] === path.join(root, file)).length, 1, file);
      }
      for (const file of ['View.vue', 'Child.vue']) {
        const parsed = asts.mock.calls.filter(call => call.arguments[0] === path.join(root, file));
        assert.equal(new Set(parsed.map(call => call.result)).size, 1, `${file} AST`);
        const rendered = templates.mock.calls.filter(call => call.arguments[0] === path.join(root, file));
        assert.equal(new Set(rendered.map(call => call.result)).size, 1, `${file} template`);
      }
      for (const target of project.config.targets) {
        const standalone = await compileTarget(root, target);
        assert.deepEqual(await readArtifact(project, target.id), standalone.artifact, 'shared syntax retains standalone output');
      }
      await writeFile(path.join(root, 'Child.vue'), child.replace('Original', 'Updated'));
      assert.deepEqual((await checkProject(project)).map(row => row.state), ['stale', 'stale']);
      assert.deepEqual((await syncProject(project)).map(row => row.state), ['generated', 'generated']);
      for (const id of ['first', 'second']) {
        for (const view of Object.values((await readArtifact(project, id)).variants)) assert.match(view.html, /Updated/);
      }
      assert.deepEqual((await syncProject(project)).map(row => row.state), ['reused', 'reused']);
    } finally {
      reads.mock.restore(); asts.mock.restore(); templates.mock.restore(); syncBuiltinESMExports();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

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

test('Vue instance declarations retain props and exact expression overrides when reusing module literals', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-instance-values-'));
  try {
    await writeFile(path.join(root, 'Child.vue'), `<script setup>const props=defineProps(['width','label']);const gap=10;const width=props.width+gap;const label=props.label;const style={width}</script><template><section :style="style" :data-label="label"/></template>`);
    await writeFile(path.join(root, 'View.vue'), `<script setup>import Child from './Child.vue'</script><template><main><Child :width="30" label="First"/><Child :width="50" label="Second"/></main></template>`);
    const { artifact } = await compileTarget(root, {
      id: 'instances', source: 'View.vue', variants: {
        original: {}, literal: { bindings: { 'Child.vue::10': 20 } }, member: { bindings: { 'Child.vue::props.label': 'Override' } },
      },
    });
    assert.deepEqual(artifact.diagnostics, []);
    assert.match(artifact.variants.original.html, /width:40px[^>]*data-label="First"/);
    assert.match(artifact.variants.original.html, /width:60px[^>]*data-label="Second"/);
    assert.match(artifact.variants.literal.html, /width:50px[^>]*data-label="First"/);
    assert.match(artifact.variants.literal.html, /width:70px[^>]*data-label="Second"/);
    assert.equal((artifact.variants.member.html.match(/data-label="Override"/g) ?? []).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
