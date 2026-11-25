import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

test('multi-viewport audit compares internal anchors and writes screenshot overlays for every variant', async ({ page }, testInfo) => {
  const repo = process.cwd();
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-audit-'));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    await mkdir(path.join(root, 'node_modules'));
    for (const name of ['react', 'react-dom', 'vite', '@vitejs']) await symlink(path.join(repo, 'node_modules', name), path.join(root, 'node_modules', name), 'dir');
    await symlink(repo, path.join(root, 'node_modules/skelcast'), 'dir');
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(root, 'vite.config.mjs'), `import react from '@vitejs/plugin-react';import{skelcastPlugin}from'skelcast/vite';export default {plugins:[react(),skelcastPlugin()]}`);
    await writeFile(path.join(root, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="/main.jsx"></script></body></html>');
    await writeFile(path.join(root, 'layout.css'), 'body{margin:0}.columns{display:grid;grid-template-columns:1fr 2fr;width:100%;height:140px;gap:12px}.shifted{grid-template-columns:2fr 1fr}.panel{height:120px;background:#f0f4fa}');
    await writeFile(path.join(root, 'View.jsx'), `import './layout.css';export default function View({aligned=true}){return <main className={aligned?'columns':'columns shifted'}><section id="left" className="panel">Left</section><section data-sk-anchor="right" className="panel">Right</section></main>}`);
    await writeFile(path.join(root, 'main.jsx'), `import React from'react';import{createRoot}from'react-dom/client';import{LoadingBoundary}from'skelcast/react';import artifact from'virtual:skelcast/layout';import View from'./View';createRoot(document.getElementById('root')).render(<LoadingBoundary artifact={artifact} pending={false}><LoadingBoundary artifact={{...artifact,id:'nested'}} pending={false}><View/></LoadingBoundary></LoadingBoundary>)`);
    await writeFile(path.join(root, 'skelcast.config.mjs'), `export default {targets:[{id:'layout',source:'View.jsx',render:'shadow',variants:{aligned:{bindings:{aligned:true}},shifted:{bindings:{aligned:false}}}}]}`);
    const { auditProject, loadProject, syncProject } = await import('../../dist/index.js');
    await syncProject(await loadProject(root));
    server = await createServer({ root, logLevel: 'silent', optimizeDeps: { exclude: ['skelcast'] }, server: { host: '127.0.0.1', port: 0, fs: { allow: [repo, root] } } });
    await server.listen();
    const address = server.httpServer!.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/`;
    const output = testInfo.outputPath('audit');
    const report = await auditProject({ url, outDir: output, id: 'layout', viewports: [{ width: 900, height: 700 }, { width: 390, height: 844 }] });
    expect(report.cases).toHaveLength(4);
    expect(report.needsReview).toBe(true);
    for (const entry of report.cases) {
      expect(entry.error).toBeUndefined();
      expect(entry.report!.delta.width).toBe(0);
      expect(entry.report!.delta.height).toBe(0);
      expect(entry.report!.anchors.compared).toBe(2);
      expect(entry.report!.needsReview).toBe(entry.variant === 'shifted');
      expect(entry.report!.anchors.mismatched).toBe(entry.variant === 'shifted' ? 2 : 0);
    }
    expect((await readdir(output)).filter(file => file.endsWith('.png'))).toHaveLength(8);
    expect(JSON.parse(await readFile(path.join(output, 'report.json'), 'utf8')).cases).toHaveLength(4);
    const html = await readFile(path.join(output, 'index.html'), 'utf8');
    expect(html).toContain('type="range"');
    expect(html).toContain('ANCHOR_MISMATCH');
    await page.goto(url);
    await expect(page.locator('[data-sk-boundary="layout"]')).toHaveAttribute('data-sk-visible', 'false');
    const error = await page.evaluate(async moduleURL => {
      const { auditBoundaryLayout } = await import(moduleURL);
      try { await auditBoundaryLayout(document.querySelector('[data-sk-boundary="layout"]'), { capture: async () => { throw new Error('Screenshot failed'); } }); }
      catch (error) { return String(error); }
    }, `/@fs/${path.join(repo, 'dist/browser.js')}`);
    expect(error).toContain('Screenshot failed');
    await expect(page.locator('[data-sk-boundary="layout"]')).toHaveAttribute('data-sk-visible', 'false');
    await page.goto(pathToFileURL(path.join(output, 'index.html')).href);
    await expect(page.getByRole('heading', { level: 2 })).toHaveCount(4);
    const slider = page.getByRole('slider').first();
    await slider.fill('0.8');
    await expect(page.locator('.skeleton').first()).toHaveCSS('opacity', '0.8');
    await page.screenshot({ path: testInfo.outputPath('audit-report.png'), fullPage: true });
  } finally { await server?.close(); await rm(root, { recursive: true, force: true }); }
});
