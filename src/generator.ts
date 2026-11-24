import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Manifest, ManifestEntry, SkeletonArtifact, SkeletonConfig, SkeletonHints, SkeletonTarget } from './types.js';
import { compileTarget } from './compiler/index.js';
import { digest } from './compiler/styles.js';

declare const __SKELETON_COMPILER_HASH__: string;
export const GENERATOR_VERSION = `0.1.0-${typeof __SKELETON_COMPILER_HASH__ === 'string' ? __SKELETON_COMPILER_HASH__ : 'source'}`;
export interface Project { root: string; config: SkeletonConfig; configFile: string; hintsFile: string; outDir: string }
export interface TargetStatus { id: string; state: 'ready' | 'stale' | 'missing' | 'corrupt'; reason?: string }
export function validateHints(hints: SkeletonHints): void {
  if (!hints || typeof hints !== 'object' || Array.isArray(hints)) throw new Error('Hints must be an object');
  const allowed = new Set(['repeat', 'lines', 'minHeight', 'bindings']);
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
  const hintsFile = path.resolve(root, config.hintsFile ?? 'skelcast.hints.json');
  let saved: Record<string, SkeletonHints> = {};
  try { saved = JSON.parse(await readFile(hintsFile, 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const ids = new Set();
  for (const target of config.targets) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(target.id) || ids.has(target.id)) throw new Error(`Invalid or duplicate target id: ${target.id}`);
    ids.add(target.id);
    if (!target.source || typeof target.source !== 'string') throw new Error(`Missing source: ${target.id}`);
    if (target.region && !/^[A-Za-z_$][\w$]*$/.test(target.region)) throw new Error(`Invalid source region: ${target.region}`);
    if (target.route && !(typeof target.route === 'string' || Array.isArray(target.route) && target.route.every(r => typeof r === 'string'))) throw new Error(`Invalid route: ${target.id}`);
    if (target.kind && !['page', 'request'].includes(target.kind)) throw new Error(`Invalid kind: ${target.id}`);
    if (target.render && !['light', 'shadow'].includes(target.render)) throw new Error(`Invalid render mode: ${target.id}`);
    target.hints = { ...target.hints, ...saved[target.id], bindings: { ...target.hints?.bindings, ...saved[target.id]?.bindings } };
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
const targetHash = (target: SkeletonTarget, aliases?: Record<string, string>) => digest(JSON.stringify({ target, aliases }));
async function entryStatus(project: Project, target: SkeletonTarget, entry?: ManifestEntry, version?: string): Promise<TargetStatus> {
  if (!entry) return { id: target.id, state: 'missing', reason: 'No generated artifact' };
  if (version !== GENERATOR_VERSION || entry.hash !== targetHash(target, project.config.aliases)) return { id: target.id, state: 'stale', reason: 'Config, hints or generator changed' };
  for (const [file, hash] of Object.entries(entry.dependencies)) {
    try { if (digest(await readFile(path.resolve(project.root, file), 'utf8')) !== hash) return { id: target.id, state: 'stale', reason: `${file} changed` }; }
    catch { return { id: target.id, state: 'stale', reason: `${file} missing` }; }
  }
  try {
    const content = await readFile(path.join(project.outDir, artifactFilename(target.id)), 'utf8');
    if (digest(content) !== entry.outputHash) return { id: target.id, state: 'corrupt', reason: 'Artifact was modified or corrupted' };
  } catch { return { id: target.id, state: 'missing', reason: 'Artifact missing' }; }
  return { id: target.id, state: 'ready' };
}
export async function checkProject(project: Project): Promise<TargetStatus[]> {
  const manifest = await readManifest(project);
  return Promise.all(project.config.targets.map(t => entryStatus(project, t, manifest?.targets[t.id], manifest?.version)));
}
async function atomicWrite(file: string, content: string) {
  try { if (await readFile(file, 'utf8') === content) return; } catch { /* new */ }
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, file);
}
export async function readArtifact(project: Project, id: string): Promise<SkeletonArtifact> {
  if (!project.config.targets.some(t => t.id === id)) throw new Error(`Unknown skeleton ${id}`);
  const text = await readFile(path.join(project.outDir, artifactFilename(id)), 'utf8');
  // Generated modules contain one JSON literal. Reading metadata never executes a module.
  const match = text.match(/^\/\/ Generated by skelcast[^\n]*\nexport default ([\s\S]*);\n$/);
  if (!match) throw new Error(`Invalid generated artifact ${id}`);
  return JSON.parse(match[1]);
}
export async function syncProject(project: Project): Promise<{ id: string; state: 'generated' | 'reused'; diagnostics: number }[]> {
  const old = await readManifest(project);
  const manifest: Manifest = { version: GENERATOR_VERSION, configHash: digest(JSON.stringify(project.config)), targets: {} };
  const result: { id: string; state: 'generated' | 'reused'; diagnostics: number }[] = [];
  for (const target of project.config.targets) {
    const previous = old?.targets[target.id];
    if ((await entryStatus(project, target, previous, old?.version)).state === 'ready') {
      manifest.targets[target.id] = previous!;
      result.push({ id: target.id, state: 'reused', diagnostics: (await readArtifact(project, target.id)).diagnostics.length });
      continue;
    }
    const { artifact, dependencies } = await compileTarget(project.root, target, project.config.aliases);
    const module = `// Generated by skelcast ${GENERATOR_VERSION}. Edit source or hints, then sync.\nexport default ${JSON.stringify(artifact, null, 2)};\n`;
    const file = artifactFilename(target.id);
    await atomicWrite(path.join(project.outDir, file), module);
    manifest.targets[target.id] = { file, hash: targetHash(target, project.config.aliases), outputHash: digest(module), dependencies };
    result.push({ id: target.id, state: 'generated', diagnostics: artifact.diagnostics.length });
  }
  await atomicWrite(path.join(project.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const id of Object.keys(old?.targets ?? {})) if (!Object.hasOwn(manifest.targets, id) && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) await unlink(path.join(project.outDir, artifactFilename(id))).catch(() => {});
  return result;
}
export async function saveHints(project: Project, id: string, hints: SkeletonHints): Promise<void> {
  if (!project.config.targets.some(t => t.id === id)) throw new Error(`Unknown skeleton ${id}`);
  validateHints(hints);
  let data: Record<string, SkeletonHints> = {};
  try { data = JSON.parse(await readFile(project.hintsFile, 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  data[id] = { ...data[id], ...hints, bindings: { ...data[id]?.bindings, ...hints.bindings } };
  await atomicWrite(project.hintsFile, JSON.stringify(data, null, 2) + '\n');
}
