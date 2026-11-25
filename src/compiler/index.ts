import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseJS, parseExpression } from '@babel/parser';
import { parse as parseSFC } from '@vue/compiler-sfc';
import { parse as parseDOM } from '@vue/compiler-dom';
import type { Diagnostic, Evidence, SkeletonArtifact, SkeletonConfig, SkeletonHints, SkeletonTarget, SourceLocation } from '../types.js';
import { UNKNOWN, bindPattern, evaluate, evaluateString, expressionText, type Ast, type ExpressionContext, type Value } from './expression.js';
import { baseCSS, digest, loadStyle, scopeCSS, utilityCSS, utilityAttribute, bindStyleVariables, type CSSBinding } from './styles.js';
import { componentName, declarationComponents } from './components.js';
import { resolvePreset } from './presets/index.js';
import type { ComponentReference } from './presets/types.js';

const extensions = ['', '.tsx', '.jsx', '.vue', '.ts', '.js', '.mjs', '.css', '.module.css', '/index.tsx', '/index.vue', '/index.ts', '/index.js'];
const escapeHTML = (v: unknown) => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const nonVisual = new Set(['script', 'style', 'link', 'meta', 'iframe', 'object', 'embed']);
const unitless = new Set(['opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'order', 'gridColumn', 'gridRow', 'aspectRatio']);
const cssName = (name: string) => name.startsWith('--') ? name : name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
const unknownGeometry = (value: unknown) => value && typeof value === 'object' && Object.entries(value).some(([key, v]) => v === UNKNOWN && /width|height|gap|display|position|margin|padding|flex|grid|inset|^top$|^right$|^bottom$|^left$|aspect|transform/i.test(key));
function styleString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value).filter(([, v]) => v !== UNKNOWN && v != null).map(([k, v]) => `${cssName(k)}:${typeof v === 'number' && v !== 0 && !unitless.has(k) && !k.startsWith('--') ? `${v}px` : v}`).join(';');
}
function classString(value: unknown): string {
  if (value === UNKNOWN || value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(classString).filter(Boolean).join(' ');
  if (typeof value === 'object') return Object.entries(value).filter(([, v]) => v !== UNKNOWN && !!v).map(([k]) => k).join(' ');
  return '';
}
function visit(node: Ast, fn: (node: Ast) => void): void {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') fn(node);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'tokens', 'comments', 'leadingComments', 'trailingComments'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(v => visit(v, fn));
    else if (value && typeof value === 'object') visit(value, fn);
  }
}
interface ModuleInfo {
  file: string;
  code: string;
  ast: Ast;
  functions: Map<string, Ast>;
  imports: Map<string, ComponentReference>;
  exports: Map<string, string>;
  reexports: Map<string, ComponentReference>;
  exportAll: ComponentReference[];
  env: Record<string, Value>;
  descriptor?: ReturnType<typeof parseSFC>['descriptor'];
  scopes: string[];
  boundaries: Set<string>;
  propDefaults: Record<string, Value>;
  propBindings: string[];
  inheritAttrs: boolean;
  cssBindings: CSSBinding[];
}
interface ResolvedComponent { module: ModuleInfo; fn?: Ast }
const ambiguousExport = Symbol('ambiguous-export');
interface SourceSlot { nodes: Ast[]; context: RenderContext; framework: 'vue' | 'jsx' }
const slotValue = Symbol('source-slot');
interface RenderContext extends ExpressionContext { module: ModuleInfo; scopes: string[]; depth: number; slots?: Record<string, SourceSlot>; mode?: 'auto' | 'preserve' | 'mask'; control?: boolean; fallthrough?: { node: Ast; props: Record<string, Value> } }

export class SourceCompiler {
  dependencies: Record<string, string> = {};
  diagnostics: Diagnostic[] = [];
  evidence: Evidence[] = [];
  sources: Record<string, SourceLocation> = {};
  private modules = new Map<string, Promise<ModuleInfo>>();
  private css = new Map<string, string>();
  private scanned = new Set<string>();
  private renderedNodes = 0;
  private budgetReported = false;
  private registry?: Promise<Map<string, ComponentReference>>;
  constructor(private root: string, private target: SkeletonTarget, private hints: SkeletonHints, private aliases: Record<string, string> = {}, private options: Pick<SkeletonConfig, 'components' | 'componentBindings' | 'componentDeclarations' | 'componentPresets' | 'styles'> = {}) {}
  private relative(file: string) { return path.relative(this.root, file).split(path.sep).join('/'); }
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
  private globalComponents() {
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
  private diagnose(code: string, message: string, ctx: RenderContext, node?: Ast, id?: string) {
    const line = this.sourceLine(ctx, node);
    this.diagnostics.push({ code, message, file: this.relative(ctx.module.file), line, node: id });
  }
  private record(kind: Evidence['kind'], expression: string, decision: string, ctx: RenderContext, node?: Ast) {
    this.evidence.push({ kind, expression, decision, file: this.relative(ctx.module.file), line: this.sourceLine(ctx, node) });
  }
  private sourceLine(ctx: RenderContext, node?: Ast) {
    return (node?.loc?.start?.line ?? 1) + (ctx.module.descriptor?.template && ctx.code === ctx.module.descriptor.template.content ? ctx.module.descriptor.template.loc.start.line - 1 : 0);
  }
  private nodeId(ctx: RenderContext, node?: Ast): string {
    const id = digest(`${this.relative(ctx.module.file)}:${node?.start ?? node?.loc?.start?.offset ?? 0}`).slice(0, 12);
    this.sources[id] = { file: this.relative(ctx.module.file), line: this.sourceLine(ctx, node) };
    return id;
  }
  private fallback(ctx: RenderContext, node: Ast, message: string, attrs = '') {
    const id = this.nodeId(ctx, node);
    this.diagnose('FALLBACK', message, ctx, node, id);
    const style = attrs.match(/ style="([^"]*)"/)?.[1];
    attrs = attrs.replace(/ style="[^"]*"/, '');
    return `<div data-sk-node="${id}" data-sk-fallback${ctx.mode === 'preserve' ? ' data-sk-control' : ' data-sk-leaf'}${attrs} style="${style ? `${style};` : ''}min-height:${this.hints.minHeight ?? 96}px"></div>`;
  }
  private text(ctx: RenderContext, node: Ast, multiline = false): string {
    const id = this.nodeId(ctx, node);
    if (ctx.mode === 'preserve') return `<span data-sk-node="${id}" data-sk-text>&nbsp;</span>`;
    if (multiline && (this.hints.lines ?? 1) > 1) return `<span data-sk-node="${id}" data-sk-multiline>${Array.from({ length: this.hints.lines! }, () => '<span></span>').join('')}</span>`;
    return `<span data-sk-node="${id}" data-sk-text data-sk-leaf>&nbsp;</span>`;
  }
  private budget(ctx: RenderContext, node: Ast): string | undefined {
    if (++this.renderedNodes <= 6000) return;
    if (this.budgetReported) return '';
    this.budgetReported = true;
    return this.fallback(ctx, node, 'Static expansion budget reached; simplify the boundary or supply a local adapter');
  }
  private inheritRootScopes(html: string, scopes: string[], attrs: Record<string, Value> = {}, rootStyle = ''): string {
    if (!html) return html;
    const roots = parseDOM(html).children.filter((n: any) => n.type === 1) as any[];
    for (const node of roots.reverse()) {
      let inherited = '';
      if (roots.length === 1 || rootStyle) {
        const forwarded: Record<string, Value> = roots.length === 1 ? { ...attrs } : {};
        if (rootStyle) forwarded.style = `${rootStyle};${styleString(forwarded.style)}`;
        for (const attr of [...node.props].reverse()) {
          if (attr.type !== 6 || forwarded[attr.name] == null || !this.attributes({ [attr.name]: forwarded[attr.name] })) continue;
          if (attr.name === 'class') forwarded.class = `${attr.value?.content ?? ''} ${classString(forwarded.class)}`;
          else if (attr.name === 'style') forwarded.style = `${attr.value?.content ?? ''};${styleString(forwarded.style)}`;
          html = html.slice(0, attr.loc.start.offset) + html.slice(attr.loc.end.offset);
        }
        inherited = this.attributes(forwarded);
      }
      const extra = scopes.filter(s => !node.props.some((p: any) => p.name === s));
      const offset = node.loc.start.offset + node.tag.length + 1;
      html = html.slice(0, offset) + inherited + extra.map(s => ` ${s}`).join('') + html.slice(offset);
    }
    return html;
  }
  private async jsxNodes(nodes: Ast[], ctx: RenderContext): Promise<string> {
    let html = '';
    for (const node of nodes) html += await this.jsx(node, ctx);
    return html;
  }
  private async scan(file: string): Promise<void> {
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
      visit(ast, n => { if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(n.type) && n.source) requests.push(n.source.value); });
      for (const request of requests) { const dep = await this.resolve(file, request); if (dep) await this.scan(dep); }
    } catch { /* unsupported dependency is still fingerprinted */ }
  }
  private module(file: string): Promise<ModuleInfo> {
    const existing = this.modules.get(file);
    if (existing) return existing;
    const promise = this.loadModule(file);
    this.modules.set(file, promise);
    return promise;
  }
  private async loadModule(file: string): Promise<ModuleInfo> {
    const raw = await this.read(file);
    let descriptor: ModuleInfo['descriptor'];
    let code = raw;
    if (file.endsWith('.vue')) {
      const parsed = parseSFC(raw, { filename: file });
      if (parsed.errors.length) throw new Error(String(parsed.errors[0]));
      descriptor = parsed.descriptor;
      code = [descriptor.script?.content, descriptor.scriptSetup?.content].filter(Boolean).join('\n');
    }
    const ast: Ast = parseJS(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
    const mod: ModuleInfo = { file, code, ast, descriptor, functions: new Map(), imports: new Map(), exports: new Map(), reexports: new Map(), exportAll: [], env: Object.create(null), scopes: [], boundaries: new Set(['LoadingBoundary']), propDefaults: {}, propBindings: [], inheritAttrs: true, cssBindings: [] };
    const ec = { code, env: mod.env, bindings: this.hints.bindings ?? {} };
    for (const statement of ast.program.body) {
      const decl = statement.declaration ?? statement;
      if (decl.type === 'FunctionDeclaration' && decl.id) { mod.functions.set(decl.id.name, decl); mod.env[decl.id.name] = UNKNOWN; }
      if (decl.type === 'VariableDeclaration') for (const d of decl.declarations) {
        let init = d.init;
        if (init?.type === 'CallExpression' && ['memo', 'forwardRef'].includes(init.callee.name)) init = init.arguments[0];
        if (d.id.type === 'Identifier' && ['ArrowFunctionExpression', 'FunctionExpression'].includes(init?.type)) mod.functions.set(d.id.name, init);
        else bindPattern(d.id, evaluate(d.init, ec), mod.env);
      }
      if (statement.type === 'ExportDefaultDeclaration') {
        mod.exports.set('default', 'default');
        const d = statement.declaration;
        if (d.type === 'Identifier') mod.functions.set('default', d);
        else if (d.type === 'CallExpression' && ['memo', 'forwardRef'].includes(d.callee.name)) mod.functions.set('default', d.arguments[0]);
        else mod.functions.set('default', d);
      }
      if (statement.type === 'ImportDeclaration') {
        for (const spec of statement.specifiers) mod.env[spec.local.name] = UNKNOWN;
        if (['skelcast/react', 'skelcast/vue'].includes(statement.source.value)) for (const spec of statement.specifiers) if (spec.imported?.name === 'LoadingBoundary') mod.boundaries.add(spec.local.name);
        const resolved = await this.resolve(file, statement.source.value);
        for (const spec of statement.specifiers) if (spec.importKind !== 'type' && statement.importKind !== 'type') mod.imports.set(spec.local.name, {
          file: resolved, request: statement.source.value,
          exported: spec.type === 'ImportNamespaceSpecifier' ? '*' : spec.type === 'ImportDefaultSpecifier' ? 'default' : spec.imported?.name ?? spec.imported?.value,
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
          if (spec.exportKind === 'type') continue;
          const name = spec.exported.name ?? spec.exported.value;
          if (request) mod.reexports.set(name, { file: resolved, request, exported: spec.type === 'ExportNamespaceSpecifier' ? '*' : spec.local.name ?? spec.local.value });
          else mod.exports.set(name, spec.local.name ?? spec.local.value);
        }
      }
      if (statement.type === 'ExportAllDeclaration' && statement.exportKind !== 'type') mod.exportAll.push({ file: await this.resolve(file, statement.source.value), request: statement.source.value, exported: '*' });
    }
    if (descriptor) {
      // Missing declared props have Vue's absent value, rather than an opaque
      // business value. Read only local type members; imported types stay unknown.
      const declaredProps = (type: Ast) => {
        if (type?.type === 'TSIntersectionType') { type.types.forEach(declaredProps); return; }
        if (type?.type !== 'TSTypeLiteral') return;
        for (const member of type.members) {
          const key = member.key?.name ?? member.key?.value;
          if (member.type === 'TSPropertySignature' && !member.computed && typeof key === 'string') mod.propDefaults[key] = member.typeAnnotation?.typeAnnotation?.type === 'TSBooleanKeyword' ? false : undefined;
        }
      };
      visit(ast, n => {
        if (n.type === 'CallExpression' && n.callee.name === 'defineOptions' && n.arguments[0]?.type === 'ObjectExpression') {
          const value = evaluate(n.arguments[0], ec) as any;
          if (value.inheritAttrs === false) mod.inheritAttrs = false;
        }
        if (n.type === 'CallExpression' && n.callee.name === 'defineProps') {
          declaredProps(n.typeParameters?.params?.[0]);
          const runtime = n.arguments[0];
          if (runtime?.type === 'ArrayExpression') for (const item of runtime.elements) if (item?.type === 'StringLiteral') mod.propDefaults[item.value] = undefined;
        }
      });
      visit(ast, n => {
        if (n.type !== 'VariableDeclarator' || n.id.type !== 'Identifier') return;
        const init = n.init;
        const declaration = init?.callee?.name === 'withDefaults' ? init.arguments[0] : init;
        if (declaration?.callee?.name !== 'defineProps') return;
        mod.propBindings.push(n.id.name);
        if (init.callee.name === 'withDefaults') {
          const defaults = evaluate(init.arguments[1], ec);
          if (defaults && defaults !== UNKNOWN && typeof defaults === 'object') Object.assign(mod.propDefaults, defaults);
          // Vue invokes default factories. Interpret only their literal
          // expression bodies; never call source functions.
          for (const property of init.arguments[1]?.properties ?? []) {
            if (property.type !== 'ObjectProperty' || property.computed || property.value.type !== 'ArrowFunctionExpression' || property.value.params.length || property.value.body.type === 'BlockStatement') continue;
            const key = property.key.name ?? property.key.value;
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
  private async resolveExport(file: string, exported: string, allowLocal = false, seen = new Set<string>(), budget = { remaining: 1000 }): Promise<ResolvedComponent | typeof ambiguousExport | undefined> {
    const key = JSON.stringify([file, exported]);
    if (seen.has(key) || seen.size >= 64 || --budget.remaining < 0) return;
    const next = new Set(seen).add(key);
    const mod = await this.module(file);
    if (mod.descriptor) return exported === 'default' ? { module: mod } : undefined;
    const follow = (reference: ComponentReference, name = reference.exported) => reference.file ? this.resolveExport(reference.file, name, false, next, budget) : undefined;
    // Init can select a private source component. Imports still require a public export.
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
  private context(mod: ModuleInfo, props: Record<string, Value> = {}, parent?: RenderContext): RenderContext {
    const file = this.relative(mod.file);
    const prefix = `${file}::`;
    const scoped = Object.fromEntries(Object.entries(this.hints.bindings ?? {}).filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]));
    const bindings = { ...this.options.componentBindings?.[file], ...this.hints.bindings, ...scoped };
    const camelProps = Object.fromEntries(Object.entries(props).map(([key, value]) => [key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), value]));
    const values = { ...mod.propDefaults, ...props, ...camelProps };
    const env: Record<string, Value> = { ...mod.env, ...values, $slots: props.__skSlots ?? {}, $attrs: this.fallthroughAttrs(mod, props) };
    for (const name of mod.propBindings) env[name] = values;
    for (const [name, value] of Object.entries(bindings)) if (/^[\w$]+$/.test(name)) env[name] = value;
    if (mod.descriptor?.scriptSetup) {
      for (const statement of mod.ast.program.body) {
        const declaration = statement.declaration ?? statement;
        if (declaration.type !== 'VariableDeclaration') continue;
        for (const item of declaration.declarations) {
          if (item.id.type === 'Identifier' && mod.propBindings.includes(item.id.name)) continue;
          if (item.id.type === 'ObjectPattern' && item.init?.type === 'CallExpression' && item.init.callee.name === 'toRefs') {
            bindPattern(item.id, evaluate(item.init.arguments[0], { code: mod.code, env, bindings, unwrapRefs: true }), env);
          } else bindPattern(item.id, evaluate(item.init, { code: mod.code, env, bindings, unwrapRefs: true }), env);
        }
      }
    }
    return { module: mod, code: mod.code, env, bindings, unwrapRefs: !!mod.descriptor, scopes: mod.scopes, depth: (parent?.depth ?? 0) + 1, slots: props.__skSlots as Record<string, SourceSlot> | undefined, mode: parent?.mode, control: parent?.control };
  }
  private fallthroughAttrs(mod: ModuleInfo, props: Record<string, Value>): Record<string, Value> {
    return Object.fromEntries(Object.entries(props).filter(([key]) => !key.startsWith('__sk') && !Object.hasOwn(mod.propDefaults, key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()))));
  }
  private cssVariables(ctx: RenderContext): string {
    const styles: Record<string, Value> = {};
    for (const binding of ctx.module.cssBindings) {
      const value = evaluateString(binding.expression, ctx);
      if (typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) {
        styles[binding.variable] = value;
        this.evidence.push({ kind: 'style', expression: binding.expression, decision: `Resolve CSS variable to ${String(value)}`, file: this.relative(ctx.module.file), line: binding.line });
      } else this.diagnostics.push({ code: 'STYLE_BINDING', message: `Cannot resolve CSS v-bind(${binding.expression}); provide a component-scoped binding`, file: this.relative(ctx.module.file), line: binding.line });
    }
    return styleString(styles);
  }
  private prepareFunction(fn: Ast, ctx: RenderContext, props: Record<string, Value>): Ast | undefined {
    bindPattern(fn.params?.[0], props, ctx.env);
    if (fn.params?.[0]?.type === 'ObjectPattern') for (const p of fn.params[0].properties) if (p.value?.type === 'AssignmentPattern') {
      const key = p.key.name ?? p.key.value;
      if (!Object.hasOwn(props, key) || props[key] === UNKNOWN) bindPattern(p.value.left, evaluate(p.value.right, ctx), ctx.env);
    }
    if (fn.body?.type !== 'BlockStatement') return fn.body;
    let output: Ast | undefined;
    for (const statement of fn.body.body) {
      if (statement.type === 'VariableDeclaration') for (const d of statement.declarations) bindPattern(d.id, evaluate(d.init, ctx), ctx.env);
      if (statement.type === 'ReturnStatement') { output = statement.argument; break; }
      if (statement.type === 'IfStatement') {
        const test = evaluate(statement.test, ctx);
        const branch = test === UNKNOWN ? null : test ? statement.consequent : statement.alternate;
        if (branch?.type === 'ReturnStatement') { output = branch.argument; break; }
        if (branch?.type === 'BlockStatement') {
          const ret = branch.body.find((n: Ast) => n.type === 'ReturnStatement');
          if (ret) { output = ret.argument; break; }
        }
        if (test === UNKNOWN) this.record('branch', expressionText(statement.test, ctx), 'Unknown early-return guard: prefer the later content return', ctx, statement);
      }
    }
    return output;
  }
  private async component(file: string, exported: string, props: Record<string, Value> = {}, parent?: RenderContext, node?: Ast): Promise<string> {
    const resolved = await this.resolveExport(file, exported, !parent);
    const component = resolved === ambiguousExport ? undefined : resolved;
    const mod = component?.module ?? await this.module(file);
    const ctx = this.context(mod, props, parent);
    if (ctx.depth > 16) return this.fallback(ctx, node, 'Component recursion limit reached');
    if (!component) return this.fallback(ctx, node, `${resolved === ambiguousExport ? 'Ambiguous' : 'Cannot locate'} exported component ${exported}`);
    if (mod.descriptor) {
      const rootStyle = this.cssVariables(ctx);
      if (!mod.descriptor.scriptSetup && mod.descriptor.script) {
        this.diagnose('VUE_OPTIONS', 'Options API script values are not interpreted; use bindings for dynamic layout', ctx);
      }
      const template = mod.descriptor.template;
      if (!template) return this.fallback(ctx, node, 'Vue component has no static template');
      if (template.lang && template.lang !== 'html') return this.fallback(ctx, node, `Template language ${template.lang} needs an adapter`);
      const ast = parseDOM(template.content);
      ctx.code = template.content;
      const roots = ast.children.filter((child: any) => child.type === 1 || child.type === 5 || child.type === 2 && child.content.trim());
      const root = roots.length === 1 && roots[0].type === 1 && roots[0].tag !== 'template' && !mod.boundaries.has(roots[0].tag) ? roots[0] : undefined;
      if (mod.inheritAttrs && root) ctx.fallthrough = { node: root, props: this.fallthroughAttrs(mod, props) };
      if (this.target.region && ctx.depth === 1) {
        let region: any;
        const find = (n: any) => {
          if (n.type === 1 && mod.boundaries.has(n.tag) && n.props.some((p: any) => p.type === 7 && p.name === 'bind' && p.arg?.content === 'artifact' && p.exp?.content === this.target.region)) region = n;
          for (const child of n.children ?? []) find(child);
        };
        find(ast);
        if (!region) return this.fallback(ctx, node, `Missing source region ${this.target.region}`);
        return this.inheritRootScopes(await this.vueNodes(region.children, ctx), [], {}, rootStyle);
      }
      return this.inheritRootScopes(await this.vueNodes(ast.children, ctx), parent?.scopes ?? [], mod.inheritAttrs && !root ? this.fallthroughAttrs(mod, props) : {}, rootStyle);
    }
    const fn = component.fn;
    if (!fn) return this.fallback(ctx, node, `Cannot locate exported component ${exported}`);
    if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(fn.type)) return this.fallback(ctx, node, `Unsupported component declaration ${fn.type}`);
    const body = this.prepareFunction(fn, ctx, props);
    if (this.target.region && ctx.depth === 1) {
      let region: Ast;
      visit(fn.body, n => {
        if (n.type === 'JSXElement' && mod.boundaries.has(n.openingElement.name.name) && n.openingElement.attributes.some((a: Ast) => a.type === 'JSXAttribute' && a.name.name === 'artifact' && a.value?.expression?.name === this.target.region) && n.children.some((c: Ast) => c.type !== 'JSXText' || c.value.trim())) region = n;
      });
      return region ? this.jsxNodes(region.children, ctx) : this.fallback(ctx, node, `Missing source region ${this.target.region}`);
    }
    return body ? this.jsx(body, ctx) : this.fallback(ctx, node, `No supported render return in ${exported}`);
  }
  private async jsx(node: Ast, ctx: RenderContext): Promise<string> {
    if (!node) return '';
    const exhausted = this.budget(ctx, node);
    if (exhausted !== undefined) return exhausted;
    if (['TSAsExpression', 'TSNonNullExpression', 'ParenthesizedExpression'].includes(node.type)) return this.jsx(node.expression, ctx);
    if (node.type === 'JSXFragment') return this.jsxNodes(node.children, ctx);
    if (node.type === 'JSXText') return node.value.trim() ? this.contentText(node.value, ctx, node) : '';
    if (node.type === 'JSXExpressionContainer') return node.expression.type === 'JSXEmptyExpression' ? '' : this.jsx(node.expression, ctx);
    if (node.type === 'ConditionalExpression') {
      const test = evaluate(node.test, ctx);
      this.record('branch', expressionText(node.test, ctx), test === UNKNOWN ? 'Default to consequent; override with bindings' : `Resolved to ${!!test}`, ctx, node);
      if (test === UNKNOWN) this.diagnose('BRANCH_DEFAULT', 'Unknown condition: chose consequent; supply bindings to select a branch', ctx, node);
      return this.jsx(test === UNKNOWN || test ? node.consequent : node.alternate, ctx);
    }
    if (node.type === 'LogicalExpression') {
      const left = evaluate(node.left, ctx);
      if (left === UNKNOWN) { this.record('branch', expressionText(node.left, ctx), 'Include optional content by default', ctx, node); return this.jsx(node.right, ctx); }
      if (node.operator === '&&') return left ? this.jsx(node.right, ctx) : '';
      return left != null && (node.operator === '??' || left) ? this.jsx(node.left, ctx) : this.jsx(node.right, ctx);
    }
    if (['CallExpression', 'OptionalCallExpression'].includes(node.type) && ['MemberExpression', 'OptionalMemberExpression'].includes(node.callee.type) && node.callee.property.name === 'map') {
      const fn = node.arguments[0];
      if (!['ArrowFunctionExpression', 'FunctionExpression'].includes(fn?.type)) return this.fallback(ctx, node, 'Unsupported map callback');
      const list = evaluate(node.callee.object, ctx);
      const count = this.hints.repeat ?? (Array.isArray(list) && list.length ? Math.min(list.length, 12) : 4);
      this.record('repeat', expressionText(node.callee.object, ctx), `Generate ${count} placeholders`, ctx, node);
      let html = '';
      for (let i = 0; i < count; i++) {
        const local = { ...ctx, env: { ...ctx.env } };
        bindPattern(fn.params[0], Array.isArray(list) ? list[i] ?? UNKNOWN : UNKNOWN, local.env);
        bindPattern(fn.params[1], i, local.env);
        const body = fn.body.type === 'BlockStatement' ? fn.body.body.find((n: Ast) => n.type === 'ReturnStatement')?.argument : fn.body;
        html += await this.jsx(body, local);
      }
      return html;
    }
    if (node.type === 'ArrayExpression') return this.jsxNodes(node.elements, ctx);
    if (node.type !== 'JSXElement') {
      if (['NullLiteral', 'BooleanLiteral'].includes(node.type)) return '';
      if (node.type === 'CallExpression') return this.fallback(ctx, node, `Unknown render call: ${expressionText(node.callee, ctx)}`);
      const value = evaluate(node, ctx);
      if (value && typeof value === 'object' && Object.hasOwn(value, slotValue)) return this.renderSlot((value as any)[slotValue], ctx);
      this.record('text', expressionText(node, ctx), 'Replace content with text placeholder', ctx, node);
      return this.contentText(value, ctx, node);
    }
    const opening = node.openingElement;
    const jsxName = (n: Ast): string => n.type === 'JSXIdentifier' ? n.name : n.type === 'JSXMemberExpression' ? `${jsxName(n.object)}.${jsxName(n.property)}` : '';
    const tag = jsxName(opening.name);
    const props: Record<string, Value> = Object.create(null);
    let unknownLayout = false;
    for (const a of opening.attributes) {
      if (a.type === 'JSXSpreadAttribute') {
        const value = evaluate(a.argument, ctx);
        if (value && value !== UNKNOWN && typeof value === 'object') Object.assign(props, value);
        else this.diagnose('SPREAD_UNKNOWN', 'Unknown spread props may affect layout', ctx, a);
        continue;
      }
      const name = a.name.name;
      props[name] = !a.value ? true : a.value.type === 'StringLiteral' ? a.value.value : evaluate(a.value.expression, ctx);
      if (props[name] === UNKNOWN && ['className', 'style', 'width', 'height'].includes(name)) {
        const fallback = a.value?.expression ? evaluate(a.value.expression, { ...ctx, defaultBranches: true }) : UNKNOWN;
        props[name] = fallback;
        this.diagnose('LAYOUT_UNKNOWN', fallback === UNKNOWN ? `Cannot resolve ${name}; using a local fallback` : `Unknown ${name} condition: use the first static branch`, ctx, a);
        if (fallback === UNKNOWN) unknownLayout = true;
      }
    }
    ctx = this.contentContext(ctx, props, tag);
    if (ctx.module.boundaries.has(tag)) return this.jsxNodes(node.children, ctx);
    if (unknownGeometry(props.style)) unknownLayout = true;
    if (unknownLayout) return this.fallback(ctx, node, 'Unknown layout expression; add bindings or an adapter', this.attributes(props));
    if (/^[A-Z]/.test(tag) || opening.name.type === 'JSXMemberExpression') {
      if (node.children.length) props.children = { [slotValue]: { nodes: node.children, context: ctx, framework: 'jsx' } satisfies SourceSlot };
      this.record('component', tag, 'Expand source component', ctx, node);
      const adapter = this.target.adapters?.[tag];
      if (adapter) {
        const file = path.resolve(this.root, adapter); await this.scan(file);
        return this.component(file, 'default', props, ctx, node);
      }
      const imported = await this.componentReference(tag, ctx);
      if (imported?.file && /\.(tsx|jsx|vue|ts|js)$/.test(imported.file)) return this.component(imported.file, imported.exported, props, ctx, node);
      if (ctx.module.functions.has(tag)) {
        const local = { ...ctx, env: { ...ctx.env }, depth: ctx.depth + 1 };
        if (local.depth > 16) return this.fallback(ctx, node, 'Component recursion limit reached');
        const body = this.prepareFunction(ctx.module.functions.get(tag), local, props);
        return body ? this.jsx(body, local) : this.fallback(ctx, node, `Cannot expand ${tag}`);
      }
      const preset = await this.preset(tag, imported, props, node.children, ctx, node, 'jsx');
      if (preset !== undefined) return preset;
      return this.fallback(ctx, node, `No source adapter for ${tag}`, this.attributes(props));
    }
    if (!tag || tag.includes('-')) return this.fallback(ctx, node, `Unsupported element ${tag || 'dynamic component'}`, this.attributes(props));
    if (nonVisual.has(tag)) return '';
    const children = tag === 'p' && this.masked(ctx) ? this.text(ctx, node, true) : await this.jsxNodes(node.children, ctx);
    return this.element(tag, props, children, ctx, node);
  }
  private masked(ctx: RenderContext) { return ctx.mode === 'mask' || ctx.mode !== 'preserve' && !ctx.control; }
  private contentText(value: unknown, ctx: RenderContext, node: Ast): string {
    if (!this.masked(ctx) && (typeof value === 'string' || typeof value === 'number')) return escapeHTML(value);
    return this.text(ctx, node);
  }
  private contentContext(ctx: RenderContext, props: Record<string, Value>, tag = ''): RenderContext {
    let mode = ctx.mode;
    if (props['data-sk-preserve'] === true || props['data-sk-preserve'] === '' || props['data-sk-preserve'] === 'true') mode = 'preserve';
    if (props['data-sk-mask'] === true || props['data-sk-mask'] === '' || props['data-sk-mask'] === 'true') mode = 'mask';
    const control = ['button','label','select','option','input','textarea','nav','th'].includes(tag) ? !(['input','textarea'].includes(tag) && (props.readonly === true || props.readOnly === true)) : ctx.control;
    return { ...ctx, mode, control };
  }
  private renderSlot(slot: SourceSlot, ctx: RenderContext): Promise<string> {
    const parent = { ...slot.context, mode: ctx.mode, control: ctx.control, depth: Math.max(ctx.depth, slot.context.depth) };
    return slot.framework === 'vue' ? this.vueNodes(slot.nodes, parent) : this.jsxNodes(slot.nodes, parent);
  }
  private async componentReference(tag: string, ctx: RenderContext): Promise<ComponentReference | undefined> {
    const [root, ...members] = tag.split('.');
    const base = ctx.module.imports.get(root);
    const qualified = members.length && base ? { ...base, exported: base.exported === '*' ? members.join('.') : base.exported+'.'+members.join('.') } : undefined;
    const direct = ctx.module.imports.get(tag) ?? qualified ?? [...ctx.module.imports.entries()].find(([name]) => componentName(name) === componentName(tag))?.[1];
    if (direct?.file) return direct;
    const configured = Object.keys(this.options.components ?? {}).some(name => componentName(name) === componentName(tag));
    return configured ? (await this.globalComponents()).get(componentName(tag)) ?? direct : direct ?? (await this.globalComponents()).get(componentName(tag));
  }
  private async preset(tag: string, reference: ComponentReference | undefined, props: Record<string, Value>, nodes: Ast[], ctx: RenderContext, node: Ast, framework: 'vue' | 'jsx'): Promise<string | undefined> {
    const resolved = resolvePreset(this.options.componentPresets, reference);
    if (!resolved) return;
    const {preset,name} = resolved;
    const role = preset.role(name, props);
    const local = { ...ctx, control: role === 'control' ? true : role === 'data' ? false : ctx.control };
    const slots = preset.slots(name);
    const childrenNodes = framework === 'jsx' ? slots.includes('default') ? nodes : [] : nodes.flatMap((n: any) => {
      const slot = n.type === 1 && n.tag === 'template' ? n.props.find((p: any) => p.name === 'slot')?.arg?.content : undefined;
      return slot ? slots.includes(slot) ? n.children : [] : slots.includes('default') ? [n] : [];
    });
    const children = framework === 'vue' ? await this.vueNodes(childrenNodes, local) : await this.jsxNodes(childrenNodes, local);
    const presentation = preset.present(name, props, children, this.masked(local) ? this.text(local,node) : this.contentText(props.value ?? props.title ?? UNKNOWN,local,node), this.hints, {mask:this.masked(local)});
    if (!presentation) return;
    this.record('component',tag,`Use ${preset.id} ${role} adapter for ${reference!.request}::${reference!.exported}`,ctx,node);
    for (const note of presentation.notes ?? []) this.diagnose('PRESET_LIMIT',note,ctx,node);
    let html = this.element(presentation.tag, { ...props, class: [props.class ?? props.className,presentation.className], className: undefined, style: `${presentation.style ?? ''};${styleString(props.style)}` },presentation.children,local,node);
    if (presentation.css) this.css.set(`preset:${this.nodeId(ctx,node)}`,presentation.css);
    if ((presentation.leaf && this.masked(local) || ctx.mode === 'mask' && role === 'control') && !html.match(/^<[^>]* data-sk-leaf/)) html = html.replace(' data-sk-node=',' data-sk-leaf data-sk-node=');
    return html;
  }
  private attributes(props: Record<string, Value>): string {
    let attrs = '';
    for (const [key, value] of Object.entries(props)) {
      if (value === UNKNOWN || value == null) continue;
      if (key === 'className' || key === 'class') { const cls = classString(value); if (cls) attrs += ` class="${escapeHTML(cls)}"`; }
      else if (key === 'style') { const style = styleString(value); if (style) attrs += ` style="${escapeHTML(style)}"`; }
      else if (['width', 'height', 'colSpan', 'rowSpan', 'viewBox'].includes(key)) attrs += ` ${key.toLowerCase()}="${escapeHTML(value)}"`;
      else if (this.options.styles?.unocss && utilityAttribute(key)) attrs += ` ${key}="${value === true ? '' : escapeHTML(value)}"`;
      else if (['rows', 'cols'].includes(key) && typeof value !== 'object') attrs += ` ${key}="${escapeHTML(value)}"`;
      else if (key === 'size' && /^\d+$/.test(String(value))) attrs += ` size="${escapeHTML(value)}"`;
    }
    return attrs;
  }
  private element(tag: string, props: Record<string, Value>, children: string, ctx: RenderContext, node: Ast): string {
    let attrs = `${this.attributes(props)} data-sk-node="${this.nodeId(ctx, node)}"${ctx.scopes.map(s => ` ${s}`).join('')}`;
    if (ctx.control || ctx.mode === 'preserve') attrs += ' data-sk-control';
    if (props['data-sk-preserve'] != null) attrs += ' data-sk-preserve';
    if (tag === 'img') attrs += ` data-sk-image${this.masked(ctx) ? ' data-sk-leaf' : ''}` + '  alt="" src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27400%27 height=%27300%27/%3E"';
    if (['input', 'textarea', 'button', 'select'].includes(tag)) {
      attrs += `${this.masked(ctx) ? ' data-sk-leaf' : ''} tabindex="-1"`;
      for (const key of ['type','placeholder','value','checked','disabled','readonly','multiple','min','max','step']) {
        let value = props[key] ?? (key === 'value' ? props.modelValue : key === 'readonly' ? props.readOnly : undefined);
        if (value === UNKNOWN || value == null || value === false || typeof value === 'object' || typeof value === 'symbol') continue;
        if ((key === 'value' || key === 'placeholder') && this.masked(ctx) || key === 'value' && props.type === 'password') continue;
        if (key === 'type' && tag === 'button' && !['button','submit','reset'].includes(String(value))) value = 'button';
        attrs += ` ${key}="${escapeHTML(value === true ? '' : value)}"`;
      }
    }
    return voids.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${children}</${tag}>`;
  }
  private async vueNodes(nodes: any[], ctx: RenderContext): Promise<string> {
    let html = '';
    let inChain = false, selected = false;
    for (const node of nodes) {
      if (node.type === 3 || node.type === 2 && !node.content.trim()) continue;
      if (node.type === 1) {
        const condition = node.props.find((p: any) => p.type === 7 && ['if', 'else-if', 'else'].includes(p.name));
        if (condition) {
          if (condition.name === 'if') { inChain = true; selected = false; }
          if (selected && inChain) continue;
          const expr = condition.exp?.content ?? 'true';
          const result = evaluateString(expr, ctx);
          if (result !== UNKNOWN && !result) continue;
          if (result === UNKNOWN) this.diagnose('BRANCH_DEFAULT', `Unknown condition ${expr}: include this branch`, ctx, node);
          this.record('branch', expr, result === UNKNOWN ? 'Include first unresolved branch' : `Resolved to ${!!result}`, ctx, node);
          selected = true;
        } else { inChain = false; selected = false; }
      } else if (node.type !== 2) { inChain = false; selected = false; }
      html += await this.vueNode(node, ctx);
    }
    return html;
  }
  private async vueNode(node: any, ctx: RenderContext, skipFor = false): Promise<string> {
    const exhausted = this.budget(ctx, node);
    if (exhausted !== undefined) return exhausted;
    if (node.type === 2) return node.content.trim() ? this.contentText(node.content, ctx, node) : '';
    if (node.type === 5) { this.record('text', node.content.content, 'Resolve content policy for interpolation', ctx, node); return this.contentText(evaluateString(node.content.content, ctx), ctx, node); }
    if (node.type !== 1) return '';
    const loop = node.props.find((p: any) => p.type === 7 && p.name === 'for');
    if (loop && !skipFor) {
      const match = loop.exp?.content.match(/^\s*(.*?)\s+(?:in|of)\s+([\s\S]+)$/);
      if (!match) return this.fallback(ctx, node, 'Unsupported v-for expression');
      let patterns: Ast[];
      try {
        const aliases = match[1].trim().replace(/^\(([\s\S]*)\)$/, '$1');
        patterns = (parseExpression(`(${aliases}) => 0`, { plugins: ['typescript'] }) as any).params;
        if (!patterns.length || patterns.length > 3) throw new Error('Unsupported aliases');
      } catch { return this.fallback(ctx, node, 'Unsupported v-for aliases'); }
      const list = evaluateString(match[2], ctx);
      const entries = Array.isArray(list) ? list.map((value, index) => [value, index]) : list && list !== UNKNOWN && typeof list === 'object' ? Object.entries(list).map(([key, value]) => [value, key]) : undefined;
      const count = this.hints.repeat ?? (entries ? Math.min(entries.length, 24) : typeof list === 'number' && Number.isFinite(list) ? Math.min(Math.max(0, Math.floor(list)), 24) : 4);
      this.record('repeat', match[2], `Generate ${count} placeholders`, ctx, node);
      let html = '';
      for (let i = 0; i < count; i++) {
        const local: RenderContext = { ...ctx, env: { ...ctx.env } };
        bindPattern(patterns[0], entries ? entries[i] ? entries[i][0] : UNKNOWN : typeof list === 'number' ? i + 1 : UNKNOWN, local.env);
        if (patterns[1]) bindPattern(patterns[1], entries ? entries[i]?.[1] ?? i : i, local.env);
        if (patterns[2]) bindPattern(patterns[2], i, local.env);
        html += await this.vueNode(node, local, true);
      }
      return html;
    }
    const props: Record<string, Value> = Object.create(null);
    let unknownLayout = false;
    let htmlContent: string | undefined, textContent = false;
    for (const p of node.props) {
      if (p.type === 6) props[p.name] = p.value?.content ?? true;
      else if (p.name === 'bind' && !p.arg) {
        const spread = evaluateString(p.exp?.content ?? '', ctx);
        if (spread && spread !== UNKNOWN && typeof spread === 'object' && !Array.isArray(spread)) Object.assign(props, spread);
        else this.diagnose('SPREAD_UNKNOWN', 'Cannot resolve Vue v-bind object; provide source bindings', ctx, node);
      }
      else if (p.name === 'bind' && p.arg?.isStatic) {
        const key = p.arg.content;
        let value = evaluateString(p.exp?.content ?? key, ctx);
        if (value === UNKNOWN && ['class', 'style', 'width', 'height'].includes(key)) {
          value = evaluateString(p.exp?.content ?? key, { ...ctx, defaultBranches: true });
          this.diagnose('LAYOUT_UNKNOWN', value === UNKNOWN ? `Cannot resolve :${key}; using a local fallback` : `Unknown :${key} condition: use the first static branch`, ctx, node);
          if (value === UNKNOWN) unknownLayout = true;
        }
        props[key] = key === 'class' && props.class != null ? [props.class, value] : value;
      } else if (p.name === 'model') {
        if (!p.arg || p.arg.isStatic) props[p.arg?.content ?? 'modelValue'] = evaluateString(p.exp?.content ?? '', ctx);
      } else if (p.name === 'show') {
        const show = evaluateString(p.exp?.content ?? '', ctx);
        if (show !== UNKNOWN && !show) return '';
      } else if (p.name === 'text') textContent = true;
      else if (p.name === 'html') {
        const value = evaluateString(p.exp?.content ?? '', ctx);
        if (typeof value !== 'string' || value.length > 32768) return this.fallback(ctx, node, 'Dynamic v-html content needs an adapter', this.attributes(props));
        htmlContent = value;
      }
      else if (!['if', 'else', 'else-if', 'for', 'on', 'slot', 'model', 'once', 'memo', 'bind'].includes(p.name)) this.diagnose('DIRECTIVE_UNKNOWN', `Custom directive v-${p.name} may affect layout`, ctx, node);
    }
    const fallthrough = ctx.fallthrough;
    if (fallthrough && fallthrough.node === node) {
      for (const [key, value] of Object.entries(fallthrough.props)) {
        if (key === 'class' && props.class != null) props.class = [props.class, value];
        else if (key === 'style' && props.style != null) props.style = `${styleString(props.style)};${styleString(value)}`;
        else props[key] = value;
      }
    }
    const tag = node.tag;
    ctx = this.contentContext(ctx, props, tag);
    if (ctx.module.boundaries.has(tag) || tag === 'loading-boundary') return this.vueNodes(node.children, ctx);
    if (unknownGeometry(props.style)) unknownLayout = true;
    if (unknownLayout) return this.fallback(ctx, node, 'Unknown layout expression; add bindings or an adapter', this.attributes(props));
    if (['template', 'transition', 'Transition', 'transition-group', 'TransitionGroup', 'KeepAlive', 'keep-alive'].includes(tag)) return this.vueNodes(node.children, ctx);
    if (tag === 'slot') {
      const name = typeof props.name === 'string' ? props.name : 'default';
      return ctx.slots?.[name] ? this.renderSlot(ctx.slots[name], ctx) : node.children.length ? this.vueNodes(node.children, ctx) : '';
    }
    if (tag === 'component') {
      if (typeof props.is !== 'string' || !/^[a-zA-Z][\w-]*$/.test(props.is)) return this.fallback(ctx, node, 'Dynamic component requires a finite adapter', this.attributes(props));
      this.record('component', node.props.find((p: any) => p.arg?.content === 'is')?.exp?.content ?? 'is', `Select static component ${props.is}`, ctx, node);
      const selected = parseDOM(`<${props.is}/>`).children[0] as any;
      return this.vueNode({ ...node, tag: props.is, tagType: selected.tagType, props: node.props.filter((p: any) => p.name !== 'is' && p.arg?.content !== 'is' && p.name !== 'for') }, ctx, true);
    }
    const imported = await this.componentReference(tag, ctx);
    if (imported?.file || this.target.adapters?.[tag]) {
      const slots: Record<string, SourceSlot> = {};
      const defaults: any[] = [];
      for (const child of node.children) {
        const slot = child.type === 1 && child.tag === 'template' ? child.props.find((p: any) => p.type === 7 && p.name === 'slot') : undefined;
        if (slot) slots[slot.arg?.content ?? 'default'] = { nodes: child.children, context: ctx, framework: 'vue' };
        else defaults.push(child);
      }
      if (defaults.length) slots.default = { nodes: defaults, context: ctx, framework: 'vue' };
      props.__skSlots = slots;
      const adapter = this.target.adapters?.[tag];
      if (adapter) { const file = path.resolve(this.root, adapter); await this.scan(file); return this.component(file, 'default', props, ctx, node); }
    }
    if (imported?.file && /\.(vue|tsx|jsx|ts|js)$/.test(imported.file)) return this.component(imported.file, imported.exported, props, ctx, node);
    if (componentName(tag) === 'routerlink') return this.element('a', props, await this.vueNodes(node.children, ctx), ctx, node);
    const presentation = await this.preset(tag, imported, props, node.children, ctx, node, 'vue');
    if (presentation !== undefined) return presentation;
    if (node.tagType === 1) return this.fallback(ctx, node, `No source adapter for ${tag}`, this.attributes(props));
    if (nonVisual.has(tag)) return '';
    const children = htmlContent !== undefined ? this.staticHTML(htmlContent, ctx, node) : textContent || tag === 'p' && this.masked(ctx) ? this.text(ctx, node, true) : await this.vueNodes(node.children, ctx);
    if (['div', 'section', 'article', 'main', 'canvas'].includes(tag) && Object.hasOwn(props, 'ref') && htmlContent === undefined && !textContent && node.children.every((child: any) => child.type === 3 || child.type === 2 && !child.content.trim())) {
      // An empty imperative mount host has no source-visible internal tree.
      // Mask only its existing box; do not invent widget-specific geometry.
      this.diagnose('FALLBACK', 'Opaque native mount point: preserve source container geometry', ctx, node, this.nodeId(ctx, node));
      return this.element(tag, props, '', ctx, node).replace(' data-sk-node=', ` data-sk-opaque${this.masked(ctx) ? ' data-sk-leaf' : ''} data-sk-node=`);
    }
    return this.element(tag, props, children, ctx, node);
  }
  private staticHTML(source: string, ctx: RenderContext, origin: Ast): string {
    this.record('component', 'v-html', 'Replace bounded static HTML content with inert semantic placeholders', ctx, origin);
    const render = (node: any): string => {
      const exhausted = this.budget(ctx, origin);
      if (exhausted !== undefined) return exhausted;
      if (node.type === 2 || node.type === 5) {
        const value = node.content?.content ?? node.content ?? '';
        if (!this.masked(ctx)) return escapeHTML(value);
        // Keep word lengths and whitespace so prose can wrap naturally at the
        // container width. No original text reaches the output.
        return value.trim() ? `<span data-sk-node="${this.nodeId(ctx, origin)}" data-sk-prose data-sk-leaf style="box-decoration-break:clone;-webkit-box-decoration-break:clone">${escapeHTML(value.replace(/[^\s]/g, 'x'))}</span>` : ' ';
      }
      if (node.type !== 1 || nonVisual.has(node.tag)) return '';
      // HTML inserted with v-html is inert HTML, never a Vue template. Do not
      // interpret directives, components, event handlers, URLs or interpolation.
      if (node.tagType !== 0) return this.fallback(ctx, origin, `Unsupported static HTML element ${node.tag}`);
      const props = Object.fromEntries(node.props.filter((p: any) => p.type === 6).map((p: any) => [p.name, p.value?.content ?? true]));
      return this.element(node.tag, props, node.children.map(render).join(''), ctx, origin);
    };
    try { return parseDOM(source, { delimiters: ['\u0000', '\u0000'] }).children.map(render).join(''); }
    catch { return this.fallback(ctx, origin, 'Static HTML could not be parsed'); }
  }
  async compile(): Promise<{ view: { html: string; css: string }; dependencies: Record<string, string> }> {
    const source = path.resolve(this.root, this.target.source);
    await this.scan(source);
    for (const file of this.target.styles ?? []) {
      const resolved = path.resolve(this.root, file);
      this.css.set(resolved, (await loadStyle(resolved, f => this.read(f), undefined, undefined, this.options.styles)).css);
    }
    const content = await this.component(source, this.target.export ?? 'default');
    const html = `<div data-sk-artifact="${this.target.id}" aria-hidden="true" style="--skeleton-min-height:${this.hints.minHeight ?? 96}px">${content}</div>`;
    let css = '';
    try { css = scopeCSS([...this.css.values(), await utilityCSS(html, this.options.styles)].join('\n'), this.target.id); }
    catch (error) { this.diagnostics.push({ code: 'STYLE_PARSE', message: String(error), file: this.target.source, line: 1 }); }
    return { view: { html, css: `${css}\n${baseCSS}` }, dependencies: this.dependencies };
  }
}
export async function compileTarget(root: string, target: SkeletonTarget, aliases: Record<string, string> = {}, options: Pick<SkeletonConfig, 'components' | 'componentBindings' | 'componentDeclarations' | 'componentPresets' | 'styles'> = {}): Promise<{ artifact: SkeletonArtifact; dependencies: Record<string, string> }> {
  root = await realpath(root);
  const variants = target.variants && Object.keys(target.variants).length ? target.variants : { default: {} };
  const artifact: SkeletonArtifact = {
    id: target.id, kind: target.kind ?? 'request', render: target.render ?? 'light', source: target.source,
    defaultVariant: target.defaultVariant ?? Object.keys(variants)[0], variants: {}, diagnostics: [], evidence: [], sources: {},
  };
  let dependencies: Record<string, string> = {};
  for (const [name, hints] of Object.entries(variants)) {
    const compiler = new SourceCompiler(root, target, { ...target.hints, ...hints, bindings: { ...target.hints?.bindings, ...hints.bindings } }, aliases, options);
    const result = await compiler.compile();
    artifact.variants[name] = result.view;
    dependencies = { ...dependencies, ...result.dependencies };
    artifact.diagnostics.push(...compiler.diagnostics);
    artifact.evidence.push(...compiler.evidence);
    Object.assign(artifact.sources, compiler.sources);
  }
  artifact.diagnostics = [...new Map(artifact.diagnostics.map(d => [JSON.stringify(d), d])).values()];
  artifact.evidence = [...new Map(artifact.evidence.map(e => [JSON.stringify(e), e])).values()];
  return { artifact, dependencies };
}
