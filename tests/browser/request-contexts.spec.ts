import {test,expect} from '@playwright/test';
import {mkdtemp,mkdir,symlink,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer,build} from 'vite';
import {initProject,syncProject,loadProject,auditProject} from '../../dist/index.js';

test('reusable request instances retain caller layout through ready, empty and error states and context-aware audits',async({page},testInfo)=>{
 const repo=process.cwd(),root=await mkdtemp(path.join(os.tmpdir(),'skelcast-context-browser-'));let server:Awaited<ReturnType<typeof createServer>>|undefined;
 try{
  await mkdir(path.join(root,'node_modules'));for(const name of ['vue','vite','@vitejs'])await symlink(path.join(repo,'node_modules',name),path.join(root,'node_modules',name),'dir');await symlink(repo,path.join(root,'node_modules/skelcast'),'dir');
  await writeFile(path.join(root,'package.json'),JSON.stringify({type:'module',dependencies:{vue:'*',vite:'*',skelcast:'*'}}));
  await writeFile(path.join(root,'vite.config.mjs'),`import vue from'@vitejs/plugin-vue';export default{plugins:[vue()],server:{fs:{allow:${JSON.stringify([repo,root])}}}}`);
  await writeFile(path.join(root,'index.html'),'<div id="app"></div><script type="module" src="/main.js"></script>');
  await writeFile(path.join(root,'main.js'),`import{createApp}from'vue';import App from'./App.vue';createApp(App).mount('#app')`);
  await writeFile(path.join(root,'Rows.vue'),`<script setup>import{LoadingBoundary}from'skelcast/vue';import frame from'virtual:skelcast/rows.svg.icons';const props=defineProps({rows:Array,state:String})</script><template><LoadingBoundary :artifact="frame" :pending="false" :variant="props.state"><section><p v-if="props.state==='error'" style="height:48px;margin:0">Unable to load</p><p v-else-if="props.state==='empty'" style="height:32px;margin:0">No items</p><div v-else><p v-for="row in props.rows" style="height:40px;margin:0">{{row}}</p><slot/></div></section></LoadingBoundary></template>`);
  await writeFile(path.join(root,'App.vue'),`<script setup>import{ref}from'vue';import Rows from'./Rows.vue';const state=ref('ready')</script><template><main style="width:500px;font:14px Arial"><button @click="state='ready'">Ready</button><button @click="state='empty'">Empty</button><button @click="state='error'">Error</button><Rows :rows="['A','B']" :state="state"><p style="height:24px;margin:0">Extra</p></Rows><Rows :rows="['C']" :state="state"/></main></template>`);
  await writeFile(path.join(root,'skelcast.config.mjs'),`export default ${JSON.stringify({targets:[{id:'rows.svg.icons',source:'Rows.vue',region:'frame',kind:'request',defaultVariant:'ready',variants:Object.fromEntries(['ready','empty','error'].map(state=>[state,{bindings:{'Rows.vue::props.state':state}}]))}]})}`);
  await initProject(root);await syncProject(await loadProject(root));await build({root,logLevel:'silent'});
  server=await createServer({root,logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();const address=server.httpServer!.address() as {port:number};const url=`http://127.0.0.1:${address.port}`;
  await page.goto(url);await expect(page.locator('[data-sk-boundary="rows.svg.icons"]')).toHaveCount(2);
  const states=[];
  for(const state of ['ready','empty','error']){
   await page.getByRole('button',{name:state[0].toUpperCase()+state.slice(1),exact:true}).click();
   const reports=await page.evaluate(async moduleURL=>{const{auditBoundaryLayout}=await import(/* @vite-ignore */moduleURL);const result=[];for(const root of document.querySelectorAll('[data-sk-boundary="rows.svg.icons"]'))result.push(await auditBoundaryLayout(root));return result},`/@fs${path.join(repo,'dist/browser.js')}`);
   states.push({state,reports});
   expect(reports.every(report=>!report.needsReview),JSON.stringify(reports)).toBe(true);
   expect(reports[0].variant).not.toBe(reports[1].variant);
   expect(reports[0].content.box.height).toBe(state==='ready'?104:state==='empty'?32:48);
   expect(reports[1].content.box.height).toBe(state==='ready'?40:state==='empty'?32:48);
  }
  await writeFile(testInfo.outputPath('request-states.json'),JSON.stringify(states,null,2));
  const report=await auditProject({url,id:'rows.svg.icons',outDir:testInfo.outputPath('context-audit'),viewports:[{width:900,height:700}]});
  expect(report.cases).toHaveLength(6);
  const byInstance=[0,1].map(instance=>new Set(report.cases.filter(c=>c.instance===instance).map(c=>c.variant.split('-').slice(0,-1).join('-'))));
  expect(byInstance[0].size).toBe(1);expect(byInstance[1].size).toBe(1);expect([...byInstance[0]][0]).not.toBe([...byInstance[1]][0]);
 }finally{await server?.close();await rm(root,{recursive:true,force:true})}
});
