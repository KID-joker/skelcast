import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {compileTarget} from '../src/compiler/index.js';
import {pruneCSS} from '../src/compiler/prune-css.js';

async function fixture(files:Record<string,string>,run:(root:string)=>Promise<void>){const root=await mkdtemp(path.join(os.tmpdir(),'skelcast-remaining-'));try{for(const [file,source]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),source);}await run(root);}finally{await rm(root,{recursive:true,force:true});}}

test('loading projects only response-linked collection guards, retains source/explicit empty views and never runs handlers',async()=>{
 await fixture({'View.vue':`<script setup>import{ref}from'vue';const rows=ref([]),page=ref({size:6,total:0});async function receive(response){rows.value=response.items;page.value={...page.value,total:response.items.length};throw Error('never run')}</script><template><section><p v-show="rows.length===0">Empty</p><template v-if="page.total>0"><article v-for="item in rows.slice(0,page.size)">{{item.title}}</article></template></section></template>`},async root=>{
  const {artifact}=await compileTarget(root,{id:'states',source:'View.vue',kind:'request',variants:{loading:{},source:{state:'source'},empty:{bindings:{'page.total>0':false,rows:[]}}}});
  assert.equal((artifact.variants.loading.html.match(/<article /g)||[]).length,6);
  assert.doesNotMatch(artifact.variants.loading.html,/Empty/);
  for(const variant of ['source','empty']){assert.doesNotMatch(artifact.variants[variant].html,/<article/);assert.match(artifact.variants[variant].html,/Empty/);}
  assert.ok(artifact.diagnostics.some(d=>d.code==='LOADING_PROJECTION'));
  assert.doesNotMatch(artifact.variants.loading.html,/response|never run/);
 });
});

test('selected and nested boundaries retain their loading defaults and explicit state overrides', async () => {
 for (const pending of ['', ':pending="false"', ':pending="true"', ':pending="!ready"']) {
  await fixture({'View.vue':`<script setup>import{ref}from'vue';import{LoadingBoundary}from'skelcast/vue';import artifact from'virtual:skelcast/view';const rows=ref([]),ready=ref(false);function receive(response){rows.value=response.items;}</script><template><LoadingBoundary :artifact="artifact" ${pending}><section v-if="rows.length>0"><article v-for="row in rows">{{row.title}}</article></section></LoadingBoundary></template>`}, async root => {
   for (const region of [undefined, 'artifact']) {
    const {artifact}=await compileTarget(root,{id:'defaults',source:'View.vue',kind:'request',region,variants:{default:{},loading:{state:'loading'},source:{state:'source'}}});
    const count=(variant:string)=>(artifact.variants[variant].html.match(/<article /g)??[]).length;
    assert.equal(count('default'),pending===':pending="false"'||!pending&&!region?0:4,`${pending || 'absent pending'}, ${region || 'nested boundary'}`);
    assert.equal(count('loading'),4);
    assert.equal(count('source'),0);
   }
  });
 }
});

test('permission guards, unrelated counts and static empty collections are never promoted to results',async()=>{
 await fixture({'View.vue':`<script setup>import{ref}from'vue';const rows=ref([]),allowed=false,total=0;function receive(response){rows.value=response.items;}</script><template><div v-if="allowed"><article v-for="row in rows">Forbidden</article></div><section v-if="total>0"><article v-for="row in rows">Unrelated</article></section></template>`},async root=>{
  const {artifact}=await compileTarget(root,{id:'safe',source:'View.vue',kind:'request'});assert.doesNotMatch(artifact.variants.default.html,/Forbidden|Unrelated|<article/);
 });
});

test('React response assignment and length guards share the finite loading projection',async()=>{
 await fixture({'View.tsx':`let rows=[];function receive(response){rows=response.items;throw Error('never run')}export default()=> <section>{rows.length===0?<p>Empty</p>:rows.slice(0,5).map(row=><article>{row.title}</article>)}</section>`},async root=>{
  const result=await compileTarget(root,{id:'react',kind:'request',source:'View.tsx'});assert.equal((result.artifact.variants.default.html.match(/<article /g)||[]).length,5);assert.doesNotMatch(result.artifact.variants.default.html,/Empty/);
 });
});

const library=`import{defineComponent,createVNode as node,mergeProps,toRefs,unref}from'vue';import{ElTable as Grid,ElTableColumn as Column}from'element-plus';const Core=defineComponent({name:'GlobalGrid',setup(props){const{columns:fields}=toRefs(props);onRuntimeMount();const col=value=>node(Column,value);const render=()=>node(Grid,mergeProps(props,{ref:'grid'}),{default:()=>unref(fields).map(col)});return()=>render();}});const Plugin=Object.assign(Core,{install(app){app.component('RenamedGrid',Core)}});export default Plugin;`;
test('global plugin registrations and reachable table cores require source/import proof, including renamed registrations',async()=>{
 await fixture({
  'index.html':`<script type="module" src="/main.ts"></script>`,
  'main.ts':`import{createApp}from'vue';import Plugin from'@fixture/widgets';const app=createApp({});app.use(Plugin);throw Error('never execute');`,
  'node_modules/@fixture/widgets/package.json':JSON.stringify({name:'@fixture/widgets',module:'index.js',peerDependencies:{'element-plus':'*'}}),
  'node_modules/@fixture/widgets/index.js':library,
  'View.vue':`<script setup>const columns=[{label:'Title',prop:'title'},{label:'Count',prop:'count'}];const rows=[{title:'A',count:2},{title:'B',count:3}]</script><template><RenamedGrid :data="rows" :columns="columns"/></template>`,
 },async root=>{
  const {artifact,dependencies}=await compileTarget(root,{id:'table',source:'View.vue'},{},{componentPresets:['element-plus']});
  assert.match(artifact.variants.default.html,/data-sk-data-table/);assert.equal((artifact.variants.default.html.match(/<tr(?:\s|>)/g)||[]).length,3);assert.match(artifact.variants.default.html,/data-sk-text-content="A"/);assert.ok(artifact.diagnostics.some(d=>d.code==='PRESET_LIMIT'));assert.ok(dependencies['node_modules/@fixture/widgets/package.json']);
  await writeFile(path.join(root,'node_modules/@fixture/widgets/index.js'),library.replace('return()=>render();','return()=>node("div",null,"Opaque");'));
  const dead=await compileTarget(root,{id:'dead',source:'View.vue'},{},{componentPresets:['element-plus']});assert.doesNotMatch(dead.artifact.variants.default.html,/data-sk-data-table/);
  await writeFile(path.join(root,'node_modules/@fixture/widgets/index.js'),library.replace("install(app){app.component('RenamedGrid',Core)}","install(app){}")+`;const unused={install(app){app.component('RenamedGrid',Core)}};`);
  const unused=await compileTarget(root,{id:'unused',source:'View.vue'},{},{componentPresets:['element-plus']});assert.doesNotMatch(unused.artifact.variants.default.html,/data-sk-data-table/);
 });
});

test('CSS pruning retains negative/alternative/theme selectors and refuses to remove unknown-font resources',()=>{
 const source=`.missing{height:99px}.present:not(.missing){height:20px}:is(.missing,.present){width:30px}.dark .present{color:red}@media(min-width:700px){.present{height:40px}.other{height:60px}}@font-face{font-family:Unused;src:url(data:font/woff2;base64,AA)}@keyframes fade{to{opacity:0}}`;
 const pruned=pruneCSS(source,'<div class="present"></div>');assert.doesNotMatch(pruned,/height:99px|height:60px|font-family:Unused/);assert.match(pruned,/:not\(\.missing\)/);assert.match(pruned,/:is\(\.missing,\.present\)/);assert.match(pruned,/\.dark/);assert.match(pruned,/@keyframes fade/);
 assert.match(pruneCSS(source+`.present{font-family:var(--external-font)}`,'<div class="present"/>'),/font-family:Unused/);
});

test('source ID provenance records finite source IDs independently of runtime-generated identifiers',async()=>{
 await fixture({'View.vue':`<script setup>const runtimeId=useRuntimeId();</script><template><section id="stable"><span :id="runtimeId"/><p data-sk-anchor="row">Data</p></section></template>`},async root=>{
  const {artifact}=await compileTarget(root,{id:'ids',source:'View.vue'});assert.deepEqual(artifact.variants.default.sourceIds,['stable']);assert.ok(artifact.diagnostics.some(d=>d.code==='LAYOUT_ATTRIBUTE_UNKNOWN'));
 });
});

test('loading alternatives with one unknown strict scalar discriminant remain mutually exclusive',async()=>{
 await fixture({'View.vue':`<script setup>const data=unknownData()</script><template><section><div v-if="data.type===1">First</div><div v-if="data.type===2">Second</div><div v-if="data.type===3">Third</div></section></template>`},async root=>{
  const {artifact}=await compileTarget(root,{id:'alternatives',kind:'request',source:'View.vue'});assert.match(artifact.variants.default.html,/First/);assert.doesNotMatch(artifact.variants.default.html,/Second|Third/);assert.ok(artifact.diagnostics.some(d=>d.code==='BRANCH_DEFAULT'));
 });
});
