import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileTarget } from '../src/compiler/index.js';
import { checkProject, loadProject, readArtifact, saveHints, syncProject } from '../src/generator.js';
import type { SkeletonTarget } from '../src/types.js';

async function fixture(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skeleton-test-'));
  try {
    for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const target: SkeletonTarget = { id: 'test.list', source: 'View.tsx' };

test('React generation never executes business imports, top-level side effects, hooks or handlers', async () => {
  await fixture({ 'View.tsx': `import './explode'; globalThis.__skelcastExecuted = true; throw new Error('BUSINESS EXECUTED'); export default function View(){ const result = usePrivateAPI(); return <section className="grid"><h1>{result.title}</h1><img src={result.image}/><button onClick={()=>danger()}>Save</button></section> }`, 'explode.ts': `throw new Error('IMPORT EXECUTED')` }, async root => {
    const { artifact, dependencies } = await compileTarget(root, target);
    assert.match(artifact.variants.default.html, /class="grid"/);
    assert.match(artifact.variants.default.html, /data-sk-image/);
    assert.doesNotMatch(artifact.variants.default.html, /onClick|danger|result.title|Save/);
    assert.equal((globalThis as any).__skelcastExecuted, undefined);
    assert.ok(dependencies['explode.ts']);
  });
});
test('field consumption, aliases and cross-component props select finite layout variants', async () => {
  await fixture({ 'View.tsx': `import Card from './Card'; export default function View(){ const mode = data.mode; return <section>{data.items.map(item=><Card item={item} layout={mode}/>)}</section> }`, 'Card.tsx': `export default function Card({item,layout}) { const cls = layout === 'grid' ? 'grid-card' : 'list-card'; return <article className={cls}><h3>{item.title}</h3></article> }` }, async root => {
    const { artifact } = await compileTarget(root, { ...target, hints: { repeat: 3 }, variants: { grid: { bindings: { 'data.mode': 'grid' } }, list: { bindings: { 'data.mode': 'list' } } } });
    assert.equal((artifact.variants.grid.html.match(/<article/g) ?? []).length, 3);
    assert.match(artifact.variants.grid.html, /grid-card/);
    assert.match(artifact.variants.list.html, /list-card/);
    assert.ok(artifact.evidence.some(e => e.kind === 'repeat' && e.expression === 'data.items'));
    assert.ok(Object.values(artifact.sources).some(s => s.file === 'Card.tsx'));
  });
});
test('field bindings flow through object destructuring aliases', async () => {
  await fixture({ 'View.tsx': `export default function View(){ const { mode: display } = data; return <div className={display === 'grid' ? 'grid' : 'list'}/> }` }, async root => {
    const { artifact } = await compileTarget(root, { ...target, hints: { bindings: { 'data.mode': 'grid' } } });
    assert.match(artifact.variants.default.html, /class="grid"/);
  });
});
test('unknown third-party region falls back locally while preserving known columns', async () => {
  await fixture({ 'View.tsx': `import Chart from 'private-chart'; export default function View(){ return <main className="columns"><aside>Navigation</aside><Chart className="chart"/></main> }` }, async root => {
    const { artifact } = await compileTarget(root, target);
    assert.match(artifact.variants.default.html, /class="columns"/);
    assert.match(artifact.variants.default.html, /<aside/);
    assert.match(artifact.variants.default.html, /data-sk-fallback/);
    assert.match(artifact.variants.default.html, /class="chart"/);
    assert.ok(artifact.diagnostics.some(d => d.code === 'FALLBACK' && d.node));
  });
});
test('unknown layout chooses a static candidate or emits a visible local default', async () => {
  await fixture({ 'View.tsx': `export default ()=> <main><section className={data.mode === 'grid' ? 'grid' : 'list'}>Content</section><aside style={{height:data.height}}>Unknown dimensions</aside></main>` }, async root => {
    const { artifact } = await compileTarget(root, target);
    assert.match(artifact.variants.default.html, /class="grid"/);
    assert.match(artifact.variants.default.html, /data-sk-fallback/);
    assert.match(artifact.variants.default.html, /min-height:96px/);
    assert.ok(artifact.diagnostics.some(d => d.code === 'LAYOUT_UNKNOWN'));
  });
});
test('Vue static and dynamic classes combine, with a candidate for unknown layout conditions', async () => {
  await fixture({ 'View.vue': `<script setup></script><template><main class="base" :class="data.mode === 'grid' ? 'grid' : 'list'">Text</main></template>` }, async root => {
    const { artifact } = await compileTarget(root, { ...target, source: 'View.vue' });
    assert.match(artifact.variants.default.html, /class="base grid"/);
  });
});
test('CSS Modules and imported responsive CSS preserve layout and map classes', async () => {
  await fixture({ 'View.tsx': `import s from './view.module.css'; export default function View(){return <div className={s.grid}><span>Text</span></div>}`, 'view.module.css': `@import './tokens.css'; .grid{display:grid;grid-template-columns:repeat(3,1fr)} @media(max-width:600px){.grid{grid-template-columns:1fr}}`, 'tokens.css': `:root{--gap:12px}` }, async root => {
    const { artifact, dependencies } = await compileTarget(root, target);
    const view = artifact.variants.default;
    const className = view.html.match(/class="([^"]+)"/)?.[1];
    assert.ok(className && className !== 'grid');
    assert.ok(view.css.includes(`.${className}`));
    assert.match(view.css, /@media\s*\(max-width:600px\)/);
    assert.ok(dependencies['tokens.css']);
    assert.match(view.css, /\[data-sk-artifact="test.list"\]/);
  });
});
test('Vue handles scoped CSS, v-for, bindings and mutually exclusive branches without running setup', async () => {
  await fixture({ 'View.vue': `<script setup>throw new Error('setup must not run'); const data = usePrivateAPI()</script><template><main><article v-for="item in data.items" class="card"><h2>{{item.title}}</h2><div v-if="data.mode === 'grid'" class="grid-layout">Grid</div><div v-else class="list-layout">List</div></article></main></template><style scoped>.card{display:flex}@container (min-width:500px){.card{gap:24px}}</style>` }, async root => {
    const { artifact } = await compileTarget(root, { ...target, source: 'View.vue', hints: { repeat: 2 }, variants: { grid: { bindings: { 'data.mode': 'grid' } }, list: { bindings: { 'data.mode': 'list' } } } });
    assert.equal((artifact.variants.grid.html.match(/<article/g) ?? []).length, 2);
    assert.match(artifact.variants.grid.html, /grid-layout/);
    assert.doesNotMatch(artifact.variants.grid.html, /list-layout/);
    assert.match(artifact.variants.list.html, /list-layout/);
    assert.doesNotMatch(artifact.variants.list.html, /grid-layout/);
    assert.match(artifact.variants.grid.html, /data-v-sk-/);
    assert.match(artifact.variants.grid.css, /\.card\[data-v-sk-/);
    assert.match(artifact.variants.grid.css, /@container/);
  });
});
test('Vue follows local component props and includes external styles', async () => {
  await fixture({ 'View.vue': `<script setup>import Card from './Card.vue'</script><template><Card :mode="data.mode"/></template>`, 'Card.vue': `<script setup>defineProps(['mode'])</script><template><div :class="mode === 'grid' ? 'grid' : 'list'">{{title}}</div></template><style src="./card.css" scoped></style>`, 'card.css': `.grid{display:grid}.list{display:flex}` }, async root => {
    const { artifact, dependencies } = await compileTarget(root, { ...target, source: 'View.vue', hints: { bindings: { 'data.mode': 'list' } } });
    assert.match(artifact.variants.default.html, /class="list"/);
    assert.ok(dependencies['Card.vue']); assert.ok(dependencies['card.css']);
  });
});
test('Vue parent scoped styles attach only to a child root, not every descendant', async () => {
  await fixture({ 'View.vue': `<script setup>import Child from './Child.vue'</script><template><section><Child/></section></template><style scoped>section > .child{width:50%}</style>`, 'Child.vue': `<script setup></script><template><div class="child"><span class="inside">Text</span></div></template><style scoped>.inside{display:block}</style>` }, async root => {
    const { artifact } = await compileTarget(root, { ...target, source: 'View.vue' });
    const html = artifact.variants.default.html;
    const parentScope = html.match(/<section[^>]*(data-v-sk-[a-f0-9]+)/)?.[1];
    const childRoot = html.match(/<div[^>]*class="child"[^>]*>/)?.[0] ?? '';
    const inner = html.match(/<span[^>]*class="inside"[^>]*>/)?.[0] ?? '';
    assert.ok(parentScope); assert.ok(childRoot.includes(parentScope!)); assert.ok(!inner.includes(parentScope!));
  });
});
test('repeated generation is deterministic and CSS cascade follows source import order', async () => {
  await fixture({ 'View.tsx': `import Child from './Child'; import './parent.css'; export default ()=> <Child/>`, 'Child.tsx': `import './child.css'; export default ()=> <div className="card"/>`, 'parent.css': `.card{gap:20px}`, 'child.css': `.card{gap:10px}` }, async root => {
    const first = await compileTarget(root, target);
    const second = await compileTarget(root, target);
    assert.deepEqual(first.artifact, second.artifact);
    const css = first.artifact.variants.default.css;
    assert.ok(css.indexOf('gap:10px') < css.indexOf('gap:20px'));
  });
});
test('unknown calls and recursive components terminate with visible fallbacks', async () => {
  await fixture({ 'View.tsx': `export default function View(){ return <section>{renderServerLayout()}<Recursive/></section> } function Recursive(){return <Recursive/>}` }, async root => {
    const { artifact } = await compileTarget(root, target);
    assert.equal(artifact.diagnostics.filter(d => d.code === 'FALLBACK').length, 2);
    assert.match(artifact.variants.default.html, /min-height:96px/);
  });
});
test('source adapters replace opaque components and preserve React children', async () => {
  await fixture({ 'View.tsx': `import Chart from 'vendor'; function Panel({children}){return <section className="panel">{children}</section>} export default ()=> <Panel><Chart/></Panel>`, 'ChartSkeleton.tsx': `export default ()=> <div className="plot" style={{height:240}}/>` }, async root => {
    const { artifact, dependencies } = await compileTarget(root, { ...target, adapters: { Chart: 'ChartSkeleton.tsx' } });
    assert.match(artifact.variants.default.html, /class="panel"/);
    assert.match(artifact.variants.default.html, /class="plot"/);
    assert.match(artifact.variants.default.html, /height:240px/);
    assert.ok(dependencies['ChartSkeleton.tsx']);
    assert.equal(artifact.diagnostics.length, 0);
  });
});
test('Vue resolves default and named source slots', async () => {
  await fixture({ 'View.vue': `<script setup>import Panel from './Panel.vue'</script><template><Panel><template #header><h1>Title</h1></template><article>Body</article></Panel></template>`, 'Panel.vue': `<script setup></script><template><section><header><slot name="header"/></header><main><slot/></main></section></template>` }, async root => {
    const { artifact } = await compileTarget(root, { ...target, source: 'View.vue' });
    assert.match(artifact.variants.default.html, /<header[^>]*><h1/);
    assert.match(artifact.variants.default.html, /<main[^>]*><article/);
    assert.equal(artifact.diagnostics.filter(d => d.code === 'FALLBACK').length, 0);
  });
});

const config = `export default {targets:[{id:'one',source:'View.tsx'},{id:'two',source:'Other.tsx'}]}`;
test('incremental generation reuses bytes and mtimes; dependent styles invalidate only affected targets', async () => {
  await fixture({ 'skelcast.config.mjs': config, 'View.tsx': `import './view.css'; export default ()=> <main>One</main>`, 'Other.tsx': `export default ()=> <aside>Two</aside>`, 'view.css': `main{display:grid}` }, async root => {
    let project = await loadProject(root);
    const first = await syncProject(project);
    assert.ok(first.every(r => r.state === 'generated'));
    const before = await stat(path.join(root, '.skelcast/one.mjs'));
    const second = await syncProject(project);
    assert.ok(second.every(r => r.state === 'reused'));
    assert.equal((await stat(path.join(root, '.skelcast/one.mjs'))).mtimeMs, before.mtimeMs);
    await writeFile(path.join(root, 'view.css'), 'main{display:flex}');
    assert.deepEqual((await checkProject(project)).map(r => r.state), ['stale', 'ready']);
    assert.deepEqual((await syncProject(project)).map(r => r.state), ['generated', 'reused']);
    await saveHints(project, 'one', { repeat: 8 });
    project = await loadProject(root);
    assert.deepEqual((await checkProject(project)).map(r => r.state), ['stale', 'ready']);
  });
});
test('transitive non-render helpers invalidate artifacts without executing them', async () => {
  await fixture({ 'skelcast.config.mjs': `export default {targets:[{id:'one',source:'View.tsx'}]}`, 'View.tsx': `import {useData} from './hook'; export default ()=> <div>{useData().title}</div>`, 'hook.ts': `import './deep'; export function useData(){ throw 1 }`, 'deep.ts': `throw new Error('private')` }, async root => {
    const project = await loadProject(root); await syncProject(project);
    await writeFile(path.join(root, 'deep.ts'), 'throw new Error("changed")');
    assert.equal((await checkProject(project))[0].state, 'stale');
  });
});
test('artifact corruption is detected and sync regenerates it', async () => {
  await fixture({ 'skelcast.config.mjs': config, 'View.tsx': 'export default ()=> <div/>', 'Other.tsx': 'export default ()=> <div/>' }, async root => {
    const project = await loadProject(root); await syncProject(project);
    await writeFile(path.join(root, '.skelcast/one.mjs'), 'throw new Error("corrupt")');
    assert.equal((await checkProject(project))[0].state, 'corrupt');
    assert.equal((await syncProject(project))[0].state, 'generated');
    assert.equal((await readArtifact(project, 'one')).id, 'one');
  });
});
test('hints reject invalid sizes and cannot add a second layout tree', async () => {
  await fixture({ 'skelcast.config.mjs': config, 'View.tsx': 'export default ()=> <div/>', 'Other.tsx': 'export default ()=> <div/>' }, async root => {
    const project = await loadProject(root);
    await assert.rejects(saveHints(project, 'one', { repeat: 100 }), /between/);
    await assert.rejects(saveHints(project, 'one', { tree: [] } as any), /Unknown hint/);
    await assert.rejects(saveHints(project, '../../outside', { repeat: 2 }), /Unknown skeleton/);
  });
});
