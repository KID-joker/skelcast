import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build, createServer } from 'vite';
import type { InitReport } from '../../src/init/types.js';

const execute = promisify(execFile);
for (const framework of ['react', 'vue'] as const) test(`init integrates an untouched ${framework} project that builds and runs real/forced loading`, async ({ page }) => {
  const repo = process.cwd();
  const root = await mkdtemp(path.join(os.tmpdir(), `skelcast-${framework}-`));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await mkdir(path.join(root, 'node_modules'));
    for (const name of ['react', 'react-dom', 'vue', 'vite', '@vitejs']) await symlink(path.join(repo, 'node_modules', name), path.join(root, 'node_modules', name), 'dir');
    await symlink(repo, path.join(root, 'node_modules/skelcast'), 'dir');
    const manifest = { name: 'existing-app', type: 'module', dependencies: { [framework]: '*', vite: '*', skelcast: '0.1.0' } };
    await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'vite.config.mjs'), `import framework from '@vitejs/plugin-${framework}'; export default {plugins:[framework()],server:{fs:{allow:${JSON.stringify([repo, root])}}}};`);
    await writeFile(path.join(root, 'index.html'), `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/src/main.${framework === 'react' ? 'jsx' : 'js'}"></script></body></html>`);
    await writeFile(path.join(root, 'src/app.css'), `*{box-sizing:border-box}[hidden]{display:none!important}body{font:16px system-ui;margin:32px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.card{padding:24px;background:#eef2f6;min-height:100px}`);
    if (framework === 'react') {
      await writeFile(path.join(root, 'src/main.jsx'), `import React from 'react';import {createRoot} from 'react-dom/client';import App from './App.jsx';createRoot(document.getElementById('root')).render(<App/>);`);
      await writeFile(path.join(root, 'src/App.jsx'), `import React,{useState,useEffect} from 'react';import './app.css';export default function App(){const [loading,setLoading]=useState(true);const items=['Alpha','Beta'];useEffect(()=>{const timer=setTimeout(()=>setLoading(false),650);return()=>clearTimeout(timer)},[]);return <main><h1>Existing project</h1><input aria-label="Draft"/><button onClick={()=>{setLoading(true);setTimeout(()=>setLoading(false),650)}}>Reload</button>{loading ? <p>Loading...</p> : <section className="grid">{items.map(item=><article className="card" key={item}>{item}</article>)}</section>}</main>}`);
    } else {
      await writeFile(path.join(root, 'src/main.js'), `import {createApp} from 'vue';import App from './App.vue';import './app.css';createApp(App).mount('#root');`);
      await writeFile(path.join(root, 'src/App.vue'), `<script setup>import {ref,onMounted} from 'vue';const loading=ref(true);const items=['Alpha','Beta'];onMounted(()=>setTimeout(()=>loading.value=false,650));function reload(){loading.value=true;setTimeout(()=>loading.value=false,650)}</script><template><main><h1>Existing project</h1><input aria-label="Draft"/><button @click="reload">Reload</button><p v-if="loading">Loading...</p><section v-else class="grid"><article v-for="item in items" :key="item" class="card">{{item}}</article></section></main></template>`);
    }
    const before = await readFile(path.join(root, `src/App.${framework === 'react' ? 'jsx' : 'vue'}`), 'utf8');
    const dry = await execute(process.execPath, [path.join(repo, 'dist/cli.js'), 'init', '--root', root, '--dry-run', '--json']);
    const planned = JSON.parse(dry.stdout) as InitReport;
    expect(planned.targets.filter(t => t.kind === 'request')).toHaveLength(1);
    expect(await readFile(path.join(root, `src/App.${framework === 'react' ? 'jsx' : 'vue'}`), 'utf8')).toBe(before);
    const result = await execute(process.execPath, [path.join(repo, 'dist/cli.js'), 'init', '--root', root, '--json']);
    const report = JSON.parse(result.stdout) as InitReport;
    expect(report.generated?.every(r => r.state === 'generated')).toBe(true);
    const request = report.targets.find(t => t.kind === 'request')!;
    const repeated = await execute(process.execPath, [path.join(repo, 'dist/cli.js'), 'init', '--root', root, '--json']);
    expect(JSON.parse(repeated.stdout).changes).toHaveLength(0);
    await build({ root, logLevel: 'silent' });
    expect(await readFile(path.join(root, 'dist/index.html'), 'utf8')).toContain('data-sk-initial');
    server = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
    await server.listen();
    const address = server.httpServer!.address() as { port: number };
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const region = page.locator(`[data-sk-boundary="${request.id}"]`);
    await expect(region).toHaveAttribute('data-sk-visible', 'true');
    await expect(region).toHaveAttribute('data-sk-visible', 'false');
    await expect(page.getByText('Alpha', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Draft' }).fill('Keep my draft');
    const toolbar = page.locator('#skelcast-devtools');
    await toolbar.getByRole('combobox', { name: 'Loading region' }).selectOption(request.id);
    await toolbar.getByRole('combobox', { name: 'Preview mode' }).selectOption('selected');
    await expect(region).toHaveAttribute('data-sk-visible', 'true');
    await expect(region.locator('article[data-sk-node]')).toHaveCount(2);
    await toolbar.getByRole('button', { name: 'Exit', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveValue('Keep my draft');
    await page.getByRole('button', { name: 'Reload' }).click();
    await expect(region).toHaveAttribute('data-sk-visible', 'true');
    await expect(region).toHaveAttribute('data-sk-visible', 'false');
    expect(errors).toEqual([]);
  } finally { await server?.close(); await rm(root, { recursive: true, force: true }); }
});
