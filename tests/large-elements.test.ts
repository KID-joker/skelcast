import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { compileTarget } from '../src/compiler/index.js';

test('graphics keep their source viewport without traversing chart internals in all frontends', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-large-elements-'));
  try {
    const cases = {
      'View.tsx': 'export default()=> <main><svg className="chart" viewBox="0 0 640 320" style={{width:"100%",height:"auto"}}><MissingChart/><text>Revenue</text></svg><canvas width={640} height={320}><MissingChart/></canvas><p>After chart</p></main>',
      'View.vue': '<template><main><svg class="chart" viewBox="0 0 640 320" style="width:100%;height:auto"><MissingChart/><text>Revenue</text></svg><canvas width="640" height="320"><MissingChart/></canvas><p>After chart</p></main></template>',
      'Render.ts': 'import {h} from "vue";export default()=>h("main",null,[h("svg",{class:"chart",viewBox:"0 0 640 320",style:{width:"100%",height:"auto"}},[h(MissingChart),h("text",null,"Revenue")]),h("canvas",{width:640,height:320},[h(MissingChart)]),h("p",null,"After chart")])',
      'HTML.vue': '<template><main v-html="\'<svg class=&quot;chart&quot; viewBox=&quot;0 0 640 320&quot; style=&quot;width:100%;height:auto&quot;><text>Revenue</text></svg><canvas width=&quot;640&quot; height=&quot;320&quot;>Fallback detail</canvas><p>After chart</p>\'"></main></template>',
    };
    for (const [source, code] of Object.entries(cases)) {
      await writeFile(path.join(root, source), code);
      const { artifact } = await compileTarget(root, { id: 'graphics', source });
      const { html } = artifact.variants.default;
      assert.match(html, /<svg[^>]*viewbox="0 0 640 320"[^>]*data-sk-leaf[^>]*><\/svg>/);
      assert.match(html, /<canvas[^>]*width="640" height="320"[^>]*data-sk-leaf[^>]*><\/canvas>/);
      assert.match(html, source === 'HTML.vue' ? /<p[^>]*><span/ : /<p[^>]*>After chart<\/p>/);
      assert.doesNotMatch(html, /MissingChart|Revenue|Fallback detail/);
      assert.deepEqual(artifact.diagnostics, [], source);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native tables stop at their outline while outer controls and preserved graphics retain policy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-large-cells-'));
  try {
    const markup = '<button>Refresh</button><table><thead><tr><th>Name</th><th>Actions</th></tr></thead><tbody><tr><td colspan="1" rowspan="2">Long value</td><td><button>Delete</button><button data-sk-preserve>Keep</button></td></tr></tbody></table><svg data-sk-preserve width="24" height="24"><title>Preserved</title></svg>';
    for (const [source, code] of Object.entries({
      'View.tsx': `export default()=> <>${markup.replace('colspan=', 'colSpan=').replace('rowspan=', 'rowSpan=')}</>`,
      'View.vue': `<template>${markup}</template>`,
    })) {
      await writeFile(path.join(root, source), code);
      const { artifact } = await compileTarget(root, { id: 'cells', source });
      const { html } = artifact.variants.default;
      assert.match(html, /<button[^>]*data-sk-control[^>]*>Refresh<\/button>/);
      assert.match(html, /<th[^>]*>Name<\/th>/);
      assert.doesNotMatch(html, /rowspan|Delete|Long value|Keep/);
      assert.equal((html.match(/<td /g)??[]).length,8);
      assert.match(html, /<svg[^>]*data-sk-preserve[^>]*><title[^>]*>Preserved<\/title><\/svg>/);
      assert.deepEqual(artifact.diagnostics, []);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
