import {test,expect}from'@playwright/test';
import{mkdtemp,mkdir,writeFile,symlink,rm}from'node:fs/promises';
import os from'node:os';
import path from'node:path';
import{createServer}from'vite';
import vue from'@vitejs/plugin-vue';
import{compileTarget}from'../../src/compiler/index.js';

test('React and Vue pending children remain measurable at mount without painting, receiving focus, expanding flow or remounting',async({page})=>{
 const repo=process.cwd(),root=await mkdtemp(path.join(os.tmpdir(),'skelcast-mount-geometry-'));let server:Awaited<ReturnType<typeof createServer>>|undefined;
 try{
  await mkdir(path.join(root,'node_modules'));for(const name of['vue','react','react-dom','skelcast'])await symlink(name==='skelcast'?repo:path.join(repo,'node_modules',name),path.join(root,'node_modules',name),'dir');
  const artifact=(id:string)=>({id,kind:'request',render:'light',source:'',defaultVariant:'default',variants:{default:{html:`<div data-sk-artifact="${id}" style="height:64px;background:#ddd"></div>`,css:''}},diagnostics:[],evidence:[],sources:{}});
  await writeFile(path.join(root,'index.html'),`<!doctype html><style>body{margin:0}.spacer{height:120px}.frame{width:70vw;max-width:640px}.after{height:20px}</style><div class="spacer"></div><div id="vue" class="frame"></div><div class="after"></div><div id="react" class="frame"></div><div class="after"></div><button id="finish">Finish</button><script type="module" src="/main.js"></script>`);
  await writeFile(path.join(root,'VueView.vue'),`<script setup>import{ref,onMounted,h,defineComponent}from'vue';import{LoadingBoundary}from'skelcast/vue';const pending=ref(true);const artifact=${JSON.stringify(artifact('vue-measured'))};const Child=defineComponent({setup(){const el=ref();onMounted(()=>{const rect=el.value.getBoundingClientRect();window.observedVue={width:rect.width,top:rect.top};window.mountsVue=(window.mountsVue??0)+1;el.value.style.height=(window.innerHeight-rect.top-50)+'px'});return()=>h('section',{ref:el,style:{height:'150px'},'data-source':'vue'},[h('input',{value:'Initial'})])}});window.finishVue=()=>pending.value=false;</script><template><LoadingBoundary :artifact="artifact" :pending="pending"><Child/></LoadingBoundary></template>`);
  await writeFile(path.join(root,'main.js'),`import{createApp}from'vue';import View from'./VueView.vue';import{createElement as h,useState,useLayoutEffect,useRef}from'react';import{createRoot}from'react-dom/client';import{LoadingBoundary}from'skelcast/react';createApp(View).mount('#vue');const artifact=${JSON.stringify(artifact('react-measured'))};function Child(){const el=useRef();useLayoutEffect(()=>{const rect=el.current.getBoundingClientRect();window.observedReact={width:rect.width,top:rect.top};window.mountsReact=(window.mountsReact??0)+1;el.current.style.height=(innerHeight-rect.top-50)+'px'},[]);return h('section',{ref:el,style:{height:150},'data-source':'react'},h('input',{defaultValue:'Initial'}))}function App(){const[pending,setPending]=useState(true);window.finishReact=()=>setPending(false);return h(LoadingBoundary,{artifact,pending},h(Child))}createRoot(document.querySelector('#react')).render(h(App));document.querySelector('#finish').onclick=()=>{window.finishVue();window.finishReact()};`);
  server=await createServer({root,configFile:false,plugins:[vue()],logLevel:'silent',optimizeDeps:{exclude:['skelcast']},server:{host:'127.0.0.1',port:0,watch:null,fs:{allow:[root,repo]}}});await server.listen();
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address()as{port:number}).port}/`);await expect(page.locator('[data-sk-boundary]')).toHaveCount(2);
  for(const framework of['vue','react']){
   const boundary=page.locator(`[data-sk-boundary="${framework}-measured"]`),content=boundary.locator('[data-sk-content]'),source=content.locator('section');
   await expect(boundary).toHaveAttribute('aria-busy','true');await expect(content).toBeHidden();await expect(content).toHaveAttribute('inert','');await expect(content).toHaveAttribute('aria-hidden','true');
   const measured=await page.evaluate(name=>(window as any)['observed'+name],framework==='vue'?'Vue':'React'),box=(await boundary.boundingBox())!;
   expect(measured.width).toBeCloseTo(box.width,1);expect(measured.top).toBeCloseTo(box.y,1);expect(box.height).toBe(64);expect((await source.boundingBox())!.height).toBeGreaterThan(150);
   await source.locator('input').evaluate((input:HTMLInputElement)=>input.focus());await expect(source.locator('input')).not.toBeFocused();
  }
  const before=await page.evaluate(()=>document.documentElement.scrollHeight);expect(before).toBeLessThanOrEqual(1050);
  await page.locator('#finish').click();
  for(const framework of['vue','react']){const boundary=page.locator(`[data-sk-boundary="${framework}-measured"]`);await expect(boundary).toHaveAttribute('aria-busy','false');await expect(boundary.locator('[data-sk-content]')).toBeVisible();await expect(boundary.locator('[data-sk-content]')).not.toHaveAttribute('inert');expect(await page.evaluate(name=>(window as any)['mounts'+name],framework==='vue'?'Vue':'React')).toBe(1);}
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});

test('table structure auditing sees grouped and horizontally clipped columns and rejects matching outer boxes with missing columns',async({page})=>{
 const repo=process.cwd(),root=await mkdtemp(path.join(os.tmpdir(),'skelcast-table-audit-'));let server:Awaited<ReturnType<typeof createServer>>|undefined;
 try{
  await writeFile(path.join(root,'index.html'),`<!doctype html><style>.frame{width:100px;height:100px;overflow:auto}table{width:400px;table-layout:fixed}</style><div id="real" class="frame"><table><thead><tr><th rowspan="2">ID</th><th colspan="2">Group</th></tr><tr><th>Name</th><th>Size</th></tr></thead></table></div><div id="generated" class="frame"><table><thead><tr><th>ID</th><th>Name</th></tr></thead></table></div>`);
  server=await createServer({root,configFile:false,logLevel:'silent',server:{host:'127.0.0.1',port:0,watch:null,fs:{allow:[root,repo]}}});await server.listen();await page.goto(`http://127.0.0.1:${(server.httpServer!.address()as{port:number}).port}/`);
  const result=await page.evaluate(async url=>{const{captureLayout,compareLayouts}=await import(url);const ids=new Set<string>(),real=captureLayout(document.querySelector('#real'),ids),skeleton=captureLayout(document.querySelector('#generated'),ids);return{real:real.tables,skeleton:skeleton.tables,issues:compareLayouts(real,{...skeleton,box:real.box}).issues.map((issue:{code:string})=>issue.code)}},`/@fs/${repo}/dist/browser.js`);
  expect(result.real).toEqual([{columns:3,headerRows:2}]);expect(result.skeleton).toEqual([{columns:2,headerRows:1}]);expect(result.issues).toEqual(['TABLE_STRUCTURE_MISMATCH']);
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});

test('finite source list bounds preserve library timeline structure inside a max-height scroll region',async({page})=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'skelcast-timeline-'));
 try{
  await writeFile(path.join(root,'View.vue'),`<script setup>import{ElScrollbar,ElTimeline,ElTimelineItem}from'element-plus';const entries=opaque().slice(0,12).map(item=>item)</script><template><ElScrollbar max-height="180"><ElTimeline><ElTimelineItem v-for="entry in entries" :timestamp="entry.time" placement="top"><p>{{entry.title}}</p></ElTimelineItem></ElTimeline></ElScrollbar></template><style scoped>:deep(.el-timeline.is-start){padding-left:7px}</style>`);
  const{artifact}=await compileTarget(root,{id:'timeline',source:'View.vue'},{},{componentPresets:['element-plus']});expect(artifact.diagnostics.some(d=>d.code==='LOADING_PROJECTION')).toBe(true);expect(artifact.diagnostics.some(d=>d.code==='FALLBACK')).toBe(false);
  for(const width of[390,1440]){await page.setViewportSize({width,height:900});const view=artifact.variants.default;await page.setContent(`<!doctype html><style>body{margin:0;font:14px/20px sans-serif}p{margin:0}${view.css}</style>${view.html}`);await expect(page.locator('.el-timeline-item')).toHaveCount(12);await expect(page.locator('.el-timeline')).toHaveCSS('padding-left','7px');expect((await page.locator('.el-scrollbar').boundingBox())!.height).toBe(180);expect(await page.locator('.el-scrollbar__wrap').evaluate(node=>node.scrollHeight>node.clientHeight)).toBe(true);}
 }finally{await rm(root,{recursive:true,force:true});}
});

test('masked declared cell glyphs preserve native text wrapping at narrow and wide widths while source values remain unknown',async({page})=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'skelcast-glyph-wrap-'));
 const text='A detailed address with multiple words spanning several lines in a narrow column.';
 try{
  await writeFile(path.join(root,'View.vue'),`<script setup>import{ElTable}from'element-plus';const rows=[{address:${JSON.stringify(text)}}];opaque(rows);const columns=[{label:'Address',prop:'address'}]</script><template><ElTable :data="rows" :columns="columns"/></template>`);
  const{artifact}=await compileTarget(root,{id:'glyph-wrap',source:'View.vue'},{},{componentPresets:['element-plus']});expect(artifact.diagnostics.some(d=>/glyph prototypes/.test(d.message))).toBe(true);
  const view=artifact.variants.default;
  for(const width of[100,360]){
   await page.setContent(`<!doctype html><style>body{margin:0;font:14px/20px sans-serif}${view.css}</style><div id="reference" style="width:${width}px"><table style="width:100%;border-collapse:collapse;table-layout:fixed"><thead><tr><th style="padding:8px 0;text-align:left;font-weight:500;border-bottom:1px solid #e4e7ed"><div style="padding:0 12px;line-height:23px;overflow-wrap:break-word">Address</div></th></tr></thead><tbody><tr><td style="padding:8px 0;border-bottom:1px solid #eee"><div style="padding:0 12px;line-height:23px;overflow-wrap:break-word">${text}</div></td></tr></tbody></table></div><div id="generated" style="width:${width}px">${view.html}</div>`);
   const real=(await page.locator('#reference table').boundingBox())!,skeleton=(await page.locator('#generated table').boundingBox())!;expect(skeleton.height).toBeCloseTo(real.height,1);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test('React and Vue preserve source intrinsic widths of flex siblings through pending and forced preview',async({page})=>{
 const repo=process.cwd(),root=await mkdtemp(path.join(os.tmpdir(),'skelcast-intrinsic-'));let server:Awaited<ReturnType<typeof createServer>>|undefined;
 try{
  await mkdir(path.join(root,'node_modules'));for(const name of['vue','react','react-dom','skelcast'])await symlink(name==='skelcast'?repo:path.join(repo,'node_modules',name),path.join(root,'node_modules',name),'dir');
  const artifact=(id:string)=>({id,kind:'request',render:'light',source:'',defaultVariant:'default',variants:{default:{html:`<div data-sk-artifact="${id}" style="width:100%;height:64px"></div>`,css:''}},diagnostics:[],evidence:[],sources:{}});
  await writeFile(path.join(root,'index.html'),`<!doctype html><style>body{margin:0}.row{display:flex;width:800px}.aside{width:300px;min-width:0}.main{width:600px}.source{width:600px;height:100px}</style><div class="row"><aside class="aside"></aside><div class="main" id="vue"></div></div><div class="row"><aside class="aside"></aside><div class="main" id="react"></div></div><button id="finish">Finish</button><script type="module" src="/main.js"></script>`);
  await writeFile(path.join(root,'View.vue'),`<script setup>import{ref}from'vue';import{LoadingBoundary}from'skelcast/vue';const pending=ref(true);const artifact=${JSON.stringify(artifact('vue-intrinsic'))};window.finishVue=()=>pending.value=false;</script><template><LoadingBoundary :artifact="artifact" :pending="pending"><div class="source"><input value="Keep"/></div></LoadingBoundary></template>`);
  await writeFile(path.join(root,'main.js'),`import{createApp}from'vue';import View from'./View.vue';import{createElement as h,useState}from'react';import{createRoot}from'react-dom/client';import{LoadingBoundary}from'skelcast/react';createApp(View).mount('#vue');function App(){const[pending,setPending]=useState(true);window.finishReact=()=>setPending(false);return h(LoadingBoundary,{artifact:${JSON.stringify(artifact('react-intrinsic'))},pending},h('div',{className:'source'},h('input',{defaultValue:'Keep'})))}createRoot(document.querySelector('#react')).render(h(App));document.querySelector('#finish').onclick=()=>{window.finishVue();window.finishReact()};`);
  server=await createServer({root,configFile:false,plugins:[vue()],logLevel:'silent',optimizeDeps:{exclude:['skelcast']},server:{host:'127.0.0.1',port:0,watch:null,fs:{allow:[root,repo]}}});await server.listen();await page.setViewportSize({width:1000,height:900});await page.goto(`http://127.0.0.1:${(server.httpServer!.address()as{port:number}).port}/`);
  for(const framework of['vue','react']){
   const boundary=page.locator(`[data-sk-boundary="${framework}-intrinsic"]`);await expect(boundary).toHaveAttribute('aria-busy','true');expect((await boundary.boundingBox())!.x).toBe(200);expect((await boundary.boundingBox())!.width).toBe(600);expect((await boundary.boundingBox())!.height).toBe(64);await expect(boundary.locator('input')).toBeHidden();
  }
  await page.getByRole('button',{name:'Finish',exact:true}).click();
  for(const framework of['vue','react']){
   const boundary=page.locator(`[data-sk-boundary="${framework}-intrinsic"]`);await expect(boundary).toHaveAttribute('aria-busy','false');
   const report=await page.evaluate(async({url,id})=>{const{auditBoundaryLayout}=await import(url);return auditBoundaryLayout(document.querySelector(`[data-sk-boundary="${id}"]`));},{url:`/@fs/${repo}/dist/browser.js`,id:`${framework}-intrinsic`});
   expect(report.delta.x).toBe(0);expect(report.delta.width).toBe(0);expect(report.skeleton.box.height).toBe(64);expect((await boundary.boundingBox())!.height).toBe(100);await expect(boundary.locator('input')).toHaveValue('Keep');
  }
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});
