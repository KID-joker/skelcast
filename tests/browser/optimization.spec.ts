import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build, preview } from 'vite';
import { loadProject, syncProject } from '../../dist/index.js';
import { skelcastPlugin } from '../../dist/vite.js';

for (const framework of ['react', 'vue'] as const) test(`${framework}: optimized production matches original geometry before JS and across shadow variants`, async ({ browser, page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-optimization-'));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await symlink(path.join(process.cwd(), 'node_modules'), path.join(root, 'node_modules'), 'dir');
    // The package itself lives outside node_modules in this repository.
    const adapter = path.join(process.cwd(), `dist/adapters/${framework}.js`);
    const runtime = path.join(process.cwd(), 'dist/runtime/index.js');
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(root, 'index.html'), '<html><head></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>');
    await writeFile(path.join(root, 'View.tsx'), `import './layout.css';const mode='grid';export default()=> <main className={mode==='grid'?'grid':'list'}>{[1,2,3,4].map(n=><article className="tile"><span>Card {n}</span><img width="40" height="20"/></article>)}</main>`);
    await writeFile(path.join(root, 'layout.css'), '.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.list{display:block}.tile{height:100px;padding:12px;border:1px solid #aaa}.tile span{font-size:18px;line-height:24px}@media(max-width:600px){.grid{grid-template-columns:1fr}}');
    await writeFile(path.join(root, 'skelcast.config.mjs'), `export default {targets:[{id:'shell',source:'View.tsx',kind:'page'},{id:'panel',source:'View.tsx',render:'shadow',variants:{grid:{bindings:{mode:'grid'}},list:{bindings:{mode:'list'}}}}]}`);
    const imports = `import {LoadingBoundary} from ${JSON.stringify(adapter)};import{releasePageSkeleton}from ${JSON.stringify(runtime)};import shell from 'virtual:skelcast/shell';import panel from 'virtual:skelcast/panel';`;
    await writeFile(path.join(root, 'main.js'), framework === 'react' ? `
      import{createElement as h,useState}from'react';import{createRoot}from'react-dom/client';${imports}
      function App(){const[pending,setPending]=useState(true),[variant,setVariant]=useState('grid');return h('div',null,
        h('button',{onClick:()=>setVariant('list')},'Variant'),h('button',{onClick:()=>setPending(false)},'Ready'),
        h(LoadingBoundary,{artifact:shell,pending},h('input',{'aria-label':'Draft'})),
        h(LoadingBoundary,{artifact:panel,pending,variant},h('div',null,'Content')))}
      releasePageSkeleton({preview:false});createRoot(document.getElementById('root')).render(h(App));` : `
      import{createApp,h,ref}from'vue';${imports}
      releasePageSkeleton({preview:false});createApp({setup(){const pending=ref(true),variant=ref('grid');return()=>h('div',null,[
        h('button',{onClick:()=>variant.value='list'},'Variant'),h('button',{onClick:()=>pending.value=false},'Ready'),
        h(LoadingBoundary,{artifact:shell,pending:pending.value},{default:()=>h('input',{'aria-label':'Draft'})}),
        h(LoadingBoundary,{artifact:panel,pending:pending.value,variant:variant.value},{default:()=>h('div',null,'Content')})])}}).mount('#root');`);
    await syncProject(await loadProject(root));
    const snapshots: number[][][] = [];
    const bytes: number[] = [];
    const capture = async (locator: ReturnType<typeof page.locator>) => locator.locator('.tile').evaluateAll(elements => elements.map(el => {
      const box = el.getBoundingClientRect();
      return [box.x, box.y, box.width, box.height, parseFloat(getComputedStyle(el).paddingLeft)];
    }));
    for (const optimize of [false, true]) {
      const outDir = optimize ? 'optimized' : 'original';
      await build({ root, configFile: false, logLevel: 'silent', plugins: [skelcastPlugin({ optimize })], build: { outDir } });
      const assets = path.join(root, outDir, 'assets');
      const js = (await Promise.all((await readdir(assets)).filter(file => file.endsWith('.js')).map(file => readFile(path.join(assets, file), 'utf8')))).join('');
      const html = await readFile(path.join(root, outDir, 'index.html'), 'utf8');
      bytes.push(Buffer.byteLength(js) + Buffer.byteLength(html));
      if (optimize) {
        expect(html).not.toContain('data-sk-node');
        expect(js).not.toContain('data-sk-node');
        expect(js.match(/@keyframes skelcast-base-pulse-v1/g)).toHaveLength(1);
      } else expect(html).toContain('data-sk-node');
      const server = await preview({ root, configFile: false, logLevel: 'silent', build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
      try {
        const { port } = server.httpServer.address() as { port: number };
        const url = `http://127.0.0.1:${port}/`;
        for (const width of [390, 1440]) {
          const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: 1050 } });
          try {
            const initial = await context.newPage();
            await initial.goto(url);
            await expect(initial.locator('[data-sk-initial]')).toBeVisible();
            const geometry = await capture(initial.locator('[data-sk-initial]'));
            expect(geometry).toHaveLength(4);
            snapshots.push(geometry);
          } finally { await context.close(); }
          await page.setViewportSize({ width, height: 1050 });
          await page.goto(url);
          const shell = page.locator('[data-sk-boundary="shell"]');
          const panel = page.locator('[data-sk-boundary="panel"]');
          await expect(shell).toHaveAttribute('data-sk-visible', 'true');
          await expect(panel.locator('.tile')).toHaveCount(4);
          snapshots.push(await capture(shell), await capture(panel));
          await page.getByRole('button', { name: 'Variant', exact: true }).click();
          await expect(panel.locator('.list')).toHaveCount(1);
          snapshots.push(await capture(panel));
          await page.getByRole('button', { name: 'Ready', exact: true }).click();
          await expect(page.getByRole('textbox', { name: 'Draft' })).toBeVisible();
          await expect(panel).toHaveAttribute('data-sk-visible', 'false');
        }
      } finally { await new Promise<void>((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve())); }
    }
    expect(bytes[1]).toBeLessThan(bytes[0]);
    const half = snapshots.length / 2;
    for (let i = 0; i < half; i++) {
      expect(snapshots[i + half].length).toBe(snapshots[i].length);
      for (let card = 0; card < snapshots[i].length; card++) for (let field = 0; field < snapshots[i][card].length; field++) {
        expect(snapshots[i + half][card][field]).toBeCloseTo(snapshots[i][card][field], 1);
      }
    }
    expect(errors).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
