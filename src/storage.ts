import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const held = new AsyncLocalStorage<Set<string>>();
const journalName = '.skelcast-transaction.json';
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
interface Owner { pid: number; host: string }

async function abandoned(lock: string): Promise<boolean> {
  try {
    const owner: Owner = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
    if (owner.host !== hostname()) return false;
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  } catch (error) {
    if (!missing(error) && !(error instanceof SyntaxError)) throw error;
    // A writer may still be creating its ownership record.
    try { return Date.now() - (await stat(lock)).mtimeMs > 30000; }
    catch (error) { if (missing(error)) return false; throw error; }
  }
}

/** Serializes CLI, init, dev-server writes and readers across processes. Nested
 * operations in the same asynchronous call chain share the existing lock. */
export async function withProjectLock<T>(outDir: string, action: () => Promise<T>): Promise<T> {
  await mkdir(outDir, { recursive: true });
  outDir = await realpath(outDir);
  if (held.getStore()?.has(outDir)) return action();
  const lock = path.join(outDir, '.skelcast-lock');
  const started = Date.now();
  for (;;) {
    try { await mkdir(lock); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (await abandoned(lock)) {
      // Only one contender may reclaim a dead writer. Recheck under this gate
      // so a second contender cannot remove a newly acquired, live lock.
      const recovery = `${lock}-recovery`;
      try {
        await mkdir(recovery);
        try { if (await abandoned(lock)) await rm(lock, { recursive: true, force: true }); }
        finally { await rm(recovery, { recursive: true, force: true }); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    if (Date.now() - started > 30000) throw new Error(`Timed out waiting for SkelCast output lock: ${lock}`);
    await delay(25);
  }
  try {
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname() }));
    return await held.run(new Set([...held.getStore() ?? [], outDir]), async () => {
      await recoverOutputs(outDir);
      return action();
    });
  } finally { await rm(lock, { recursive: true, force: true }); }
}

interface Journal { stage: string; files: { name: string; existed: boolean }[] }
const outputName = (name: string) => name === 'manifest.json' || /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.mjs$/.test(name);
async function recoverOutputs(outDir: string): Promise<void> {
  let journal: Journal;
  try { journal = JSON.parse(await readFile(path.join(outDir, journalName), 'utf8')); }
  catch (error) { if (missing(error)) return; throw error; }
  if (!/^\.skelcast-stage-[a-f0-9-]+$/.test(journal.stage) || !Array.isArray(journal.files) || journal.files.some(file => !outputName(file.name) || typeof file.existed !== 'boolean')) throw new Error('Invalid SkelCast transaction journal');
  for (const file of journal.files) {
    const destination = path.join(outDir, file.name);
    if (file.existed) await atomicWrite(destination, await readFile(path.join(outDir, journal.stage, 'backup', file.name), 'utf8'));
    else await unlink(destination).catch(error => { if (!missing(error)) throw error; });
  }
  await unlink(path.join(outDir, journalName));
  await rm(path.join(outDir, journal.stage), { recursive: true, force: true });
}

export async function atomicWrite(file: string, content: string): Promise<void> {
  try { if (await readFile(file, 'utf8') === content) return; }
  catch (error) { if (!missing(error)) throw error; }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, content); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

/** Call under withProjectLock. Stage every output before changing owned files;
 * retain a recovery journal until the manifest and all outputs are committed. */
export async function commitOutputs(outDir: string, updates: Map<string, string | null>): Promise<void> {
  const changes: { name: string; content: string | null; existed: boolean }[] = [];
  for (const [name, content] of updates) {
    if (!outputName(name)) throw new Error(`Invalid generated output: ${name}`);
    let previous: string | null = null;
    try { previous = await readFile(path.join(outDir, name), 'utf8'); }
    catch (error) { if (!missing(error)) throw error; }
    if (previous !== content) changes.push({ name, content, existed: previous !== null });
  }
  if (!changes.length) return;
  const stage = `.skelcast-stage-${randomUUID()}`;
  const directory = path.join(outDir, stage);
  const journal: Journal = { stage, files: [] };
  await mkdir(path.join(directory, 'next'), { recursive: true });
  await mkdir(path.join(directory, 'backup'));
  let journalWritten = false;
  try {
    for (const { name, content, existed } of changes) {
      if (existed) await copyFile(path.join(outDir, name), path.join(directory, 'backup', name));
      if (content !== null) await writeFile(path.join(directory, 'next', name), content);
      journal.files.push({ name, existed });
    }
    await atomicWrite(path.join(outDir, journalName), JSON.stringify(journal));
    journalWritten = true;
    for (const { name, content } of changes) {
      if (content === null) await unlink(path.join(outDir, name));
      else await rename(path.join(directory, 'next', name), path.join(outDir, name));
    }
    await unlink(path.join(outDir, journalName));
    journalWritten = false;
  } catch (error) {
    if (journalWritten) { await recoverOutputs(outDir); journalWritten = false; }
    throw error;
  } finally {
    // Keep backups if recovery itself fails; the next operation retries recovery.
    if (!journalWritten) await rm(directory, { recursive: true, force: true });
  }
}
