import { parseExpression } from '@babel/parser';
import type * as t from '@babel/types';
import { endOf, isRenderFunction, nodeName, parseSource, startOf, unwrapExpression as unwrap, walk } from '../compiler/ast.js';

export { endOf, nodeName, startOf, unwrap, walk };
export type Ast = t.Node;
export interface Edit { start: number; end: number; text: string }
export function parseCode(code: string, filename?: string, jsx?: boolean) { return parseSource(code, filename, jsx); }
export const slice = (code: string, node: t.Node) => code.slice(startOf(node), endOf(node));
export const isFunction = isRenderFunction;
export function applyEdits(code: string, edits: Edit[]): string {
  for (const e of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) code = code.slice(0, e.start) + e.text + code.slice(e.end);
  return code;
}
export function importOffset(ast: t.File): number {
  return Math.max(0, ...ast.program.directives.map(endOf), ...ast.program.body.filter(n => n.type === 'ImportDeclaration').map(endOf));
}
export function uniqueName(code: string, base: string): string {
  let name = base, index = 1;
  while (new RegExp(`\\b${name}\\b`).test(code)) name = `${base}${index++}`;
  return name;
}
/** Identify adapter imports rather than matching unrelated component names. */
export function boundaryImports(ast: t.File, framework: 'react' | 'vue'): Set<string> {
  const names = new Set<string>();
  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== `skelcast/${framework}`) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier' && nodeName(specifier.imported) === 'LoadingBoundary') names.add(specifier.local.name);
      if (specifier.type === 'ImportNamespaceSpecifier') names.add(`${specifier.local.name}.LoadingBoundary`);
    }
  }
  return names;
}
export function objectConfig(ast: t.File): t.ObjectExpression | undefined {
  const declaration = ast.program.body.find(n => n.type === 'ExportDefaultDeclaration');
  let value = unwrap(declaration?.declaration);
  if (value?.type === 'CallExpression' && value.arguments.length === 1) value = unwrap(value.arguments[0]);
  return value?.type === 'ObjectExpression' ? value : undefined;
}
export const loadingName = (s: string) => /^(?:is)?(?:loading|pending|fetching|initialloading)$|(?:Loading|Pending|Fetching)$/.test(s);
const unsafeCondition = (node: t.Node) => ['CallExpression', 'OptionalCallExpression', 'AssignmentExpression', 'UpdateExpression', 'AwaitExpression', 'NewExpression'].includes(node.type);
/** One file analysis shares syntax facts; known loading flags remain caller-local. */
export function createConditionAnalyzer() {
  interface Condition { key: string; names: string[]; unsafe: boolean }
  const cache = new Map<string, Condition | null>();
  const analyze = (code: string) => {
    if (cache.has(code)) return cache.get(code);
    let result: Condition | null = null;
    try {
      const ast = parseExpression(code, { plugins: ['typescript'] });
      const names = new Set<string>();
      let unsafe = false;
      walk(ast, node => {
        if (node.type === 'Identifier') names.add(node.name);
        if (unsafeCondition(node)) unsafe = true;
      });
      const key = JSON.stringify(ast, (name, value: unknown) =>
        ['start', 'end', 'loc', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments'].includes(name) ? undefined : value);
      result = { key, names: [...names], unsafe };
    } catch { /* Invalid conditions remain opaque for every consumer. */ }
    cache.set(code, result);
    return result;
  };
  return {
    sameCondition(left: string, right: string): boolean {
      if (left === right) return true;
      const a = analyze(left), b = analyze(right);
      return !!a && !!b && a.key === b.key;
    },
    pureCondition(code: string): boolean {
      const result = analyze(code);
      return !!result && !result.unsafe;
    },
    pendingCondition(code: string, flags: Set<string> = new Set()): boolean {
      const result = analyze(code);
      return !!result && !result.unsafe && result.names.some(name => loadingName(name) || flags.has(name));
    },
  };
}
export function isLoader(node: t.Node | null | undefined, code: string): boolean {
  if (!node) return false;
  if (node.type === 'NullLiteral' || node.type === 'BooleanLiteral' && !node.value) return true;
  if (node.type !== 'JSXElement' && node.type !== 'JSXFragment') return false;
  let result = false;
  walk(node, n => {
    if (n.type === 'JSXOpeningElement' && /(?:loader|loading|spinner|skeleton|progress)/i.test(nodeName(n.name) ?? '')) result = true;
    if (n.type === 'JSXText' && /loading|加载|请稍候/i.test(n.value)) result = true;
    if (n.type === 'JSXAttribute' && nodeName(n.name) === 'role' && n.value?.type === 'StringLiteral' && ['progressbar', 'status'].includes(n.value.value)) result = true;
  });
  return result || /\bloading\b/i.test(slice(code, node)) && node.children.length === 0;
}
