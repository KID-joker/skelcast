import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolveStylesheet, type StyleSource } from './stylesheet-source.js';

const scheme = 'skelcast-file:';
const requestScheme = 'skelcast-import:';
const canonical = (file: string) => new URL(scheme + pathToFileURL(file).href.slice(5));
const filename = (url: URL) => fileURLToPath(new URL('file:' + url.href.slice(scheme.length)));

/** Keep bare/aliased requests distinct from Sass's relative URL resolution.
 * Redirection is textual only; conditional imports are loaded only by Sass. */
function redirectImports(source: string, from: string): string {
  const edits: {start:number;end:number;text:string}[] = [];
  const directive = /@(use|forward|import)\s+/y;
  for (let i=0;i<source.length;) {
    if (source.startsWith('/*',i)) { const end=source.indexOf('*/',i+2);i=end<0?source.length:end+2;continue; }
    if (source.startsWith('//',i)) { const end=source.indexOf('\n',i+2);i=end<0?source.length:end+1;continue; }
    if (source[i]==='"'||source[i]==="'") { const quote=source[i++];while(i<source.length){if(source[i]==='\\')i+=2;else if(source[i++]===quote)break;}continue; }
    directive.lastIndex=i;
    const match=directive.exec(source);
    if(!match){i++;continue;}
    let cursor=directive.lastIndex;
    while(source[cursor]==='"'||source[cursor]==="'") {
      const start=cursor,quote=source[cursor++];
      while(cursor<source.length&&source[cursor]!==quote){if(source[cursor]==='\\')cursor++;cursor++;}
      const request=source.slice(start+1,cursor);cursor++;
      let next=cursor;while(/\s/.test(source[next]??'')&&next<source.length)next++;
      const cssImport=match[1]==='import'&&(/\.css(?:[?#]|$)/.test(request)||![';',',','}'].includes(source[next]??';'));
      if(!cssImport&&!/^(?:\.|\/|[a-z][\w+.-]*:)/i.test(request)&&!request.includes('#{')) edits.push({start,end:cursor,text:JSON.stringify(requestScheme+encodeURIComponent(JSON.stringify([from,request,match[1]==='import']))+'/'+path.posix.basename(request))});
      if(source[next]!==',')break;
      cursor=next+1;while(/\s/.test(source[cursor]??'')&&cursor<source.length)cursor++;
    }
    i=cursor;
  }
  for(const edit of edits.reverse())source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);
  return source;
}

/** A closed data importer keeps every Sass read, including missing alternatives,
 * inside dependency tracking. No application importer or custom JS function runs. */
export async function compileSass(source: string, file: string, lang: string, io: StyleSource) {
  const sass = await import('sass');
  const importer: import('sass').Importer<'async'> = {
      async canonicalize(url, context) {
        if (url.startsWith('sass:')) return null;
        if (url.startsWith(requestScheme)) {
          const [from,request,fromImport] = JSON.parse(decodeURIComponent(url.slice(requestScheme.length,url.lastIndexOf('/')))) as [string,string,boolean];
          return canonical(await resolveStylesheet(request,from,io,true,fromImport));
        }
        const from = context.containingUrl?.protocol === scheme ? filename(context.containingUrl) : file;
        const request = url.startsWith(scheme) ? filename(new URL(url)) : url;
        return canonical(await resolveStylesheet(request, from, io, true, context.fromImport));
      },
      async load(url) {
        const file = filename(url);
        return { contents: redirectImports(await io.read(file),file), syntax: path.extname(file) === '.sass' ? 'indented' : path.extname(file) === '.css' ? 'css' : 'scss', sourceMapUrl: pathToFileURL(file) };
      },
  };
  const output = await sass.compileStringAsync(redirectImports(source,file), {
    url: canonical(file), syntax: lang === 'sass' ? 'indented' : 'scss',
    sourceMap: true, sourceMapIncludeSources: true, logger: sass.Logger.silent,
    importer, importers: [importer],
  });
  return { css: output.css, map: output.sourceMap };
}
