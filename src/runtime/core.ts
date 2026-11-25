import type { SkeletonArtifact } from '../types.js';

export interface BoundaryInfo {
  id: string;
  kind: 'page' | 'request';
  pending: boolean;
  variant?: string;
  artifact: SkeletonArtifact;
  element?: HTMLElement;
}
export interface PreviewState { target: string | null; variant?: string; highlight: boolean }
const boundaries = new Map<symbol, BoundaryInfo>();
const listeners = new Set<() => void>();
let revision = 0;
let preview: PreviewState = { target: null, highlight: false };
let initialReleased = false;
let initialHandedOff = false;
let initialPreviewAllowed = true;
const overrides = new Map<string, SkeletonArtifact>();

function updateInitial() {
  if (typeof document === 'undefined') return;
  const root = document.querySelector<HTMLElement>('[data-sk-initial]');
  if (!root) return;
  const id = root.dataset.skInitial!;
  // A static SPA entry may contain another route's initial shell. Any mounted
  // page boundary owns the current page and must retire that shell permanently.
  const managed = [...boundaries.values()].some(b => b.kind === 'page');
  if (managed) initialHandedOff = true;
  root.hidden = initialHandedOff || initialReleased && (!initialPreviewAllowed || !(preview.target === 'page' || preview.target === id));
}
function emit() { revision++; updateInitial(); listeners.forEach(fn => fn()); }
export function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function snapshot() { return revision; }
export const serverSnapshot = () => 0;
export function getPreview(): PreviewState { return preview; }
export function setPreview(value: Partial<PreviewState>) { preview = { ...preview, ...value }; emit(); }
export function listBoundaries() { return [...boundaries.values()]; }
export function forced(id: string, kind: string) { return preview.target === id || preview.target === 'page' && kind === 'page'; }
export function registerBoundary(info: BoundaryInfo) {
  const token = Symbol(info.id);
  boundaries.set(token, info); emit();
  return {
    update(next: Partial<BoundaryInfo>) {
      const previous = boundaries.get(token);
      if (previous && Object.entries(next).some(([key, value]) => (previous as any)[key] !== value)) { boundaries.set(token, { ...previous, ...next }); emit(); }
    },
    dispose() { boundaries.delete(token); emit(); },
  };
}
export function currentArtifact(artifact: SkeletonArtifact) { return overrides.get(artifact.id) ?? artifact; }
export function replaceArtifacts(artifacts: SkeletonArtifact[]) { for (const a of artifacts) overrides.set(a.id, a); emit(); }
export function releasePageSkeleton(options: { preview?: boolean } = {}) { initialReleased = true; initialPreviewAllowed = options.preview !== false; updateInitial(); }

export function selectedView(artifact: SkeletonArtifact, variant?: string) {
  const chosen = preview.variant ?? variant ?? artifact.defaultVariant;
  return artifact.variants[chosen] ?? artifact.variants[artifact.defaultVariant] ?? Object.values(artifact.variants)[0];
}
export function mountSkeleton(host: HTMLElement, artifact: SkeletonArtifact, variant?: string): () => void {
  const view = selectedView(artifact, variant);
  if (!view) return () => {};
  // The strings are build-time artifacts. Mounting does not inspect business DOM.
  const root = artifact.render === 'shadow' ? host.shadowRoot ?? host.attachShadow({ mode: 'open' }) : host;
  if (root instanceof ShadowRoot) {
    root.innerHTML = `<style>:host{display:block}${view.css.replace(/<\/style/gi, '<\\/style')}</style>${view.html}`;
  } else {
    const style = document.createElement('style'); style.textContent = view.css;
    root.replaceChildren(style);
    const template = document.createElement('template'); template.innerHTML = view.html;
    root.append(template.content);
  }
  if (preview.highlight) root.querySelector('[data-sk-artifact]')?.setAttribute('data-sk-highlight', '');
  return () => root.replaceChildren();
}
