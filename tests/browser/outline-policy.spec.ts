import {test,expect} from '@playwright/test';
import {mkdtemp,mkdir,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'vite';
import {initProject} from '../../dist/index.js';

for(const framework of ['react','vue'] as const)test(`${framework} live editor stays visible and retains its node, draft and selection during loading and comparison`,async({page},testInfo)=>{
  const repo=process.cwd(),root=await mkdtemp(path.join(os.tmpdir(),'skelcast-live-editor-'));
  let server:Awaited<ReturnType<typeof createServer>>|undefined;
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await mkdir(path.join(root,'node_modules'));
    for(const name of ['react','react-dom','vue','vite','@vitejs'])await symlink(path.join(repo,'node_modules',name),path.join(root,'node_modules',name),'dir');
    await symlink(repo,path.join(root,'node_modules/skelcast'),'dir');
    await mkdir(path.join(root,'src'));
    await writeFile(path.join(root,'package.json'),JSON.stringify({type:'module',dependencies:{[framework]:'*',vite:'*',skelcast:'*'}}));
    await writeFile(path.join(root,'vite.config.mjs'),`import framework from '@vitejs/plugin-${framework}';export default {plugins:[framework()],server:{fs:{allow:${JSON.stringify([repo,root])}}}}`);
    await writeFile(path.join(root,'index.html'),`<html><body><div id="root"></div><script type="module" src="/src/main.${framework==='react'?'jsx':'js'}"></script></body></html>`);
    if(framework==='react'){
      await writeFile(path.join(root,'src/Editor.jsx'),`import React,{useState}from'react';let instances=0;export default function Editor(){const[id]=useState(()=>++instances);return <div role="textbox" aria-label="Editor" contentEditable suppressContentEditableWarning data-editor data-instance={id}>Draft</div>}`);
      await writeFile(path.join(root,'src/App.jsx'),`import React,{useState}from'react';import Editor from './Editor';export default function App(){const[pending,setPending]=useState(false);const result='Loaded data';return <main loading={pending}><h1>Orders</h1><p>Fixed instructions</p><section data-sk-live><Editor/></section><button onClick={()=>{setPending(true);setTimeout(()=>setPending(false),500)}}>Reload</button><section className="results"><p>{result}</p></section></main>}`);
      await writeFile(path.join(root,'src/main.jsx'),`import React from 'react';import{createRoot}from'react-dom/client';import App from './App';createRoot(document.getElementById('root')).render(<App/>);`);
    }else{
      await writeFile(path.join(root,'src/Editor.vue'),`<script setup>const instance=window.editorInstances=(window.editorInstances||0)+1</script><template><div role="textbox" aria-label="Editor" contenteditable data-editor :data-instance="instance">Draft</div></template>`);
      await writeFile(path.join(root,'src/App.vue'),`<script setup>import{ref}from'vue';import Editor from './Editor.vue';const pending=ref(false),result='Loaded data';function reload(){pending.value=true;setTimeout(()=>pending.value=false,500)}</script><template><main v-loading="pending"><h1>Orders</h1><p>Fixed instructions</p><section data-sk-live><Editor/></section><button @click="reload">Reload</button><section class="results"><p>{{result}}</p></section></main></template>`);
      await writeFile(path.join(root,'src/main.js'),`import{createApp}from'vue';import App from './App.vue';createApp(App).mount('#root');`);
    }
    const report=await initProject(root);
    expect(report.targets).toHaveLength(1);expect(report.targets[0].kind).toBe('request');
    const entry=path.join(repo,'dist/runtime/index.js');
    const core=(await readFile(entry,'utf8')).match(/from "([^"]+)"/)![1];
    const coreURL=`/@fs${path.resolve(path.dirname(entry),core)}`;
    server=await createServer({root,logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
    const address=server.httpServer!.address() as {port:number};
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const editor=page.getByRole('textbox',{name:'Editor'}),boundary=page.locator(`[data-sk-boundary="${report.targets[0].id}"]`);
    await expect(editor).toBeVisible();await expect(boundary).toHaveAttribute('aria-busy','false');
    await expect(page.locator('#skelcast-devtools').getByRole('status',{name:'Skeleton status'})).toHaveText('Up to date');
    await editor.fill('Keep this draft');
    await page.evaluate(()=>{
      const editor=document.querySelector('[data-editor]')!;
      (window as any).originalEditor=editor;
      const range=document.createRange();range.setStart(editor.firstChild!,4);range.collapse(true);
      const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
    });
    for(const width of [390,1200]){
      await page.setViewportSize({width,height:900});
      for(const comparison of ['off','overlay','side-by-side','switch']){
        await page.evaluate(async({url,id,comparison})=>{const{setPreview}=await import(url);setPreview({target:id,comparison,comparisonView:'skeleton'});},{url:coreURL,id:report.targets[0].id,comparison});
        await expect(boundary).toHaveAttribute('data-sk-visible','true');
        await expect(editor).toBeVisible();await expect(editor).toHaveText('Keep this draft');
        await expect(editor).toHaveAttribute('data-instance','1');
        expect(await page.evaluate(()=>({same:(window as any).originalEditor===document.querySelector('[data-editor]'),offset:window.getSelection()?.anchorOffset}))).toEqual({same:true,offset:4});
        await expect(page.getByRole('heading',{name:'Orders'})).toBeVisible();
        await expect(boundary.locator('[data-sk-skeleton] [data-editor]')).toHaveCount(0);
      }
      await page.screenshot({path:testInfo.outputPath(`editor-${width}.png`),fullPage:true});
    }
    await page.evaluate(async url=>{const{setPreview}=await import(url);setPreview({target:null,comparison:'off'});},coreURL);
    await page.getByRole('button',{name:'Reload',exact:true}).click();
    await expect(boundary).toHaveAttribute('aria-busy','true');await expect(editor).toBeVisible();
    await expect(boundary).toHaveAttribute('aria-busy','false');await expect(editor).toHaveText('Keep this draft');
    expect(errors).toEqual([]);
  }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});
