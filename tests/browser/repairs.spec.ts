import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build, createServer } from 'vite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SkeletonConfig } from '../../src/types.js';

for (const framework of ['react', 'vue'] as const) test(`${framework}: coding agent diagnoses and repairs bindings and adapters while the toolbar previews results`, async ({ page }) => {
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
      ? `const layout=privateLayout();throw new Error('never execute');\nexport default ()=> <section style={{width:layout.width}} title={'<img src=x onerror=alert(1)>'}><span>Layout</span></section>`
      : `<script setup>const layout=privateLayout();throw new Error('never execute')</script>\n<template><section :style="{width:layout.width}" title="&lt;img src=x onerror=alert(1)&gt;"><span>Layout</span></section></template>`;
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
    const run = async (...args: string[]) => {
      const { stdout } = await promisify(execFile)(process.execPath, [path.join(repo, 'dist/cli.js'), ...args, '--root', root, '--json']);
      return JSON.parse(stdout);
    };
    await page.goto(`http://127.0.0.1:${address.port}/?__sk=repair.layout`);
    const toolbar = page.locator('#skelcast-devtools');
    const layoutBoundary = page.locator('[data-sk-boundary="repair.layout"]');
    await expect(layoutBoundary.locator('[data-sk-fallback]')).toHaveCount(1);
    await expect(toolbar.locator('.panel, .repair, textarea')).toHaveCount(0);
    const report = await run('diagnose', '--id', 'repair.layout');
    const location = report.variants.default.locations[0];
    expect(location.source).toMatchObject({ file: `src/Layout.${extension}`, line: 2 });
    expect(location.diagnostics[0].expression).toContain('layout.width');
    const example = location.examples.find((example: { kind: string }) => example.kind === 'binding');
    example.bindings[`src/Layout.${extension}::layout.width`] = 456;
    await writeFile(path.join(root, 'hint-patch.json'), JSON.stringify({ bindings: { keep: 'existing value', ...example.bindings } }));
    await run('hints', '--id', 'repair.layout', '--file', 'hint-patch.json');
    await run('sync');
    await expect(layoutBoundary.locator('[data-sk-fallback]')).toHaveCount(0);
    await expect(layoutBoundary.locator('section[data-sk-node]')).toHaveCSS('width', '456px');
    expect((await run('diagnose', '--id', 'repair.layout')).needsReview).toBe(false);
    expect(JSON.parse(await readFile(path.join(root, 'skelcast.hints.json'), 'utf8'))['repair.layout'].bindings.keep).toBe('existing value');
    await page.setViewportSize({ width: 390, height: 844 });
    const bar = await toolbar.boundingBox();
    expect(bar!.x).toBeGreaterThanOrEqual(0);
    expect(bar!.x + bar!.width).toBeLessThanOrEqual(390);
    await page.setViewportSize({ width: 1440, height: 1050 });
    const chart = await run('diagnose', '--id', 'repair.chart');
    const adapter = chart.variants.default.locations.flatMap((location: { examples: { kind: string; files: { name: string; code: string }[] }[] }) => location.examples).find((example: { kind: string }) => example.kind === 'adapter');
    expect(adapter.files[0].name).toBe(`src/skeletons/VendorChartSkeleton.${extension}`);
    await mkdir(path.join(root, 'src/skeletons'));
    await writeFile(path.join(root, adapter.files[0].name), adapter.files[0].code);
    config.targets[1].adapters = { VendorChart: adapter.files[0].name };
    await writeFile(path.join(root, 'skelcast.config.mjs'), `export default ${JSON.stringify(config)};`);
    await run('sync');
    await toolbar.getByRole('combobox', { name: 'Loading region' }).selectOption('repair.chart');
    await expect(page.locator('[data-sk-boundary="repair.chart"] [data-sk-fallback]')).toHaveCount(0);
    expect((await run('diagnose', '--id', 'repair.chart')).needsReview).toBe(false);
    await toolbar.screenshot({ path: `test-results/${framework}-agent-repair-preview.png` });
    expect(errors).toEqual([]);
    await build({ root, logLevel: 'silent' });
    expect(await readFile(path.join(root, 'dist/index.html'), 'utf8')).not.toContain('skelcast-devtools');
  } finally { await server?.close(); await rm(root, { recursive: true, force: true }); }
});
