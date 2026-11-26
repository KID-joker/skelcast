import {test,expect} from '@playwright/test';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'vite';
import vue from '@vitejs/plugin-vue';
import {compileTarget} from '../../src/compiler/index.js';

test('response-linked loading template matches resolved native grid on desktop and mobile',async({page})=>{
 const repo=process.cwd(),root=await mkdtemp(path.join(os.tmpdir(),'skelcast-loading-grid-'));let server:Awaited<ReturnType<typeof createServer>>|undefined;
 try{
  await mkdir(path.join(root,'node_modules'));for(const name of ['vue','skelcast'])await symlink(name==='skelcast'?repo:path.join(repo,'node_modules',name),path.join(root,'node_modules',name),'dir');
  await writeFile(path.join(root,'index.html'),'<!doctype html><style>body{margin:0;font:14px/20px sans-serif}</style><div id="app"></div><script type="module" src="/main.js"></script>');
  await writeFile(path.join(root,'main.js'),`import{createApp}from'vue';import View from './View.vue';createApp(View).mount('#app');`);
  await writeFile(path.join(root,'View.vue'),`<script setup>import{ref,onMounted}from'vue';import{LoadingBoundary}from'skelcast/vue';import artifact from './artifact.js';const rows=ref([]),page=ref({size:6,total:0}),pending=ref(true);function receive(response){rows.value=response.items;page.value={...page.value,total:response.items.length};pending.value=false}onMounted(()=>setTimeout(()=>receive({items:Array.from({length:6},(_,i)=>({title:'Item '+i}))}),30));</script><template><LoadingBoundary :artifact="artifact" :pending="pending"><section><p v-show="rows.length===0">Empty</p><div v-if="page.total>0" class="grid"><article v-for="row in rows.slice(0,page.size)">{{row.title}}</article></div></section></LoadingBoundary><footer>Following content</footer></template><style scoped>.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}article{height:72px;padding:16px;background:#eee}@media(max-width:600px){.grid{grid-template-columns:1fr}}</style>`);
  const {artifact}=await compileTarget(root,{id:'grid',source:'View.vue',kind:'request',region:'artifact'});expect(artifact.diagnostics.every(d=>d.code==='LOADING_PROJECTION')).toBe(true);
  await writeFile(path.join(root,'artifact.js'),`export default ${JSON.stringify(artifact)}`);
  server=await createServer({root,configFile:false,plugins:[vue()],logLevel:'silent',optimizeDeps:{exclude:['skelcast']},server:{host:'127.0.0.1',port:0,watch:null,fs:{allow:[repo,root]}}});await server.listen();
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}/`);
  await expect(page.locator('[data-sk-boundary="grid"]')).toHaveAttribute('aria-busy','false');
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:900});
   const result=await page.evaluate(async url=>{const{auditBoundaryLayout}=await import(url);return auditBoundaryLayout(document.querySelector('[data-sk-boundary="grid"]'),{tolerancePx:2,toleranceRatio:0});},`/@fs/${repo}/dist/browser.js`);
   expect(result.issues,JSON.stringify({width,content:result.content.box,skeleton:result.skeleton.box,html:artifact.variants.default.html})).toEqual([]);expect(result.delta.followingContentShift).toBeCloseTo(0,1);
  }
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});

test('CSS pruning preserves responsive geometry and source text wrapping against the full stylesheet',async({page})=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'skelcast-pruning-'));
 try{
  await writeFile(path.join(root,'View.vue'),`<template><main class="frame"><article class="used">A long source text that wraps over several lines on narrow screens.</article></main></template><style>.unused{height:999px}.frame{width:100%;padding:16px}.used:not(.absent){max-width:500px;padding:12px;font:16px/24px sans-serif}@media(min-width:700px){.used{max-width:800px}}:is(.absent,.used){border:1px solid black}</style>`);
  const full=(await compileTarget(root,{id:'compare',source:'View.vue'},{},{styles:{prune:false}})).artifact.variants.default;
  const pruned=(await compileTarget(root,{id:'compare',source:'View.vue'})).artifact.variants.default;
  expect(pruned.css.length).toBeLessThan(full.css.length);
  for(const width of [390,1440]){
   await page.setViewportSize({width,height:900});const boxes=[];
   for(const view of [full,pruned]){await page.setContent(`<!doctype html><style>body{margin:0}${view.css}</style>${view.html}`);boxes.push(await page.locator('.used').boundingBox());}
   expect(boxes[1]).toEqual(boxes[0]);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test('different artifacts share the base sheet, keep cascade order and release the final reference',async({page})=>{
 const repo=process.cwd(),root=await mkdtemp(path.join(os.tmpdir(),'skelcast-style-share-'));let server:Awaited<ReturnType<typeof createServer>>|undefined;
 try{
  await writeFile(path.join(root,'index.html'),'<!doctype html><div id="a"></div><div id="b"></div>');
  server=await createServer({root,configFile:false,logLevel:'silent',server:{host:'127.0.0.1',port:0,watch:null,fs:{allow:[root,repo]}}});await server.listen();await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}/`);
  const result=await page.evaluate(async url=>{
   const{mountSkeleton}=await import(url);const common='[data-sk-artifact] [data-sk-leaf]{background-color:rgb(10,20,30)!important;height:20px}';
   const make=(id:string)=>({id,kind:'request',render:'light',defaultVariant:'default',variants:{default:{html:`<div data-sk-artifact="${id}"><span data-sk-leaf>Data</span></div>`,css:`[data-sk-artifact="${id}"] [data-sk-leaf]{background-color:red!important}/* skelcast-shared-base */${common}`}},diagnostics:[],evidence:[],sources:{},source:''});
   const releaseA=mountSkeleton(document.querySelector('#a'),make('a')),releaseB=mountSkeleton(document.querySelector('#b'),make('b'));
   const counts=[document.querySelectorAll('head style[data-sk-style]').length],shared=document.querySelectorAll('[data-sk-shared]').length,color=getComputedStyle(document.querySelector('#b span')!).backgroundColor;
   releaseA();counts.push(document.querySelectorAll('head style[data-sk-style]').length);releaseB();counts.push(document.querySelectorAll('head style[data-sk-style]').length);return{counts,shared,color};
  },`/@fs/${repo}/dist/runtime/index.js`);
  expect(result).toEqual({counts:[3,2,0],shared:1,color:'rgb(10, 20, 30)'});
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});

test('audit anchors ignore runtime IDs but retain declared IDs and explicit missing anchors',async({page})=>{
 const repo=process.cwd(),root=await mkdtemp(path.join(os.tmpdir(),'skelcast-anchor-ids-'));let server:Awaited<ReturnType<typeof createServer>>|undefined;
 try{
  await writeFile(path.join(root,'index.html'),'<!doctype html><div id="real"><div id="stable" style="height:40px"><span id="runtime-random-id">Text</span><b data-sk-anchor="row">Row</b></div></div><div id="generated"><div data-sk-source-id="stable" style="height:40px"><span>Text</span><b data-sk-anchor="row">Row</b></div></div>');
  server=await createServer({root,configFile:false,logLevel:'silent',server:{host:'127.0.0.1',port:0,watch:null,fs:{allow:[root,repo]}}});await server.listen();await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}/`);
  const result=await page.evaluate(async url=>{
   const{captureLayout,compareLayouts}=await import(url),ids=new Set(['stable']);
   const real=captureLayout(document.querySelector('#real'),ids),generated=captureLayout(document.querySelector('#generated'),ids);
   document.querySelector('[data-sk-source-id]')!.removeAttribute('data-sk-source-id');
   const missing=captureLayout(document.querySelector('#generated'),ids);
   return{real:Object.keys(real.anchors),generated:Object.keys(generated.anchors),missing:compareLayouts(real,missing).issues.map((i:{anchor:string})=>i.anchor)};
  },`/@fs/${repo}/dist/browser.js`);
  expect(result.real).toEqual(['id:stable','anchor:row']);expect(result.generated).toEqual(result.real);expect(result.missing).toContain('id:stable');
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});

test('opaque children fit source fixed containers while their own dimensions and aspect ratio retain priority',async({page})=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'skelcast-contained-'));
 try{
  await writeFile(path.join(root,'Opaque.ts'),'export default makeWidget();');
  await writeFile(path.join(root,'View.vue'),`<script setup>import Opaque from './Opaque'</script><template><main><div class="frame"><Opaque/></div><div class="frame"><Opaque style="height:20px"/></div><div class="frame"><Opaque style="width:20px;aspect-ratio:1"/></div></main></template><style scoped>.frame{display:flex;align-items:center;width:46px;height:46px;border-radius:50%}</style>`);
  const view=(await compileTarget(root,{id:'constrained',source:'View.vue'})).artifact.variants.default;
  await page.setContent(`<!doctype html><style>${view.css}</style>${view.html}`);
  const nodes=page.locator('[data-sk-fallback]');for(const [index,height]of [[0,46],[1,20],[2,20]])expect((await nodes.nth(index).boundingBox())!.height).toBeCloseTo(height,1);
  await expect(nodes.first()).toHaveCSS('border-top-left-radius','50%');
 }finally{await rm(root,{recursive:true,force:true});}
});
