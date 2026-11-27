import {test,expect} from '@playwright/test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {compileTarget} from '../../src/compiler/index.js';

async function fixture(files:Record<string,string>,run:(root:string)=>Promise<void>){
  const root=await mkdtemp(path.join(os.tmpdir(),'skelcast-fidelity-'));
  try{for(const [name,source]of Object.entries(files)){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),source);}await run(root);}finally{await rm(root,{recursive:true,force:true});}
}

test('opaque source geometry beats fallback defaults in light and shadow roots across breakpoints',async({page})=>{
  await fixture({
    'Opaque.ts':'export default makeBusinessWidget();',
    'View.vue':`<script setup>import Opaque from './Opaque'</script><template><main><Opaque class="icon" width="18" height="18"/><Opaque class="responsive"/><Opaque class="minimum"/><Opaque class="ratio"/><Opaque class="unknown"/><div style="display:inline-flex;font-size:18px"><Opaque class="inline-style"/></div><div class="inline-context"><Opaque class="inline-class"/></div><span style="font-size:16px"><Opaque class="inline-tag"/></span></main></template><style scoped>.responsive{width:30px;height:15px}.minimum{min-height:24px}.ratio{width:80px;aspect-ratio:2}.inline-context{display:inline-flex;font-size:20px}@media(min-width:700px){.responsive{width:100px;height:50px}}</style>`,
  },async root=>{
    const {artifact}=await compileTarget(root,{id:'geometry',source:'View.vue'});
    const v=artifact.variants.default;
    for(const shadow of [false,true])for(const width of [390,1200]){
      await page.setViewportSize({width,height:900});
      await page.setContent('<!doctype html><div id="mount"></div>');
      await page.evaluate(({v,shadow})=>{const host=document.querySelector('#mount')!;(shadow?host.attachShadow({mode:'open'}):host).innerHTML=`<style>${v.css}</style>${v.html}`;},{v,shadow});
      for(const [selector,w,h]of [['.icon',18,18],['.responsive',width<700?30:100,width<700?15:50],['.minimum',undefined,24],['.ratio',80,40],['.unknown',undefined,96],['.inline-style',18,18],['.inline-class',20,20],['.inline-tag',16,16]] as const){
        const box=(await page.locator(selector).boundingBox())!;
        if(w)expect(box.width).toBeCloseTo(w,1);
        expect(box.height).toBeCloseTo(h,1);
      }
    }
  });
});

test('fallback inline important dimensions retain CSS priority across all source frontends', async ({ page }) => {
  await fixture({
    'Opaque.ts': 'export default makeBusinessWidget();',
    'layout.css': '.opaque{height:160px!important}',
    'View.tsx': `import './layout.css';import Opaque from './Opaque';export default()=> <Opaque className="opaque" width={18} style="height:100px!important;height:20px"/>;`,
    'View.vue': `<script setup>import './layout.css';import Opaque from './Opaque'</script><template><Opaque class="opaque" width="18" style="height:100px!important;height:20px"/></template>`,
    'View.ts': `import './layout.css';import {h} from 'vue';import Opaque from './Opaque';export default()=>h(Opaque,{class:'opaque',width:18,style:'height:100px!important;height:20px'});`,
  }, async root => {
    for (const source of ['View.tsx', 'View.vue', 'View.ts']) {
      const { artifact } = await compileTarget(root, { id: 'priority', source });
      const view = artifact.variants.default;
      for (const shadow of [false, true]) {
        await page.setContent('<!doctype html><div id="mount"></div>');
        await page.evaluate(({ view, shadow }) => {
          const host = document.querySelector('#mount')!;
          const root = shadow ? host.attachShadow({ mode: 'open' }) : host;
          root.innerHTML = `<style>${view.css}</style>${view.html}`;
        }, { view, shadow });
        await expect(page.locator('.opaque')).toHaveCSS('height', '100px');
        await expect(page.locator('.opaque')).toHaveCSS('width', '18px');
      }
    }
  });
});

test('React satisfies wrappers preserve native layout in generated skeletons', async ({ page }) => {
  await fixture({
    'View.tsx': `export default()=> (<section style={{width:168,height:44}}><p>Value</p></section>) satisfies JSX.Element;`,
  }, async root => {
    const { artifact } = await compileTarget(root, { id: 'satisfies', source: 'View.tsx' });
    expect(artifact.diagnostics).toEqual([]);
    const view = artifact.variants.default;
    await page.setContent(`<!doctype html><style>${view.css}</style>${view.html}`);
    await expect(page.locator('section')).toHaveCSS('width', '168px');
    await expect(page.locator('section')).toHaveCSS('height', '44px');
    await expect(page.locator('section > p [data-sk-measured]')).toHaveAttribute('data-sk-text-content', 'Value');
  });
});

test('entry SCSS and Tailwind utilities determine standalone geometry without the application stylesheet',async({page})=>{
  await fixture({
    'index.html':'<script type="module" src="/src/main.ts"></script>',
    'src/main.ts':`import '/src/reset.scss';import './theme.css';throw Error('do not execute');`,
    'src/_tokens.scss':'$pad:18px;',
    'src/reset.scss':`@use './tokens' as *;:root{font-size:16px}.frame{font:14px/1.5 sans-serif;padding:$pad;}`,
    'src/theme.css':`@import 'tailwindcss/theme.css' layer(theme);@import 'tailwindcss/utilities.css' layer(utilities);@utility panel{@apply flex items-center;gap:12px;}`,
    'View.vue':`<template><main class="frame"><div class="panel w-full md:w-1/2 h-20"><div class="w-6 h-6">A</div><div class="w-10 h-7">B</div></div></main></template>`,
  },async root=>{
    const {artifact}=await compileTarget(root,{id:'styles',source:'View.vue'});
    expect(artifact.diagnostics).toEqual([]);
    const v=artifact.variants.default;
    for(const width of [390,1200]){
      await page.setViewportSize({width,height:900});
      await page.setContent('<!doctype html><style>body{margin:0}</style><div id="mount"></div>');
      await page.evaluate(v=>{document.querySelector('#mount')!.attachShadow({mode:'open'}).innerHTML=`<style>${v.css}</style>${v.html}`;},v);
      const panel=page.locator('.panel'),box=(await panel.boundingBox())!;
      expect(box.width).toBeCloseTo((width-36)*(width>=768?0.5:1),1);
      expect(box.height).toBeCloseTo(80,1);
      await expect(panel).toHaveCSS('display','flex');
      const cells=await panel.locator(':scope > div').all();
      expect((await cells[0].boundingBox())!.width).toBeCloseTo(24,1);
      expect((await cells[1].boundingBox())!.x-(await cells[0].boundingBox())!.x).toBeCloseTo(36,1);
    }
  });
});

test('Element Plus card slots, body overrides, statistics and scrollbar keep their separate geometric contracts',async({page})=>{
  await fixture({'View.vue':`<script setup>import{ElCard,ElStatistic,ElCountdown,ElProgress,ElScrollbar,ElLink}from'element-plus'</script><template><ElCard class="card" :body-style="{padding:'12px'}"><template #header><div style="height:22px">Heading</div></template><div style="height:50px">Body</div><template #footer><div style="height:18px">Footer</div></template></ElCard><ElStatistic class="stat" :value="36000"><template #title>Revenue</template><template #suffix>%</template></ElStatistic><ElCountdown class="timer" title="Remaining" :value="Date.now() + 5000"/><ElProgress :stroke-width="21"/><ElProgress type="circle" :width="80"/><ElScrollbar :height="100" :max-height="80"><div style="height:200px"/></ElScrollbar><ElLink>Details</ElLink></template><style scoped>.card{width:300px}:deep(.el-card__header){padding:10px}.stat{font:14px/1.5 sans-serif}</style>`},async root=>{
    const {artifact}=await compileTarget(root,{id:'preset',source:'View.vue'},{},{componentPresets:['element-plus']});
    expect(artifact.diagnostics).toEqual([]);
    const v=artifact.variants.default;
    await page.setContent(`<!doctype html><style>body{margin:0;font:14px/1.5 sans-serif}${v.css}</style>${v.html}`);
    await expect(page.locator('.el-card__header > div')).toHaveCount(1);
    await expect(page.locator('.el-card__body > div')).toHaveCount(1);
    await expect(page.locator('.el-card__footer > div')).toHaveCount(1);
    expect((await page.locator('.card').boundingBox())!.height).toBeCloseTo(174,1);
    expect((await page.locator('.stat').boundingBox())!.height).toBeCloseTo(54,1);
    expect((await page.locator('.timer').boundingBox())!.height).toBeCloseTo(54,1);
    await expect(page.locator('.el-progress--line')).toHaveCSS('height','21px');
    await expect(page.locator('.el-progress--circle')).toHaveCSS('width','80px');
    await expect(page.locator('.el-statistic__suffix [data-sk-measured]')).toHaveAttribute('data-sk-text-content','%');
    await expect(page.locator('.el-scrollbar')).toHaveCSS('height','100px');
    await expect(page.locator('.el-scrollbar__wrap')).toHaveCSS('max-height','80px');
    await expect(page.locator('a.el-link')).toHaveText('Details');
    await expect(page.locator('a.el-link')).not.toHaveAttribute('href');
    await expect(page.locator('a.el-link')).toHaveCSS('padding-top','0px');
  });
});
