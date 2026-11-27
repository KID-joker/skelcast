import { VISITOR_KEYS } from '@babel/types';
import { parse } from '@babel/parser';
import type * as t from '@babel/types';

export type Ast = t.Node;
export type RenderFunction = t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression;

/** Plain TypeScript permits angle assertions; TSX interprets them as JSX. */
export function parseSource(code: string, filename = '', jsx = !/\.(?:[cm]?ts|vue)$/.test(filename)) {
  return parse(code, { sourceType: 'module', plugins: [...(jsx ? ['jsx' as const] : []), 'typescript'] });
}

export function unwrapExpression(node: t.Node | null | undefined): t.Node | undefined {
  while (node && ['TSAsExpression', 'TSTypeAssertion', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression'].includes(node.type) && 'expression' in node) node = node.expression as t.Node;
  return node ?? undefined;
}

export function nodeName(node?: t.Node | null): string | undefined {
  if (!node) return;
  switch (node.type) {
    case 'Identifier': case 'JSXIdentifier': return node.name;
    case 'StringLiteral': return node.value;
    case 'NumericLiteral': return String(node.value);
    case 'JSXMemberExpression': return `${nodeName(node.object)}.${nodeName(node.property)}`;
  }
}

export function patternNames(node: t.Node): string[] {
  switch (node.type) {
    case 'Identifier': return [node.name];
    case 'AssignmentPattern': return patternNames(node.left);
    case 'RestElement': return patternNames(node.argument);
    case 'ObjectPattern': return node.properties.flatMap(property => patternNames(property.type === 'RestElement' ? property.argument : property.value));
    case 'ArrayPattern': return node.elements.flatMap(element => element ? patternNames(element) : []);
    default: return [];
  }
}

export function startOf(node: t.Node): number {
  if (node.start == null) throw new Error(`Missing source start for ${node.type}`);
  return node.start;
}

export function endOf(node: t.Node): number {
  if (node.end == null) throw new Error(`Missing source end for ${node.type}`);
  return node.end;
}

function isNode(value: unknown): value is t.Node {
  return !!value && typeof value === 'object' && 'type' in value && typeof value.type === 'string' && Object.hasOwn(VISITOR_KEYS, value.type);
}

/** Traverse parser nodes only; positions and comments are never treated as syntax. */
export function walk(node: t.Node | null | undefined, visitor: (node: t.Node, ancestors: t.Node[]) => boolean | void, ancestors: t.Node[] = []): void {
  if (!node || visitor(node, ancestors) === false) return;
  for (const key of VISITOR_KEYS[node.type] ?? []) {
    const child: unknown = Reflect.get(node, key);
    if (Array.isArray(child)) {
      for (const item of child) if (isNode(item)) walk(item, visitor, [...ancestors, node]);
    } else if (isNode(child)) walk(child, visitor, [...ancestors, node]);
  }
}

export function isRenderFunction(node?: t.Node | null): node is RenderFunction {
  return node?.type === 'FunctionDeclaration' || node?.type === 'FunctionExpression' || node?.type === 'ArrowFunctionExpression';
}
