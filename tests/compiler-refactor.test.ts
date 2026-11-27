import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse } from '@vue/compiler-dom';
import { compileTarget } from '../src/compiler/index.js';
import type { CompilerOptions } from '../src/compiler/modules.js';
import { digest } from '../src/compiler/styles.js';
import { parseExpression } from '@babel/parser';
import { renderJSX } from '../src/compiler/react.js';
import type { RenderContext } from '../src/compiler/context.js';
import type { RenderHost } from '../src/compiler/render-host.js';
import { analyzeReact } from '../src/init/react.js';

async function fixture(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-refactor-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), source);
    }
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('shared declaration parsing preserves init selection, export aliases and compiler wrapper support', async () => {
  const cases = [
    { source: 'export default () => <main>Ready</main>;', targets: 1, exported: 'default' },
    { source: 'export default function Page(){return <main>Ready</main>}', targets: 1, exported: 'default' },
    { source: 'const Page = memo(() => <main>Ready</main>); export {Page as Dashboard};', targets: 1, exported: 'Dashboard' },
    { source: 'const Page = forwardRef((props,ref) => <main>Ready</main>); export default Page;', targets: 1, exported: 'default' },
    // Init only edits its existing set of supported component declarations.
    { source: 'export default memo(() => <main>Ready</main>);', targets: 0, exported: 'default' },
    { source: 'export default forwardRef((props,ref) => <main>Ready</main>);', targets: 0, exported: 'default' },
  ];
  await fixture({}, async root => {
    for (const entry of cases) {
      const source = `import {memo,forwardRef} from 'react';${entry.source}`;
      const analysis = analyzeReact({ file: 'View.tsx', source, page: true, routes: ['/'], existing: { targets: [] }, usedIds: new Set() });
      assert.equal(analysis.targets.length, entry.targets, entry.source);
      assert.deepEqual(analysis.diagnostics, []);
      if (entry.targets) assert.equal(analysis.targets[0].export, entry.exported);
      await writeFile(path.join(root, 'View.tsx'), source);
      const { artifact } = await compileTarget(root, { id: 'declarations', source: 'View.tsx', export: entry.exported });
      assert.match(artifact.variants.default.html, /<main\b/);
      assert.deepEqual(artifact.diagnostics, []);
    }
  });
});

test('React branch inspection reuses syntax while preserving current branch choices and diagnostics', async () => {
  const code = 'flag ? <section>{items.map(item => <p>{item}</p>)}</section> : <aside/>';
  const node = parseExpression(code, { plugins: ['jsx'] });
  if (node.type !== 'ConditionalExpression' || node.consequent.type !== 'JSXElement') throw new Error('Expected conditional JSX');
  let reads = 0, emptyStates = 0;
  const children = node.consequent.children;
  Object.defineProperty(node.consequent, 'children', { get() { reads++; return children; } });
  const ctx = { code, env: { flag: false }, bindings: {} } as unknown as RenderContext;
  const host = {
    target: { kind: 'request' }, hints: {}, budget: () => undefined, record: () => {},
    diagnose(code: string) { if (code === 'EMPTY_STATE') emptyStates++; },
    async jsx(selected: unknown) { return selected === node.consequent ? 'list' : 'empty'; },
  } as unknown as RenderHost;
  assert.equal(await renderJSX.call(host, node, ctx), 'empty');
  assert.equal(await renderJSX.call(host, node, ctx), 'empty');
  ctx.env.flag = true;
  assert.equal(await renderJSX.call(host, node, ctx), 'list');
  assert.equal(reads, 1, 'the same collection subtree is scanned once');
  assert.equal(emptyStates, 2, 'each render still emits its own diagnostics');
});

test('React type wrappers retain the same native tree, including satisfies and nested wrappers', async () => {
  const jsx = '<section><p>Value</p></section>';
  await fixture({}, async root => {
    let expected: string | undefined;
    for (const expression of [jsx, `(${jsx}) as JSX.Element`, `(${jsx})!`, `(${jsx}) satisfies JSX.Element`, `((${jsx})! satisfies JSX.Element) as JSX.Element`]) {
      await writeFile(path.join(root, 'View.tsx'), `export default () => ${expression};`);
      const { artifact } = await compileTarget(root, { id: 'wrappers', source: 'View.tsx' });
      const html = artifact.variants.default.html.replace(/ data-sk-node="[^"]+"/g, '');
      expected ??= html;
      assert.equal(html, expected, expression);
      assert.deepEqual(artifact.diagnostics, []);
    }
  });
});

test('React type wrapper unification retains the expansion cutoff and fallback source node', async () => {
  const prefix = 'export default () => <main>{[';
  const child = '(<span>Value</span> as JSX.Element)';
  await fixture({ 'View.tsx': prefix + Array(2100).fill(child).join(',') + ']}</main>' }, async root => {
    const { artifact } = await compileTarget(root, { id: 'budget', source: 'View.tsx' });
    assert.equal((artifact.variants.default.html.match(/data-sk-measured/g) ?? []).length, 1999);
    const diagnostics = artifact.diagnostics.filter(row => row.message.includes('expansion budget'));
    assert.equal(diagnostics.length, 1);
    const offset = prefix.length + 1999 * (child.length + 1) + 1;
    assert.equal(diagnostics[0].node, digest(`View.tsx:${offset}`).slice(0, 12));
  });
});

test('fallback props retain CSS priority, escaped attributes, source IDs and explicit geometry across frontends', async () => {
  const style = 'height:100px!important;height:20px;min-height:24px!important;--caption:"A & B"';
  await fixture({
    'Opaque.ts': 'export default makeBusinessWidget();',
    'View.tsx': `import Opaque from './Opaque';export default () => <Opaque id="source" data-label='A & B "C"' width={18} height={18} style={${JSON.stringify(style)}}/>;`,
    'View.vue': `<script setup>import Opaque from './Opaque'</script><template><Opaque id="source" data-label="A &amp; B &quot;C&quot;" width="18" height="18" style="${style.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"/></template>`,
    'View.ts': `import {h} from 'vue';import Opaque from './Opaque';export default () => h(Opaque,{id:'source','data-label':'A & B "C"',width:18,height:18,style:${JSON.stringify(style)}});`,
  }, async root => {
    for (const source of ['View.tsx', 'View.vue', 'View.ts']) {
      const { artifact } = await compileTarget(root, { id: 'fallback', source, hints: { minHeight: 48 } });
      const markup = parse(artifact.variants.default.html).children[0];
      assert.equal(markup.type, 1);
      if (markup.type !== 1) throw new Error('Expected artifact root');
      const node = markup.children[0];
      assert.equal(node.type, 1);
      if (node.type !== 1) throw new Error('Expected fallback');
      const attrs = Object.fromEntries(node.props.filter(prop => prop.type === 6).map(prop => [prop.name, prop.value?.content]));
      assert.ok('data-sk-fallback' in attrs);
      assert.equal(attrs['data-label'], 'A & B "C"');
      assert.equal(attrs['data-sk-source-id'], 'source');
      assert.equal(attrs.width, undefined);
      assert.equal(attrs.height, undefined);
      assert.equal(attrs.style, 'height:100px!important;height:20px;min-height:48px;--caption:"A & B";width:18px');
      assert.deepEqual(artifact.variants.default.sourceIds, ['source']);
      assert.equal(artifact.diagnostics.filter(row => row.code === 'FALLBACK').length, 1);
    }
  });
});

test('template and h presets keep named slot order, body geometry and explicit camelCase prop precedence', async () => {
  await fixture({
    'View.vue': `<script setup>import {ElCard,ElScrollbar} from 'element-plus'</script><template><ElCard><template #footer><footer>Footer</footer></template><ElScrollbar :max-height="100" :maxHeight="200"><article>Body</article></ElScrollbar><template #header><header>Header</header></template></ElCard></template>`,
    'View.ts': `import {h} from 'vue';import {ElCard,ElScrollbar} from 'element-plus';export default () => h(ElCard,null,{footer:()=>h('footer',null,'Footer'),default:()=>h(ElScrollbar,{'max-height':100,maxHeight:200},{default:()=>h('article',null,'Body')}),header:()=>h('header',null,'Header')});`,
  }, async root => {
    let expected: string | undefined;
    for (const source of ['View.vue', 'View.ts']) {
      const { artifact } = await compileTarget(root, { id: 'slots', source }, {}, { componentPresets: ['element-plus'] });
      const html = artifact.variants.default.html.replace(/ data-sk-node="[^"]+"/g, '');
      assert.match(html, /max-height:200px/);
      assert.ok(html.indexOf('Header') < html.indexOf('Body'));
      assert.ok(html.indexOf('Body') < html.indexOf('Footer'));
      assert.deepEqual(artifact.diagnostics, []);
      expected ??= html;
      assert.equal(html, expected);
    }
  });
});

test('global component discovery retains declaration/configuration precedence and installer identity rules', async () => {
  const plugin = `import {defineComponent,h} from 'vue';const Core=defineComponent({name:'PluginCore',render(){return h('section',{'data-origin':'plugin'},'Plugin')}});const Other=defineComponent({render(){return h('div',null,'Other')}});const Plugin=Object.assign(Core,{install(app){app.component('Wrong',Other);app.component(Core.name,Core);app.component('Registered',Core)}});export default Plugin;`;
  await fixture({
    'index.html': '<script type="module" src="/main.ts"></script>',
    'main.ts': `import {createApp} from 'vue';import Plugin from '@fixture/widgets';import Direct from './Direct.vue';const app=createApp({});app.component('Registered',Direct);app.use(Plugin);const fake={};fake.component('Spoof',Direct);throw Error('never execute');`,
    'node_modules/@fixture/widgets/package.json': JSON.stringify({ module: 'index.js', peerDependencies: { 'element-plus': '*' } }),
    'node_modules/@fixture/widgets/index.js': plugin,
    'Direct.vue': '<template><article data-origin="direct">Direct</article></template>',
    'Declared.vue': '<template><article data-origin="declared">Declared</article></template>',
    'Configured.vue': '<template><article data-origin="configured">Configured</article></template>',
    'View.vue': '<template><Registered/><Wrong/><PluginCore/><Spoof/></template>',
  }, async root => {
    const target = { id: 'registry', source: 'View.vue' };
    const options: CompilerOptions = { componentPresets: ['element-plus'] };
    const direct = await compileTarget(root, target, {}, options);
    assert.match(direct.artifact.variants.default.html, /data-origin="direct"/);
    assert.equal(direct.artifact.diagnostics.filter(row => row.code === 'FALLBACK').length, 3);

    await writeFile(path.join(root, 'main.ts'), `import {createApp} from 'vue';import Plugin from '@fixture/widgets';const app=createApp({});app.use(Plugin);`);
    const registered = await compileTarget(root, target, {}, options);
    assert.match(registered.artifact.variants.default.html, /data-origin="plugin"/);
    assert.equal(registered.artifact.diagnostics.filter(row => row.code === 'FALLBACK').length, 3);
    assert.ok(registered.dependencies['node_modules/@fixture/widgets/package.json']);

    await writeFile(path.join(root, 'components.d.ts'), `declare module 'vue' { interface GlobalComponents { Registered: typeof import('./Declared.vue')['default'] } }`);
    const declared = await compileTarget(root, target, {}, options);
    assert.match(declared.artifact.variants.default.html, /data-origin="declared"/);
    const configured = await compileTarget(root, target, {}, { ...options, components: { Registered: 'Configured.vue' } });
    assert.match(configured.artifact.variants.default.html, /data-origin="configured"/);
  });
});
