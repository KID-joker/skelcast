import { forced, getPreview, listBoundaries, replaceArtifacts, setPreview, subscribe, type ComparisonMode, type PreviewState } from './runtime/core.js';
import type { SkeletonArtifact } from './types.js';
import type { TargetStatus } from './generator.js';
import { patchChildren } from './devtools/dom.js';
import { devtoolsCSS } from './devtools/styles.js';
import { icon } from './devtools/icons.js';
import { escapeHTML } from './shared.js';

interface DevState { artifacts: SkeletonArtifact[]; statuses: TargetStatus[]; versions?: Record<string, string> }
let data: DevState = { artifacts: [], statuses: [] };
let selected = '';
let selectedByUser = false;
let picking = false;
let note = '';
let busy = false;
let refreshRevision = 0;
const host = document.createElement('div');
host.id = 'skelcast-devtools';
host.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:2147483646';
host.style.maxWidth = 'calc(100vw - 36px)';
const shadow = host.attachShadow({ mode: 'open' });
document.documentElement.append(host);

function readURL() {
  const query = new URLSearchParams(location.search);
  const target = query.get('__sk');
  selectedByUser = !!target && target !== 'page' && target !== 'auto';
  if (selectedByUser) selected = target!;
  const comparison = query.get('__sk_compare');
  const opacity = query.get('__sk_opacity');
  setPreview({ target: target && target !== 'auto' ? target : null, variant: query.get('__sk_variant') ?? undefined,
    comparison: target && target !== 'auto' && ['side-by-side', 'overlay', 'switch'].includes(comparison ?? '') ? comparison as ComparisonMode : 'off',
    opacity: opacity !== null && opacity.trim() ? Number(opacity) : 0.5,
    comparisonView: query.get('__sk_view') === 'skeleton' ? 'skeleton' : 'content' });
}
function writeURL(target: string | null, variant?: string, comparison: Partial<Pick<PreviewState, 'comparison' | 'opacity' | 'comparisonView'>> = {}) {
  const next = { ...getPreview(), ...comparison };
  if (!target) next.comparison = 'off';
  const url = new URL(location.href);
  if (target) url.searchParams.set('__sk', target); else url.searchParams.delete('__sk');
  if (variant) url.searchParams.set('__sk_variant', variant); else url.searchParams.delete('__sk_variant');
  for (const key of ['__sk_compare', '__sk_opacity', '__sk_view']) url.searchParams.delete(key);
  if (next.comparison !== 'off') {
    url.searchParams.set('__sk_compare', next.comparison);
    if (next.comparison === 'overlay') url.searchParams.set('__sk_opacity', String(next.opacity));
    if (next.comparison === 'switch') url.searchParams.set('__sk_view', next.comparisonView);
  }
  history.replaceState(history.state, '', url);
  setPreview({ target, variant, comparison: next.comparison, opacity: next.opacity, comparisonView: next.comparisonView });
}
async function requestSync() {
  const response = await fetch('/__skelcast/sync', { method: 'POST', headers: { 'X-SkelCast-Dev': '1' } });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error ?? 'Operation failed');
  return json;
}
async function refresh() {
  const revision = ++refreshRevision;
  try {
    const response = await fetch('/__skelcast/state');
    if (!response.ok) throw new Error('Unable to read skeleton state');
    const next: DevState = await response.json();
    if (revision !== refreshRevision) return;
    data = next;
    if (data.statuses.every(status => status.state === 'ready')) note = '';
    if (!selected) selected = listBoundaries()[0]?.id ?? document.querySelector<HTMLElement>('[data-sk-initial]')?.dataset.skInitial ?? data.artifacts[0]?.id ?? '';
    if (!replaceArtifacts(data.artifacts, data.versions)) render();
  } catch {
    if (revision !== refreshRevision) return;
    note = 'Unable to read skeleton status. Ask your coding agent to run skelcast check.'; render();
  }
}
const esc = (value: unknown) => escapeHTML(value ?? '');
function render() {
  if (!selectedByUser) {
    const mounted = listBoundaries();
    const active = mounted.find(boundary => boundary.kind === 'page') ?? mounted[0];
    if (active) selected = active.id;
  }
  const preview = getPreview();
  const artifact = data.artifacts.find(a => a.id === selected);
  const mounted = listBoundaries().filter(b => b.id === selected);
  const pending = mounted.some(b => b.pending);
  const status = data.statuses.find(s => s.id === selected);
  const held = !!artifact && forced(selected, artifact.kind);
  const comparing = preview.comparison !== 'off' && held;
  const stateNames = { ready: 'Up to date', stale: 'Out of date', missing: 'Missing', corrupt: 'Modified' };
  const needsUpdate = data.statuses.some(item => item.state !== 'ready');
  const requestedVariant = (artifact && forced(selected, artifact.kind) ? preview.variant : undefined) ?? mounted[0]?.variant ?? artifact?.defaultVariant ?? '';
  const variant = artifact?.variants[requestedVariant] ? requestedVariant : artifact?.defaultVariant ?? '';
  const template = document.createElement('template');
  template.innerHTML = `<style>${devtoolsCSS}</style>
    <div class="bar" data-ui-key="bar" role="group" aria-label="SkelCast preview controls"><span class="title"><span class="brand-mark">${icon('layers')}</span>SkelCast</span>
    <div class="controls" data-ui-key="controls">
    <div class="select-control region-control" title="Loading region">${icon('region')}<select id="target" aria-label="Loading region">${picking ? '<option value="" selected>Click a region…</option>' : ''}${data.artifacts.map(a => `<option value="${esc(a.id)}" ${!picking && a.id === selected ? 'selected' : ''}>${esc(a.id)}</option>`).join('')}<option value="__sk_pick__">${picking ? 'Cancel picking' : 'Pick region…'}</option></select></div>
    <label class="preview-toggle">Show skeleton<input id="preview" type="checkbox" role="switch" ${held ? 'checked' : ''} ${!artifact ? 'disabled' : ''}></label>
    <button id="compare" class="compare-button" aria-pressed="${comparing}" ${!artifact ? 'disabled' : ''}>${icon('compare')}Compare</button>
    ${artifact && Object.keys(artifact.variants).length > 1 ? `<div class="select-control variant-control" title="Layout variant"><select id="variant" aria-label="Layout variant">${Object.keys(artifact.variants).map(v => `<option value="${esc(v)}" ${v === variant ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>` : ''}</div>
    <div class="bar-actions" data-ui-key="bar-actions"><span class="generation-status${needsUpdate ? ' warning' : ''}" role="status" aria-label="Skeleton status">${status ? status.state === 'ready' && needsUpdate ? 'Updates available' : stateNames[status.state] : 'Reading…'}</span>${needsUpdate ? `<button id="sync" class="update-button" ${busy ? 'disabled' : ''}>${busy ? 'Updating…' : 'Update skeletons'}</button>` : ''}</div></div>
    ${note ? `<p class="notice" role="alert">${esc(note)}</p>` : ''}
    ${comparing ? `<div class="comparison-bar" data-ui-key="comparison-bar" role="group" aria-label="Comparison controls">
      <select id="comparison" aria-label="Comparison mode"><option value="overlay">Overlay</option><option value="side-by-side">Side by side</option><option value="switch">One-click switch</option></select>
      <span role="status">${pending ? 'Waiting for real content…' : !mounted.length ? 'Region is not mounted' : preview.comparison === 'side-by-side' ? 'Real content (left) · Skeleton (right)' : preview.comparison === 'overlay' ? 'Skeleton over real content' : `Showing: ${preview.comparisonView === 'content' ? 'Real content' : 'Skeleton'}`}</span>
      ${preview.comparison === 'overlay' ? `<label for="opacity">Opacity <input id="opacity" type="range" min="0" max="100" step="5" value="${Math.round(preview.opacity * 100)}"><output for="opacity">${Math.round(preview.opacity * 100)}%</output></label>` : ''}
      ${preview.comparison === 'switch' ? `<button id="switch-view" ${pending || !mounted.length ? 'disabled' : ''}>Show ${preview.comparisonView === 'content' ? 'skeleton' : 'real content'}</button>` : ''}
    </div>` : ''}`;
  patchChildren(shadow, template.content);
  (shadow.querySelector('#target') as HTMLSelectElement).value = picking ? '' : selected;
  const comparisonSelect = shadow.querySelector<HTMLSelectElement>('#comparison');
  if (comparisonSelect) comparisonSelect.value = preview.comparison;
  const bind = (id: string, event: string, fn: (event: Event) => void) => {
    const element = shadow.querySelector(`#${id}`);
    if (element) Reflect.set(element, `on${event}`, fn);
  };
  bind('preview', 'change', event => { selectedByUser = true; const checked = (event.target as HTMLInputElement).checked; writeURL(checked ? selected : null, checked ? preview.variant : undefined, { comparison: 'off' }); });
  bind('compare', 'click', () => { selectedByUser = true; writeURL(comparing ? null : selected, comparing ? undefined : preview.variant, { comparison: comparing ? 'off' : 'overlay' }); });
  bind('comparison', 'change', event => {
    const comparison = (event.target as HTMLSelectElement).value as ComparisonMode;
    writeURL(selected, preview.variant, { comparison });
  });
  bind('opacity', 'input', event => writeURL(preview.target, preview.variant, { opacity: Number((event.target as HTMLInputElement).value) / 100 }));
  bind('switch-view', 'click', () => writeURL(preview.target, preview.variant, { comparisonView: preview.comparisonView === 'content' ? 'skeleton' : 'content' }));
  bind('target', 'change', event => {
    const value = (event.target as HTMLSelectElement).value;
    if (value === '__sk_pick__') { picking = !picking; render(); return; }
    if (!value) return;
    selected = value; selectedByUser = true; picking = false;
    if (preview.target) writeURL(selected);
    else render();
  });
  bind('variant', 'change', event => writeURL(getPreview().target, (event.target as HTMLSelectElement).value));
  bind('sync', 'click', () => void updateSkeletons());
}
async function updateSkeletons() {
  busy = true; note = ''; render();
  try { await requestSync(); await refresh(); }
  catch { note = 'Skeleton update failed. Ask your coding agent to run skelcast sync.'; }
  finally { busy = false; render(); }
}

function onDocumentClick(event: MouseEvent) {
  const path = event.composedPath();
  if (path.includes(host)) return;
  if (!picking) return;
  const boundary = (event.target as Element)?.closest<HTMLElement>('[data-sk-boundary]');
  if (!boundary) return;
  event.preventDefault(); event.stopPropagation();
  selected = boundary.dataset.skBoundary!; selectedByUser = true; picking = false; writeURL(selected);
}
document.addEventListener('click', onDocumentClick, true);
window.addEventListener('popstate', readURL);
const unsubscribe = subscribe(render);
readURL(); void refresh();
const hot = (import.meta as any).hot;
hot?.on('skelcast:update', refresh);
hot?.dispose(() => { refreshRevision++; unsubscribe(); document.removeEventListener('click', onDocumentClick, true); window.removeEventListener('popstate', readURL); host.remove(); });
