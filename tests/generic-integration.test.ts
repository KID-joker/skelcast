import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { compileTarget } from '../src/compiler/index.js';
import { BuildAssets } from '../src/compiler/build-assets.js';
import { initProject } from '../src/init/index.js';

async function fixture(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-generic-'));
  try {
    for (const [name, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('Vue templates expand local TSX column components and confirmed lower-case library tags without running callbacks', async () => {
  await fixture({
    'View.vue': `<script setup lang="tsx">import {ElTable,ElTableColumn} from 'element-plus';const Cell=(column)=> <ElTableColumn {...column}>{{default:()=>{throw Error('never execute')}}}</ElTableColumn>;const cols=[{prop:'a',label:'Alpha',width:120},{prop:'b',label:'Beta',width:240}]</script><template><ElTable :data="unknown"><Cell v-for="col in cols" :key="col.prop" v-bind="col"/></ElTable></template>`,
  }, async root => {
    const { artifact } = await compileTarget(root, { id: 'columns', source: 'View.vue' }, {}, { componentPresets: ['element-plus'] });
    assert.match(artifact.variants.default.html, /Alpha/); assert.match(artifact.variants.default.html, /Beta/);
    assert.equal((artifact.variants.default.html.match(/<th\b/g) ?? []).length, 2);
  });
});
test('local interface props retain absent optional dimensions for an opaque mount host', async () => {
  await fixture({
    'Mount.vue': `<script setup lang="ts">import {computed,ref}from'vue';interface Props{width?:number;height?:number}const props=defineProps<Props>();const mount=ref();const style=computed(()=>props.width||props.height?{width:props.width+'px',height:props.height+'px'}:{width:'100%',height:'100%'});</script><template><div ref="mount" :style="style"/></template>`,
    'View.vue': `<script setup>import Mount from './Mount.vue'</script><template><section style="height:280px"><Mount/></section></template>`,
  }, async root => {
    const { artifact } = await compileTarget(root, { id: 'mount', source: 'View.vue' });
    assert.match(artifact.variants.default.html, /width:100%;height:100%/);
    assert.ok(!artifact.diagnostics.some(d => d.code === 'LAYOUT_UNKNOWN'));
  });
});
test('production resources deduplicate by bytes and retain portable inspection artifacts and relative deployment URLs', async () => {
  await fixture({ 'View.vue': '<template><p>Data</p></template>' }, async root => {
    const { artifact } = await compileTarget(root, { id: 'asset', source: 'View.vue' });
    const uri = 'data:font/woff2;base64,' + Buffer.from('font contents').toString('base64');
    artifact.variants.default.css = `@font-face{font-family:a;src:url("${uri}")} .x{background:url("${uri}#face")}`;
    const assets = new BuildAssets(); let count = 0;
    const built = assets.externalize(artifact, () => { count++; return 'ref1'; });
    assert.equal(count, 1); assert.ok(artifact.variants.default.css.includes(uri));
    assert.ok(!built.variants.default.css.includes('base64'));
    const code = assets.chunk(`export default ${JSON.stringify(built)}`, 'assets/js/view.js', () => 'assets/font.woff2')!;
    assert.match(code, /new URL\("\.\.\/font.woff2",import.meta.url\)\.href/);
    assert.doesNotMatch(code, /__SKELCAST_ASSET_/);
    assert.match(assets.html(built.variants.default.css, 'nested/index.html', './', () => 'assets/font.woff2'), /\.\.\/assets\/font.woff2#face/);
  });
});
test('init understands a source-declared cwd root and upgrades legacy ESM resolution without executing the config', async () => {
  await fixture({
    'package.json': JSON.stringify({ dependencies: { vue: '^3.5', vite: '^6', skelcast: '*' } }),
    'vite.config.ts': `import {defineConfig}from'vite';throw Error('never execute');export default defineConfig(()=>{const directory=process.cwd();return {root:directory}})`,
    'tsconfig.json': '{"compilerOptions": {"module":"ESNext",/* keep */"moduleResolution":"Node"}}',
    'src/App.vue': '<template><main>Data</main></template>',
  }, async root => {
    const result = await initProject(root, { dryRun: true });
    assert.ok(result.targets.length);
    assert.ok(!result.diagnostics.some(d => d.code === 'VITE_ROOT_DYNAMIC'));
    const change = result.changes.find(c => c.file === 'tsconfig.json')!;
    assert.match(change.after, /\/\* keep \*\//); assert.match(change.after, /"moduleResolution":"Bundler"/);
    assert.ok(result.diagnostics.some(d => d.code === 'PAGE_PREVIEW_ONLY'));
  });
});
test('source-proven request state handles overlapping requests and failures and init remains idempotent', async () => {
  await fixture({
    'package.json': JSON.stringify({ type: 'module', dependencies: { vue: '^3.5', vite: '^6', skelcast: '*' } }),
    'vite.config.mjs': 'export default {}',
    'src/feed.ts': `import{reactive,toRefs}from'vue';export const useFeed=(fetcher)=>{const state=reactive({items:[]});const refresh=async()=>{const {data}=await fetcher();state.items=data.items;};return{...toRefs(state),refresh}}`,
    'src/App.vue': `<script setup>import{useFeed}from'./feed';const{items,refresh}=useFeed(fetchData);</script><template><table :data="items"><tr><td>Data</td></tr></table></template>`,
  }, async root => {
    await symlink(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
    const result = await initProject(root);
    assert.ok(result.targets.some(t => t.kind === 'page'));
    assert.ok(result.changes.some(c => c.file === 'src/feed.ts'));
    const { useFeed } = await import(pathToFileURL(path.join(root, 'src/feed.ts')).href);
    const finish: ((value: unknown) => void)[] = [];
    const feed = useFeed(() => new Promise(resolve => finish.push(resolve)));
    const pending = feed[Object.keys(feed).find(k => k.startsWith('__skelcastPending'))!];
    const first = feed.refresh(), second = feed.refresh();
    assert.equal(pending.value, true);
    finish[0]({ data: { items: [1] } }); await first; assert.equal(pending.value, true);
    finish[1]({ data: { items: [2] } }); await second; assert.equal(pending.value, false);
    const failed = useFeed(() => Promise.reject(new Error('fixture error')));
    await assert.rejects(failed.refresh(), /fixture error/);
    assert.equal(failed[Object.keys(failed).find(k => k.startsWith('__skelcastPending'))!].value, false);
    assert.equal((await initProject(root)).changes.length, 0);
  });
});
test('source viewport handlers produce media queries and layout dependencies retain identity', async () => {
  await fixture({
    'Panel.vue': `<script setup>import{ref,computed}from'vue';const size=ref('wide');const resize=e=>{const w=e.target.innerWidth;switch(!!w){case w<700:size.value='narrow';break;case w>=700:size.value='wide';break;}};window.addEventListener('resize',resize);const columns={narrow:1,wide:3};const style=computed(()=>({display:'grid',gridTemplateColumns:'repeat('+columns[size.value]+',1fr)'}))</script><template><section :style="style"><p>Data</p></section></template>`,
  }, async root => {
    const { artifact } = await compileTarget(root, { id: 'responsive', source: 'Panel.vue' });
    assert.match(artifact.variants.default.css, /min-width:700px/);
    assert.match(artifact.variants.default.css, /repeat\(1,1fr\)/);
    assert.match(artifact.variants.default.css, /repeat\(3,1fr\)/);
    assert.match(artifact.variants.default.html, /sk-viewport-/);
  });
});
test('finite slot initialization and immediate injection watchers preserve collapsed source structure', async () => {
  await fixture({
    'Grid.vue': `<script setup>import{ref,useSlots,onBeforeMount,provide}from'vue';const props=defineProps({limit:Number});const edge=ref(-1);const slots=useSlots().default();const arrange=()=>{const cells=[];slots.forEach(v=>{if(Array.isArray(v.children))cells.push(...v.children)});cells.forEach((v,index)=>{if(index>=props.limit&&edge.value===-1)edge.value=index})};onBeforeMount(()=>arrange());provide('cut',edge)</script><template><section><slot/></section></template>`,
    'Cell.vue': `<script setup>import{ref,inject,watch}from'vue';const props=defineProps({index:Number});const cut=inject('cut',ref(-1));const visible=ref(true);watch(()=>cut.value,value=>{if(value>=0&&props.index>=value)visible.value=false},{immediate:true})</script><template><p v-show="visible">{{props.index}}</p></template>`,
    'View.vue': `<script setup>import Grid from'./Grid.vue';import Cell from'./Cell.vue'</script><template><Grid :limit="2"><Cell v-for="(item,index) in [0,1,2,3]" :index="index"/></Grid></template>`,
  }, async root => {
    const { artifact } = await compileTarget(root, { id:'collapsed',source:'View.vue' });
    assert.match(artifact.variants.default.html,/data-sk-text-content="0"/);
    assert.match(artifact.variants.default.html,/data-sk-text-content="1"/);
    assert.doesNotMatch(artifact.variants.default.html,/data-sk-text-content="[23]"/);
    assert.ok(artifact.diagnostics.some(d=>d.code==='LAYOUT_PROJECTION'));
  });
});
test('layout initialization refuses input mutation and opaque effects instead of executing application code', async () => {
  await fixture({
    'Grid.vue': `<script setup>import{ref,useSlots,onBeforeMount}from'vue';const props=defineProps({items:Array});const slots=useSlots().default();const active=ref(false);onBeforeMount(()=>{props.items.push(999);active.value=true})</script><template><section><p v-for="item in props.items">{{item}}</p><slot/></section></template>`,
    'View.vue': `<script setup>import Grid from'./Grid.vue'</script><template><Grid :items="[1,2]"><span>Child</span></Grid></template>`,
  }, async root => {
    const { artifact } = await compileTarget(root, {id:'readonly',source:'View.vue'});
    assert.doesNotMatch(artifact.variants.default.html,/data-sk-text-content="999"/);
    assert.ok(artifact.diagnostics.some(d=>d.code==='LAYOUT_UNKNOWN'));
  });
});
test('Vue JSX slot objects and source-proven function props retain origin, column geometry and inert controls', async () => {
  await fixture({
    'fields.tsx': `export const fields=[{render:({height})=><aside style={{height}}>Field data</aside>}];throw Error('never import this module')`,
    'View.vue': `<script setup lang="tsx">import{ElTable,ElTableColumn,ElButton}from'element-plus';import{fields}from'./fields';const Cell=()=> <ElTableColumn label="Label">{{default:()=> <ElButton>Action</ElButton>}}</ElTableColumn></script><template><main><component :is="fields[0].render" :height="80"/><ElTable :data="unknown"><Cell/></ElTable></main></template>`,
  }, async root => {
    const { artifact } = await compileTarget(root,{id:'render-fields',source:'View.vue'}, {}, {componentPresets:['element-plus']});
    assert.match(artifact.variants.default.html,/height:80px/);
    assert.ok(Object.values(artifact.sources).some(source=>source.file==='fields.tsx'));
    assert.match(artifact.variants.default.html,/el-button/);
    assert.match(artifact.variants.default.html,/min-width:80px/);
  });
});
test('field projections preserve explicit undefined Vue defaults and optional array calls without executing arbitrary helpers', async () => {
  await fixture({
    'Box.vue': `<script setup lang="ts">const props=withDefaults(defineProps<{size?:number}>(),{size:42})</script><template><article :style="{height:props.size+'px'}"/></template>`,
    'View.vue': `<script setup>import Box from'./Box.vue';const project=item=>({size:item?.size});const rows=[{size:undefined}];const filtered=rows?.filter(item=>true);</script><template><Box v-for="row in filtered" v-bind="project(row)"/></template>`,
  }, async root => {
    const { artifact } = await compileTarget(root,{id:'fields',source:'View.vue'});
    assert.match(artifact.variants.default.html,/height:42px/);
  });
});
test('finite read-only key helpers forward named Vue slots and unknown cell calls retain text geometry', async () => {
  await fixture({
    'keys.ts': `export function tail(key:string){const bits=key.split('.');if(bits.length===1)return key;return bits[bits.length-1]}export function unsafe(value){value.push(7);return value}throw Error('never import')`,
    'Cell.vue': `<script setup lang="tsx">import{useSlots}from'vue';import{ElTableColumn}from'element-plus';import{tail}from'./keys';const props=defineProps({field:String});const slots=useSlots();const Cell=()=> <ElTableColumn label="Field">{{default:()=>{if(slots[tail(props.field)])return slots[tail(props.field)]();return formatRemote(value)}}}</ElTableColumn></script><template><Cell/></template>`,
    'View.vue': `<script setup>import{ElTable,ElButton}from'element-plus';import Cell from'./Cell.vue'</script><template><ElTable :data="unknown"><Cell field="a.action"><template #action><ElButton>Inspect</ElButton></template></Cell><Cell field="missing"/></ElTable></template>`,
  }, async root => {
    const {artifact}=await compileTarget(root,{id:'slot-key',source:'View.vue'},{},{componentPresets:['element-plus']});
    assert.match(artifact.variants.default.html,/el-button/);
    assert.doesNotMatch(artifact.variants.default.html,/data-sk-fallback/);
    assert.ok(artifact.diagnostics.some(d=>d.code==='PRESET_LIMIT'&&d.message.includes('data-slot')));
  });
});
test('request instrumentation keeps multiple hook instances distinct and skips explicit return contracts', async () => {
  const hook=(name:string,typed=false)=>`export const ${name}=(api)${typed?': Contract':''}=>{const state=reactive({items:[]});const refresh=async()=>{const {data}=await api();state.items=data.items};return{...toRefs(state),refresh}};`;
  await fixture({
    'package.json':JSON.stringify({dependencies:{vue:'^3.5',vite:'^6',skelcast:'*'}}),
    'vite.config.mjs':'export default {}',
    'src/hooks.ts':`import{reactive,toRefs}from'vue';${hook('useFirst')}${hook('useSecond')}${hook('useTyped',true)}`,
    'src/App.vue':`<script setup>import{useFirst,useSecond}from'./hooks';const{items:a}=useFirst(api);const{items:b}=useSecond(api)</script><template><main><section :data="a"/><section :data="b"/></main></template>`,
  },async root=>{
    const result=await initProject(root,{dryRun:true});
    const hooks=result.changes.find(c=>c.file==='src/hooks.ts')!.after;
    const app=result.changes.find(c=>c.file==='src/App.vue')!.after;
    assert.equal((hooks.match(/skelcast:request-state/g)||[]).length,2);
    const names=[...app.matchAll(/v-loading="([^"]+)"/g)].map(match=>match[1]);
    // analyzeVue consumes v-loading into boundary pending attributes.
    const pending=[...app.matchAll(/:pending="(__skelcastPending[^"]*)"/g)].map(match=>match[1]);
    assert.equal(new Set([...names,...pending]).size,2);
    assert.match(hooks,/useTyped=\(api\): Contract=>\{const state/);
  });
});
test('viewport projection refuses incompatible switch discriminants or independently mutated state',async()=>{
  for(const extra of ['','size.value="other";'])await fixture({
    'View.vue':`<script setup>import{ref}from'vue';const size=ref('wide');const resize=e=>{const w=e.target.innerWidth;switch(${extra?'!!w':'false'}){case w<700:size.value='narrow';break;case w>=700:size.value='wide';break;}};window.addEventListener('resize',resize);${extra}</script><template><section :style="{width:size==='wide'?'400px':'200px'}">Data</section></template>`,
  },async root=>{const{artifact}=await compileTarget(root,{id:'negative',source:'View.vue'});assert.doesNotMatch(artifact.variants.default.css,/min-width:700px/)});
});
test('build defines project JSON fields from the exported config without executing config helpers',async()=>{
 await fixture({'package.json':JSON.stringify({dependencies:{alpha:'1',beta:'2'}}),'vite.config.mjs':`import{defineConfig}from'vite';import pkg from'./package.json';const info={pkg,stamp:clock()};throw Error('never execute');export default defineConfig(()=>({define:{APP:JSON.stringify(info)}}))`,'View.vue':'<script setup>const {pkg}=APP</script><template><main><p v-for="(value,key) in pkg.dependencies">{{key}}: {{value}}</p></main></template>'},async root=>{const{artifact,dependencies}=await compileTarget(root,{id:'defines',source:'View.vue'});assert.match(artifact.variants.default.html,/alpha/);assert.match(artifact.variants.default.html,/beta/);assert.ok(dependencies['package.json']);assert.ok(dependencies['vite.config.mjs'])});
 await fixture({'vite.config.mjs':`const unused={define:{APP:JSON.stringify({visible:false})}};export default {}`,'View.vue':'<template><p v-if="APP.visible">Uncertain</p></template>'},async root=>{const{artifact}=await compileTarget(root,{id:'unused',source:'View.vue'});assert.ok(artifact.diagnostics.some(d=>d.code==='BRANCH_DEFAULT'))});
});
test('initial recursive column defaults preserve both grouped source trees and flat projections',async()=>{
 await fixture({
 'Search.vue':`<script setup>defineProps({columns:Array})</script><template><aside v-if="columns.length">Search present</aside></template>`,
 'Cell.vue':`<script setup lang="tsx">import{ElTableColumn}from'element-plus';defineProps({column:Object});const Col=item=><>{item.visible&&<ElTableColumn label={item.label}>{{default:()=>{if(item.children)return item.children.map(child=>Col(child));return format(value)}}}</ElTableColumn>}</>;</script><template><Col v-bind="column"/></template>`,
 'View.vue':`<script setup>import{reactive,computed}from'vue';import{ElTable}from'element-plus';import Cell from'./Cell.vue';import Search from'./Search.vue';const props=defineProps({columns:Array});const tree=reactive(props.columns);const flat=computed(()=>normalize(tree));const fields=computed(()=>flat.value.filter(row=>row.search?.el).sort((a,b)=>0));const normalize=(rows,out=[])=>{rows.forEach(async row=>{if(row.children?.length)out.push(...normalize(row.children));out.push(row);row.visible=row.visible??true;await decorate(row)});return out.filter(row=>!row.children?.length)};</script><template><Search :columns="fields"/><ElTable :data="flat"><Cell v-for="item in tree" :column="item"/></ElTable></template>`,
 'Page.vue':`<script setup>import View from'./View.vue'</script><template><View :columns="[{label:'Group',children:[{label:'Child'}]}]"/></template>`},async root=>{const{artifact}=await compileTarget(root,{id:'nested-defaults',source:'Page.vue',kind:'request'},{},{componentPresets:['element-plus']});assert.match(artifact.variants.default.html,/Group/);assert.match(artifact.variants.default.html,/Child/);assert.doesNotMatch(artifact.variants.default.html,/Search present/)});
});
test('optional field reads on finite primitive values preserve known filter membership',async()=>{
 await fixture({'View.vue':`<script setup>const columns=[{label:'Skip',search:''},{label:'Keep',search:{el:'input'}}];const fields=columns.filter(item=>item.search?.el||item.search?.render)</script><template><p v-for="item in fields">{{item.label}}</p></template>`},async root=>{const{artifact}=await compileTarget(root,{id:'primitive-members',source:'View.vue'});assert.match(artifact.variants.default.html,/Keep/);assert.doesNotMatch(artifact.variants.default.html,/Skip/);assert.doesNotMatch(artifact.variants.default.html,/data-sk-fallback/)});
});
test('boolean layout guards absorb a known false operand without claiming unknown values are bindings',async()=>{
 await fixture({'View.vue':`<script setup>const fields=[];const mode=externalState</script><template><aside v-if="mode.enabled && fields.length">Must be absent</aside><p v-if="mode.enabled || true">Present</p></template>`},async root=>{const{artifact}=await compileTarget(root,{id:'boolean-guards',source:'View.vue'});assert.doesNotMatch(artifact.variants.default.html,/Must be absent/);assert.match(artifact.variants.default.html,/Present/)});
});
test('finite dynamic slot forwarding retains caller controls and scoped parameters through reusable tables',async()=>{
 await fixture({'Cell.vue':`<script setup>import{ElTableColumn}from'element-plus';defineProps({name:String})</script><template><ElTableColumn label="Actions"><template #default="scope"><slot :name="name" v-bind="scope"/></template></ElTableColumn></template>`,'Rows.vue':`<script setup>import{ElTable}from'element-plus';import Cell from'./Cell.vue'</script><template><ElTable :data="unknown"><Cell name="actions"><template v-for="key in Object.keys($slots)" #[key]="scope"><slot :name="key" v-bind="scope"/></template></Cell></ElTable></template>`,'View.vue':`<script setup>import Rows from'./Rows.vue';import{ElButton}from'element-plus'</script><template><Rows><template #actions="{row}"><ElButton link>Inspect</ElButton></template></Rows></template>`},async root=>{const{artifact}=await compileTarget(root,{id:'forwarded',source:'View.vue'},{},{componentPresets:['element-plus']});assert.match(artifact.variants.default.html,/el-button/);assert.match(artifact.variants.default.html,/data-sk-text-content="Inspect"/);assert.ok(!artifact.diagnostics.some(d=>d.code==='SLOT_UNKNOWN'))});
});
