import type * as t from '@babel/types';
import { isRenderFunction, nodeName, patternNames, walk, type RenderFunction } from './ast.js';
import type { Ast } from './expression.js';
import type { ModuleInfo } from './context.js';
import { mutationTarget, rootName } from './mutations.js';

/** Helper identity is established from imports, including aliases/namespaces. */
export function vueHelper(mod: ModuleInfo, callee: Ast, name: string): boolean {
  if (callee.type === 'Identifier') {
    const ref = mod.imports.get(callee.name);
    return ref?.request === 'vue' && ref.exported === name;
  }
  if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier') {
    const ref = mod.imports.get(callee.object.name);
    return ref?.request === 'vue' && ref.exported === '*' && nodeName(callee.property) === name;
  }
  return false;
}

const supportedBodies = new WeakMap<Ast, boolean>();
export function supportedBody(body: Ast): boolean {
  const previous = supportedBodies.get(body);
  if (previous !== undefined) return previous;
  const statement = (s: t.Statement): boolean => s.type === 'VariableDeclaration' || s.type === 'ReturnStatement' || s.type === 'BlockStatement' && s.body.every(statement) || s.type === 'IfStatement' && statement(s.consequent) && (!s.alternate || statement(s.alternate));
  const supported = body.type !== 'BlockStatement' || body.body.every(statement);
  supportedBodies.set(body, supported);
  return supported;
}

const visualNodes = new WeakMap<ModuleInfo['imports'], WeakMap<Ast, { jsx: boolean; h: boolean }>>();
/** Classify every subtree once, including nested helpers. Import identity remains
 * part of the cache key; no props or evaluated values are cached here. */
export function visualSyntax(mod: ModuleInfo, node: Ast): { jsx: boolean; h: boolean } {
  let cache = visualNodes.get(mod.imports);
  if (!cache) visualNodes.set(mod.imports, cache = new WeakMap());
  const previous = cache.get(node);
  if (previous) return previous;
  const result = { jsx: node.type === 'JSXElement' || node.type === 'JSXFragment', h: node.type === 'CallExpression' && vueHelper(mod, node.callee, 'h') };
  walk(node, child => {
    if (child === node) return;
    const nested = visualSyntax(mod, child);
    result.jsx ||= nested.jsx;
    result.h ||= nested.h;
    return false;
  });
  cache.set(node, result);
  return result;
}

function indexSetup(body: Ast) {
  const declarations: t.VariableDeclarator[] = [];
  const declarationByName = new Map<string, t.VariableDeclarator>();
  const localNames = new Set<string>();
  const renderBindings: { name?: string; fn: Ast | null | undefined }[] = [];
  const aliases: [string, string][] = [];
  const definitions = new Map<string, Ast | null>();
  const functions = new Map<string, RenderFunction>();
  if (body.type === 'BlockStatement') for (const statement of body.body) {
    if (statement.type === 'VariableDeclaration') for (const declaration of statement.declarations) {
      declarations.push(declaration);
      for (const name of patternNames(declaration.id)) localNames.add(name);
      const name = nodeName(declaration.id);
      renderBindings.push({ name, fn: declaration.init });
      if (declaration.id.type === 'Identifier') {
        definitions.set(declaration.id.name, declaration.init ?? null);
        if (isRenderFunction(declaration.init)) functions.set(declaration.id.name, declaration.init);
        if (!declarationByName.has(declaration.id.name)) declarationByName.set(declaration.id.name, declaration);
        if (declaration.init?.type === 'Identifier') aliases.push([declaration.id.name, declaration.init.name]);
      }
    }
    if (statement.type === 'FunctionDeclaration') {
      const name = statement.id?.name;
      if (name) {
        localNames.add(name);
        definitions.set(name, statement);
        functions.set(name, statement);
      }
      renderBindings.push({ name, fn: statement });
    }
  }
  const effects: { written?: string; call?: t.CallExpression }[] = [];
  if (body.type === 'BlockStatement') walk(body, node => {
    const written = rootName(mutationTarget(node));
    if (written || node.type === 'CallExpression') effects.push({ written, call: node.type === 'CallExpression' ? node : undefined });
  });
  return { declarations, declarationByName, localNames, renderBindings, aliases, effects, definitions, functions };
}
const setupIndexes = new WeakMap<Ast, ReturnType<typeof indexSetup>>();
/** Object-method wrappers may be recreated; their source body stays immutable. */
export function setupSyntax(body: Ast) {
  let result = setupIndexes.get(body);
  if (!result) setupIndexes.set(body, result = indexSetup(body));
  return result;
}
