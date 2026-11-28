import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {compileTarget} from '../src/compiler/index.js';
async function fixture(files:Record<string,string>,run:(root:string)=>Promise<void>){const root=await mkdtemp(path.join(os.tmpdir(),'skelcast-directive-'));try{for(const[name,code]of Object.entries(files))await writeFile(path.join(root,name),code);await run(root)}finally{await rm(root,{recursive:true,force:true})}}
test('source directives distinguish event callbacks from initial layout and never invoke either',async()=>{
 await fixture({'events.ts':`interface ElementData extends HTMLElement{payload:unknown}export default {mounted(el:ElementData,binding){let timer=null;el.payload=binding.value;el.handle=()=>{el.style.height='999px';throw Error('never invoke')};el.addEventListener('click',el.handle)}};throw Error('never import')`,'shape.ts':`export default {mounted(el){el.style.position='absolute';el.style.width='75px';el.onmousedown=()=>{el.style.width='999px'}}}`,'View.vue':`<script setup>import vEvents from'./events';import vShape from'./shape'</script><template><section><button v-events="callback">Action</button><div v-shape>Data</div></section></template>`},async root=>{
  const{artifact}=await compileTarget(root,{id:'effects',source:'View.vue'});assert.match(artifact.variants.default.html,/position:absolute/);assert.match(artifact.variants.default.html,/width:75px/);assert.doesNotMatch(artifact.variants.default.html,/999px/);assert.ok(!artifact.diagnostics.some(d=>d.code.startsWith('DIRECTIVE_')));assert.ok(artifact.evidence.some(e=>e.decision.includes('event-only')));
 });
});
test('unknown permission removal needs declared visibility variants, with no role/store inference',async()=>{
 await fixture({'gate.ts':`export default {mounted(el,binding){const store=readStore();if(!store.allowed)el.remove()}}`,'View.vue':`<script setup>import vGate from'./gate'</script><template><button v-gate="permission">Restricted</button></template>`},async root=>{
  const{artifact}=await compileTarget(root,{id:'visibility',source:'View.vue',variants:{allowed:{bindings:{'v-gate.visible':true}},denied:{bindings:{'v-gate.visible':false}},unknown:{}}});assert.match(artifact.variants.allowed.html,/Restricted/);assert.doesNotMatch(artifact.variants.denied.html,/Restricted/);assert.ok(artifact.diagnostics.some(d=>d.code==='DIRECTIVE_VISIBILITY_UNKNOWN'&&d.variants?.includes('unknown')));assert.ok(!artifact.diagnostics.some(d=>d.variants?.includes('allowed')||d.variants?.includes('denied')));
 });
});
test('local plugin directives registered through a finite install table retain source dependency identity',async()=>{
 await fixture({'index.html':'<script type="module" src="/main.ts"></script>','main.ts':`import{createApp}from'vue';import plugin from'./plugin';const app=createApp({});app.use(plugin)`,'plugin.ts':`import painted from'./painted';const registry={painted};export default {install(app){Object.keys(registry).forEach(key=>app.directive(key,registry[key]))}}`,'painted.ts':`export default {mounted(el){el.style.height='37px'}}`,'View.vue':'<template><div v-painted>Data</div></template>'},async root=>{const{artifact,dependencies}=await compileTarget(root,{id:'global',source:'View.vue'});assert.match(artifact.variants.default.html,/height:37px/);assert.ok(dependencies['painted.ts']);assert.ok(!artifact.diagnostics.some(d=>d.code==='DIRECTIVE_UNKNOWN'))});
});
