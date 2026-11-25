import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import reactPlugin from '@vitejs/plugin-react';
import vuePlugin from '@vitejs/plugin-vue';

for (const framework of ['react', 'vue'] as const) for (const fallback of [false, true]) test(`${framework}: lazy skeletons retain DOM and share styles until unmounted (${fallback ? 'style fallback' : 'constructed sheets'})`, async ({ page }) => {
  const repo = process.cwd();
  const root = await mkdtemp(path.join(os.tmpdir(), `skelcast-runtime-${framework}-`));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  const errors: string[] = [];
  let navigations = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
  page.on('pageerror', error => errors.push(error.message));
  const artifact = (render: 'light' | 'shadow') => ({
    id: `cached-${render}`, kind: 'request', render, defaultVariant: 'default',
    variants: { default: { html: `<div data-sk-artifact="cached-${render}"><article>Default</article></div>`, css: 'article{height:73px}' }, alternate: { html: `<div data-sk-artifact="cached-${render}"><article>Alternate</article></div>`, css: 'article{height:91px}' } },
    source: '', sources: {}, diagnostics: [], evidence: [],
  });
  const fixtures = `const artifacts=${JSON.stringify([artifact('light'), artifact('light'), artifact('shadow'), artifact('shadow')])};`;
  try {
    await mkdir(path.join(root, 'node_modules'));
    for (const name of ['react', 'react-dom', 'vue']) await symlink(path.join(repo, 'node_modules', name), path.join(root, 'node_modules', name), 'dir');
    await symlink(repo, path.join(root, 'node_modules/skelcast'), 'dir');
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(root, 'index.html'), `<html><head><style>[hidden]{display:none!important}</style></head><body><div id="root"></div><script type="module" src="/main.${framework === 'react' ? 'jsx' : 'js'}"></script></body></html>`);
    if (framework === 'react') {
      await writeFile(path.join(root, 'main.jsx'), `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{LoadingBoundary}from'skelcast/react';${fixtures}
        function App(){const[pending,setPending]=useState(false);const[variant,setVariant]=useState('default');const[count,setCount]=useState(4);return <><button onClick={()=>setPending(v=>!v)}>Toggle</button><button onClick={()=>setVariant('alternate')}>Variant</button><button onClick={()=>setCount(v=>v-1)}>Remove</button>{artifacts.slice(0,count).map((artifact,index)=><LoadingBoundary key={index} artifact={artifact} pending={pending} variant={variant}><input aria-label={'Draft '+index}/></LoadingBoundary>)}</>}
        createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);`);
    } else {
      await writeFile(path.join(root, 'main.js'), `import{createApp}from'vue';import App from './App.vue';createApp(App).mount('#root');`);
      await writeFile(path.join(root, 'App.vue'), `<script setup>import{ref}from'vue';import{LoadingBoundary}from'skelcast/vue';${fixtures}const pending=ref(false),variant=ref('default'),count=ref(4)</script><template><button @click="pending=!pending">Toggle</button><button @click="variant='alternate'">Variant</button><button @click="count--">Remove</button><LoadingBoundary v-for="(artifact,index) in artifacts.slice(0,count)" :key="index" :artifact="artifact" :pending="pending" :variant="variant"><input :aria-label="'Draft '+index"/></LoadingBoundary></template>`);
    }
    server = await createServer({ root, configFile: false, logLevel: 'silent', plugins: [framework === 'react' ? reactPlugin() : vuePlugin()],
      // Keep dependencies fixed; this fixture tests state changes rather than HMR.
      // macOS can deliver initial file-write events after navigation, so disable watching.
      optimizeDeps: { noDiscovery: true, include: framework === 'react' ? ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] : ['vue'] }, server: { watch: null, host: '127.0.0.1', port: 0, fs: { allow: [repo, root] } } });
    await server.listen();
    const address = server.httpServer!.address() as { port: number };
    if (fallback) await page.addInitScript(() => { Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', { value: undefined, configurable: true }); });
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await expect(page.locator('[data-sk-boundary]')).toHaveCount(4);
    await expect(page.locator('[data-sk-artifact]')).toHaveCount(0);
    await expect(page.locator('style[data-sk-style]')).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Draft 0', exact: true }).fill('Keep this draft');
    await page.getByRole('button', { name: 'Toggle', exact: true }).click();
    await expect(page.locator('[data-sk-artifact]')).toHaveCount(4);
    const article = page.locator('[data-sk-artifact] article');
    await expect(article.first()).toHaveCSS('height', '73px');
    await expect(article.last()).toHaveCSS('height', '73px');
    await expect(page.locator('head style[data-sk-style]')).toHaveCount(1);
    const original = await article.first().elementHandle();
    if (fallback) await expect(page.locator('style[data-sk-style]')).toHaveCount(3);
    else expect(await page.locator('[data-sk-boundary="cached-shadow"]').evaluateAll(boundaries => {
      const roots = boundaries.map(boundary => boundary.firstElementChild!.firstElementChild!.shadowRoot!);
      return roots[0].adoptedStyleSheets[0] === roots[1].adoptedStyleSheets[0];
    })).toBe(true);
    await page.getByRole('button', { name: 'Toggle', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Draft 0', exact: true })).toHaveValue('Keep this draft');
    await page.getByRole('button', { name: 'Toggle', exact: true }).click();
    expect(await original!.evaluate(element => element.isConnected)).toBe(true);
    await page.getByRole('button', { name: 'Toggle', exact: true }).click();
    await page.getByRole('button', { name: 'Variant', exact: true }).click();
    expect(await original!.evaluate(element => element.isConnected)).toBe(true);
    await page.getByRole('button', { name: 'Toggle', exact: true }).click();
    await expect(article.first()).toHaveCSS('height', '91px');
    await expect(article.last()).toHaveCSS('height', '91px');
    expect(await original!.evaluate(element => element.isConnected)).toBe(false);
    // Removing one instance retains the shared style until its final consumer exits.
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.locator('head style[data-sk-style]')).toHaveCount(1);
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.locator('[data-sk-boundary]')).toHaveCount(0);
    await expect(page.locator('style[data-sk-style]')).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(navigations).toBe(1);
  } finally { await server?.close(); await rm(root, { recursive: true, force: true }); }
});
