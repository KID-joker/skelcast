import { readFile, realpath, stat } from 'node:fs/promises';
import { parse as parseSFC } from '@vue/compiler-sfc';
import { parse as parseDOM } from '@vue/compiler-dom';
import { parseSource } from './ast.js';
import { digest } from './styles.js';
import type { Expression } from '@babel/types';

/** File bytes and syntax shared by freshness checks, scans, targets and variants within one operation.
 * Evaluated module environments and generated styles remain compiler-local. */
export class SourceFiles {
  readonly expressions = new Map<string, Expression | null>();
  private files = new Map<string, Promise<{ file: string; bytes: Buffer; hash: string }>>();
  private probes = new Map<string, Promise<boolean>>();
  private scripts = new Map<string, { code: string; sfc?: ReturnType<typeof parseSFC> }>();
  private asts = new Map<string, ReturnType<typeof parseSource>>();
  private templates = new Map<string, ReturnType<typeof parseDOM>>();
  private resolutions = new Map<string, Promise<{ file?: string; missing: string[] }>>();

  isFile(file: string) {
    let result = this.probes.get(file);
    if (!result) {
      result = stat(file).then(info => info.isFile());
      this.probes.set(file, result);
    }
    return result;
  }

  /** Share probes across scans and variants, retaining every failed candidate
   * so each compiler can record its own invalidation dependencies. */
  resolve(candidates: string[]) {
    const key = JSON.stringify(candidates);
    let result = this.resolutions.get(key);
    if (!result) {
      result = (async () => {
        const missing: string[] = [];
        for (const file of candidates) {
          try { if (await this.isFile(file)) return { file, missing }; }
          catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
          missing.push(file);
        }
        return { missing };
      })();
      this.resolutions.set(key, result);
    }
    return result;
  }

  read(file: string): Promise<{ file: string; bytes: Buffer; hash: string }> {
    let result = this.files.get(file);
    if (!result) {
      result = (async () => {
        const resolved = await realpath(file);
        if (resolved !== file) return this.read(resolved);
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

  template(file: string, code: string) {
    let ast = this.templates.get(file);
    if (!ast) {
      ast = parseDOM(code);
      this.templates.set(file, ast);
    }
    return ast;
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
