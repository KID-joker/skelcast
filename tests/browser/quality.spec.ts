import { test, expect } from '@playwright/test';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { BoundaryLayoutReport } from '../../src/browser.js';

const browserModule = `/@fs/${path.join(process.cwd(), 'dist/browser.js')}`;
test('layout audit tolerates metadata-only artifact refresh while rejecting changed layout', async ({ page }) => {
  const entry = path.join(process.cwd(), 'dist/runtime/index.js');
  const core = (await readFile(entry, 'utf8')).match(/from "([^"]+)"/)![1];
  const coreModule = `/@fs${path.resolve(path.dirname(entry), core)}`;
  await page.goto('http://127.0.0.1:5173/');
  await page.getByRole('button', { name: 'Enter demo workspace' }).click();
  await expect(page.locator('[data-sk-boundary="products.page"]')).toHaveAttribute('aria-busy', 'false');
  // The first render precedes the request effect and can report idle with no
  // items. Audit only after actual data-backed content has a visible box.
  await expect(page.locator('[data-sk-boundary="products.list"] [data-sk-content] article').first()).toBeVisible();
  await page.waitForFunction(async moduleURL => (await import(moduleURL)).listBoundaries().some((item: { id: string }) => item.id === 'products.list'), coreModule);
  const results = await page.evaluate(async ({ browserModule, coreModule }) => {
    const { auditBoundaryLayout } = await import(browserModule);
    const { listBoundaries, currentArtifact, replaceArtifacts } = await import(coreModule);
    const boundary = listBoundaries().find((item: { id: string }) => item.id === 'products.list');
    const artifact = currentArtifact(boundary.artifact);
    const running = auditBoundaryLayout(boundary.element);
    replaceArtifacts([{ ...artifact, diagnostics: [{ code: 'METADATA_ONLY', message: 'Metadata refreshed', file: artifact.source, line: 1 }] }]);
    let same = '';
    try { await running; same = 'completed'; } catch (error) { same = String(error); }
    const changed = auditBoundaryLayout(boundary.element);
    const next = structuredClone(artifact);
    next.variants[next.defaultVariant].css += '\n[data-sk-artifact]{height:999px}';
    replaceArtifacts([next]);
    let different = '';
    try { await changed; } catch (error) { different = String(error); }
    return { same, different };
  }, { browserModule, coreModule });
  expect(results.same).toBe('completed');
  expect(results.different).toContain('Loading region changed');
});
test('browser layout check catches bad geometry and hidden placeholders and restores real/forced state', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173/?__sk=products.list&__sk_variant=list');
  await page.getByRole('button', { name: 'Enter demo workspace' }).click();
  const boundary = page.locator('[data-sk-boundary="products.list"]');
  await expect(page.locator('[data-sk-boundary="products.page"]')).toHaveAttribute('aria-busy', 'false');
  await expect(boundary.locator('[data-sk-content] article').first()).toBeAttached();
  await expect(boundary).toHaveAttribute('aria-busy', 'false');
  const originalURL = page.url();
  const audit = () => page.evaluate(async url => {
    const { auditBoundaryLayout } = await import(url);
    return auditBoundaryLayout(document.querySelector('[data-sk-boundary="products.list"]'));
  }, browserModule) as Promise<BoundaryLayoutReport>;
  await boundary.evaluate(element => {
    const root = element.firstElementChild!.firstElementChild!.shadowRoot!;
    const style = document.createElement('style');
    style.textContent = '[data-sk-artifact]{height:1000px!important;min-width:1800px!important}[data-sk-artifact][data-sk-artifact] [data-sk-leaf]{background:transparent!important}';
    root.append(style);
  });
  const result = await audit();
  expect(result.variant).toBe('list');
  expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['HEIGHT_MISMATCH', 'HORIZONTAL_OVERFLOW', 'PLACEHOLDERS_INVISIBLE']));
  expect(result.delta.followingContentShift).not.toBe(0);
  await expect(boundary).toHaveAttribute('data-sk-visible', 'true');
  expect(page.url()).toBe(originalURL);
  await page.locator('#skelcast-devtools').getByRole('switch', { name: 'Show skeleton' }).uncheck();
  await audit();
  await expect(boundary).toHaveAttribute('data-sk-visible', 'false');
  await page.getByRole('button', { name: 'Refresh assets' }).click();
  await expect(boundary).toHaveAttribute('aria-busy', 'true');
  const error = await page.evaluate(async url => {
    const { auditBoundaryLayout } = await import(url);
    try { await auditBoundaryLayout(document.querySelector('[data-sk-boundary="products.list"]')); }
    catch (error) { return String(error); }
  }, browserModule);
  expect(error).toContain('Wait for real loading');
});

test('layout checks reject concurrent work and preserve a preview selected by the user mid-check', async ({ page }) => {
  await page.goto('http://127.0.0.1:5174/?__sk=products.list');
  await page.getByRole('button', { name: 'Enter demo workspace' }).click();
  await expect(page.locator('[data-sk-boundary="products.page"]')).toHaveAttribute('aria-busy', 'false');
  const boundary = page.locator('[data-sk-boundary="products.list"]');
  await expect(boundary.locator('[data-sk-content] article').first()).toBeAttached();
  await expect(boundary).toHaveAttribute('aria-busy', 'false');
  const concurrent = await page.evaluate(async url => {
    const { auditBoundaryLayout } = await import(url);
    const boundary = document.querySelector('[data-sk-boundary="products.list"]');
    const running = auditBoundaryLayout(boundary);
    let rejected = '';
    try { await auditBoundaryLayout(boundary); } catch (error) { rejected = String(error); }
    await running;
    return rejected;
  }, browserModule);
  expect(concurrent).toContain('already running');
  const interrupted = await page.evaluate(async url => {
    const { auditBoundaryLayout } = await import(url);
    const running = auditBoundaryLayout(document.querySelector('[data-sk-boundary="products.list"]'));
    const selector = document.querySelector('#skelcast-devtools')!.shadowRoot!.querySelector<HTMLSelectElement>('#target')!;
    selector.value = 'products.page';
    selector.dispatchEvent(new Event('change'));
    const toggle = document.querySelector('#skelcast-devtools')!.shadowRoot!.querySelector<HTMLInputElement>('#preview')!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    try { await running; } catch (error) { return String(error); }
  }, browserModule);
  expect(interrupted).toContain('Preview changed');
  await expect(page.locator('[data-sk-boundary="products.page"]')).toHaveAttribute('data-sk-visible', 'true');
  await expect(page).toHaveURL(/__sk=products\.page/);
});
