import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { applyEdits, importOffset, uniqueName } from './ast.js';
import { startOf, endOf, nodeName, parseSource, walk, type Ast } from '../compiler/ast.js';
import type { InitChange, InitDiagnostic } from './types.js';

export async function integrateVite(root: string, manifest: { scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }): Promise<{ changes: InitChange[]; diagnostics: InitDiagnostic[]; configRoot?: string; aliases?: Record<string, string> }> {
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
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (!file || code == null) {
    const hasVite = !!manifest.dependencies?.vite || !!manifest.devDependencies?.vite;
    if (hasVite && !custom.size) changes.push({ file: 'vite.config.mjs', before: null, after: `import { skelcastPlugin } from 'skelcast/vite';\nexport default { plugins: [skelcastPlugin()] };\n`, reason: 'Register SkelCast with Vite' });
    else diagnostics.push({ code: 'BUNDLER_UNSUPPORTED', file: 'package.json', message: 'No supported Vite config found; framework/bundler adapter required' });
    return { changes, diagnostics };
  }
  const ast = parseSource(code, file);
  const declaration = ast.program.body.find(n => n.type === 'ExportDefaultDeclaration')?.declaration;
  if (!declaration) return { changes, diagnostics: [{ code: 'VITE_CONFIG_UNSUPPORTED', file, message: 'Vite config has no ESM default export' }] };
  let configRoot = root;
  let dynamicRoot = false;
  const aliases: Record<string, string> = {};
  const constants = new Map<string, Ast>();
  const ambiguous = new Set<string>();
  walk(ast, (node, ancestors) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
      if (constants.has(node.id.name) || ancestors.at(-1)?.type !== 'VariableDeclaration' || (ancestors.at(-1) as import('@babel/types').VariableDeclaration).kind !== 'const') ambiguous.add(node.id.name);
      constants.set(node.id.name, node.init);
    }
    if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') ambiguous.add(node.left.name);
    if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier') ambiguous.add(node.argument.name);
    if (['ImportSpecifier','ImportDefaultSpecifier','ImportNamespaceSpecifier'].includes(node.type) && 'local' in node) ambiguous.add((node.local as import('@babel/types').Identifier).name);
    if (['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type) && 'params' in node) for (const param of node.params as Ast[]) if (param.type === 'Identifier') ambiguous.add(param.name);
  });
  const staticPath = (value: Ast, seen = new Set<string>()): string | undefined => {
    if (value.type === 'Identifier' && constants.has(value.name) && !ambiguous.has(value.name) && !seen.has(value.name)) return staticPath(constants.get(value.name)!, new Set([...seen, value.name]));
    if (value.type === 'CallExpression' && value.arguments.length === 0 && value.callee.type === 'MemberExpression' && !value.callee.computed && nodeName(value.callee.object) === 'process' && nodeName(value.callee.property) === 'cwd' && !constants.has('process') && !ambiguous.has('process')) return root;
    if (value.type === 'StringLiteral') return path.resolve(root, value.value);
    if (value.type === 'CallExpression' && nodeName(value.callee) === 'fileURLToPath' && value.arguments[0]?.type === 'NewExpression' && nodeName(value.arguments[0].callee) === 'URL' && value.arguments[0].arguments[0]?.type === 'StringLiteral') return path.resolve(path.dirname(path.join(root, file!)), value.arguments[0].arguments[0].value);
  };
  walk(declaration, node => {
    if (node.type === 'ObjectProperty' && nodeName(node.key) === 'alias' && node.value.type === 'ObjectExpression') {
      for (const p of node.value.properties) if (p.type === 'ObjectProperty') {
        const value = staticPath(p.value);
        if (value) aliases[nodeName(p.key)!] = path.relative(root, value).split(path.sep).join('/') || '.';
      }
    }
    if (node.type !== 'ObjectProperty' || nodeName(node.key) !== 'root') return;
    const value = staticPath(node.value);
    if (value) configRoot = value;
    else dynamicRoot = true;
  });
  if (dynamicRoot) diagnostics.push({ code: 'VITE_ROOT_DYNAMIC', file, message: 'Cannot determine Vite root without executing config; select a static root before init' });
  const imported = new Map<string, string>();
  for (const n of ast.program.body) if (n.type === 'ImportDeclaration' && n.source.value === 'skelcast/vite') for (const s of n.specifiers) if (s.type === 'ImportSpecifier') imported.set(s.local.name, nodeName(s.imported)!);
  let registered = false;
  walk(ast, n => { if (n.type === 'CallExpression' && ['skelcastPlugin', 'withSkelCast'].includes(imported.get(nodeName(n.callee) ?? '') ?? '')) registered = true; });
  if (registered) return { changes, diagnostics, configRoot, aliases };
  // Wrapping preserves object, function, async function, Promise and defineConfig forms.
  const existingHelper = [...imported].find(([, name]) => name === 'withSkelCast')?.[0];
  const helper = existingHelper ?? uniqueName(code, '__withSkelCast');
  const offset = importOffset(ast);
  const changed = applyEdits(code, [
    ...existingHelper ? [] : [{ start: offset, end: offset, text: `\nimport { withSkelCast as ${helper} } from 'skelcast/vite';\n` }],
    { start: startOf(declaration), end: startOf(declaration), text: ` ${helper}(` },
    { start: endOf(declaration), end: endOf(declaration), text: declaration.type === 'FunctionDeclaration' ? ');' : ')' },
  ]);
  parseSource(changed);
  changes.push({ file, before: code, after: changed, reason: 'Register SkelCast while preserving the existing Vite config' });
  return { changes, diagnostics, configRoot, aliases };
}
