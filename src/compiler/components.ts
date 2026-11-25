import { parse } from '@babel/parser';
import { nodeName, walk } from './ast.js';

export const componentName = (name: string) => name.replace(/[-_:]/g, '').toLowerCase();

/** Only reads GlobalComponents type members. No application modules are imported. */
export function declarationComponents(code: string): { name: string; request: string; exported: string }[] {
  const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
  const result: { name: string; request: string; exported: string }[] = [];
  walk(ast.program, node => {
    if (node.type === 'TSInterfaceDeclaration' && node.id.name === 'GlobalComponents') {
      for (const member of node.body.body) {
        if (member.type !== 'TSPropertySignature' || member.computed) continue;
        const type = member.typeAnnotation?.typeAnnotation;
        if (type?.type !== 'TSIndexedAccessType') continue;
        const query = type.objectType;
        const imported = query.type === 'TSTypeQuery' ? query.exprName : query;
        const request = imported.type === 'TSImportType' ? imported.argument.value : undefined;
        const exported = type.indexType.type === 'TSLiteralType' && type.indexType.literal.type === 'StringLiteral' ? type.indexType.literal.value : undefined;
        const name = nodeName(member.key);
        if (typeof name === 'string' && typeof request === 'string' && typeof exported === 'string') result.push({ name, request, exported });
      }
      return false;
    }
  });
  return result;
}
