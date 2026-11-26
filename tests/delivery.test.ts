import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {compileTarget} from '../src/compiler/index.js';
import {evaluateString,UNKNOWN} from '../src/compiler/expression.js';

async function fixture(files:Record<string,string>,run:(root:string)=>Promise<void>){const root=await mkdtemp(path.join(os.tmpdir(),'skelcast-delivery-'));try{for(const [file,source]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),source);}await run(root);}finally{await rm(root,{recursive:true,force:true});}}

test('source return fields retain immutable columns and declared loading capacity without running a factory or callbacks',async()=>{
 await fixture({
  'fields.ts':`import{ref,reactive,onMounted}from'vue';export function configure(ignored){const rows=ref([]);const pagination=reactive({pageSize:7,total:0});const columns=[{label:'Title',prop:'title',width:180},{label:'Size',prop:'size'}];onMounted(()=>{throw Error('never run');rows.value=request();pagination.total=rows.value.length});return{rows,pagination,columns}}`,
  'View.vue':`<script setup>import{ElTable}from'element-plus';import{configure as describe}from'./fields';const{rows,pagination,columns}=describe(runtimeRef)</script><template><ElTable :data="rows" :columns="columns" :pagination="{...pagination,size:'small'}"/></template>`,
 },async root=>{
  const {artifact}=await compileTarget(root,{id:'fields',kind:'request',source:'View.vue'},{},{componentPresets:['element-plus']});
  const html=artifact.variants.default.html;assert.match(html,/>Title<\/div><\/th>/);assert.match(html,/>Size<\/div><\/th>/);assert.equal((html.match(/<tr(?:\s|>)/g)||[]).length,8);assert.doesNotMatch(html,/never run|request\(\)/);assert.ok(artifact.diagnostics.some(d=>/row capacity/.test(d.message)));
 });
});

test('mutable, escaped, conditional and asynchronous return fields are not treated as immutable configuration',async()=>{
 await fixture({
  'fields.ts':`const shared={height:70};mutate(shared);export function configure(){const geometry={height:50};mutate(geometry);return{geometry,shared}}export function conditional(flag){if(flag)return{height:50};return{height:80}}export async function deferred(){return{height:90}}`,
  'View.vue':`<script setup>import{configure,conditional,deferred}from'./fields';const{geometry,shared}=configure();const other=conditional(flag),later=deferred()</script><template><section :style="{height:geometry.height+'px'}"/><section :style="{height:shared.height+'px'}"/><section :style="{height:other.height+'px'}"/><section :style="{height:later.height+'px'}"/></template>`,
 },async root=>{
  const {artifact}=await compileTarget(root,{id:'unsafe',source:'View.vue'});assert.equal((artifact.variants.default.html.match(/data-sk-fallback/g)||[]).length,4);assert.doesNotMatch(artifact.variants.default.html,/height:(50|70|80|90)px/);
 });
});

test('dependency helper identity follows source metadata writes and rejects render replacement or active optional extensions',async()=>{
 await fixture({
  'node_modules/@fixture/decorators/package.json':JSON.stringify({module:'index.js'}),
  'node_modules/@fixture/decorators/index.js':`export const attach=(value,extra)=>{if(value.install=app=>app.component(value.name,value),extra)for(const key in extra)value[key]=extra[key];return value};export const replace=value=>{value.render=businessRender;return value};`,
  'Base.vue':`<template><section style="height:44px">Known</section></template>`,
  'Good.ts':`import{attach as wrap}from'@fixture/decorators';import Base from'./Base.vue';export default wrap(Base);`,
  'Bad.ts':`import{replace}from'@fixture/decorators';import Base from'./Base.vue';export default replace(Base);`,
  'Extra.ts':`import{attach}from'@fixture/decorators';import Base from'./Base.vue';export default attach(Base,{render:businessRender});`,
 },async root=>{
  const good=await compileTarget(root,{id:'good',source:'Good.ts'});assert.match(good.artifact.variants.default.html,/height:44px/);assert.ok(good.dependencies['node_modules/@fixture/decorators/index.js']);
  for(const source of ['Bad.ts','Extra.ts']){const bad=await compileTarget(root,{id:'bad',source});assert.doesNotMatch(bad.artifact.variants.default.html,/height:44px/);assert.ok(bad.artifact.diagnostics.some(d=>d.code==='FALLBACK'));}
 });
});

test('renamed source-proven typeof guards work without calling dependency code',async()=>{
 await fixture({
  'node_modules/@fixture/checks/package.json':JSON.stringify({module:'index.js'}),
  'node_modules/@fixture/checks/index.js':`throw Error('never import');export function predicate(value){return typeof value==='function'};`,
  'View.vue':`<script setup>import{predicate as inspect}from'@fixture/checks';const label='Name'</script><template><div v-if="inspect(label)">Callable</div><p v-else>Literal</p></template>`,
 },async root=>{const {artifact}=await compileTarget(root,{id:'types',source:'View.vue'});assert.match(artifact.variants.default.html,/Literal/);assert.doesNotMatch(artifact.variants.default.html,/Callable/);assert.deepEqual(artifact.diagnostics,[]);});
});

test('direct Vue render shells keep source typography and finite local render helpers while mutable values remain unknown',async()=>{
 await fixture({
  'Frame.tsx':`import{defineComponent,ref,onMounted}from'vue';const props={fontSize:{type:String,default:'20px'}};export default defineComponent({props,setup(props){const data=ref('initial');const alias=data;onMounted(()=>{throw Error('never run');alias.value=readBusiness()});const labels=()=>['A','B'].map(label=><b>{label}</b>);return()=> <section><span style={{fontSize:props.fontSize}}>{data.value}</span>{labels()}</section>}});`,
  'View.vue':`<script setup>import Frame from'./Frame'</script><template><Frame/></template>`,
 },async root=>{const {artifact}=await compileTarget(root,{id:'shell',source:'View.vue'});const html=artifact.variants.default.html;assert.match(html,/font-size:20px/);assert.equal((html.match(/<b /g)||[]).length,2);assert.doesNotMatch(html,/initial|never run|readBusiness/);assert.ok(artifact.diagnostics.some(d=>d.code==='PRESET_LIMIT'));});
});

test('absent members of complete source objects are undefined; opaque spreads and external objects stay unknown',()=>{
 const ctx={code:'',env:{},bindings:{}};
 assert.equal(evaluateString('({label:"Text"}).icon',ctx),undefined);
 assert.equal(evaluateString('({label:"Text",...opaque}).icon',ctx),UNKNOWN);
 assert.equal(evaluateString('data.icon',{...ctx,env:{data:{label:'Text'}}}),UNKNOWN);
});

test('bounded opaque collections keep a representative capacity without claiming a result length or exposing source data',async()=>{
 await fixture({
  'data.ts':`const escaped=[{title:'Secret A'},{title:'Secret B'},{title:'Secret C'}];mutate(escaped);export{escaped};export const bounded=opaque().slice(0,9).map(item=>item);`,
  'View.vue':`<script setup>import{escaped,bounded}from'./data'</script><template><main><article v-for="row in escaped">{{row.title}}</article><aside v-for="row in bounded">{{row.title}}</aside><section :style="{height:escaped.length+'px'}"/></main></template>`,
 },async root=>{const{artifact}=await compileTarget(root,{id:'bounds',source:'View.vue'});const html=artifact.variants.default.html;assert.equal((html.match(/<article /g)||[]).length,3);assert.equal((html.match(/<aside /g)||[]).length,9);assert.doesNotMatch(html,/Secret/);assert.ok(artifact.diagnostics.some(d=>d.code==='FALLBACK'));assert.ok(artifact.diagnostics.some(d=>d.code==='LOADING_PROJECTION'));});
});

test('source-proven table pagination keeps literal base spacing and rejects dead pagination branches',async()=>{
 const core=`import{defineComponent,createVNode as node,mergeProps,toRefs,unref,computed}from'vue';import{ElTable as Grid,ElTableColumn as Column,ElPagination as Pager}from'element-plus';export default defineComponent({setup(props){const{columns:fields,pagination:page}=toRefs(props);onRuntimeMount();const style=computed(()=>Object.assign({margin:'11px 0',display:'flex'},unref(page).style??{}));const col=value=>node(Column,value);const render=()=>[node(Grid,mergeProps(props,{ref:'grid'}),{default:()=>unref(fields).map(col)}),true?node(Pager,mergeProps({class:'source-pager',style:unref(style)},unref(page))):null];return()=>render();}});`;
 await fixture({'Core.ts':core,'View.vue':`<script setup>import Core from'./Core';const rows=[{name:'A'}],columns=[{label:'Name',prop:'name'}],pagination={currentPage:1,pageSize:8}</script><template><Core :data="rows" :columns="columns" :pagination="pagination"/></template>`},async root=>{
  const compile=()=>compileTarget(root,{id:'pager',source:'View.vue'},{},{componentPresets:['element-plus']});const first=await compile();assert.match(first.artifact.variants.default.html,/class="source-pager el-pagination"/);assert.match(first.artifact.variants.default.html,/margin:11px 0/);
  await writeFile(path.join(root,'Core.ts'),core.replace('true?node(Pager','false?node(Pager'));const dead=await compile();assert.doesNotMatch(dead.artifact.variants.default.html,/source-pager/);assert.match(dead.artifact.variants.default.html,/data-sk-data-table/);
  await writeFile(path.join(root,'Core.ts'),core.replace('true?node(Pager','0??node(Pager').replace('):null]',')]'));const nullish=await compile();assert.doesNotMatch(nullish.artifact.variants.default.html,/source-pager/);
 });
});

test('escaped row literals supply masked glyph geometry without becoming values, layout bindings or preserved content',async()=>{
 await fixture({'data.ts':`const rows=[{address:'A long declared address',height:99}];opaque(rows);export{rows};`,'View.vue':`<script setup>import{rows}from'./data';import{ElTable}from'element-plus';const columns=[{label:'Address',prop:'address'}];const geometry={height:125};opaque(geometry)</script><template><ElTable :data="rows" :columns="columns"/><ElTable data-sk-preserve :data="rows" :columns="columns"/><aside :style="{height:rows[0].height+'px'}"/><aside :style="{height:geometry.height+'px'}"/></template>`},async root=>{
  const{artifact}=await compileTarget(root,{id:'glyphs',source:'View.vue'},{},{componentPresets:['element-plus']});const html=artifact.variants.default.html;
  assert.equal((html.match(/data-sk-text-content="A long declared address"/g)||[]).length,1);assert.doesNotMatch(html,/height:(99|125)px/);assert.ok(artifact.diagnostics.some(d=>d.code==='FALLBACK'));assert.ok(artifact.diagnostics.some(d=>/glyph prototypes/.test(d.message)));
 });
});
