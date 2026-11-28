import { test, expect } from '@playwright/test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { compileTarget } from '../../src/compiler/index.js';

test('simplified charts and table cells keep responsive footprints and following content positions', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-large-geometry-'));
  const markup = '<main><svg class="chart" viewBox="0 0 640 320"><path d="M0 200L300 40L640 100"/><text>Revenue</text></svg><canvas class="canvas" width="640" height="320">Chart details</canvas><table><colgroup><col style="width:35%"/><col style="width:65%"/></colgroup><thead><tr><th>Name</th><th>Actions</th></tr></thead><tbody><tr><td>Long value that wraps over multiple lines in a narrow table</td><td><button>Delete selected records</button></td></tr></tbody></table><footer>Following content</footer></main>';
  const css = 'main{width:100%;font:14px/23px Arial}.chart,.canvas{display:block;width:100%;height:auto}table{width:100%;table-layout:fixed;border-collapse:collapse}th,td{padding:12px;border:1px solid #ddd;text-align:left}button{font:inherit;padding:6px 12px}footer{margin-top:16px}';
  try {
    await writeFile(path.join(root, 'layout.css'), css);
    await writeFile(path.join(root, 'View.tsx'), `import './layout.css';export default()=>${markup.replaceAll('class=', 'className=').replace('style="width:35%"', 'style={{width:"35%"}}').replace('style="width:65%"', 'style={{width:"65%"}}')}`);
    await writeFile(path.join(root, 'View.vue'), `<template>${markup}</template><style src="./layout.css"></style>`);
    for (const source of ['View.tsx', 'View.vue']) {
      const { artifact } = await compileTarget(root, { id: 'large-geometry', source });
      expect(artifact.diagnostics).toEqual([]);
      for (const width of [320, 768, 1280]) for (const shadow of [false, true]) {
        await page.setViewportSize({ width, height: 1600 });
        await page.setContent(`<style>body{margin:0}${css}</style><div id="real">${markup}</div><div id="skeleton"></div>`);
        await page.evaluate(({ view, shadow }) => {
          const host = document.querySelector('#skeleton')!;
          const root = shadow ? host.attachShadow({ mode: 'open' }) : host;
          root.innerHTML = `<style>${view.css}</style>${view.html}`;
        }, { view: artifact.variants.default, shadow });
        const realRoot = (await page.locator('#real main').boundingBox())!;
        const skeletonRoot = (await page.locator('#skeleton main').boundingBox())!;
        for (const selector of ['main', '.chart', '.canvas', 'table', 'th', 'td', 'button', 'footer']) {
          const real = (await page.locator(`#real ${selector}`).first().boundingBox())!;
          const skeleton = (await page.locator(`#skeleton ${selector}`).first().boundingBox())!;
          expect(skeleton.width, `${source} ${width} ${selector} width`).toBeCloseTo(real.width, 1);
          expect(skeleton.height, `${source} ${width} ${selector} height`).toBeCloseTo(real.height, 1);
          expect(skeleton.y - skeletonRoot.y, `${source} ${width} ${selector} top`).toBeCloseTo(real.y - realRoot.y, 1);
        }
        await expect(page.locator('#skeleton .chart > *, #skeleton .canvas > *')).toHaveCount(0);
        await expect(page.locator('#skeleton .chart')).toHaveCSS('background-color', 'rgb(229, 233, 239)');
        await expect(page.locator('#skeleton button')).toHaveCSS('color', 'rgba(0, 0, 0, 0)');
        await expect(page.locator('#skeleton th').first()).toHaveText('Name');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('simplified library cell controls retain table row heights and column proportions', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-library-geometry-'));
  try {
    for (const preserve of [false, true]) {
      await writeFile(path.join(root, `${preserve ? 'Preserved' : 'Simplified'}.vue`), `<script setup>import {ElTable,ElTableColumn,ElButton} from 'element-plus';const rows=[{name:'Long name that wraps at narrow widths'},{name:'Short name'}]</script><template><section ${preserve ? 'data-sk-preserve' : ''}><ElTable :data="rows" :columns="[{type:'selection'},{type:'expand'},{label:'Name',prop:'name',minWidth:120}]"/><ElTable :data="rows"><ElTableColumn label="Name" prop="name" :width="120"/><ElTableColumn label="Actions" :width="180"><ElButton>Delete records</ElButton></ElTableColumn></ElTable></section></template>`);
    }
    const views = await Promise.all(['Preserved.vue', 'Simplified.vue'].map(async source =>
      (await compileTarget(root, { id: source.slice(0, -4), source }, {}, { componentPresets: ['element-plus'] })).artifact.variants.default));
    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.setContent(`<style>body{margin:0;font:14px/23px Arial}${views.map(view => view.css).join('\n')}</style>${views.map((view, index) => `<div id="view${index}">${view.html}</div>`).join('')}`);
      for (const selector of ['.el-table', 'table', 'tr', 'th', 'td', 'button']) {
        const measure = (nodes: Element[]) => nodes.map(node => {
          const rect = node.getBoundingClientRect(); return { width: rect.width, height: rect.height };
        });
        const real = await page.locator(`#view0 ${selector}`).evaluateAll(measure);
        const simplified = await page.locator(`#view1 ${selector}`).evaluateAll(measure);
        expect(simplified.length).toBe(real.length);
        for (let i = 0; i < real.length; i++) {
          expect(simplified[i].width, `${width} ${selector} ${i} width`).toBeCloseTo(real[i].width, 1);
          expect(simplified[i].height, `${width} ${selector} ${i} height`).toBeCloseTo(real[i].height, 1);
        }
      }
      await expect(page.locator('#view1 tbody input')).toHaveCount(0);
      await expect(page.locator('#view1 thead input')).toHaveCount(1);
      await expect(page.locator('#view1 tbody button[data-sk-leaf]')).toHaveCount(2);
      await expect(page.locator('#view0 tbody button[data-sk-leaf]')).toHaveCount(0);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
