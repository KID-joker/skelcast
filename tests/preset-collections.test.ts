import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {compileTarget} from '../src/compiler/index.js';
async function fixture(files:Record<string,string>,run:(root:string)=>Promise<void>){const root=await mkdtemp(path.join(os.tmpdir(),'skelcast-collections-'));try{for(const[name,code]of Object.entries(files))await writeFile(path.join(root,name),code);await run(root)}finally{await rm(root,{recursive:true,force:true})}}
test('switches preserve the library control heights independently of their smaller visual track',async()=>{
 await fixture({'View.vue':`<script setup>import{ElSwitch}from'element-plus'</script><template><ElSwitch/><ElSwitch size="small"/><ElSwitch size="large"/></template>`},async root=>{const{artifact}=await compileTarget(root,{id:'switches',source:'View.vue'},{},{componentPresets:['element-plus']});const html=artifact.variants.default.html;for(const height of [24,32,40])assert.match(html,new RegExp(`height:${height}px;min-width:`));assert.equal((html.match(/class="el-switch"/g)||[]).length,3)});
});
test('Element Plus tree, upload, alert and watermark render source slots and finite collections',async()=>{
 await fixture({'View.vue':`<script setup>import{ElTree,ElUpload,ElAlert,ElWatermark}from'element-plus';const rows=[{id:1,name:'Parent',nodes:[{id:2,name:'Child'}]}];const files=[{name:'Receipt',status:'success'}]</script><template><ElWatermark content="Mark"><ElAlert title="Notice" :closable="false" description="Details"/><ElTree :data="rows" :props="{label:'name',children:'nodes'}" default-expand-all show-checkbox><template #default="{node}"><strong>{{node.label}}</strong></template></ElTree><ElUpload :file-list="files" list-type="picture-card"><template #file="{file}"><p>{{file.name}}</p></template><button>Add file</button></ElUpload></ElWatermark></template>`},async root=>{
  const{artifact}=await compileTarget(root,{id:'collections',source:'View.vue'},{},{componentPresets:['element-plus']});const html=artifact.variants.default.html;
  assert.equal((html.match(/class="el-tree-node__content"/g)||[]).length,2);assert.doesNotMatch(html,/data-sk-text-content="(?:Child|Receipt)"/);assert.match(html,/data-sk-text data-sk-leaf/);assert.match(html,/Notice/);assert.match(html,/Details/);assert.match(html,/el-upload--picture-card/);assert.doesNotMatch(html,/data-sk-fallback/);
 });
});
test('vuedraggable uses ordered scoped items only with confirmed library identity',async()=>{
 await fixture({'View.vue':`<script setup>import Sortable from'vuedraggable';const items=[{size:45},{size:90}]</script><template><Sortable :list="items"><template #item="{element,index}"><article :style="{height:element.size+'px'}">{{index}}</article></template></Sortable></template>`},async root=>{
  const{artifact}=await compileTarget(root,{id:'sortable',source:'View.vue'},{},{componentPresets:['vuedraggable']});assert.match(artifact.variants.default.html,/height:45px/);assert.match(artifact.variants.default.html,/height:90px/);assert.doesNotMatch(artifact.variants.default.html,/data-sk-fallback/);
  const result=await compileTarget(root,{id:'off',source:'View.vue'});assert.match(result.artifact.variants.default.html,/data-sk-fallback/);
 });
});
test('tabs keep the active source body and its custom directives instead of only drawing labels',async()=>{
 await fixture({'listener.ts':`export default{mounted(el){el.addEventListener('click',()=>{throw Error('never run')})}}`,'View.vue':`<script setup>import{ElTabs,ElTabPane}from'element-plus';import vListener from'./listener';const active='two'</script><template><ElTabs :model-value="active"><ElTabPane name="one" label="One"><p>First data</p></ElTabPane><ElTabPane name="two" label="Two"><button v-listener>Action</button><p>Second data</p></ElTabPane></ElTabs></template>`},async root=>{const{artifact}=await compileTarget(root,{id:'tabs',source:'View.vue'},{},{componentPresets:['element-plus']});assert.match(artifact.variants.default.html,/Action/);assert.match(artifact.variants.default.html,/Second data/);assert.match(artifact.variants.default.html,/display:none/);assert.ok(artifact.evidence.some(e=>e.decision.includes('event-only')))});
});
test('nested table columns flatten to a bounded outline without merged cells or summaries',async()=>{
 await fixture({'View.vue':`<script setup>import{ElTable,ElTableColumn}from'element-plus';const span=({rowIndex,columnIndex})=>{if(columnIndex===0){if(rowIndex%2===0)return{rowspan:2,colspan:1};return{rowspan:0,colspan:0}}}</script><template><ElTable :data="unknown" :span-method="span" show-summary><ElTableColumn label="Group"><ElTableColumn label="One" width="80"/><ElTableColumn label="More"><ElTableColumn label="Two" width="90"/><ElTableColumn label="Three" width="100"/></ElTableColumn></ElTableColumn></ElTable></template>`},async root=>{const{artifact}=await compileTarget(root,{id:'groups',source:'View.vue',hints:{repeat:4}},{},{componentPresets:['element-plus']});const html=artifact.variants.default.html;assert.doesNotMatch(html,/colspan|rowspan|<tfoot/);assert.match(html,/>One<\/th>/);assert.match(html,/>Two<\/th>/);assert.match(html,/>Three<\/th>/);assert.equal((html.match(/<col data-sk-layout/g)||[]).length,3);assert.doesNotMatch(html,/<tfoot/)});
});
