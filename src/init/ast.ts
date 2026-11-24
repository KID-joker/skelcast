import { parse, parseExpression } from '@babel/parser';
import type { Ast } from '../compiler/expression.js';

export type { Ast };
export interface Edit { start: number; end: number; text: string }
export function parseCode(code: string): Ast { return parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] }); }
export function walk(node: Ast, visit: (node: Ast, ancestors: Ast[]) => boolean | void, ancestors: Ast[] = []): void {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  if (visit(node, ancestors) === false) return;
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'tokens', 'comments', 'leadingComments', 'trailingComments'].includes(key)) continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit, [...ancestors, node]);
    else if (value && typeof value === 'object') walk(value, visit, [...ancestors, node]);
  }
}
export const slice = (code: string, node: Ast) => code.slice(node.start, node.end);
export const isFunction = (n: Ast) => n && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod'].includes(n.type);
export function applyEdits(code: string, edits: Edit[]): string {
  for (const e of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) code = code.slice(0, e.start) + e.text + code.slice(e.end);
  return code;
}
export function importOffset(ast: Ast): number {
  return Math.max(0, ...ast.program.directives.map((n: Ast) => n.end), ...ast.program.body.filter((n: Ast) => n.type === 'ImportDeclaration').map((n: Ast) => n.end));
}
export function uniqueName(code: string, base: string): string {
  let name = base, index = 1;
  while (new RegExp(`\\b${name}\\b`).test(code)) name = `${base}${index++}`;
  return name;
}
export function unwrap(node: Ast): Ast {
  while (node && ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression'].includes(node.type)) node = node.expression;
  return node;
}
export function objectConfig(ast: Ast): Ast | undefined {
  const decl = ast.program.body.find((n: Ast) => n.type === 'ExportDefaultDeclaration')?.declaration;
  let value = unwrap(decl);
  if (value?.type === 'CallExpression' && value.arguments.length === 1) value = unwrap(value.arguments[0]);
  return value?.type === 'ObjectExpression' ? value : undefined;
}
export const loadingName = (s: string) => /^(?:is)?(?:loading|pending|fetching|initialloading)$|(?:Loading|Pending|Fetching)$/.test(s) || /^(?:isLoading|isPending|isFetching)$/.test(s);
export function pureCondition(code: string): boolean {
  try {
    let unsafe = false;
    walk(parseExpression(code, { plugins: ['typescript'] }), node => {
      if (['CallExpression', 'OptionalCallExpression', 'AssignmentExpression', 'UpdateExpression', 'AwaitExpression', 'NewExpression'].includes(node.type)) unsafe = true;
    });
    return !unsafe;
  } catch { return false; }
}
export function pendingCondition(code: string, flags: Set<string> = new Set()): boolean {
  try {
    let seen = false, unsafe = false;
    walk(parseExpression(code, { plugins: ['typescript'] }), node => {
      if (node.type === 'Identifier' && (loadingName(node.name) || flags.has(node.name))) seen = true;
      if (['CallExpression', 'OptionalCallExpression', 'AssignmentExpression', 'UpdateExpression', 'AwaitExpression', 'NewExpression'].includes(node.type)) unsafe = true;
    });
    return seen && !unsafe;
  } catch { return false; }
}
export function isLoader(node: Ast, code: string): boolean {
  // Recognize existing localized applications while keeping generated messages in English.
  if (!node) return false;
  if (node.type === 'NullLiteral' || node.type === 'BooleanLiteral' && !node.value) return true;
  if (!['JSXElement', 'JSXFragment'].includes(node.type)) return false;
  let result = false;
  walk(node, n => {
    if (n.type === 'JSXOpeningElement' && /(?:loader|loading|spinner|skeleton|progress)/i.test(n.name.name ?? n.name.property?.name ?? '')) result = true;
    if (n.type === 'JSXText' && /loading|加载|请稍候/i.test(n.value)) result = true;
    if (n.type === 'JSXAttribute' && n.name.name === 'role' && ['progressbar', 'status'].includes(n.value?.value)) result = true;
  });
  return result || /\bloading\b/i.test(slice(code, node)) && node.children?.length === 0;
}
