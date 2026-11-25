import type * as t from '@babel/types';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseSFC } from '@vue/compiler-sfc';
import { evaluate } from '../compiler/expression.js';
import { nodeName, parseCode, unwrap, walk, type Ast } from './ast.js';
import { reactComponents } from './react.js';
import type { InitDiagnostic } from './types.js';

const ignored = new Set(['node_modules', '.git', '.skelcast', '.skelcast-init', 'dist', 'build', 'coverage', '.next', '.nuxt', '.output', 'test-results', 'playwright-report', 'vendor', 'tests', '__tests__', '__mocks__']);
export interface SourceFile { file: string; code: string; ast: t.File; vue: boolean; imports: Map<string, string> }
export interface ScanResult { files: SourceFile[]; routes: Map<string, Set<string>>; aliases: Record<string, string>; diagnostics: InitDiagnostic[] }
export const relativePath = (root: string, file: string) => path.relative(root, file).split(path.sep).join('/');
async function exists(file: string) { try { return (await stat(file)).isFile(); } catch { return false; } }
export async function resolveSource(root: string, from: string, request: string, aliases: Record<string, string>): Promise<string | undefined> {
  let base: string;
  if (request.startsWith('.')) base = path.resolve(path.dirname(path.join(root, from)), request);
  else {
    const alias = Object.keys(aliases).sort((a, b) => b.length - a.length).find(a => request === a || request.startsWith(`${a}/`));
    if (!alias) return;
    base = path.resolve(root, aliases[alias], `.${request.slice(alias.length)}`);
  }
  for (const ext of ['', '.tsx', '.jsx', '.vue', '.ts', '.js', '/index.tsx', '/index.jsx', '/index.vue', '/index.ts', '/index.js']) {
    if (await exists(base + ext)) return relativePath(root, base + ext);
  }
}
async function discover(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink() || entry.name.startsWith('.') || ignored.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await discover(root, file));
    else if (/\.(?:tsx?|jsx?|vue)$/.test(entry.name) && !/\.d\.[cm]?ts$|\.(?:test|spec|stories|story)\./.test(entry.name) && !/^(?:vite|vitest|playwright|eslint|postcss|tailwind|skelcast)\.config\./.test(entry.name)) files.push(relativePath(root, file));
  }
  return files;
}
function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function jsxAttribute(node: t.JSXElement, name: string): t.JSXAttribute['value'] {
  const attribute = node.openingElement.attributes.find(a => a.type === 'JSXAttribute' && nodeName(a.name) === name);
  return attribute?.type === 'JSXAttribute' ? attribute.value : undefined;
}
function jsxLiteral(value: t.JSXAttribute['value']): string | boolean | undefined {
  if (value?.type === 'StringLiteral') return value.value;
  if (value?.type === 'JSXExpressionContainer' && (value.expression.type === 'StringLiteral' || value.expression.type === 'BooleanLiteral')) return value.expression.value;
}
async function readAliases(root: string, diagnostics: InitDiagnostic[]): Promise<Record<string, string>> {
  const aliases: Record<string, string> = {};
  const visited = new Set<string>();
  const visit = async (file: string): Promise<void> => {
    if (visited.has(file)) return;
    visited.add(file);
    try {
      const code = await readFile(file, 'utf8');
      const ast = parseCode(`export default (${code});`);
      const declaration = ast.program.body[0];
      if (declaration.type !== 'ExportDefaultDeclaration') return;
      const value = evaluate(declaration.declaration, { code: `export default (${code});`, env: {}, bindings: {} });
      const config = record(value);
      if (typeof config.extends === 'string' && config.extends.startsWith('.')) {
        let base = path.resolve(path.dirname(file), config.extends);
        if (!base.endsWith('.json')) base += '.json';
        await visit(base);
      }
      for (const ref of Array.isArray(config.references) ? config.references : []) if (typeof record(ref).path === 'string') {
        const candidate = path.resolve(path.dirname(file), String(record(ref).path));
        await visit(candidate.endsWith('.json') ? candidate : path.join(candidate, 'tsconfig.json'));
      }
      const options = record(config.compilerOptions);
      const base = path.resolve(path.dirname(file), typeof options.baseUrl === 'string' ? options.baseUrl : '.');
      for (const [key, values] of Object.entries(record(options.paths))) {
        const value = Array.isArray(values) ? values[0] : undefined;
        if (typeof value === 'string' && /^(?:[^*]+|[^*]+\/\*)$/.test(key)) aliases[key.replace(/\/\*$/, '')] = relativePath(root, path.resolve(base, value.replace(/\/\*$/, ''))) || '.';
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostics.push({ code: 'TSCONFIG_PARSE', file: relativePath(root, file), message: String(error) });
    }
  };
  await visit(path.join(root, 'tsconfig.json'));
  await visit(path.join(root, 'jsconfig.json'));
  return aliases;
}
function lazyImport(node: Ast): string | undefined {
  let request: string | undefined;
  walk(node, n => {
    if (n.type === 'CallExpression' && n.callee.type === 'Import' && n.arguments[0]?.type === 'StringLiteral') request = n.arguments[0].value;
    if (n.type === 'ImportExpression' && n.source.type === 'StringLiteral') request = n.source.value;
  });
  return request;
}
export async function scanProject(root: string, viteAliases: Record<string, string> = {}): Promise<ScanResult> {
  const diagnostics: InitDiagnostic[] = [], files: SourceFile[] = [];
  const aliases = { ...await readAliases(root, diagnostics), ...viteAliases };
  const sourceFiles = await discover(root);
  for (const file of sourceFiles) {
    try {
      const code = await readFile(path.join(root, file), 'utf8');
      let script = code;
      if (file.endsWith('.vue')) {
        const parsed = parseSFC(code, { filename: file });
        if (parsed.errors.length) throw new Error(String(parsed.errors[0]));
        script = [parsed.descriptor.script?.content, parsed.descriptor.scriptSetup?.content].filter(Boolean).join('\n');
      }
      const ast = parseCode(script), imports = new Map<string, string>();
      for (const node of ast.program.body) if (node.type === 'ImportDeclaration') for (const spec of node.specifiers) imports.set(spec.local.name, node.source.value);
      walk(ast, node => {
        if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init?.type === 'CallExpression' && ['lazy', 'defineAsyncComponent'].includes(nodeName(node.init.callee) ?? '')) {
          const request = lazyImport(node.init); if (request) imports.set(node.id.name, request);
        }
      });
      files.push({ file, code, ast, imports, vue: file.endsWith('.vue') });
    } catch (error) { diagnostics.push({ code: 'SOURCE_PARSE', file, message: String(error) }); }
  }
  const routes = new Map<string, Set<string>>();
  const route = async (source: SourceFile, input: Ast, url: string) => {
    let request: string | undefined;
    const node = unwrap(input);
    if (node?.type === 'Identifier') request = source.imports.get(node.name);
    if (node?.type === 'JSXElement') request = source.imports.get(nodeName(node.openingElement.name) ?? '');
    if (node) request ??= lazyImport(node);
    if (!request) return;
    const resolved = await resolveSource(root, source.file, request, aliases);
    if (!resolved) { diagnostics.push({ code: 'ROUTE_IMPORT', file: source.file, message: `Cannot resolve route import ${request}` }); return; }
    const set = routes.get(resolved) ?? new Set<string>(); set.add(url); routes.set(resolved, set);
  };
  for (const source of files) {
    const pending: Promise<void>[] = [];
    walk(source.ast, (node, ancestors) => {
      if (node.type === 'ObjectExpression') {
        const props = node.properties.filter(p => p.type === 'ObjectProperty');
        const routePath = props.find(p => nodeName(p.key) === 'path')?.value;
        const indexValue = props.find(p => nodeName(p.key) === 'index')?.value;
        const indexRoute = indexValue?.type === 'BooleanLiteral' && indexValue.value;
        const component = props.find(p => ['component', 'Component', 'element'].includes(nodeName(p.key) ?? ''))?.value;
        if ((routePath?.type === 'StringLiteral' || indexRoute) && component) {
          let url = routePath?.type === 'StringLiteral' ? routePath.value : '';
          for (const parent of [...ancestors].reverse()) {
            if (url.startsWith('/')) break;
            if (parent.type === 'ObjectExpression') {
              const p = parent.properties.find(p => p.type === 'ObjectProperty' && nodeName(p.key) === 'path');
              if (p?.type === 'ObjectProperty' && p.value.type === 'StringLiteral') url = `${p.value.value.replace(/\/$/, '')}/${url}`;
            }
          }
          pending.push(route(source, component, url.startsWith('/') ? url : `/${url}`));
        }
      }
      if (node.type === 'JSXElement' && nodeName(node.openingElement.name) === 'Route') {
        const attr = (name: string) => jsxAttribute(node, name);
        const p = attr('path'), element = attr('element') ?? attr('Component');
        const index = node.openingElement.attributes.find(a => a.type === 'JSXAttribute' && nodeName(a.name) === 'index');
        const indexRoute = index?.type === 'JSXAttribute' && (!index.value || jsxLiteral(index.value) === true);
        let url = jsxLiteral(p) ?? (indexRoute ? '' : undefined);
        if (typeof url === 'string' && element?.type === 'JSXExpressionContainer') {
          for (const parent of [...ancestors].reverse()) {
            if (url.startsWith('/')) break;
            if (parent.type !== 'JSXElement' || nodeName(parent.openingElement.name) !== 'Route') continue;
            const prefix = jsxLiteral(jsxAttribute(parent, 'path'));
            if (typeof prefix === 'string') url = `${prefix.replace(/\/$/, '')}/${url}`.replace(/\/$/, '') || '/';
          }
          pending.push(route(source, element.expression, url.startsWith('/') ? url : `/${url}`));
        }
      }
    });
    await Promise.all(pending);
  }
  return { files, routes, aliases, diagnostics };
}
export function isPageFile(source: SourceFile, hasRoutes: boolean): boolean {
  if (/(?:^|\/)(?:components|__tests__)\//.test(source.file)) return false;
  if (/(?:^|\/)(?:pages|views)\//.test(source.file)) return source.vue || reactComponents(source.ast).some(c => c.exported === 'default' || /Page$/.test(c.name));
  if (/Page\.(?:tsx|jsx|vue)$/.test(source.file)) return true;
  return !hasRoutes && /(?:^|\/)App\.(?:tsx|jsx|vue)$/.test(source.file);
}
export function inferredRoute(file: string): string | undefined {
  if (/(?:^|\/)App\.(?:tsx|jsx|vue)$/.test(file)) return '/';
  if (!/(?:^|\/)(?:pages|views)\//.test(file)) return;
  return '/' + file.replace(/^.*?(?:pages|views)\//, '').replace(/\.(?:tsx|jsx|vue)$/, '').replace(/(?:^|\/)index$/i, '').replace(/\[\.\.\.[^\]]+\]/g, '*').replace(/\[([^\]]+)\]/g, ':$1').replace(/\/+$/, '');
}
