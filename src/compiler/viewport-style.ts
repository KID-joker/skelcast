import { isRenderFunction, nodeName, unwrapExpression, walk } from './ast.js';
import { evaluate, evaluateString, UNKNOWN, type Value } from './expression.js';
import type { RenderContext, ModuleInfo } from './context.js';
import { bindSetupDeclarations } from './instance-values.js';
import { styleString, unknownGeometry } from './html.js';
import { initializeLayout } from './layout-effects.js';

interface Frame { min: number; max?: number; values: Record<string, Value> }
/** Translate finite viewport comparisons into CSS; event handlers never run. */
function frames(mod: ModuleInfo): Frame[] {
  const functions = mod.functions;
  for (const [name, fn] of functions) {
    if (!isRenderFunction(fn) || fn.params.length !== 1 || fn.body.type !== 'BlockStatement') continue;
    let registered = false;
    walk(mod.ast, n => {
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.object.type === 'Identifier' && n.callee.object.name === 'window' && nodeName(n.callee.property) === 'addEventListener' && n.arguments[0]?.type === 'StringLiteral' && n.arguments[0].value === 'resize' && nodeName(n.arguments[1]) === name) registered = true;
    });
    if (!registered) continue;
    const widths = new Set<string>();
    for (const statement of fn.body.body) if (statement.type === 'VariableDeclaration') for (const d of statement.declarations) {
      const init = unwrapExpression(d.init);
      if (d.id.type === 'Identifier' && init?.type === 'MemberExpression' && nodeName(init.property) === 'innerWidth') widths.add(d.id.name);
    }
    const branch = fn.body.body.find(s => s.type === 'SwitchStatement');
    if (branch?.type !== 'SwitchStatement' || !widths.size || branch.cases.length > 16 || fn.body.body.some(statement => statement !== branch && statement.type !== 'VariableDeclaration')) continue;
    const comparison = (node: import('@babel/types').Node): boolean => node.type === 'LogicalExpression' && ['&&','||'].includes(node.operator) ? comparison(node.left) && comparison(node.right) : node.type === 'BinaryExpression' && ['<','>='].includes(node.operator) && node.left.type === 'Identifier' && widths.has(node.left.name) && node.right.type === 'NumericLiteral';
    if (branch.cases.some(item => !item.test || !comparison(item.test) || item.consequent.at(-1)?.type !== 'BreakStatement')) continue;
    const thresholds = new Set([0]); let invalid = false;
    for (const item of branch.cases) {
      if (!item.test) { invalid = true; break; }
      walk(item.test, n => { if (n.type === 'NumericLiteral' && n.value >= 0 && n.value <= 10000) thresholds.add(n.value); });
    }
    if (invalid) continue;
    const points = [...thresholds].sort((a, b) => a - b), result: Frame[] = [];
    for (let index = 0; index < points.length; index++) {
      const min = points[index], max = points[index + 1];
      const context = { code: mod.code, env: Object.fromEntries([...widths].map(name => [name, min + (max == null ? 1 : (max - min) / 2)])), bindings: {} };
      if (evaluate(branch.discriminant, context) !== true) { invalid = true; break; }
      const item = branch.cases.find(item => item.test && evaluate(item.test, context) === true);
      if (!item) { invalid = true; break; }
      const values: Record<string, Value> = {};
      for (const statement of item.consequent) {
        if (statement.type === 'BreakStatement') continue;
        if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'AssignmentExpression' || statement.expression.operator !== '=') { invalid = true; break; }
        const assignment = statement.expression;
        if (assignment.left.type !== 'MemberExpression' || assignment.left.object.type !== 'Identifier' || nodeName(assignment.left.property) !== 'value') { invalid = true; break; }
        const value = evaluate(assignment.right, context);
        if (value === UNKNOWN || !['string', 'number', 'boolean'].includes(typeof value)) { invalid = true; break; }
        values[assignment.left.object.name] = value;
        values[assignment.left.object.name + '.value'] = value;
      }
      if (!Object.keys(values).length) invalid = true;
      result.push({ min, max, values });
    }
    const targets = new Set(result.flatMap(frame => Object.keys(frame.values).filter(key => !key.endsWith('.value'))));
    walk(mod.ast, (node, ancestors) => {
      if (ancestors.includes(fn)) return;
      if ((node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') && targets.has(nodeName(node.type === 'AssignmentExpression' ? node.left.type === 'MemberExpression' ? node.left.object : node.left : node.argument.type === 'MemberExpression' ? node.argument.object : node.argument) ?? '')) invalid = true;
    });
    if (!invalid) return result;
  }
  return [];
}
const cache = new WeakMap<ModuleInfo['imports'], Frame[]>();
function moduleFrames(ctx: RenderContext): Frame[] {
  let result = cache.get(ctx.module.imports);
  if (!result) cache.set(ctx.module.imports, result = frames(ctx.module));
  return result;
}
export function providedValues(ctx: RenderContext): Record<string, Value> {
  const result = { ...ctx.provides };
  for (const statement of ctx.module.ast.program.body) {
    if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'CallExpression') continue;
    const call = statement.expression, imported = call.callee.type === 'Identifier' ? ctx.module.imports.get(call.callee.name) : undefined;
    if (imported?.request !== 'vue' || imported.exported !== 'provide' || call.arguments.length !== 2) continue;
    const key = evaluate(call.arguments[0], ctx);
    if (typeof key === 'string') result[key] = evaluate(call.arguments[1], ctx);
  }
  return result;
}
export function providedFrames(ctx: RenderContext) {
  const own = moduleFrames(ctx);
  if (!own.length) return ctx.viewportFrames;
  return own.map(frame => {
    const local = { ...ctx, code: ctx.module.code, env: { ...ctx.env }, bindings: { ...ctx.bindings, ...frame.values } };
    bindSetupDeclarations(ctx.module, ctx.module.env, local);
    initializeLayout(local);
    return { min: frame.min, max: frame.max, provides: providedValues(local) };
  });
}
export function viewportStyle(expression: string, ctx: RenderContext): { style: string; media: { query: string; style: string }[] } | undefined {
  const own = moduleFrames(ctx);
  const variants = own.length ? own.map(frame => ({ ...frame, provides: ctx.provides })) : (ctx.viewportFrames ?? []).map(frame => ({ ...frame, values: {} }));
  if (!variants.length) return;
  const styles: { query: string; style: string }[] = [];
  for (const frame of variants) {
    const local = { ...ctx, code: ctx.module.code, env: { ...ctx.env }, provides: frame.provides, bindings: { ...ctx.bindings, ...frame.values } };
    bindSetupDeclarations(ctx.module, ctx.module.env, local);
    initializeLayout(local);
    if (local.layoutUnresolved) return;
    const value = evaluateString(expression, local);
    if (value === UNKNOWN || unknownGeometry(value)) return;
    styles.push({ query: `(min-width:${frame.min}px)${frame.max == null ? '' : ` and (max-width:${frame.max - .02}px)`}`, style: styleString(value) });
  }
  if (new Set(styles.map(s => s.style)).size < 2) return;
  return { style: styles[0].style, media: styles };
}
