import{test}from'node:test';
import assert from'node:assert/strict';
import{mkdtemp,mkdir,writeFile,readFile,rm}from'node:fs/promises';
import path from'node:path';import os from'node:os';
import{compileTarget}from'../src/compiler/index.js';

async function fixture(files:Record<string,string>,run:(root:string)=>Promise<void>){const root=await mkdtemp(path.join(os.tmpdir(),'skelcast-context-'));try{for(const[file,code]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),code);}await run(root);}finally{await rm(root,{recursive:true,force:true});}}

test('request regions retain lexical scoped arguments through JSX wrappers without evaluating surrounding styles or event handlers',async()=>{
 await fixture({
  'Frame.tsx':`import{defineComponent}from'vue';export default defineComponent({props:['height','columns'],setup(props,{slots}){return()=> <div style={{width:readBusinessWidth()}} onClick={()=>slots.default({height:999,columns:[]})}>{slots.default({height:props.height,columns:props.columns})}</div>}});`,
  'View.vue':`<script setup>import Frame from'./Frame';import{ElTable}from'element-plus';import{LoadingBoundary}from'skelcast/vue';const columns=[{label:'Title',prop:'title'},{label:'Size',prop:'size'}],rows=[{title:'A',size:2}]</script><template><header>Outside</header><div :class="unknownClass"><Frame :height="72" :columns="columns"><template #default="{height: blockHeight,columns:fields}"><LoadingBoundary :artifact="artifact" :pending="pending"><article :style="{height:blockHeight+'px'}">Inside</article><ElTable :columns="fields" :data="rows"/><p v-if="false">Forbidden</p></LoadingBoundary></template></Frame></div></template>`,
 },async root=>{const{artifact}=await compileTarget(root,{id:'scope',kind:'request',source:'View.vue',region:'artifact'},{},{componentPresets:['element-plus']});const html=artifact.variants.default.html;assert.match(html,/height:72px/);assert.match(html,/>Title<\/div><\/th>/);assert.match(html,/>Size<\/div><\/th>/);assert.doesNotMatch(html,/Outside|Forbidden|999|readBusinessWidth/);assert.deepEqual(artifact.diagnostics,[]);});
});

test('template and h scoped slots forward renamed fields and defaults across nested components',async()=>{
 await fixture({
  'Inner.ts':`import{defineComponent,h}from'vue';export default defineComponent({setup(props,{slots}){return()=>h('div',null,slots.default({height:56}))}});`,
  'Outer.vue':`<script setup>import Inner from'./Inner'</script><template><Inner v-slot="{height: value}"><slot :height="value"/></Inner></template>`,
  'View.vue':`<script setup>import Outer from'./Outer';import{LoadingBoundary}from'skelcast/vue'</script><template><Outer v-slot="{height: size,missing='Default'}"><LoadingBoundary :artifact="artifact" :pending="pending"><p :style="{height:size+'px'}">{{missing}}</p></LoadingBoundary></Outer></template>`,
 },async root=>{const{artifact}=await compileTarget(root,{id:'nested',kind:'request',source:'View.vue',region:'artifact'});assert.match(artifact.variants.default.html,/height:56px/);assert.match(artifact.variants.default.html,/Default/);assert.deepEqual(artifact.diagnostics,[]);});
});

test('deferred scoped h slots preserve the selected region through another source component',async()=>{
 await fixture({
  'Inner.ts':`import{defineComponent,h}from'vue';export default defineComponent({setup(props,{slots}){return()=>h('div',null,slots.default({height:64}))}});`,
  'Frame.ts':`import{defineComponent,h}from'vue';import Inner from'./Inner';export default defineComponent({setup(props,{slots}){return()=>h(Inner,{style:{width:unknownWidth()}},{default:({height})=>h('div',null,slots.default({height}))})}});`,
  'View.vue':`<script setup>import Frame from'./Frame';import{LoadingBoundary}from'skelcast/vue'</script><template><Frame v-slot="{height}"><LoadingBoundary :artifact="artifact" :pending="true"><p :style="{height:height+'px'}">Inside</p></LoadingBoundary></Frame></template>`,
 },async root=>{const{artifact}=await compileTarget(root,{id:'deferred',source:'View.vue',region:'artifact'});assert.match(artifact.variants.default.html,/height:64px/);assert.doesNotMatch(artifact.variants.default.html,/data-sk-fallback/);});
});

test('unreachable lifecycle and event slot calls cannot supply a region context',async()=>{
 await fixture({
  'Frame.tsx':`import{defineComponent,onMounted}from'vue';export default defineComponent({setup(props,{slots}){onMounted(()=>slots.default({height:999}));return()=> <button onClick={()=>slots.default({height:999})}>Button</button>}});`,
  'View.vue':`<script setup>import Frame from'./Frame';import{LoadingBoundary}from'skelcast/vue'</script><template><Frame v-slot="{height}"><LoadingBoundary :artifact="artifact" :pending="true"><p :style="{height:height+'px'}">Inside</p></LoadingBoundary></Frame></template>`,
 },async root=>{const{artifact}=await compileTarget(root,{id:'dead',source:'View.vue',region:'artifact'});assert.doesNotMatch(artifact.variants.default.html,/999px|Inside/);assert.ok(artifact.diagnostics.some(d=>/source slot context/.test(d.message)));});
});

test('source-proven copying and initial Vue state preserve loading column configuration without exposing it as live bindings',async()=>{
 const copy=await readFile('tests/fixtures/source-copy.txt','utf8');
 await fixture({
  'copy.ts':`throw Error('never import this module');${copy}`,
  'Frame.tsx':`import{defineComponent,ref as state,onMounted}from'vue';import{replicate as snapshot}from'./copy';export default defineComponent({props:['columns'],setup(props,{slots}){const columns=state(snapshot(props.columns));const height=state(72);onMounted(()=>{columns.value=[];height.value=300;throw Error('never mount')});return()=> <div>{slots.default({columns:columns.value,height:height.value,allowed:false})}</div>}});`,
  'View.vue':`<script setup>import Frame from'./Frame';import{ElTable}from'element-plus';import{LoadingBoundary}from'skelcast/vue';const columns=[{label:'Title',prop:'title',cellRenderer:()=>readBusiness()},{label:'Size',prop:'size'}]</script><template><Frame :columns="columns" v-slot="{columns:fields,height,allowed}"><LoadingBoundary :artifact="artifact" :pending="pending"><ElTable :columns="fields"/><aside :style="{height:height+'px'}"/><b v-if="allowed">Forbidden</b></LoadingBoundary></Frame></template>`,
 },async root=>{
  const compile=()=>compileTarget(root,{id:'initial',kind:'request',source:'View.vue',region:'artifact'},{},{componentPresets:['element-plus']});
  const result=await compile(),html=result.artifact.variants.default.html;assert.match(html,/>Title<\/div><\/th>/);assert.match(html,/>Size<\/div><\/th>/);assert.equal((html.match(/<th /g)||[]).length,2);assert.doesNotMatch(html,/height:72px|height:300px|Forbidden|never import/);assert.ok(result.artifact.diagnostics.some(d=>/initial columns/.test(d.message)));assert.ok(result.artifact.diagnostics.some(d=>d.code==='FALLBACK'));
  await writeFile(path.join(root,'copy.ts'),copy.replace('target[key] = copyChild','input[key] = copyChild'));
  const unsafe=await compile();assert.doesNotMatch(unsafe.artifact.variants.default.html,/>Title<\/div><\/th>/);assert.ok(unsafe.artifact.diagnostics.some(d=>/columns are unknown/.test(d.message)));
  await writeFile(path.join(root,'copy.ts'),`Object.hasOwn=()=>false;${copy}`);const replaced=await compile();assert.doesNotMatch(replaced.artifact.variants.default.html,/>Title<\/div><\/th>/);assert.equal(Object.hasOwn({value:1},'value'),true);
 });
});

test('viewport constraints require the matching table ref, known activation/offset and a reachable lifecycle registration',async()=>{
 const source=await readFile('tests/fixtures/viewport-table.txt','utf8');
 const view=`<script setup>import Grid from'./Grid';const fields=[{label:'Title',prop:'title'}]</script><template><Grid :columns="fields" :auto-fill="true" :fit="{gap:43}"/></template>`;
 await fixture({'Grid.ts':source,'View.vue':view},async root=>{
  const compile=()=>compileTarget(root,{id:'fit',source:'View.vue'},{},{componentPresets:['element-plus']});
  const positive=await compile();assert.match(positive.artifact.variants.default.html,/data-sk-viewport-bottom="43"/);
  const cases=[
   source.replace("vm.proxy.$refs['grid-view']","vm.proxy.$refs['unrelated-view']"),
   source.replace('element.getBoundingClientRect().top','document.body.getBoundingClientRect().top'),
   source.replace('onMounted(() => nextTick(() => { if (unref(enabled)) fitViewport(); }));','const unused = () => onMounted(() => nextTick(() => { if (unref(enabled)) fitViewport(); }));'),
  ];
  for(const negative of cases){await writeFile(path.join(root,'Grid.ts'),negative);const result=await compile();assert.doesNotMatch(result.artifact.variants.default.html,/data-sk-viewport-bottom/);}
  await writeFile(path.join(root,'Grid.ts'),source);
  for(const negative of[view.replace(':auto-fill="true"',':auto-fill="false"'),view.replace('{gap:43}','{gap:unknownOffset()}')]){await writeFile(path.join(root,'View.vue'),negative);const result=await compile();assert.doesNotMatch(result.artifact.variants.default.html,/data-sk-viewport-bottom/);}
 });
});
