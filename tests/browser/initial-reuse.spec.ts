import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build, preview } from 'vite';
import { loadProject, syncProject } from '../../dist/index.js';
import { skelcastPlugin } from '../../dist/vite.js';

async function fixture(render: 'light' | 'shadow', lazy = true, asyncEntry = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-initial-reuse-'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(root, 'index.html'), `<html><head><script async src="data:text/javascript,window.analytics=true"></script></head><body><button id="mount">Mount</button><button id="variant">Variant</button><button id="reset">Reset</button><div id="host"></div><script type=module ${asyncEntry ? 'async' : ''} src="/main.js"></script></body></html>`);
  await writeFile(path.join(root, 'View.tsx'), `import './layout.css';const layout='grid';export default()=> <article id="card" className={layout==='grid'?'only-in-html':'other-variant'}><span>Keep   spaces &amp; symbols</span><img width="40" height="20"/></article>`);
  await writeFile(path.join(root, 'layout.css'), '.only-in-html{height:96px;width:80%;padding:10px}.other-variant{height:144px;width:60%;padding:10px}');
  await writeFile(path.join(root, 'skelcast.config.mjs'), `export default {targets:[{id:'shell',source:'View.tsx',kind:'page',render:${JSON.stringify(render)},variants:{grid:{bindings:{layout:'grid'}},list:{bindings:{layout:'list'}}},defaultVariant:'grid'}]}`);
  const runtime = path.join(process.cwd(), 'dist/runtime/index.js');
  await writeFile(path.join(root, 'main.js'), `import{mountSkeleton,releasePageSkeleton}from ${JSON.stringify(runtime)};
    ${lazy ? '' : `import artifact from 'virtual:skelcast/shell';`}
    // Simulate an application replacing its shell before visiting this route.
    document.querySelector('[data-sk-initial]')?.remove();
    releasePageSkeleton({preview:false});let dispose;
    async function mount(variant){${lazy ? `const{default:artifact}=await import('virtual:skelcast/shell');` : ''}
      dispose?.();dispose=mountSkeleton(document.getElementById('host'),artifact,variant);}
    document.getElementById('mount').onclick=()=>mount('grid');
    document.getElementById('variant').onclick=()=>mount('list');
    document.getElementById('reset').onclick=()=>mount('grid');`);
  await syncProject(await loadProject(root));
  return root;
}

async function javascript(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? javascript(path.join(directory, entry.name)) : entry.name.endsWith('.js') ? readFile(path.join(directory, entry.name), 'utf8') : ''))).join('');
}

for (const render of ['light', 'shadow'] as const) test(`${render}: lazy page data survives shell removal, SPA navigation and variant remounts without a JS copy`, async ({ browser, page }) => {
  const root = await fixture(render);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await build({ root, base: '/demo/', configFile: false, logLevel: 'silent', plugins: [skelcastPlugin()] });
    const html = await readFile(path.join(root, 'dist/index.html'), 'utf8');
    const js = await javascript(path.join(root, 'dist'));
    expect(html).toContain('only-in-html');
    expect(js).not.toContain('only-in-html');
    expect(js).toContain('other-variant');
    expect(js).not.toContain('@keyframes skelcast-base-pulse-v1');
    const server = await preview({ root, base: '/demo/', configFile: false, logLevel: 'silent', preview: { host: '127.0.0.1', port: 0 } });
    try {
      const { port } = server.httpServer.address() as { port: number };
      const url = `http://127.0.0.1:${port}/demo/`;
      const context = await browser.newContext({ javaScriptEnabled: false });
      try {
        const initial = await context.newPage();
        await initial.goto(url);
        await expect(initial.locator('[data-sk-initial]')).toBeVisible();
        await expect(initial.locator('.only-in-html')).toHaveCSS('height', '96px');
      } finally { await context.close(); }
      await page.goto(url);
      await expect(page.locator('[data-sk-initial]')).toHaveCount(0);
      await page.evaluate(() => history.pushState({}, '', '/demo/another-route'));
      await page.getByRole('button', { name: 'Mount', exact: true }).click();
      await expect(page.locator('#host .only-in-html')).toHaveCSS('height', '96px');
      await expect(page.locator('#host [data-sk-source-id="card"]')).toHaveCount(1);
      await page.getByRole('button', { name: 'Variant', exact: true }).click();
      await expect(page.locator('#host .other-variant')).toHaveCSS('height', '144px');
      await page.getByRole('button', { name: 'Reset', exact: true }).click();
      await expect(page.locator('#host .only-in-html')).toHaveCSS('height', '96px');
      expect(errors).toEqual([]);
    } finally { await new Promise<void>((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve())); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const mode of ['disabled', 'multi-entry', 'async-entry', 'ssr'] as const) test(`${mode}: builds retain standalone page data when initial reuse is unavailable`, async ({ page }) => {
  const root = await fixture('light', false, mode === 'async-entry');
  try {
    if (mode === 'multi-entry') await writeFile(path.join(root, 'other.html'), await readFile(path.join(root, 'index.html'), 'utf8'));
    await build({ root, configFile: false, logLevel: 'silent', plugins: [skelcastPlugin({ reuseInitial: mode !== 'disabled' })],
      build: mode === 'ssr' ? { ssr: path.join(root, 'main.js') } : mode === 'multi-entry' ? { rolldownOptions: { input: { main: path.join(root, 'index.html'), other: path.join(root, 'other.html') } } } : {} });
    expect(await javascript(path.join(root, 'dist'))).toContain('only-in-html');
    if (mode === 'ssr') return;
    const html = await readFile(path.join(root, 'dist/index.html'), 'utf8');
    expect(html).not.toContain('data-sk-initial-style');
    const server = await preview({ root, configFile: false, logLevel: 'silent', preview: { host: '127.0.0.1', port: 0 } });
    try {
      const { port } = server.httpServer.address() as { port: number };
      await page.goto(`http://127.0.0.1:${port}/${mode === 'multi-entry' ? 'other.html' : ''}`);
      await page.getByRole('button', { name: 'Mount', exact: true }).click();
      await expect(page.locator('#host .only-in-html')).toHaveCSS('height', '96px');
    } finally { await new Promise<void>((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve())); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
