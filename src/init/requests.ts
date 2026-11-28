import type * as t from '@babel/types';
import { parse as parseSFC } from '@vue/compiler-sfc';
import { parse as parseDOM } from '@vue/compiler-dom';
import { isRenderFunction, nodeName, startOf, endOf, walk } from '../compiler/ast.js';
import { applyEdits, importOffset, uniqueName, type Edit } from './ast.js';
import { resolveSource } from './scan.js';

interface Source { file: string; code: string; ast: t.File; vue: boolean }
interface Recipe { file: string; exported: string; field: string; key: string; edits: Edit[] }
const member = (node: t.Node | null | undefined): string | undefined => node?.type === 'Identifier' ? node.name : node?.type === 'MemberExpression' && !node.computed ? [member(node.object), nodeName(node.property)].filter(Boolean).join('.') : undefined;

/** Instrument only a source-proved returned request operation: an awaited input
 * API writes a reactive collection exposed via toRefs. No network interception,
 * name heuristics, application execution or inferred promise ownership. */
export async function requestStateChanges(root: string, sources: Source[], aliases: Record<string, string>): Promise<Map<string, string>> {
  const recipes: Recipe[] = [];
  for (const source of sources) {
    if (source.vue || source.code.includes('/* skelcast:request-state */')) continue;
    const vueImports = new Map<string, string>();
    for (const statement of source.ast.program.body) if (statement.type === 'ImportDeclaration' && statement.source.value === 'vue') for (const specifier of statement.specifiers) if (specifier.type === 'ImportSpecifier') vueImports.set(specifier.local.name, nodeName(specifier.imported)!);
    if (!vueImports.size) continue;
    let reserved = source.code;
    for (const statement of source.ast.program.body) {
      if (statement.type !== 'ExportNamedDeclaration' || statement.declaration?.type !== 'VariableDeclaration') continue;
      for (const declaration of statement.declaration.declarations) {
        const fn = declaration.init;
        if (declaration.id.type !== 'Identifier' || !isRenderFunction(fn) || fn.async || fn.returnType || fn.body.type !== 'BlockStatement' || fn.params[0]?.type !== 'Identifier') continue;
        const returned = fn.body.body.at(-1);
        if (returned?.type !== 'ReturnStatement' || returned.argument?.type !== 'ObjectExpression') continue;
        const returnedObject = returned.argument;
        const api = fn.params[0].name;
        const candidates: { operation: t.ArrowFunctionExpression | t.FunctionExpression; field: string }[] = [];
        for (const item of fn.body.body) if (item.type === 'VariableDeclaration') for (const d of item.declarations) {
          const operation = d.init;
          if (d.id.type !== 'Identifier' || !isRenderFunction(operation) || !operation.async || operation.body.type !== 'BlockStatement') continue;
          const operationName = d.id.name;
          if (!returnedObject.properties.some(p => p.type === 'ObjectProperty' && p.value.type === 'Identifier' && p.value.name === operationName)) continue;
          const responses = new Set<string>(); let awaited = 0;
          walk(operation.body, n => {
            if (n.type === 'VariableDeclarator' && n.init?.type === 'AwaitExpression' && n.init.argument.type === 'CallExpression' && member(n.init.argument.callee) === api) {
              awaited++;
              if (n.id.type === 'Identifier') responses.add(n.id.name);
              if (n.id.type === 'ObjectPattern') for (const p of n.id.properties) if (p.type === 'ObjectProperty' && p.value.type === 'Identifier') responses.add(p.value.name);
            }
          });
          if (awaited !== 1 || !responses.size) continue;
          const fields = new Set<string>();
          walk(operation.body, n => {
            if (n.type !== 'AssignmentExpression' || n.operator !== '=') return;
            const target = member(n.left); if (!target || target.split('.').length !== 2) return;
            let owns = false; walk(n.right, value => { if (value.type === 'Identifier' && responses.has(value.name)) owns = true; });
            if (!owns) return;
            const [state, field] = target.split('.');
            const stateDeclaration = fn.body.type === 'BlockStatement' && fn.body.body.flatMap(s => s.type === 'VariableDeclaration' ? s.declarations : []).find(d => nodeName(d.id) === state);
            const init = stateDeclaration ? stateDeclaration.init : undefined;
            if (init?.type !== 'CallExpression' || init.callee.type !== 'Identifier' || vueImports.get(init.callee.name) !== 'reactive' || init.arguments[0]?.type !== 'ObjectExpression') return;
            if (!init.arguments[0].properties.some(p => p.type === 'ObjectProperty' && nodeName(p.key) === field && p.value.type === 'ArrayExpression')) return;
            const exposed = returnedObject.properties.some(p => p.type === 'SpreadElement' && p.argument.type === 'CallExpression' && p.argument.callee.type === 'Identifier' && vueImports.get(p.argument.callee.name) === 'toRefs' && member(p.argument.arguments[0]) === state);
            if (exposed) fields.add(field);
          });
          if (fields.size === 1) candidates.push({ operation, field: [...fields][0] });
        }
        if (candidates.length !== 1) continue;
        const { operation, field } = candidates[0];
        const key = uniqueName(reserved, '__skelcastPending');
        const count = uniqueName(reserved, '__skelcastRequests');
        const ref = uniqueName(reserved, '__skelcastRef');
        reserved += ` ${key} ${count} ${ref}`;
        recipes.push({ file: source.file, exported: declaration.id.name, field, key, edits: [
          { start: importOffset(source.ast), end: importOffset(source.ast), text: `\nimport { ref as ${ref} } from 'vue';\n` },
          { start: startOf(fn.body) + 1, end: startOf(fn.body) + 1, text: `\n/* skelcast:request-state */ const ${key} = ${ref}(false); let ${count} = 0;\n` },
          { start: startOf(operation.body) + 1, end: startOf(operation.body) + 1, text: `\n${count}++; ${key}.value = true; try {\n` },
          { start: endOf(operation.body) - 1, end: endOf(operation.body) - 1, text: `\n} finally { ${key}.value = --${count} > 0; }\n` },
          { start: startOf(returned.argument) + 1, end: startOf(returned.argument) + 1, text: `\n${key},\n` },
        ] });
      }
    }
  }
  const changes = new Map<string, string>();
  const used = new Set<Recipe>();
  for (const source of sources) {
    if (!source.vue) continue;
    const sfc = parseSFC(source.code).descriptor;
    if (!sfc.scriptSetup || !sfc.template || sfc.script) continue;
    const edits: Edit[] = [];
    let reserved = source.code;
    for (const statement of source.ast.program.body) if (statement.type === 'VariableDeclaration') for (const d of statement.declarations) {
      if (d.id.type !== 'ObjectPattern' || d.init?.type !== 'CallExpression' || d.init.callee.type !== 'Identifier') continue;
      const callee = d.init.callee.name;
      const imported = source.ast.program.body.flatMap(s => s.type === 'ImportDeclaration' ? s.specifiers.map(spec => ({ statement: s, spec })) : []).find(p => p.spec.type === 'ImportSpecifier' && p.spec.local.name === callee);
      if (!imported || imported.spec.type !== 'ImportSpecifier') continue;
      const file = await resolveSource(root, source.file, imported.statement.source.value, aliases);
      const recipe = recipes.find(r => r.file === file && r.exported === nodeName(imported.spec.type === 'ImportSpecifier' ? imported.spec.imported : undefined));
      if (!recipe) continue;
      const data = d.id.properties.find(p => p.type === 'ObjectProperty' && nodeName(p.key) === recipe.field);
      if (data?.type !== 'ObjectProperty' || data.value.type !== 'Identifier') continue;
      const dependents = new Set([data.value.name]);
      for (let pass = 0; pass < 8; pass++) for (const item of source.ast.program.body) if (item.type === 'VariableDeclaration') for (const declaration of item.declarations) {
        if (declaration.id.type !== 'Identifier' || !declaration.init) continue;
        let depends = false; walk(declaration.init, n => { if (n.type === 'Identifier' && dependents.has(n.name)) depends = true; });
        if (depends) dependents.add(declaration.id.name);
      }
      const pending = uniqueName(reserved, '__skelcastPending');
      let connected = false;
      const template = parseDOM(sfc.template.content);
      const visit = (node: typeof template | import('@vue/compiler-dom').TemplateChildNode) => {
        if (node.type === 1) {
          const data = node.props.find(p => p.type === 7 && p.name === 'bind' && p.arg?.type === 4 && p.arg.content === 'data');
          if (data?.type === 7 && data.exp?.type === 4 && dependents.has(data.exp.content) && !node.props.some(p => p.type === 7 && p.name === 'loading')) {
            const offset = sfc.template!.loc.start.offset + node.loc.start.offset + 1 + node.tag.length;
            edits.push({ start: offset, end: offset, text: ` v-loading="${pending}"` }); connected = true;
          }
          node.children.forEach(visit);
        }
        if (node.type === 0) node.children.forEach(visit);
      };
      visit(template);
      if (connected) {
        reserved += ` ${pending}`;
        const offset = sfc.scriptSetup.loc.start.offset + startOf(d.id) + 1;
        edits.push({ start: offset, end: offset, text: `${recipe.key}: ${pending}, ` }); used.add(recipe);
      }
    }
    if (edits.length) changes.set(source.file, applyEdits(source.code, edits));
  }
  for (const file of new Set([...used].map(recipe => recipe.file))) {
    const source = sources.find(s => s.file === file)!;
    changes.set(file, applyEdits(source.code, [...used].filter(recipe => recipe.file === file).flatMap(recipe => recipe.edits)));
  }
  return changes;
}
