import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initProject } from '../src/init/index.js';
import { checkProject, loadProject, readArtifact } from '../src/generator.js';
import { createConditionAnalyzer } from '../src/init/ast.js';
import { parseSource } from '../src/compiler/ast.js';
import { matchesRoute, selectPageTarget, withSkelCast } from '../src/vite.js';
import { scanProject } from '../src/init/scan.js';
import { analyzeReact } from '../src/init/react.js';
import { analyzeVue } from '../src/init/vue.js';

const manifest = { name: 'existing-app', type: 'module', dependencies: { react: '^19', vue: '^3', vite: '^8' }, devDependencies: { skelcast: '^0.1.0' } };
test('condition analysis preserves syntax equivalence and checks loading flags against the current scope', () => {
  const conditions = createConditionAnalyzer();
  assert.ok(conditions.sameCondition('!(loading)', '! /* comment */ loading'));
  assert.ok(!conditions.sameCondition('loading && ready', 'loading || ready'));
  assert.ok(conditions.pureCondition('fetching?.value && ready'));
  assert.ok(!conditions.pendingCondition('busy && ready'));
  assert.ok(conditions.pendingCondition('busy && ready', new Set(['busy'])));
  assert.ok(!conditions.pendingCondition('busy && ready'));
  for (const code of ['loading()', 'loading = true', 'loading++', 'await loading', 'loading &&']) {
    assert.ok(!conditions.pureCondition(code), code);
    assert.ok(!conditions.pendingCondition(code, new Set(['loading'])), code);
  }
  assert.ok(!conditions.sameCondition('loading &&', 'loading ||'));
  assert.ok(conditions.sameCondition('loading &&', 'loading &&'));
});
test('initial page matching prefers specific routes over an earlier Vue catch-all', () => {
  const targets = [
    { id: '404', source: '404.vue', kind: 'page' as const, route: '/:pathMatch(.*)*' },
    { id: 'detail', source: 'Detail.vue', kind: 'page' as const, route: '/tools/:id' },
    { id: 'new', source: 'New.vue', kind: 'page' as const, route: ['/tools/new', '/create'] },
    { id: 'home', source: 'Home.vue', kind: 'page' as const, route: '/' },
  ];
  assert.equal(selectPageTarget(targets, '/')?.id, 'home');
  assert.equal(selectPageTarget(targets, '/tools/new')?.id, 'new');
  assert.equal(selectPageTarget(targets, '/tools/123')?.id, 'detail');
  assert.equal(selectPageTarget(targets, '/unknown/nested/path')?.id, '404');
  assert.ok(matchesRoute('/:pathMatch(.*)*', '/nested/path'));
});
async function fixture(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-init-'));
  try {
    for (const [file, content] of Object.entries({ 'package.json': JSON.stringify(manifest), 'vite.config.ts': `import {defineConfig} from 'vite'; export default defineConfig({plugins:[],server:{port:5555}});`, ...files })) {
      const absolute = path.join(root, file); await mkdir(path.dirname(absolute), { recursive: true }); await writeFile(absolute, content);
    }
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('reusing scanned syntax preserves init edits, target names and block-local Vue offsets', async () => {
  await fixture({
    'src/App.tsx': `'use client';const __skelcast0 = 1;export default function App(){return <main>{loading ? <Spinner/> : <section>Content</section>}</main>}`,
    'src/Setup.vue': `<script setup lang="ts">const __skelcast0 = 1;const loading = true;</script><template><main><p v-if="loading">Loading</p><section v-else>Content</section></main></template>`,
    'src/Options.vue': `<script>export default {name:'Options'}</script><template><main>Content</main></template>`,
    'src/Mixed.vue': `<script lang="ts">export default {name:'Mixed'}</script>\n<script setup lang="tsx">const loading = true;const icon = <span/>;</script><template><main v-loading="loading">Content</main></template>`,
  }, async root => {
    const scan = await scanProject(root);
    assert.equal(scan.files.length, 4);
    for (const source of scan.files) {
      const analyze = source.vue ? analyzeVue : analyzeReact;
      const ctx = { file: source.file, source: source.code, page: true, routes: ['/first', '/second'], existing: { targets: [] }, usedIds: new Set(['app.page']) };
      const expected = analyze(ctx);
      const syntax = JSON.stringify(source.ast);
      const actual = analyze({ ...ctx, usedIds: new Set(['app.page']), ast: source.ast, sfc: source.sfc });
      assert.deepEqual(actual, expected, source.file);
      assert.equal(JSON.stringify(source.ast), syntax, 'shared scan syntax stays immutable');
    }
  });
});
test('Vue init accepts native input, br and img without self-closing syntax', async () => {
  await fixture({ 'src/App.vue': '<script setup></script><template><main><input><br><img src="/photo.png"></main></template>' }, async root => {
    const report = await initProject(root);
    assert.equal(report.targets.length, 1);
    assert.equal(report.diagnostics.filter(row => row.code === 'CODEMOD_SKIPPED').length, 0);
    assert.match((await readArtifact(await loadProject(root), report.targets[0].id)).variants.default.html, /data-sk-image/);
  });
});
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
    parseSource(report.changes.find(c => c.file === 'src/App.tsx')!.after);
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
test('an init report failure leaves generated files intact and rolls back source changes', async () => {
  const source = 'export default ()=> <main>Original</main>';
  await fixture({ 'src/App.tsx': source }, async root => {
    const outDir = path.join(root, '.skelcast');
    await mkdir(path.join(outDir, 'init-report.json'), { recursive: true });
    await writeFile(path.join(outDir, 'manifest.json'), 'previous manifest');
    const vite = await readFile(path.join(root, 'vite.config.ts'), 'utf8');
    await assert.rejects(initProject(root), /EISDIR/);
    assert.equal(await readFile(path.join(root, 'src/App.tsx'), 'utf8'), source);
    assert.equal(await readFile(path.join(root, 'vite.config.ts'), 'utf8'), vite);
    assert.equal(await readFile(path.join(outDir, 'manifest.json'), 'utf8'), 'previous manifest');
    assert.deepEqual((await readdir(outDir)).sort(), ['init-backups', 'init-report.json', 'manifest.json']);
    assert.ok(!(await readdir(root)).includes('skelcast.config.mjs'));
    assert.ok(!(await readdir(path.join(root, 'src'))).includes('skelcast-env.d.ts'));
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

for (const framework of ['react', 'vue'] as const) test(`${framework}: repeated init discovers new loading regions without wrapping existing regions again`, async () => {
  const file = framework === 'react' ? 'src/App.tsx' : 'src/App.vue';
  const source = framework === 'react'
    ? `export default function App(){const {data,isLoading}=useQuery();return <main>{isLoading ? <p>Loading...</p> : <section className="original">{data.map(item=><article>{item.name}</article>)}</section>}<aside>New regions go here</aside></main>}`
    : `<script setup>const loading=usePending()</script><template><main><section class="original" v-loading="loading">Original content</section><aside>New regions go here</aside></main></template>`;
  await fixture({ [file]: source }, async root => {
    const initial = await initProject(root);
    const originalTargets = (await loadProject(root)).config.targets;
    assert.equal(originalTargets.length, 2);
    const originalBoundary = initial.targets.find(t => t.kind === 'request')!.region!;
    const firstCode = await readFile(path.join(root, file), 'utf8');
    for (const index of [1, 2]) {
      const before = await readFile(path.join(root, file), 'utf8');
      const region = framework === 'react'
        ? `{extra${index}Loading ? <p>Loading...</p> : <section className="extra${index}">Additional content</section>}`
        : `<section class="extra${index}" v-loading="extra${index}Loading">Additional content</section>`;
      await writeFile(path.join(root, file), before.replace('<aside>', `${region}<aside>`));
      const dry = await initProject(root, { dryRun: true });
      assert.equal(dry.targets.length, 1);
      assert.equal(dry.targets[0].kind, 'request');
      assert.match(dry.changes.find(c => c.file === file)!.after, new RegExp(`extra${index}`));
      const report = await initProject(root);
      assert.equal(report.targets.length, 1);
      const project = await loadProject(root);
      assert.equal(project.config.targets.length, originalTargets.length + index);
      assert.deepEqual(project.config.targets.slice(0, 2), originalTargets);
      const changed = await readFile(path.join(root, file), 'utf8');
      assert.equal((changed.match(/from 'skelcast\/(?:react|vue)'/g) ?? []).length, 1);
      assert.equal((changed.match(/skelcast:init/g) ?? []).length, 2 + index);
      assert.equal((changed.match(new RegExp(`import ${originalBoundary} from`, 'g')) ?? []).length, 1);
      assert.equal((await initProject(root)).changes.length, 0);
      const artifact = await readArtifact(project, report.targets[0].id);
      assert.match(artifact.variants.default.html, new RegExp(`class="extra${index}"`));
      const page = await readArtifact(project, originalTargets.find(t => t.kind === 'page')!.id);
      assert.match(page.variants.default.html, new RegExp(`class="extra${index}"`));
      assert.ok(!page.diagnostics.some(d => ['FALLBACK', 'BRANCH_DEFAULT'].includes(d.code)));
    }
    assert.ok(firstCode.includes(originalBoundary));
  });
});

test('incremental init reuses manually aliased React and Options API Vue boundaries', async () => {
  for (const framework of ['react', 'vue'] as const) {
    const file = framework === 'react' ? 'src/App.tsx' : 'src/App.vue';
    const source = framework === 'react'
      ? `import {LoadingBoundary as Wait} from 'skelcast/react';import old from 'virtual:skelcast/manual';export default function App(){return <main><Wait artifact={old} pending={loading}><section loading={loading}>Old</section></Wait>{nextLoading ? <p>Loading...</p> : <article>New</article>}</main>}`
      : `<script>import {LoadingBoundary as Boundary} from 'skelcast/vue';import old from 'virtual:skelcast/manual';export default {components:{Wait:Boundary},data(){return {old}}}</script><template><main><wait :artifact="old" :pending="loading"><section :loading="loading">Old</section></wait><article v-loading="nextLoading">New</article></main></template>`;
    await fixture({ [file]: source, 'src/Old.tsx': 'export default () => <section>Old</section>', 'skelcast.config.mjs': `export default {targets:[{id:'manual',source:'src/Old.tsx'}]}` }, async root => {
      const report = await initProject(root);
      assert.equal(report.targets.filter(t => t.kind === 'request').length, 1);
      const changed = await readFile(path.join(root, file), 'utf8');
      assert.equal((changed.match(/from 'skelcast\/(?:react|vue)'/g) ?? []).length, 1);
      assert.equal((await initProject(root)).changes.length, 0);
    });
  }
});

test('early-return boundaries remain unchanged while nested new regions are integrated', async () => {
  await fixture({ 'src/App.tsx': `export default function App(){const loading=usePending();if(loading)return <Spinner/>;const title=data.title;return <main><h1>{title}</h1></main>}` }, async root => {
    await initProject(root);
    const file = path.join(root, 'src/App.tsx');
    const before = await readFile(file, 'utf8');
    assert.equal((await initProject(root)).changes.length, 0);
    await writeFile(file, before.replace('</main>', '{nextLoading ? <p>Loading...</p> : <aside>New</aside>}</main>'));
    const next = await initProject(root);
    assert.equal(next.targets.length, 1);
    assert.equal(next.targets[0].kind, 'request');
    const after = await readFile(file, 'utf8');
    assert.ok(after.indexOf('if(loading)') < after.indexOf('const title=data.title'));
    assert.equal((after.match(/pending=\{loading\} \/>/g) ?? []).length, 1);
    assert.equal((await initProject(root)).changes.length, 0);
  });
});

for (const framework of ['react', 'vue'] as const) test(`${framework}: incremental inverse guards contribute content to existing page skeletons`, async () => {
  const file = framework === 'react' ? 'src/App.tsx' : 'src/App.vue';
  await fixture({ [file]: framework === 'react' ? 'export default function App(){return <main><h1>Title</h1></main>}' : '<template><main><h1>Title</h1></main></template>' }, async root => {
    const initial = await initProject(root);
    const before = await readFile(path.join(root, file), 'utf8');
    const extra = framework === 'react'
      ? `{nextLoading ? <aside>Additional details</aside> : <Spinner/>}`
      : `<aside v-if="nextLoading">Additional details</aside><Spinner v-else/>`;
    await writeFile(path.join(root, file), before.replace('</main>', `${extra}</main>`));
    const report = await initProject(root);
    assert.equal(report.targets.length, 1);
    const page = await readArtifact(await loadProject(root), initial.targets[0].id);
    assert.match(page.variants.default.html, /<aside/);
    assert.ok(!page.diagnostics.some(d => ['FALLBACK', 'BRANCH_DEFAULT'].includes(d.code)));
    assert.equal((await initProject(root)).changes.length, 0);
  });
});

test('source discovery parses plain TypeScript assertions separately from TSX and Vue script languages', async () => {
  await fixture({
    'src/rules.ts': `type Rules={name:string};export const rules=<Rules>{name:'required'};`,
    'src/App.vue': `<script setup lang="ts">type Item={title:string};const item=<Item>{title:'Data'}</script><template><main>{{item.title}}</main></template>`,
    'src/Extra.tsx': `export const Extra=()=> <aside>Extra</aside>`,
  }, async root => {
    const report = await initProject(root);
    assert.equal(report.scanned, 3);
    assert.deepEqual(report.diagnostics.filter(d => d.code === 'SOURCE_PARSE'), []);
    const project = await loadProject(root);
    assert.ok((await readArtifact(project, report.targets.find(t => t.source === 'src/App.vue')!.id)).variants.default.html.includes('Data'));
  });
});

test('init keeps its CSS inclusion policy while compilation retains entry import cascade order', async () => {
  await fixture({
    'index.html': '<script type="module" src="/src/main.tsx"></script>',
    'src/main.tsx': `import './z.css';import './a.css';import './query.css?theme';import './base.scss';import App from './App';`,
    'src/App.tsx': `import './page.css';export default function App(){return <main className="panel">Content</main>}`,
    'src/z.css': '.panel{height:10px}',
    'src/a.css': '.panel{height:20px}',
    'src/query.css': '.panel{height:30px}',
    'src/base.scss': '$height:40px;.panel{height:$height}',
    'src/page.css': '.panel{height:50px}',
  }, async root => {
    const report = await initProject(root);
    assert.equal(report.targets.length, 1);
    assert.deepEqual(report.targets[0].styles, ['src/a.css', 'src/page.css', 'src/z.css']);
    const artifact = await readArtifact(await loadProject(root), report.targets[0].id);
    const positions = [10, 20, 30, 40, 50].map(height => artifact.variants.default.css.search(new RegExp(`height:\\s*${height}px`)));
    assert.ok(positions.every(position => position >= 0), 'all entry styles and page styles remain included');
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'configuration sorting never reorders imported CSS');
    assert.deepEqual(artifact.diagnostics, []);
    assert.equal((await initProject(root)).changes.length, 0);
  });
});
