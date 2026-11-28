import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { nodeName, parseSource, startOf, endOf } from '../compiler/ast.js';
import type { InitChange } from './types.js';

export async function integrateTypeResolution(root: string): Promise<InitChange[]> {
  const result: InitChange[] = [];
  for (const file of ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json']) {
    let code: string;
    try { code = await readFile(path.join(root, file), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const prefix = 'export default (';
    const ast = parseSource(prefix + code + ');');
    const declaration = ast.program.body[0];
    if (declaration.type !== 'ExportDefaultDeclaration' || declaration.declaration.type !== 'ObjectExpression') continue;
    const options = declaration.declaration.properties.find(p => p.type === 'ObjectProperty' && nodeName(p.key) === 'compilerOptions');
    if (options?.type !== 'ObjectProperty' || options.value.type !== 'ObjectExpression') continue;
    const property = (key: string) => options.value.type === 'ObjectExpression' ? options.value.properties.find(p => p.type === 'ObjectProperty' && nodeName(p.key) === key) : undefined;
    const module = property('module'), resolution = property('moduleResolution');
    if (module?.type !== 'ObjectProperty' || module.value.type !== 'StringLiteral' || !/^(esnext|es\d+|preserve)$/i.test(module.value.value)) continue;
    if (resolution?.type !== 'ObjectProperty' || resolution.value.type !== 'StringLiteral' || !/^(node|node10|classic)$/i.test(resolution.value.value)) continue;
    const value = resolution.value;
    const after = code.slice(0, startOf(value) - prefix.length) + '"Bundler"' + code.slice(endOf(value) - prefix.length);
    result.push({ file, before: code, after, reason: 'Resolve package exports and virtual module types with Vite-compatible TypeScript resolution' });
  }
  return result;
}
