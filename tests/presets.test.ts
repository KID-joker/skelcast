import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse } from '@vue/compiler-dom';
import { compileTarget } from '../src/compiler/index.js';
import { analyzeQuality } from '../src/quality.js';
import { projectFromConfig } from '../src/generator.js';
async function fixture(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-presets-'));
  try {
    for (const [name, code] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), code);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function elements(html: string) {
  const result: any[] = [];
  const walk = (n: any) => {
    if (n.type === 1) result.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(parse(html));
  return result;
}
const has = (n: any, name: string) => n.props.some((p: any) => p.name === name);
const presetOptions = {
  componentPresets: ['element-plus', 'ant-design-vue', 'antd'] as (
    | 'element-plus'
    | 'ant-design-vue'
    | 'antd'
  )[],
};

test('preset-owned elements retain layout markers without changing source slot box models or duplicating leaf markers', async () => {
  await fixture({
    'View.vue': `<script setup>
      import {ElCard,ElTable,ElTableColumn,ElInput,ElPagination,ElStatistic} from 'element-plus';
      import {NCode,NGrid,NScrollbar,NFormItem} from 'naive-ui';
    </script><template>
      <ElCard header="Heading"><article class="source-content">Source text</article></ElCard>
      <ElTable><ElTableColumn label="Name"/></ElTable>
      <ElInput readonly/><ElInput data-sk-mask/><ElStatistic :value="12"/>
      <ElPagination layout="total, sizes, prev, pager, next, jumper, ->, slot"><aside class="source-content">Footer</aside></ElPagination>
      <NCode code="first&#10;second"/><NGrid cols="1 s:2"><section class="source-content">Grid</section></NGrid>
      <NScrollbar x-scrollable><NFormItem label="Field"><input readonly></NFormItem></NScrollbar>
    </template>`,
  }, async root => {
    const { artifact } = await compileTarget(root, { id: 'markers', source: 'View.vue' }, {}, { componentPresets: ['element-plus', 'naive-ui'] });
    const els = elements(artifact.variants.default.html);
    const owned = els.filter(node => !has(node, 'data-sk-node') && !has(node, 'data-sk-artifact'));
    assert.ok(owned.length > 20);
    assert.ok(owned.every(node => has(node, 'data-sk-layout')), 'primitive wrappers use border-box');
    const source = els.filter(node => node.props.some((p: any) => p.name === 'class' && p.value?.content === 'source-content'));
    assert.equal(source.length, 3);
    assert.ok(source.every(node => !has(node, 'data-sk-layout')), 'source slots keep their source box model');
    assert.ok(els.every(node => node.props.filter((p: any) => p.name === 'data-sk-leaf').length <= 1));
    assert.ok(els.some(node => node.props.some((p: any) => p.name === 'class' && p.value?.content === 'el-pagination__total is-first')));
    assert.deepEqual(artifact.diagnostics.filter(row => row.code === 'FALLBACK'), []);
  });
});

test('Element Plus keeps controls and masks only table data, with import-identity gating', async () => {
  await fixture(
    {
      'View.vue': `<script setup>import {ElButton as Action,ElCalendar,ElTable,ElTableColumn,ElStatistic} from 'element-plus';const rows=privateAPI();throw new Error('never run')</script><template><Action @click="danger()">Refresh</Action><ElCalendar/><ElTable :data="rows"><ElTableColumn label="Name" prop="name" :width="180"/><ElTableColumn label="Count" prop="count"/><ElTableColumn label="Actions"><template #default><Action @click="danger()">Delete</Action></template></ElTableColumn></ElTable><ElStatistic title="Total" :value="total"/><el-button>Unregistered</el-button></template>`,
    },
    async (root) => {
      const { artifact } = await compileTarget(root, { id: 'el', source: 'View.vue' }, {}, presetOptions);
      const html = artifact.variants.default.html,
        els = elements(html);
      const button = els.find((n) => n.tag === 'button');
      assert.ok(has(button, 'data-sk-control'));
      assert.ok(!has(button, 'data-sk-leaf'));
      assert.match(button.loc.source, />Refresh<\/button>/);
      assert.equal(els.filter((n) => has(n, 'data-sk-calendar-cell')).length, 42);
      const table = els.find((n) => has(n, 'data-sk-data-table'));
      assert.ok(table);
      assert.equal(elements(table.loc.source).filter((n) => n.tag === 'th').length, 3);
      assert.equal(elements(table.loc.source).filter((n) => n.tag === 'td').length, 12);
      assert.match(html, />Name<\/div><\/th>/);
      const actions=elements(table.loc.source).filter(n=>n.tag==='button');
      assert.equal(actions.length,4);
      assert.ok(actions.every(n=>!has(n,'data-sk-leaf')&&n.loc.source.includes('Delete')));
      assert.doesNotMatch(html, /danger|privateAPI|never run/);
      assert.equal(artifact.diagnostics.filter((d) => d.code === 'FALLBACK').length, 1);
      assert.ok(
        artifact.diagnostics.some((d) => d.code === 'PRESET_LIMIT' && d.message.includes('Calendar')),
      );
    },
  );
});

test('Ant Design supports React compound components and deep imports without executing render callbacks', async () => {
  await fixture(
    {
      'View.tsx': `import {Card,Button,Form,Input,Table,Calendar,List} from 'antd';import Deep from 'antd/es/button';import * as UI from 'antd';import * as ui from 'antd';throw new Error('never run');export default function View({rows}){return <Card><Button>Reload</Button><Deep>Deep</Deep><ui.Button>Lower</ui.Button><Form.Item label="Name"><Input value="initial" /></Form.Item><Table dataSource={rows} columns={[{title:'Name',dataIndex:'name',render:()=>danger()},{title:'Count',dataIndex:'count'}]} /><Table dataSource={rows}><Table.Column title="Code" dataIndex="code"/></Table><UI.Calendar/><List dataSource={rows} renderItem={()=>danger()}/></Card>}`,
    },
    async (root) => {
      const { artifact } = await compileTarget(
        root,
        { id: 'ant', source: 'View.tsx', hints: { repeat: 3 } },
        {},
        presetOptions,
      );
      const html = artifact.variants.default.html,
        els = elements(html);
      assert.equal(artifact.diagnostics.filter((d) => d.code === 'FALLBACK').length, 0);
      assert.equal(els.filter((n) => has(n, 'data-sk-data-table')).length, 2);
      assert.equal(els.filter((n) => n.tag === 'td').length, 9);
      assert.equal(els.filter((n) => n.tag === 'button' && !has(n, 'data-sk-leaf')).length, 3);
      assert.match(html, />Reload<\/button>/);
      assert.match(html, />Deep<\/button>/);
      assert.match(html, /value="initial"/);
      assert.equal(els.filter((n) => has(n, 'data-sk-calendar-cell')).length, 42);
      assert.ok(artifact.diagnostics.some((d) => d.message.includes('renderItem')));
      assert.ok(artifact.diagnostics.some((d) => d.message.includes('column renderers')));
      assert.doesNotMatch(html, /danger|never run/);
    },
  );
});

test('table columns follow forwarded children, retain escaped content and stay scoped to nested tables', async () => {
  await fixture({
    'Forward.vue': '<template><section><slot/></section></template>',
    'Forward.tsx': 'export default ({children}) => <section>{children}</section>',
    'View.vue': `<script setup>import {ElTable,ElTableColumn,ElButton,ElInput} from 'element-plus';import Forward from './Forward.vue'</script><template>
      <ElTable><Forward><ElTableColumn label="Name &amp; &quot;code&quot; &lt;tag&gt;" prop="name" :width="180"/></Forward><ElTableColumn label="Actions"><ElButton>Open &amp; inspect</ElButton></ElTableColumn></ElTable>
      <ElTable><ElInput><ElTableColumn label="Discarded"/></ElInput></ElTable>
      <ElTable :columns="[{title:'Explicit'}]"><ElTableColumn label="Ignored"/></ElTable>
      <ElTable><ElTableColumn label="Outer"><ElTable><ElTableColumn label="Inner"/></ElTable></ElTableColumn></ElTable>
    </template>`,
    'View.tsx': `import {Table,Button,Input} from 'antd';import Forward from './Forward';export default () => <>
      <Table><Forward><Table.Column title={'Name & "code" <tag>'} dataIndex="name" width={180}/></Forward><Table.Column title="Actions"><Button>Open &amp; inspect</Button></Table.Column></Table>
      <Table><Input><Table.Column title="Discarded"/></Input></Table>
      <Table columns={[{title:'Explicit'}]}><Table.Column title="Ignored"/></Table>
      <Table><Table.Column title="Outer"><Table><Table.Column title="Inner"/></Table></Table.Column></Table>
    </>`,
  }, async root => {
    for (const source of ['View.vue', 'View.tsx']) {
      const { artifact } = await compileTarget(root, { id: 'columns', source, hints: { repeat: 1 } }, {}, presetOptions);
      const html = artifact.variants.default.html;
      const tables = elements(html).filter(node => has(node, 'data-sk-data-table'));
      assert.equal(tables.length, 5);
      const headers = tables.map(table => elements(table.loc.source).filter(node => node.tag === 'th'));
      assert.deepEqual(headers.map(nodes => nodes.length), [2, 3, 1, 2, 1]);
      assert.match(headers[0][0].loc.source, /Name &amp; &quot;code&quot; &lt;tag&gt;/);
      assert.match(headers[0][1].loc.source, /Actions/);
      assert.match(headers[2][0].loc.source, /Explicit/);
      assert.match(headers[3][0].loc.source, /Outer/);
      assert.match(headers[4][0].loc.source, /Inner/);
      assert.match(html, />Open &amp; inspect<\/button>/);
      assert.doesNotMatch(html, /Discarded|Ignored|skelcast-column:|data-sk-column|data-cell=/);
      assert.equal(artifact.diagnostics.filter(row => row.code === 'FALLBACK').length, 0);
    }
  });
});

test('Vue declarations and exact deep import paths enable common libraries, not lookalike packages', async () => {
  await fixture(
    {
      'View.vue': `<script setup>import Button from 'ant-design-vue/es/button';import Field from 'element-plus/es/components/input';import {Button as Fake} from 'ant-design-vue-lookalike'</script><template><Button>Search</Button><Field placeholder="Filter"/><a-table :columns="[{title:'Title',dataIndex:'title'}]"/><el-table><el-table-column label="Title"/></el-table><Fake/></template>`,
      'components.d.ts': `declare module 'vue'{interface GlobalComponents{ATable:typeof import('ant-design-vue')['Table'];ElTable:typeof import('element-plus/es')['ElTable'];ElTableColumn:typeof import('element-plus/es')['ElTableColumn']}}`,
    },
    async (root) => {
      const { artifact } = await compileTarget(root, { id: 'decl', source: 'View.vue' }, {}, presetOptions);
      assert.equal(
        elements(artifact.variants.default.html).filter((n) => has(n, 'data-sk-data-table')).length,
        2,
      );
      assert.equal(artifact.diagnostics.filter((d) => d.code === 'FALLBACK').length, 1);
      const disabled = await compileTarget(root, { id: 'decl', source: 'View.vue' });
      assert.ok(disabled.artifact.diagnostics.filter((d) => d.code === 'FALLBACK').length >= 4);
    },
  );
});

test('native/local controls retain static slot text in both frameworks and explicit policies override defaults', async () => {
  await fixture(
    {
      'View.vue': `<script setup>import Local from './Button.vue';import {ElButton,ElCard} from 'element-plus';const name='Keep';</script><template><Local>Save</Local><label>Name</label><input placeholder="Search"><input readonly placeholder="Hidden placeholder" value="Output"><section data-sk-preserve><h2>Static heading</h2><p>{{name}}</p></section><ElButton data-sk-mask>Hidden</ElButton><ElCard data-sk-preserve><span class="forced-data" data-sk-mask>Dynamic</span><b>Fixed</b></ElCard></template>`,
      'Button.vue': `<template><button><slot/></button></template>`,
      'View.tsx': `import Local from './Button';import {Button,Card} from 'antd';export default ()=> <><Local>Save</Local><Button data-sk-preserve>Keep</Button><Button data-sk-mask>Hidden</Button><input placeholder="Search"/><Card data-sk-preserve><span className="forced-data" data-sk-mask>Dynamic</span><b>Fixed</b></Card></>`,
      'Button.tsx': `export default ({children})=><button>{children}</button>`,
    },
    async (root) => {
      for (const source of ['View.vue', 'View.tsx']) {
        const { artifact } = await compileTarget(root, { id: 'policy', source }, {}, presetOptions);
        const html = artifact.variants.default.html,
          els = elements(html);
        assert.match(html, />Save<\/button>/);
        assert.doesNotMatch(html, />Hidden<\/button>/);
        assert.ok(els.some((n) => n.tag === 'button' && has(n, 'data-sk-leaf')));
        assert.ok(els.some((n) => n.tag === 'button' && !has(n, 'data-sk-leaf')));
        assert.doesNotMatch(html, /onclick|onClick/);
        const forced=els.find(n=>n.props.some((p:any)=>p.name==='class'&&p.value?.content==='forced-data'));
        assert.ok(elements(forced.loc.source).some(n=>has(n,'data-sk-leaf')));
        assert.match(html,/>Fixed<\/b>/);
        if (source.endsWith('vue')) {
          assert.match(html, />Static heading<\/h2>/);
          assert.match(html, />Keep<\/p>/);
          assert.doesNotMatch(html, /value="Output"|placeholder="Hidden placeholder"/);
          assert.ok(els.some((n) => n.tag === 'input' && has(n, 'readonly') && has(n, 'data-sk-leaf')));
        }
      }
    },
  );
});

test('control-only output is valid and static empty table data does not invent rows', async () => {
  await fixture(
    {
      'Controls.vue': `<script setup>import {ElButton,ElCalendar} from 'element-plus'</script><template><ElButton>Submit</ElButton><ElCalendar/></template>`,
      'Empty.tsx': `import{Table}from'antd';export default()=> <Table dataSource={[]} columns={[{title:'Name',dataIndex:'name'}]}/>`,
    },
    async (root) => {
      const { artifact } = await compileTarget(
        root,
        { id: 'controls', source: 'Controls.vue' },
        {},
        presetOptions,
      );
      const q = analyzeQuality(artifact);
      assert.equal(q.variants.default.placeholders, 0);
      assert.ok(q.variants.default.preservedNodes > 0);
      assert.ok(!q.variants.default.issues.some((i) => i.includes('EMPTY_SKELETON')));
      const empty = await compileTarget(root, { id: 'empty', source: 'Empty.tsx' }, {}, presetOptions);
      assert.match(empty.artifact.variants.default.html, />No data<\/td>/);
      assert.equal(elements(empty.artifact.variants.default.html).filter((n) => n.tag === 'td').length, 1);
      await projectFromConfig(root, { targets: [{ id: 'x', source: 'Controls.vue' }], ...presetOptions });
    },
  );
});
