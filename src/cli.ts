#!/usr/bin/env node
import { loadProject, syncProject, checkProject, readArtifact } from './generator.js';
import { initProject } from './init/index.js';
import { qualityProject, createQualityBaseline, compareQualityBaseline } from './quality.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './storage.js';

const usage = 'Usage: skelcast <init|sync|check|inspect|quality|audit> [--root directory] [--dry-run] [--id target] [--json] [--strict]\nquality: [--save-baseline file] [--baseline file]\naudit: --url http://localhost:5173 [--id target] [--viewports 1440x900,390x844] [--out directory] [--storage-state file]';
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return; }
  const command = args[0];
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index < 0) return;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    return value;
  };
  if (!['init', 'sync', 'check', 'inspect', 'quality', 'audit'].includes(command)) throw new Error(usage);
  if (command === 'audit') {
    const { auditProject, parseViewports } = await import('./audit.js');
    const url = option('--url');
    if (!url) throw new Error('audit requires --url <development URL>');
    const outDir = option('--out') ?? '.skelcast-audit';
    const report = await auditProject({ url, outDir, id: option('--id'), viewports: parseViewports(option('--viewports')), storageState: option('--storage-state') });
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : `${report.cases.length} layout measurements: ${report.needsReview ? 'needs review' : 'within tolerance'}. Report: ${outDir}/index.html`);
    if (report.needsReview) process.exitCode = 1;
    return;
  }
  if (command === 'init') {
    const report = await initProject(option('--root') ?? process.cwd(), { dryRun: args.includes('--dry-run') });
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`${report.dryRun ? 'Planned' : report.generated ? 'Initialized' : 'Needs review'} ${report.targets.length} new targets, ${report.changes.length} files (${report.scanned} source files scanned)`);
      for (const change of report.changes) console.log(`${report.dryRun ? 'plan' : 'updated'}    ${change.file} — ${change.reason}`);
      for (const diagnostic of report.diagnostics) console.log(`review     ${diagnostic.file}: ${diagnostic.code} — ${diagnostic.message}`);
      if (report.backup) console.log(`backup     ${report.backup}`);
    }
    if (!report.dryRun && !report.generated) process.exitCode = 1;
    return;
  }
  const project = await loadProject(option('--root') ?? process.cwd());
  const id = option('--id');
  if (command === 'inspect' && !id) throw new Error('inspect requires --id <target>');
  if (command === 'quality') {
    const result = await qualityProject(project, id);
    const baselineFile = option('--baseline'), saveFile = option('--save-baseline');
    if (baselineFile && saveFile) throw new Error('Use --baseline or --save-baseline, not both');
    const progress = baselineFile ? compareQualityBaseline(result, JSON.parse(await readFile(path.resolve(project.root, baselineFile), 'utf8'))) : undefined;
    if (saveFile) await atomicWrite(path.resolve(project.root, saveFile), JSON.stringify(createQualityBaseline(result), null, 2) + '\n');
    const rows = result.map(row => ({ ...row, ...(progress ? { progress: progress[row.id] } : {}) }));
    if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2));
    else for (const row of rows) console.log(`${row.needsReview ? 'review' : 'ready'}    ${row.id} — ${'variants' in row ? `${row.review.locations} review locations; ${Object.entries(row.variants).map(([name, view]) => `${name}: ${view.placeholders} placeholders, ${view.fallbacks} fallbacks`).join('; ')}` : row.reason}${row.progress ? `; ${row.progress.resolved} resolved, ${row.progress.added} added since baseline` : ''}`);
    if (args.includes('--strict') && result.some(row => row.needsReview)) process.exitCode = 1;
    return;
  }
  const output = command === 'sync' ? await syncProject(project) : command === 'check' ? await checkProject(project) : await readArtifact(project, id!);
  if (args.includes('--json') || command === 'inspect') console.log(JSON.stringify(output, null, 2));
  else if (Array.isArray(output)) for (const row of output) console.log(`${row.state.padEnd(10)} ${row.id}${'reason' in row && row.reason ? ` — ${row.reason}` : ''}${'diagnostics' in row ? ` (${row.diagnostics} diagnostics)` : ''}`);
  if (command === 'check' && Array.isArray(output) && output.some(row => row.state !== 'ready')) process.exitCode = 1;
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
