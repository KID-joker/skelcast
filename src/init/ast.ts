import { parse, parseExpression } from '@babel/parser';
import type * as t from '@babel/types';
import { endOf, isRenderFunction, nodeName, startOf, walk } from '../compiler/ast.js';

export { endOf, nodeName, startOf, walk };
export type Ast = t.Node;
export interface Edit { start: number; end: number; text: string }
export function parseCode(code: string) { return parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] }); }
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
export function sameCondition(left: string, right: string): boolean {
  if (left === right) return true;
  const key = (code: string) => JSON.stringify(parseExpression(code, { plugins: ['typescript'] }), (name, value: unknown) =>
    ['start', 'end', 'loc', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments'].includes(name) ? undefined : value);
  try { return key(left) === key(right); } catch { return false; }
}
export function unwrap(node: t.Node | null | undefined): t.Node | undefined {
  while (node) {
    switch (node.type) {
      case 'TSAsExpression': case 'TSSatisfiesExpression': case 'TSNonNullExpression': case 'ParenthesizedExpression': node = node.expression; break;
      default: return node;
    }
  }
}
export function objectConfig(ast: t.File): t.ObjectExpression | undefined {
  const declaration = ast.program.body.find(n => n.type === 'ExportDefaultDeclaration');
  let value = unwrap(declaration?.declaration);
  if (value?.type === 'CallExpression' && value.arguments.length === 1) value = unwrap(value.arguments[0]);
  return value?.type === 'ObjectExpression' ? value : undefined;
}
export const loadingName = (s: string) => /^(?:is)?(?:loading|pending|fetching|initialloading)$|(?:Loading|Pending|Fetching)$/.test(s) || /^(?:isLoading|isPending|isFetching)$/.test(s);
const unsafeCondition = (node: t.Node) => ['CallExpression', 'OptionalCallExpression', 'AssignmentExpression', 'UpdateExpression', 'AwaitExpression', 'NewExpression'].includes(node.type);
export function pureCondition(code: string): boolean {
  try {
    let unsafe = false;
    walk(parseExpression(code, { plugins: ['typescript'] }), node => { if (unsafeCondition(node)) unsafe = true; });
    return !unsafe;
  } catch { return false; }
}
export function pendingCondition(code: string, flags: Set<string> = new Set()): boolean {
  try {
    let seen = false, unsafe = false;
    walk(parseExpression(code, { plugins: ['typescript'] }), node => {
      if (node.type === 'Identifier' && (loadingName(node.name) || flags.has(node.name))) seen = true;
      if (unsafeCondition(node)) unsafe = true;
    });
    return seen && !unsafe;
  } catch { return false; }
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
