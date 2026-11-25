import { forced, getPreview, listBoundaries, replaceArtifacts, setPreview, subscribe } from './runtime/core.js';
import type { SkeletonArtifact, SkeletonTarget } from './types.js';
import type { TargetStatus } from './generator.js';
import { auditBoundaryLayout, type BoundaryLayoutReport } from './browser.js';
import { patchChildren } from './devtools/dom.js';

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
const css = `
:host{font:12px/1.5 ui-sans-serif,system-ui,sans-serif;color:#dce7f5;color-scheme:dark}*{box-sizing:border-box}button,select,input,textarea{font:inherit;color:inherit}button,select{border:1px solid #354458;border-radius:7px;background:#1b293c;padding:7px 9px}button{cursor:pointer}button:hover{background:#2a3d55}button:disabled{opacity:.5;cursor:wait}.bar{display:flex;gap:7px;align-items:center;background:#111c2b;padding:9px;border:1px solid #354458;border-radius:12px;box-shadow:0 8px 30px #0003}.badge{width:7px;height:7px;border-radius:50%;background:#79d8bd;display:inline-block;margin-right:5px}.panel{width:min(400px,calc(100vw - 36px));max-height:70vh;overflow:auto;background:#111c2b;border:1px solid #354458;border-radius:12px;margin-bottom:8px;padding:16px;box-shadow:0 8px 30px #0003}h3{font-size:14px;margin:0 0 12px}p{margin:7px 0;color:#9bacc2}label{display:flex;justify-content:space-between;align-items:center;margin:8px 0;gap:12px}input,textarea{background:#0a1422;border:1px solid #354458;border-radius:5px;padding:6px}input{width:95px}textarea{width:100%;height:76px;resize:vertical}.actions{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0}.diagnostic{background:#1b293c;border-left:2px solid #dca45d;padding:8px;margin:8px 0;overflow-wrap:anywhere}.notice{color:#e9c883;max-width:365px;overflow-wrap:anywhere}small{color:#9bacc2}summary{cursor:pointer}select{max-width:150px}.title{white-space:nowrap}.active{border-color:#79d8bd}a{color:#91c9ff}
`;
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
  const template = document.createElement('template');
  template.innerHTML = `<style>${css}.bar{flex-wrap:wrap}button{white-space:nowrap}.panel{margin-left:auto}@media(max-width:600px){.bar{max-width:calc(100vw - 36px)}.title{display:none}select{min-width:0;max-width:130px}.bar button{padding:6px 9px}}</style>
    ${open ? `<section class="panel" data-ui-key="panel"><h3>Skeleton inspector · ${esc(selected)}</h3>
      <p>Showing: <strong>${esc(reason)}</strong> · Actual state: ${pending ? 'Loading' : mounted.length ? 'Ready' : 'Not mounted'}</p>
      <p>Artifact: ${status ? stateNames[status.state] : 'Reading'}${status?.reason ? ` · ${esc(status.reason)}` : ''}</p>
      <div class="actions"><button id="pick" class="${picking ? 'active' : ''}">${picking ? 'Click a region' : 'Pick region'}</button><button id="copy">Copy link</button><button id="source">Open source</button><button id="layout" ${busy || pending || !mounted.length ? 'disabled' : ''}>Check layout</button><button id="sync" ${busy ? 'disabled' : ''}>${busy ? 'Updating…' : 'Sync artifacts'}</button></div>
      <label>Highlight fallbacks<input id="highlight" type="checkbox" ${preview.highlight ? 'checked' : ''}></label>
      <details data-ui-key="hints"><summary>Generation hints</summary><p>Save small generation hints. Application source remains the layout authority.</p>
      <label>Repeat count<input id="repeat" type="number" min="1" max="24" value="${esc(draft.repeat)}"></label>
      <label>Text lines<input id="lines" type="number" min="1" max="8" value="${esc(draft.lines)}"></label>
      <label>Fallback height<input id="minHeight" type="number" min="16" max="2000" value="${esc(draft.minHeight)}"></label>
      <small>Field bindings (JSON object)</small><textarea id="bindings">${esc(draft.bindings)}</textarea>
      <div class="actions"><button id="save" ${busy ? 'disabled' : ''}>Save and generate</button></div></details>
      <details data-ui-key="diagnostics"><summary>Diagnostics · ${artifact?.diagnostics.length ?? 0}</summary>${artifact?.diagnostics.map(d => `<div class="diagnostic"><strong>${esc(d.code)}</strong> ${esc(d.message)}<br><small>${esc(d.file)}:${d.line}</small>${d.node ? `<br><button data-source-node="${esc(d.node)}">Open source</button>` : ''}</div>`).join('') || '<p>No diagnostics.</p>'}</details>
      <details data-ui-key="evidence"><summary>Evidence · ${artifact?.evidence.length ?? 0}</summary>${artifact?.evidence.slice(0, 30).map(e => `<p><small>${esc(e.expression)} → ${esc(e.decision)}</small></p>`).join('') ?? ''}</details>
      ${layout ? `<details data-ui-key="layout"><summary>Layout check · ${layout.needsReview ? 'Needs review' : 'Within tolerance'}</summary><p>${esc(layout.variant)} · ${layout.viewport.width} × ${layout.viewport.height}<br>Width Δ ${layout.delta.width.toFixed(1)}px · Height Δ ${layout.delta.height.toFixed(1)}px<br>Following content shift ${layout.delta.followingContentShift.toFixed(1)}px · Overflow ${layout.skeleton.overflowX.toFixed(1)}px<br>Visible placeholders ${layout.skeleton.visiblePlaceholders}/${layout.skeleton.placeholders}</p>${layout.issues.map(issue => `<p>${esc(issue.code)}: ${esc(issue.message)}</p>`).join('')}<small>Geometry snapshot; excludes pixel similarity and CLS.</small></details>` : ''}
      ${note ? `<p class="notice" role="status">${esc(note)}</p>` : ''}
    </section>` : ''}
    <div class="bar" data-ui-key="bar"><span class="title"><span class="badge"></span>SkelCast</span><select id="mode" aria-label="Preview mode">${modes}</select>
    <select id="target" aria-label="Loading region">${data.artifacts.map(a => `<option value="${esc(a.id)}" ${a.id === selected ? 'selected' : ''}>${esc(a.id)}</option>`).join('')}</select>
    ${artifact && Object.keys(artifact.variants).length > 1 ? `<select id="variant" aria-label="Layout variant">${Object.keys(artifact.variants).map(v => `<option value="${esc(v)}" ${v === (preview.variant ?? mounted[0]?.variant ?? artifact.defaultVariant) ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>` : ''}
    <button id="play">${playing ? 'Release' : 'Play'}</button><button id="more" aria-expanded="${open}">${open ? 'Collapse' : 'More'}</button>${preview.target ? '<button id="exit">Exit</button>' : ''}</div>`;
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
document.addEventListener('click', event => {
  if (!picking || event.composedPath().includes(host)) return;
  const boundary = (event.target as Element)?.closest<HTMLElement>('[data-sk-boundary]');
  if (!boundary) return;
  event.preventDefault(); event.stopPropagation();
  selected = boundary.dataset.skBoundary!; selectedByUser = true; picking = false; writeURL(selected); render();
}, true);
window.addEventListener('popstate', readURL);
subscribe(render);
readURL(); render(); void refresh();
const hot = (import.meta as any).hot;
hot?.on('skelcast:update', refresh);
hot?.dispose(() => { stopReplay(); host.remove(); });
