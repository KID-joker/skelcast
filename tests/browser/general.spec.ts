import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'vite';
import { compileTarget } from '../../src/compiler/index.js';
import { projectFromConfig, syncProject } from '../../src/generator.js';
import { skelcastPlugin } from '../../dist/vite.js';

test('generic render wrappers preserve responsive 24-column spans, hidden columns and nested gutters', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-grid-'));
  try {
    await writeFile(path.join(root, 'Cell.ts'), `import {defineComponent,h}from'vue';import {ElCol}from'element-plus';export default defineComponent({props:{units:{type:Number,default:6}},render(){const n=this.units;return h(ElCol,{xs:n,sm:n,md:n,lg:n,xl:n,...this.$attrs},{default:()=>this.$slots.default()})}})`);
    await writeFile(path.join(root, 'View.vue'), `<script setup>import Cell from './Cell';import{ElRow,ElCol}from'element-plus'</script><template><ElRow :gutter="24" class="outer"><Cell v-for="n in 4" :xs="24" :sm="12" :md="8" :lg="6" class="cell"><div class="tile" style="height:80px">Data</div></Cell><ElCol :span="0" :md="{span:24}" class="conditional"><ElRow :gutter="8" class="inner"><ElCol :span="12"><div style="height:20px"/></ElCol><ElCol :span="12"><div style="height:20px"/></ElCol></ElRow></ElCol></ElRow><ElRow class="position"><ElCol class="pushcol" :span="6" :offset="3" :push="2"><div style="height:20px"/></ElCol><ElCol class="pullcol" :span="6" :pull="2"><div style="height:20px"/></ElCol></ElRow><ElRow class="variants"><Cell class="wide-cell" :xs="24" :lg="18"><div style="height:20px"/></Cell><Cell class="narrow-cell" :xs="24" :lg="6"><div style="height:20px"/></Cell></ElRow></template>`);
    const { artifact } = await compileTarget(root, { id: 'grid', source: 'View.vue' }, {}, { componentPresets: ['element-plus'] });
    expect(artifact.diagnostics).toEqual([]);
    const view = artifact.variants.default;
    for (const [width, span] of [[390,24],[800,12],[1100,8],[1440,6]] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(`<style>body{margin:0;padding:24px}${view.css}</style>${view.html}`);
      const row = await page.locator('.outer').boundingBox();
      const cells = await page.locator('.cell').evaluateAll(elements => elements.map(el => {const b=el.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width};}));
      expect(cells).toHaveLength(4);
      for (const cell of cells) expect(cell.width).toBeCloseTo(row!.width * span / 24, 1);
      expect(new Set(cells.map(cell=>cell.y)).size).toBe(Math.ceil(4 / (24 / span)));
      await expect(page.locator('.cell').first()).toHaveCSS('padding-left','12px');
      await expect(page.locator('.inner > div').first()).toHaveCSS('padding-left','4px');
      if(width<992)await expect(page.locator('.conditional')).toBeHidden();else await expect(page.locator('.conditional')).toBeVisible();
      const variants = (await page.locator('.variants').boundingBox())!;
      const wide = (await page.locator('.wide-cell').boundingBox())!;
      const narrow = (await page.locator('.narrow-cell').boundingBox())!;
      expect(wide.width).toBeCloseTo(variants.width * (width >= 1200 ? 18 : width >= 768 ? 6 : 24) / 24, 1);
      expect(narrow.width).toBeCloseTo(variants.width * (width >= 768 ? 6 : 24) / 24, 1);
      const position = (await page.locator('.position').boundingBox())!;
      const push = (await page.locator('.pushcol').boundingBox())!;
      const pull = (await page.locator('.pullcol').boundingBox())!;
      expect(push.x).toBeCloseTo(position.x + position.width * 5 / 24, 1);
      expect(pull.x).toBeCloseTo(position.x + position.width * 7 / 24, 1);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('state reads never reload the app or publish lock bookkeeping, including custom output directories', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-watch-'));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(root, 'View.tsx'), `export default()=> <article>Data</article>`);
    await writeFile(path.join(root, 'index.html'), `<!doctype html><div id="app">Existing application</div><script type="module" src="/main.js"></script>`);
    await writeFile(path.join(root, 'main.js'), `window.documentIdentity=crypto.randomUUID();`);
    const config = { outDir: 'generated/artifacts', targets: [{id:'panel',source:'View.tsx',kind:'request' as const}] };
    await writeFile(path.join(root, 'skelcast.config.mjs'), `export default ${JSON.stringify(config)}`);
    await syncProject(await projectFromConfig(root, config));
    server = await createServer({root,configFile:false,logLevel:'silent',plugins:[skelcastPlugin()],server:{host:'127.0.0.1',port:0,watch:{ignored:['**/user-output/**']}}});
    await server.listen();
    const ignored=server.config.server.watch?.ignored;
    expect(ignored).toContain('**/user-output/**');
    const address=server.httpServer!.address() as {port:number};
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.waitForFunction(()=>!!(window as unknown as {documentIdentity:string}).documentIdentity);
    const identity=await page.evaluate(()=>(window as unknown as {documentIdentity:string}).documentIdentity);
    const updates: unknown[]=[];
    const send=server.ws.send.bind(server.ws);
    server.ws.send=((...args: Parameters<typeof send>)=>{updates.push(args[0]);return Reflect.apply(send,server!.ws,args);}) as typeof server.ws.send;
    for(let i=0;i<8;i++)expect((await page.request.get(`http://127.0.0.1:${address.port}/__skelcast/state`)).ok()).toBe(true);
    // Observe longer than the plugin's 100ms notification debounce and fs batching.
    await page.waitForTimeout(750);
    expect(await page.evaluate(()=>(window as unknown as {documentIdentity:string}).documentIdentity)).toBe(identity);
    expect(updates.filter(value=>JSON.stringify(value).includes('owner.json')||JSON.stringify(value).includes('skelcast:update'))).toEqual([]);
    await mkdir(path.join(root,'generated/artifacts/.skelcast-stage-fixture'),{recursive:true});
    await writeFile(path.join(root,'generated/artifacts/.skelcast-stage-fixture/next.json'),'{}');
    await page.waitForTimeout(250);
    expect(updates).toEqual([]);
    await writeFile(path.join(root,'View.tsx'),`export default()=> <article>Updated data</article>`);
    await expect.poll(()=>updates.some(value=>JSON.stringify(value).includes('skelcast:update'))).toBe(true);
  } finally { await server?.close();await rm(root,{recursive:true,force:true}); }
});
