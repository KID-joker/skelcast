import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse } from '@vue/compiler-dom';
import { parseExpression } from '@babel/parser';
import { compileTarget, compileTargetWithFiles, SourceCompiler } from '../src/compiler/index.js';
import { SourceFiles } from '../src/compiler/source-files.js';
import { SourceModules } from '../src/compiler/modules.js';
import { StaticValues } from '../src/compiler/static-values.js';
import { UNKNOWN } from '../src/compiler/expression.js';
import { renderJSX } from '../src/compiler/react.js';
import { renderVueExpression } from '../src/compiler/vue-render.js';
import { setupSyntax, visualSyntax } from '../src/compiler/vue-syntax.js';
import { renderPresetSlots } from '../src/compiler/presets/slots.js';
import { naiveUIPreset } from '../src/compiler/presets/naive-ui.js';
import { elementPlusPreset } from '../src/compiler/presets/element-plus.js';
import { antDesignPreset } from '../src/compiler/presets/ant-design.js';
import { TableColumns } from '../src/compiler/presets/columns.js';
import type { ModuleInfo, RenderContext, SourceSlot } from '../src/compiler/context.js';
import type { RenderHost } from '../src/compiler/render-host.js';
import type { ComponentPreset } from '../src/compiler/presets/types.js';
import { parseSource } from '../src/compiler/ast.js';
import { renderVueNode } from '../src/compiler/vue.js';

async function fixture(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-simplification-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), source);
    }
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('presets consume joined markup only when their presentation uses it', () => {
  const cases: [ComponentPreset, string[]][] = [
    [naiveUIPreset, ['nimage', 'nicon', 'ninput', 'nstatistic']],
    [elementPlusPreset, ['elimage', 'elicon', 'elinput', 'elcard', 'elstatistic']],
    [antDesignPreset('antd'), ['image', 'input', 'progress', 'statistic']],
  ];
  for (const [preset, names] of cases) {
    const policy = { mask: true, slots: { default: '<p>Body</p>', header: '<h2>Header</h2>' }, columns: new TableColumns(),
      get children(): string { throw new Error('Unused slot markup must not be joined'); } };
    for (const name of names) assert.ok(preset.present(name, {}, () => 'Text', {}, policy), `${preset.id}:${name}`);
    const button = preset.present(preset.id === 'naive-ui' ? 'nbutton' : preset.id === 'element-plus' ? 'elbutton' : 'button', {}, () => 'Text', {}, { mask: true, slots: policy.slots, columns: policy.columns, children: 'Caption' });
    assert.equal(button?.children, 'Caption');
  }
});

test('unused preset slots retain traversal diagnostics, dependencies and expansion costs', async () => {
  await fixture({
    'Child.vue': '<template><Missing/></template>',
    'View.vue': '<script setup>import {NImage} from "naive-ui";import Child from "./Child.vue";</script><template><NImage><Child/></NImage><p>After</p></template>',
  }, async root => {
    const result = await compileTarget(root, { id: 'unused', source: 'View.vue' }, {}, { componentPresets: ['naive-ui'] });
    assert.ok(result.dependencies['Child.vue']);
    assert.deepEqual(result.artifact.diagnostics.map(d => [d.code, d.component]), [['FALLBACK', 'Missing']]);
    assert.doesNotMatch(result.artifact.variants.default.html, /data-sk-fallback/);
    assert.match(result.artifact.variants.default.html, /After/);
    await writeFile(path.join(root, 'View.vue'), '<script setup>import {NImage} from "naive-ui";</script><template><NImage>' + '<span>Data</span>'.repeat(3100) + '</NImage><p>After</p></template>');
    const limited = await compileTarget(root, { id: 'unused', source: 'View.vue' }, {}, { componentPresets: ['naive-ui'] });
    assert.equal(limited.artifact.diagnostics.filter(d => d.message.includes('expansion budget')).length, 1);
    assert.doesNotMatch(limited.artifact.variants.default.html, /After|data-sk-fallback/);
  });
});

test('preset slot lookup reuses syntax while retaining duplicate slots, order and per-render contexts', async () => {
  const ast = parse('<section><template #footer><footer/></template><p/><template #header><h1/></template><template #header><h2/></template><template #default><main/></template></section>');
  const parent = ast.children[0];
  assert.equal(parent.type, 1);
  if (parent.type !== 1) return;
  let reads = 0;
  for (const child of parent.children) if (child.type === 1) {
    const props = child.props;
    Object.defineProperty(child, 'props', { get() { reads++; return props; } });
  }
  const calls: string[] = [];
  const host = { async vueNodes(nodes, ctx) {
    calls.push(String(ctx.env.instance));
    return nodes.map(node => node.type === 1 ? node.tag : '').join(',');
  } } as RenderHost;
  const names = ['default', 'header', 'footer', 'missing'];
  for (let instance = 0; instance < 3; instance++) {
    const ctx = { env: { instance } } as unknown as RenderContext;
    const source: SourceSlot = { framework: 'vue', nodes: parent.children, context: ctx };
    assert.deepEqual(await renderPresetSlots(host, source, names, ctx), { default: 'p,main', header: 'h1,h2', footer: 'footer', missing: '' });
  }
  assert.equal(reads, 4, 'named templates are classified once across slots and renders');
  assert.deepEqual(calls, names.map(() => '0').concat(names.map(() => '1'), names.map(() => '2')));
});

test('preset dynamic slot names follow instance bindings and report unresolved names', async () => {
  await fixture({
    'View.vue': `<script setup>import {ElCard} from 'element-plus';const section = readName();</script><template><ElCard><template #[section]><h2>Header marker</h2></template><p>Body</p></ElCard></template>`,
  }, async root => {
    const { artifact } = await compileTarget(root, { id: 'dynamic-slots', source: 'View.vue', variants: {
      header: { bindings: { section: 'header' } }, footer: { bindings: { section: 'footer' } }, unknown: {},
    } }, {}, { componentPresets: ['element-plus'] });
    assert.match(artifact.variants.header.html, /class="el-card__header [^"]*"><h2/);
    assert.doesNotMatch(artifact.variants.header.html, /class="el-card__footer/);
    assert.match(artifact.variants.footer.html, /class="el-card__footer [^"]*"><h2/);
    assert.doesNotMatch(artifact.variants.footer.html, /class="el-card__header/);
    assert.doesNotMatch(artifact.variants.unknown.html, /Header marker/);
    assert.deepEqual(artifact.diagnostics.map(d => [d.code, d.variants]), [['SLOT_UNKNOWN', ['unknown']]]);
    assert.ok(Object.values(artifact.variants).every(view => view.html.includes('Body')));
  });
});

test('Vue collection limits avoid reading unused array/object values and retain aliases', async () => {
  const node = parse('<div v-for="(item,key,index) in items"/>').children[0];
  for (const object of [false, true]) {
    let reads = 0;
    const items = object ? {} as Record<string, unknown> : new Array(1000);
    for (let i = 0; i < 1000; i++) Object.defineProperty(items, object ? `key${i}` : i, {
      enumerable: true, get() { reads++; return i === 0 ? null : i === 1 ? undefined : i; },
    });
    for (const repeat of [undefined, 2]) {
      reads = 0;
      const rendered: Record<string, unknown>[] = [];
      const host = {
        hints: { repeat }, target: { kind: 'page' }, selectVueNode() {}, budget() {}, diagnose() {}, record() {},
        async vueNode(_node: unknown, ctx: RenderContext) { rendered.push(ctx.env); return ''; },
      } as unknown as RenderHost;
      const ctx = { code: '', env: { items }, bindings: {}, expressions: new Map(),
        module: { imports: new Map(), ast: parseSource('') }, scopes: [], depth: 1 } as unknown as RenderContext;
      await renderVueNode.call(host, node, ctx);
      assert.equal(rendered.length, repeat ?? 24);
      assert.equal(reads, rendered.length);
      for (let i = 0; i < rendered.length; i++) {
        assert.equal(rendered[i].item, i === 0 ? null : i === 1 ? undefined : i);
        assert.equal(rendered[i].key, object ? `key${i}` : i);
        assert.equal(rendered[i].index, i);
      }
    }
  }
});

test('layout presets skip unused text while repeated text consumers share one placeholder', async () => {
  class CountingCompiler extends SourceCompiler {
    textCalls = 0;
    override text(...args: Parameters<SourceCompiler['text']>) {
      this.textCalls++;
      return super.text(...args);
    }
  }
  await fixture({
    'View.vue': `<script setup>import {ElRow,ElCol,ElCard} from 'element-plus';import {NImage,NCard} from 'naive-ui';import {Row,Col,Card} from 'ant-design-vue';</script><template><ElRow><ElCol/></ElRow><ElCard/><NImage/><NCard/><Row><Col/></Row><Card/></template>`,
    'Statistic.vue': `<script setup>import {NStatistic} from 'naive-ui';</script><template><NStatistic/></template>`,
  }, async root => {
    const options = { componentPresets: ['element-plus', 'naive-ui', 'ant-design-vue'] as const };
    const layout = new CountingCompiler(root, { id: 'layout', source: 'View.vue' }, {}, {}, { componentPresets: [...options.componentPresets] });
    await layout.compile();
    assert.equal(layout.textCalls, 0);
    assert.deepEqual(layout.diagnostics, []);
    const statistic = new CountingCompiler(root, { id: 'statistic', source: 'Statistic.vue' }, {}, {}, { componentPresets: ['naive-ui'] });
    const { view } = await statistic.compile();
    assert.equal(statistic.textCalls, 1);
    assert.equal((view.html.match(/data-sk-text data-sk-leaf/g) ?? []).length, 2);
    assert.deepEqual(statistic.diagnostics, []);
  });
});

test('Vue loop and slot parameter syntax is shared across instances and variants with isolated values', async () => {
  await fixture({
    'Frame.vue': '<script setup>defineProps({height:Number})</script><template><slot :height="height"/></template>',
    'View.vue': '<script setup>import Frame from "./Frame.vue";</script><template><Frame v-for="(size,i) in sizes" :height="size" v-slot="{height=60}"><p :style="{height:height+\'px\'}">{{i}}</p></Frame></template>',
  }, async root => {
    const files = new SourceFiles(), parses = new Map<string, number>();
    const set = files.expressions.set.bind(files.expressions);
    files.expressions.set = (key, value) => { parses.set(key, (parses.get(key) ?? 0) + 1); return set(key, value); };
    const target = { id: 'parameters', source: 'View.vue', variants: { small: { bindings: { sizes: [20, 40] } }, large: { bindings: { sizes: [80] } } } };
    const { artifact } = await compileTargetWithFiles(root, target, {}, {}, files);
    assert.match(artifact.variants.small.html, /height:20px/);
    assert.match(artifact.variants.small.html, /height:40px/);
    assert.doesNotMatch(artifact.variants.small.html, /height:80px/);
    assert.match(artifact.variants.large.html, /height:80px/);
    assert.doesNotMatch(artifact.variants.large.html, /height:20px|height:40px/);
    assert.equal(parses.get('(size,i) => 0'), 1);
    assert.equal(parses.get('({height=60})=>0'), 1);
    assert.deepEqual(artifact.diagnostics, []);
    await writeFile(path.join(root, 'View.vue'), '<template><p v-for="(a,b,c,d) in 2"/></template>');
    const invalid = await compileTarget(root, { id: 'parameters', source: 'View.vue', variants: { one: {}, two: {} } });
    assert.deepEqual(invalid.artifact.diagnostics.map(d => [d.message, d.variants]), [['Unsupported v-for aliases', ['one', 'two']]]);
  });
});

test('setup syntax retains source order and reuses nested visual facts without sharing import identities', () => {
  const ast = parseSource('function setup(){const alias=state;const row=()=>h("p");state.value=2;return()=>row()}');
  const setup = ast.program.body[0];
  if (setup.type !== 'FunctionDeclaration') throw new Error('Expected setup');
  const facts = setupSyntax(setup.body);
  assert.equal(setupSyntax(setup.body), facts);
  assert.deepEqual([...facts.localNames], ['alias', 'row']);
  assert.deepEqual(facts.aliases, [['alias', 'state']]);
  assert.deepEqual(facts.effects.map(effect => effect.written ?? effect.call?.callee.type), ['Identifier', 'state', 'Identifier']);
  const row = facts.renderBindings[1].fn;
  if (row?.type !== 'ArrowFunctionExpression') throw new Error('Expected row');
  let reads = 0;
  const body = row.body;
  Object.defineProperty(row, 'body', { get() { reads++; return body; } });
  const module = { imports: new Map([['h', { request: 'vue', exported: 'h' }]]) } as ModuleInfo;
  assert.deepEqual(visualSyntax(module, setup.body), { jsx: false, h: true });
  const before = reads;
  assert.deepEqual(visualSyntax({ ...module }, row), { jsx: false, h: true });
  assert.equal(reads, before, 'the enclosing scan already classified its nested helper');
  assert.deepEqual(visualSyntax({ imports: new Map([['h', { request: 'other', exported: 'h' }]]) } as ModuleInfo, row), { jsx: false, h: false });
  assert.notEqual(setupSyntax(parseSource('function setup(){return 1}').program), facts);
});

test('namespace resolution indexes destructured exports without rescanning per field', async () => {
  const names = Array.from({ length: 80 }, (_, i) => `field${i}`);
  await fixture({
    'data.ts': `export const {${names.join(',')}}={${names.map((name, i) => `${name}:${i}`).join(',')}};export const [first,,third]=[1,2,3];export default {height:40};`,
    'View.ts': 'import * as ns from "./data";export const height=ns.field79;',
  }, async root => {
    class Modules extends SourceModules { load(file: string) { return this.module(file); } }
    const modules = new Modules(root, {});
    const data = await modules.load(path.join(root, 'data.ts'));
    const body = data.ast.program.body;
    const iterate = body[Symbol.iterator].bind(body);
    let scans = 0;
    body[Symbol.iterator] = () => { scans++; return iterate(); };
    const values = new StaticValues(file => modules.load(file));
    const result = await values.environment(await modules.load(path.join(root, 'View.ts')));
    const ns = result.ns as Record<string, unknown>;
    assert.equal(ns.field0, 0);
    assert.equal(ns.field79, 79);
    assert.equal(ns.first, 1);
    assert.equal(ns.third, 3);
    assert.equal((ns.default as { height: number }).height, 40);
    assert.equal(result.height, 79);
    assert.ok(scans < 10, `namespace analysis traversed declarations ${scans} times for 82 fields`);
  });
});

test('shared branches retain frontend-specific diagnostics, evidence and expansion accounting', async () => {
  for (const framework of ['jsx', 'render'] as const) for (const value of [UNKNOWN, false, true, 0, null, 'ready']) {
    for (const code of ['flag ? yes : no', 'flag && yes', 'flag || yes', 'flag ?? yes']) {
      const node = parseExpression(code), diagnostics: string[] = [], evidence: string[] = [];
      let cost = 0;
      const ctx = { code, env: { flag: value }, bindings: {} } as unknown as RenderContext;
      const select = async (node: unknown) => node && typeof node === 'object' && 'name' in node ? String(node.name) : '';
      const host = { target: {}, hints: {}, budget: () => { cost++; }, diagnose: (code: string) => diagnostics.push(code),
        record: (_kind: string, _expression: string, decision: string) => evidence.push(decision), jsx: select, vueExpression: select } as unknown as RenderHost;
      const html = await (framework === 'jsx' ? renderJSX : renderVueExpression).call(host, node, ctx);
      const conditional = node.type === 'ConditionalExpression';
      const expected = conditional ? value === UNKNOWN || value ? 'yes' : 'no'
        : value === UNKNOWN ? 'yes' : code.includes('&&') ? value ? 'yes' : ''
        : code.includes('??') ? value == null ? 'yes' : 'flag' : value ? 'flag' : 'yes';
      assert.equal(html, expected, `${framework}: ${code}: ${String(value)}`);
      assert.equal(cost, 1);
      assert.deepEqual(diagnostics, value === UNKNOWN && (framework === 'render' || conditional) ? ['BRANCH_DEFAULT'] : []);
      assert.equal(evidence.length, framework === 'jsx' && (conditional || value === UNKNOWN) ? 1 : 0);
    }
  }
});
