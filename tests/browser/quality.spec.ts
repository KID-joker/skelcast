import { test, expect } from '@playwright/test';
import path from 'node:path';
import type { BoundaryLayoutReport } from '../../src/browser.js';

const browserModule = `/@fs/${path.join(process.cwd(), 'dist/browser.js')}`;
test('browser layout check catches bad geometry and hidden placeholders and restores real/forced state', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173/?__sk=products.list&__sk_variant=list');
  await page.getByRole('button', { name: 'Enter demo workspace' }).click();
  const boundary = page.locator('[data-sk-boundary="products.list"]');
  await expect(page.locator('[data-sk-boundary="products.page"]')).toHaveAttribute('aria-busy', 'false');
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
  await page.locator('#skelcast-devtools').getByRole('button', { name: 'Exit', exact: true }).click();
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
    const selector = document.querySelector('#skelcast-devtools')!.shadowRoot!.querySelector<HTMLSelectElement>('#mode')!;
    selector.value = 'page';
    selector.dispatchEvent(new Event('change'));
    try { await running; } catch (error) { return String(error); }
  }, browserModule);
  expect(interrupted).toContain('Preview changed');
  await expect(page.locator('[data-sk-boundary="products.page"]')).toHaveAttribute('data-sk-visible', 'true');
  await expect(page).toHaveURL(/__sk=page/);
});
