import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Manifest, ManifestEntry, SkeletonArtifact, SkeletonConfig, SkeletonHints, SkeletonTarget } from './types.js';
import { compileTargetWithFiles } from './compiler/index.js';
import { SourceFiles } from './compiler/source-files.js';
import { digest } from './compiler/styles.js';
import { presetNames } from './compiler/presets/index.js';
import { atomicWrite, commitOutputs, withProjectLock } from './storage.js';

declare const __SKELETON_COMPILER_HASH__: string;
export const GENERATOR_VERSION = `0.1.0-${typeof __SKELETON_COMPILER_HASH__ === 'string' ? __SKELETON_COMPILER_HASH__ : 'source-outline-v1'}`;
export interface Project { root: string; config: SkeletonConfig; configFile: string; hintsFile: string; outDir: string }
export interface TargetStatus { id: string; state: 'ready' | 'stale' | 'missing' | 'corrupt'; reason?: string }
export function validateHints(hints: SkeletonHints): void {
  if (!hints || typeof hints !== 'object' || Array.isArray(hints)) throw new Error('Hints must be an object');
  const allowed = new Set(['state', 'repeat', 'lines', 'minHeight', 'bindings']);
  if(hints.state!=null&&!['loading','source'].includes(hints.state))throw new Error('state must be loading or source');
  for (const key of Object.keys(hints)) if (!allowed.has(key)) throw new Error(`Unknown hint: ${key}`);
  for (const [key, min, max] of [['repeat', 1, 24], ['lines', 1, 8], ['minHeight', 16, 2000]] as const) {
    const value = hints[key];
    if (value != null && (!Number.isInteger(value) || value < min || value > max)) throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  if (hints.bindings != null && (typeof hints.bindings !== 'object' || Array.isArray(hints.bindings))) throw new Error('bindings must be an object');
}
export async function loadProject(root = process.cwd()): Promise<Project> {
  root = await realpath(path.resolve(root));
  const configFile = path.join(root, 'skelcast.config.mjs');
  const code = await readFile(configFile, 'utf8');
  const imported = await import(`${pathToFileURL(configFile).href}?v=${digest(code)}`);
  return projectFromConfig(root, imported.default);
}
/** Validate a statically obtained config without importing any project modules. */
export async function projectFromConfig(root: string, input: SkeletonConfig): Promise<Project> {
  root = await realpath(path.resolve(root));
  const configFile = path.join(root, 'skelcast.config.mjs');
  const config: SkeletonConfig = structuredClone(input);
  if (!config || !Array.isArray(config.targets)) throw new Error('skelcast.config.mjs must export { targets: [...] }');
  if (config.aliases && Object.values(config.aliases).some(v => typeof v !== 'string')) throw new Error('aliases must map prefixes to source directories');
  if (config.components && (Array.isArray(config.components) || typeof config.components !== 'object' || Object.values(config.components).some(v => typeof v !== 'string'))) throw new Error('components must map names to source files');
  if (config.componentBindings && (typeof config.componentBindings !== 'object' || Array.isArray(config.componentBindings) || Object.values(config.componentBindings).some(value => !value || typeof value !== 'object' || Array.isArray(value)))) throw new Error('componentBindings must map component source files to expression values');
  if (config.componentDeclarations && (!Array.isArray(config.componentDeclarations) || config.componentDeclarations.some(v => typeof v !== 'string'))) throw new Error('componentDeclarations must be a list of declaration files');
  if (config.componentPolicies && (typeof config.componentPolicies !== 'object' || Array.isArray(config.componentPolicies) || Object.values(config.componentPolicies).some(v=>!['live','graphic'].includes(v)))) throw new Error('componentPolicies must map source binding names to live or graphic');
  if (config.componentPresets && (!Array.isArray(config.componentPresets) || config.componentPresets.some(v => !presetNames.includes(v)))) throw new Error(`Supported component presets: ${presetNames.join(', ')}`);
  if (config.styles) {
    if (typeof config.styles !== 'object' || Array.isArray(config.styles)) throw new Error('styles must be an object');
    if (config.styles.less != null && typeof config.styles.less !== 'boolean') throw new Error('styles.less must be a boolean');
    for (const name of ['sass','tailwind','prune'] as const) if (config.styles[name] != null && typeof config.styles[name] !== 'boolean') throw new Error(`styles.${name} must be a boolean`);
    const uno = config.styles.unocss;
    if (uno != null && typeof uno !== 'boolean') {
      if (typeof uno !== 'object' || Array.isArray(uno)) throw new Error('styles.unocss must be a boolean or configuration object');
      if (uno.attributify != null && typeof uno.attributify !== 'boolean') throw new Error('unocss.attributify must be a boolean');
      if (uno.shortcuts && Object.values(uno.shortcuts).some(v => typeof v !== 'string')) throw new Error('unocss.shortcuts must map names to utility strings');
      if (uno.safelist && (!Array.isArray(uno.safelist) || uno.safelist.some(v => typeof v !== 'string'))) throw new Error('unocss.safelist must be a string array');
    }
  }
  const hintsFile = path.resolve(root, config.hintsFile ?? 'skelcast.hints.json');
  let saved: Record<string, SkeletonHints> = {};
  try { saved = JSON.parse(await readFile(hintsFile, 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const ids = new Set();
  for (const target of config.targets) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(target.id) || ids.has(target.id)) throw new Error(`Invalid or duplicate target id: ${target.id}`);
    ids.add(target.id);
    if (!target.source || typeof target.source !== 'string') throw new Error(`Missing source: ${target.id}`);
    if (target.region && !/^[A-Za-z_$][\w$]*$/.test(target.region)) throw new Error(`Invalid source region: ${target.region}`);
    if (target.contexts && (!target.source.endsWith('.vue') || !target.region || Object.keys(target.contexts).length > 64 || Object.entries(target.contexts).some(([key, value]) => !/^[a-zA-Z0-9_-]+$/.test(key) || !value || typeof value.source !== 'string' || !value.source.endsWith('.vue')))) throw new Error(`Invalid finite source contexts: ${target.id}`);
    if (target.route && !(typeof target.route === 'string' || Array.isArray(target.route) && target.route.every(r => typeof r === 'string'))) throw new Error(`Invalid route: ${target.id}`);
    if (target.kind && !['page', 'request'].includes(target.kind)) throw new Error(`Invalid kind: ${target.id}`);
    if (target.render && !['light', 'shadow'].includes(target.render)) throw new Error(`Invalid render mode: ${target.id}`);
    target.hints = { ...target.hints, ...saved[target.id] };
    validateHints(target.hints);
    if (target.variants && (Object.keys(target.variants).length > 16 || !Object.keys(target.variants).length)) throw new Error('Use between 1 and 16 variants');
    for (const [name, hints] of Object.entries(target.variants ?? {})) {
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Invalid variant: ${name}`);
      validateHints(hints);
    }
    if (target.defaultVariant && !Object.hasOwn(target.variants ?? { default: {} }, target.defaultVariant)) throw new Error(`Unknown defaultVariant: ${target.defaultVariant}`);
  }
  return { root, config, configFile, hintsFile, outDir: path.resolve(root, config.outDir ?? '.skelcast') };
}
async function readManifest(project: Project): Promise<Manifest | undefined> {
  try {
    const manifest = JSON.parse(await readFile(path.join(project.outDir, 'manifest.json'), 'utf8'));
    if (manifest && typeof manifest.version === 'string' && manifest.targets && typeof manifest.targets === 'object' && !Array.isArray(manifest.targets)) return manifest;
  } catch { /* absent or invalid manifests are regenerated */ }
}
export const artifactFilename = (id: string) => `${id}.mjs`;
const targetHash = (target: SkeletonTarget, config: SkeletonConfig) => digest(JSON.stringify({ target, aliases: config.aliases, components: config.components, componentBindings: config.componentBindings, componentDeclarations: config.componentDeclarations, componentPresets: config.componentPresets, componentPolicies:config.componentPolicies, styles: config.styles }));
async function entryStatus(project: Project, target: SkeletonTarget, files: SourceFiles, entry?: ManifestEntry, version?: string): Promise<TargetStatus> {
  if (!entry) return { id: target.id, state: 'missing', reason: 'No generated artifact' };
  if (version !== GENERATOR_VERSION || entry.hash !== targetHash(target, project.config)) return { id: target.id, state: 'stale', reason: 'Config, hints or generator changed' };
  for (const [file, hash] of Object.entries(entry.dependencies)) {
    if (hash === '!missing') {
      // Resolution candidates can be directories, or have a non-directory parent.
      try { if (await files.isFile(path.resolve(project.root, file))) return { id: target.id, state: 'stale', reason: `${file} created` }; }
      catch (error: any) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return { id: target.id, state: 'stale', reason: `${file} unavailable` }; }
      continue;
    }
    try { if ((await files.read(path.resolve(project.root, file))).hash !== hash) return { id: target.id, state: 'stale', reason: `${file} changed` }; }
    catch { return { id: target.id, state: 'stale', reason: `${file} missing` }; }
  }
  try {
    const content = await files.read(path.join(project.outDir, artifactFilename(target.id)));
    if (content.hash !== entry.outputHash) return { id: target.id, state: 'corrupt', reason: 'Artifact was modified or corrupted' };
  } catch { return { id: target.id, state: 'missing', reason: 'Artifact missing' }; }
  return { id: target.id, state: 'ready' };
}
export async function checkProject(project: Project, id?: string): Promise<TargetStatus[]> {
  const targets = selectedTargets(project, id);
  return withProjectLock(project.outDir, () => checkProjectUnlocked(project, new SourceFiles(), targets));
}
function selectedTargets(project: Project, id?: string): SkeletonTarget[] {
  const targets = id ? project.config.targets.filter(target => target.id === id) : project.config.targets;
  if (id && !targets.length) throw new Error(`Unknown skeleton ${id}`);
  return targets;
}
async function checkProjectUnlocked(project: Project, files: SourceFiles, targets: SkeletonTarget[]): Promise<TargetStatus[]> {
  const manifest = await readManifest(project);
  return Promise.all(targets.map(t => entryStatus(project, t, files, manifest?.targets[t.id], manifest?.version)));
}
/** Read freshness and inspection data from the same verified output bytes. */
export async function readProjectState(project: Project, id?: string) {
  const targets = selectedTargets(project, id);
  return withProjectLock(project.outDir, async () => {
    const files = new SourceFiles();
    const statuses = await checkProjectUnlocked(project, files, targets);
    const entries = await Promise.all(statuses.filter(status => status.state !== 'missing' && status.state !== 'corrupt').map(async status =>
      [status.id, await readArtifactUnlocked(project, status.id, files)] as const));
    return { statuses, artifacts: new Map(entries) };
  });
}
export async function readArtifact(project: Project, id: string): Promise<SkeletonArtifact> {
  return withProjectLock(project.outDir, () => readArtifactUnlocked(project, id));
}
async function readArtifactUnlocked(project: Project, id: string, files = new SourceFiles()): Promise<SkeletonArtifact> {
  if (!project.config.targets.some(t => t.id === id)) throw new Error(`Unknown skeleton ${id}`);
  const { bytes } = await files.read(path.join(project.outDir, artifactFilename(id)));
  const text = bytes.toString('utf8');
  // Generated modules contain one JSON literal. Reading metadata never executes a module.
  const match = text.match(/^\/\/ Generated by skelcast[^\n]*\nexport default ([\s\S]*);\n$/);
  if (!match) throw new Error(`Invalid generated artifact ${id}`);
  return JSON.parse(match[1]);
}
export async function syncProject(project: Project): Promise<{ id: string; state: 'generated' | 'reused'; diagnostics: number }[]> {
  return withProjectLock(project.outDir, async () => {
    const { updates, result } = await prepareProjectSync(project);
    await commitOutputs(project.outDir, updates);
    return result;
  });
}
/** Prepare without changing owned outputs. Call under withProjectLock, then
 * commit together with any init report so all generated files share recovery. */
export async function prepareProjectSync(project: Project) {
  const files = new SourceFiles();
  const old = await readManifest(project);
  const manifest: Manifest = { version: GENERATOR_VERSION, targets: {} };
  const result: { id: string; state: 'generated' | 'reused'; diagnostics: number }[] = [];
  const updates = new Map<string, string | null>();
  for (const target of project.config.targets) {
    const previous = old?.targets[target.id];
    if ((await entryStatus(project, target, files, previous, old?.version)).state === 'ready') {
      const { hash, outputHash, dependencies } = previous!;
      manifest.targets[target.id] = { hash, outputHash, dependencies };
      result.push({ id: target.id, state: 'reused', diagnostics: (await readArtifactUnlocked(project, target.id, files)).diagnostics.length });
      continue;
    }
    const { artifact, dependencies } = await compileTargetWithFiles(project.root, target, project.config.aliases ?? {}, project.config, files);
    const module = `// Generated by skelcast ${GENERATOR_VERSION}. Edit source or hints, then sync.\nexport default ${JSON.stringify(artifact)};\n`;
    const file = artifactFilename(target.id);
    updates.set(file, module);
    manifest.targets[target.id] = { hash: targetHash(target, project.config), outputHash: digest(module), dependencies };
    result.push({ id: target.id, state: 'generated', diagnostics: artifact.diagnostics.length });
  }
  for (const id of Object.keys(old?.targets ?? {})) if (!Object.hasOwn(manifest.targets, id) && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) updates.set(artifactFilename(id), null);
  // The manifest is the final file in the transaction.
  updates.set('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  return { updates, result };
}
export async function saveHints(project: Project, id: string, hints: SkeletonHints): Promise<void> {
  if (!project.config.targets.some(t => t.id === id)) throw new Error(`Unknown skeleton ${id}`);
  validateHints(hints);
  return withProjectLock(project.outDir, async () => {
    let data: Record<string, SkeletonHints> = {};
    try { data = JSON.parse(await readFile(project.hintsFile, 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    // A supplied bindings object is the complete edited value, including {}.
    // Omitting it leaves the previous bindings intact when updating other hints.
    data[id] = { ...data[id], ...hints };
    await atomicWrite(project.hintsFile, JSON.stringify(data, null, 2) + '\n');
  });
}
