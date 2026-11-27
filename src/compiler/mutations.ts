import type * as t from '@babel/types';
import { nodeName } from './ast.js';

const mutatingMethods = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'copyWithin', 'fill', 'set', 'add', 'delete', 'clear']);

export function rootName(node: t.Node | null | undefined): string | undefined {
  while (node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression') node = node.object;
  return node?.type === 'Identifier' ? node.name : undefined;
}

/** Shared syntax recognition; callers retain their own escape and scope rules. */
export function mutationTarget(node: t.Node): t.Node | undefined {
  if (node.type === 'AssignmentExpression') return node.left;
  if (node.type === 'UpdateExpression' || node.type === 'UnaryExpression' && node.operator === 'delete') return node.argument;
  if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && mutatingMethods.has(nodeName(node.callee.property) ?? '')) return node.callee.object;
}

/** An alias and its source refer to the same potentially mutated object. */
export function propagateAliases(affected: Set<string>, aliases: readonly (readonly [string, string])[]): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [alias, source] of aliases) {
      if (affected.has(alias) === affected.has(source)) continue;
      affected.add(alias); affected.add(source); changed = true;
    }
  }
}
