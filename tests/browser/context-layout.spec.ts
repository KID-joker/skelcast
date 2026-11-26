import{test,expect}from'@playwright/test';
import{mkdtemp,writeFile,rm}from'node:fs/promises';
import path from'node:path';import os from'node:os';
import{createServer}from'vite';
import{compileTarget}from'../../src/compiler/index.js';

for(const mode of['light','shadow'])test(`${mode}: declared viewport constraints follow their own geometry and release all observers`,async({page})=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'skelcast-viewport-')),repo=process.cwd();let server:Awaited<ReturnType<typeof createServer>>|undefined;
 try{
  await writeFile(path.join(root,'index.html'),`<!doctype html><style>body{margin:0;font:14px/20px sans-serif}#before{height:120px}#host{width:70vw}#business{height:123px}</style><div id="before"></div><div id="host"></div><div id="business" data-sk-viewport-bottom="999">Business</div>`);
  server=await createServer({root,configFile:false,logLevel:'silent',server:{host:'127.0.0.1',port:0,watch:null,fs:{allow:[root,repo]}}});await server.listen();await page.setViewportSize({width:1440,height:900});await page.goto(`http://127.0.0.1:${(server.httpServer!.address()as{port:number}).port}/`);
  await page.evaluate(async({url,mode})=>{
   const runtime=await import(url),state=window as any;state.activeResize=0;state.activeMutation=0;
   const Resize=window.ResizeObserver,Mutation=window.MutationObserver;
   window.ResizeObserver=class extends Resize{constructor(callback:ResizeObserverCallback){super(callback);state.activeResize++}disconnect(){super.disconnect();state.activeResize--}};
   window.MutationObserver=class extends Mutation{constructor(callback:MutationCallback){super(callback);state.activeMutation++}disconnect(){super.disconnect();state.activeMutation--}};
   const artifact={id:'viewport',kind:'request',render:mode,source:'',defaultVariant:'default',variants:{default:{html:'<div data-sk-artifact="viewport"><header style="height:44px">Header</header><section data-sk-viewport-bottom="57" style="overflow:auto"><p>Source frame</p></section></div>',css:''}},diagnostics:[],evidence:[],sources:{}};
   state.release=runtime.mountSkeleton(document.querySelector('#host'),artifact);
   window.ResizeObserver=Resize;window.MutationObserver=Mutation;
  },{url:`/@fs/${repo}/dist/runtime/index.js`,mode});
  const target=page.locator('#host [data-sk-viewport-bottom]');
  const check=async()=>{await expect.poll(async()=>target.evaluate(node=>{const box=node.getBoundingClientRect();return Math.abs(box.height-Math.max(0,innerHeight-box.top-57))})).toBeLessThan(1);};
  await check();const before=(await target.boundingBox())!;
  await page.locator('#before').evaluate(node=>(node as HTMLElement).style.height='160px');await expect.poll(async()=>Math.round((await target.boundingBox())!.height)).toBe(Math.round(before.height-40));
  await page.setViewportSize({width:390,height:844});await check();await expect(page.locator('#business')).toHaveCSS('height','123px');
  expect(await page.evaluate(()=>({resize:(window as any).activeResize,mutation:(window as any).activeMutation}))).toEqual({resize:1,mutation:1});
  await page.evaluate(()=>{(window as any).release();window.dispatchEvent(new Event('resize'))});await expect(target).toHaveCount(0);expect(await page.evaluate(()=>({resize:(window as any).activeResize,mutation:(window as any).activeMutation}))).toEqual({resize:0,mutation:0});
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});

test('declared pagination groups wrap by intrinsic control geometry instead of a fixed region height',async({page})=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'skelcast-pagination-wrap-'));
 try{
  await writeFile(path.join(root,'View.vue'),`<script setup>import{ElPagination}from'element-plus'</script><template><ElPagination background layout="total, sizes, prev, pager, next, jumper" :page-size="10" :current-page="1" style="flex-wrap:wrap;width:100%"/></template>`);
  const{artifact}=await compileTarget(root,{id:'pages',source:'View.vue'},{},{componentPresets:['element-plus']});const view=artifact.variants.default;
  for(const[width,height]of[[966,32],[126,149]]){
   await page.setContent(`<!doctype html><style>body{margin:0;font:14px/21px sans-serif}${view.css}</style><div style="width:${width}px">${view.html}</div>`);
   expect((await page.locator('.el-pagination').boundingBox())!.height).toBe(height);await expect(page.locator('.el-pagination__sizes')).toHaveCount(1);await expect(page.locator('.el-pagination__jump')).toHaveCount(1);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test('table selection and min-width columns retain their library widths when space grows or scrolls',async({page})=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'skelcast-column-width-'));
 try{
  await writeFile(path.join(root,'View.vue'),`<script setup>import{ElTable}from'element-plus';const columns=[{type:'selection',label:'Select'},{label:'Name',minWidth:130},{label:'Count',minWidth:90},{label:'Actions',width:180}]</script><template><ElTable :columns="columns"/></template>`);
  const view=(await compileTarget(root,{id:'column-width',source:'View.vue'},{},{componentPresets:['element-plus']})).artifact.variants.default;
  for(const[width,expected]of[[300,[48,130,90,180]],[748,[48,308,212,180]]]as const){
   await page.setContent(`<!doctype html><style>body{margin:0;font:14px/21px sans-serif}${view.css}</style><div style="width:${width}px">${view.html}</div>`);
   const sizes=await page.locator('th').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().width));
   for(let index=0;index<expected.length;index++)expect(Math.abs(sizes[index]-expected[index]),JSON.stringify({width,sizes,expected})).toBeLessThan(1);
   await expect(page.locator('th input[type="checkbox"]')).toHaveCount(1);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
