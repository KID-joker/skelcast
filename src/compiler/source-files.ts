import { readFile, realpath } from 'node:fs/promises';
import { parse as parseSFC } from '@vue/compiler-sfc';
import { parseSource } from './ast.js';
import { digest } from './styles.js';

/** Immutable source data shared by scans and variants within one compilation.
 * Evaluated module environments and generated styles remain compiler-local. */
export class SourceFiles {
  private files = new Map<string, Promise<{ file: string; bytes: Buffer; hash: string }>>();
  private scripts = new Map<string, { code: string; sfc?: ReturnType<typeof parseSFC> }>();
  private asts = new Map<string, ReturnType<typeof parseSource>>();

  read(file: string) {
    let result = this.files.get(file);
    if (!result) {
      result = (async () => {
        const resolved = await realpath(file);
        const bytes = await readFile(resolved);
        return { file: resolved, bytes, hash: digest(bytes) };
      })();
      this.files.set(file, result);
    }
    return result;
  }

  script(file: string, raw: string) {
    let result = this.scripts.get(file);
    if (!result) {
      const sfc = file.endsWith('.vue') ? parseSFC(raw, { filename: file }) : undefined;
      let code = raw;
      if (sfc) {
        // Retain original SFC offsets for diagnostics and source-node identities.
        code = raw.replace(/[^\r\n]/g, ' ');
        for (const script of [sfc.descriptor.script, sfc.descriptor.scriptSetup]) if (script) {
          code = code.slice(0, script.loc.start.offset) + script.content + code.slice(script.loc.end.offset);
        }
      }
      result = { code, sfc };
      this.scripts.set(file, result);
    }
    return result;
  }

  ast(file: string, code: string, jsx = !/\.(?:[cm]?ts|vue)$/.test(file)) {
    const key = JSON.stringify([file, jsx]);
    let ast = this.asts.get(key);
    if (!ast) {
      ast = parseSource(code, file, jsx);
      this.asts.set(key, ast);
    }
    return ast;
  }
}
