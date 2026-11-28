import type * as t from '@babel/types';
import { readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { evaluate, UNKNOWN } from '../compiler/expression.js';
import { digest } from '../compiler/styles.js';
import { prepareProjectSync, projectFromConfig } from '../generator.js';
import { atomicWrite, commitOutputs, withProjectLock } from '../storage.js';
import type { SkeletonConfig } from '../types.js';
import { stylesheetImports } from '../compiler/stylesheet-source.js';
import { applyEdits, objectConfig } from './ast.js';
import { startOf, endOf, nodeName, parseSource, type Ast } from '../compiler/ast.js';
import { analyzeReact } from './react.js';
import { inferredRoute, isPageFile, relativePath, resolveSource, scanProject } from './scan.js';
import { analyzeVue } from './vue.js';
import { integrateVite } from './vite.js';
import { integrateTypeResolution } from './tsconfig.js';
import { requestContexts } from './contexts.js';
import { requestStateChanges } from './requests.js';
import { parse as parseSFC } from '@vue/compiler-sfc';
import type { InitChange, InitOptions, InitReport } from './types.js';
export type { InitChange, InitDiagnostic, InitOptions, InitReport } from './types.js';

async function optionalRead(file: string): Promise<string | null> {
  try { return await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function hasUnknown(value: unknown): boolean {
  return value === UNKNOWN || value != null && typeof value === 'object' && Object.values(value).some(hasUnknown);
}
function literalConfig(code: string): { config: SkeletonConfig; object: t.ObjectExpression; ast: t.File } {
  const ast = parseSource(code), object = objectConfig(ast);
  if (!object) throw new Error('Existing SkelCast config is not a static object; preserve it and integrate targets manually');
  const config = evaluate(object, { code, env: {}, bindings: {} }) as SkeletonConfig;
  if (hasUnknown(config) || !Array.isArray(config.targets)) throw new Error('Existing SkelCast config contains dynamic values; init will not overwrite it');
  return { config, object, ast };
}
function insertItems(code: string, node: Ast, items: string[], existing: (Ast | null)[]): { start: number; end: number; text: string } {
  const last = existing.filter((node): node is Ast => node != null).at(-1);
  const comma = last && !code.slice(endOf(last), endOf(node) - 1).includes(',') ? ',' : '';
  return { start: endOf(node) - 1, end: endOf(node) - 1, text: `${comma}\n${items.join(',\n')}\n` };
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
  let existing: SkeletonConfig = { targets: [] }, configObject: t.ObjectExpression;
  if (existingText != null) {
    try { const parsed = literalConfig(existingText); existing = parsed.config; configObject = parsed.object; }
    catch (error) { report.diagnostics.push({ code: 'CONFIG_DYNAMIC', file: configFile, message: String(error) }); return report; }
  }
  const scan = await scanProject(root, vite.aliases);
  const requestChanges = await requestStateChanges(root, scan.files, scan.aliases);
  report.scanned = scan.files.length;
  report.diagnostics.push(...scan.diagnostics);
  const usedIds = new Set(existing.targets.map(t => t.id));
  const globalStyles = new Set<string>();
  for (const source of scan.files) if (/^(?:src\/)?(?:main|index|App)\.(?:tsx?|jsx?)$/.test(source.file)) {
    for (const request of stylesheetImports(source.ast)) {
      const file = await resolveSource(root, source.file, request, scan.aliases);
      if (file) globalStyles.add(relativePath(configRoot, path.resolve(root, file)));
    }
  }
  const hasPageDirectories = scan.files.some(f => /(?:^|\/)(?:pages|views)\//.test(f.file) && !/(?:^|\/)components\//.test(f.file));
  const aliases = Object.fromEntries(Object.entries(scan.aliases).map(([key, value]) => [key, relativePath(configRoot, path.resolve(root, value)) || '.']));
  Object.assign(aliases, existing.aliases);
  for (const original of scan.files) {
    let source = original;
    const updated = requestChanges.get(source.file);
    if (updated) {
      const sfc = source.vue ? parseSFC(updated, { filename: source.file }) : undefined;
      const script = sfc ? sfc.descriptor.scriptSetup!.content : updated;
      source = { ...source, code: updated, sfc, ast: parseSource(script, source.file, sfc?.descriptor.scriptSetup?.lang === 'tsx') };
    }
    const routes = [...scan.routes.get(source.file) ?? []].sort();
    const page = routes.length > 0 || isPageFile(source, scan.routes.size > 0 || hasPageDirectories);
    if (page && !routes.length) {
      const route = inferredRoute(source.file);
      if (route) { routes.push(route); report.diagnostics.push({ code: 'ROUTE_CONVENTION', file: source.file, message: `Inferred ${route} from file location; verify against your router` }); }
      else report.diagnostics.push({ code: 'ROUTE_UNKNOWN', file: source.file, message: 'Page boundary identified; initial HTML route must be configured manually' });
    }
    try {
      const ctx = { file: source.file, source: source.code, ast: source.ast, sfc: source.sfc, page, routes, existing, usedIds };
      const analysis = source.vue ? analyzeVue(ctx) : analyzeReact(ctx);
      report.diagnostics.push(...analysis.diagnostics);
      if (!analysis.targets.length && !updated) continue;
      const changed = applyEdits(source.code, analysis.edits);
      report.changes.push({ file: source.file, before: original.code, after: changed, reason: updated ? 'Connect source-proven request ownership and pending state' : `Integrate ${analysis.targets.length} loading boundaries` });
      report.targets.push(...analysis.targets.map(t => ({ ...t, source: relativePath(configRoot, path.resolve(root, t.source)), ...(globalStyles.size ? { styles: [...globalStyles].sort() } : {}) })));
    } catch (error) { report.diagnostics.push({ code: 'CODEMOD_SKIPPED', file: source.file, message: String(error) }); }
  }
  const contexts = await requestContexts(root, configRoot, scan.files, report.changes, [...existing.targets,...report.targets], scan.aliases, report.diagnostics);
  for (const target of report.targets) if (contexts.has(target.id)) target.contexts = contexts.get(target.id);
  if (!report.targets.length && !existing.targets.length) {
    report.diagnostics.push({ code: 'NO_TARGETS', file: '.', message: 'No supported page or loading region found; declare a target manually' }); return report;
  }
  if (existingText == null) {
    const config: SkeletonConfig = { ...(Object.keys(aliases).length ? { aliases } : {}), targets: report.targets };
    report.changes.push({ file: configFile, before: null, after: `// Generated by skelcast init. Source remains the layout authority.\nexport default ${JSON.stringify(config, null, 2)};\n`, reason: 'Create source-derived skeleton targets' });
  } else {
    const edits = [];
    if (report.targets.length) {
      const property = configObject!.properties.find(p => p.type === 'ObjectProperty' && nodeName(p.key) === 'targets');
      if (property?.type !== 'ObjectProperty' || property.value.type !== 'ArrayExpression') throw new Error('Static targets array required');
      const targets = property.value;
      edits.push(insertItems(existingText, targets, report.targets.map(t => JSON.stringify(t, null, 2)), targets.elements));
    }
    for (const target of existing.targets) {
      const mapping=contexts.get(target.id);
      if(!mapping||JSON.stringify(mapping)===JSON.stringify(target.contexts))continue;
      const targetsProperty=configObject!.properties.find(p=>p.type==='ObjectProperty'&&nodeName(p.key)==='targets');
      if(targetsProperty?.type!=='ObjectProperty'||targetsProperty.value.type!=='ArrayExpression')continue;
      const object=targetsProperty.value.elements.find(p=>p?.type==='ObjectExpression'&&p.properties.some(property=>property.type==='ObjectProperty'&&nodeName(property.key)==='id'&&property.value.type==='StringLiteral'&&property.value.value===target.id));
      if(object?.type!=='ObjectExpression')continue;
      const property=object.properties.find(p=>p.type==='ObjectProperty'&&nodeName(p.key)==='contexts');
      if(property?.type==='ObjectProperty')edits.push({start:startOf(property.value),end:endOf(property.value),text:JSON.stringify(mapping)});
      else edits.push({start:startOf(object)+1,end:startOf(object)+1,text:`\ncontexts: ${JSON.stringify(mapping)},\n`});
    }
    const missingAliases = Object.entries(aliases).filter(([key]) => !Object.hasOwn(existing.aliases ?? {}, key));
    if (missingAliases.length) {
      const prop = configObject!.properties.find(p => p.type === 'ObjectProperty' && nodeName(p.key) === 'aliases');
      if (prop?.type === 'ObjectProperty' && prop.value.type === 'ObjectExpression') edits.push(insertItems(existingText, prop.value, missingAliases.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`), prop.value.properties));
      else edits.push({ start: startOf(configObject!) + 1, end: startOf(configObject!) + 1, text: `\n  aliases: ${JSON.stringify(Object.fromEntries(missingAliases))},\n` });
    }
    if (edits.length) report.changes.push({ file: configFile, before: existingText, after: applyEdits(existingText, edits), reason: 'Append discovered targets without replacing existing configuration' });
  }
  report.changes.push(...vite.changes);
  report.changes.push(...await integrateTypeResolution(root));
  const configRelativeSources = scan.files.map(f => relativePath(configRoot, path.join(root, f.file)));
  const envFile = relativePath(root, path.join(configRoot, configRelativeSources.some(f => f.startsWith('src/')) ? 'src/skelcast-env.d.ts' : 'skelcast-env.d.ts'));
  const env = await optionalRead(path.join(root, envFile));
  if (!env?.includes('skelcast/virtual')) report.changes.push({ file: envFile, before: env, after: `/// <reference types="skelcast/virtual" />\n${env ?? ''}`, reason: 'Declare generated virtual module types' });
  if (report.dryRun) return report;
  return withProjectLock(path.resolve(configRoot, existing.outDir ?? '.skelcast'), async () => {
    // Verify every planned edit before writing; a concurrent user edit is never overwritten.
    for (const change of report.changes) if (await optionalRead(path.join(root, change.file)) !== change.before) throw new Error(`${change.file} changed during init; run init again`);
    const outDir = path.resolve(configRoot, existing.outDir ?? '.skelcast');
    const backup = relativePath(root, path.join(outDir, 'init-backups', `${Date.now()}-${digest(report.changes.map(c => c.after).join()).slice(0, 8)}`));
    const applied: InitChange[] = [];
    if (report.changes.length) {
      report.backup = backup;
      for (const change of report.changes) if (change.before != null) {
        const file = path.join(root, backup, change.file);
        await atomicWrite(file, change.before);
      }
    }
    try {
      for (const change of report.changes) {
        if (await optionalRead(path.join(root, change.file)) !== change.before) throw new Error(`${change.file} changed during init; run init again`);
        await atomicWrite(path.join(root, change.file), change.after);
        applied.push(change);
      }
      const finalConfig = report.changes.find(c => c.file === configFile)?.after ?? existingText!;
      const { updates, result } = await prepareProjectSync(await projectFromConfig(configRoot, literalConfig(finalConfig).config));
      report.generated = result;
      const reportText = JSON.stringify({ scanned: report.scanned, targets: report.targets, changes: report.changes.map(({ file, reason }) => ({ file, reason })), diagnostics: report.diagnostics, backup: report.backup }, null, 2) + '\n';
      await commitOutputs(outDir, new Map([['init-report.json', reportText], ...updates]));
    } catch (error) {
      for (const change of applied.reverse()) {
        const file = path.join(root, change.file);
        // Roll back only bytes written by this run, preserving subsequent user edits.
        if (await optionalRead(file) !== change.after) continue;
        if (change.before == null) await unlink(file); else await atomicWrite(file, change.before);
      }
      throw error;
    }
    return report;
  });
}
