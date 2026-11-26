import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SourceModules } from '../src/compiler/modules.js';
import { compileTarget } from '../src/compiler/index.js';
import { projectFromConfig, syncProject, checkProject } from '../src/generator.js';
import { resolveSource } from '../src/init/scan.js';
import { objectConfig, parseCode, unwrap } from '../src/init/ast.js';

test('init and compilation agree on directory JSX, aliases, queries and source precedence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skelcast-resolution-'));
  try {
    for (const [file, content] of Object.entries({
      'src/Panel/index.jsx': 'export default () => <article>Panel content</article>',
      'src/Panel/index.ts': 'export default () => <aside>Lower priority</aside>',
      'src/App.jsx': "import Panel from '@ui/Panel'; export default () => <main><Panel/></main>",
      'src/direct.jsx': 'export default () => <div/>',
      'src/direct/index.tsx': 'export default () => <div/>',
      'src/helper.mjs': 'export const count = 2',
    })) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    }
    const aliases = { '@ui': 'missing', '@ui/Panel': 'src/Panel' };
    for (const [request, expected] of [
      ['./Panel', 'src/Panel/index.jsx'],
      ['./Panel?raw', 'src/Panel/index.jsx'],
      ['@ui/Panel', 'src/Panel/index.jsx'],
      ['./direct', 'src/direct.jsx'],
      ['./helper', 'src/helper.mjs'],
    ]) {
      assert.equal(await resolveSource(root, 'src/App.jsx', request, aliases), expected);
      assert.equal(await new SourceModules(root, {}, aliases).resolve(path.join(root, 'src/App.jsx'), request), path.join(root, expected));
    }
    const target = { id: 'panel', source: 'src/App.jsx' };
    const { artifact } = await compileTarget(root, target, aliases);
    assert.match(artifact.variants.default.html, /<article/);
    assert.doesNotMatch(artifact.variants.default.html, /Lower priority|data-sk-fallback/);

    const project = await projectFromConfig(root, { aliases, targets: [target] });
    await syncProject(project);
    assert.equal((await checkProject(project, 'panel'))[0].state, 'ready');
    // A new higher-priority candidate must invalidate the directory resolution.
    await writeFile(path.join(root, 'src/Panel.tsx'), 'export default () => <section>Replacement</section>');
    const changed = await checkProject(project, 'panel');
    assert.equal(changed[0].state, 'stale');
    assert.match(changed[0].reason!, /Panel\.tsx created/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('init unwraps TypeScript angle assertions when reading static configuration and expressions', () => {
  const ast = parseCode('export default <Config>({targets: []} satisfies Config)!;', 'config.ts');
  assert.equal(objectConfig(ast)?.type, 'ObjectExpression');
  const statement = parseCode('const count = <number>1;', 'state.ts').program.body[0];
  assert.equal(statement.type, 'VariableDeclaration');
  if (statement.type === 'VariableDeclaration') assert.equal(unwrap(statement.declarations[0].init)?.type, 'NumericLiteral');
});
