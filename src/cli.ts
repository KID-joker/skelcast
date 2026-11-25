#!/usr/bin/env node
import { loadProject, syncProject, checkProject, readArtifact } from './generator.js';
import { initProject } from './init/index.js';
import { qualityProject } from './quality.js';

const usage = 'Usage: skelcast <init|sync|check|inspect|quality> [--root directory] [--dry-run] [--id target] [--json] [--strict]';
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
  if (!['init', 'sync', 'check', 'inspect', 'quality'].includes(command)) throw new Error(usage);
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
    if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else for (const row of result) console.log(`${row.needsReview ? 'review' : 'ready'}    ${row.id} — ${'variants' in row ? Object.entries(row.variants).map(([name, view]) => `${name}: ${view.placeholders} placeholders, ${view.fallbacks} fallbacks`).join('; ') : row.reason}`);
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
