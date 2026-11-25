import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { checkProject, loadProject, saveHints, syncProject } from '../src/generator.js';
import { withProjectLock } from '../src/storage.js';

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
