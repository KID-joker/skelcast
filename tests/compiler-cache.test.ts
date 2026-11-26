import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { compileTarget } from '../src/compiler/index.js';
import { SourceFiles } from '../src/compiler/source-files.js';

test('scans and variants share source reads and ASTs while keeping binding environments independent', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'skelcast-cache-')));
  try {
    await writeFile(path.join(root, 'layout.css'), '.grid{display:grid}.list{display:flex}');
    await writeFile(path.join(root, 'View.tsx'), `import './layout.css';const mode='grid';export default()=> <main className={mode} data-layout={mode}>Original</main>`);
    await writeFile(path.join(root, 'View.vue'), `<script setup>const mode='grid'</script><template><main :class="mode" :data-layout="mode">Original</main></template><style src="./layout.css"/>`);
    const reads = t.mock.method(fs, 'readFile');
    const asts = t.mock.method(SourceFiles.prototype, 'ast');
    syncBuiltinESMExports();
    try {
      for (const source of ['View.tsx', 'View.vue']) {
        reads.mock.resetCalls(); asts.mock.resetCalls();
        const target = { id: 'cache', source, variants: { grid: { bindings: { mode: 'grid' } }, list: { bindings: { mode: 'list' } } } };
        const first = await compileTarget(root, target);
        const count = (file: string) => reads.mock.calls.filter(call => call.arguments[0] === path.join(root, file)).length;
        assert.equal(count(source), 1, 'scan and all variants read the source once');
        assert.equal(count('layout.css'), 1, 'shared styles are read once');
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
      reads.mock.restore(); asts.mock.restore(); syncBuiltinESMExports();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
