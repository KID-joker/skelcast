import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {compileTarget} from '../src/compiler/index.js';
import {initProject} from '../src/init/index.js';
import {selectedVariant} from '../src/runtime/core.js';
import type {SkeletonTarget} from '../src/types.js';
async function fixture(files:Record<string,string>,run:(root:string)=>Promise<void>){const root=await mkdtemp(path.join(os.tmpdir(),'skelcast-context-'));try{for(const[file,code]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),code)}await run(root)}finally{await rm(root,{recursive:true,force:true})}}
const box=`<script setup>import{ElTable,ElTableColumn}from'element-plus';import{LoadingBoundary}from'skelcast/vue';import frame from'virtual:skelcast/rows';const props=defineProps({columns:{type:Array,default:()=>[]}})</script><template><LoadingBoundary :artifact="frame" :pending="false" :context="$attrs['data-sk-context']"><ElTable :data="unknown"><ElTableColumn v-for="column in props.columns" :key="column.label" :label="column.label" :width="column.width"/><slot/></ElTable></LoadingBoundary></template>`;
test('a reusable request region compiles caller props and slots separately and tracks caller freshness',async()=>{
 await fixture({'Rows.vue':box,'Page.vue':`<script setup>import Rows from'./Rows.vue';import{ElTableColumn}from'element-plus';const columns=[{label:'One',width:90},{label:'Two',width:140}]</script><template><main><Rows data-sk-context="first" :columns="columns"><ElTableColumn label="Action" width="180"/></Rows><Rows data-sk-context="second" :columns="[{label:'Only',width:220}]"/></main></template>`},async root=>{
  const target:SkeletonTarget={id:'rows',source:'Rows.vue',region:'frame',contexts:{first:{source:'Page.vue'},second:{source:'Page.vue'}}};
  const{artifact,dependencies}=await compileTarget(root,target,{}, {componentPresets:['element-plus']});
  const first=artifact.contexts?.first?.default,second=artifact.contexts?.second?.default;
  assert.ok(first&&second,'call-site contexts have declared variant mappings');
  const a=artifact.variants[first].html,b=artifact.variants[second].html;
  assert.equal((a.match(/<th /g)||[]).length,3);assert.match(a,/Action/);
  assert.equal((b.match(/<th /g)||[]).length,1);assert.doesNotMatch(b,/Action/);
  assert.ok(dependencies['Page.vue']);
  assert.equal(selectedVariant(artifact,undefined,false,'first'),first);
  assert.equal(selectedVariant(artifact,undefined,false,'second'),second);
 });
});
test('init wires finite caller identifiers and request contexts and is idempotent',async()=>{
 await fixture({'package.json':JSON.stringify({dependencies:{vue:'^3',vite:'^6',skelcast:'*'}}),'vite.config.mjs':'export default {}','src/Rows.vue':`<script setup>const props=defineProps({columns:Array});const busy=false</script><template><section v-loading="busy"><p v-for="column in props.columns">{{column.label}}</p></section></template>`,'src/views/Page.vue':`<script setup>import Rows from'../Rows.vue';const columns=[{label:'One'}]</script><template><Rows :columns="columns"/></template>`},async root=>{
  const report=await initProject(root);const target=report.targets.find(t=>t.source==='src/Rows.vue'&&t.kind==='request')!;
  assert.equal(Object.keys(target.contexts??{}).length,1);
  assert.ok(report.changes.some(c=>c.file==='src/views/Page.vue'&&c.after.includes('data-sk-context')));
  assert.ok(report.changes.some(c=>c.file==='src/Rows.vue'&&c.after.includes(':context=')));
  assert.equal((await initProject(root)).changes.length,0);
 });
});
test('selected caller contexts retain scoped CSS variables from the reusable component instance',async()=>{
 await fixture({'Rows.vue':`<script setup>import{LoadingBoundary}from'skelcast/vue';import frame from'virtual:skelcast/size';defineProps({height:String})</script><template><LoadingBoundary :artifact="frame" :pending="false"><div class="panel">Data</div></LoadingBoundary></template><style scoped>.panel{height:v-bind('height')}</style>`,'Page.vue':'<script setup>import Rows from"./Rows.vue"</script><template><Rows data-sk-context="tall" height="76px"/><Rows data-sk-context="short" height="24px"/></template>'},async root=>{const{artifact}=await compileTarget(root,{id:'size',source:'Rows.vue',region:'frame',contexts:{tall:{source:'Page.vue'},short:{source:'Page.vue'}}});assert.match(artifact.variants[artifact.contexts!.tall.default].html,/76px/);assert.match(artifact.variants[artifact.contexts!.short.default].html,/24px/)});
});
