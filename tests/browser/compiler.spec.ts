import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { compileTarget } from '../../src/compiler/index.js';

const naiveDeclarations = `declare module 'vue' {interface GlobalComponents {${['NIcon','NInput','NScrollbar','NGrid','NGi','NCode'].map(name=>name+":typeof import('naive-ui')['"+name+"']").join(';')}}}`;

test('mapped ID and data selectors preserve layout and specificity across repeated light and shadow instances', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-attribute-layout-'));
  try {
    await writeFile(path.join(root, 'View.tsx'), `import './layout.css';export default function View(){return <section id="catalog:main" className="panel" data-layout="grid"><span>Title</span><span>Body</span></section>}`);
    await writeFile(path.join(root, 'View.vue'), `<template><section id="catalog:main" class="panel" data-layout="grid"><span>Title</span><span>Body</span></section></template><style src="./layout.css"></style>`);
    await writeFile(path.join(root, 'layout.css'), `#catalog\\:main { width:600px } .panel { width:140px } [id^="catalog"] { min-height:72px } [data-layout="grid"] { display:grid; grid-template-columns:repeat(3, 1fr); gap:12px } :is(#other, #catalog\\:main) > span { margin-top:7px }`);
    for (const source of ['View.tsx', 'View.vue']) {
      const { artifact } = await compileTarget(root, { id: 'attribute-layout', source });
      expect(artifact.diagnostics).toHaveLength(0);
      for (const shadow of [false, true]) {
        await page.setContent('<section id="catalog:main" class="panel" data-layout="grid" style="width:137px">Live content</section>');
        await page.evaluate(({ view, shadow }) => {
          for (let i = 0; i < 2; i++) {
            const host = document.createElement('div');
            document.body.append(host);
            const root = shadow ? host.attachShadow({ mode: 'open' }) : host;
            root.innerHTML = `<style>${view.css}</style>${view.html}`;
          }
        }, { view: artifact.variants.default, shadow });
        const sections = page.locator('[data-sk-source-id="catalog:main"]');
        await expect(sections).toHaveCount(2);
        for (const section of await sections.all()) {
          await expect(section).toHaveCSS('width', '600px');
          await expect(section).toHaveCSS('min-height', '72px');
          await expect(section).toHaveCSS('display', 'grid');
          await expect(section).toHaveCSS('gap', '12px');
          await expect(section.locator(':scope > span').first()).toHaveCSS('margin-top', '7px');
          expect(await section.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(3);
        }
        await expect(page.locator('section[id]')).toHaveCount(1);
        await expect(page.locator('section[id]')).toHaveCSS('width', '137px');
        await expect(page.locator('section[id]')).toHaveCSS('display', 'block');
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source-generated Vue cards keep responsive grid, Less padding and attributify flex layout', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-layout-'));
  try {
    const files = {
      'View.vue': `<script setup>throw new Error('business must never run')</script><template><main class="grid grid-cols-1 gap-12px md:grid-cols-4"><auto-card v-for="item in data.items" class="h-full"><div flex items-center gap-8px><n-icon :size="40"/><span>{{item.title}}</span><span class="scale-0">Hidden overlay</span></div><n-input/></auto-card></main></template>`,
      'components.d.ts': `declare module 'vue' { interface GlobalComponents { AutoCard: typeof import('./Card.vue')['default'] } }` + naiveDeclarations,
      'Card.vue': `<script setup></script><template><article class="card"><slot/></article></template><style lang="less" scoped>@import './tokens.less'; .card{padding:@padding; & > div{margin-bottom:12px}}</style>`,
      'tokens.less': '@padding:24px;',
    };
    for (const [file, code] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), code);
    }
    const { artifact } = await compileTarget(root, { id: 'layout', source: 'View.vue', hints: { repeat: 4 } }, {}, {
      componentPresets: ['naive-ui'], styles: { less: true, unocss: true },
    });
    expect(artifact.diagnostics).toHaveLength(0);
    const view = artifact.variants.default;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.setContent(`<style>body{margin:0}${view.css}</style>${view.html}`);
    await expect(page.locator('article')).toHaveCount(4);
    await expect(page.locator('article').first()).toHaveCSS('padding', '24px');
    await expect(page.locator('article > div').first()).toHaveCSS('display', 'flex');
    await expect(page.locator('article > div').first()).toHaveCSS('align-items', 'center');
    expect(await page.locator('.scale-0').first().evaluate(element => element.getBoundingClientRect().width)).toBe(0);
    const columns = () => page.locator('main').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length);
    expect(await columns()).toBe(4);
    await page.setViewportSize({ width: 390, height: 800 });
    expect(await columns()).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await expect(page.locator('[data-sk-control][style*="height:34px"]').first()).toHaveCSS('height', '34px');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dynamic CSS instances and horizontal scroll regions stay bounded on mobile in both themes', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-dynamic-layout-'));
  try {
    await writeFile(path.join(root, 'components.d.ts'), naiveDeclarations);
    await writeFile(path.join(root, 'View.vue'), `<script setup>import Card from './Card.vue';const width=ref(600);const height=ref(350);throw new Error('never run')</script><template><div class="surface bg-white dark:bg-black"/><Card :spacing="12"/><Card :spacing="28"/><n-scrollbar x-scrollable><div flex flex-nowrap justify-center><article v-for="index in 3" style="width:294px;flex-shrink:0">Suite</article></div></n-scrollbar><img class="max-w-full h-auto" :style="{aspectRatio:width/height}"></template>`);
    await writeFile(path.join(root, 'Card.vue'), `<script setup>const props=defineProps<{spacing:number}>();const {spacing}=toRefs(props);const theme=privateTheme();const padding=computed(()=>spacing.value+'px')</script><template><section class="card">Card</section></template><style scoped>.card{padding:v-bind(padding);background:v-bind('theme.bg')}</style>`);
    const { artifact } = await compileTarget(root, { id: 'dynamic-layout', source: 'View.vue', variants: { light: {}, dark: { bindings: { 'Card.vue::theme': { bg: '#222222' } } } } }, {}, {
      componentPresets: ['naive-ui'], styles: { unocss: true }, componentBindings: { 'Card.vue': { theme: { bg: '#ffffff' } } },
    });
    expect(artifact.diagnostics).toHaveLength(0);
    for (const [variant, view] of Object.entries(artifact.variants)) {
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await page.setContent(`<style>body{margin:0;padding:24px}${view.css}</style>${view.html}`);
        await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), variant === 'dark');
        await expect(page.locator('.surface')).toHaveCSS('background-color', variant === 'light' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)');
        await expect(page.locator('.card').nth(0)).toHaveCSS('padding', '12px');
        await expect(page.locator('.card').nth(1)).toHaveCSS('padding', '28px');
        await expect(page.locator('.card').first()).toHaveCSS('background-color', variant === 'light' ? 'rgb(255, 255, 255)' : 'rgb(34, 34, 34)');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        if (width < 900) {
          const scroll = page.locator('[style*="overflow-x:auto"]');
          expect(await scroll.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
          expect(await scroll.evaluate(element => { element.scrollLeft = 100; return element.scrollLeft; })).toBe(100);
        }
        const image = await page.locator('img').boundingBox();
        expect(image!.width / image!.height).toBeCloseTo(600 / 350, 1);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('Naive responsive grids follow container and screen widths while preserving code and rich content', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-content-layout-'));
  try {
    await writeFile(path.join(root, 'components.d.ts'), naiveDeclarations);
    await writeFile(path.join(root, 'View.vue'), `<script setup>const html='<h1>Heading</h1><p>Article paragraph</p>';const code='first\\nsecond\\nthird'</script><template><main><div class="narrow" style="width:300px;max-width:100%"><n-grid cols="1 600:3" x-gap="12"><n-gi v-for="i in 3"><n-code :code="code"/></n-gi></n-grid></div><div class="wide"><n-grid cols="1 600:3" x-gap="12"><n-gi v-for="i in 3"><input/></n-gi></n-grid></div><div class="screen"><n-grid cols="1 s:2" responsive="screen"><n-gi v-for="i in 2"><input/></n-gi></n-grid></div><article v-html="html"/><div ref="opaqueHost" class="opaque-host" style="height:600px;width:100%"/><section class="compact" important:pa0 style="padding:24px"><div px8 pb6>Body</div></section></main></template>`);
    const { artifact } = await compileTarget(root, { id: 'content-layout', source: 'View.vue' }, {}, { componentPresets: ['naive-ui'], styles: { unocss: true } });
    expect(artifact.diagnostics.map(row=>row.code)).toEqual(['FALLBACK']);
    const view = artifact.variants.default;
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(`<style>body{margin:0}${view.css}</style>${view.html}`);
      const columns = (selector: string) => page.locator(selector + ' [class*="sk-naive-grid"]').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length);
      expect(await columns('.narrow')).toBe(1);
      expect(await columns('.wide')).toBe(width >= 600 ? 3 : 1);
      expect(await columns('.screen')).toBe(width >= 640 ? 2 : 1);
      await expect(page.locator('[data-sk-code-line]')).toHaveCount(9);
      await expect(page.locator('article h1 [data-sk-prose]')).toHaveCount(1);
      await expect(page.locator('.opaque-host[data-sk-opaque]')).toHaveCSS('height','600px');
      await expect(page.locator('.opaque-host > *')).toHaveCount(0);
      await expect(page.locator('.compact')).toHaveCSS('padding', '0px');
      await expect(page.locator('.compact > div')).toHaveCSS('padding-left', '32px');
      await expect(page.locator('.compact > div')).toHaveCSS('padding-bottom', '24px');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
