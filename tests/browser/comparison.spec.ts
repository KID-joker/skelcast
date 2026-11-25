import { test, expect } from '@playwright/test';

for (const [framework, port] of [['React', 5173], ['Vue', 5174]] as const) {
  test(`${framework}: comparison modes preserve content, geometry, variants and loading state`, async ({ page }) => {
    const errors: string[] = [];
    let requests = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/products') requests++; });
    await page.goto(`http://127.0.0.1:${port}/?q=keep`);
    await page.getByRole('button', { name: 'Enter demo workspace' }).click();
    const boundary = page.locator('[data-sk-boundary="products.list"]');
    await expect(boundary).toHaveAttribute('aria-busy', 'false');
    const toolbar = page.locator('#skelcast-devtools');
    await toolbar.getByRole('combobox', { name: 'Loading region' }).selectOption('products.list');
    await expect(toolbar.getByRole('combobox', { name: 'Comparison mode' })).toHaveCount(0);
    await toolbar.getByRole('button', { name: 'Compare', exact: true }).click();
    await expect(boundary).toHaveAttribute('data-sk-comparison', 'overlay');
    const comparison = toolbar.getByRole('combobox', { name: 'Comparison mode' });
    const content = boundary.locator(':scope > [data-sk-content]');
    const skeleton = boundary.locator(':scope > div').first();
    const card = await content.getByRole('heading', { name: 'Workspace design system' }).elementHandle();
    const search = page.getByRole('textbox', { name: 'Search assets' });
    await search.fill('Keep my draft');
    const originalWidth = (await boundary.boundingBox())!.width;

    await comparison.selectOption('side-by-side');
    await expect(content).toBeVisible();
    await expect(skeleton).toBeVisible();
    await expect(content).not.toHaveAttribute('inert');
    const left = (await content.boundingBox())!, right = (await skeleton.boundingBox())!;
    expect(left.x).toBeLessThan(right.x);
    expect(left.y).toBeCloseTo(right.y, 1);
    expect(left.width).toBeCloseTo(right.width, 1);
    expect(left.width + right.width + 16).toBeCloseTo(originalWidth, 1);
    await expect(toolbar.getByText('Real content (left) · Skeleton (right)')).toBeVisible();
    await page.screenshot({ path: `test-results/${framework.toLowerCase()}-comparison-side-by-side.png`, fullPage: true });
    const originalSkeleton = await boundary.locator('[data-sk-artifact]').elementHandle();

    await comparison.selectOption('overlay');
    await expect(skeleton).toHaveCSS('opacity', '0.5');
    await expect(skeleton).toHaveCSS('pointer-events', 'none');
    const under = (await content.boundingBox())!, over = (await skeleton.boundingBox())!;
    expect(over.x).toBeCloseTo(under.x, 1);
    expect(over.y).toBeCloseTo(under.y, 1);
    expect(over.width).toBeCloseTo(originalWidth, 1);
    await toolbar.getByRole('slider', { name: 'Opacity' }).fill('75');
    await expect(skeleton).toHaveCSS('opacity', '0.75');
    await expect(page).toHaveURL(/__sk_opacity=0.75/);
    await page.screenshot({ path: `test-results/${framework.toLowerCase()}-comparison-overlay.png`, fullPage: true });
    expect(await originalSkeleton!.evaluate(element => element.isConnected)).toBe(true);
    await toolbar.getByRole('combobox', { name: 'Layout variant' }).selectOption('list');
    expect(await boundary.locator('[data-sk-artifact] > div').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1);

    // Coding agents use the browser API; it restores the developer's comparison.
    const report = await page.evaluate(async moduleURL => {
      const { auditBoundaryLayout } = await import(moduleURL);
      return auditBoundaryLayout(document.querySelector('[data-sk-boundary="products.list"]'));
    }, `/@fs/${process.cwd()}/dist/browser.js`);
    expect(report.variant).toBe('list');
    await expect(boundary).toHaveAttribute('data-sk-comparison', 'overlay');
    await expect(skeleton).toHaveCSS('opacity', '0.75');

    await comparison.selectOption('switch');
    await expect(content).toBeVisible();
    await expect(skeleton).toBeHidden();
    await toolbar.getByRole('button', { name: 'Show skeleton', exact: true }).click();
    await expect(content).toBeHidden();
    await expect(content).toHaveAttribute('inert');
    await expect(skeleton).toBeVisible();
    expect((await skeleton.boundingBox())!.width).toBeCloseTo(originalWidth, 1);
    await toolbar.getByRole('button', { name: 'Show real content', exact: true }).click();
    await expect(content).toBeVisible();
    expect(await card!.evaluate(element => element.isConnected)).toBe(true);
    await expect(search).toHaveValue('Keep my draft');
    expect(requests).toBe(1);

    await comparison.selectOption('side-by-side');
    await page.getByRole('button', { name: 'Refresh assets' }).click();
    await expect(boundary).toHaveAttribute('aria-busy', 'true');
    await expect(content).toBeHidden();
    await expect(toolbar.getByText('Waiting for real content…')).toBeVisible();
    await expect(boundary).toHaveAttribute('aria-busy', 'false');
    await expect(content).toBeVisible();
    await expect(boundary).toHaveAttribute('data-sk-comparison', 'side-by-side');

    // Page comparison also works for the light-DOM artifact and nested boundaries.
    await toolbar.getByRole('combobox', { name: 'Loading region' }).selectOption('products.page');
    const pageBoundary = page.locator('[data-sk-boundary="products.page"]');
    await expect(pageBoundary).toHaveAttribute('data-sk-comparison', 'side-by-side');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect((await toolbar.boundingBox())!.x).toBeGreaterThanOrEqual(0);
    await expect(comparison).toBeVisible();
    await page.screenshot({ path: `test-results/${framework.toLowerCase()}-comparison-mobile.png`, fullPage: true });
    await comparison.selectOption('overlay');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await toolbar.getByRole('switch', { name: 'Show skeleton' }).uncheck();
    await expect(pageBoundary).toHaveAttribute('data-sk-comparison', 'off');
    await expect(pageBoundary).toHaveAttribute('data-sk-visible', 'false');
    await page.setViewportSize({ width: 1440, height: 1050 });
    await expect(search).toHaveValue('Keep my draft');
    await expect(page).toHaveURL(/\?q=keep$/);
    expect(errors).toEqual([]);
    expect(requests).toBe(2);
  });

  test(`${framework}: comparison links reload and history changes restore normal preview`, async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}/?q=keep&__sk=products.list&__sk_compare=overlay&__sk_opacity=0.25&__sk_variant=list`);
    await page.getByRole('button', { name: 'Enter demo workspace' }).click();
    const boundary = page.locator('[data-sk-boundary="products.list"]');
    const toolbar = page.locator('#skelcast-devtools');
    await expect(boundary).toHaveAttribute('aria-busy', 'false');
    await expect(boundary).toHaveAttribute('data-sk-comparison', 'overlay');
    await expect(boundary.locator(':scope > div').first()).toHaveCSS('opacity', '0.25');
    await page.reload();
    await expect(boundary).toHaveAttribute('data-sk-comparison', 'overlay');
    await expect(toolbar.getByRole('slider', { name: 'Opacity' })).toHaveValue('25');
    await toolbar.getByRole('combobox', { name: 'Comparison mode' }).selectOption('switch');
    await toolbar.getByRole('button', { name: 'Show skeleton', exact: true }).click();
    await page.reload();
    await expect(toolbar.getByRole('button', { name: 'Show real content', exact: true })).toBeVisible();
    await expect(boundary.locator(':scope > [data-sk-content]')).toBeHidden();
    await page.evaluate(() => {
      history.pushState({}, '', '?q=keep');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(toolbar.getByRole('combobox', { name: 'Comparison mode' })).toHaveCount(0);
    await expect(toolbar.getByRole('button', { name: 'Compare', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(toolbar.getByRole('switch', { name: 'Show skeleton' })).not.toBeChecked();
    await expect(boundary).toHaveAttribute('data-sk-comparison', 'off');
    await expect(boundary).toHaveAttribute('data-sk-visible', 'false');
  });
}
