import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {compileTarget} from '../src/compiler/index.js';
import {loadProject,syncProject,checkProject} from '../src/generator.js';

async function fixture(files:Record<string,string|Uint8Array>, run:(root:string)=>Promise<void>){
 const root=await mkdtemp(path.join(os.tmpdir(),'skelcast-geometry-'));
 try{for(const [name,contents]of Object.entries(files)){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),contents);}await run(root);}finally{await rm(root,{recursive:true,force:true});}
}

test('opaque components keep caller dimensions, classes, scopes and source minimum/aspect constraints',async()=>{
 await fixture({
  'Opaque.ts':`export default makeBusinessWidget();`,
  'View.vue':`<script setup>import Opaque from './Opaque'</script><template><section><Opaque width="18" height="18" class="icon"/><Opaque style="width:42px;height:21px"/><Opaque class="responsive"/><Opaque style="min-height:24px"/><Opaque style="width:80px;aspect-ratio:2"/></section></template><style scoped>.responsive{width:30px;height:15px}@media(min-width:700px){.responsive{width:100px;height:50px}}</style>`,
 },async root=>{
  const {artifact}=await compileTarget(root,{id:'opaque',source:'View.vue'});
  const v=artifact.variants.default;
  assert.match(v.html,/width:18px;height:18px/);
  assert.match(v.html,/data-v-sk-[\w]+ class="responsive"/);
  assert.match(v.html,/min-height:24px;--sk-fallback-height:auto/);
  assert.doesNotMatch(v.html,/[;"]min-height:96px/);
  assert.equal(artifact.diagnostics.filter(d=>d.code==='FALLBACK').length,5);
 });
});

test('SCSS and indented Sass compile aliases, partials and imported asset origins without running entry scripts',async()=>{
 await fixture({
  'index.html':'<script type="module" src="/src/main.ts"></script>',
  'src/main.ts':`import './styles/global.scss';throw Error('application must not execute');`,
  'src/styles/_tokens.scss':'$space:18px;',
  'src/styles/global.scss':`@use './tokens' as *;.frame{padding:$space;}`,
  'src/styles/_photo.scss':`.photo{background-image:url('../assets/tile.png');}`,
  'src/assets/tile.png':Buffer.from([0x89,0x50,0x4e,0x47]),
  'View.vue':`<template><main class="frame"><article class="photo">Data</article><aside>Other</aside></main></template><style lang="scss" scoped>@use '@app/styles/tokens' as *;@use '@app/styles/photo';article{margin:$space;&:hover{padding:2px}}</style><style lang="sass" scoped>aside\n  height: 27px\n</style>`,
  'skelcast.config.mjs':`export default {aliases:{'@app':'src'},targets:[{id:'scss',source:'View.vue'}]}`,
 },async root=>{
  const p=await loadProject(root);await syncProject(p);
  const {artifact,dependencies}=await compileTarget(root,p.config.targets[0],p.config.aliases);
  assert.deepEqual(artifact.diagnostics,[]);
  assert.match(artifact.variants.default.css,/padding: 18px/);
  assert.match(artifact.variants.default.css,/height: 27px/);
  assert.match(artifact.variants.default.css,/data:image\/png;base64/);
  for(const f of ['src/main.ts','src/styles/_tokens.scss','src/styles/_photo.scss','src/assets/tile.png'])assert.ok(dependencies[f],f);
  await writeFile(path.join(root,'src/styles/_tokens.scss'),'$space:24px;');
  assert.equal((await checkProject(p))[0].state,'stale');
 });
});

test('SCSS missing alternatives are dependencies and ambiguous partials fail explicitly',async()=>{
 await fixture({'View.vue':`<template><div/></template><style lang="scss">@use './theme';.x{padding:theme.$gap}</style>`,'_theme.scss':'$gap:12px;'},async root=>{
  const first=await compileTarget(root,{id:'scss',source:'View.vue'});
  assert.equal(first.dependencies['theme.scss'],'!missing');
  await writeFile(path.join(root,'theme.scss'),'$gap:20px;');
  await assert.rejects(compileTarget(root,{id:'scss',source:'View.vue'}),/Ambiguous stylesheet/);
 });
});

test('Tailwind 4 CSS theme, custom utilities, variants, @apply and inline safelists compile from generated markup',async()=>{
 await fixture({
  'index.html':'<script type="module" src="/main.js"></script>',
  'main.js':`import './theme.css';throw Error('application must not execute');`,
  'theme.css':`@import 'tailwindcss/theme.css' layer(theme);@import 'tailwindcss/utilities.css' layer(utilities);@theme{--color-brand:#123456}@utility panel{padding:18px;@apply flex items-center;}@custom-variant dark (&:where(.dark *));@source inline('h-7');`,
  'View.vue':`<template><main class="panel w-full md:w-1/2 dark:bg-brand"><p class="text-brand">Data</p></main></template>`,
 },async root=>{
  const {artifact,dependencies}=await compileTarget(root,{id:'tailwind',source:'View.vue'},{},{styles:{prune:false}});
  const css=artifact.variants.default.css;
  assert.deepEqual(artifact.diagnostics,[]);
  assert.match(css,/display: flex/);
  assert.match(css,/padding: 18px/);
  assert.match(css,/--color-brand: #123456/);
  assert.match(css,/\.h-7/);
  assert.match(css,/width: calc\(1 \/ 2 \* 100%\)/);
  assert.doesNotMatch(css,/@(?:theme|utility|tailwind|apply)\b/);
  assert.ok(Object.keys(dependencies).some(f=>f.endsWith('/theme.css')));
 });
});

test('Tailwind JavaScript configs and plugins are rejected without executing their modules',async()=>{
 await fixture({'View.vue':`<template><div/></template><style>@config './business.js';</style>`,'business.js':`throw Error('application must not execute');`},async root=>{
  for(const directive of ['config','plugin']){
   await writeFile(path.join(root,'View.vue'),`<template><div/></template><style>@${directive} './business.js';</style>`);
   await assert.rejects(compileTarget(root,{id:'blocked',source:'View.vue'}),new RegExp(`JavaScript ${directive} is not executed`));
  }
 });
});
