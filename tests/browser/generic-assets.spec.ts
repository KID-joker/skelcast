import { test, expect } from '@playwright/test';
import { mkdtemp, writeFile, symlink, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { build, preview } from 'vite';
import { syncProject, loadProject } from '../../dist/index.js';
import { skelcastPlugin } from '../../dist/vite.js';

test('production assets are shared and load from relative deployments in both initial HTML and lazy artifact CSS', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(),'skelcast-build-assets-'));
  let server: Awaited<ReturnType<typeof preview>> | undefined;
  try {
    await symlink(path.resolve('node_modules'),path.join(root,'node_modules'),'dir');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>';
    await writeFile(path.join(root,'background.svg'),svg);
    await writeFile(path.join(root,'style.css'),'.panel{width:80px;height:40px;background:url("./background.svg")}');
    await writeFile(path.join(root,'View.vue'),'<template><main class="panel">Data</main></template>');
    await writeFile(path.join(root,'index.html'),'<div id="app"></div><script type="module" src="/main.ts"></script>');
    await writeFile(path.join(root,'main.ts'),`import page from 'virtual:skelcast/page';import list from 'virtual:skelcast/assets.svg.icons.list';window.artifacts=[page,list];`);
    await writeFile(path.join(root,'skelcast.config.mjs'),`export default {targets:[{id:'page',kind:'page',route:'/',source:'View.vue',styles:['style.css']},{id:'assets.svg.icons.list',source:'View.vue',styles:['style.css']}]}`);
    await syncProject(await loadProject(root));
    await build({root,base:'./',configFile:false,plugins:[skelcastPlugin()],logLevel:'silent'});
    const files = await readdir(path.join(root,'dist/assets'));
    expect(files.filter(file=>file.endsWith('.svg'))).toHaveLength(1);
    const html = await readFile(path.join(root,'dist/index.html'),'utf8');
    expect(html).not.toContain('__SKELCAST_ASSET_');
    expect(html).not.toContain('data:image/svg+xml;base64');
    server = await preview({root,base:'./',configFile:false,logLevel:'silent',preview:{host:'127.0.0.1',port:0}});
    const address = server.httpServer.address() as {port:number};
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.waitForFunction(()=>!!(window as unknown as {artifacts?:unknown}).artifacts);
    const urls = await page.evaluate(()=>{
      const artifacts=(window as unknown as {artifacts:{variants:{default:{css:string}}}[]}).artifacts;
      return artifacts.map(a=>a.variants.default.css.match(/url\(["']?([^"')]+)/)![1]);
    });
    expect(new URL(urls[0],page.url()).href).toBe(new URL(urls[1],page.url()).href);
    const response=await page.request.get(new URL(urls[1],page.url()).href);
    expect(response.ok()).toBe(true);expect(await response.text()).toBe(svg);
  } finally { await server?.close();await rm(root,{recursive:true,force:true}); }
});

test('unknown text keeps a single line in an intrinsically sized flex child', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(),'skelcast-inline-'));
  try {
    await writeFile(path.join(root,'View.vue'),'<template><section style="display:flex;flex-direction:column;align-items:center;width:500px"><span style="font:17px/20px sans-serif">Result: {{ response }}</span></section></template>');
    const { compileTarget } = await import('../../dist/index.js');
    const { artifact } = await compileTarget(root,{id:'inline',source:'View.vue'});
    const view=artifact.variants.default;
    await page.setContent(`<style>${view.css}</style>${view.html}`);
    const geometry=await page.locator('[data-sk-artifact] section > span').evaluate(element=>({height:element.getBoundingClientRect().height,tops:[...element.children].map(child=>child.getBoundingClientRect().top)}));
    expect(geometry.height).toBeLessThanOrEqual(22);
    expect(Math.max(...geometry.tops)-Math.min(...geometry.tops)).toBeLessThan(5);
  } finally {await rm(root,{recursive:true,force:true})}
});
