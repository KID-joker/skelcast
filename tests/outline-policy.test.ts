import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {compileTarget} from '../src/compiler/index.js';
import {initProject} from '../src/init/index.js';
import {analyzeQuality} from '../src/quality.js';
import {projectFromConfig,checkProject,syncProject} from '../src/generator.js';

async function fixture(files:Record<string,string>,run:(root:string)=>Promise<void>){
  const root=await mkdtemp(path.join(os.tmpdir(),'skelcast-outline-'));
  try{for(const[file,code]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),code);}await run(root);}
  finally{await rm(root,{recursive:true,force:true});}
}

test('table outlines skip data cells, nested widgets, callbacks and large source row counts',async()=>{
  await fixture({
    'View.vue':`<script setup>import{ElTable,ElTableColumn}from'element-plus';const rows=Array.from({length:100},()=>({value:'PRIVATE'}))</script><template><ElTable :data="rows" :span-method="runBusiness"><ElTableColumn label="Name" width="180"><MissingWidget/><template #default="{row}">{{runBusiness(row)}}</template></ElTableColumn><ElTableColumn label="Group"><ElTableColumn label="Size"/></ElTableColumn></ElTable></template>`,
  },async root=>{
    const {artifact}=await compileTarget(root,{id:'table',source:'View.vue',kind:'request'},{},{componentPresets:['element-plus']});
    const html=artifact.variants.default.html;
    assert.equal((html.match(/<td /g)??[]).length,8);
    assert.match(html,/>Name<\/th>/);assert.match(html,/>Size<\/th>/);
    assert.doesNotMatch(html,/MissingWidget|PRIVATE|runBusiness|rowspan|Group|data-sk-text-content/);
    assert.deepEqual(artifact.diagnostics,[]);
    assert.ok(!artifact.evidence.some(item=>/runBusiness|MissingWidget/.test(item.expression)));
    const repeat=await compileTarget(root,{id:'table',source:'View.vue',hints:{repeat:2}},{},{componentPresets:['element-plus']});
    assert.equal((repeat.artifact.variants.default.html.match(/<td /g)??[]).length,4);
  });
});

test('fixed content remains readable while finite data expressions use generic placeholders',async()=>{
  await fixture({'View.tsx':`const data={title:'PRIVATE'};export default()=> <main><h1>Orders</h1><p>Manage orders</p><h2>{data.title}</h2><span data-sk-mask>Sample value</span><aside data-sk-preserve>Fixed note</aside></main>`},async root=>{
    const {artifact}=await compileTarget(root,{id:'text',source:'View.tsx'});
    const html=artifact.variants.default.html;
    assert.match(html,/>Orders<\/h1>/);assert.match(html,/>Manage orders<\/p>/);assert.match(html,/>Fixed note<\/aside>/);
    assert.doesNotMatch(html,/PRIVATE|Sample value|data-sk-measured|data-sk-text-content/);
    assert.equal(analyzeQuality(artifact).variants.default.placeholders,2);
  });
});

test('native table outlines keep their native root, caller selectors and outer sizing in every frontend',async()=>{
  await fixture({
    'View.tsx':`export default()=> <table className="report" style={{height:240}}><thead><tr><th>Name</th></tr></thead><tbody><tr><td><Missing/></td></tr></tbody></table>`,
    'View.vue':`<template><table class="report" style="height:240px"><thead><tr><th>Name</th></tr></thead><tbody><tr><td><Missing/></td></tr></tbody></table></template>`,
    'View.ts':`import{h}from'vue';export default()=>h('table',{class:'report',style:{height:240}},[h('thead',null,[h('tr',null,[h('th',null,'Name')])]),h('tbody',null,[h('tr',null,[h('td',null,[h(Missing)])])])])`,
    'HTML.vue':`<template><div v-html="'<table class=&quot;report&quot; style=&quot;height:240px&quot;><thead><tr><th>Name</th></tr></thead><tbody><tr><td>PRIVATE</td></tr></tbody></table>'"/></template>`,
  },async root=>{
    for(const source of ['View.tsx','View.vue','View.ts','HTML.vue']){
      const{artifact}=await compileTarget(root,{id:'native',source});
      const html=artifact.variants.default.html;
      assert.match(html,/<table[^>]*class="report"/);assert.match(html,/<table[^>]*height:240px/);
      assert.match(html,/data-sk-outline/);assert.doesNotMatch(html,/PRIVATE|Missing|sk-table-outline/);
      assert.equal((html.match(/<td /g)??[]).length,4);
      assert.deepEqual(artifact.diagnostics,[]);
    }
  });
});

test('configured graphics stop before local source expansion and live widgets are never static clones',async()=>{
  await fixture({
    'Chart.tsx':`import './widget.css';export default()=> <MissingChart/>`,
    'Editor.tsx':`import './widget.css';export default()=> <MissingEditor/>`,
    'widget.css':'.editor-internals{background:url(./missing.png)}',
    'View.tsx':`import Chart from './Chart';import Editor from './Editor';export default()=> <main><Chart height={280}/><Editor/><section data-sk-live><Missing/></section></main>`,
  },async root=>{
    const{artifact,dependencies}=await compileTarget(root,{id:'widgets',source:'View.tsx'},{},{componentPolicies:{Chart:'graphic',Editor:'live'}});
    const view=artifact.variants.default;
    assert.match(view.html,/height:280px/);assert.match(view.html,/data-sk-outline/);
    assert.doesNotMatch(view.html+view.css,/Missing|editor-internals|widget.css/);
    assert.doesNotMatch(view.html,/data-sk-fallback/);
    assert.ok(dependencies['Chart.tsx']);assert.ok(dependencies['Editor.tsx']);
    assert.equal(artifact.diagnostics.filter(d=>d.code==='LIVE_CONTENT_IN_BOUNDARY').length,2);
    await assert.rejects(projectFromConfig(root,{targets:[],componentPolicies:{Editor:'invalid' as 'live'}}),/componentPolicies/);
  });
});

test('forms skip option internals and request values; tree and upload placeholders omit original strings',async()=>{
  await fixture({
    'View.vue':`<script setup>import{ElForm,ElFormItem,ElSelect,ElTree,ElUpload}from'element-plus';const rows=[{label:'PRIVATE_NODE'}],files=[{name:'PRIVATE_FILE'}]</script><template><ElForm><ElFormItem label="Category"><ElSelect><MissingOption/></ElSelect></ElFormItem><input value="PRIVATE_VALUE" placeholder="Enter name"><select><MissingOption/></select><textarea>PRIVATE_DRAFT</textarea></ElForm><ElTree :data="rows"/><ElUpload :file-list="files"><button>Upload</button></ElUpload></template>`,
  },async root=>{
    const{artifact}=await compileTarget(root,{id:'form',source:'View.vue',kind:'request'},{},{componentPresets:['element-plus']});
    const html=artifact.variants.default.html;
    assert.match(html,/>Category<\/label>/);assert.match(html,/placeholder="Enter name"/);assert.match(html,/>Upload<\/button>/);
    assert.doesNotMatch(html,/PRIVATE_|MissingOption|data-sk-measured|data-sk-text-content/);
    assert.deepEqual(artifact.diagnostics,[]);
  });
});

test('identified widgets keep their policy when dimensions are unknown and policy changes invalidate artifacts',async()=>{
  await fixture({
    'View.tsx':`import Editor from '@monaco-editor/react';import{Table}from'antd';export default()=> <main><Editor height={unknownHeight}/><Chart height={unknownHeight}/><Table style={{height:unknownHeight}}/></main>`,
  },async root=>{
    const config={targets:[{id:'widgets',source:'View.tsx'}],componentPresets:['antd' as const],componentPolicies:{Chart:'graphic' as const}};
    const project=await projectFromConfig(root,config);
    await syncProject(project);assert.equal((await checkProject(project))[0].state,'ready');
    const{artifact}=await compileTarget(root,config.targets[0],{},config);
    assert.doesNotMatch(artifact.variants.default.html,/data-sk-fallback/);
    assert.equal((artifact.variants.default.html.match(/data-sk-outline/g)??[]).length,3);
    assert.ok(artifact.diagnostics.some(d=>d.code==='LIVE_CONTENT_IN_BOUNDARY'));
    const changed=await projectFromConfig(root,{...config,componentPolicies:{Chart:'live'}});
    assert.equal((await checkProject(changed))[0].state,'stale');
  });
});

for(const framework of ['react','vue'] as const)test(`init keeps ${framework} live components outside newly generated loading boundaries`,async()=>{
  await fixture({
    'package.json':JSON.stringify({dependencies:{[framework]:'*',vite:'*',skelcast:'*'}}),
    'vite.config.mjs':'export default {}',
    [`src/App.${framework==='react'?'jsx':'vue'}`]:framework==='react'
      ? `import React from 'react';export default()=> <main loading={pending}><h1>Orders</h1><section data-sk-live><CustomEditor/></section><section className="results">{rows.map(row=><p>{row.name}</p>)}</section></main>`
      : `<template><main v-loading="pending"><h1>Orders</h1><section data-sk-live><CustomEditor/></section><section class="results"><p v-for="row in rows">{{row.name}}</p></section></main></template>`,
  },async root=>{
    const report=await initProject(root);
    assert.equal(report.targets.length,1);assert.equal(report.targets[0].kind,'request');
    const edited=report.changes.find(change=>change.file.startsWith('src/App.'))!.after;
    assert.match(edited,/<main\s*>/);
    assert.ok(edited.indexOf('data-sk-live')<edited.indexOf('artifact='));
    assert.ok(report.diagnostics.some(d=>d.code==='PAGE_LIVE_CONTENT'));
    assert.ok(!report.generated?.some(row=>row.diagnostics));
    assert.equal((await initProject(root)).changes.length,0);
  });
});

test('editor identity follows imports and aliases rather than its tag spelling',async()=>{
  await fixture({
    'package.json':JSON.stringify({dependencies:{react:'*',vite:'*',skelcast:'*'}}),'vite.config.mjs':'export default {}',
    'src/App.jsx':`import Editor from '@monaco-editor/react';export default()=> <main loading={pending}><Editor/><section>{data}</section></main>`,
  },async root=>{
    const report=await initProject(root,{dryRun:true});
    assert.equal(report.targets.length,1);assert.equal(report.targets[0].kind,'request');
    assert.ok(report.changes.some(change=>change.file==='src/App.jsx'&&change.after.includes('<Editor/>')));
  });
});

for(const framework of ['react','vue'] as const)test(`${framework} boundary narrowing distinguishes literal headings from dynamic headings and paragraphs`,async()=>{
  await fixture({
    'package.json':JSON.stringify({dependencies:{[framework]:'*',vite:'*',skelcast:'*'}}),'vite.config.mjs':'export default {}',
    [`src/App.${framework==='react'?'jsx':'vue'}`]:framework==='react'
      ? `export default()=> <main loading={pending}><h1>Fixed heading</h1><div contentEditable="plaintext-only"/><h2>{data.title}</h2><p>{data.summary}</p></main>`
      : `<template><main v-loading="pending"><h1>Fixed heading</h1><div contenteditable="plaintext-only"/><h2>{{data.title}}</h2><p>{{data.summary}}</p></main></template>`,
  },async root=>{
    const report=await initProject(root,{dryRun:true});
    assert.equal(report.targets.length,2);assert.ok(report.targets.every(t=>t.kind==='request'));
    const source=report.changes.find(change=>change.file.startsWith('src/App.'))!.after;
    assert.ok(source.indexOf('Fixed heading')<source.indexOf('artifact='));
  });
});

test('existing manual boundaries containing live content produce actionable source diagnostics',async()=>{
  await fixture({
    'package.json':JSON.stringify({dependencies:{vue:'*',vite:'*',skelcast:'*'}}),'vite.config.mjs':'export default {}',
    'skelcast.config.mjs':`export default {targets:[{id:'page',source:'src/App.vue',region:'frame'}]}`,
    'src/App.vue':`<script setup>import{LoadingBoundary}from'skelcast/vue';import frame from'virtual:skelcast/page'</script><template><LoadingBoundary :artifact="frame" :pending="pending"><div contenteditable>Draft</div></LoadingBoundary></template>`,
  },async root=>{
    const report=await initProject(root,{dryRun:true});
    assert.ok(report.diagnostics.some(d=>d.code==='LIVE_CONTENT_IN_BOUNDARY'&&d.line));
    assert.equal(report.targets.length,0);
  });
});
