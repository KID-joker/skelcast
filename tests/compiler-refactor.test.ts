import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse } from '@vue/compiler-dom';
import { compileTarget, SourceCompiler } from '../src/compiler/index.js';
import type { CompilerOptions } from '../src/compiler/modules.js';
import { digest } from '../src/compiler/styles.js';
import { parseExpression } from '@babel/parser';
import { renderJSX } from '../src/compiler/react.js';
import type { ModuleInfo, RenderContext } from '../src/compiler/context.js';
import type { RenderHost } from '../src/compiler/render-host.js';
import { analyzeReact, reactComponents } from '../src/init/react.js';
import { isPageFile } from '../src/init/scan.js';
import { inheritRootScopes, RootMarkup } from '../src/compiler/attributes.js';
import { renderAttributes, renderElement } from '../src/compiler/output.js';
import { UNKNOWN } from '../src/compiler/expression.js';
import { vueRenderFunction } from '../src/compiler/vue-render.js';
import { parseSource } from '../src/compiler/ast.js';
import { planCollection } from '../src/compiler/collections.js';
import { loadingPresence } from '../src/compiler/loading-state.js';
import { applyEdits } from '../src/init/ast.js';

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

test('React page discovery reuses component facts without retaining later source versions', () => {
  for (const source of ['export default () => <main>Ready</main>;', 'export const value = 1;']) {
    const ast = parseSource(source, 'src/pages/View.tsx');
    const components = reactComponents(ast);
    const file = { file: 'src/pages/View.tsx', code: source, ast, vue: false, imports: new Map<string, string>() };
    assert.equal(isPageFile(file, false), components.length > 0);
    assert.equal(reactComponents(ast), components, 'both populated and empty analyses are reused');
    const context = { file: file.file, source, page: true, routes: ['/view'], existing: { targets: [] }, usedIds: new Set<string>() };
    assert.deepEqual(analyzeReact({ ...context, ast }), analyzeReact({ ...context, usedIds: new Set() }));
    assert.equal(reactComponents(ast), components);
  }
  const before = reactComponents(parseSource('export default () => <main/>;', 'View.tsx'));
  const after = reactComponents(parseSource('export default () => <aside/>;', 'View.tsx'));
  assert.notEqual(before, after, 'a fresh AST for the same filename is analyzed independently');
});

test('component dispatch preserves adapter precedence and h source/fallback behavior', async () => {
  await fixture({
    'Adapter.vue': '<template><section data-origin="adapter"/></template>',
    'Widget.vue': '<template><article data-origin="source"/></template>',
  }, async root => {
    for (const request of ['./Widget.vue', 'vendor-widget']) {
      await writeFile(path.join(root, 'View.tsx'), `import Widget from '${request}';export default () => <Widget/>;`);
      await writeFile(path.join(root, 'View.vue'), `<script setup>import Widget from '${request}';</script><template><Widget/></template>`);
      await writeFile(path.join(root, 'View.ts'), `import {h} from 'vue';import Widget from '${request}';export default () => h(Widget);`);
      for (const source of ['View.tsx', 'View.vue', 'View.ts']) {
        const { artifact, dependencies } = await compileTarget(root, { id: 'dispatch', source, adapters: { Widget: 'Adapter.vue' } });
        const rendered = source === 'View.ts';
        assert.equal(Object.hasOwn(dependencies, 'Adapter.vue'), !rendered);
        if (!rendered) {
          assert.match(artifact.variants.default.html, /data-origin="adapter"/);
          assert.deepEqual(artifact.diagnostics, []);
        } else if (request.startsWith('.')) {
          assert.match(artifact.variants.default.html, /data-origin="source"/);
          assert.deepEqual(artifact.diagnostics, []);
        } else {
          assert.ok(artifact.diagnostics.some(d => d.message === 'No source adapter for Widget'));
        }
      }
    }
  });
});

test('install wrapper extraction preserves transparent callbacks and rejects changed component shapes', async () => {
  await fixture({ 'Base.vue': '<template><section style="height:88px"/></template>' }, async root => {
    for (const [expression, transparent] of [
      ['Object.assign(Base,{install(app){throw Error("never run")}})', true],
      ['Object.assign(Base,{install:app=>{throw Error("never run")}})', true],
      ['Object.assign(Base,{get install(){throw Error("never run")}})', false],
      ['Object.assign(Base,{["install"]:()=>{}})', false],
      ['Object.assign(Base,{install(){},render:businessRender})', false],
      ['Object.assign(Base,{install(){}},{render:businessRender})', false],
      ['Object.assign(Missing,{install(){}})', false],
    ] as const) {
      await writeFile(path.join(root, 'View.ts'), `import Base from './Base.vue';export default ${expression};`);
      const { artifact } = await compileTarget(root, { id: 'install-wrapper', source: 'View.ts' });
      assert.equal(artifact.variants.default.html.includes('height:88px'), transparent, expression);
      assert.equal(artifact.diagnostics.some(d => d.code === 'FALLBACK'), !transparent, expression);
    }
    await writeFile(path.join(root, 'View.ts'), `import Base from './Base.vue';const Object={assign:businessAssign};export default Object.assign(Base,{install(){}});`);
    const { artifact } = await compileTarget(root, { id: 'shadowed-wrapper', source: 'View.ts' });
    assert.doesNotMatch(artifact.variants.default.html, /height:88px/);
    assert.ok(artifact.diagnostics.some(d => d.code === 'FALLBACK'));
  });
});

test('collection planning skips ineligible root reads and preserves explicit, source and loading views', () => {
  for (const scenario of ['source', 'control', 'bound', 'untracked', 'projected'] as const) {
    let reads = 0;
    const notes: string[] = [];
    const ctx = {
      code: 'items', env: { get items() { reads++; return []; } },
      bindings: scenario === 'bound' ? { items: [] } : {},
      loading: scenario !== 'source', control: scenario === 'control',
      projectedCollections: scenario === 'untracked' ? undefined : new Set(['items']),
      module: { ast: parseSource(''), imports: new Map() },
    } as unknown as RenderContext;
    const host = {
      target: { kind: 'request' }, hints: scenario === 'source' ? { state: 'source' } : {},
      diagnose: (code: string) => notes.push(code), record: () => {},
    } as unknown as RenderHost;
    const projected = scenario === 'projected';
    assert.deepEqual(planCollection(host, 'items', [], ctx, parseExpression('items')), { count: projected ? 4 : 0, projected });
    assert.equal(reads, projected ? 1 : 0, scenario);
    assert.deepEqual(notes, projected ? ['LOADING_PROJECTION'] : ['source', 'bound'].includes(scenario) ? [] : ['EMPTY_STATE']);
  }
});

test('collection count aliases preserve duplicates, conflicts, object fields and response scope', () => {
  for (const [code, expected] of [
    ['function receive(response){total=response.items.length;rows=response.items;rows=response.items;total=response.items.length}', { root: 'rows', present: true }],
    ['function receive(response){rows=response.items;page={total:response.items.length}}', { root: 'rows', present: true }],
    ['function receive(response){rows=response.items;other=response.items;total=response.items.length}', undefined],
    ['function first(response){rows=response.items;total=response.items.length}function second(response){other=response.items;total=response.items.length}', undefined],
    ['function first(response){rows=response.items}function second(response){total=response.items.length}', undefined],
  ] as const) {
    const ctx = { loading: true, module: { ast: parseSource(code), imports: new Map() } } as unknown as RenderContext;
    assert.deepEqual(loadingPresence(code.includes('page=') ? 'page.total > 0' : 'total > 0', ctx), expected, code);
  }
});

test('React init retains outermost collection regions and independent sibling regions', () => {
  const source = `export default function App(){const {data,isLoading}=useQuery();return <><main><section>{data.map(item=><article/>)}{data.map(item=><article/>)}</section>{data.map(item=><aside/>)}</main><footer loading={isLoading}>Footer</footer><nav loading={isLoading}>Nav</nav></>}`;
  const analysis = analyzeReact({ file: 'View.tsx', source, page: false, routes: [], existing: { targets: [] }, usedIds: new Set() });
  assert.equal(analysis.targets.length, 3);
  assert.deepEqual(analysis.diagnostics, []);
  const replacements = analysis.edits.filter(edit => edit.start !== edit.end);
  assert.deepEqual(replacements.map(edit => source.slice(edit.start, edit.end).match(/^<\w+/)?.[0]), ['<main', '<footer', '<nav']);
  const changed = applyEdits(source, analysis.edits);
  assert.equal((changed.match(/skelcast:init/g) ?? []).length, 3);
  assert.match(changed, /<section>\{data\.map/);
});

test('root attribute merging filters without serializing probes and preserves source markup', () => {
  const html = '<section class="old" style="color:red" data-sk-source-id="before" data-value="keep" grid="old"> <span>Text</span> </section>';
  for (const unocss of [false, true]) {
    let serializations = 0;
    const styles = { unocss };
    const host = { options: { styles } } as RenderHost;
    const result = inheritRootScopes(html, ['data-scope'], {
      class: ['new', { active: true }], style: { padding: 8 }, id: 'after',
      'data-value': UNKNOWN, grid: 'cols-2', rows: {},
    }, '', props => { serializations++; return renderAttributes.call(host, props); }, styles);
    assert.equal(serializations, 1);
    assert.match(result, /class="old new active"/);
    assert.match(result, /style="color:red;padding:8px"/);
    assert.equal((result.match(/data-sk-source-id=/g) ?? []).length, 1);
    assert.match(result, /data-sk-source-id="after"/);
    assert.match(result, /data-value="keep"/);
    assert.match(result, unocss ? /grid="cols-2"/ : /grid="old"/);
    assert.doesNotMatch(result, / rows=/);
    assert.match(result, / data-scope\b/);
    assert.match(result, /> <span>Text<\/span> <\/section>$/);
  }
});

test('root inheritance carries opening tags across wrappers without parsing their descendants', () => {
  const parsed: string[] = [];
  const markup = new RootMarkup((source, options) => { parsed.push(source); return parse(source, options); });
  const host = { options: {}, masked: () => false, attributes: (props: Record<string, unknown>) => renderAttributes.call(host, props), nodeId: () => 'root' } as unknown as RenderHost;
  const children = '<article><span>Keep &amp; preserve</span></article>'.repeat(1000);
  const html = renderElement.call(host, 'section', { class: 'inner', style: 'color:red' }, children, { scopes: [] } as unknown as RenderContext, undefined, {}, markup);
  const inherit = (html: string, scopes: string[], attrs: Record<string, unknown>) =>
    inheritRootScopes(html, scopes, attrs, '', host.attributes, undefined, markup);
  const first = inherit(html, ['data-inner'], { class: 'middle', style: 'padding:8px' });
  const result = inherit(first, ['data-inner', 'data-outer'], { class: 'outer', style: 'margin:4px' });
  assert.match(result, /class="inner middle outer"/);
  assert.match(result, /style="color:red;padding:8px;margin:4px"/);
  assert.equal((result.match(/data-inner/g) ?? []).length, 1);
  assert.match(result, / data-outer\b/);
  assert.equal(result.slice(result.indexOf('>') + 1), children + '</section>');
  assert.equal(parsed.length, 2);
  assert.ok(parsed.every(source => !source.includes('<article>')), 'only opening tags are parsed');
});

test('fragment inheritance retains comments, quoted delimiters, void roots and per-root style precedence', () => {
  const markup = new RootMarkup();
  const host = { options: {} } as RenderHost;
  const attributes = (props: Record<string, unknown>) => renderAttributes.call(host, props);
  const html = '<!--before--><section data-note="A > B" style="color:red"><span>Body</span></section> between <input value="a > b"><!--after-->';
  const first = inheritRootScopes(html, ['data-inner'], { class: 'ignored', id: 'ignored' }, '--root:1', attributes, undefined, markup);
  const result = inheritRootScopes(first, ['data-inner', 'data-outer'], {}, '--parent:2', attributes, undefined, markup);
  const expected = '<!--before--><section style="color:red;--root:1;;--parent:2;" data-outer  data-inner data-note="A > B" ><span>Body</span></section> between <input style="--root:1;;--parent:2;" data-outer  data-inner value="a > b"><!--after-->';
  assert.equal(result, expected);
  assert.doesNotMatch(result, /ignored/);
});

test('identical native roots and inherited outputs retain their parsed root metadata', () => {
  let parses = 0;
  const markup = new RootMarkup((source, options) => { parses++; return parse(source, options); });
  const host = { options: {}, masked: () => false, attributes: (props: Record<string, unknown>) => renderAttributes.call(host, props), nodeId: () => 'root' } as unknown as RenderHost;
  const inherit = (html: string, scopes: string[]) => inheritRootScopes(html, scopes, {}, '', host.attributes, undefined, markup);
  let expected: string | undefined;
  for (let i = 0; i < 20; i++) {
    const html = renderElement.call(host, 'section', { class: 'inner' }, '<span>Keep</span>', { scopes: [] } as unknown as RenderContext, undefined, {}, markup);
    const first = inherit(html, ['data-inner']);
    const result = inherit(first, ['data-inner', 'data-outer']);
    expected ??= result;
    assert.equal(result, expected);
  }
  assert.equal(parses, 2, 'each distinct opening is parsed once across identical renders');
  assert.match(expected!, /<span>Keep<\/span>/);
});

test('React loading collection checks consume receiver syntax without parsing it again', async () => {
  for (const code of [
    'items.length > 0 ? <section>{items.slice(0, 4).map(item => <p>{item}</p>)}</section> : <aside/>',
    'items.length > 0 && <section>{items.slice(0, 4).map(item => <p>{item}</p>)}</section>',
  ]) {
    const node = parseExpression(code, { plugins: ['jsx'] });
    const expressions = new Map();
    const ctx = { code, env: { items: [] }, bindings: {}, loading: true, projectedCollections: new Set(['items']), expressions,
      module: { ast: parseSource(''), imports: new Map() } } as unknown as RenderContext;
    const notes: string[] = [];
    const host = {
      target: { kind: 'page' }, hints: {}, budget: () => undefined, record: () => {},
      diagnose: (code: string) => notes.push(code),
      async jsx(selected: unknown) { return selected === (node.type === 'ConditionalExpression' ? node.consequent : node.type === 'LogicalExpression' ? node.right : undefined) ? 'list' : 'empty'; },
    } as unknown as RenderHost;
    assert.equal(await renderJSX.call(host, node, ctx), 'list');
    assert.equal(expressions.has('items.slice(0, 4)'), false, 'existing collection AST is not reparsed as text');
    assert.deepEqual(notes, node.type === 'ConditionalExpression' ? ['LOADING_PROJECTION'] : []);
    ctx.bindings['items.length > 0'] = false;
    assert.equal(await renderJSX.call(host, node, ctx), node.type === 'ConditionalExpression' ? 'empty' : '');
  }
});

test('functional Vue classification reuses syntax while retaining helper package identity', () => {
  for (const code of ["() => h('section')", "() => node('aside')", "() => Vue.h('main')", '() => <section/>']) {
    const fn = parseExpression(code, { plugins: ['jsx'] });
    if (fn.type !== 'ArrowFunctionExpression') throw new Error('Expected function');
    let reads = 0;
    const body = fn.body;
    const key = body.type === 'CallExpression' ? 'arguments' : 'children';
    const children = Reflect.get(body, key);
    Object.defineProperty(body, key, { get() { reads++; return children; } });
    const imports: ModuleInfo['imports'] = new Map([
      ['h', { request: 'vue', exported: 'h' }],
      ['node', { request: 'vue', exported: 'h' }],
      ['Vue', { request: 'vue', exported: '*' }],
    ]);
    const module = { imports } as ModuleInfo;
    for (let i = 0; i < 20; i++) assert.equal(vueRenderFunction({ ...module }, fn), code.includes('<section') ? undefined : fn);
    assert.equal(reads, 1, 'positive and negative classification facts reuse the body syntax between instances');
    const other = { imports: new Map([...imports].map(([key, value]) => [key, { ...value, request: 'other-library' }])) } as ModuleInfo;
    assert.equal(vueRenderFunction(other, fn), undefined);
    assert.equal(reads, 2, 'different import identities are classified independently');
  }
});

test('component name indexes retain first normalized imports, exact matches and namespace exports', async () => {
  const compiler = new SourceCompiler(process.cwd(), { id: 'names', source: 'View.vue' }, {});
  const first = { file: '/first.vue', request: './first.vue', exported: 'default' };
  const second = { file: '/second.vue', request: './second.vue', exported: 'default' };
  const imports = new Map([
    ['FooBar', first], ['Foo_Bar', second],
    ['Widgets', { file: '/widgets.ts', request: './widgets', exported: '*' }],
  ]);
  const ctx = { module: { imports } } as RenderContext;
  assert.equal(await compiler.componentReference('foo-bar', ctx), first);
  assert.equal(await compiler.componentReference('Foo_Bar', ctx), second);
  assert.deepEqual(await compiler.componentReference('Widgets.Card.Header', ctx), {
    file: '/widgets.ts', request: './widgets', exported: 'Card.Header',
  });
  assert.equal(await compiler.componentReference('foo:bar', { ...ctx, module: { ...ctx.module } }), first);
  const other = { ...ctx, module: { ...ctx.module, imports: new Map([['FooBar', second]]) } };
  assert.equal(await compiler.componentReference('foo-bar', other), second);
});

test('local render calls retain isolated arguments and selected-region parameter defaults', async () => {
  await fixture({
    'Plain.ts': `import{defineComponent,h}from'vue';export default defineComponent({setup(){const row=(height=48)=>h('section',{style:{height:height+'px'}});return()=>h('main',null,[row(40),row(80),row()]);}});`,
    'Wrapper.ts': `import{defineComponent,h}from'vue';export default defineComponent({setup(props,{slots}){const row=(arg={height:48})=>h('div',null,slots.default(arg));return()=>h('main',null,row());}});`,
    'View.vue': `<script setup>import Wrapper from'./Wrapper';import{LoadingBoundary}from'skelcast/vue';import artifact from'virtual:skelcast/region';</script><template><Wrapper v-slot="{height}"><LoadingBoundary :artifact="artifact" :pending="true"><section :style="{height:height+'px'}"/></LoadingBoundary></Wrapper></template>`,
  }, async root => {
    const plain = await compileTarget(root, { id: 'plain-calls', source: 'Plain.ts' });
    assert.match(plain.artifact.variants.default.html, /height:40px/);
    assert.match(plain.artifact.variants.default.html, /height:80px/);
    assert.doesNotMatch(plain.artifact.variants.default.html, /height:48px/);
    assert.ok(plain.artifact.diagnostics.some(d => d.code === 'FALLBACK'), 'ordinary local calls retain opaque missing parameters');
    const region = await compileTarget(root, { id: 'selected-call', source: 'View.vue', region: 'artifact' });
    assert.match(region.artifact.variants.default.html, /height:48px/);
    assert.doesNotMatch(region.artifact.variants.default.html, /<main|<div[^>]*>\s*<div/);
    assert.ok(!region.artifact.diagnostics.some(d => d.code === 'FALLBACK'));
  });
});

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
