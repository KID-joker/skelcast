import { forced, getPreview, listBoundaries, replaceArtifacts, setPreview, subscribe } from './runtime/core.js';
import type { SkeletonArtifact, SkeletonTarget } from './types.js';
import type { TargetStatus } from './generator.js';
import { auditBoundaryLayout, type BoundaryLayoutReport } from './browser.js';
import { patchChildren } from './devtools/dom.js';
import { buildRepairGuide, type RepairGuide } from './devtools/repairs.js';
import { devtoolsCSS } from './devtools/styles.js';
import { icon } from './devtools/icons.js';

interface DevState { artifacts: SkeletonArtifact[]; statuses: TargetStatus[]; targets: SkeletonTarget[] }
let data: DevState = { artifacts: [], statuses: [], targets: [] };
let selected = '';
let selectedByUser = false;
let open = false;
let playing = false;
let picking = false;
let replayTimer: ReturnType<typeof setTimeout> | undefined;
let note = '';
let busy = false;
let inspected: { id: string; node: string } | undefined;
interface HintDraft { repeat: string; lines: string; minHeight: string; bindings: string }
const drafts = new Map<string, HintDraft>();
const layoutReports = new Map<string, BoundaryLayoutReport>();
const disclosures = new Map<string, boolean>();
let panelScroll = 0;
function hintDraft(target?: SkeletonTarget): HintDraft {
  return drafts.get(selected) ?? {
    repeat: String(target?.hints?.repeat ?? 4),
    lines: String(target?.hints?.lines ?? 1),
    minHeight: String(target?.hints?.minHeight ?? 96),
    bindings: JSON.stringify(target?.hints?.bindings ?? {}, null, 2),
  };
}
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
  setPreview({ target: target && target !== 'auto' ? target : null, variant: query.get('__sk_variant') ?? undefined });
}
function writeURL(target: string | null, variant?: string) {
  const url = new URL(location.href);
  if (target) url.searchParams.set('__sk', target); else url.searchParams.delete('__sk');
  if (variant) url.searchParams.set('__sk_variant', variant); else url.searchParams.delete('__sk_variant');
  history.replaceState(history.state, '', url);
  setPreview({ target, variant });
}
async function request(endpoint: string, body: unknown) {
  const response = await fetch(`/__skelcast/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SkelCast-Dev': '1' }, body: JSON.stringify(body) });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error ?? 'Operation failed');
  return json;
}
async function refresh() {
  try {
    const response = await fetch('/__skelcast/state');
    if (!response.ok) throw new Error('Unable to read skeleton state');
    data = await response.json(); replaceArtifacts(data.artifacts);
    if (!selected) selected = listBoundaries()[0]?.id ?? document.querySelector<HTMLElement>('[data-sk-initial]')?.dataset.skInitial ?? data.artifacts[0]?.id ?? '';
    render();
  } catch (error) { note = String(error); render(); }
}
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
function repairPanel(artifact: SkeletonArtifact, variant: string, guide: RepairGuide): string {
  const template = document.createElement('template');
  template.innerHTML = artifact.variants[variant].html;
  const unresolved = [...template.content.querySelectorAll<HTMLElement>('[data-sk-fallback],[data-sk-opaque]')].some(element => element.dataset.skNode === inspected?.node);
  return `<section class="repair" aria-label="Fallback details" data-ui-key="repair-${esc(inspected?.node)}">
    <h4>Fallback details · ${esc(variant)}</h4><button id="close-repair">Close details</button>
    ${!unresolved ? '<p role="status">No fallback remains at this location in this variant.</p>' : ''}
    ${guide.source ? `<p>${esc(guide.source.file)}:${guide.source.line} <button data-source-node="${esc(inspected?.node)}">Open source</button></p>` : '<p>Source location unavailable. Sync artifacts to refresh diagnostics.</p>'}
    ${guide.diagnostics.map(d => `<div class="diagnostic"><strong>${esc(d.code)}</strong> ${esc(d.message)}${d.expression ? `<br><small>Source expression</small><pre><code>${esc(d.expression)}</code></pre>` : ''}</div>`).join('')}
    ${guide.evidence.length ? `<details data-ui-key="repair-evidence"><summary>Related evidence · ${guide.evidence.length}</summary>${guide.evidence.map(e => `<p>${esc(e.expression)} → ${esc(e.decision)}</p>`).join('')}</details>` : ''}
    ${unresolved ? guide.examples.map((example, index) => `<div class="repair-example"><h4>${esc(example.title)}</h4><p>${esc(example.description)}</p>${example.files.map(file => `<small>${esc(file.name)}</small><pre><code>${esc(file.code)}</code></pre>`).join('')}
      <div class="actions">${example.files.length ? `<button data-repair-copy="${index}" aria-label="Copy ${esc(example.kind)} example">Copy example</button>` : ''}${example.bindings ? `<button data-repair-binding="${index}">Add to hint draft</button>` : ''}</div></div>`).join('') : ''}
  </section>`;
}
function render() {
  for (const details of shadow.querySelectorAll<HTMLDetailsElement>('details[data-ui-key]')) {
    disclosures.set(details.dataset.uiKey!, details.open);
  }
  const previousPanel = shadow.querySelector<HTMLElement>('.panel');
  if (previousPanel) panelScroll = previousPanel.scrollTop;
  if (!selectedByUser) {
    const mounted = listBoundaries();
    const active = mounted.find(boundary => boundary.kind === 'page') ?? mounted[0];
    if (active) selected = active.id;
  }
  const preview = getPreview();
  for (const initial of document.querySelectorAll<HTMLElement>('[data-sk-initial]')) {
    (initial.shadowRoot ?? initial).querySelector('[data-sk-artifact]')?.toggleAttribute('data-sk-highlight', preview.highlight);
  }
  const artifact = data.artifacts.find(a => a.id === selected);
  const target = data.targets.find(t => t.id === selected);
  const mounted = listBoundaries().filter(b => b.id === selected);
  const pending = mounted.some(b => b.pending);
  const status = data.statuses.find(s => s.id === selected);
  const reason = artifact && forced(selected, artifact.kind) ? playing ? 'Playing' : 'Forced preview' : pending ? artifact?.kind === 'page' ? 'Page loading' : 'Request loading' : 'Content';
  const stateNames = { ready: 'Up to date', stale: 'Out of date', missing: 'Missing', corrupt: 'Modified' };
  const modes = `<option value="auto">Follow loading</option><option value="page">Hold page</option><option value="selected">Hold region</option>`;
  const mode = preview.target === 'page' ? 'page' : preview.target ? 'selected' : 'auto';
  const draft = hintDraft(target);
  const layout = layoutReports.get(selected);
  const requestedVariant = (artifact && forced(selected, artifact.kind) ? preview.variant : undefined) ?? mounted[0]?.variant ?? artifact?.defaultVariant ?? '';
  const variant = artifact?.variants[requestedVariant] ? requestedVariant : artifact?.defaultVariant ?? '';
  const diagnostics = artifact?.diagnostics.filter(d => !d.variants || d.variants.includes(variant)) ?? [];
  const guide = artifact && inspected?.id === selected ? buildRepairGuide(artifact, inspected.node, variant, target) : undefined;
  const template = document.createElement('template');
  template.innerHTML = `<style>${devtoolsCSS}</style>
    ${open ? `<section id="inspector" class="panel" data-ui-key="panel" aria-label="Skeleton inspector"><div class="panel-heading"><h3>Skeleton inspector</h3><span class="eyebrow">Devtools</span></div>
      <p class="region-name">${esc(selected)}</p>
      <div class="state-card"><p>Showing: <strong>${esc(reason)}</strong> · Actual state: ${pending ? 'Loading' : mounted.length ? 'Ready' : 'Not mounted'}</p>
      <p><span class="badge${status && status.state !== 'ready' ? ' warning' : ''}" aria-hidden="true"></span>Artifact: ${status ? stateNames[status.state] : 'Reading'}${status?.reason ? ` · ${esc(status.reason)}` : ''}</p></div>
      ${guide && artifact ? repairPanel(artifact, variant, guide) : ''}
      <div class="actions"><button id="pick" class="${picking ? 'active' : ''}">${picking ? 'Click a region' : 'Pick region'}</button><button id="copy">Copy link</button><button id="source">Open source</button><button id="layout" ${busy || pending || !mounted.length ? 'disabled' : ''}>Check layout</button><button id="sync" ${busy ? 'disabled' : ''}>${busy ? 'Updating…' : 'Sync artifacts'}</button></div>
      <label>Highlight fallbacks<input id="highlight" type="checkbox" ${preview.highlight ? 'checked' : ''}></label>
      ${preview.highlight ? '<p>Click a highlighted fallback to inspect its source and repair examples.</p>' : ''}
      <details data-ui-key="hints"><summary>Generation hints</summary><p>Save small generation hints. Application source remains the layout authority.</p>
      <label>Repeat count<input id="repeat" type="number" min="1" max="24" value="${esc(draft.repeat)}"></label>
      <label>Text lines<input id="lines" type="number" min="1" max="8" value="${esc(draft.lines)}"></label>
      <label>Fallback height<input id="minHeight" type="number" min="16" max="2000" value="${esc(draft.minHeight)}"></label>
      <small>Field bindings (JSON object)</small><textarea id="bindings">${esc(draft.bindings)}</textarea>
      <div class="actions"><button id="save" ${busy ? 'disabled' : ''}>Save and generate</button></div></details>
      <details data-ui-key="diagnostics"><summary>Diagnostics · ${diagnostics.length}</summary>${diagnostics.map(d => `<div class="diagnostic"><strong>${esc(d.code)}</strong> ${esc(d.message)}<br><small>${esc(d.file)}:${d.line}</small>${d.node ? `<br><button data-source-node="${esc(d.node)}">Open source</button>${d.code === 'FALLBACK' ? `<button data-inspect-node="${esc(d.node)}">Inspect fallback</button>` : ''}` : ''}</div>`).join('') || '<p>No diagnostics.</p>'}</details>
      <details data-ui-key="evidence"><summary>Evidence · ${artifact?.evidence.length ?? 0}</summary>${artifact?.evidence.slice(0, 30).map(e => `<p><small>${esc(e.expression)} → ${esc(e.decision)}</small></p>`).join('') ?? ''}</details>
      ${layout ? `<details data-ui-key="layout"><summary>Layout check · ${layout.needsReview ? 'Needs review' : 'Within tolerance'}</summary><p>${esc(layout.variant)} · ${layout.viewport.width} × ${layout.viewport.height}<br>Width Δ ${layout.delta.width.toFixed(1)}px · Height Δ ${layout.delta.height.toFixed(1)}px<br>Following content shift ${layout.delta.followingContentShift.toFixed(1)}px · Overflow ${layout.skeleton.overflowX.toFixed(1)}px<br>Visible placeholders ${layout.skeleton.visiblePlaceholders}/${layout.skeleton.placeholders}<br>Internal anchors: ${layout.anchors.compared} compared, ${layout.anchors.mismatched} mismatched, ${layout.anchors.missing} missing</p>${layout.issues.map(issue => `<p>${esc(issue.code)}: ${esc(issue.message)}</p>`).join('')}<small>Geometry and marked anchors; use the audit report for screenshot overlays.</small></details>` : ''}
      ${note ? `<p class="notice" role="status">${esc(note)}</p>` : ''}
    </section>` : ''}
    <div class="bar" data-ui-key="bar" role="group" aria-label="SkelCast preview controls"><span class="title"><span class="brand-mark">${icon('layers')}</span>SkelCast</span>
    <div class="controls" data-ui-key="controls"><div class="select-control${mode !== 'auto' ? ' is-active' : ''}" title="Preview mode">${icon('mode')}<select id="mode" aria-label="Preview mode">${modes}</select></div>
    <div class="select-control region-control" title="Loading region">${icon('region')}<select id="target" aria-label="Loading region">${data.artifacts.map(a => `<option value="${esc(a.id)}" ${a.id === selected ? 'selected' : ''}>${esc(a.id)}</option>`).join('')}</select></div>
    ${artifact && Object.keys(artifact.variants).length > 1 ? `<div class="select-control variant-control" title="Layout variant"><select id="variant" aria-label="Layout variant">${Object.keys(artifact.variants).map(v => `<option value="${esc(v)}" ${v === variant ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>` : ''}</div>
    <div class="bar-actions" data-ui-key="bar-actions"><button id="play" class="icon-button" aria-label="${playing ? 'Release' : 'Play'}" title="${playing ? 'Release preview' : 'Play loading preview'}" aria-pressed="${playing}">${icon(playing ? 'stop' : 'play')}</button><button id="more" class="icon-button" aria-label="${open ? 'Collapse' : 'More'}" title="${open ? 'Collapse inspector' : 'Open inspector'}" aria-expanded="${open}"${open ? ' aria-controls="inspector"' : ''}>${icon('settings')}</button>${preview.target ? `<button id="exit" class="icon-button" aria-label="Exit" title="Exit forced preview">${icon('close')}</button>` : ''}</div></div>`;
  patchChildren(shadow, template.content);
  for (const details of shadow.querySelectorAll<HTMLDetailsElement>('details[data-ui-key]')) {
    details.open = disclosures.get(details.dataset.uiKey!) ?? false;
  }
  const panel = shadow.querySelector<HTMLElement>('.panel');
  if (panel) panel.scrollTop = panelScroll;
  (shadow.querySelector('#mode') as HTMLSelectElement).value = mode;
  const bind = (id: string, event: string, fn: (event: Event) => void) => {
    const element = shadow.querySelector(`#${id}`);
    if (element) Reflect.set(element, `on${event}`, fn);
  };
  for (const field of ['repeat', 'lines', 'minHeight', 'bindings'] as const) {
    bind(field, 'input', event => {
      drafts.set(selected, { ...hintDraft(target), [field]: (event.target as HTMLInputElement | HTMLTextAreaElement).value });
    });
  }
  bind('more', 'click', () => { open = !open; render(); });
  bind('mode', 'change', event => { stopReplay(); const value = (event.target as HTMLSelectElement).value; writeURL(value === 'auto' ? null : value === 'page' ? 'page' : selected, preview.variant); });
  bind('target', 'change', event => { selected = (event.target as HTMLSelectElement).value; selectedByUser = true; if (getPreview().target && getPreview().target !== 'page') writeURL(selected); render(); });
  bind('variant', 'change', event => writeURL(getPreview().target, (event.target as HTMLSelectElement).value));
  bind('exit', 'click', () => { stopReplay(); writeURL(null); });
  bind('play', 'click', () => {
    if (playing) { stopReplay(); writeURL(null); return; }
    playing = true; writeURL(selected || 'page', preview.variant);
    replayTimer = setTimeout(() => { playing = false; writeURL(null); }, 1500);
  });
  bind('highlight', 'change', event => setPreview({ highlight: (event.target as HTMLInputElement).checked }));
  bind('pick', 'click', () => { picking = !picking; render(); });
  bind('copy', 'click', () => { void navigator.clipboard.writeText(location.href).then(() => { note = 'Link copied'; render(); }).catch(error => { note = `Unable to copy: ${error}`; render(); }); });
  bind('source', 'click', () => void openSource());
  for (const button of shadow.querySelectorAll<HTMLElement>('[data-source-node]')) button.onclick = () => { void openSource(button.dataset.sourceNode); };
  for (const button of shadow.querySelectorAll<HTMLElement>('[data-inspect-node]')) button.onclick = () => inspectFallback(selected, button.dataset.inspectNode!);
  bind('close-repair', 'click', () => { inspected = undefined; render(); });
  for (const button of shadow.querySelectorAll<HTMLElement>('[data-repair-copy]')) button.onclick = () => {
    const example = guide?.examples[Number(button.dataset.repairCopy)];
    if (example) void navigator.clipboard.writeText(example.files.map(file => `${file.name}\n${file.code}`).join('\n\n')).then(() => { note = 'Repair example copied'; render(); }).catch(error => { note = `Unable to copy: ${error}`; render(); });
  };
  for (const button of shadow.querySelectorAll<HTMLElement>('[data-repair-binding]')) button.onclick = () => {
    const example = guide?.examples[Number(button.dataset.repairBinding)];
    if (!example?.bindings) return;
    try {
      const draft = hintDraft(target), current: unknown = JSON.parse(draft.bindings);
      if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('Bindings must be a JSON object');
      drafts.set(selected, { ...draft, bindings: JSON.stringify({ ...example.bindings, ...current }, null, 2) });
      const hints = shadow.querySelector<HTMLDetailsElement>('[data-ui-key="hints"]');
      if (hints) hints.open = true;
      note = 'Example added to draft; existing bindings retained. Review values, then Save and generate.';
      render();
      shadow.querySelector<HTMLTextAreaElement>('#bindings')?.focus();
    } catch (error) { note = `Unable to add example: ${error}`; render(); }
  };
  bind('sync', 'click', () => void mutate('sync', {}));
  bind('layout', 'click', () => void checkLayout());
  bind('save', 'click', () => {
    try {
      const number = (id: string) => Number((shadow.querySelector(`#${id}`) as HTMLInputElement).value);
      const bindings = JSON.parse((shadow.querySelector('#bindings') as HTMLTextAreaElement).value);
      const id = selected, submitted = drafts.get(id);
      void mutate('hints', { id, hints: { repeat: number('repeat'), lines: number('lines'), minHeight: number('minHeight'), bindings } }, () => {
        if (drafts.get(id) === submitted) drafts.delete(id);
      });
    } catch (error) { note = `Invalid hints: ${error}`; render(); }
  });
}
async function checkLayout() {
  const boundary = listBoundaries().find(item => item.id === selected && item.element);
  if (!boundary?.element) return;
  stopReplay(); busy = true; note = ''; render();
  try {
    const report = await auditBoundaryLayout(boundary.element);
    layoutReports.set(report.id, report);
  } catch (error) { note = String(error); }
  finally { busy = false; render(); }
}
function stopReplay() { if (replayTimer) clearTimeout(replayTimer); playing = false; }
async function openSource(node?: string) {
  try { const result = await request('open', { id: selected, node }); await fetch(result.url); note = 'Requested source file in your editor'; }
  catch (error) { note = String(error); }
  render();
}
async function mutate(endpoint: string, body: unknown, saved?: () => void) {
  busy = true; note = ''; render();
  try { await request(endpoint, body); saved?.(); note = 'Artifacts updated'; await refresh(); }
  catch (error) { note = String(error); }
  finally { busy = false; render(); }
}
function inspectFallback(id: string, node: string) {
  inspected = { id, node }; selected = id; selectedByUser = true; open = true; picking = false;
  stopReplay();
  const panel = shadow.querySelector<HTMLElement>('.panel');
  if (panel) panel.scrollTop = 0;
  writeURL(id, getPreview().variant);
}
function onDocumentClick(event: MouseEvent) {
  const path = event.composedPath();
  if (path.includes(host)) return;
  const fallback = path.find((node): node is HTMLElement => node instanceof HTMLElement && node.matches('[data-sk-fallback],[data-sk-opaque]'));
  const artifact = path.find((node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute('data-sk-artifact'));
  if (getPreview().highlight && fallback?.dataset.skNode && artifact?.dataset.skArtifact) {
    event.preventDefault(); event.stopPropagation(); inspectFallback(artifact.dataset.skArtifact, fallback.dataset.skNode); return;
  }
  if (!picking) return;
  const boundary = (event.target as Element)?.closest<HTMLElement>('[data-sk-boundary]');
  if (!boundary) return;
  event.preventDefault(); event.stopPropagation();
  selected = boundary.dataset.skBoundary!; selectedByUser = true; picking = false; writeURL(selected); render();
}
document.addEventListener('click', onDocumentClick, true);
window.addEventListener('popstate', readURL);
const unsubscribe = subscribe(render);
readURL(); render(); void refresh();
const hot = (import.meta as any).hot;
hot?.on('skelcast:update', refresh);
hot?.dispose(() => { stopReplay(); unsubscribe(); document.removeEventListener('click', onDocumentClick, true); window.removeEventListener('popstate', readURL); host.remove(); });
