import type * as t from '@babel/types';
import { isRenderFunction, nodeName, walk } from './ast.js';
import type { ModuleInfo } from './context.js';
import type { ComponentReference } from './presets/types.js';

type AppRegistration =
  | { kind: 'component'; name: string; reference: ComponentReference }
  | { kind: 'plugin'; reference: ComponentReference };

function appRoot(node: t.Node): string | undefined {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') return appRoot(node.callee.object);
}

/** Syntax facts only; preserve call order and require an imported createApp. */
export function appRegistrations(mod: ModuleInfo): AppRegistration[] {
  const apps = new Set<string>();
  for (const statement of mod.ast.program.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declaration of statement.declarations) {
      const init = declaration.init;
      if (declaration.id.type !== 'Identifier' || init?.type !== 'CallExpression' || init.callee.type !== 'Identifier') continue;
      const reference = mod.imports.get(init.callee.name);
      if (reference?.request === 'vue' && reference.exported === 'createApp') apps.add(declaration.id.name);
    }
  }
  const result: AppRegistration[] = [];
  walk(mod.ast, node => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed) return;
    if (!apps.has(appRoot(node.callee.object) ?? '')) return;
    const method = nodeName(node.callee.property);
    const [first, second] = node.arguments;
    if (method === 'component' && first?.type === 'StringLiteral' && second?.type === 'Identifier') {
      const reference = mod.imports.get(second.name);
      if (reference) result.push({ kind: 'component', name: first.value, reference });
    }
    if (method === 'use' && first?.type === 'Identifier') {
      const reference = mod.imports.get(first.name);
      if (reference && !reference.file) result.push({ kind: 'plugin', reference });
    }
  });
  return result;
}

interface PluginRegistration { component: string; name?: string; useComponentName: boolean }

/** Read only install callbacks attached to the selected exported definition.
 * Component identity and package eligibility are proved by the module host. */
export function pluginRegistrations(mod: ModuleInfo, exported: string): PluginRegistration[] {
  let definition = mod.functions.get(mod.exports.get(exported) ?? '');
  const seen = new Set<string>();
  while (definition?.type === 'Identifier' && !seen.has(definition.name)) {
    seen.add(definition.name);
    definition = mod.functions.get(definition.name);
  }
  if (definition?.type !== 'CallExpression' || definition.arguments[1]?.type !== 'ObjectExpression') return [];
  const result: PluginRegistration[] = [];
  for (const property of definition.arguments[1].properties) {
    if (property.type === 'SpreadElement' || nodeName(property.key) !== 'install') continue;
    const fn = property.type === 'ObjectMethod' ? property
      : isRenderFunction(property.value) ? property.value : undefined;
    const parameter = fn?.params[0];
    if (!fn || parameter?.type !== 'Identifier') continue;
    walk(fn.body, node => {
      if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
      if (node.callee.object.type !== 'Identifier' || node.callee.object.name !== parameter.name || nodeName(node.callee.property) !== 'component') return;
      const [key, value] = node.arguments;
      if (value?.type !== 'Identifier') return;
      result.push({
        component: value.name,
        name: key?.type === 'StringLiteral' ? key.value : undefined,
        useComponentName: key?.type === 'MemberExpression' && key.object.type === 'Identifier'
          && key.object.name === value.name && nodeName(key.property) === 'name',
      });
    });
  }
  return result;
}
