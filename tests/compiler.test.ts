import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat, rm, symlink, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileTarget } from '../src/compiler/index.js';
import { checkProject, loadProject, readArtifact, saveHints, syncProject } from '../src/generator.js';
import type { SkeletonTarget } from '../src/types.js';
import { analyzeQuality, qualityProject } from '../src/quality.js';

async function fixture(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skeleton-test-'));
  try {
    for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const naiveDeclarations = `declare module 'vue' { interface GlobalComponents { ${['NInput','NIcon','NCard','NInputGroup','NInputGroupLabel','NTooltip','NConfigProvider','NCode','NGrid','NGi'].map(name => name + ": typeof import('naive-ui')['" + name + "']").join(';')} } }`;

const target: SkeletonTarget = { id: 'test.list', source: 'View.tsx' };

test('JSX and Vue keep explicit adapters ahead of local source and presets while forwarding children', async () => {
  await fixture({
    'Child.tsx': `export default({children})=><section className="source">{children}</section>`,
    'Adapter.tsx': `export default({children})=><article className="adapter">{children}</article>`,
    'Child.vue': `<template><section class="source"><slot/></section></template>`,
    'Adapter.vue': `<template><article class="adapter"><slot/></article></template>`,
    'View.tsx': `import Child from './Child';import{Button}from'antd';export default()=> <main><Child>Source child</Child><Button>Action</Button></main>`,
    'View.vue': `<script setup>import Child from './Child.vue';import{Button}from'antd'</script><template><main><Child>Source child</Child><Button>Action</Button></main></template>`,
  }, async root => {
    for (const source of ['View.tsx', 'View.vue']) {
      const options = { componentPresets: ['antd' as const] };
      const plain = await compileTarget(root, { ...target, source }, {}, options);
      assert.match(plain.artifact.variants.default.html, /<section class="source"/);
      assert.match(plain.artifact.variants.default.html, /<button/);
      const adapter = source.endsWith('.vue') ? 'Adapter.vue' : 'Adapter.tsx';
      const adapted = await compileTarget(root, { ...target, source, adapters: { Child: adapter, Button: adapter } }, {}, options);
      const html = adapted.artifact.variants.default.html;
      assert.equal((html.match(/<article class="adapter"/g) ?? []).length, 2);
      assert.doesNotMatch(html, /<section|<button/);
      assert.match(html, /Source child/);
      assert.match(html, /Action/);
      assert.deepEqual(adapted.artifact.diagnostics, []);
    }
  });
});

test('h component dispatch retains its existing source path when a JSX/template adapter is configured', async () => {
  await fixture({
    'Child.ts': `import { h } from 'vue';export default()=>h('section',{class:'source'},'Original')`,
    'Adapter.tsx': `export default()=> <article className="adapter">Adapter</article>`,
    'View.ts': `import { h } from 'vue';import Child from './Child';export default()=>h(Child)`,
  }, async root => {
    const plain = await compileTarget(root, { ...target, source: 'View.ts' });
    const configured = await compileTarget(root, { ...target, source: 'View.ts', adapters: { Child: 'Adapter.tsx' } });
    assert.deepEqual(configured, plain);
    assert.match(configured.artifact.variants.default.html, /<section class="source"/);
    assert.doesNotMatch(configured.artifact.variants.default.html, /class="adapter"/);
  });
});

test('Vue native tags retain declaration, configured, imported and adapter overrides in order', async () => {
  await fixture({
    'View.vue': `<template><main>Static</main><component is="main">Dynamic</component><input/></template>`,
    'Declared.vue': `<template><aside class="declared"><slot/></aside></template>`,
    'Configured.vue': `<template><nav class="configured"><slot/></nav></template>`,
    'Imported.vue': `<template><section class="imported"><slot/></section></template>`,
    'Adapter.vue': `<template><footer class="adapter"><slot/></footer></template>`,
  }, async root => {
    const nativeTarget = { ...target, source: 'View.vue' };
    const plain = await compileTarget(root, nativeTarget);
    assert.equal((plain.artifact.variants.default.html.match(/<main /g) ?? []).length, 2);
    assert.equal(plain.dependencies['components.d.ts'], '!missing');
    assert.equal(plain.dependencies['src/components.d.ts'], '!missing');

    await writeFile(path.join(root, 'components.d.ts'), `declare module 'vue' { interface GlobalComponents { Main: typeof import('./Declared.vue')['default'] } }`);
    const options = { components: { main: 'Configured.vue' } };
    const declared = await compileTarget(root, nativeTarget);
    const configured = await compileTarget(root, nativeTarget, {}, options);
    await writeFile(path.join(root, 'View.vue'), `<script setup>import Main from './Imported.vue'</script><template><main>Static</main><component is="main">Dynamic</component><input/></template>`);
    const imported = await compileTarget(root, nativeTarget, {}, options);
    const adapted = await compileTarget(root, { ...nativeTarget, adapters: { main: 'Adapter.vue' } }, {}, options);
    for (const [result, tag, name] of [[declared, 'aside', 'declared'], [configured, 'nav', 'configured'], [imported, 'section', 'imported'], [adapted, 'footer', 'adapter']] as const) {
      const html = result.artifact.variants.default.html;
      assert.equal((html.match(new RegExp(`<${tag} class="${name}"`, 'g')) ?? []).length, 2);
      assert.match(html, /Static/);
      assert.match(html, /Dynamic/);
      assert.match(html, /<input/);
      assert.deepEqual(result.artifact.diagnostics, []);
    }
  });
});

test('package symlink changes invalidate consumers even when the original package remains', async () => {
  const helper = `export function predicate(value){return typeof value==='function'}`;
  await fixture({
    'skelcast.config.mjs': `export default {targets:[{id:'types',source:'View.vue'}]}`,
    'View.vue': `<script setup>import {predicate} from '@fixture/checks';const label='Name'</script><template><div v-if="predicate(label)">Callable</div><p v-else>Literal</p></template>`,
    'node_modules/.store/first/package.json': JSON.stringify({ module: 'index.js', version: '1' }),
    'node_modules/.store/first/index.js': helper,
    'node_modules/.store/second/package.json': JSON.stringify({ module: 'index.js', version: '2' }),
    'node_modules/.store/second/index.js': helper,
  }, async root => {
    await mkdir(path.join(root, 'node_modules/@fixture'));
    const link = path.join(root, 'node_modules/@fixture/checks');
    await symlink(path.join(root, 'node_modules/.store/first'), link, 'dir');
    const project = await loadProject(root);
    await syncProject(project);
    assert.equal((await checkProject(project))[0].state, 'ready');
    const before = await readArtifact(project, 'types');
    assert.match(before.variants.default.html, /Literal/);
    await unlink(link);
    await symlink(path.join(root, 'node_modules/.store/second'), link, 'dir');
    assert.equal((await checkProject(project))[0].state, 'stale');
    await syncProject(project);
    assert.deepEqual(await readArtifact(project, 'types'), before);
    assert.equal((await checkProject(project))[0].state, 'ready');
  });
});

test('dynamic Vue tags retain native controls, source slots, spread order and component-scoped diagnostics', async () => {
  await fixture({
    'Child.vue': `<script setup>defineProps(['title'])</script><template><section><h2>{{title}}</h2><slot/><slot name="extra"/></section></template>`,
    'View.vue': `<script setup>import Child from './Child.vue'</script><template><component :is="tag" v-for="i in 2" v-bind="attrs" :class="'local'" title="Heading"><span>Default</span><template #extra><b>Extra</b></template></component></template>`,
    'Opaque.vue': `<template><component is="Child" v-bind="unknown"/></template>`,
    'Directive.vue': `<script setup>import Child from './Child.vue'</script><template><component is="Child" v-demo /></template>`,
    'Hidden.vue': `<template><component is="Child" v-bind="unknown" v-show="false"/></template>`,
    'Cycle.vue': `<template><component v-bind="{is:'component'}"/></template>`,
  }, async root => {
    const { artifact } = await compileTarget(root, {
      id: 'dynamic', source: 'View.vue', variants: Object.fromEntries(['button', 'input', 'Child'].map(tag => [tag, { bindings: { tag, attrs: { class: 'spread', 'data-layout': 'grid' } } }])),
    });
    assert.equal((artifact.variants.button.html.match(/<button /g) ?? []).length, 2);
    assert.match(artifact.variants.button.html, /class="spread local"/);
    assert.match(artifact.variants.button.html, /data-sk-control/);
    assert.equal((artifact.variants.input.html.match(/<input /g) ?? []).length, 2);
    const child = artifact.variants.Child.html;
    assert.equal((child.match(/<section /g) ?? []).length, 2);
    for (const text of ['Heading', 'Default', 'Extra']) assert.match(child, new RegExp(`data-sk-text-content="${text}"`));
    assert.deepEqual(artifact.diagnostics, []);
    const opaque = await compileTarget(root, { id: 'opaque', source: 'Opaque.vue' });
    assert.deepEqual(opaque.artifact.diagnostics.filter(d => d.code === 'SPREAD_UNKNOWN').map(d => d.component), ['Child']);
    const directive = await compileTarget(root, { id: 'directive', source: 'Directive.vue' });
    assert.deepEqual(directive.artifact.diagnostics.map(d => [d.code, d.component]), [['DIRECTIVE_UNKNOWN', 'Child']]);
    const hidden = await compileTarget(root, { id: 'hidden', source: 'Hidden.vue' });
    assert.deepEqual(hidden.artifact.diagnostics.map(d => d.code), ['SPREAD_UNKNOWN']);
    assert.doesNotMatch(hidden.artifact.variants.default.html, /data-sk-fallback/);
    const cycle = await compileTarget(root, { id: 'cycle', source: 'Cycle.vue' });
    assert.match(cycle.artifact.variants.default.html, /data-sk-fallback/);
    assert.deepEqual(cycle.artifact.diagnostics.map(d => d.code), ['SPREAD_UNKNOWN', 'FALLBACK']);
  });
});

test('known text keeps font-shaped layout, paragraphs and finite bindings while unknown text accepts local widths', async () => {
  await fixture({
    'View.tsx': `const title='Known & <text>';export default function View(){return <main><h1>{title}</h1><p>A paragraph with <strong>mixed</strong> content and 中文。</p><section data-sk-text-width="18ch">{unknown}</section><aside>{unknown}</aside><b>{0}</b></main>}`,
    'View.vue': `<script setup>const title='Known & <text>'</script><template><main><h1>{{title}}</h1><p>A paragraph with <strong>mixed</strong> content and 中文。</p><section data-sk-text-width="18ch">{{unknown}}</section><aside>{{unknown}}</aside><b v-text="0"/></main></template>`,
  }, async root => {
    for (const source of ['View.tsx', 'View.vue']) {
      const { artifact } = await compileTarget(root, { ...target, source });
      const { html } = artifact.variants.default;
      assert.match(html, /data-sk-measured data-sk-leaf data-sk-text-content="Known &amp; &lt;text&gt;"/);
      assert.match(html, /<strong[^>]*><span[^>]*data-sk-measured/);
      assert.match(html, /width:18ch;min-width:0/);
      assert.match(html, /data-sk-measured data-sk-leaf data-sk-text-content="0"/);
      assert.doesNotMatch(html, /data-sk-text-width=/);
      assert.deepEqual(artifact.diagnostics, []);
      const explicit = await compileTarget(root, { ...target, source, hints: { lines: 3 } });
      assert.match(explicit.artifact.variants.default.html, /<p[^>]*><span[^>]*data-sk-multiline/);
    }
  });
});

test('images preserve explicit, CSS and local intrinsic dimensions and track local asset changes', async () => {
  await fixture({
    'photo.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80"/>',
    'View.tsx': `import photo from './photo.svg';export default function View(){return <main><img src={photo}/><img src="./photo.svg" width="20" height="10"/><img src="https://never-fetch.invalid/image" data-sk-image-ratio="16 / 9" style={{width:160,height:'auto'}}/><img src="./photo.svg" style={{aspectRatio:2}}/></main>}`,
    'View.vue': `<template><main><img src="./photo.svg"/><img src="./photo.svg" width="20" height="10"/><img src="https://never-fetch.invalid/image" data-sk-image-ratio="16 / 9" style="width:160px;height:auto"/><img src="./photo.svg" style="aspect-ratio:2"/></main></template>`,
  }, async root => {
    for (const source of ['View.tsx', 'View.vue']) {
      const first = await compileTarget(root, { ...target, source });
      assert.match(first.artifact.variants.default.html, /width=%27240%27 height=%2780%27/);
      assert.match(first.artifact.variants.default.html, /width="20" height="10"/);
      assert.match(first.artifact.variants.default.html, /aspect-ratio:1\.777/);
      assert.match(first.artifact.variants.default.html, /aspect-ratio:2/);
      assert.doesNotMatch(first.artifact.variants.default.html, /never-fetch|data-sk-image-ratio=/);
      assert.ok(first.dependencies['photo.svg']);
      assert.deepEqual(first.artifact.diagnostics, []);
    }
    const first = await compileTarget(root, target);
    await writeFile(path.join(root, 'photo.svg'), '<svg viewBox="0 0 100 200"/>');
    const changed = await compileTarget(root, target);
    assert.notEqual(first.dependencies['photo.svg'], changed.dependencies['photo.svg']);
    assert.match(changed.artifact.variants.default.html, /width=%27100%27 height=%27200%27/);
  });
});

test('React and Vue retain static layout attributes and map source IDs without copying internal metadata', async () => {
  await fixture({
    'View.tsx': `import './layout.css';export default function View(){return <section id="catalog:main" data-layout="grid" data-note={'a"<&'} dir="rtl" lang="ar" data-sk-boundary="forged" onClick={runBusiness}><span>Title</span></section>}`,
    'View.vue': `<template><section id="catalog:main" data-layout="grid" data-note="a&quot;&lt;&amp;" dir="rtl" lang="ar" data-sk-boundary="forged" @click="runBusiness"><span>Title</span></section></template><style src="./layout.css"></style>`,
    'layout.css': `#catalog\\:main[data-layout="grid"] { display:grid } [id^="catalog"] { width:600px } :is(#other, [data-layout="grid"]) { gap:12px }`,
  }, async root => {
    for (const source of ['View.tsx', 'View.vue']) {
      const { artifact } = await compileTarget(root, { ...target, source });
      const { html, css } = artifact.variants.default;
      assert.match(html, /data-sk-source-id="catalog:main"/);
      assert.match(html, /data-layout="grid"/);
      assert.match(html, /data-note="a&quot;&lt;&amp;"/);
      assert.match(html, /dir="rtl" lang="ar"/);
      assert.doesNotMatch(html, /\sid=|forged|onClick|runBusiness/);
      assert.match(css, /data-sk-source-id="catalog:main"/);
      assert.match(css, /data-sk-source-id\^="catalog"/);
      assert.deepEqual(artifact.diagnostics, []);
      assert.equal(analyzeQuality(artifact).needsReview, false);
    }
  });
});

test('unresolved layout attributes require review instead of silently dropping selector inputs', async () => {
  await fixture({
    'View.tsx': `export default function View(){return <section id={state.id} data-layout={state.layout}><span>Title</span></section>}`,
    'View.vue': `<template><section :id="state.id" :data-layout="state.layout"><span>Title</span></section></template>`,
  }, async root => {
    for (const source of ['View.tsx', 'View.vue']) {
      const { artifact } = await compileTarget(root, { ...target, source });
      assert.equal(artifact.diagnostics.filter(d => d.code === 'LAYOUT_ATTRIBUTE_UNKNOWN').length, 2);
      assert.equal(analyzeQuality(artifact).needsReview, true);
      const resolved = await compileTarget(root, { ...target, source, hints: { bindings: { 'state.id': 'catalog', 'state.layout': 'grid' } } });
      assert.deepEqual(resolved.artifact.diagnostics, []);
      assert.match(resolved.artifact.variants.default.html, /data-sk-source-id="catalog" data-layout="grid"/);
    }
  });
});

test('Vue fallthrough replaces mapped root IDs and data attributes without duplicates', async () => {
  await fixture({
    'View.vue': `<script setup>import Card from './Card.vue'</script><template><Card id="outer" data-layout="grid"/></template>`,
    'Card.vue': `<template><template v-if="true"><section id="inner" data-layout="list">Card</section></template></template>`,
  }, async root => {
    const { artifact } = await compileTarget(root, { ...target, source: 'View.vue' });
    const html = artifact.variants.default.html;
    assert.equal((html.match(/data-sk-source-id=/g) ?? []).length, 1);
    assert.equal((html.match(/data-layout=/g) ?? []).length, 1);
    assert.match(html, /data-sk-source-id="outer" data-layout="grid"/);
    assert.deepEqual(artifact.diagnostics, []);
  });
});

test('saved bindings replace and clear the effective shared bindings while omitted bindings are retained', async () => {
  await fixture({
    'View.tsx': `const mode='grid';export default function View(){return <main className={mode}><span>Title</span></main>}`,
    'skelcast.config.mjs': `export default { targets: [{ id:'one', source:'View.tsx', hints:{lines:2,bindings:{mode:'list',extra:true}} }] }`,
  }, async root => {
    let project = await loadProject(root);
    await syncProject(project);
    await saveHints(project, 'one', { bindings: { mode: 'compact' } });
    project = await loadProject(root);
    assert.deepEqual(project.config.targets[0].hints, { lines: 2, bindings: { mode: 'compact' } });
    assert.equal((await checkProject(project))[0].state, 'stale');
    await syncProject(project);
    assert.match((await readArtifact(project, 'one')).variants.default.html, /class="compact"/);
    await saveHints(project, 'one', { repeat: 3 });
    project = await loadProject(root);
    assert.deepEqual(project.config.targets[0].hints?.bindings, { mode: 'compact' });
    await saveHints(project, 'one', { bindings: {} });
    project = await loadProject(root);
    assert.deepEqual(project.config.targets[0].hints, { lines: 2, repeat: 3, bindings: {} });
    await syncProject(project);
    assert.match((await readArtifact(project, 'one')).variants.default.html, /class="grid"/);
    assert.equal((await checkProject(project))[0].state, 'ready');
  });
});

test('React and Vue agree on empty, known, unknown and explicitly predicted list lengths', async () => {
  for (const [list, expected] of [['[]', 0], ['[1,2]', 2], [`[${Array.from({ length: 30 }, (_, i) => i).join(',')}]`, 24], ['fetchItems()', 4]] as const) {
    await fixture({
      'View.tsx': `const items=${list};export default function View(){return <ul>{items.map(item=><li>{item}</li>)}</ul>}`,
      'View.vue': `<script setup>const items=${list}</script><template><ul><li v-for="item in items">{{item}}</li></ul></template>`,
    }, async root => {
      for (const source of ['View.tsx', 'View.vue']) {
        const { artifact } = await compileTarget(root, { ...target, source });
        assert.equal((artifact.variants.default.html.match(/<li\b/g) ?? []).length, expected, `${source}: ${list}`);
        const predicted = await compileTarget(root, { ...target, source, hints: { repeat: 3 } });
        assert.equal((predicted.artifact.variants.default.html.match(/<li\b/g) ?? []).length, 3, `${source}: explicit repeat`);
      }
    });
  }
});

test('Vue fallthrough attrs reach component/native roots before classifying read-only output', async () => {
  await fixture({
    'View.vue': `<script setup>import Wrapper from './Wrapper.vue';import Native from './Native.vue'</script><template><Wrapper readonly class="outer"/><Native readonly/><Wrapper/></template>`,
    'Wrapper.vue': `<script setup>import Native from './Native.vue';const props=defineProps<{value?:string}>()</script><template><Native class="inner"/></template>`,
    'Native.vue': `<script setup>const props=defineProps<{value?:string}>()</script><template><input class="field" :value="props.value"></template>`,
  }, async root => {
    const {artifact}=await compileTarget(root,{...target,source:'View.vue'});
    const inputs=artifact.variants.default.html.match(/<input[^>]+>/g)??[];
    assert.equal(inputs.length,3);
    assert.match(inputs[0],/readonly/);assert.match(inputs[0],/data-sk-leaf/);assert.match(inputs[0],/class="field inner outer"/);
    assert.match(inputs[1],/readonly/);assert.match(inputs[1],/data-sk-leaf/);
    assert.doesNotMatch(inputs[2],/readonly|data-sk-leaf/);
  });
});

test('Vue absent props, slots and model aliases select the source branch while opaque values stay diagnosed', async () => {
  await fixture({
    'View.vue': `<script setup>import Field from './Field.vue';const blank=ref();const text=ref('ready')</script><template><Field v-model:value="blank"/><Field title="Title" v-model:value="text"/><Field :title="remoteTitle"/></template>`,
    'Field.vue': `<script setup>const props=defineProps<{title?:string;value?:string;clearable?:boolean}>();const {title,clearable}=toRefs(props);const value=useVModel(props,'value')</script><template><section><header v-if="title">Title</header><button v-if="clearable && value">Clear</button><footer v-if="$slots.footer"><slot name="footer"/></footer><p v-if="value">Filled</p><input v-else></section></template>`,
  }, async root => {
    const { artifact } = await compileTarget(root, { ...target, source: 'View.vue' });
    const html = artifact.variants.default.html;
    assert.equal((html.match(/<header/g) ?? []).length, 2);
    assert.equal((html.match(/<input/g) ?? []).length, 2);
    assert.equal((html.match(/<p /g) ?? []).length, 1);
    assert.doesNotMatch(html, /<button|<footer/);
    assert.equal(artifact.diagnostics.filter(d => d.code === 'BRANCH_DEFAULT').length, 1);
  });
});

test('Vue destructured loops retain object keys and index, preserve empty lists and use literal default factories', async () => {
  await fixture({
    'View.vue': `<script setup>const props=withDefaults(defineProps<{rows?:unknown[]}>(),{rows:()=>[{kind:'input'},{kind:'textarea'}]});const {rows}=toRefs(props);const groups={first:{kind:'input'},second:{kind:'textarea'}};</script><template><section v-for="({kind},index) in rows"><input v-if="kind === 'input'"><textarea v-else/></section><article v-for="({kind},key,index) of groups"><input v-if="key === 'first' && index === 0"><textarea v-else/></article><div v-for="entry in []">Empty</div></template>`,
  }, async root => {
    const { artifact } = await compileTarget(root, { ...target, source: 'View.vue' });
    const html = artifact.variants.default.html;
    assert.equal((html.match(/<section/g) ?? []).length, 2);
    assert.equal((html.match(/<article/g) ?? []).length, 2);
    assert.equal((html.match(/<input/g) ?? []).length, 2);
    assert.equal((html.match(/<textarea/g) ?? []).length, 2);
    assert.doesNotMatch(html, /<div data-sk-node/);
    assert.deepEqual(artifact.diagnostics, []);
  });
});

test('bounded static HTML becomes inert semantic placeholders and unknown HTML stays local', async () => {
  await fixture({
    'View.vue': `<script setup>const html='<h1 onclick="privateCall()">Welcome</h1><p>Body</p><scr' + 'ipt>throw new Error("never run")</scr' + 'ipt><img src="https://private.invalid/tracker"><div v-if="privateCall()">Literal HTML</div>'</script><template><article class="rich" v-html="html"/><aside v-html="privateHtml"/><label v-text="privateText"/></template>`,
  }, async root => {
    const { artifact } = await compileTarget(root, { ...target, source: 'View.vue' });
    const html = artifact.variants.default.html;
    assert.match(html, /<h1/); assert.match(html, /<p /); assert.match(html, /<label[^>]*><span/);
    assert.doesNotMatch(html, /onclick|privateCall|private.invalid|<script|Welcome|Literal HTML/);
    assert.equal(artifact.diagnostics.filter(d => d.code === 'FALLBACK').length, 1);
    assert.equal(artifact.diagnostics.filter(d => d.code === 'BRANCH_DEFAULT').length, 0);
  });
});

test('empty native mount hosts retain source dimensions as opaque boxes without widget-specific trees', async () => {
  await fixture({
    'View.vue': `<script setup>const host=ref(null);throw new Error('never run')</script><template><div ref="host" style="height:600px;width:100%"/><input ref="field"/><div ref="populated"><p>Content</p></div></template>`,
  }, async root => {
    const {artifact}=await compileTarget(root,{...target,source:'View.vue'});
    assert.equal((artifact.variants.default.html.match(/data-sk-opaque/g)??[]).length,1);
    assert.match(artifact.variants.default.html,/height:600px;width:100%/);
    assert.equal(artifact.diagnostics.filter(d=>d.code==='FALLBACK').length,1);
    assert.equal(analyzeQuality(artifact).variants.default.fallbacks,1);
  });
});

test('library presets require package identity, preserve aliases/namespaces and remain opt-in', async () => {
  await fixture({
    'View.vue': `<script setup>import { NInput as Field } from 'naive-ui';import * as UI from 'naive-ui';import { NInput as Other } from 'other-library';import NCard from './Local.vue';import type {NButton} from 'naive-ui'</script><template><Field/><UI.NInput/><Other/><NCard/><n-input/><NButton/></template>`,
    'Local.vue': `<template><article>Local card</article></template>`,
    'Declared.vue': `<template><RenamedControl/><n-input/></template>`,
    'components.d.ts': `declare module 'vue' {interface GlobalComponents {RenamedControl:typeof import('naive-ui')['NInput']}}`,
  }, async root => {
    const {artifact}=await compileTarget(root,{...target,source:'View.vue'},{},{componentPresets:['naive-ui']});
    const html=artifact.variants.default.html;
    assert.equal((html.match(/height:34px/g)??[]).length,2);
    assert.match(html,/<article/);
    assert.equal(artifact.diagnostics.filter(d=>d.code==='FALLBACK').length,3);
    assert.ok(artifact.evidence.some(e=>e.decision.includes('naive-ui::NInput')));
    const declared=await compileTarget(root,{...target,source:'Declared.vue'},{},{componentPresets:['naive-ui']});
    assert.equal(declared.artifact.diagnostics.filter(d=>d.code==='FALLBACK').length,1);
    assert.equal((declared.artifact.variants.default.html.match(/height:34px/g)??[]).length,1);
    const disabled=await compileTarget(root,{...target,source:'Declared.vue'});
    assert.equal(disabled.artifact.diagnostics.filter(d=>d.code==='FALLBACK').length,2);
    const adapted=await compileTarget(root,{...target,source:'View.vue'},{},{componentPresets:['naive-ui'],components:{Other:'Local.vue',NCard:'Local.vue'}});
    assert.equal((adapted.artifact.variants.default.html.match(/<article/g)??[]).length,2);
    assert.equal(adapted.artifact.diagnostics.filter(d=>d.code==='FALLBACK').length,2);
  });
});

test('Naive providers preserve code lines, imported controls and numeric-string grid geometry', async () => {
  await fixture({
    'components.d.ts': naiveDeclarations,
    'View.vue': `<script setup>import {NInputNumber} from 'naive-ui';const code='line one\\nline two'</script><template><n-config-provider><n-grid cols="4" x-gap="12"><n-gi span="2"><NInputNumber/></n-gi><n-gi span="2"><n-code :code="code"/></n-gi></n-grid></n-config-provider></template>`,
  }, async root => {
    const { artifact } = await compileTarget(root, { ...target, source: 'View.vue' }, {}, { componentPresets: ['naive-ui'] });
    assert.deepEqual(artifact.diagnostics, []);
    assert.match(artifact.variants.default.html, /grid-template-columns:repeat\(4/);
    assert.match(artifact.variants.default.html, /grid-column:span 2/);
    assert.equal((artifact.variants.default.html.match(/data-sk-code-line/g) ?? []).length, 2);
  });
});

test('finite dynamic components use explicit source mappings and unknown selections retain diagnostics', async () => {
  await fixture({
    'View.vue': `<script setup>const tag='StatusIcon'</script><template><component :is="tag" class="icon"/><component :is="privateComponent"/></template>`,
    'Icon.vue': `<template><img style="width:1em;height:1em"></template>`,
  }, async root => {
    const { artifact } = await compileTarget(root, { ...target, source: 'View.vue' }, {}, { components: {StatusIcon:'Icon.vue'} });
    assert.match(artifact.variants.default.html, /<img[^>]*class="icon"/);
    assert.equal(artifact.diagnostics.filter(d => d.code === 'FALLBACK').length, 1);
  });
});

test('bounded collection callbacks retain option branches and reject opaque calls or runaway work', async () => {
  await fixture({
    'View.vue': `<script setup>const raw=ref(['first',{label:'second',value:'two'}]);const options=computed(()=>{return raw.value.map(option=>{if(typeof option === 'string')return {label:option,value:option};return option})});const selected=computed(()=>options.value.find(option=>option.value==='two'));</script><template><p v-if="selected">Selected</p><input v-else><article v-for="[key,value] in Object.entries({a:1,b:2})">{{key}}</article><div v-if="privateCall()">Unknown</div></template>`,
    'Work.vue': `<script setup>const result=seed.map(a=>seed.map(b=>a+b))</script><template><span v-if="result">Budget</span></template>`,
    'Unsafe.vue': `<script setup>const values=[1,2].map(item=>{privateCall();return item});const large=ref(Array(500));</script><template><i v-for="v in values">Opaque</i><span v-if="large">Unknown</span></template>`,
  }, async root => {
    const { artifact } = await compileTarget(root, { ...target, source: 'View.vue' });
    assert.match(artifact.variants.default.html, /<p /); assert.doesNotMatch(artifact.variants.default.html, /<input/);
    assert.equal((artifact.variants.default.html.match(/<article/g) ?? []).length, 2);
    assert.equal(artifact.diagnostics.filter(d=>d.code==='BRANCH_DEFAULT').length, 1);
    const unsafe=await compileTarget(root,{...target,source:'Unsafe.vue'});
    assert.ok(unsafe.artifact.diagnostics.some(d=>d.code==='BRANCH_DEFAULT'));
    assert.ok(unsafe.artifact.evidence.some(e=>e.kind==='repeat'&&e.decision.includes('2 placeholders')));
    const work=await compileTarget(root,{...target,source:'Work.vue',hints:{bindings:{seed:Array.from({length:256},(_,i)=>i)}}});
    assert.ok(work.artifact.diagnostics.some(d=>d.code==='BRANCH_DEFAULT'));
  });
});

test('Object.keys infers static list lengths without invoking imported namespaces', async () => {
  await fixture({
    'View.vue': `<script setup>const names=Object.keys({first:privateValue,second:otherValue})</script><template><span v-for="name in names">{{name}}</span></template>`,
    'Shadow.vue': `<script setup>import Object from './private';const names=Object.keys({first:1,second:2})</script><template><span v-for="name in names">{{name}}</span></template>`,
    'private.ts': `throw new Error('never import business code');export default privateObject`,
  }, async root => {
    const known = await compileTarget(root, { ...target, source: 'View.vue' });
    const shadow = await compileTarget(root, { ...target, source: 'Shadow.vue' });
    assert.equal((known.artifact.variants.default.html.match(/data-sk-leaf/g) ?? []).length, 2);
    assert.equal((shadow.artifact.variants.default.html.match(/data-sk-leaf/g) ?? []).length, 4);
  });
});

test('Vue CSS bindings resolve per instance, after prop aliases and computed wrappers, without running hooks', async () => {
  await fixture({
    'View.vue': `<script setup>import Card from './Card.vue'</script><template><Card :padding="12"/><Card :padding="28"/></template>`,
    'Card.vue': `<script setup>const props=withDefaults(defineProps<{padding?:number}>(),{padding:8});const {padding:space}=toRefs(props);const theme=usePrivateTheme();const pad=computed(()=>space.value+'px');throw new Error('never run')</script><template><article class="card"><input></article></template><style scoped>/* v-bind(notAValue) */ .card{padding:v-bind(pad);border:1px solid v-bind('theme.border')}</style>`,
  }, async root => {
    const { artifact } = await compileTarget(root, { ...target, source: 'View.vue' }, {}, { componentBindings: { 'Card.vue': { theme: { border: '#123456' } } } });
    const view = artifact.variants.default;
    assert.match(view.html, /--sk-bind-[\w]+:12px/); assert.match(view.html, /--sk-bind-[\w]+:28px/);
    assert.match(view.html, /--sk-bind-[\w]+:#123456/); assert.match(view.css, /padding:var\(--sk-bind-/);
    assert.equal(artifact.diagnostics.filter(row => row.code === 'STYLE_BINDING').length, 0);
  });
});

test('unresolved CSS bindings stay diagnosed and scoped variant bindings override only their component', async () => {
  await fixture({
    'View.vue': `<script setup>import Card from './Card.vue'</script><template><Card/></template>`,
    'Card.vue': `<script setup>const theme=privateTheme()</script><template><div>Body</div></template><style>div{background:v-bind('theme.bg');height:v-bind(missingHeight)}</style>`,
  }, async root => {
    const { artifact } = await compileTarget(root, { ...target, source: 'View.vue', variants: { light: {}, dark: { bindings: { 'Card.vue::theme': { bg: '#111' } } } } }, {}, { componentBindings: { 'Card.vue': { theme: { bg: '#fff' } } } });
    assert.match(artifact.variants.light.html, /:#fff/); assert.match(artifact.variants.dark.html, /:#111/);
    assert.ok(artifact.diagnostics.some(row => row.code === 'STYLE_BINDING' && row.message.includes('missingHeight')));
    assert.ok(!artifact.diagnostics.some(row => row.message.includes('v-bind(theme.bg)')));
  });
});

test('kebab props and v-bind objects keep label geometry through local component wrappers', async () => {
  await fixture({
    'View.vue': `<script setup>import Wrapper from './Wrapper.vue'</script><template><Wrapper label-width="100px"/></template>`,
    'Wrapper.vue': `<script setup>import Label from './Label.vue';const props=defineProps<{labelWidth:string}>()</script><template><Label v-bind="props"/></template>`,
    'Label.vue': `<script setup>const props=withDefaults(defineProps<{labelWidth?:string}>(),{labelWidth:'auto'});const {labelWidth}=toRefs(props)</script><template><label>Name</label></template><style>label{width:v-bind(labelWidth)}</style>`,
  }, async root => {
    const { artifact } = await compileTarget(root, { ...target, source: 'View.vue' });
    assert.match(artifact.variants.default.html, /--sk-bind-[\w]+:100px/);
    assert.equal(artifact.diagnostics.length, 0);
  });
});

test('Vue DOM parsing accepts native void elements and makes opaque kebab components visible', async () => {
  await fixture({ 'View.vue': `<script setup>throw new Error('never execute')</script><template><main><input size="1"><br><vendor-widget/><n-input/></main></template>` }, async root => {
    const { artifact } = await compileTarget(root, { ...target, source: 'View.vue' });
    assert.match(artifact.variants.default.html, /<input[^>]*data-sk-control/);
    assert.match(artifact.variants.default.html, /<input size="1"/);
    assert.equal(artifact.diagnostics.filter(d => d.code === 'FALLBACK').length, 2);
    assert.doesNotMatch(artifact.variants.default.html, /<vendor-widget|<n-input/);
  });
});

test('GlobalComponents declarations expand local source, apply defaults and forward root layout attributes', async () => {
  await fixture({
    'View.vue': `<script setup>throw new Error('never execute')</script><template><c-card class="outer" style="margin:12px" flex items-center><c-field label="Name"/></c-card></template>`,
    'components.d.ts': `declare module '@vue/runtime-core' { interface GlobalComponents { CCard: typeof import('./Card.vue')['default']; CField: typeof import('./Field.vue')['default']; External: typeof import('private-vendor')['Widget'] } }`,
    'Card.vue': `<script setup>throw new Error('never execute')</script><template><section class="card" style="padding:20px" flex><slot/></section></template>`,
    'Field.vue': `<script setup>const props = withDefaults(defineProps<{multiline?:boolean,label?:string}>(), {multiline:false}); const {multiline,label} = toRefs(props); throw new Error('never execute')</script><template><div><label>{{label}}</label><textarea v-if="multiline"/><input v-else></div></template>`,
  }, async root => {
    const { artifact, dependencies } = await compileTarget(root, { ...target, source: 'View.vue' }, {}, { styles: { unocss: true } });
    const view = artifact.variants.default;
    assert.match(view.html, /class="card outer"/);
    assert.match(view.html, /style="padding:20px;margin:12px"/);
    assert.match(view.html, /flex=""/); assert.match(view.html, /items-center=""/);
    assert.match(view.html, /<input/); assert.doesNotMatch(view.html, /<textarea|<c-card|<c-field/);
    assert.ok(dependencies['components.d.ts']); assert.ok(dependencies['Field.vue']);
    assert.equal(artifact.diagnostics.length, 0);
  });
});

test('component declaration creation and edits invalidate only consumers, and explicit mappings take precedence', async () => {
  await fixture({
    'skelcast.config.mjs': `export default {targets:[{id:'one',source:'View.vue'},{id:'two',source:'Other.tsx'}]}`,
    'View.vue': `<script setup></script><template><auto-card/></template>`,
    'Other.tsx': `export default ()=> <div>Other</div>`,
    'Card.vue': `<script setup></script><template><article>Card</article></template>`,
    'Override.vue': `<script setup></script><template><aside>Override</aside></template>`,
  }, async root => {
    let project = await loadProject(root); await syncProject(project);
    assert.ok((await checkProject(project)).every(row => row.state === 'ready'));
    await writeFile(path.join(root, 'components.d.ts'), `declare module 'vue' { interface GlobalComponents { AutoCard: typeof import('./Card.vue')['default'] } }`);
    assert.deepEqual((await checkProject(project)).map(row => row.state), ['stale', 'ready']);
    await syncProject(project);
    assert.match((await readArtifact(project, 'one')).variants.default.html, /<article/);
    await writeFile(path.join(root, 'skelcast.config.mjs'), `export default {components:{'auto-card':'Override.vue'},targets:[{id:'one',source:'View.vue'}]}`);
    project = await loadProject(root); assert.equal((await checkProject(project))[0].state, 'stale');
    await syncProject(project); assert.match((await readArtifact(project, 'one')).variants.default.html, /<aside/);
  });
});

test('Less compiles before scoped CSS and imported variables invalidate generated artifacts', async () => {
  await fixture({
    'skelcast.config.mjs': `export default {styles:{less:true},targets:[{id:'one',source:'View.vue'}]}`,
    'View.vue': `<script setup></script><template><div class="card"><span>Text</span></div></template><style lang="less" scoped>@import './tokens.less'; .card { padding:@gap; & > span { display:block; } }</style>`,
    'tokens.less': `@gap:24px;`,
  }, async root => {
    const project = await loadProject(root); await syncProject(project);
    const view = (await readArtifact(project, 'one')).variants.default;
    assert.match(view.css, /padding:\s*24px/); assert.match(view.css, /\.card\[data-v-sk-/);
    await writeFile(path.join(root, 'tokens.less'), '@gap:12px;');
    assert.equal((await checkProject(project))[0].state, 'stale');
  });
});

test('Less cannot execute inline JavaScript or @plugin code', async () => {
  await fixture({
    'View.vue': `<script setup></script><template><div>Text</div></template><style lang="less">@plugin './plugin.js';</style>`,
    'plugin.js': `globalThis.__lessBusinessExecuted=true;module.exports={install(){}};`,
  }, async root => {
    await assert.rejects(compileTarget(root, { ...target, source: 'View.vue' }, {}, { styles: { less: true } }));
    assert.equal((globalThis as any).__lessBusinessExecuted, undefined);
    await writeFile(path.join(root, 'View.vue'), '<template><div/></template><style lang="less">.x{width:`1+1`}</style>');
    await assert.rejects(compileTarget(root, { ...target, source: 'View.vue' }, {}, { styles: { less: true } }));
  });
});

test('UnoCSS preserves attributify layout without executing application configuration', async () => {
  await fixture({ 'View.vue': `<script setup></script><template><main class="grid grid-cols-1 md:grid-cols-4 panel"><div flex items-center gap-8px @click="danger" :title="secret"><input></div></main></template>`, 'unocss.config.ts': `globalThis.__unoBusinessExecuted=true;throw new Error('never execute application config')` }, async root => {
    const { artifact } = await compileTarget(root, { ...target, source: 'View.vue' }, {}, { styles: { unocss: { shortcuts: { panel: 'p-24px' }, theme: { colors: { primary: '#1ea54c' } } } } });
    const view = artifact.variants.default;
    assert.match(view.html, /items-center=""/); assert.match(view.html, /gap-8px=""/);
    assert.doesNotMatch(view.html, /danger|secret|@click/);
    assert.match(view.css, /display:\s*flex/); assert.match(view.css, /align-items:\s*center/);
    assert.match(view.css, /padding:\s*24px/); assert.match(view.css, /@media/);
    assert.match(view.css, /repeat\(4/);
    assert.equal((globalThis as any).__unoBusinessExecuted, undefined);
  });
});

test('opt-in Naive UI adapters preserve container children and bound opaque controls', async () => {
  await fixture({ 'components.d.ts': naiveDeclarations, 'View.vue': `<script setup></script><template><n-card><n-input-group><n-input-group-label>Label</n-input-group-label><n-input/></n-input-group><n-icon :size="40"/></n-card></template>` }, async root => {
    const { artifact } = await compileTarget(root, { ...target, source: 'View.vue' }, {}, { componentPresets: ['naive-ui'] });
    assert.doesNotMatch(artifact.variants.default.html, /<n-/);
    assert.match(artifact.variants.default.html, /display:flex/);
    assert.match(artifact.variants.default.html, /height:34px/);
    assert.match(artifact.variants.default.html, /width:40px;height:40px/);
    assert.equal(artifact.diagnostics.length, 0);
    assert.ok(artifact.evidence.some(row => row.decision.includes('naive-ui')));
  });
});

test('Naive UI card header and tooltip trigger slots preserve visible presentation', async () => {
  await fixture({ 'components.d.ts': naiveDeclarations, 'View.vue': `<script setup></script><template><n-card><template #header><h1>Header</h1></template><n-tooltip><template #trigger><button>Trigger</button></template><strong>Popup</strong></n-tooltip></n-card></template>` }, async root => {
    const { artifact } = await compileTarget(root, { ...target, source: 'View.vue' }, {}, { componentPresets: ['naive-ui'] });
    assert.match(artifact.variants.default.html, /<h1/); assert.match(artifact.variants.default.html, /<button/);
    assert.doesNotMatch(artifact.variants.default.html, /<strong/);
    assert.equal(artifact.diagnostics.length, 0);
  });
});

test('quality distinguishes freshness from empty output, unresolved tags and fallback regions', async () => {
  await fixture({
    'skelcast.config.mjs': `export default {targets:[{id:'empty',source:'Empty.tsx'},{id:'opaque',source:'View.vue'}]}`,
    'Empty.tsx': 'export default ()=> <div/>',
    'View.vue': '<script setup></script><template><vendor-control/></template>',
  }, async root => {
    const project = await loadProject(root); await syncProject(project);
    assert.ok((await checkProject(project)).every(row => row.state === 'ready'));
    const quality = await qualityProject(project);
    assert.ok(quality.every(row => row.needsReview));
    assert.match(JSON.stringify(quality), /EMPTY_SKELETON|FALLBACK_REGIONS/);
    const artifact = await readArtifact(project, 'opaque'); artifact.variants.default.html = '<vendor-control/>';
    assert.deepEqual(analyzeQuality(artifact).variants.default.unresolvedComponents, ['vendor-control']);
  });
});

test('React generation never executes business imports, top-level side effects, hooks or handlers', async () => {
  await fixture({ 'View.tsx': `import './explode'; globalThis.__skelcastExecuted = true; throw new Error('BUSINESS EXECUTED'); export default function View(){ const result = usePrivateAPI(); return <section className="grid"><h1>{result.title}</h1><img src={result.image}/><button onClick={()=>danger()}>Save</button></section> }`, 'explode.ts': `throw new Error('IMPORT EXECUTED')` }, async root => {
    const { artifact, dependencies } = await compileTarget(root, target);
    assert.match(artifact.variants.default.html, /class="grid"/);
    assert.match(artifact.variants.default.html, /data-sk-image/);
    assert.doesNotMatch(artifact.variants.default.html, /onClick|danger|result.title/);
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

for (const [source, code, component, aliases] of [
  ['View.tsx', `import Card from './Card'; export default ()=> <Card/>`, 'Card.tsx', {}],
  ['View.vue', `<script setup>import Card from '@/Card.vue'</script><template><Card/></template>`, 'Card.vue', { '@': '.' }],
] as const) test(`creating and deleting a missing ${component} invalidates only its consumers`, async () => {
  await fixture({
    'skelcast.config.mjs': `export default ${JSON.stringify({ aliases, targets: [{ id: 'one', source }, { id: 'two', source: 'Other.tsx' }] })}`,
    [source]: code,
    'Other.tsx': `export default ()=> <aside>Other</aside>`,
  }, async root => {
    const project = await loadProject(root);
    await syncProject(project);
    assert.match((await readArtifact(project, 'one')).variants.default.html, /data-sk-fallback/);
    assert.deepEqual((await checkProject(project)).map(row => row.state), ['ready', 'ready']);
    await writeFile(path.join(root, component), component.endsWith('.vue')
      ? `<template><article>Card</article></template>`
      : `throw new Error('never execute'); export default ()=> <article>Card</article>`);
    assert.deepEqual((await checkProject(project)).map(row => row.state), ['stale', 'ready']);
    assert.deepEqual((await syncProject(project)).map(row => row.state), ['generated', 'reused']);
    const artifact = await readArtifact(project, 'one');
    assert.match(artifact.variants.default.html, /<article/);
    assert.equal(artifact.diagnostics.length, 0);
    await rm(path.join(root, component));
    assert.deepEqual((await checkProject(project)).map(row => row.state), ['stale', 'ready']);
    await syncProject(project);
    assert.match((await readArtifact(project, 'one')).variants.default.html, /data-sk-fallback/);
    assert.deepEqual((await checkProject(project)).map(row => row.state), ['ready', 'ready']);
  });
});

test('new higher-priority resolution candidates invalidate directory imports without perpetual staleness', async () => {
  await fixture({
    'skelcast.config.mjs': config,
    'View.tsx': `import Card from './Card'; export default ()=> <Card/>`,
    'Card/index.tsx': `export default ()=> <article>Directory</article>`,
    'Other.tsx': `export default ()=> <aside>Other</aside>`,
  }, async root => {
    const project = await loadProject(root);
    await syncProject(project);
    assert.deepEqual((await checkProject(project)).map(row => row.state), ['ready', 'ready']);
    assert.deepEqual((await syncProject(project)).map(row => row.state), ['reused', 'reused']);
    await writeFile(path.join(root, 'Card.tsx'), `export default ()=> <section>File</section>`);
    assert.deepEqual((await checkProject(project)).map(row => row.state), ['stale', 'ready']);
    await syncProject(project);
    assert.match((await readArtifact(project, 'one')).variants.default.html, /<section/);
    assert.deepEqual((await checkProject(project)).map(row => row.state), ['ready', 'ready']);
  });
});

test('missing transitive style imports are tracked until their files are created', async () => {
  await fixture({
    'skelcast.config.mjs': config,
    'View.tsx': `import './helper'; export default ()=> <main>One</main>`,
    'helper.ts': `import './theme.css'; throw new Error('never execute')`,
    'Other.tsx': `export default ()=> <aside>Other</aside>`,
  }, async root => {
    const project = await loadProject(root);
    await syncProject(project);
    assert.deepEqual((await checkProject(project)).map(row => row.state), ['ready', 'ready']);
    await writeFile(path.join(root, 'theme.css'), `main{gap:37px}`);
    assert.deepEqual((await checkProject(project)).map(row => row.state), ['stale', 'ready']);
    await syncProject(project);
    assert.match((await readArtifact(project, 'one')).variants.default.css, /gap:37px/);
  });
});

test('React components resolve through named, default, imported and namespace re-export chains', async () => {
  await fixture({
    'View.tsx': `import {Card as Named} from './named'; import Default from './default'; import {Imported} from './imported'; import * as UI from './named'; import {Cards} from './namespace'; import {Local} from './local'; export default ()=> <main><Named width={71}>Body</Named><Default width={72}/><Imported width={73}/><UI.Card width={74}/><Cards.Card width={75}/><Local width={76}/></main>`,
    'named.ts': `export {default as Card} from './default'; throw new Error('never execute')`,
    'default.ts': `export {Panel as default} from './Card'`,
    'imported.ts': `import Local from './default'; export {Local as Imported}`,
    'namespace.ts': `export * as Cards from './named'`,
    'local.tsx': `const Local = ({width})=> <article style={{width}}/>; export {Local}`,
    'Card.tsx': `import './card.css'; export function Panel({width,children}){return <article style={{width}}>{children}</article>} throw new Error('never execute')`,
    'card.css': `article{display:grid}`,
  }, async root => {
    const { artifact, dependencies } = await compileTarget(root, target);
    assert.equal(artifact.diagnostics.length, 0);
    const html = artifact.variants.default.html;
    assert.equal((html.match(/<article/g) ?? []).length, 6);
    for (const width of [71, 72, 73, 74, 75, 76]) assert.match(html, new RegExp(`width:${width}px`));
    assert.match(html, /<article[^>]*><span/);
    assert.match(artifact.variants.default.css, /display:grid/);
    for (const file of ['named.ts', 'default.ts', 'imported.ts', 'namespace.ts', 'local.tsx', 'Card.tsx', 'card.css']) assert.ok(dependencies[file], file);
  });
});

test('init-style targets can still select private source components and their regions', async () => {
  await fixture({
    'View.tsx': `import {LoadingBoundary} from 'skelcast/react'; import region from 'virtual:skelcast/test.list'; function Inner(){return <LoadingBoundary artifact={region} pending={false}><article>Body</article></LoadingBoundary>} export default ()=> <Inner/>`,
  }, async root => {
    const { artifact } = await compileTarget(root, { ...target, export: 'Inner', region: 'region' });
    assert.equal(artifact.diagnostics.length, 0);
    assert.match(artifact.variants.default.html, /<article/);
    assert.doesNotMatch(artifact.variants.default.html, /LoadingBoundary/);
  });
});

test('Vue default and named slots survive local component re-exports and dependency edits', async () => {
  await fixture({
    'skelcast.config.mjs': `export default {targets:[{id:'one',source:'View.vue'},{id:'two',source:'Other.tsx'}]}`,
    'View.vue': `<script setup>import {Panel} from './barrel'</script><template><Panel :width="82"><template #header><h1>Title</h1></template><p>Body</p></Panel></template>`,
    'barrel.ts': `export {default as Panel} from './forward'; throw new Error('never execute')`,
    'forward.ts': `import Panel from './Panel.vue'; export default Panel`,
    'Panel.vue': `<script setup>defineProps(['width'])</script><template><article :style="{width:width+'px'}"><header><slot name="header"/></header><main><slot/></main></article></template><style scoped>article{display:grid}</style>`,
    'Other.tsx': `export default ()=> <aside>Other</aside>`,
  }, async root => {
    const project = await loadProject(root);
    await syncProject(project);
    const artifact = await readArtifact(project, 'one');
    assert.equal(artifact.diagnostics.length, 0);
    assert.match(artifact.variants.default.html, /<article[^>]*width:82px/);
    assert.match(artifact.variants.default.html, /<header[^>]*><h1/);
    assert.match(artifact.variants.default.html, /<main[^>]*><p/);
    assert.match(artifact.variants.default.css, /article\[data-v-sk-/);
    await writeFile(path.join(root, 'Panel.vue'), `<template><section>Updated</section></template>`);
    assert.deepEqual((await checkProject(project)).map(row => row.state), ['stale', 'ready']);
    await syncProject(project);
    assert.match((await readArtifact(project, 'one')).variants.default.html, /<section/);
  });
});

test('star re-exports handle diamonds and cycles while explicit exports win', async () => {
  await fixture({
    'View.tsx': `import {Card} from './barrel'; export default ()=> <Card/>`,
    'barrel.ts': `export * from './left'; export * from './right'; export * from './cycle'`,
    'left.ts': `export {default as Card} from './Card'`,
    'right.ts': `export * from './left'`,
    'cycle.ts': `export * from './barrel'`,
    'Card.tsx': `export default ()=> <article>Card</article>`,
  }, async root => {
    const first = await compileTarget(root, target);
    assert.equal(first.artifact.diagnostics.length, 0);
    assert.match(first.artifact.variants.default.html, /<article/);
    await writeFile(path.join(root, 'barrel.ts'), `export * from './left'; export {default as Card} from './Override'`);
    await writeFile(path.join(root, 'Override.tsx'), `export default ()=> <aside>Override</aside>`);
    const second = await compileTarget(root, target);
    assert.equal(second.artifact.diagnostics.length, 0);
    assert.match(second.artifact.variants.default.html, /<aside/);
  });
});

test('cyclic named re-exports produce a local fallback and keep sibling content', async () => {
  await fixture({
    'View.tsx': `import {Card} from './left'; export default ()=> <main><Card/><aside>Keep</aside></main>`,
    'left.ts': `export {Card} from './right'`,
    'right.ts': `export {Card} from './left'`,
  }, async root => {
    const { artifact } = await compileTarget(root, target);
    assert.equal(artifact.diagnostics.filter(d => d.code === 'FALLBACK').length, 1);
    assert.match(artifact.variants.default.html, /data-sk-fallback/);
    assert.match(artifact.variants.default.html, /<aside/);
  });
});

test('star re-exports do not expose defaults, private functions, types or ambiguous names', async () => {
  await fixture({
    'View.tsx': `import Missing, {Private,Card,TypeOnly} from './barrel'; export default ()=> <main><Missing/><Private/><Card/><TypeOnly/></main>`,
    'barrel.ts': `export * from './left'; export * from './right'; export type {TypeOnly} from './typed'`,
    'left.tsx': `function Private(){return <nav/>} export default ()=> <header/>; export function Card(){return <article/>}`,
    'right.tsx': `export function Card(){return <aside/>}`,
    'typed.tsx': `export function TypeOnly(){return <footer/>}`,
  }, async root => {
    const { artifact } = await compileTarget(root, target);
    assert.equal(artifact.diagnostics.filter(d => d.code === 'FALLBACK').length, 4);
    assert.ok(artifact.diagnostics.some(d => d.message === 'Ambiguous exported component Card'));
    assert.doesNotMatch(artifact.variants.default.html, /<(?:nav|header|article|aside|footer)\b/);
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


test('React and Vue select the same source branches for coercive equality', async () => {
  await fixture({
    'View.tsx': `export default function View(){return <main>{0 == false ? <section/> : <aside/>}{null == undefined ? <header/> : <footer/>}</main>}`,
    'View.vue': `<template><main><section v-if="0 == false"/><aside v-else/><header v-if="null == undefined"/><footer v-else/></main></template>`,
  }, async root => {
    for (const source of ['View.tsx', 'View.vue']) {
      const { artifact } = await compileTarget(root, { ...target, source });
      assert.match(artifact.variants.default.html, /<section/);
      assert.match(artifact.variants.default.html, /<header/);
      assert.doesNotMatch(artifact.variants.default.html, /<aside|<footer/);
      assert.deepEqual(artifact.diagnostics, []);
    }
  });
});
