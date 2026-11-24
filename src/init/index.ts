import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluate, UNKNOWN } from '../compiler/expression.js';
import { digest } from '../compiler/styles.js';
import { projectFromConfig, syncProject } from '../generator.js';
import type { SkeletonConfig } from '../types.js';
import { applyEdits, objectConfig, parseCode, type Ast } from './ast.js';
import { analyzeReact } from './react.js';
import { inferredRoute, isPageFile, relativePath, resolveSource, scanProject } from './scan.js';
import { analyzeVue } from './vue.js';
import { integrateVite } from './vite.js';
import type { InitChange, InitOptions, InitReport } from './types.js';
export type { InitChange, InitDiagnostic, InitOptions, InitReport } from './types.js';

async function optionalRead(file: string): Promise<string | null> {
  try { return await readFile(file, 'utf8'); } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}
function hasUnknown(value: unknown): boolean {
  return value === UNKNOWN || value != null && typeof value === 'object' && Object.values(value).some(hasUnknown);
}
function literalConfig(code: string): { config: SkeletonConfig; object: Ast; ast: Ast } {
  const ast = parseCode(code), object = objectConfig(ast);
  if (!object) throw new Error('Existing SkelCast config is not a static object; preserve it and integrate targets manually');
  const config = evaluate(object, { code, env: {}, bindings: {} }) as SkeletonConfig;
  if (hasUnknown(config) || !Array.isArray(config.targets)) throw new Error('Existing SkelCast config contains dynamic values; init will not overwrite it');
  return { config, object, ast };
}
function insertItems(code: string, node: Ast, items: string[], existing: Ast[]): { start: number; end: number; text: string } {
  const last = existing.at(-1);
  const comma = last && !code.slice(last.end, node.end - 1).includes(',') ? ',' : '';
  return { start: node.end - 1, end: node.end - 1, text: `${comma}\n${items.join(',\n')}\n` };
}
export async function initProject(directory = process.cwd(), options: InitOptions = {}): Promise<InitReport> {
  const root = await realpath(path.resolve(directory));
  const manifestText = await readFile(path.join(root, 'package.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const report: InitReport = { root, dryRun: options.dryRun ?? false, scanned: 0, targets: [], changes: [], diagnostics: [] };
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  if (typeof dependencies.vue === 'string' && /^[~^\s]*2\./.test(dependencies.vue)) {
    report.diagnostics.push({ code: 'VUE_VERSION', file: 'package.json', message: 'Vue 2 requires a separate runtime adapter; init supports Vue 3' }); return report;
  }
  if (dependencies.next || dependencies.nuxt || dependencies['@nuxt/kit']) {
    report.diagnostics.push({ code: 'SSR_FRAMEWORK', file: 'package.json', message: 'Next/Nuxt need their own loading adapters; init currently integrates Vite React/Vue projects' }); return report;
  }
  const vite = await integrateVite(root, manifest);
  report.diagnostics.push(...vite.diagnostics);
  const configRoot = vite.configRoot ?? root;
  if (vite.diagnostics.some(d => ['VITE_ROOT_DYNAMIC', 'VITE_MULTIPLE_CONFIGS', 'VITE_CONFIG_UNSUPPORTED', 'BUNDLER_UNSUPPORTED'].includes(d.code))) return report;
  if (manifest.name !== 'skelcast' && !dependencies.skelcast) {
    report.diagnostics.push({ code: 'DEPENDENCY_REQUIRED', file: 'package.json', message: 'Install SkelCast in this project first: pnpm add -D skelcast' });
    if (!report.dryRun) return report;
  }
  const configFile = relativePath(root, path.join(configRoot, 'skelcast.config.mjs'));
  const existingText = await optionalRead(path.join(root, configFile));
  let existing: SkeletonConfig = { targets: [] }, configObject: Ast;
  if (existingText != null) {
    try { const parsed = literalConfig(existingText); existing = parsed.config; configObject = parsed.object; }
    catch (error) { report.diagnostics.push({ code: 'CONFIG_DYNAMIC', file: configFile, message: String(error) }); return report; }
  }
  const scan = await scanProject(root, vite.aliases);
  report.scanned = scan.files.length;
  report.diagnostics.push(...scan.diagnostics);
  const usedIds = new Set(existing.targets.map(t => t.id));
  const globalStyles = new Set<string>();
  for (const source of scan.files) if (/^(?:src\/)?(?:main|index|App)\.(?:tsx?|jsx?)$/.test(source.file)) {
    for (const n of source.ast.program.body) if (n.type === 'ImportDeclaration' && /\.css$/.test(n.source.value)) {
      const file = await resolveSource(root, source.file, n.source.value, scan.aliases);
      if (file) globalStyles.add(relativePath(configRoot, path.resolve(root, file)));
    }
  }
  const hasPageDirectories = scan.files.some(f => /(?:^|\/)(?:pages|views)\//.test(f.file) && !/(?:^|\/)components\//.test(f.file));
  const aliases = Object.fromEntries(Object.entries(scan.aliases).map(([key, value]) => [key, relativePath(configRoot, path.resolve(root, value)) || '.']));
  Object.assign(aliases, existing.aliases);
  for (const source of scan.files) {
    const routes = [...scan.routes.get(source.file) ?? []].sort();
    const page = routes.length > 0 || isPageFile(source, scan.routes.size > 0 || hasPageDirectories);
    if (page && !routes.length) {
      const route = inferredRoute(source.file);
      if (route) { routes.push(route); report.diagnostics.push({ code: 'ROUTE_CONVENTION', file: source.file, message: `Inferred ${route} from file location; verify against your router` }); }
      else report.diagnostics.push({ code: 'ROUTE_UNKNOWN', file: source.file, message: 'Page boundary identified; initial HTML route must be configured manually' });
    }
    try {
      const ctx = { file: source.file, source: source.code, page, routes, existing, usedIds };
      const analysis = source.vue ? analyzeVue(ctx) : analyzeReact(ctx);
      report.diagnostics.push(...analysis.diagnostics);
      if (!analysis.targets.length) continue;
      const changed = applyEdits(source.code, analysis.edits);
      report.changes.push({ file: source.file, before: source.code, after: changed, reason: `Integrate ${analysis.targets.length} loading boundaries` });
      report.targets.push(...analysis.targets.map(t => ({ ...t, source: relativePath(configRoot, path.resolve(root, t.source)), ...(globalStyles.size ? { styles: [...globalStyles].sort() } : {}) })));
    } catch (error) { report.diagnostics.push({ code: 'CODEMOD_SKIPPED', file: source.file, message: String(error) }); }
  }
  if (!report.targets.length && !existing.targets.length) {
    report.diagnostics.push({ code: 'NO_TARGETS', file: '.', message: 'No supported page or loading region found; declare a target manually' }); return report;
  }
  if (existingText == null) {
    const config: SkeletonConfig = { ...(Object.keys(aliases).length ? { aliases } : {}), targets: report.targets };
    report.changes.push({ file: configFile, before: null, after: `// Generated by skelcast init. Source remains the layout authority.\nexport default ${JSON.stringify(config, null, 2)};\n`, reason: 'Create source-derived skeleton targets' });
  } else {
    const edits = [];
    if (report.targets.length) {
      const targets = configObject!.properties.find((p: Ast) => p.type === 'ObjectProperty' && (p.key.name ?? p.key.value) === 'targets').value;
      edits.push(insertItems(existingText, targets, report.targets.map(t => JSON.stringify(t, null, 2)), targets.elements));
    }
    const missingAliases = Object.entries(aliases).filter(([key]) => !Object.hasOwn(existing.aliases ?? {}, key));
    if (missingAliases.length) {
      const prop = configObject!.properties.find((p: Ast) => p.type === 'ObjectProperty' && (p.key.name ?? p.key.value) === 'aliases');
      if (prop) edits.push(insertItems(existingText, prop.value, missingAliases.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`), prop.value.properties));
      else edits.push({ start: configObject!.start + 1, end: configObject!.start + 1, text: `\n  aliases: ${JSON.stringify(Object.fromEntries(missingAliases))},\n` });
    }
    if (edits.length) report.changes.push({ file: configFile, before: existingText, after: applyEdits(existingText, edits), reason: 'Append discovered targets without replacing existing configuration' });
  }
  report.changes.push(...vite.changes);
  const configRelativeSources = scan.files.map(f => relativePath(configRoot, path.join(root, f.file)));
  const envFile = relativePath(root, path.join(configRoot, configRelativeSources.some(f => f.startsWith('src/')) ? 'src/skelcast-env.d.ts' : 'skelcast-env.d.ts'));
  const env = await optionalRead(path.join(root, envFile));
  if (!env?.includes('skelcast/virtual')) report.changes.push({ file: envFile, before: env, after: `/// <reference types="skelcast/virtual" />\n${env ?? ''}`, reason: 'Declare generated virtual module types' });
  if (report.dryRun) return report;
  // Verify every planned edit before writing; a concurrent user edit is never overwritten.
  for (const change of report.changes) if (await optionalRead(path.join(root, change.file)) !== change.before) throw new Error(`${change.file} changed during init; run init again`);
  const outDir = path.resolve(configRoot, existing.outDir ?? '.skelcast');
  const backup = relativePath(root, path.join(outDir, 'init-backups', `${Date.now()}-${digest(report.changes.map(c => c.after).join()).slice(0, 8)}`));
  const generatedBefore = new Map<string, string | null>();
  for (const id of [...new Set([...existing.targets, ...report.targets].map(t => t.id))]) if (/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
    const file = path.join(outDir, `${id}.mjs`); generatedBefore.set(file, await optionalRead(file));
  }
  generatedBefore.set(path.join(outDir, 'manifest.json'), await optionalRead(path.join(outDir, 'manifest.json')));
  const applied: InitChange[] = [];
  if (report.changes.length) {
    report.backup = backup;
    for (const change of report.changes) if (change.before != null) {
      const file = path.join(root, backup, change.file);
      await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, change.before);
    }
  }
  try {
    for (const change of report.changes) {
      if (await optionalRead(path.join(root, change.file)) !== change.before) throw new Error(`${change.file} changed during init; run init again`);
      const file = path.join(root, change.file); await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.skelcast-init-${process.pid}.tmp`;
      await writeFile(temporary, change.after); await rename(temporary, file); applied.push(change);
    }
    const finalConfig = report.changes.find(c => c.file === configFile)?.after ?? existingText!;
    report.generated = await syncProject(await projectFromConfig(configRoot, literalConfig(finalConfig).config));
    const reportFile = path.join(outDir, 'init-report.json');
    await writeFile(reportFile, JSON.stringify({ scanned: report.scanned, targets: report.targets, changes: report.changes.map(({ file, reason }) => ({ file, reason })), diagnostics: report.diagnostics, backup: report.backup }, null, 2) + '\n');
  } catch (error) {
    // Generated modules are owned outputs; restore even a partially completed sync.
    for (const [file, content] of generatedBefore) {
      if (content == null) await unlink(file).catch(() => {});
      else { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); }
    }
    for (const change of applied.reverse()) {
      const file = path.join(root, change.file);
      // Roll back only bytes written by this run, preserving subsequent user edits.
      if (await optionalRead(file) !== change.after) continue;
      if (change.before == null) await unlink(file); else await writeFile(file, change.before);
    }
    throw error;
  }
  return report;
}
