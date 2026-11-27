import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';

for (const [framework, port] of [['React', 5173], ['Vue', 5174]] as const) {
  test(`${framework}: compact toolbar picks regions and keeps inspection tools out of the preview flow`, async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}/?q=keep`);
    await page.getByRole('button', { name: 'Enter demo workspace' }).click();
    const boundary = page.locator('[data-sk-boundary="products.list"]');
    await expect(boundary).toHaveAttribute('aria-busy', 'false');
    const toolbar = page.locator('#skelcast-devtools');
    const region = toolbar.getByRole('combobox', { name: 'Loading region' });
    const preview = toolbar.getByRole('switch', { name: 'Show skeleton' });
    const compare = toolbar.getByRole('button', { name: 'Compare', exact: true });
    await expect(preview).not.toBeChecked();
    await expect(toolbar.getByRole('button', { name: 'Update skeletons' })).toHaveCount(0);
    await expect(toolbar.getByRole('button', { name: 'Play', exact: true })).toHaveCount(0);
    await expect(toolbar.getByRole('combobox', { name: 'Preview mode' })).toHaveCount(0);
    await region.selectOption({ label: 'Pick region…' });
    await expect(region).toHaveValue('');
    await region.selectOption({ label: 'Cancel picking' });
    await expect(region).toHaveValue('products.page');
    await region.selectOption({ label: 'Pick region…' });
    await page.getByRole('heading', { name: 'Workspace design system' }).click();
    await expect(region).toHaveValue('products.list');
    await expect(preview).toBeChecked();
    await expect(boundary).toHaveAttribute('data-sk-visible', 'true');
    await preview.uncheck();
    await expect(boundary).toHaveAttribute('data-sk-visible', 'false');
    await compare.click();
    await expect(boundary).toHaveAttribute('data-sk-comparison', 'overlay');
    await compare.click();
    await expect(boundary).toHaveAttribute('data-sk-visible', 'false');
    await expect(page).toHaveURL(/\?q=keep$/);
    await expect(toolbar.getByRole('status', { name: 'Skeleton status' })).toHaveText('Up to date');
    await expect(toolbar.getByRole('button', { name: 'More', exact: true })).toHaveCount(0);
    await expect(toolbar.getByRole('button', { name: 'Copy link', exact: true })).toHaveCount(0);
    await expect(toolbar.getByRole('button', { name: 'Open source', exact: true })).toHaveCount(0);
    await expect(toolbar.getByRole('button', { name: 'Check layout', exact: true })).toHaveCount(0);
    await expect(toolbar.getByLabel('Repeat count')).toHaveCount(0);
    await expect(toolbar.locator('details, textarea, .diagnostic, .repair')).toHaveCount(0);
    const state = await (await page.request.get(`http://127.0.0.1:${port}/__skelcast/state`)).json();
    expect(state.targets).toBeUndefined();
    for (const artifact of state.artifacts) {
      expect(artifact.diagnostics).toEqual([]);
      expect(artifact.evidence).toEqual([]);
      expect(artifact.sources).toEqual({});
      expect(state.versions[artifact.id]).toBe(createHash('sha256').update(JSON.stringify(artifact)).digest('hex'));
    }
    const refreshed = await (await page.request.get(`http://127.0.0.1:${port}/__skelcast/state`)).json();
    expect(refreshed.versions).toEqual(state.versions);
    for (const endpoint of ['hints', 'open']) {
      const response = await page.request.post(`http://127.0.0.1:${port}/__skelcast/${endpoint}`, { headers: { 'X-SkelCast-Dev': '1' }, data: { id: 'products.list' } });
      expect(response.status()).toBe(404);
    }
    const blocked = await page.request.post(`http://127.0.0.1:${port}/__skelcast/sync`, { data: {} });
    expect(blocked.status()).toBe(403);
  });
}
