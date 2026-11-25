import { test, expect } from '@playwright/test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { compileTarget } from '../../src/compiler/index.js';

test('common library adapters keep inert controls visible while masking bounded data cells on mobile', async ({
  page,
}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-common-ui-'));
  try {
    const views = {
      'Element.vue': `<script setup>import {ElButton,ElInput,ElCalendar,ElTable,ElTableColumn}from'element-plus';throw new Error('never run')</script><template><ElButton @click="danger()">Search</ElButton><ElInput placeholder="Filter"/><ElCalendar/><ElTable><ElTableColumn label="Name" :width="180"/><ElTableColumn label="Count" :width="180"/><ElTableColumn label="Details" :width="180"/></ElTable></template>`,
      'AntVue.vue': `<script setup>import {Button,Input,Calendar,Table}from'ant-design-vue';const columns=[{title:'Name',width:180},{title:'Count',width:180},{title:'Details',width:180}]</script><template><Button>Search</Button><Input placeholder="Filter"/><Calendar/><Table :columns="columns"/></template>`,
      'Ant.tsx': `import{Button,Input,Calendar,Table}from'antd';export default()=> <><Button onClick={()=>danger()}>Search</Button><Input placeholder="Filter"/><Calendar/><Table columns={[{title:'Name',width:180},{title:'Count',width:180},{title:'Details',width:180}]}/></>`,
    };
    for (const [source, code] of Object.entries(views)) {
      await writeFile(path.join(root, source), code);
      const { artifact } = await compileTarget(
        root,
        { id: 'common', source, hints: { repeat: 3 } },
        {},
        { componentPresets: ['element-plus', 'ant-design-vue', 'antd'] },
      );
      expect(artifact.diagnostics.filter((d) => d.code === 'FALLBACK')).toHaveLength(0);
      const view = artifact.variants.default;
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await page.setContent(
          `<style>body{margin:0;padding:24px;font:14px/1.6 system-ui}${view.css}</style>${view.html}`,
        );
        await expect(page.locator('button')).toHaveText('Search');
        await expect(page.locator('button[data-sk-leaf]')).toHaveCount(0);
        await expect(page.locator('button [data-sk-leaf]')).toHaveCount(0);
        await expect(page.locator('button')).toHaveCSS('color', 'rgb(96, 98, 102)');
        await expect(page.locator('button')).toHaveCSS('animation-name', 'none');
        await expect(page.locator('input[placeholder="Filter"][data-sk-control]')).toHaveCount(1);
        await expect(page.locator('[data-sk-calendar-cell]')).toHaveCount(42);
        await expect(page.locator('[data-sk-calendar-cell][data-sk-leaf]')).toHaveCount(0);
        await expect(page.locator('[data-sk-data-table] th')).toHaveText(['Name', 'Count', 'Details']);
        await expect(page.locator('[data-sk-data-table] td [data-sk-leaf]')).toHaveCount(9);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        if (width < 600) {
          const scroll = page.locator('[data-sk-data-table]').locator('..');
          expect(await scroll.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
          expect(
            await scroll.evaluate((e) => {
              e.scrollLeft = 50;
              return e.scrollLeft;
            }),
          ).toBe(50);
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
