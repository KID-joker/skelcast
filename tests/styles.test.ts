import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scopeArtifactStyles } from '../src/compiler/styles.js';
import { compileTarget } from '../src/compiler/index.js';
import { checkProject, loadProject, syncProject } from '../src/generator.js';

test('animation and font references are isolated across artifacts, variants and inline styles', () => {
  const source = `@font-face{font-family:"My Font";src:local("Arial")}@font-face{font-family:'My Font';font-weight:700;src:local("Arial Bold")}@keyframes fade{to{opacity:0}}@-webkit-keyframes fade{to{opacity:0}}.card{font:italic 16px/1.4 My Font,sans-serif;animation:fade 2s linear,fade 1s ease-in}@media(min-width:1px){.card{font-family:"my font";animation-name:fade}}`;
  const html = '<div style="font-family:My Font;animation:fade 1s"></div>';
  const one = scopeArtifactStyles(source, html, 'one');
  const two = scopeArtifactStyles(source, html, 'two');
  const variant = scopeArtifactStyles(source + '.card{gap:2px}', html, 'one');
  const animation = (css: string) => css.match(/@keyframes ([\w-]+)/)![1];
  const font = one.css.match(/font-family:"([\w-]+)"/)![1];
  assert.notEqual(animation(one.css), animation(two.css));
  assert.notEqual(animation(one.css), animation(variant.css));
  assert.ok(one.css.includes(`@-webkit-keyframes ${animation(one.css)}`));
  assert.ok(one.css.includes(`animation:${animation(one.css)} 2s linear, ${animation(one.css)} 1s ease-in`));
  assert.ok(one.css.includes(`font:italic 16px/1.4 "${font}", sans-serif`));
  assert.ok(one.html.includes(`font-family:&quot;${font}&quot;`));
  assert.ok(one.html.includes(`animation:${animation(one.css)} 1s`));
});

test('CSS imports, Less imports and inline styles embed relative binary assets and track changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-assets-'));
  try {
    await mkdir(path.join(root, 'styles/nested'), { recursive: true });
    await writeFile(path.join(root, 'tile.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]));
    await writeFile(path.join(root, 'styles/nested/theme.css'), `.box{background:url('../../tile.png?x=1#part')}@font-face{font-family:Demo;src:url('../../tile.png')}`);
    await writeFile(path.join(root, 'styles/main.css'), `@import './nested/theme.css';.outside{background:url('/public.png')} .remote{background:url(https://example.invalid/image.png)} .quoted::before{content:'url(./missing.png)'}`);
    await writeFile(path.join(root, 'styles/nested/theme.less'), `.less{background:url('../../tile.png')}`);
    await writeFile(path.join(root, 'styles/main.less'), `@import './nested/theme.less';`);
    await writeFile(path.join(root, 'View.jsx'), `import './styles/main.css';import './styles/main.less';import tile from './tile.png';export default ()=> <div className="box less" style={{backgroundImage:"url('./tile.png')"}}><img src={tile}/></div>`);
    await writeFile(path.join(root, 'skelcast.config.mjs'), `export default {styles:{less:true},targets:[{id:'assets',source:'View.jsx'}]}`);
    const { artifact, dependencies } = await compileTarget(root, { id: 'assets', source: 'View.jsx' }, {}, { styles: { less: true } });
    const data = `data:image/png;base64,${(await readFile(path.join(root, 'tile.png'))).toString('base64')}`;
    assert.ok(artifact.variants.default.css.includes(data));
    assert.ok(artifact.variants.default.html.includes(data));
    assert.ok(artifact.variants.default.css.includes('#part'));
    assert.ok(artifact.variants.default.css.includes("url('/public.png')"));
    assert.ok(artifact.variants.default.css.includes('https://example.invalid/image.png'));
    assert.ok(dependencies['tile.png']);
    const project = await loadProject(root);
    await syncProject(project);
    assert.equal((await checkProject(project))[0].state, 'ready');
    await writeFile(path.join(root, 'tile.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xfe, 0x00]));
    assert.equal((await checkProject(project))[0].state, 'stale');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('font and animation names retain their namespace through CSS variable chains and inline fallbacks', () => {
  const source = `@font-face{font-family:Demo;src:local(Arial)}@keyframes fade{to{opacity:0}}:root{--face:Demo;--theme-face:var(--face);--motion:fade 2s linear;--other-motion:var(--motion)}.card{font-family:var(--theme-face,Demo)}`;
  const result = scopeArtifactStyles(source, '<div style="animation:var(--other-motion,fade 1s);font-family:var(--face,Demo)"></div>', 'variables');
  const font = result.css.match(/font-family:"([\w-]+)"/)![1];
  const animation = result.css.match(/@keyframes ([\w-]+)/)![1];
  assert.ok(result.css.includes(`--face:"${font}"`));
  assert.ok(result.css.includes(`--motion:${animation} 2s linear`));
  assert.ok(result.css.includes(`var(--theme-face, "${font}")`));
  assert.ok(result.html.includes(`var(--other-motion, ${animation} 1s)`));
  assert.ok(result.html.includes(`var(--face, &quot;${font}&quot;)`));
});
