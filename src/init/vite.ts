import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { applyEdits, importOffset, parseCode, uniqueName, walk, type Ast } from './ast.js';
import type { InitChange, InitDiagnostic } from './types.js';

export async function integrateVite(root: string, manifest: any): Promise<{ changes: InitChange[]; diagnostics: InitDiagnostic[]; configRoot?: string; aliases?: Record<string, string> }> {
  const changes: InitChange[] = [], diagnostics: InitDiagnostic[] = [];
  const custom = new Set<string>();
  for (const script of Object.values(manifest.scripts ?? {})) if (typeof script === 'string' && /\bvite\b/.test(script)) {
    const config = script.match(/--config(?:=|\s+)([\w./-]+)/)?.[1];
    if (config) custom.add(config);
  }
  if (custom.size > 1) return { changes, diagnostics: [{ code: 'VITE_MULTIPLE_CONFIGS', file: 'package.json', message: 'Multiple Vite configs need explicit plugin integration' }] };
  const candidates = custom.size ? [...custom] : ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'];
  let file: string | undefined, code: string | undefined;
  for (const candidate of candidates) {
    try { code = await readFile(path.join(root, candidate), 'utf8'); file = candidate; break; }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!file || code == null) {
    const hasVite = !!manifest.dependencies?.vite || !!manifest.devDependencies?.vite;
    if (hasVite && !custom.size) changes.push({ file: 'vite.config.mjs', before: null, after: `import { skelcastPlugin } from 'skelcast/vite';\nexport default { plugins: [skelcastPlugin()] };\n`, reason: 'Register SkelCast with Vite' });
    else diagnostics.push({ code: 'BUNDLER_UNSUPPORTED', file: 'package.json', message: 'No supported Vite config found; framework/bundler adapter required' });
    return { changes, diagnostics };
  }
  const ast = parseCode(code);
  const declaration = ast.program.body.find((n: Ast) => n.type === 'ExportDefaultDeclaration')?.declaration;
  if (!declaration) return { changes, diagnostics: [{ code: 'VITE_CONFIG_UNSUPPORTED', file, message: 'Vite config has no ESM default export' }] };
  let configRoot = root;
  let dynamicRoot = false;
  const aliases: Record<string, string> = {};
  const staticPath = (value: Ast): string | undefined => {
    if (value.type === 'StringLiteral') return path.resolve(root, value.value);
    if (value.type === 'CallExpression' && value.callee.name === 'fileURLToPath' && value.arguments[0]?.type === 'NewExpression' && value.arguments[0].callee.name === 'URL' && value.arguments[0].arguments[0]?.type === 'StringLiteral') return path.resolve(path.dirname(path.join(root, file!)), value.arguments[0].arguments[0].value);
  };
  walk(declaration, node => {
    if (node.type === 'ObjectProperty' && (node.key.name ?? node.key.value) === 'alias' && node.value.type === 'ObjectExpression') {
      for (const p of node.value.properties) if (p.type === 'ObjectProperty') {
        const value = staticPath(p.value);
        if (value) aliases[p.key.name ?? p.key.value] = path.relative(root, value).split(path.sep).join('/') || '.';
      }
    }
    if (node.type !== 'ObjectProperty' || (node.key.name ?? node.key.value) !== 'root') return;
    const value = staticPath(node.value);
    if (value) configRoot = value;
    else dynamicRoot = true;
  });
  if (dynamicRoot) diagnostics.push({ code: 'VITE_ROOT_DYNAMIC', file, message: 'Cannot determine Vite root without executing config; select a static root before init' });
  const imported = new Map<string, string>();
  for (const n of ast.program.body) if (n.type === 'ImportDeclaration' && n.source.value === 'skelcast/vite') for (const s of n.specifiers) if (s.imported?.name) imported.set(s.local.name, s.imported.name);
  let registered = false;
  walk(ast, n => { if (n.type === 'CallExpression' && ['skelcastPlugin', 'withSkelCast'].includes(imported.get(n.callee.name) ?? '')) registered = true; });
  if (registered) return { changes, diagnostics, configRoot, aliases };
  // Wrapping preserves object, function, async function, Promise and defineConfig forms.
  const existingHelper = [...imported].find(([, name]) => name === 'withSkelCast')?.[0];
  const helper = existingHelper ?? uniqueName(code, '__withSkelCast');
  const offset = importOffset(ast);
  const changed = applyEdits(code, [
    ...existingHelper ? [] : [{ start: offset, end: offset, text: `\nimport { withSkelCast as ${helper} } from 'skelcast/vite';\n` }],
    { start: declaration.start, end: declaration.start, text: `${helper}(` },
    { start: declaration.end, end: declaration.end, text: declaration.type === 'FunctionDeclaration' ? ');' : ')' },
  ]);
  parseCode(changed);
  changes.push({ file, before: code, after: changed, reason: 'Register SkelCast while preserving the existing Vite config' });
  return { changes, diagnostics, configRoot, aliases };
}
