import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { parse } from '@vue/compiler-dom';
import { compileTarget } from '../src/compiler/index.js';
import { createArtifactOptimizer } from '../src/compiler/optimize.js';

// Same input before and after the migration. Run with node --import tsx.
const root = await mkdtemp(path.join(tmpdir(), 'skelcast-outline-size-'));
try {
  const fixtures = {
    table: `<script setup>import {ElTable,ElTableColumn,ElButton} from 'element-plus';const rows=Array.from({length:20},(_,i)=>({name:'Record '+i}));</script><template><section><h1>Orders</h1><p>Manage your orders here.</p><ElTable :data="rows" height="440"><ElTableColumn label="Name" prop="name"/><ElTableColumn label="Details"><template #default="{row}"><div><b>{{row.name}}</b><p>Additional information about this order</p><ElButton>Open record</ElButton></div></template></ElTableColumn><ElTableColumn label="Actions"><ElButton>Edit</ElButton><ElButton>Delete</ElButton></ElTableColumn></ElTable></section></template>`,
    form: `<script setup>import {ElForm,ElFormItem,ElSelect,ElOption,ElInput} from 'element-plus';</script><template><ElForm label-width="120px"><h2>Account settings</h2><p>Update your preferences.</p><ElFormItem label="Name"><ElInput/></ElFormItem><ElFormItem label="Category"><ElSelect>${Array.from({length:30},(_,i)=>`<ElOption label="Category ${i}" value="${i}"><b>Category ${i}</b></ElOption>`).join('')}</ElSelect></ElFormItem></ElForm></template>`,
    chart: `<template><section><h2>Revenue</h2><p>Monthly revenue</p><svg viewBox="0 0 640 320" style="width:100%;height:auto">${'<path d="M0 0L10 20"/>'.repeat(100)}</svg><p>{{summary}}</p></section></template>`,
  };
  const result: Record<string,unknown> = {};
  for (const [name, code] of Object.entries(fixtures)) {
    await writeFile(path.join(root, 'View.vue'), code);
    const runs: number[] = [];
    let artifact: Awaited<ReturnType<typeof compileTarget>>['artifact'];
    for (let run=0;run<6;run++) {
      const start=performance.now();
      ({artifact}=await compileTarget(root,{id:name,source:'View.vue',kind:'request'},{},{componentPresets:['element-plus']}));
      runs.push(performance.now()-start);
    }
    const view = createArtifactOptimizer().artifact(artifact!).variants.default;
    let nodes = 0;
    const visit = (node: any) => {if(node.type===1)nodes++;for(const child of node.children??[])visit(child);};
    visit(parse(view.html));
    const payload = JSON.stringify({html:view.html,css:view.css});
    result[name] = {nodes,html:Buffer.byteLength(view.html),css:Buffer.byteLength(view.css),bytes:Buffer.byteLength(payload),brotli:brotliCompressSync(payload).length,firstMs:Math.round(runs[0]*100)/100,medianMs:Math.round(runs.slice(1).sort((a,b)=>a-b)[2]*100)/100};
  }
  const json = JSON.stringify(result,null,2)+'\n';
  if(process.argv[2])await writeFile(process.argv[2],json);
  process.stdout.write(json);
} finally {await rm(root,{recursive:true,force:true});}
