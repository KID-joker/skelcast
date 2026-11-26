import path from 'node:path';

const fileExtensions = ['', '.tsx', '.jsx', '.vue', '.ts', '.js', '.mjs'];
const directoryExtensions = ['/index.tsx', '/index.jsx', '/index.vue', '/index.ts', '/index.js'];

/** Init and compilation use the same source precedence. Compilation also resolves
 * stylesheet imports and records unsuccessful candidates for invalidation. */
export function resolutionCandidates(root: string, from: string, request: string, aliases: Record<string, string>, includeStyles = false): string[] {
  let base: string;
  if (request.startsWith('.')) base = path.resolve(path.dirname(from), request.split('?')[0]);
  else {
    const alias = Object.keys(aliases).sort((a, b) => b.length - a.length).find(key => request === key || request.startsWith(`${key}/`));
    if (!alias) return [];
    base = path.resolve(root, aliases[alias], `.${request.slice(alias.length)}`.split('?')[0]);
  }
  return [...fileExtensions, ...(includeStyles ? ['.css', '.module.css'] : []), ...directoryExtensions].map(extension => base + extension);
}
