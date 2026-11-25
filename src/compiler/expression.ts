import { parseExpression } from '@babel/parser';

export const UNKNOWN = Symbol('unknown');
export type Value = unknown;
export type Ast = any;
export interface ExpressionContext {
  code: string;
  env: Record<string, Value>;
  bindings: Record<string, Value>;
  defaultBranches?: boolean;
  unwrapRefs?: boolean;
  /** Shared work limit for nested bounded collection operations. */
  budget?: { remaining: number };
}
export const expressionText = (node: Ast, ctx: ExpressionContext): string =>
  node?.start != null && node?.end != null ? ctx.code.slice(node.start, node.end) : '';
const denied = new Set(['__proto__', 'prototype', 'constructor']);
export const safeKey = (key: unknown): key is string => typeof key === 'string' && !denied.has(key);
function inferredObject(name: string, ctx: ExpressionContext): Value {
  const result: Record<string, unknown> = Object.create(null);
  let found = false;
  for (const [key, value] of Object.entries(ctx.bindings)) {
    if (!key.startsWith(`${name}.`) || !/^[\w$]+(?:\.[\w$]+)+$/.test(key)) continue;
    const parts = key.slice(name.length + 1).split('.');
    if (!parts.every(safeKey)) continue;
    let object = result;
    for (let i = 0; i < parts.length - 1; i++) {
      const previous = object[parts[i]];
      if (!previous || typeof previous !== 'object') object[parts[i]] = Object.create(null);
      object = object[parts[i]] as Record<string, unknown>;
    }
    object[parts.at(-1)!] = value; found = true;
  }
  return found ? result : UNKNOWN;
}

// This is an abstract, bounded interpreter. No eval, Function, imports or business calls.
export function evaluate(node: Ast, ctx: ExpressionContext, depth = 0): Value {
  if (!ctx.budget) ctx = { ...ctx, budget: { remaining: 10000 } };
  if (--ctx.budget!.remaining < 0) return UNKNOWN;
  if (!node || depth > 40) return UNKNOWN;
  const text = expressionText(node, ctx);
  if (Object.hasOwn(ctx.bindings, text)) return ctx.bindings[text];
  const ev = (n: Ast) => evaluate(n, ctx, depth + 1);
  switch (node.type) {
    case 'TSAsExpression': case 'TSTypeAssertion': case 'TSNonNullExpression': case 'ParenthesizedExpression': return ev(node.expression);
    case 'StringLiteral': case 'NumericLiteral': case 'BooleanLiteral': return node.value;
    case 'NullLiteral': return null;
    case 'Identifier': {
      if (node.name === 'undefined' && !Object.hasOwn(ctx.env, node.name)) return undefined;
      const value = Object.hasOwn(ctx.env, node.name) ? ctx.env[node.name] : UNKNOWN;
      return value === UNKNOWN ? inferredObject(node.name, ctx) : value;
    }
    case 'ArrayExpression': return node.elements.map((n: Ast) => n ? ev(n) : UNKNOWN);
    case 'ObjectExpression': {
      const result: Record<string, Value> = Object.create(null);
      for (const p of node.properties) {
        if (p.type === 'SpreadElement') {
          const v = ev(p.argument);
          if (v && v !== UNKNOWN && typeof v === 'object') for (const k of Object.keys(v)) if (safeKey(k)) result[k] = (v as any)[k];
        } else if (p.type === 'ObjectProperty') {
          const key = p.computed ? ev(p.key) : p.key.name ?? p.key.value;
          if (safeKey(String(key))) result[String(key)] = ev(p.value);
        }
      }
      return result;
    }
    case 'MemberExpression': case 'OptionalMemberExpression': {
      const obj = ev(node.object);
      const key = node.computed ? ev(node.property) : node.property.name;
      if (key === UNKNOWN || !safeKey(String(key))) return UNKNOWN;
      if (node.property.name === 'value' && obj !== UNKNOWN && (obj === null || typeof obj !== 'object')) return obj;
      if (ctx.unwrapRefs && node.property.name === 'value' && obj !== UNKNOWN && obj != null && !Object.hasOwn(Object(obj), 'value')) return obj;
      if (obj === UNKNOWN || obj == null) return UNKNOWN;
      if (node.object.type === 'Identifier' && node.object.name === '$slots') return Object.hasOwn(obj, key as any) ? (obj as any)[key as any] : undefined;
      return Object.hasOwn(Object(obj), key as any) ? (obj as any)[key as any] : UNKNOWN;
    }
    case 'TemplateLiteral': {
      const values = node.expressions.map(ev);
      if (values.includes(UNKNOWN)) return UNKNOWN;
      return node.quasis.map((q: Ast, i: number) => q.value.cooked + (i < values.length ? String(values[i]) : '')).join('');
    }
    case 'ConditionalExpression': {
      const test = ev(node.test);
      return test === UNKNOWN ? ctx.defaultBranches ? ev(node.consequent) : UNKNOWN : ev(test ? node.consequent : node.alternate);
    }
    case 'LogicalExpression': {
      const a = ev(node.left);
      if (a === UNKNOWN) return UNKNOWN;
      if (node.operator === '&&') return a ? ev(node.right) : a;
      if (node.operator === '||') return a ? a : ev(node.right);
      return a == null ? ev(node.right) : a;
    }
    case 'UnaryExpression': {
      const a = ev(node.argument);
      if (a === UNKNOWN) return UNKNOWN;
      if (node.operator === '!') return !a;
      if (node.operator === 'typeof') return typeof a;
      if (node.operator === '-') return typeof a === 'number' ? -a : UNKNOWN;
      if (node.operator === '+') return typeof a === 'number' ? a : UNKNOWN;
      return UNKNOWN;
    }
    case 'BinaryExpression': {
      const a = ev(node.left), b = ev(node.right);
      if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
      switch (node.operator) {
        case '===': return a === b;
        case '!==': return a !== b;
        case '==': case '!=': {
          // Objects may contain business coercion hooks. Only compare primitives;
          // never invoke valueOf/toString while interpreting application source.
          const primitive = (value: unknown): value is string | number | boolean | bigint | symbol | null | undefined => value === null || !['object', 'function'].includes(typeof value);
          if (!primitive(a) || !primitive(b)) return UNKNOWN;
          const equal = a == b;
          return node.operator === '==' ? equal : !equal;
        }
        case '+': {
          if (typeof a === 'number' && typeof b === 'number') return a + b;
          const primitive = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
          return (typeof a === 'string' || typeof b === 'string') && primitive(a) && primitive(b) ? String(a) + String(b) : UNKNOWN;
        }
        case '-': return typeof a === 'number' && typeof b === 'number' ? a - b : UNKNOWN;
        case '*': return typeof a === 'number' && typeof b === 'number' ? a * b : UNKNOWN;
        case '/': return typeof a === 'number' && typeof b === 'number' && b !== 0 ? a / b : UNKNOWN;
        case '>': return (a as any) > (b as any); case '<': return (a as any) < (b as any);
        case '>=': return (a as any) >= (b as any); case '<=': return (a as any) <= (b as any);
      }
      return UNKNOWN;
    }
    case 'CallExpression': {
      const name = node.callee.name;
      if (node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.name === 'trim' && !node.arguments.length) {
        const value = ev(node.callee.object);
        return typeof value === 'string' ? value.trim() : UNKNOWN;
      }
      if (node.callee.type === 'MemberExpression' && node.callee.object.name === 'Object' && !node.callee.computed && ['keys', 'entries', 'values'].includes(node.callee.property.name) && !Object.hasOwn(ctx.env, 'Object') && !Object.hasOwn(ctx.bindings, 'Object')) {
        const value = ev(node.arguments[0]);
        return value && value !== UNKNOWN && typeof value === 'object' ? node.callee.property.name === 'entries' ? Object.entries(value) : node.callee.property.name === 'values' ? Object.values(value) : Object.keys(value) : UNKNOWN;
      }
      if (node.callee.type === 'MemberExpression' && !node.callee.computed && ['map', 'find'].includes(node.callee.property.name)) {
        const list = ev(node.callee.object), fn = node.arguments[0];
        if (!Array.isArray(list) || list.length > 256 || fn?.type !== 'ArrowFunctionExpression' || fn.async || node.arguments.length !== 1) return UNKNOWN;
        const result = [];
        for (let index = 0; index < list.length; index++) {
          const value = arrowValue(fn, [list[index], index, list], ctx, depth + 1);
          if (node.callee.property.name === 'find') {
            if (value === UNKNOWN) return UNKNOWN;
            if (value) return list[index];
          } else result.push(value);
          if (ctx.budget!.remaining < 0) return UNKNOWN;
        }
        return node.callee.property.name === 'find' ? undefined : result;
      }
      // Recognize source-level wrappers; never invoke the actual implementation.
      if (['ref', 'shallowRef', 'reactive', 'readonly'].includes(name)) return node.arguments.length ? ev(node.arguments[0]) : ['ref', 'shallowRef'].includes(name) ? undefined : UNKNOWN;
      if (name === 'useVModel') {
        const props = ev(node.arguments[0]), key = node.arguments[1] ? ev(node.arguments[1]) : 'modelValue';
        return props && props !== UNKNOWN && typeof props === 'object' && safeKey(key) && Object.hasOwn(props, key) ? (props as any)[key] : UNKNOWN;
      }
      if (['computed', 'useMemo'].includes(name)) {
        const fn = node.arguments[0];
        if (fn?.type === 'ArrowFunctionExpression' && !fn.async) return arrowValue(fn, [], ctx, depth + 1);
      }
      return UNKNOWN;
    }
  }
  return UNKNOWN;
}

function arrowValue(fn: Ast, args: Value[], ctx: ExpressionContext, depth: number): Value {
  if (depth > 40) return UNKNOWN;
  const local = { ...ctx, env: { ...ctx.env } };
  fn.params.forEach((param: Ast, index: number) => bindPattern(param, args[index], local.env));
  const ev = (node: Ast) => evaluate(node, local, depth + 1);
  if (fn.body.type !== 'BlockStatement') return ev(fn.body);
  const statements = (body: Ast[]): { value: Value } | undefined => {
    for (const statement of body) {
      if (--local.budget!.remaining < 0) return { value: UNKNOWN };
      if (statement.type === 'ReturnStatement') return { value: statement.argument ? ev(statement.argument) : undefined };
      if (statement.type === 'VariableDeclaration') {
        for (const item of statement.declarations) bindPattern(item.id, ev(item.init), local.env);
      } else if (statement.type === 'IfStatement') {
        const condition = ev(statement.test);
        if (condition === UNKNOWN) return { value: UNKNOWN };
        const branch = condition ? statement.consequent : statement.alternate;
        if (branch) {
          const result = statements(branch.type === 'BlockStatement' ? branch.body : [branch]);
          if (result) return result;
        }
      } else return { value: UNKNOWN };
    }
  };
  return statements(fn.body.body)?.value;
}

export function evaluateString(text: string, ctx: ExpressionContext): Value {
  if (Object.hasOwn(ctx.bindings, text.trim())) return ctx.bindings[text.trim()];
  try { return evaluate(parseExpression(text, { plugins: ['typescript'] }), { ...ctx, code: text }); }
  catch { return UNKNOWN; }
}

export function bindPattern(pattern: Ast, value: Value, env: Record<string, Value>): void {
  if (!pattern) return;
  if (pattern.type === 'Identifier') env[pattern.name] = value;
  else if (pattern.type === 'AssignmentPattern') bindPattern(pattern.left, value, env);
  else if (pattern.type === 'ObjectPattern') {
    for (const p of pattern.properties) if (p.type === 'ObjectProperty') {
      const key = p.key.name ?? p.key.value;
      bindPattern(p.value, value && value !== UNKNOWN && typeof value === 'object' && Object.hasOwn(value, key) ? (value as any)[key] : UNKNOWN, env);
    }
  } else if (pattern.type === 'ArrayPattern') pattern.elements.forEach((p: Ast, i: number) => bindPattern(p, Array.isArray(value) ? value[i] : UNKNOWN, env));
}
