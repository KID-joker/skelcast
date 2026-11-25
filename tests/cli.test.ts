import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
const cli = path.resolve('src/cli.ts');
async function run(root: string, ...args: string[]) {
  try {
    const result = await execute(process.execPath, ['--import', 'tsx', cli, ...args, '--root', root, '--json']);
    return { code: 0, ...result };
  } catch (error: any) {
    return { code: error.code, stdout: error.stdout as string, stderr: error.stderr as string };
  }
}
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-cli-'));
  try {
    await writeFile(path.join(root, 'View.tsx'), `const layout=privateLayout(); throw new Error('never execute');\nexport default ()=> <section style={{width:layout.width,height:layout.height}}><span>Layout</span></section>`);
    await writeFile(path.join(root, 'skelcast.config.mjs'), `export default { targets: [{id:'layout',source:'View.tsx',variants:{wide:{bindings:{'layout.width':600}},tall:{bindings:{'layout.height':480}}}},{id:'other',source:'View.tsx'}] };`);
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('diagnose supplies scoped source repair context without executing business code or writing hints', async () => {
  await fixture(async root => {
    assert.equal((await run(root, 'sync')).code, 0);
    const raw = JSON.parse((await run(root, 'inspect', '--id', 'layout')).stdout);
    assert.ok(raw.variants.wide.html); // Existing raw inspect contract stays available.
    const before = await readFile(path.join(root, '.skelcast/layout.mjs'), 'utf8');
    const result = await run(root, 'diagnose', '--id', 'layout', '--json');
    assert.equal(result.code, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.state, 'ready');
    assert.equal(report.needsReview, true);
    assert.deepEqual(Object.keys(report.variants), ['wide', 'tall']);
    const wide = report.variants.wide.locations[0];
    assert.deepEqual(wide.examples[0].bindings, { 'View.tsx::layout.height': 96 });
    assert.deepEqual(report.variants.tall.locations[0].examples[0].bindings, { 'View.tsx::layout.width': 320 });
    assert.equal(wide.source.file, 'View.tsx');
    assert.equal(wide.source.line, 2);
    assert.deepEqual(report.variants.wide.evidence, raw.evidence.filter((e: { variants?: string[] }) => !e.variants || e.variants.includes('wide')));
    assert.equal(report.variants.wide.html, undefined);
    const scoped = JSON.parse((await run(root, 'diagnose', '--id', 'layout', '--node', wide.node, '--variant', 'wide')).stdout);
    assert.deepEqual(Object.keys(scoped.variants), ['wide']);
    assert.equal(scoped.variants.wide.locations.length, 1);
    assert.equal((await run(root, 'diagnose', '--id', 'layout', '--strict')).code, 1);
    assert.equal((await run(root, 'diagnose', '--id', 'layout', '--node', 'typo')).code, 1);
    assert.equal((await run(root, 'diagnose', '--id', 'layout', '--variant', 'typo')).code, 1);
    assert.equal(await readFile(path.join(root, '.skelcast/layout.mjs'), 'utf8'), before);
    await assert.rejects(readFile(path.join(root, 'skelcast.hints.json')), { code: 'ENOENT' });
  });
});

test('hints validates patches, retains unrelated targets and omitted bindings, then explicit sync repairs the result', async () => {
  await fixture(async root => {
    await writeFile(path.join(root, 'skelcast.hints.json'), JSON.stringify({ other: { lines: 3 }, layout: { bindings: { 'View.tsx::layout.width': 320, 'View.tsx::layout.height': 96 } } }));
    await run(root, 'sync');
    const artifact = await readFile(path.join(root, '.skelcast/layout.mjs'), 'utf8');
    await writeFile(path.join(root, 'patch.json'), '{"repeat":5}');
    const saved = await run(root, 'hints', '--id', 'layout', '--file', 'patch.json');
    assert.equal(saved.code, 0);
    assert.equal(JSON.parse(saved.stdout).hints.repeat, 5);
    let hints = JSON.parse(await readFile(path.join(root, 'skelcast.hints.json'), 'utf8'));
    assert.deepEqual(hints.other, { lines: 3 });
    assert.equal(hints.layout.bindings['View.tsx::layout.width'], 320);
    assert.equal(await readFile(path.join(root, '.skelcast/layout.mjs'), 'utf8'), artifact);
    assert.equal(JSON.parse((await run(root, 'diagnose', '--id', 'layout')).stdout).state, 'stale');
    assert.equal((await run(root, 'check')).code, 1);
    const before = await readFile(path.join(root, 'skelcast.hints.json'), 'utf8');
    for (const patch of ['{"repeat":25}', '{"unknown":true}', '[]', '{broken']) {
      await writeFile(path.join(root, 'patch.json'), patch);
      assert.equal((await run(root, 'hints', '--id', 'layout', '--file', 'patch.json')).code, 1);
      assert.equal(await readFile(path.join(root, 'skelcast.hints.json'), 'utf8'), before);
    }
    await run(root, 'sync');
    assert.equal((await run(root, 'diagnose', '--id', 'layout', '--strict')).code, 0);
    await writeFile(path.join(root, 'patch.json'), '{"bindings":{}}');
    await run(root, 'hints', '--id', 'layout', '--file', 'patch.json');
    hints = JSON.parse(await readFile(path.join(root, 'skelcast.hints.json'), 'utf8'));
    assert.deepEqual(hints.layout.bindings, {});
    assert.deepEqual(hints.other, { lines: 3 });
    await run(root, 'sync');
    assert.equal((await run(root, 'diagnose', '--id', 'layout', '--strict')).code, 1);
  });
});

test('diagnose reports unavailable artifacts and rejects missing selectors without fabricating repair context', async () => {
  await fixture(async root => {
    const missing = JSON.parse((await run(root, 'diagnose', '--id', 'layout')).stdout);
    assert.equal(missing.state, 'missing');
    assert.equal(missing.needsReview, true);
    assert.deepEqual(missing.variants, {});
    assert.equal((await run(root, 'diagnose')).code, 1);
    assert.equal((await run(root, 'diagnose', '--id', 'unknown')).code, 1);
    assert.equal((await run(root, 'hints', '--id', 'layout')).code, 1);
    await run(root, 'sync');
    await writeFile(path.join(root, '.skelcast/layout.mjs'), 'throw new Error("never execute corrupt artifacts")');
    const corrupt = JSON.parse((await run(root, 'diagnose', '--id', 'layout', '--strict')).stdout);
    assert.equal(corrupt.state, 'corrupt');
    assert.deepEqual(corrupt.variants, {});
  });
});
