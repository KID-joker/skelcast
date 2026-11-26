import path from 'node:path';
import { createRequire } from 'node:module';

export interface StyleSource {
  root: string;
  aliases: Record<string, string>;
  read(file: string): Promise<string>;
}

/** Resolve stylesheet data only. Resolving a package entry never imports it. */
export async function resolveStylesheet(request: string, from: string, io: StyleSource, sass = false, fromImport = false): Promise<string> {
  if (/^[a-z][\w+.-]*:|^\/\//i.test(request)) throw new Error(`Remote stylesheet imports are not supported: ${request}`);
  const alias = Object.keys(io.aliases).sort((a,b)=>b.length-a.length).find(key=>request===key||request.startsWith(`${key}/`));
  const bases = alias ? [path.resolve(io.root, io.aliases[alias], `.${request.slice(alias.length)}`)] : [path.resolve(path.dirname(from), request)];
  if (!alias && !request.startsWith('.') && !path.isAbsolute(request)) {
    for (const require of [createRequire(from), createRequire(path.join(io.root, '__styles.cjs')), createRequire(import.meta.url)]) {
      for (const id of [request, `${request}/index.css`, `${request}/index.scss`]) {
        try { const file = require.resolve(id); if (/\.(?:css|scss|sass)$/.test(file)) bases.push(file); } catch { /* Try the next static stylesheet entry. */ }
      }
    }
    bases.push(path.join(io.root, 'node_modules', request));
  }
  const probe = async (files: string[]) => {
    const found: string[] = [];
    for (const file of [...new Set(files)]) try { await io.read(file); found.push(file); }
    catch (error) { if (!['ENOENT','ENOTDIR','EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    if (found.length > 1) throw new Error(`Ambiguous stylesheet ${request}: ${found.join(', ')}`);
    return found[0];
  };
  for (const base of [...new Set(bases)]) {
    if (!sass) { const found = await probe([base]); if (found) return found; continue; }
    const ext = path.extname(base), dir = path.dirname(base), name = path.basename(base);
    const partial = path.join(dir, `_${name}`);
    if (fromImport) {
      const importOnly = ext ? [base.replace(/\.(scss|sass)$/, '.import.$1'), partial.replace(/\.(scss|sass)$/, '.import.$1')] : [base+'.import.scss', partial+'.import.scss', base+'.import.sass', partial+'.import.sass'];
      const found = await probe(importOnly.filter(file=>file!==base&&file!==partial));
      if (found) return found;
    }
    const files = /\.(?:scss|sass|css)$/.test(ext) ? [base,partial] : ['.scss','.sass','.css'].flatMap(suffix=>[base+suffix,partial+suffix]);
    const found = await probe(files);
    if (found) return found;
    if (!ext) {
      const index = await probe(['.scss','.sass','.css'].flatMap(suffix=>[path.join(base,'index'+suffix),path.join(base,'_index'+suffix)]));
      if (index) return index;
    }
  }
  throw new Error(`Cannot resolve stylesheet ${request} from ${from}`);
}
