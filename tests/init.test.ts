import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initProject } from '../src/init/index.js';
import { checkProject, loadProject, readArtifact } from '../src/generator.js';
import { parseCode } from '../src/init/ast.js';
import { matchesRoute, withSkelCast } from '../src/vite.js';

const manifest = { name: 'existing-app', type: 'module', dependencies: { react: '^19', vue: '^3', vite: '^8' }, devDependencies: { skelcast: '^0.1.0' } };
async function fixture(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-init-'));
  try {
    for (const [file, content] of Object.entries({ 'package.json': JSON.stringify(manifest), 'vite.config.ts': `import {defineConfig} from 'vite'; export default defineConfig({plugins:[],server:{port:5555}});`, ...files })) {
      const absolute = path.join(root, file); await mkdir(path.dirname(absolute), { recursive: true }); await writeFile(absolute, content);
    }
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('init dry-run discovers React pages/regions without executing code or writing files', async () => {
  const code = `globalThis.__initBusinessExecuted=true; throw new Error('do not execute'); export default function App(){const {data,isLoading}=useQuery();return <main><h1>Orders</h1>{isLoading ? <p>Loading...</p> : <section className="orders">{data.map(item=><article>{item.name}</article>)}</section>}</main>}`;
  await fixture({ 'src/App.tsx': code }, async root => {
    const report = await initProject(root, { dryRun: true });
    assert.equal(report.targets.length, 2);
    assert.equal(report.targets.filter(t => t.kind === 'page').length, 1);
    assert.equal(report.targets.filter(t => t.kind === 'request').length, 1);
    assert.equal(await readFile(path.join(root, 'src/App.tsx'), 'utf8'), code);
    assert.ok(!(await readdir(root)).includes('.skelcast'));
    assert.equal((globalThis as any).__initBusinessExecuted, undefined);
    parseCode(report.changes.find(c => c.file === 'src/App.tsx')!.after);
  });
});
test('init integrates React regions, extracts only their content, backs up originals and is idempotent', async () => {
  const code = `'use client'; import './app.css'; export default function App(){const {data,isLoading}=useQuery();return <main><h1>Orders</h1>{isLoading ? <p>Loading...</p> : <section className="orders">{data.map(item=><article>{item.name}</article>)}</section>}</main>}`;
  await fixture({ 'src/App.tsx': code, 'src/app.css': `.orders{display:grid;grid-template-columns:repeat(2,1fr)}` }, async root => {
    const report = await initProject(root);
    assert.ok(report.generated?.every(t => t.state === 'generated'));
    assert.ok(report.backup);
    assert.equal(await readFile(path.join(root, report.backup!, 'src/App.tsx'), 'utf8'), code);
    const modified = await readFile(path.join(root, 'src/App.tsx'), 'utf8');
    assert.ok(modified.startsWith("'use client'"));
    assert.match(modified, /isLoading \? null : <section/);
    const project = await loadProject(root);
    const request = project.config.targets.find(t => t.kind === 'request')!;
    const artifact = await readArtifact(project, request.id);
    assert.match(artifact.variants.default.html, /class="orders"/);
    assert.doesNotMatch(artifact.variants.default.html, /<h1|<main/);
    assert.equal((artifact.variants.default.html.match(/<article/g) ?? []).length, 4);
    assert.equal(artifact.diagnostics.filter(d => d.code === 'FALLBACK').length, 0);
    assert.ok((await checkProject(project)).every(t => t.state === 'ready'));
    const config = await readFile(path.join(root, 'skelcast.config.mjs'), 'utf8');
    const again = await initProject(root);
    assert.equal(again.changes.length, 0);
    assert.equal(await readFile(path.join(root, 'src/App.tsx'), 'utf8'), modified);
    assert.equal(await readFile(path.join(root, 'skelcast.config.mjs'), 'utf8'), config);
    assert.ok(again.generated?.every(t => t.state === 'reused'));
  });
});
test('early-return integration preserves guarded business evaluation order', async () => {
  const code = `export default function App(){const {data,isLoading}=useQuery(); if(isLoading){return <Spinner/>} const title=data.title; return <main><h1>{title}</h1></main>}`;
  await fixture({ 'src/App.tsx': code }, async root => {
    const report = await initProject(root);
    assert.equal(report.targets.length, 1);
    assert.equal(report.targets[0].kind, 'page');
    const modified = await readFile(path.join(root, 'src/App.tsx'), 'utf8');
    assert.ok(modified.indexOf('if(isLoading)') < modified.indexOf('const title=data.title'));
    assert.match(modified, /pending=\{isLoading\} \/>/);
    const artifact = await readArtifact(await loadProject(root), report.targets[0].id);
    assert.match(artifact.variants.default.html, /<main/);
    assert.doesNotMatch(artifact.variants.default.html, /data-sk-fallback/);
  });
});
test('React map inference requires data and pending to share a query declaration', async () => {
  await fixture({ 'src/App.tsx': `export default function App(){const {data:orders,isLoading}=useOrders(); const categories=['A','B']; return <main><nav>{categories.map(c=><span>{c}</span>)}</nav><section>{orders.map(o=><article>{o.title}</article>)}</section></main>}` }, async root => {
    const report = await initProject(root);
    const request = report.targets.find(t => t.kind === 'request')!;
    assert.ok(request);
    const artifact = await readArtifact(await loadProject(root), request.id);
    assert.match(artifact.variants.default.html, /<section/);
    assert.doesNotMatch(artifact.variants.default.html, /<nav/);
  });
});
test('aliased pending fields and optional lists produce meaningful region skeletons', async () => {
  await fixture({ 'src/App.tsx': `export default function App(){const {data:items,isLoading:busy}=useQuery();return <main>{busy ? <Spinner/> : <section>{items?.map(item=><article>{item.title}</article>)}</section>}</main>}` }, async root => {
    const report = await initProject(root);
    const region = report.targets.find(t => t.kind === 'request')!;
    assert.ok(region);
    const artifact = await readArtifact(await loadProject(root), region.id);
    assert.equal((artifact.variants.default.html.match(/<article/g) ?? []).length, 4);
    assert.match(await readFile(path.join(root, 'src/App.tsx'), 'utf8'), /pending=\{busy\}/);
  });
});
test('Vue v-if/v-else integration preserves localized loading guards, scoped CSS and script setup', async () => {
  await fixture({ 'src/App.vue': `<script setup>import {ref} from 'vue'; const loading=ref(true);const data=ref(null);throw new Error('never run')</script><template><main><h1>Orders</h1><p v-if="loading">\u52a0\u8f7d\u4e2d</p><section v-else class="orders"><h2>{{data.title}}</h2></section></main></template><style scoped>.orders{display:grid}</style>` }, async root => {
    const report = await initProject(root);
    assert.equal(report.targets.length, 2);
    const changed = await readFile(path.join(root, 'src/App.vue'), 'utf8');
    assert.match(changed, /v-if="!\(loading\)"/);
    assert.match(changed, /LoadingBoundary as SkelCastBoundary/);
    const request = report.targets.find(t => t.kind === 'request')!;
    const artifact = await readArtifact(await loadProject(root), request.id);
    assert.match(artifact.variants.default.html, /class="orders"/);
    assert.match(artifact.variants.default.html, /data-v-sk-/);
    assert.doesNotMatch(artifact.variants.default.html, /<h1|<main/);
    assert.equal((await initProject(root)).changes.length, 0);
  });
});
test('Vue Options API registers the boundary and replaces v-loading without executing options', async () => {
  await fixture({ 'src/App.vue': `<script>export default {name:'OldPage',data(){throw new Error('must not execute');return {loading:true}}}</script><template><main v-loading="loading"><h1>Orders</h1></main></template>` }, async root => {
    const report = await initProject(root);
    assert.equal(report.targets.length, 1);
    const changed = await readFile(path.join(root, 'src/App.vue'), 'utf8');
    assert.match(changed, /components: \{ SkelCastBoundary \}/);
    assert.doesNotMatch(changed, /v-loading/);
    assert.match(changed, /:pending="loading"/);
    const artifact = await readArtifact(await loadProject(root), report.targets[0].id);
    assert.match(artifact.variants.default.html, /<main/);
  });
});
test('Vue loading directives accept existing flags with arbitrary names', async () => {
  await fixture({ 'src/App.vue': `<script setup>const busy=useTableState()</script><template><main v-loading="busy">Content</main></template>` }, async root => {
    const report = await initProject(root);
    assert.equal(report.targets.length, 1);
    assert.match(await readFile(path.join(root, 'src/App.vue'), 'utf8'), /:pending="busy"/);
  });
});
test('entry-point CSS is included in Vue artifacts before business JavaScript runs', async () => {
  await fixture({ 'src/main.js': `import './global.css'; import App from './App.vue'`, 'src/global.css': `.grid{display:grid;grid-template-columns:1fr 1fr}`, 'src/App.vue': `<template><main class="grid"><article>Content</article></main></template>` }, async root => {
    const report = await initProject(root);
    const artifact = await readArtifact(await loadProject(root), report.targets[0].id);
    assert.match(artifact.variants.default.css, /display:grid/);
    assert.deepEqual(report.targets[0].styles, ['src/global.css']);
  });
});
test('static routes resolve relative, lazy and tsconfig alias imports without running the router', async () => {
  await fixture({ 'tsconfig.json': `{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}`, 'src/router.tsx': `import Orders from '@/pages/Orders';throw new Error('router must not run'); const routes=[{path:'/orders/:id',element:<Orders/>},{path:'/archive',component:()=>import('./pages/Orders')}];`, 'src/pages/Orders.tsx': `export default function Orders(){return <main><h1>Orders</h1></main>}` }, async root => {
    const report = await initProject(root);
    const page = report.targets.find(t => t.kind === 'page')!;
    assert.deepEqual(page.route, ['/archive', '/orders/:id']);
    assert.equal((await loadProject(root)).config.aliases?.['@'], 'src');
    assert.ok(matchesRoute(page.route, '/orders/123'));
    assert.ok(matchesRoute(page.route, '/archive'));
    assert.ok(!matchesRoute(page.route, '/unrelated'));
  });
});
test('nested JSX index routes preserve their parent path', async () => {
  await fixture({ 'src/routes.tsx': `import Home from './Home'; import Orders from './Orders'; const routes=<Route path="/workspace"><Route index element={<Home/>}/><Route path="orders" element={<Orders/>}/></Route>`, 'src/Home.tsx': `export default ()=> <main>Home</main>`, 'src/Orders.tsx': `export default ()=> <main>Orders</main>` }, async root => {
    const report = await initProject(root);
    assert.equal(report.targets.find(t => t.source === 'src/Home.tsx')?.route, '/workspace');
    assert.equal(report.targets.find(t => t.source === 'src/Orders.tsx')?.route, '/workspace/orders');
  });
});
test('Vite aliases and custom root are propagated into generated configuration', async () => {
  await fixture({ 'vite.config.ts': `import {defineConfig} from 'vite'; import {fileURLToPath} from 'node:url'; export default defineConfig({root:'web',resolve:{alias:{'@':fileURLToPath(new URL('./web',import.meta.url))}}})`, 'web/App.tsx': `import Card from '@/Card'; export default function App(){return <main><Card/></main>}`, 'web/Card.tsx': `export default ()=> <article>Card</article>` }, async root => {
    const report = await initProject(root);
    assert.ok(report.changes.some(c => c.file === 'web/skelcast.config.mjs'));
    const project = await loadProject(path.join(root, 'web'));
    assert.equal(project.config.aliases?.['@'], '.');
    const artifact = await readArtifact(project, project.config.targets[0].id);
    assert.match(artifact.variants.default.html, /<article/);
    assert.ok(!artifact.diagnostics.some(d => d.code === 'FALLBACK'));
  });
});
test('existing config targets and comments are preserved when adding new pages', async () => {
  await fixture({ 'skelcast.config.mjs': `// keep this comment\nexport default {targets:[{id:'manual',source:'src/Manual.tsx'}, /* preserve */], outDir:'.generated'};`, 'src/Manual.tsx': `export default ()=> <span/>`, 'src/pages/Orders.tsx': `export default ()=> <main>Orders</main>` }, async root => {
    const report = await initProject(root);
    const text = await readFile(path.join(root, 'skelcast.config.mjs'), 'utf8');
    assert.ok(text.includes('// keep this comment')); assert.ok(text.includes('/* preserve */'));
    const project = await loadProject(root);
    assert.equal(project.config.targets[0].id, 'manual');
    assert.equal(project.config.outDir, '.generated');
    assert.ok(report.generated?.every(t => t.state === 'generated'));
  });
});
test('dynamic existing config and unsupported bundlers are diagnosed without modifying the project', async () => {
  await fixture({ 'skelcast.config.mjs': `import business from './src/App';export default makeConfig(business)`, 'src/App.tsx': `throw new Error('must not run');export default ()=> <main/>` }, async root => {
    const report = await initProject(root);
    assert.ok(report.diagnostics.some(d => d.code === 'CONFIG_DYNAMIC'));
    assert.equal(report.changes.length, 0);
  });
  await fixture({ 'package.json': JSON.stringify({ ...manifest, dependencies: { next: '^15', react: '^19' } }) }, async root => {
    const report = await initProject(root); assert.ok(report.diagnostics.some(d => d.code === 'SSR_FRAMEWORK')); assert.equal(report.changes.length, 0);
  });
});
test('init does not execute even a pre-existing static SkelCast config module', async () => {
  await fixture({ 'skelcast.config.mjs': `globalThis.__initConfigExecuted=true; export default {targets:[]}`, 'src/App.tsx': `export default ()=> <main/>` }, async root => {
    const report = await initProject(root);
    assert.ok(report.generated?.length);
    assert.equal((globalThis as any).__initConfigExecuted, undefined);
  });
});
test('a generation failure rolls back codemods and newly created configuration', async () => {
  const source = `import './missing.css';export default ()=> <main/>`;
  // Existing parser ignores unresolved imports, so use a malformed explicit imported stylesheet.
  await fixture({ 'src/App.tsx': source, 'src/missing.css': `main { color:` }, async root => {
    await assert.rejects(initProject(root));
    assert.equal(await readFile(path.join(root, 'src/App.tsx'), 'utf8'), source);
    assert.ok(!(await readdir(root)).includes('skelcast.config.mjs'));
    assert.ok(!(await readFile(path.join(root, 'vite.config.ts'), 'utf8')).includes('withSkelCast'));
  });
});
test('failed generation restores artifacts from a partially completed sync', async () => {
  await fixture({ 'src/App.tsx': `import './bad.css';export default ()=> <main/>`, 'src/bad.css': `main {color:`, 'src/Other.tsx': `export default ()=> <article/>`, 'skelcast.config.mjs': `export default {targets:[{id:'manual',source:'src/Other.tsx'}]}` }, async root => {
    await mkdir(path.join(root, '.skelcast'));
    await writeFile(path.join(root, '.skelcast/manual.mjs'), 'original bytes');
    const originalManifest = JSON.stringify({ version: 'old', configHash: '', targets: {} });
    await writeFile(path.join(root, '.skelcast/manifest.json'), originalManifest);
    await assert.rejects(initProject(root));
    assert.equal(await readFile(path.join(root, '.skelcast/manual.mjs'), 'utf8'), 'original bytes');
    assert.equal(await readFile(path.join(root, '.skelcast/manifest.json'), 'utf8'), originalManifest);
  });
});
test('withSkelCast preserves object, async factory and Promise configs', async () => {
  const plugin = { name: 'existing' };
  const config: any = withSkelCast({ plugins: [plugin], server: { port: 5555 } });
  assert.equal(config.server.port, 5555); assert.equal(config.plugins[0], plugin); assert.equal(config.plugins[1].name, 'skelcast');
  const factory: any = withSkelCast(async env => ({ base: env.command === 'build' ? '/prod/' : '/', plugins: [plugin] }));
  assert.equal((await factory({ command: 'build', mode: 'production' })).base, '/prod/');
  assert.equal(((await withSkelCast(Promise.resolve({ plugins: [] }))) as any).plugins[0].name, 'skelcast');
});
