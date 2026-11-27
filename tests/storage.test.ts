import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm, utimes } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { checkProject, loadProject, saveHints, syncProject } from '../src/generator.js';
import { commitOutputs, withProjectLock } from '../src/storage.js';
import { qualityProject } from '../src/quality.js';
import { diagnoseProject } from '../src/diagnose.js';

const execute = promisify(execFile);
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-storage-'));
  try {
    await writeFile(path.join(root, 'skelcast.config.mjs'), `export default {targets:[{id:'one',source:'One.jsx'},{id:'two',source:'Two.jsx'}]}`);
    await writeFile(path.join(root, 'One.jsx'), 'export default ()=> <section>One</section>');
    await writeFile(path.join(root, 'Two.jsx'), 'export default ()=> <section>Two</section>');
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('unchanged outputs do not create transaction files or touch output timestamps', async () => fixture(async root => {
  const project = await loadProject(root);
  await syncProject(project);
  const artifactFile = path.join(project.outDir, 'one.mjs');
  const artifact = await readFile(artifactFile, 'utf8');
  const before = (await stat(artifactFile)).mtimeMs;
  await withProjectLock(project.outDir, async () => {
    await utimes(project.outDir, 1, 1);
    const directoryTime = (await stat(project.outDir)).mtimeMs;
    await commitOutputs(project.outDir, new Map([
      ['one.mjs', artifact],
      ['manifest.json', await readFile(path.join(project.outDir, 'manifest.json'), 'utf8')],
      ['absent.mjs', null],
    ]));
    await commitOutputs(project.outDir, new Map());
    assert.equal((await stat(project.outDir)).mtimeMs, directoryTime, 'no staging directory or journal was created');
    assert.equal((await stat(artifactFile)).mtimeMs, before);
    assert.equal(await readFile(artifactFile, 'utf8'), artifact);
  });
  assert.ok((await checkProject(project)).every(row => row.state === 'ready'));
}));

test('single-target checks, quality and diagnosis do not inspect unrelated target inputs', async () => fixture(async root => {
  const project = await loadProject(root);
  await syncProject(project);
  let unrelatedReads = 0;
  Object.defineProperty(project.config.targets[1], 'source', { enumerable: true, get: () => { unrelatedReads++; return 'Two.jsx'; } });
  assert.deepEqual(await checkProject(project, 'one'), [{ id: 'one', state: 'ready' }]);
  assert.deepEqual((await qualityProject(project, 'one')).map(row => row.id), ['one']);
  assert.equal((await diagnoseProject(project, 'one')).state, 'ready');
  assert.equal(unrelatedReads, 0);
  assert.equal((await checkProject(project)).length, 2);
  assert.ok(unrelatedReads > 0, 'full-project checks still inspect every target');
  await assert.rejects(checkProject(project, 'unknown'), /Unknown skeleton unknown/);
  await assert.rejects(qualityProject(project, 'unknown'), /Unknown skeleton unknown/);
}));

test('sync reuses legacy manifests while dropping unused metadata', async () => fixture(async root => {
  const project = await loadProject(root);
  await syncProject(project);
  const manifestFile = path.join(project.outDir, 'manifest.json');
  const legacy = JSON.parse(await readFile(manifestFile, 'utf8'));
  legacy.configHash = 'unused legacy hash';
  for (const [id, entry] of Object.entries(legacy.targets)) (entry as Record<string, unknown>).file = `${id}.mjs`;
  await writeFile(manifestFile, JSON.stringify(legacy));
  const before = (await stat(path.join(project.outDir, 'one.mjs'))).mtimeMs;
  assert.ok((await syncProject(project)).every(row => row.state === 'reused'));
  assert.equal((await stat(path.join(project.outDir, 'one.mjs'))).mtimeMs, before);
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  assert.equal(Object.hasOwn(manifest, 'configHash'), false);
  for (const entry of Object.values(manifest.targets)) assert.equal(Object.hasOwn(entry as object, 'file'), false);
  assert.ok((await checkProject(project)).every(row => row.state === 'ready'));
}));

test('checks and inspection share reads within an operation and refresh binary dependencies on the next operation', async t => fixture(async root => {
  await writeFile(path.join(root, 'shared.js'), `import './asset.bin';export const title='Shared'`);
  await writeFile(path.join(root, 'asset.bin'), Buffer.from([0xff, 0x00, 0x80]));
  for (const source of ['One.jsx', 'Two.jsx']) await writeFile(path.join(root, source), `import {title} from './shared.js';export default()=> <section>{title}</section>`);
  const project = await loadProject(root);
  await syncProject(project);
  const reads = t.mock.method(fs, 'readFile');
  syncBuiltinESMExports();
  try {
    for (const operation of [() => checkProject(project), () => qualityProject(project), () => diagnoseProject(project, 'one'), () => syncProject(project)]) {
      reads.mock.resetCalls();
      await operation();
      for (const file of [path.join(project.root, 'shared.js'), path.join(project.root, 'asset.bin'), path.join(project.outDir, 'one.mjs')]) {
        assert.equal(reads.mock.calls.filter(call => call.arguments[0] === file).length, 1, `read ${file} once per operation`);
      }
    }
    // Both byte sequences decode to the same UTF-8 text; fingerprints must use bytes.
    await writeFile(path.join(root, 'asset.bin'), Buffer.from([0xfe, 0x00, 0x80]));
    const statuses = await checkProject(project);
    assert.ok(statuses.every(status => status.state === 'stale' && status.reason === 'asset.bin changed'));
    await syncProject(project);
    assert.ok((await checkProject(project)).every(status => status.state === 'ready'));
  } finally { reads.mock.restore(); syncBuiltinESMExports(); }
}));

test('a later compilation failure preserves every previous output and the manifest', async () => fixture(async root => {
  const project = await loadProject(root);
  await syncProject(project);
  const files = ['one.mjs', 'two.mjs', 'manifest.json'];
  const before = await Promise.all(files.map(async file => ({ text: await readFile(path.join(project.outDir, file), 'utf8'), mtime: (await stat(path.join(project.outDir, file))).mtimeMs })));
  await writeFile(path.join(root, 'One.jsx'), 'export default ()=> <main><p>Updated</p></main>');
  await writeFile(path.join(root, 'Two.jsx'), 'export default ()=> <section>');
  await assert.rejects(syncProject(project));
  for (const [index, file] of files.entries()) {
    assert.equal(await readFile(path.join(project.outDir, file), 'utf8'), before[index].text);
    assert.equal((await stat(path.join(project.outDir, file))).mtimeMs, before[index].mtime);
  }
  assert.deepEqual((await readdir(project.outDir)).sort(), files.sort());
}));

test('a failed commit restores the init report, deleted outputs and manifest together', async t => fixture(async root => {
  const project = await loadProject(root);
  await syncProject(project);
  const reportFile = path.join(project.outDir, 'init-report.json');
  await writeFile(reportFile, 'previous report');
  const before = new Map(await Promise.all(['one.mjs', 'two.mjs', 'manifest.json', 'init-report.json'].map(async name =>
    [name, await readFile(path.join(project.outDir, name), 'utf8')] as const)));
  const rename = fs.rename;
  let failed = false;
  const mocked = t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
    if (!failed && args[1] === path.join(project.outDir, 'manifest.json')) {
      failed = true;
      throw new Error('Simulated manifest commit failure');
    }
    return rename(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(withProjectLock(project.outDir, () => commitOutputs(project.outDir, new Map([
      ['init-report.json', 'new report'], ['one.mjs', null], ['new.mjs', 'new artifact'], ['manifest.json', 'new manifest'],
    ]))), /Simulated manifest commit failure/);
    for (const [name, content] of before) assert.equal(await readFile(path.join(project.outDir, name), 'utf8'), content);
    assert.deepEqual((await readdir(project.outDir)).sort(), [...before.keys()].sort());
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
}));

test('independent processes serialize sync and readers; hint edits do not lose other targets', async () => fixture(async root => {
  const project = await loadProject(root);
  const marker = path.join(root, 'requested');
  let child: ReturnType<typeof execute> | undefined;
  await withProjectLock(project.outDir, async () => {
    child = execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import {writeFile} from 'node:fs/promises';import{loadProject,syncProject}from ${JSON.stringify(new URL('../src/generator.ts', import.meta.url).href)};await writeFile(${JSON.stringify(marker)},'ready');await syncProject(await loadProject(${JSON.stringify(root)}));`]);
    const started = Date.now();
    while (!(await readdir(root)).includes('requested')) { if (Date.now() - started > 5000) throw new Error('Child did not start'); await delay(10); }
    assert.deepEqual(await readdir(project.outDir), ['.skelcast-lock']);
    // Reentrancy lets init's outer transaction invoke generation safely.
    await syncProject(project);
  });
  await child;
  assert.ok((await checkProject(project)).every(row => row.state === 'ready'));
  await Promise.all([saveHints(project, 'one', { repeat: 2 }), saveHints(project, 'two', { lines: 3 })]);
  assert.deepEqual(JSON.parse(await readFile(project.hintsFile, 'utf8')), { one: { repeat: 2 }, two: { lines: 3 } });
}));

test('a reader recovers a killed writer before returning artifacts or freshness', async () => fixture(async root => {
  const project = await loadProject(root);
  await syncProject(project);
  const previous = await readFile(path.join(project.outDir, 'one.mjs'), 'utf8');
  const stage = `.skelcast-stage-${randomUUID()}`;
  await mkdir(path.join(project.outDir, stage, 'backup'), { recursive: true });
  await writeFile(path.join(project.outDir, stage, 'backup', 'one.mjs'), previous);
  await writeFile(path.join(project.outDir, 'one.mjs'), 'interrupted output');
  await writeFile(path.join(project.outDir, '.skelcast-transaction.json'), JSON.stringify({ stage, files: [{ name: 'one.mjs', existed: true }, { name: 'orphan.mjs', existed: false }] }));
  await writeFile(path.join(project.outDir, 'orphan.mjs'), 'partial new output');
  await mkdir(path.join(project.outDir, '.skelcast-lock'));
  await writeFile(path.join(project.outDir, '.skelcast-lock/owner.json'), JSON.stringify({ pid: 99999999, host: os.hostname() }));
  assert.ok((await checkProject(project)).every(row => row.state === 'ready'));
  assert.equal(await readFile(path.join(project.outDir, 'one.mjs'), 'utf8'), previous);
  assert.deepEqual((await readdir(project.outDir)).sort(), ['manifest.json', 'one.mjs', 'two.mjs']);
}));
