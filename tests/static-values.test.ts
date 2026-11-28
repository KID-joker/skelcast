import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {compileTarget} from '../src/compiler/index.js';
import {evaluateString,UNKNOWN} from '../src/compiler/expression.js';
import {StaticValues} from '../src/compiler/static-values.js';
import {SourceModules} from '../src/compiler/modules.js';

async function fixture(files:Record<string,string>,run:(root:string)=>Promise<void>){
 const root=await mkdtemp(path.join(os.tmpdir(),'skelcast-values-'));
 try{for(const [name,source]of Object.entries(files)){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),source);}await run(root);}finally{await rm(root,{recursive:true,force:true});}
}

test('unused imports do not consume the presentation budget or hide later layout values', async () => {
 const data = `export const unused=${JSON.stringify(Array.from({length:200},()=>Array.from({length:60},()=>1)))};export const height=80;`;
 await fixture({'data.ts':data}, async root => {
  for (const imports of ['height', 'unused,height', 'height,unused']) {
   const sources = {
    'View.vue': `<script setup>import{${imports}}from'./data';</script><template><main :style="{height:height+1}">Text</main></template>`,
    'View.tsx': `import{${imports}}from'./data';export default()=> <main style={{height:height+1}}>Text</main>;`,
   };
   for (const [source, code] of Object.entries(sources)) {
    await writeFile(path.join(root, source), code);
    const {artifact, dependencies} = await compileTarget(root, {id:'imports',source,variants:{normal:{},override:{bindings:{height:90}}}});
    assert.deepEqual(artifact.diagnostics, [], `${source}: ${imports}`);
    assert.match(artifact.variants.normal.html, /height:81px/);
    assert.match(artifact.variants.override.html, /height:91px/);
    assert.ok(dependencies['data.ts'], 'unused imports remain in the invalidation graph');
   }
  }
 });
});

test('imports used only by CSS bindings, aliases and public reexports retain their values', async () => {
 await fixture({
  'data.ts': 'export const height=80;',
  'View.vue': `<script setup>import{height}from'./data';</script><template><main>Text</main></template><style>main{height:calc(v-bind(height) * 1px)}</style>`,
  'Alias.vue': `<script setup>import{height}from'./data';const size=height+1;</script><template><main :style="{height:size}">Text</main></template>`,
  'Escaped.vue': `<script setup>import{height}from'./data';</script><template><main :style="{height:\\u0068eight+1}">Text</main></template>`,
  'Entity.vue': `<script setup>import{height}from'./data';</script><template><main :style="{height:he&#105;ght+1}">Text</main></template>`,
  'barrel.ts': `import{height}from'./data';export{height};`,
 }, async root => {
  const css = await compileTarget(root, {id:'css',source:'View.vue'});
  assert.deepEqual(css.artifact.diagnostics, []);
  assert.match(css.artifact.variants.default.html, /--sk-bind-[\w-]+:80/);
  const alias = await compileTarget(root, {id:'alias',source:'Alias.vue'});
  assert.deepEqual(alias.artifact.diagnostics, []);
  assert.match(alias.artifact.variants.default.html, /height:81px/);
  for (const source of ['Escaped.vue', 'Entity.vue']) {
   const result = await compileTarget(root, {id:'escaped',source});
   assert.deepEqual(result.artifact.diagnostics, []);
   assert.match(result.artifact.variants.default.html, /height:81px/);
  }
  class Modules extends SourceModules { load(file:string){return this.module(file);} }
  const modules = new Modules(root, {});
  const values = await new StaticValues(file=>modules.load(file)).environment(await modules.load(path.join(root,'barrel.ts')));
  assert.equal(values.height, 80);
 });
});

test('static environment caching leaves budget-exhausted passes eligible for further resolution',async()=>{
 const source=Array.from({length:800},(_,index)=>`export const value${index}=[${Array.from({length:16},(_,i)=>i).join(',')}];`).join('\n');
 await fixture({'data.ts':source},async root=>{
  class Modules extends SourceModules{load(file:string){return this.module(file);}}
  const modules=new Modules(root,{}),mod=await modules.load(path.join(root,'data.ts'));
  const values=new StaticValues(file=>modules.load(file));
  const first=await values.environment(mod);
  assert.equal(first.value799,undefined,'the first pass retains the finite work limit');
  const second=await values.environment(mod);
  assert.deepEqual(second.value799,Array.from({length:16},(_,i)=>i),'a later pass can finish using previously resolved values');
 });
});

test('reusing unknown evaluations preserves the resolution cutoff for later constants', async () => {
 await fixture({}, async root => {
  class Modules extends SourceModules { load(file: string) { return this.module(file); } }
  for (const count of [1999, 2000]) {
   const source = Array.from({ length: count }, (_, index) => `const unknown${index}=businessValue();`).join('\n');
   const file = path.join(root, 'data.ts');
   await writeFile(file, source + '\nexport const height=42;');
   const modules = new Modules(root, {}), mod = await modules.load(file);
   const values = await new StaticValues(file => modules.load(file)).environment(mod);
   assert.equal(values.height, count === 1999 ? 42 : undefined);
  }
 });
});

test('local constants cross aliases, default/named/namespace and diamond reexports without executing source',async()=>{
 await fixture({
  'data.ts':`throw Error('never execute');export const sizes=[20,30,40];export const columns=[{label:'Name',prop:'name',width:180},{label:'Count',prop:'count',width:120}];export default {height:72};`,
  'left.ts':`export * from './data';`,
  'right.ts':`export {sizes,columns} from './data';`,
  'barrel.ts':`export * from './left';export * from './right';export {default as geometry}from'./data';`,
  'View.vue':`<script setup>import{sizes as items,geometry}from'@data/barrel';import * as ns from '@data/data';import{ElTable}from'element-plus';const tail=items.slice(1).reverse();</script><template><main :style="{height:geometry.height+'px'}"><b v-for="size in tail" :style="{width:size+'px'}">{{size}}</b><ElTable :columns="ns.columns"/></main></template>`,
 },async root=>{
  const {artifact,dependencies}=await compileTarget(root,{id:'imports',source:'View.vue'},{'@data':'.'},{componentPresets:['element-plus']});
  assert.deepEqual(artifact.diagnostics,[]);
  const html=artifact.variants.default.html;
  assert.match(html,/height:72px/);assert.equal((html.match(/<b /g)||[]).length,2);
  assert.match(html,/width:40px/);assert.match(html,/width:30px/);
  assert.match(html,/>Name<\/th>/);assert.match(html,/>Count<\/th>/);
  assert.ok(dependencies['data.ts']);
 });
});

test('Vue setup closures forward props, attrs and default/named source slots without executing setup',async()=>{
 await fixture({
  'Frame.ts':`import{defineComponent,h}from'vue';import Inner from './Inner.vue';export default defineComponent({props:{height:{type:Number,default:50}},setup(props,{attrs,slots}){const style={height:props.height+'px'};return()=>h(Inner,{...attrs,style},slots)}});`,
  'Inner.vue':`<template><article><header><slot name="header"/></header><slot/></article></template>`,
  'View.vue':`<script setup>import Frame from './Frame'</script><template><Frame class="box" :height="80"><template #header><h2>Heading</h2></template><p>Body</p></Frame></template>`,
 },async root=>{
  const {artifact}=await compileTarget(root,{id:'setup',source:'View.vue'});
  assert.deepEqual(artifact.diagnostics,[]);
  assert.match(artifact.variants.default.html,/<article[^>]*class="[^"]*\bbox\b/);
  assert.match(artifact.variants.default.html,/style="height:80px/);
  assert.match(artifact.variants.default.html,/<h2/);assert.match(artifact.variants.default.html,/<p/);
 });
});

test('source-proven identity wrappers unwrap local components; mutations and lookalike helpers stay opaque',async()=>{
 await fixture({
  'identity.ts':`export const pass=component=>{const result=component;return result};`,
  'Base.vue':`<template><section style="height:88px">Known</section></template>`,
  'View.ts':`import {pass as decorate}from'./identity';import Component from './Base.vue';const Alias=Component;export default decorate(Alias);`,
  'Unsafe.ts':`import Component from './Base.vue';const pass=component=>{component.render=businessRender;return component};export default pass(Component);`,
  'Early.ts':`import Component from './Base.vue';const pass=component=>{const result=later;const later=component;return result};export default pass(Component);`,
 },async root=>{
  const result=await compileTarget(root,{id:'identity',source:'View.ts'});
  assert.deepEqual(result.artifact.diagnostics,[]);assert.match(result.artifact.variants.default.html,/height:88px/);
  for(const source of ['Unsafe.ts','Early.ts']){const unsafe=await compileTarget(root,{id:'unsafe',source});assert.ok(unsafe.artifact.diagnostics.some(d=>d.code==='FALLBACK'));assert.doesNotMatch(unsafe.artifact.variants.default.html,/Known/);}
 });
});

test('conflicting exports, cycles, mutations and opaque calls retain unknown values',async()=>{
 await fixture({
  'a.ts':`export const height=40;`, 'b.ts':`export const height=80;`,
  'conflict.ts':`export * from './a';export * from './b';`,
  'cycle-a.ts':`import{height as other}from'./cycle-b';export const height=other;export const stable=25;`,
  'cycle-b.ts':`import{height as other}from'./cycle-a';export const height=other;`,
  'mutated.ts':`const geometry={height:42};const alias=geometry;alias.height=99;export {geometry};`,
  'escaped.ts':`const geometry={height:42};runBusiness(geometry);export {geometry};`,
  'opaque.ts':`export const height=loadBusinessHeight();`,
 },async root=>{
  for(const [module,expression]of [['conflict','height'],['cycle-a','height'],['mutated','geometry.height'],['escaped','geometry.height'],['opaque','height']]){
   await writeFile(path.join(root,'View.vue'),`<script setup>import * as data from './${module}'</script><template><div :style="{height:data.${expression}+'px'}"/></template>`);
   const {artifact}=await compileTarget(root,{id:'unknown',source:'View.vue'});
   assert.ok(artifact.diagnostics.some(d=>d.code==='FALLBACK'),module);
  }
  await writeFile(path.join(root,'View.vue'),`<script setup>import{stable}from'./cycle-a'</script><template><div :style="{height:stable+'px'}"/></template>`);
  const stable=await compileTarget(root,{id:'stable',source:'View.vue'});assert.deepEqual(stable.artifact.diagnostics,[]);assert.match(stable.artifact.variants.default.html,/height:25px/);
 });
});

test('bounded array transforms preserve their inputs and refuse huge work, mutation and object coercion',()=>{
 const list=[1,2,3],ctx={code:'',env:{list},bindings:{}};
 assert.deepEqual(evaluateString('list.slice(1).reverse()',ctx),[3,2]);assert.deepEqual(list,[1,2,3]);
 assert.deepEqual(evaluateString('list.toReversed()',ctx),[3,2,1]);assert.equal(evaluateString('list.reverse()',ctx),UNKNOWN);
 assert.equal(evaluateString('nested.find(item=>true).reverse()',{...ctx,env:{nested:[[1,2],[3,4]]}}),UNKNOWN);
 assert.equal(evaluateString('Array.from({length:1000000},(_,i)=>i)',ctx),UNKNOWN);
 assert.deepEqual(evaluateString('Array.from({length:2,0:7,1:8})',ctx),[7,8]);
 assert.equal(evaluateString('`${value}`',{...ctx,env:{value:{toString(){throw Error('must not execute')}}}}),UNKNOWN);
});

test('namespace exports exclude star defaults and include destructured constants; data edits change dependencies',async()=>{
 await fixture({
  'data.ts':`export default 99;export const {height}={height:45};export const items=Array.from({length:3},(_,i)=>({height:(i+1)*10}));`,
  'barrel.ts':`export * from './data';`,
  'View.tsx':`import * as data from './barrel';export default()=> <main style={{height:data.height}}>{Object.keys(data).map(name=><b>{name}</b>)}{data.items.map(item=><article style={{height:item.height}}>Data</article>)}</main>`,
 },async root=>{
  const first=await compileTarget(root,{id:'data',source:'View.tsx'});
  assert.deepEqual(first.artifact.diagnostics,[]);assert.equal((first.artifact.variants.default.html.match(/<b /g)||[]).length,2);assert.equal((first.artifact.variants.default.html.match(/<article /g)||[]).length,3);
  await writeFile(path.join(root,'data.ts'),`export const height=60;export const items=Array.of({height:20});`);
  const second=await compileTarget(root,{id:'data',source:'View.tsx'});
  assert.notEqual(first.dependencies['data.ts'],second.dependencies['data.ts']);assert.match(second.artifact.variants.default.html,/height:60px/);assert.equal((second.artifact.variants.default.html.match(/<article /g)||[]).length,1);
 });
});

test('setup accessors and direct render shells stay finite while async and unreachable bodies remain opaque',async()=>{
 await fixture({
  'Good.ts':`import{defineComponent as define,h,useAttrs as attrsOf,useSlots}from'vue';export default define((props)=>{const attrs=attrsOf();const slots=useSlots();const render=()=>h('section',attrs,slots.default?.());return render});`,
  'Life.ts':`import{defineComponent,h,onMounted}from'vue';export default defineComponent({setup(){onMounted(runBusiness);return()=>h('div',null,'invented')}});`,
  'Async.ts':`import{defineComponent,h}from'vue';export default defineComponent({async setup(){return()=>h('div',null,'invented')}});`,
  'Early.ts':`import{defineComponent,h}from'vue';export default defineComponent({setup(){return render;const render=()=>h('div',null,'invented')}});`,
  'Private.vue':`<script>import{defineComponent}from'vue';export default defineComponent({setup(){const privateHeight=60;return{}}});</script><template><section :style="{height:privateHeight+'px'}"/></template>`,
  'View.vue':`<script setup>import Good from './Good'</script><template><Good class="forwarded"><p>Child</p></Good></template>`,
 },async root=>{
  const good=await compileTarget(root,{id:'good',source:'View.vue'});assert.deepEqual(good.artifact.diagnostics,[]);assert.match(good.artifact.variants.default.html,/forwarded/);assert.match(good.artifact.variants.default.html,/Child/);
  const shell=await compileTarget(root,{id:'shell',source:'Life.ts'});assert.match(shell.artifact.variants.default.html,/<div/);assert.ok(shell.artifact.diagnostics.some(d=>d.code==='PRESET_LIMIT'));
  for(const source of ['Async.ts','Early.ts']){const bad=await compileTarget(root,{id:'bad',source});assert.ok(bad.artifact.diagnostics.some(d=>d.code==='FALLBACK'));assert.doesNotMatch(bad.artifact.variants.default.html,/invented/);}
  const privateState=await compileTarget(root,{id:'private',source:'Private.vue'});assert.ok(privateState.artifact.diagnostics.some(d=>d.code==='FALLBACK'));assert.doesNotMatch(privateState.artifact.variants.default.html,/height:60px/);
 });
});
