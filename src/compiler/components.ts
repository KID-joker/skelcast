import { parse } from '@babel/parser';

export const componentName = (name: string) => name.replace(/[-_:]/g, '').toLowerCase();

/** Only reads GlobalComponents type members. No application modules are imported. */
export function declarationComponents(code: string): { name: string; request: string; exported: string }[] {
  const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
  const result: { name: string; request: string; exported: string }[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'TSInterfaceDeclaration' && node.id.name === 'GlobalComponents') {
      for (const member of node.body.body) {
        if (member.type !== 'TSPropertySignature' || member.computed) continue;
        const type = member.typeAnnotation?.typeAnnotation;
        if (type?.type !== 'TSIndexedAccessType') continue;
        const query = type.objectType;
        const imported = query.type === 'TSTypeQuery' ? query.exprName : query;
        const request = imported.type === 'TSImportType' ? imported.argument.value : undefined;
        const exported = type.indexType.type === 'TSLiteralType' ? type.indexType.literal.value : undefined;
        const name = member.key.name ?? member.key.value;
        if (typeof name === 'string' && typeof request === 'string' && typeof exported === 'string') result.push({ name, request, exported });
      }
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (['loc', 'comments', 'tokens'].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(walk); else walk(child);
    }
  };
  walk(ast.program);
  return result;
}
