import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build, createServer } from 'vite';
import type { SkeletonConfig } from '../../src/types.js';

for (const framework of ['react', 'vue'] as const) test(`${framework}: inspect, copy and repair fallbacks through bindings and source adapters`, async ({ page }) => {
  const repo = process.cwd(), root = await mkdtemp(path.join(os.tmpdir(), `skelcast-repair-${framework}-`));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await mkdir(path.join(root, 'node_modules'));
    for (const name of ['react', 'react-dom', 'vue', 'vite', '@vitejs']) await symlink(path.join(repo, 'node_modules', name), path.join(root, 'node_modules', name), 'dir');
    await symlink(repo, path.join(root, 'node_modules/skelcast'), 'dir');
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(root, 'vite.config.mjs'), `import framework from '@vitejs/plugin-${framework}';import {skelcastPlugin} from 'skelcast/vite';export default {plugins:[framework(),skelcastPlugin()]};`);
    const extension = framework === 'react' ? 'tsx' : 'vue';
    const config: SkeletonConfig = { targets: [
      { id: 'repair.layout', source: `src/Layout.${extension}`, render: framework === 'vue' ? 'shadow' : 'light' },
      { id: 'repair.chart', source: `src/Chart.${extension}`, render: framework === 'vue' ? 'shadow' : 'light' },
    ] };
    const layout = framework === 'react'
      ? `const layout=privateLayout();throw new Error('never execute');\nexport default ()=> <section style={{width:layout.width}} title={'<img src=x onerror=alert(1)>'}/>`
      : `<script setup>const layout=privateLayout();throw new Error('never execute')</script>\n<template><section :style="{width:layout.width}" title="&lt;img src=x onerror=alert(1)&gt;"/></template>`;
    await writeFile(path.join(root, `src/Layout.${extension}`), layout);
    await writeFile(path.join(root, `src/Chart.${extension}`), framework === 'react'
      ? `import VendorChart from 'private-vendor'; export default ()=> <VendorChart/>`
      : `<script setup>import VendorChart from 'private-vendor'</script><template><VendorChart/></template>`);
    await writeFile(path.join(root, 'skelcast.config.mjs'), `export default ${JSON.stringify(config)};`);
    const main = framework === 'react'
      ? `import React from 'react';import {createRoot} from 'react-dom/client';import {LoadingBoundary} from 'skelcast/react';import layout from 'virtual:skelcast/repair.layout';import chart from 'virtual:skelcast/repair.chart';createRoot(document.getElementById('root')).render(<main><LoadingBoundary artifact={layout} pending={true}/><LoadingBoundary artifact={chart} pending={true}/></main>);`
      : `import {createApp,h} from 'vue';import {LoadingBoundary} from 'skelcast/vue';import layout from 'virtual:skelcast/repair.layout';import chart from 'virtual:skelcast/repair.chart';createApp({render:()=>h('main',[h(LoadingBoundary,{artifact:layout,pending:true}),h(LoadingBoundary,{artifact:chart,pending:true})])}).mount('#root');`;
    await writeFile(path.join(root, 'src/main.jsx'), main);
    await writeFile(path.join(root, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>');
    const { loadProject, syncProject } = await import('../../dist/index.js');
    await syncProject(await loadProject(root));
    server = await createServer({ root, logLevel: 'silent', optimizeDeps: { exclude: ['skelcast'] }, server: { host: '127.0.0.1', port: 0, fs: { allow: [repo, root] } } });
    await server.listen();
    const address = server.httpServer!.address() as { port: number };
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { (window as Window & { copiedRepair?: string }).copiedRepair = text; } } });
    });
    await page.route('**/__open-in-editor?*', route => route.fulfill({ status: 200, body: 'ok' }));
    await page.goto(`http://127.0.0.1:${address.port}/?__sk=repair.layout`);
    const toolbar = page.locator('#skelcast-devtools');
    await toolbar.getByRole('button', { name: 'More', exact: true }).click();
    await toolbar.getByLabel('Highlight fallbacks').check();
    const layoutBoundary = page.locator('[data-sk-boundary="repair.layout"]');
    const fallback = layoutBoundary.locator('[data-sk-fallback]');
    const node = await fallback.getAttribute('data-sk-node');
    await fallback.click(); // Real hit testing, including through the Vue shadow root.
    const details = toolbar.getByRole('region', { name: 'Fallback details' });
    await expect(details).toContainText('layout.width');
    await expect(details).toContainText(`src/Layout.${extension}:2`);
    await expect(details.locator('img')).toHaveCount(0);
    await toolbar.screenshot({ path: `test-results/${framework}-fallback-repair.png` });
    await details.getByRole('button', { name: 'Copy binding example' }).click();
    expect(await page.evaluate(() => (window as Window & { copiedRepair?: string }).copiedRepair)).toContain(`src/Layout.${extension}::layout.width`);
    const sourceRequest = page.waitForRequest(request => request.url().endsWith('/__skelcast/open'));
    await details.getByRole('button', { name: 'Open source', exact: true }).click();
    expect((await sourceRequest).postDataJSON()).toEqual({ id: 'repair.layout', node });
    await expect(toolbar.getByRole('status')).toContainText('Requested source file');
    await toolbar.locator('[data-ui-key="hints"] summary').click();
    const bindings = toolbar.locator('#bindings');
    await bindings.fill('{unfinished');
    await details.getByRole('button', { name: 'Add to hint draft' }).click();
    await expect(bindings).toHaveValue('{unfinished');
    await expect(toolbar.getByRole('status')).toContainText('Unable to add example');
    await bindings.fill('{"keep":"my draft"}');
    await details.getByRole('button', { name: 'Add to hint draft' }).click();
    const draft = JSON.parse(await bindings.inputValue());
    expect(draft.keep).toBe('my draft');
    expect(draft[`src/Layout.${extension}::layout.width`]).toBe(320);
    await expect(readFile(path.join(root, 'skelcast.hints.json'))).rejects.toThrow();
    draft[`src/Layout.${extension}::layout.width`] = 456;
    await bindings.fill(JSON.stringify(draft));
    await toolbar.getByRole('button', { name: 'Save and generate' }).click();
    await expect(layoutBoundary.locator('[data-sk-fallback]')).toHaveCount(0);
    await expect(layoutBoundary.locator('section[data-sk-node]')).toHaveCSS('width', '456px');
    await expect(details).toContainText('No fallback remains');
    expect(JSON.parse(await readFile(path.join(root, 'skelcast.hints.json'), 'utf8'))['repair.layout'].bindings).toEqual(draft);
    await page.setViewportSize({ width: 390, height: 844 });
    // The page can overflow due to the explicit 456px example; the inspector stays bounded.
    const panel = await toolbar.locator('.panel').boundingBox();
    expect(panel!.x).toBeGreaterThanOrEqual(0);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(390);
    await page.setViewportSize({ width: 1440, height: 1050 });
    await toolbar.getByRole('combobox', { name: 'Loading region' }).selectOption('repair.chart');
    await expect(details).toHaveCount(0);
    await page.locator('[data-sk-boundary="repair.chart"] [data-sk-fallback]').click();
    await expect(details).toContainText('Add a source adapter for VendorChart');
    await expect(details).toContainText('Related evidence');
    await details.getByRole('button', { name: 'Close details' }).click();
    await toolbar.locator('[data-ui-key="diagnostics"] summary').click();
    const inspect = toolbar.getByRole('button', { name: 'Inspect fallback', exact: true });
    await inspect.focus();
    await inspect.press('Enter');
    await expect(details).toContainText('Add a source adapter for VendorChart');
    await details.getByRole('button', { name: 'Copy adapter example' }).click();
    expect(await page.evaluate(() => (window as Window & { copiedRepair?: string }).copiedRepair)).toContain('VendorChartSkeleton');
    const adapter = `src/skeletons/VendorChartSkeleton.${extension}`;
    await mkdir(path.join(root, 'src/skeletons'));
    await writeFile(path.join(root, adapter), await details.locator('.repair-example pre code').first().innerText());
    config.targets[1].adapters = { VendorChart: adapter };
    await writeFile(path.join(root, 'skelcast.config.mjs'), `export default ${JSON.stringify(config)};`);
    await toolbar.getByRole('button', { name: 'Sync artifacts', exact: true }).click();
    await expect(page.locator('[data-sk-boundary="repair.chart"] [data-sk-fallback]')).toHaveCount(0);
    await expect(details).toContainText('No fallback remains');
    expect(errors).toEqual([]);
    await build({ root, logLevel: 'silent' });
    expect(await readFile(path.join(root, 'dist/index.html'), 'utf8')).not.toContain('skelcast-devtools');
  } finally { await server?.close(); await rm(root, { recursive: true, force: true }); }
});
