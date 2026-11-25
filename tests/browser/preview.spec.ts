import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

for (const [framework, port] of [['React', 5173], ['Vue', 5174]] as const) {
  test(`${framework}: real loading, preview controls, variants, preserved state and responsiveness`, async ({ page }) => {
    const errors: string[] = [];
    let requests = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', req => { if (new URL(req.url()).pathname === '/api/products') requests++; });
    await page.goto(`http://127.0.0.1:${port}/?__sk=products.list`);
    await page.getByRole('button', { name: 'Enter demo workspace' }).click();
    const pageBoundary = page.locator('[data-sk-boundary="products.page"]');
    const listBoundary = page.locator('[data-sk-boundary="products.list"]');
    await expect(pageBoundary).toHaveAttribute('aria-busy', 'true');
    await expect(pageBoundary).toHaveAttribute('aria-busy', 'false');
    await expect(listBoundary).toHaveAttribute('data-sk-visible', 'true');
    const toolbar = page.locator('#skelcast-devtools');
    await expect(toolbar.getByRole('combobox', { name: 'Loading region' })).toHaveValue('products.list');
    const skeletonGrid = listBoundary.locator('[data-sk-artifact="products.list"] > div');
    await expect(skeletonGrid.locator('article')).toHaveCount(6);
    expect(await skeletonGrid.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(3);
    await toolbar.getByRole('combobox', { name: 'Layout variant' }).selectOption('list');
    expect(await skeletonGrid.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(1);
    await toolbar.getByRole('button', { name: 'Exit', exact: true }).click();
    await expect(listBoundary).toHaveAttribute('data-sk-visible', 'false');
    await expect(page.getByRole('heading', { name: 'Workspace design system' })).toBeVisible();
    const originalCard = await page.getByRole('heading', { name: 'Workspace design system' }).elementHandle();
    const search = page.getByRole('textbox', { name: 'Search assets' });
    await search.fill('Keep my input');
    await toolbar.getByRole('combobox', { name: 'Preview mode' }).selectOption('selected');
    await expect(listBoundary).toHaveAttribute('data-sk-visible', 'true');
    await toolbar.getByRole('combobox', { name: 'Preview mode' }).selectOption('auto');
    await expect(search).toHaveValue('Keep my input');
    expect(await originalCard!.evaluate(el => el.isConnected)).toBe(true);
    expect(requests).toBe(1);
    await page.getByRole('button', { name: 'Refresh assets' }).click();
    await expect(listBoundary).toHaveAttribute('aria-busy', 'true');
    await expect(listBoundary).toHaveAttribute('data-sk-visible', 'true');
    await toolbar.getByRole('combobox', { name: 'Preview mode' }).selectOption('selected');
    await toolbar.getByRole('button', { name: 'Exit', exact: true }).click();
    await expect(search).toHaveValue('Keep my input');
    await expect(listBoundary).toHaveAttribute('data-sk-visible', 'true');
    await expect(listBoundary).toHaveAttribute('aria-busy', 'false');
    await expect(listBoundary).toHaveAttribute('data-sk-visible', 'false');
    await toolbar.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(listBoundary).toHaveAttribute('data-sk-visible', 'true');
    await expect(listBoundary).toHaveAttribute('data-sk-visible', 'false');
    await toolbar.getByRole('combobox', { name: 'Preview mode' }).selectOption('page');
    await expect(pageBoundary).toHaveAttribute('data-sk-visible', 'true');
    await toolbar.getByRole('button', { name: 'Exit', exact: true }).click();
    await toolbar.getByRole('combobox', { name: 'Preview mode' }).selectOption('selected');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await skeletonGrid.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect((await toolbar.boundingBox())!.x).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: `test-results/${framework.toLowerCase()}-mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1050 });
    await toolbar.getByRole('button', { name: 'More' }).click();
    await expect(toolbar.getByText('Forced preview', { exact: true })).toBeVisible();
    await expect(toolbar.getByText('Artifact: Up to date')).toBeVisible();
    await page.screenshot({ path: `test-results/${framework.toLowerCase()}-preview.png`, fullPage: true });
    expect(errors).toEqual([]);
    expect(requests).toBe(2);
  });
  test(`${framework}: URL preview survives login and reload, history restores automatic mode`, async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}/?q=keep&__sk=products.list&__sk_variant=list`);
    await page.getByRole('button', { name: 'Enter demo workspace' }).click();
    const list = page.locator('[data-sk-boundary="products.list"]');
    await expect(list).toHaveAttribute('data-sk-visible', 'true');
    await page.reload();
    await expect(list).toHaveAttribute('data-sk-visible', 'true');
    await page.locator('#skelcast-devtools').getByRole('button', { name: 'Exit', exact: true }).click();
    await expect(page).toHaveURL(/\?q=keep$/);
    await expect(list).toHaveAttribute('data-sk-visible', 'false');
  });
  test(`${framework}: page preview does not cover the login gate`, async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}/?__sk=page`);
    await expect(page.getByRole('button', { name: 'Enter demo workspace' })).toBeVisible();
    await page.getByRole('button', { name: 'Enter demo workspace' }).click();
    const pageBoundary = page.locator('[data-sk-boundary="products.page"]');
    await expect(pageBoundary).toHaveAttribute('aria-busy', 'false');
    await expect(pageBoundary).toHaveAttribute('data-sk-visible', 'true');
    await page.locator('#skelcast-devtools').getByRole('button', { name: 'Exit', exact: true }).click();
    await expect(pageBoundary).toHaveAttribute('data-sk-visible', 'false');
  });
}

test('toolbar saves small hints, refreshes artifacts, marks stale dependencies and resolves source locations', async ({ page }) => {
  const { readFile, writeFile, unlink } = await import('node:fs/promises');
  const hintsFile = 'examples/react/skelcast.hints.json';
  const cssFile = 'examples/react/src/catalog.module.css';
  let previousHints: string | undefined;
  try { previousHints = await readFile(hintsFile, 'utf8'); } catch { /* no saved hints */ }
  const previousCSS = await readFile(cssFile, 'utf8');
  try {
    await page.goto('http://127.0.0.1:5173/?__sk=products.list');
    await page.getByRole('button', { name: 'Enter demo workspace' }).click();
    await expect(page.locator('[data-sk-boundary="products.page"]')).toHaveAttribute('aria-busy', 'false');
    const toolbar = page.locator('#skelcast-devtools');
    await toolbar.getByRole('button', { name: 'More' }).click();
    await toolbar.locator('summary').filter({ hasText: 'Generation hints' }).click();
    await toolbar.getByLabel('Repeat count').fill('3');
    await toolbar.getByRole('button', { name: 'Save and generate' }).click();
    await expect(page.locator('[data-sk-boundary="products.list"] article[data-sk-node]')).toHaveCount(3);
    const saved = JSON.parse(await readFile(hintsFile, 'utf8'));
    expect(saved['products.list'].repeat).toBe(3);
    expect(Object.keys(saved['products.list']).sort()).toEqual(['bindings', 'lines', 'minHeight', 'repeat']);
    await writeFile(cssFile, previousCSS + '\n/* dependency changed */\n');
    await expect(toolbar.getByText(/Artifact: Out of date/)).toBeVisible();
    await toolbar.getByRole('button', { name: 'Sync artifacts', exact: true }).click();
    await expect(toolbar.getByText('Artifact: Up to date')).toBeVisible();
    const response = await page.request.post('http://127.0.0.1:5173/__skelcast/open', { headers: { 'X-SkelCast-Dev': '1' }, data: { id: 'products.list' } });
    expect(response.ok()).toBe(true);
    expect((await response.json()).url).toContain('ProductGrid.tsx');
    const blocked = await page.request.post('http://127.0.0.1:5173/__skelcast/hints', { data: { id: 'products.list', hints: { repeat: 9 } } });
    expect(blocked.status()).toBe(403);
  } finally {
    await writeFile(cssFile, previousCSS);
    if (previousHints != null) await writeFile(hintsFile, previousHints); else await unlink(hintsFile).catch(() => {});
    // Use the built generator so restored output keeps the production compiler fingerprint.
    const built = await import('../../dist/index.js');
    await built.syncProject(await built.loadProject('examples/react'));
  }
});

test('production HTML has pre-JS skeleton and no dev tooling', async () => {
  for (const framework of ['react', 'vue']) {
    const html = await readFile(`examples/${framework}/dist/index.html`, 'utf8');
    expect(html).toContain('data-sk-initial="products.page"');
    expect(html).toContain('data-sk-artifact="products.page"');
    expect(html).not.toContain('client.js');
    expect(html).not.toContain('skelcast-devtools');
  }
});
test('initial skeleton is visible before JavaScript runs', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:5173/');
    const initial = page.locator('[data-sk-initial="products.page"]');
    await expect(initial).toBeVisible();
    await expect(initial.locator('article')).toHaveCount(6);
    expect(await initial.locator('article').first().evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThan(100);
    await expect(page.locator('#skelcast-devtools')).toHaveCount(0);
  } finally { await context.close(); }
});

for (const [framework, port] of [['react', 5173], ['vue', 5174]] as const) test(`${framework}: initial shell matches page boundary and source width without added padding`, async ({ browser, page }) => {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: 1050 } });
    try {
      const initialPage = await context.newPage();
      await initialPage.goto(`http://127.0.0.1:${port}/`);
      await expect(initialPage.locator('[data-sk-initial]')).toHaveCSS('padding', '0px');
      const initial = await initialPage.locator('[data-sk-artifact="products.page"] > div').boundingBox();
      await page.setViewportSize({ width, height: 1050 });
      await page.goto(`http://127.0.0.1:${port}/?__sk=page`);
      const login = page.getByRole('button', { name: 'Enter demo workspace' });
      if (await login.count()) await login.click();
      const boundary = page.locator('[data-sk-boundary="products.page"]');
      await expect(boundary).toHaveAttribute('aria-busy', 'false');
      const skeleton = await boundary.locator('[data-sk-artifact="products.page"] > div').boundingBox();
      await page.locator('#skelcast-devtools').getByRole('button', { name: 'Exit', exact: true }).click();
      await expect(boundary).toHaveAttribute('data-sk-visible', 'false');
      const realContent = boundary.locator(':scope > [data-sk-content] > div');
      await expect(realContent).toBeVisible();
      const content = await realContent.boundingBox();
      for (const box of [initial, skeleton]) {
        expect(box!.x).toBeCloseTo(content!.x, 1);
        expect(box!.y).toBeCloseTo(content!.y, 1);
        expect(box!.width).toBeCloseTo(content!.width, 1);
      }
    } finally { await context.close(); }
  }
});
