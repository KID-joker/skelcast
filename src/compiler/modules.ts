import type * as t from '@babel/types';
import { isRenderFunction, nodeName } from './ast.js';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseJS } from '@babel/parser';
import { parse as parseSFC } from '@vue/compiler-sfc';
import type { Diagnostic, SkeletonConfig, SkeletonHints } from '../types.js';
import { UNKNOWN, bindPattern, evaluate, type Ast } from './expression.js';
import { digest, loadStyle, bindStyleVariables } from './styles.js';
import { componentName, declarationComponents } from './components.js';
import type { ComponentReference } from './presets/types.js';
import { ambiguousExport, type ModuleInfo, type ResolvedComponent } from './context.js';
import { visit } from './html.js';

export type CompilerOptions = Pick<SkeletonConfig, 'components' | 'componentBindings' | 'componentDeclarations' | 'componentPresets' | 'styles'>;
const extensions = ['', '.tsx', '.jsx', '.vue', '.ts', '.js', '.mjs', '.css', '.module.css', '/index.tsx', '/index.vue', '/index.ts', '/index.js'];

export class SourceModules {
  dependencies: Record<string, string> = {};
  diagnostics: Diagnostic[] = [];
  protected modules = new Map<string, Promise<ModuleInfo>>();
  protected css = new Map<string, string>();
  protected scanned = new Set<string>();
  protected registry?: Promise<Map<string, ComponentReference>>;
  constructor(readonly root: string, readonly hints: SkeletonHints, protected aliases: Record<string, string> = {}, readonly options: CompilerOptions = {}) {}
  relative(file: string) { return path.relative(this.root, file).split(path.sep).join('/'); }
  async read(file: string): Promise<string> {
    file = await realpath(file);
    const text = await readFile(file, 'utf8');
    this.dependencies[this.relative(file)] = digest(text);
    return text;
  }
  async resolve(from: string, request: string): Promise<string | undefined> {
    let base: string;
    if (request.startsWith('.')) base = path.resolve(path.dirname(from), request.split('?')[0]);
    else {
      const alias = Object.keys(this.aliases).sort((a, b) => b.length - a.length).find(a => request === a || request.startsWith(`${a}/`));
      if (!alias) return;
      base = path.resolve(this.root, this.aliases[alias], `.${request.slice(alias.length)}`.split('?')[0]);
    }
    for (const ext of extensions) {
      const candidate = base + ext;
      try { if ((await stat(candidate)).isFile()) return candidate; }
      catch (error: any) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
      // Earlier candidates also matter: creating one can change which file wins.
      this.dependencies[this.relative(candidate)] = '!missing';
    }
  }
  protected globalComponents() {
    return this.registry ??= (async () => {
      const result = new Map<string, ComponentReference>();
      for (const declaration of this.options.componentDeclarations ?? ['components.d.ts', 'src/components.d.ts']) {
        const file = path.resolve(this.root, declaration);
        let code: string;
        try { code = await this.read(file); }
        catch (error: any) {
          if (error.code !== 'ENOENT') throw error;
          this.dependencies[this.relative(file)] = '!missing'; continue;
        }
        try {
          for (const entry of declarationComponents(code)) {
            const resolved = await this.resolve(file, entry.request);
            result.set(componentName(entry.name), { file: resolved, request: entry.request, exported: entry.exported });
          }
        } catch (error) { this.diagnostics.push({ code: 'COMPONENT_DECLARATION', file: this.relative(file), line: 1, message: String(error) }); }
      }
      for (const [name, source] of Object.entries(this.options.components ?? {})) {
        const file = path.resolve(this.root, source);
        result.set(componentName(name), { file, request: source, exported: 'default' });
      }
      return result;
    })();
  }
  async scan(file: string): Promise<void> {
    if (this.scanned.has(file)) return;
    this.scanned.add(file);
    const text = await this.read(file);
    if (/\.(css|less)$/.test(file)) { this.css.set(file, (await loadStyle(file, f => this.read(f), undefined, undefined, this.options.styles)).css); return; }
    // Conservative import graph: include helpers even when not expanded in the render tree.
    let code = text;
    if (file.endsWith('.vue')) {
      const { descriptor } = parseSFC(text, { filename: file });
      code = [descriptor.script?.content, descriptor.scriptSetup?.content].filter(Boolean).join('\n');
    }
    try {
      const ast = parseJS(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
      const requests: string[] = [];
      visit(ast, n => { if ((n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') && n.source) requests.push(n.source.value); });
      for (const request of requests) { const dep = await this.resolve(file, request); if (dep) await this.scan(dep); }
    } catch { /* unsupported dependency is still fingerprinted */ }
  }
  protected module(file: string): Promise<ModuleInfo> {
    const existing = this.modules.get(file);
    if (existing) return existing;
    const promise = this.loadModule(file);
    this.modules.set(file, promise);
    return promise;
  }
  protected async loadModule(file: string): Promise<ModuleInfo> {
    const raw = await this.read(file);
    let descriptor: ModuleInfo['descriptor'];
    let code = raw;
    if (file.endsWith('.vue')) {
      const parsed = parseSFC(raw, { filename: file });
      if (parsed.errors.length) throw new Error(String(parsed.errors[0]));
      descriptor = parsed.descriptor;
      code = [descriptor.script?.content, descriptor.scriptSetup?.content].filter(Boolean).join('\n');
    }
    const ast = parseJS(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
    const mod: ModuleInfo = { file, code, ast, descriptor, functions: new Map(), imports: new Map(), exports: new Map(), reexports: new Map(), exportAll: [], env: Object.create(null), scopes: [], boundaries: new Set(['LoadingBoundary']), propDefaults: {}, propBindings: [], inheritAttrs: true, cssBindings: [] };
    const ec = { code, env: mod.env, bindings: this.hints.bindings ?? {} };
    for (const statement of ast.program.body) {
      const decl = statement.type === 'ExportDefaultDeclaration' || statement.type === 'ExportNamedDeclaration' ? statement.declaration ?? statement : statement;
      if (decl.type === 'FunctionDeclaration' && decl.id) { mod.functions.set(decl.id.name, decl); mod.env[decl.id.name] = UNKNOWN; }
      if (decl.type === 'VariableDeclaration') for (const d of decl.declarations) {
        let init: t.Node | null | undefined = d.init;
        if (init?.type === 'CallExpression' && ['memo', 'forwardRef'].includes(nodeName(init.callee) ?? '')) init = init.arguments[0];
        if (d.id.type === 'Identifier' && isRenderFunction(init)) mod.functions.set(d.id.name, init);
        else bindPattern(d.id, evaluate(d.init, ec), mod.env);
      }
      if (statement.type === 'ExportDefaultDeclaration') {
        mod.exports.set('default', 'default');
        const d = statement.declaration;
        if (d.type === 'Identifier') mod.functions.set('default', d);
        else if (d.type === 'CallExpression' && ['memo', 'forwardRef'].includes(nodeName(d.callee) ?? '')) { if (d.arguments[0]) mod.functions.set('default', d.arguments[0]); }
        else mod.functions.set('default', d);
      }
      if (statement.type === 'ImportDeclaration') {
        for (const spec of statement.specifiers) mod.env[spec.local.name] = UNKNOWN;
        if (['skelcast/react', 'skelcast/vue'].includes(statement.source.value)) for (const spec of statement.specifiers) if (spec.type === 'ImportSpecifier' && nodeName(spec.imported) === 'LoadingBoundary') mod.boundaries.add(spec.local.name);
        const resolved = await this.resolve(file, statement.source.value);
        for (const spec of statement.specifiers) if ((spec.type !== 'ImportSpecifier' || spec.importKind !== 'type') && statement.importKind !== 'type') mod.imports.set(spec.local.name, {
          file: resolved, request: statement.source.value,
          exported: spec.type === 'ImportNamespaceSpecifier' ? '*' : spec.type === 'ImportDefaultSpecifier' ? 'default' : nodeName(spec.imported)!,
        });
        if (resolved && /\.(css|less)$/.test(resolved)) {
          const { css, mapping } = await loadStyle(resolved, f => this.read(f), undefined, undefined, this.options.styles);
          this.css.set(resolved, css);
          for (const spec of statement.specifiers) mod.env[spec.local.name] = mapping;
        }
      }
      if (statement.type === 'ExportNamedDeclaration' && statement.exportKind !== 'type') {
        if (decl.type === 'FunctionDeclaration' && decl.id) mod.exports.set(decl.id.name, decl.id.name);
        if (decl.type === 'VariableDeclaration') for (const item of decl.declarations) if (item.id.type === 'Identifier') mod.exports.set(item.id.name, item.id.name);
        const request = statement.source?.value;
        const resolved = request ? await this.resolve(file, request) : undefined;
        for (const spec of statement.specifiers ?? []) {
          if (spec.type === 'ExportSpecifier' && spec.exportKind === 'type') continue;
          const name = nodeName(spec.exported)!;
          if (request) mod.reexports.set(name, { file: resolved, request, exported: spec.type === 'ExportNamespaceSpecifier' ? '*' : spec.type === 'ExportDefaultSpecifier' ? 'default' : nodeName(spec.local)! });
          else if (spec.type === 'ExportSpecifier') mod.exports.set(name, nodeName(spec.local)!);
        }
      }
      if (statement.type === 'ExportAllDeclaration' && statement.exportKind !== 'type') mod.exportAll.push({ file: await this.resolve(file, statement.source.value), request: statement.source.value, exported: '*' });
    }
    if (descriptor) {
      // Missing declared props have Vue's absent value, rather than an opaque
      // business value. Read only local type members; imported types stay unknown.
      const declaredProps = (type: Ast | undefined) => {
        if (type?.type === 'TSIntersectionType') { type.types.forEach(declaredProps); return; }
        if (type?.type !== 'TSTypeLiteral') return;
        for (const member of type.members) {
          const key = member.type === 'TSPropertySignature' ? nodeName(member.key) : undefined;
          if (member.type === 'TSPropertySignature' && !member.computed && typeof key === 'string') mod.propDefaults[key] = member.typeAnnotation?.typeAnnotation?.type === 'TSBooleanKeyword' ? false : undefined;
        }
      };
      visit(ast, n => {
        if (n.type === 'CallExpression' && nodeName(n.callee) === 'defineOptions' && n.arguments[0]?.type === 'ObjectExpression') {
          const value = evaluate(n.arguments[0], ec);
          if (value && typeof value === 'object' && 'inheritAttrs' in value && value.inheritAttrs === false) mod.inheritAttrs = false;
        }
        if (n.type === 'CallExpression' && nodeName(n.callee) === 'defineProps') {
          declaredProps(n.typeParameters?.params?.[0]);
          const runtime = n.arguments[0];
          if (runtime?.type === 'ArrayExpression') for (const item of runtime.elements) if (item?.type === 'StringLiteral') mod.propDefaults[item.value] = undefined;
        }
      });
      visit(ast, n => {
        if (n.type !== 'VariableDeclarator' || n.id.type !== 'Identifier') return;
        const init = n.init;
        if (init?.type !== 'CallExpression') return;
        const declaration = nodeName(init.callee) === 'withDefaults' ? init.arguments[0] : init;
        if (declaration?.type !== 'CallExpression' || nodeName(declaration.callee) !== 'defineProps') return;
        mod.propBindings.push(n.id.name);
        if (nodeName(init.callee) === 'withDefaults') {
          const defaults = evaluate(init.arguments[1], ec);
          if (defaults && defaults !== UNKNOWN && typeof defaults === 'object') Object.assign(mod.propDefaults, defaults);
          // Vue invokes default factories. Interpret only their literal
          // expression bodies; never call source functions.
          for (const property of init.arguments[1]?.type === 'ObjectExpression' ? init.arguments[1].properties : []) {
            if (property.type !== 'ObjectProperty' || property.computed || property.value.type !== 'ArrowFunctionExpression' || property.value.params.length || property.value.body.type === 'BlockStatement') continue;
            const key = nodeName(property.key);
            if (typeof key === 'string') mod.propDefaults[key] = evaluate(property.value.body, ec);
          }
        }
      });
      const scopeId = `data-v-sk-${digest(this.relative(file)).slice(0, 8)}`;
      for (let i = 0; i < descriptor.styles.length; i++) {
        const style = descriptor.styles[i];
        if (style.lang && style.lang !== 'css' && !(style.lang === 'less' && this.options.styles?.less)) {
          this.diagnostics.push({ code: 'STYLE_UNSUPPORTED', message: `Style language ${style.lang} needs an adapter`, file: this.relative(file), line: style.loc.start.line }); continue;
        }
        const styleFile = style.src ? await this.resolve(file, style.src) : file;
        if (!styleFile) continue;
        if (style.scoped && !mod.scopes.includes(scopeId)) mod.scopes.push(scopeId);
        const bound = bindStyleVariables(style.src ? await this.read(styleFile) : style.content, this.relative(file));
        mod.cssBindings.push(...bound.bindings.map(binding => ({ ...binding, line: binding.line + (style.src ? 0 : style.loc.start.line - 1) })));
        const { css, mapping } = await loadStyle(style.module ? `${styleFile}.module.css` : styleFile, f => this.read(f), style.scoped ? scopeId : undefined, bound.css, this.options.styles, style.lang);
        this.css.set(`${file}:${i}`, css);
        if (style.module) mod.env[typeof style.module === 'string' ? style.module : '$style'] = mapping;
      }
    }
    return mod;
  }
  protected async resolveExport(file: string, exported: string, allowLocal = false, seen = new Set<string>(), budget = { remaining: 1000 }): Promise<ResolvedComponent | typeof ambiguousExport | undefined> {
    const key = JSON.stringify([file, exported]);
    if (seen.has(key) || seen.size >= 64 || --budget.remaining < 0) return;
    const next = new Set(seen).add(key);
    const mod = await this.module(file);
    if (mod.descriptor) return exported === 'default' ? { module: mod } : undefined;
    const follow = (reference: ComponentReference, name = reference.exported) => reference.file ? this.resolveExport(reference.file, name, false, next, budget) : undefined;
    // Init can select a protected source component. Imports still require a public export.
    const binding = mod.exports.get(exported) ?? (allowLocal && mod.functions.has(exported) ? exported : undefined);
    if (binding !== undefined) {
      let local: string = binding;
      const bindings = new Set<string>();
      while (!bindings.has(local)) {
        bindings.add(local);
        const fn = mod.functions.get(local);
        if (fn?.type === 'Identifier') { local = fn.name; continue; }
        if (fn) return { module: mod, fn };
        const imported = mod.imports.get(local);
        return imported ? follow(imported) : undefined;
      }
      return;
    }
    const explicit = mod.reexports.get(exported);
    if (explicit) return follow(explicit);
    const [namespace, ...members] = exported.split('.');
    const reference = mod.reexports.get(namespace) ?? mod.imports.get(mod.exports.get(namespace) ?? '');
    if (members.length && reference?.exported === '*') return follow(reference, members.join('.'));
    // export * never forwards default, and conflicting bindings are not a choice.
    if (exported === 'default') return;
    let result: ResolvedComponent | undefined;
    for (const reference of mod.exportAll) {
      const candidate = await follow(reference, exported);
      if (candidate === ambiguousExport) return ambiguousExport;
      if (!candidate) continue;
      if (result && (result.module !== candidate.module || result.fn !== candidate.fn)) return ambiguousExport;
      result = candidate;
    }
    return result;
  }
}
