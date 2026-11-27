import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { BoundaryLayoutReport, LayoutTolerance } from './browser.js';
import type { SkeletonArtifact } from './types.js';
import { escapeHTML as escape } from './shared.js';

export interface AuditOptions extends LayoutTolerance {
  url: string;
  outDir: string;
  id?: string;
  viewports?: { width: number; height: number }[];
  /** Existing Playwright storage state; login itself stays under user control. */
  storageState?: string;
  timeoutMs?: number;
}
export interface AuditCase {
  id: string;
  variant: string;
  instance: number;
  viewport: { width: number; height: number };
  report?: BoundaryLayoutReport;
  screenshots?: { content: string; skeleton: string };
  error?: string;
}
export interface AuditReport { version: 1; url: string; needsReview: boolean; cases: AuditCase[] }

export function parseViewports(value = '1440x900,390x844'): { width: number; height: number }[] {
  const entries = value.split(',');
  if (entries.length > 12) throw new Error('Use between 1 and 12 audit viewports');
  return entries.map(entry => {
    const match = /^(\d+)x(\d+)$/.exec(entry.trim());
    if (!match || match.slice(1).some(n => Number(n) < 100 || Number(n) > 10000)) throw new Error(`Invalid viewport: ${entry}; use WIDTHxHEIGHT (100–10000px)`);
    return { width: Number(match[1]), height: Number(match[2]) };
  });
}

async function settled(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].filter(image => image.getClientRects().length && image.loading !== 'lazy').map(image => image.decode().catch(() => {})));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

/** Runs against a user's existing Vite dev server. This module is Node-only;
 * Playwright is optional and is loaded only when the audit command is invoked. */
export async function auditProject(options: AuditOptions): Promise<AuditReport> {
  const url = new URL(options.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Audit requires an http(s) development URL');
  const viewports = options.viewports ?? parseViewports();
  if (!viewports.length || viewports.length > 12 || viewports.some(v => !Number.isInteger(v.width) || !Number.isInteger(v.height) || v.width < 100 || v.height < 100 || v.width > 10000 || v.height > 10000)) throw new Error('Invalid audit viewports');
  let playwright: typeof import('@playwright/test');
  try { playwright = await import('@playwright/test'); }
  catch { throw new Error('Browser audit requires @playwright/test. Install it and run playwright install chromium.'); }
  const browser = await playwright.chromium.launch();
  const output = path.resolve(options.outDir);
  const result: AuditReport = { version: 1, url: url.href, needsReview: false, cases: [] };
  try {
    await mkdir(output, { recursive: true });
    const context = await browser.newContext({ storageState: options.storageState, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(options.timeoutMs ?? 30000);
    let capture: ((phase: 'content' | 'skeleton') => Promise<void>) | undefined;
    await page.exposeFunction('__skelcastCapture', async (phase: 'content' | 'skeleton') => {
      if (phase !== 'content' && phase !== 'skeleton') throw new Error('Invalid screenshot phase');
      if (!capture) throw new Error('No audit measurement is active');
      await capture(phase);
    });
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto(url.href);
      const stateResponse = await page.request.get(new URL('/__skelcast/state', url).href);
      if (!stateResponse.ok()) throw new Error('Audit requires an application served by the SkelCast Vite development plugin');
      const state = await stateResponse.json() as { artifacts: SkeletonArtifact[] };
      const artifacts = state.artifacts.filter(artifact => !options.id || artifact.id === options.id);
      if (!artifacts.length) throw new Error(`Unknown skeleton: ${options.id}`);
      const selector = options.id ? `[data-sk-boundary=${JSON.stringify(options.id)}]` : '[data-sk-boundary]';
      await page.locator(selector).first().waitFor({ state: 'attached' });
      await page.waitForFunction(selector => {
        const boundaries = [...document.querySelectorAll(selector)];
        return boundaries.length > 0 && boundaries.every(element => element.getAttribute('aria-busy') === 'false');
      }, selector);
      await settled(page);
      for (const artifact of artifacts) {
        const boundaries = page.locator(`[data-sk-boundary=${JSON.stringify(artifact.id)}]`);
        const count = await boundaries.count();
        for (let instance = 0; instance < count; instance++) for (const variant of Object.keys(artifact.variants)) {
          const entry: AuditCase = { id: artifact.id, variant, instance, viewport };
          result.cases.push(entry);
          const prefix = `case-${result.cases.length}`;
          const screenshots = { content: `${prefix}-content.png`, skeleton: `${prefix}-skeleton.png` };
          capture = async phase => {
            const box = await boundaries.nth(instance).boundingBox();
            if (!box || box.width <= 0 || box.height <= 0) throw new Error('Boundary has no screenshot box');
            const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
            await page.screenshot({ path: path.join(output, screenshots[phase]), clip: { ...box, x: box.x + scroll.x, y: box.y + scroll.y }, animations: 'disabled' });
          };
          try {
            entry.report = await page.evaluate(async ({ id, instance, variant, moduleURL, tolerance }) => {
              const { auditBoundaryLayout } = await import(/* @vite-ignore */ moduleURL);
              const element = document.querySelectorAll<HTMLElement>(`[data-sk-boundary=${JSON.stringify(id)}]`)[instance];
              return auditBoundaryLayout(element, { ...tolerance, variant, capture: (phase: 'content' | 'skeleton') => (window as unknown as { __skelcastCapture: (phase: string) => Promise<void> }).__skelcastCapture(phase) });
            }, { id: artifact.id, instance, variant, moduleURL: `/@fs${fileURLToPath(new URL('./browser.js', import.meta.url))}`, tolerance: { tolerancePx: options.tolerancePx, toleranceRatio: options.toleranceRatio, overflowTolerancePx: options.overflowTolerancePx } });
            entry.screenshots = screenshots;
          } catch (error) { entry.error = error instanceof Error ? error.message : String(error); }
          finally { capture = undefined; }
        }
      }
    }
    if (!result.cases.length) throw new Error('No mounted skeleton boundaries found at this URL');
    result.needsReview = result.cases.some(entry => entry.error || entry.report?.needsReview);
    await writeFile(path.join(output, 'report.json'), JSON.stringify(result, null, 2) + '\n');
    await writeFile(path.join(output, 'index.html'), renderAuditReport(result));
    return result;
  } finally { await browser.close(); }
}

export function renderAuditReport(result: AuditReport): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SkelCast layout audit</title>
<style>body{font:16px system-ui;margin:24px;color:#172334;background:#f7f9fc}section{background:white;padding:20px;margin:20px 0;border:1px solid #ccd4df;border-radius:8px}.scroll{overflow:auto}.overlay{position:relative;background:#eee}.overlay img{position:absolute;inset:0;max-width:none}.skeleton{opacity:.5}label{display:block;margin:12px 0}input{width:240px}li{margin:6px 0}a{color:#145cc5}</style>
<h1>SkelCast layout audit · ${result.needsReview ? 'Needs review' : 'Within tolerance'}</h1><p>${escape(result.url)}</p><p>${result.cases.length} measurements. Slide to compare real content and skeleton. Geometry checks include marked anchors; screenshots require visual review.</p>
${result.cases.map(entry => `<section><h2>${escape(entry.id)} · ${escape(entry.variant)} · instance ${entry.instance + 1} · ${entry.viewport.width} × ${entry.viewport.height}</h2>${entry.error ? `<p>${escape(entry.error)}</p>` : `<p>Anchors compared: ${entry.report!.anchors.compared} · mismatches: ${entry.report!.anchors.mismatched} · missing: ${entry.report!.anchors.missing}</p><ul>${entry.report!.issues.map(issue => `<li>${escape(issue.code)}: ${escape(issue.message)}</li>`).join('')}</ul>`}${entry.screenshots && entry.report ? `<label>Skeleton opacity <input type="range" min="0" max="1" step="0.01" value="0.5"></label><p><a href="${escape(entry.screenshots.content)}">Real content</a> · <a href="${escape(entry.screenshots.skeleton)}">Skeleton</a></p><div class="scroll"><div class="overlay" style="width:${Math.ceil(Math.max(entry.report.content.box.width, entry.report.skeleton.box.width))}px;height:${Math.ceil(Math.max(entry.report.content.box.height, entry.report.skeleton.box.height))}px"><img alt="Real content" src="${escape(entry.screenshots.content)}"><img class="skeleton" alt="Skeleton" src="${escape(entry.screenshots.skeleton)}"></div></div>` : ''}</section>`).join('\n')}
<script>document.querySelectorAll('input').forEach(input=>input.addEventListener('input',()=>{input.closest('section').querySelector('.skeleton').style.opacity=input.value}))</script></html>`;
}
