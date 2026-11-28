import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { compileTarget } from '../src/compiler/index.js';
import { digest } from '../src/compiler/styles.js';

test('large h trees preserve the existing expansion cutoff and fallback source node', async () => {
  const prefix = `import {h}from'vue';export default()=>h('div',null,[`;
  const child = `h('span',null,'x')`;
  await fixture({}, async root => {
    for (const count of [1999, 2100]) {
      await writeFile(path.join(root, 'Huge.ts'), prefix + Array(count).fill(child).join(',') + '])');
      const { artifact } = await compileTarget(root, { id: 'huge', source: 'Huge.ts' });
      const budget = artifact.diagnostics.filter(item => item.message.includes('expansion budget'));
      assert.equal(budget.length, count === 1999 ? 0 : 1);
      assert.equal((artifact.variants.default.html.match(/data-sk-measured/g) ?? []).length, 1999);
      if (budget.length) {
        const offset = prefix.length + 1999 * (child.length + 1) + child.indexOf("'x'");
        assert.equal(budget[0].node, digest(`Huge.ts:${offset}`).slice(0, 12));
      }
    }
  });
});

test('mixed JSX and h expansion retains its call checkpoint and exact fallback source', async () => {
  const prefix = `import {h} from 'vue';export default()=> <main>{[`;
  const child = `h('span',null,'x')`;
  await fixture({}, async root => {
    for (const count of [1499, 1500]) {
      await writeFile(path.join(root, 'Mixed.tsx'), prefix + Array(count).fill(child).join(',') + ']}</main>');
      const { artifact } = await compileTarget(root, { id: 'mixed', source: 'Mixed.tsx' });
      const diagnostics = artifact.diagnostics.filter(item => item.message.includes('expansion budget'));
      assert.equal((artifact.variants.default.html.match(/data-sk-measured/g) ?? []).length, 1499);
      assert.equal(diagnostics.length, count === 1499 ? 0 : 1);
      if (diagnostics.length) {
        const offset = prefix.length + 1499 * (child.length + 1);
        assert.equal(diagnostics[0].node, digest(`Mixed.tsx:${offset}`).slice(0, 12));
      }
    }
  });
});

async function fixture(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-render-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), source);
    }
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('Vue render wrappers retain defaults, attrs and nested slots through renamed helpers and exported bindings', async () => {
  await fixture({
    'Cell.ts': `import {defineComponent as define, h as node} from 'vue';import {ElCol} from 'element-plus';throw Error('never execute');const Cell=define({props:{size:{type:Number,default:6}},render(){const attrs=this.$attrs;const size=this.size;return node(ElCol,{xs:size,sm:size,md:size,lg:size,xl:size,...attrs},{default:()=>this.$slots.default()});}});export {Cell};export default Cell;`,
    'View.vue': `<script setup>import Box from './Cell';import {ElRow}from'element-plus'</script><template><ElRow :gutter="24"><Box :xs="24" :sm="12" class="panel"><article style="height:80px">Details</article></Box></ElRow></template>`,
  }, async root => {
    const { artifact } = await compileTarget(root, { id: 'wrapper', source: 'View.vue' }, {}, { componentPresets: ['element-plus'] });
    const { html, css } = artifact.variants.default;
    assert.match(html, /<article/);
    assert.match(html, /data-sk-text-content="Details"/);
    assert.match(html, /class="[^"]*panel/);
    assert.match(html, /--sk-el-half-gutter:12px/);
    assert.match(css, /min-width:768px/);
    assert.match(css, /flex:0 0 50%/);
    assert.match(css, /flex:0 0 25%/);
    assert.deepEqual(artifact.diagnostics, []);
    await writeFile(path.join(root, 'Named.vue'), `<script setup>import {Cell as Box}from'./Cell'</script><template><Box :size="12"><b>Named child</b></Box></template>`);
    const named = await compileTarget(root, { id: 'named', source: 'Named.vue' }, {}, { componentPresets: ['element-plus'] });
    assert.deepEqual(named.artifact.diagnostics, []);
    assert.match(named.artifact.variants.default.css, /flex:0 0 50%/);
  });
});

test('namespace h imports preserve named source slots and allow local template children', async () => {
  await fixture({
    'Frame.ts': `import * as Vue from 'vue';import Card from './Card.vue';export default Vue.defineComponent({render(){return Vue.h(Card,{}, {header:()=>Vue.h('h2',null,'Heading'),default:()=>this.$slots.default()});}});`,
    'Card.vue': `<template><section><header><slot name="header"/></header><main><slot/></main></section></template>`,
    'View.vue': `<script setup>import Frame from './Frame'</script><template><Frame><p>Body</p></Frame></template>`,
  }, async root => {
    const { artifact } = await compileTarget(root, { id: 'slots', source: 'View.vue' });
    assert.match(artifact.variants.default.html, /<h2/);
    assert.match(artifact.variants.default.html, /data-sk-text-content="Heading"/);
    assert.match(artifact.variants.default.html, /data-sk-text-content="Body"/);
    assert.deepEqual(artifact.diagnostics, []);
  });
});

test('render-only Vue SFCs and functional h components retain literal props and native geometry', async () => {
  await fixture({
    'Frame.vue': `<script>import {h,defineComponent}from'vue';export default defineComponent({inheritAttrs:false,props:{height:{type:Number,default:40}},render(){return h('article',{style:{height:this.height+'px'}},'Data')}})</script>`,
    'View.vue': `<script setup>import Frame from './Frame.vue'</script><template><Frame class="ignored"/></template>`,
    'Fn.ts': `import {h}from'vue';export default ({height=60})=>h(('section' satisfies string),{style:{height:height+'px'}},['Data',h('button',null,'Reload')]);`,
  }, async root => {
    const { artifact } = await compileTarget(root, { id: 'sfc', source: 'View.vue' });
    assert.match(artifact.variants.default.html, /height:40px/);
    assert.doesNotMatch(artifact.variants.default.html, /ignored/);
    assert.deepEqual(artifact.diagnostics, []);
    const fn = await compileTarget(root, { id: 'function', source: 'Fn.ts' });
    assert.match(fn.artifact.variants.default.html, /height:60px/);
    assert.match(fn.artifact.variants.default.html, />Reload<\/button>/);
    assert.deepEqual(fn.artifact.diagnostics, []);
  });
});

test('unrelated helpers and imperative render bodies retain local fallbacks without executing source', async () => {
  await fixture({
    'Fake.ts': `function defineComponent(x){throw Error('never execute')}function h(){throw Error('never execute')}export default defineComponent({render(){return h('div',null,'invented')}});`,
    'Stateful.ts': `import {h,defineComponent}from'vue';export default defineComponent({render(){runBusiness();return h('div',null,'invented')}});`,
    'Mixed.ts': `import {h,defineComponent}from'vue';export default defineComponent({mixins:[businessMixin],render(){return h('div',null,'invented')}});`,
    'Custom.ts': `import {h}from'vue';export default()=>h('business-widget',null,'invented');`,
  }, async root => {
    for (const source of ['Fake.ts', 'Stateful.ts', 'Mixed.ts', 'Custom.ts']) {
      const { artifact } = await compileTarget(root, { id: 'opaque', source });
      assert.ok(artifact.diagnostics.some(d => d.code === 'FALLBACK'));
      assert.doesNotMatch(artifact.variants.default.html, /invented/);
    }
  });
});

test('request empty-state diagnostics preserve source branches and explicit empty variants', async () => {
  await fixture({
    'View.vue': `<script setup>const total=0;const items=[]</script><template><section><template v-if="total > 0"><article v-for="item in items">{{item.title}}</article></template><p v-else>Empty</p></section></template>`,
    'View.tsx': `export default function View(){const total=0;const items=[];return <section>{total > 0 ? items.map(item=><article>{item.title}</article>) : <p>Empty</p>}</section>}`,
  }, async root => {
    for (const source of ['View.vue','View.tsx']) {
      const result = await compileTarget(root, { id: 'empty', kind: 'request', source, hints: { repeat: 12 } });
      assert.ok(result.artifact.diagnostics.some(d => d.code === 'EMPTY_STATE'));
      assert.doesNotMatch(result.artifact.variants.default.html, /<article/);
      const explicit = await compileTarget(root, { id: 'empty', kind: 'request', source, hints: { bindings: { 'total > 0': false } } });
      assert.deepEqual(explicit.artifact.diagnostics, []);
      const named = await compileTarget(root, { id: 'empty', kind: 'request', source, hints: { bindings: { total: 0 } } });
      assert.deepEqual(named.artifact.diagnostics, []);
    }
  });
});

test('guarded optional slots, h overloads and opaque mount points retain their finite source semantics', async () => {
  await fixture({
    'Frame.ts': `import{h,defineComponent}from'vue';export default defineComponent({render(){return h('section',null,[this.$slots.header && this.$slots.header(),this.$slots.default?.(),h('div',h('b',null,'Data')),h('div',{ref:'chart',style:{height:'280px'}})])}})`,
  }, async root => {
    const { artifact } = await compileTarget(root, { id: 'optional', source: 'Frame.ts' });
    assert.match(artifact.variants.default.html, /<b/);
    assert.match(artifact.variants.default.html, /data-sk-text-content="Data"/);
    assert.match(artifact.variants.default.html, /data-sk-opaque data-sk-leaf/);
    assert.match(artifact.variants.default.html, /height:280px/);
    assert.equal(artifact.diagnostics.length, 1);
    assert.match(artifact.diagnostics[0].message, /Opaque native mount point/);
  });
});

test('render-only SFC diagnostics point to original script lines', async () => {
  await fixture({
    'View.vue': `<!-- license -->\n\n<script lang="ts">\nimport { h, defineComponent } from 'vue';\nexport default defineComponent({\n  render() {\n    return h('main', null, runBusiness());\n  }\n});\n</script>`,
  }, async root => {
    const { artifact } = await compileTarget(root, { id: 'location', source: 'View.vue' });
    const diagnostic = artifact.diagnostics.find(d=>d.message.includes('runBusiness'));
    assert.equal(diagnostic?.line, 7);
  });
});
