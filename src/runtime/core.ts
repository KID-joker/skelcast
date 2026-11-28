import type { SkeletonArtifact, SkeletonView } from '../types.js';
import { acquireStyle } from './styles.js';
import{acquireLayoutConstraints}from'./layout.js';

export interface BoundaryInfo {
  id: string;
  kind: 'page' | 'request';
  pending: boolean;
  variant?: string;
  context?: string;
  artifact: SkeletonArtifact;
  element?: HTMLElement;
}
export type ComparisonMode = 'off' | 'side-by-side' | 'overlay' | 'switch';
export interface PreviewState {
  target: string | null;
  variant?: string;
  highlight: boolean;
  comparison: ComparisonMode;
  opacity: number;
  comparisonView: 'content' | 'skeleton';
}
const boundaries = new Map<symbol, BoundaryInfo>();
let pageBoundaryCount = 0;
const listeners = new Set<() => void>();
const boundaryListeners = new Set<{ id: string; kind: BoundaryInfo['kind']; listener: () => void }>();
const artifactRevisions = new Map<string, number>();
let preview: PreviewState = { target: null, highlight: false, comparison: 'off', opacity: 0.5, comparisonView: 'content' };
let initialReleased = false;
let initialHandedOff = false;
let initialPreviewAllowed = true;
const overrides = new Map<string, SkeletonArtifact>();
const overrideVersions = new Map<string, string>();

function updateInitial() {
  if (typeof document === 'undefined') return;
  const root = document.querySelector<HTMLElement>('[data-sk-initial]');
  if (!root) return;
  const id = root.dataset.skInitial!;
  // A static SPA entry may contain another route's initial shell. Any mounted
  // page boundary owns the current page and must retire that shell permanently.
  if (pageBoundaryCount > 0) initialHandedOff = true;
  const hidden = initialHandedOff || initialReleased && (!initialPreviewAllowed || !(preview.target === 'page' || preview.target === id));
  if (root.hidden !== hidden) root.hidden = hidden;
  const display = hidden ? 'none' : 'block';
  if (root.style.getPropertyValue('display') !== display || root.style.getPropertyPriority('display') !== 'important') {
    root.style.setProperty('display', display, 'important');
  }
}
function emit() { listeners.forEach(fn => fn()); }
export function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export const serverSnapshot = () => '';
export function getPreview(): PreviewState { return preview; }
/** Inspector subscriptions include pending state; boundary subscriptions only track
 * preview and artifact changes that affect that boundary's rendered output. */
function boundaryValues(id: string, kind: BoundaryInfo['kind']) {
  const held = forced(id, kind);
  return [held, held ? preview.variant ?? null : null, preview.highlight, artifactRevisions.get(id) ?? 0,
    held ? preview.comparison : null, held && preview.comparison === 'overlay' ? preview.opacity : null,
    held && preview.comparison === 'switch' ? preview.comparisonView : null] as const;
}
export function boundarySnapshot(id: string, kind: BoundaryInfo['kind']): string {
  return JSON.stringify(boundaryValues(id, kind));
}
export function subscribeBoundary(id: string, kind: BoundaryInfo['kind'], listener: () => void) {
  const entry = { id, kind, listener };
  boundaryListeners.add(entry);
  return () => { boundaryListeners.delete(entry); };
}
export function setPreview(value: Partial<PreviewState>) {
  const next = { ...preview, ...value };
  next.opacity = Number.isFinite(next.opacity) ? Math.max(0, Math.min(1, next.opacity)) : 0.5;
  if ((Object.keys(next) as (keyof PreviewState)[]).every(key => next[key] === preview[key])) return;
  const values = new Map<string, { state: PreviewState; revision: number; fields: ReturnType<typeof boundaryValues> }>();
  const read = (id: string, kind: BoundaryInfo['kind']) => {
    const key = `${kind}:${id}`, revision = artifactRevisions.get(id) ?? 0;
    let cached = values.get(key);
    if (!cached || cached.state !== preview || cached.revision !== revision) {
      values.set(key, cached = { state: preview, revision, fields: boundaryValues(id, kind) });
    }
    return cached.fields;
  };
  const before = new Map([...boundaryListeners].map(entry => [entry, read(entry.id, entry.kind)]));
  preview = next;
  for (const [entry, previous] of before) {
    const current = read(entry.id, entry.kind);
    if (previous.some((field, index) => field !== current[index])) entry.listener();
  }
  updateInitial(); emit();
}
export function listBoundaries() { return [...boundaries.values()]; }
export function forced(id: string, kind: string) { return preview.target === id || preview.target === 'page' && kind === 'page'; }
export function registerBoundary(info: BoundaryInfo) {
  const token = Symbol(info.id);
  boundaries.set(token, info);
  if (info.kind === 'page') pageBoundaryCount++;
  updateInitial(); emit();
  return {
    update(next: Partial<BoundaryInfo>) {
      const previous = boundaries.get(token);
      if (previous && Object.entries(next).some(([key, value]) => previous[key as keyof BoundaryInfo] !== value)) {
        const current = { ...previous, ...next };
        boundaries.set(token, current);
        pageBoundaryCount += Number(current.kind === 'page') - Number(previous.kind === 'page');
        // Pending, variants and artifact contents cannot change shell ownership.
        if (!initialHandedOff || next.id !== undefined && next.id !== previous.id || next.kind !== undefined && next.kind !== previous.kind) updateInitial();
        emit();
      }
    },
    dispose() {
      if (boundaries.get(token)?.kind === 'page') pageBoundaryCount--;
      boundaries.delete(token); updateInitial(); emit();
    },
  };
}
export function currentArtifact(artifact: SkeletonArtifact) { return overrides.get(artifact.id) ?? artifact; }
/** Dev responses supply versions of their browser payloads. Direct callers retain
 * the existing content comparison when no version is available. */
export function replaceArtifacts(artifacts: SkeletonArtifact[], versions?: Readonly<Record<string, string>>) {
  const changed = new Set<string>();
  for (const artifact of artifacts) {
    const previous = overrides.get(artifact.id);
    const version = versions?.[artifact.id], previousVersion = overrideVersions.get(artifact.id);
    if (previous === artifact) continue;
    const unchanged = previous && (version !== undefined && previousVersion !== undefined
      ? version === previousVersion : JSON.stringify(previous) === JSON.stringify(artifact));
    if (version !== undefined) overrideVersions.set(artifact.id, version);
    else overrideVersions.delete(artifact.id);
    if (unchanged) continue;
    overrides.set(artifact.id, artifact);
    artifactRevisions.set(artifact.id, (artifactRevisions.get(artifact.id) ?? 0) + 1);
    changed.add(artifact.id);
  }
  if (!changed.size) return false;
  for (const entry of boundaryListeners) if (changed.has(entry.id)) entry.listener();
  if (!initialHandedOff) updateInitial();
  emit();
  return true;
}
export function releasePageSkeleton(options: { preview?: boolean } = {}) { initialReleased = true; initialPreviewAllowed = options.preview !== false; updateInitial(); }

export function selectedVariant(artifact: SkeletonArtifact, variant?: string, held = forced(artifact.id, artifact.kind), context?: string): string {
  const chosen = (held ? preview.variant : undefined) ?? variant ?? artifact.defaultVariant;
  const mapping = context && artifact.contexts?.[context];
  if(mapping){const state=Object.values(artifact.contexts??{}).flatMap(mapping=>Object.entries(mapping)).find(([,view])=>view===chosen)?.[0];const contextual=mapping[chosen]??(state?mapping[state]:undefined)??mapping[artifact.defaultVariant]??Object.values(mapping)[0];if(artifact.variants[contextual])return contextual;}
  return artifact.variants[chosen] ? chosen : artifact.defaultVariant;
}
export function selectedView(artifact: SkeletonArtifact, variant?: string, context?: string) {
  return artifact.variants[selectedVariant(artifact, variant, undefined, context)] ?? Object.values(artifact.variants)[0];
}
export function mountSkeleton(host: HTMLElement, artifact: SkeletonArtifact, variant?: string, context?: string): () => void {
  const view = selectedView(artifact, variant, context);
  if (!view) return () => {};
  // Keep the shadow root on an owned child so switching render modes can remove it.
  const container = artifact.render === 'shadow' ? host.ownerDocument.createElement('div') : host;
  if (container !== host) host.replaceChildren(container);
  const root = artifact.render === 'shadow' ? container.attachShadow({ mode: 'open' }) : host;
  const template = host.ownerDocument.createElement('template'); template.innerHTML = view.html;
  root.replaceChildren(template.content);
  const releaseStyle = acquireStyle(root instanceof ShadowRoot ? root : host.ownerDocument, `${root instanceof ShadowRoot ? ':host{display:block}' : ''}${view.css}`);
  const releaseLayout=acquireLayoutConstraints(root);
  if (preview.highlight) root.querySelector('[data-sk-artifact]')?.setAttribute('data-sk-highlight', '');
  return () => { releaseLayout();releaseStyle(); host.replaceChildren(); };
}

/** Mount on first display and retain the tree while hidden. Artifact/variant changes
 * are applied on the next display, without recreating an unchanged skeleton. */
export function createSkeletonMount() {
  let cleanup: (() => void) | undefined;
  let previous: SkeletonView | undefined;
  let previousMode: SkeletonArtifact['render'] | undefined;
  let previousHost: HTMLElement | undefined;
  return {
    update(host: HTMLElement, visible: boolean, artifact: SkeletonArtifact, variant?: string, context?: string) {
      if (!visible) return;
      const view = selectedView(artifact, variant, context);
      if (host !== previousHost || previousMode !== artifact.render || view?.html !== previous?.html || view?.css !== previous?.css) {
        cleanup?.(); cleanup = mountSkeleton(host, artifact, variant, context);
        previous = view; previousMode = artifact.render; previousHost = host;
      }
      const root = host.firstElementChild?.shadowRoot ?? host;
      root.querySelector('[data-sk-artifact]')?.toggleAttribute('data-sk-highlight', preview.highlight);
    },
    dispose() { cleanup?.(); cleanup = undefined; previous = undefined; previousHost = undefined; previousMode = undefined; },
  };
}
