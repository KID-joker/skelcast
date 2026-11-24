import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseJS } from '@babel/parser';
import { parse as parseSFC } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import type { Diagnostic, Evidence, SkeletonArtifact, SkeletonHints, SkeletonTarget, SourceLocation } from '../types.js';
import { UNKNOWN, bindPattern, evaluate, evaluateString, expressionText, type Ast, type ExpressionContext, type Value } from './expression.js';
import { baseCSS, digest, loadStyle, scopeCSS } from './styles.js';

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
  imports: Map<string, { file: string; exported: string }>;
  env: Record<string, Value>;
  descriptor?: ReturnType<typeof parseSFC>['descriptor'];
  scopes: string[];
  boundaries: Set<string>;
}
interface RenderContext extends ExpressionContext { module: ModuleInfo; scopes: string[]; depth: number; slots?: Record<string, string> }

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
  constructor(private root: string, private target: SkeletonTarget, private hints: SkeletonHints, private aliases: Record<string, string> = {}) {}
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
      try { if ((await stat(base + ext)).isFile()) return base + ext; } catch { /* next */ }
    }
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
    return `<div data-sk-node="${id}" data-sk-fallback data-sk-leaf${attrs} style="${style ? `${style};` : ''}min-height:${this.hints.minHeight ?? 96}px"></div>`;
  }
  private text(ctx: RenderContext, node: Ast, multiline = false): string {
    const id = this.nodeId(ctx, node);
    if (multiline && (this.hints.lines ?? 1) > 1) return `<span data-sk-node="${id}" data-sk-multiline>${Array.from({ length: this.hints.lines! }, () => '<span></span>').join('')}</span>`;
    return `<span data-sk-node="${id}" data-sk-text data-sk-leaf>&nbsp;</span>`;
  }
  private budget(ctx: RenderContext, node: Ast): string | undefined {
    if (++this.renderedNodes <= 6000) return;
    if (this.budgetReported) return '';
    this.budgetReported = true;
    return this.fallback(ctx, node, 'Static expansion budget reached; simplify the boundary or supply a local adapter');
  }
  private inheritRootScopes(html: string, scopes: string[]): string {
    if (!scopes.length || !html) return html;
    const roots = baseParse(html).children.filter((n: any) => n.type === 1) as any[];
    for (const node of roots.reverse()) {
      const extra = scopes.filter(s => !node.props.some((p: any) => p.name === s));
      const offset = node.loc.start.offset + node.tag.length + 1;
      html = html.slice(0, offset) + extra.map(s => ` ${s}`).join('') + html.slice(offset);
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
    if (file.endsWith('.css')) { this.css.set(file, (await loadStyle(file, f => this.read(f))).css); return; }
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
    const mod: ModuleInfo = { file, code, ast, descriptor, functions: new Map(), imports: new Map(), env: Object.create(null), scopes: [], boundaries: new Set(['LoadingBoundary']) };
    const ec = { code, env: mod.env, bindings: this.hints.bindings ?? {} };
    for (const statement of ast.program.body) {
      const decl = statement.declaration ?? statement;
      if (decl.type === 'FunctionDeclaration' && decl.id) mod.functions.set(decl.id.name, decl);
      if (decl.type === 'VariableDeclaration') for (const d of decl.declarations) {
        let init = d.init;
        if (init?.type === 'CallExpression' && ['memo', 'forwardRef'].includes(init.callee.name)) init = init.arguments[0];
        if (d.id.type === 'Identifier' && ['ArrowFunctionExpression', 'FunctionExpression'].includes(init?.type)) mod.functions.set(d.id.name, init);
        else bindPattern(d.id, evaluate(d.init, ec), mod.env);
      }
      if (statement.type === 'ExportDefaultDeclaration') {
        const d = statement.declaration;
        if (d.type === 'Identifier') mod.functions.set('default', d);
        else if (d.type === 'CallExpression' && ['memo', 'forwardRef'].includes(d.callee.name)) mod.functions.set('default', d.arguments[0]);
        else mod.functions.set('default', d);
      }
      if (statement.type === 'ImportDeclaration') {
        if (['skelcast/react', 'skelcast/vue'].includes(statement.source.value)) for (const spec of statement.specifiers) if (spec.imported?.name === 'LoadingBoundary') mod.boundaries.add(spec.local.name);
        const resolved = await this.resolve(file, statement.source.value);
        for (const spec of statement.specifiers) if (resolved) mod.imports.set(spec.local.name, { file: resolved, exported: spec.type === 'ImportDefaultSpecifier' ? 'default' : spec.imported?.name ?? 'default' });
        if (resolved?.endsWith('.css')) {
          const { css, mapping } = await loadStyle(resolved, f => this.read(f));
          this.css.set(resolved, css);
          for (const spec of statement.specifiers) mod.env[spec.local.name] = mapping;
        }
      }
      if (statement.type === 'ExportNamedDeclaration') for (const spec of statement.specifiers ?? []) {
        const name = spec.exported.name;
        if (resolvedIdentifier(spec.local)) mod.functions.set(name, spec.local);
      }
    }
    if (descriptor) {
      const scopeId = `data-v-sk-${digest(this.relative(file)).slice(0, 8)}`;
      for (let i = 0; i < descriptor.styles.length; i++) {
        const style = descriptor.styles[i];
        if (style.lang && style.lang !== 'css') {
          this.diagnostics.push({ code: 'STYLE_UNSUPPORTED', message: `Style language ${style.lang} needs an adapter`, file: this.relative(file), line: style.loc.start.line }); continue;
        }
        const styleFile = style.src ? await this.resolve(file, style.src) : file;
        if (!styleFile) continue;
        if (style.scoped && !mod.scopes.includes(scopeId)) mod.scopes.push(scopeId);
        const { css, mapping } = await loadStyle(style.module ? `${styleFile}.module.css` : styleFile, f => this.read(f), style.scoped ? scopeId : undefined, style.src ? await this.read(styleFile) : style.content);
        this.css.set(`${file}:${i}`, css);
        if (style.module) mod.env[typeof style.module === 'string' ? style.module : '$style'] = mapping;
        if (/v-bind\s*\(/.test(style.content)) this.diagnostics.push({ code: 'STYLE_BINDING', message: 'CSS v-bind requires an explicit static style hint or CSS variable default', file: this.relative(file), line: style.loc.start.line });
      }
    }
    return mod;
  }
  private context(mod: ModuleInfo, props: Record<string, Value> = {}, parent?: RenderContext): RenderContext {
    return { module: mod, code: mod.code, env: { ...mod.env, ...props }, bindings: this.hints.bindings ?? {}, scopes: mod.scopes, depth: (parent?.depth ?? 0) + 1, slots: props.__skSlots as Record<string, string> | undefined };
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
    const mod = await this.module(file);
    const ctx = this.context(mod, props, parent);
    if (ctx.depth > 16) return this.fallback(ctx, node, 'Component recursion limit reached');
    if (mod.descriptor) {
      if (!mod.descriptor.scriptSetup) {
        this.diagnose('VUE_OPTIONS', 'Options API script values are not interpreted; use bindings for dynamic layout', ctx);
      }
      const template = mod.descriptor.template;
      if (!template) return this.fallback(ctx, node, 'Vue component has no static template');
      if (template.lang && template.lang !== 'html') return this.fallback(ctx, node, `Template language ${template.lang} needs an adapter`);
      const ast = baseParse(template.content);
      ctx.code = template.content;
      if (this.target.region && ctx.depth === 1) {
        let region: any;
        const find = (n: any) => {
          if (n.type === 1 && mod.boundaries.has(n.tag) && n.props.some((p: any) => p.type === 7 && p.name === 'bind' && p.arg?.content === 'artifact' && p.exp?.content === this.target.region)) region = n;
          for (const child of n.children ?? []) find(child);
        };
        find(ast);
        if (!region) return this.fallback(ctx, node, `Missing source region ${this.target.region}`);
        return this.vueNodes(region.children, ctx);
      }
      return this.inheritRootScopes(await this.vueNodes(ast.children, ctx), parent?.scopes ?? []);
    }
    let fn = mod.functions.get(exported);
    const seen = new Set<string>();
    while (fn?.type === 'Identifier' && !seen.has(fn.name)) { seen.add(fn.name); fn = mod.functions.get(fn.name); }
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
    if (node.type === 'JSXText') return node.value.trim() ? this.text(ctx, node) : '';
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
      if (value && typeof value === 'object' && Object.hasOwn(value, '__skHTML')) return String((value as any).__skHTML);
      this.record('text', expressionText(node, ctx), 'Replace content with text placeholder', ctx, node);
      return this.text(ctx, node);
    }
    const opening = node.openingElement;
    const tag = opening.name.type === 'JSXIdentifier' ? opening.name.name : '';
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
    if (ctx.module.boundaries.has(tag)) return this.jsxNodes(node.children, ctx);
    if (unknownGeometry(props.style)) unknownLayout = true;
    if (unknownLayout) return this.fallback(ctx, node, 'Unknown layout expression; add bindings or an adapter', this.attributes(props));
    if (/^[A-Z]/.test(tag)) {
      if (node.children.length) props.children = { __skHTML: await this.jsxNodes(node.children, ctx) };
      this.record('component', tag, 'Expand source component', ctx, node);
      const adapter = this.target.adapters?.[tag];
      if (adapter) {
        const file = path.resolve(this.root, adapter); await this.scan(file);
        return this.component(file, 'default', props, ctx, node);
      }
      const imported = ctx.module.imports.get(tag);
      if (imported && /\.(tsx|jsx|vue|ts|js)$/.test(imported.file)) return this.component(imported.file, imported.exported, props, ctx, node);
      if (ctx.module.functions.has(tag)) {
        const local = { ...ctx, env: { ...ctx.env }, depth: ctx.depth + 1 };
        if (local.depth > 16) return this.fallback(ctx, node, 'Component recursion limit reached');
        const body = this.prepareFunction(ctx.module.functions.get(tag), local, props);
        return body ? this.jsx(body, local) : this.fallback(ctx, node, `Cannot expand ${tag}`);
      }
      return this.fallback(ctx, node, `No source adapter for ${tag}`, this.attributes(props));
    }
    if (!tag || tag.includes('-')) return this.fallback(ctx, node, `Unsupported element ${tag || 'dynamic component'}`, this.attributes(props));
    if (nonVisual.has(tag)) return '';
    const children = tag === 'p' ? this.text(ctx, node, true) : await this.jsxNodes(node.children, ctx);
    return this.element(tag, props, children, ctx, node);
  }
  private attributes(props: Record<string, Value>): string {
    let attrs = '';
    for (const [key, value] of Object.entries(props)) {
      if (value === UNKNOWN || value == null) continue;
      if (key === 'className' || key === 'class') { const cls = classString(value); if (cls) attrs += ` class="${escapeHTML(cls)}"`; }
      else if (key === 'style') { const style = styleString(value); if (style) attrs += ` style="${escapeHTML(style)}"`; }
      else if (['width', 'height', 'colSpan', 'rowSpan', 'viewBox'].includes(key)) attrs += ` ${key.toLowerCase()}="${escapeHTML(value)}"`;
    }
    return attrs;
  }
  private element(tag: string, props: Record<string, Value>, children: string, ctx: RenderContext, node: Ast): string {
    let attrs = `${this.attributes(props)} data-sk-node="${this.nodeId(ctx, node)}"${ctx.scopes.map(s => ` ${s}`).join('')}`;
    if (tag === 'img') attrs += ' data-sk-image data-sk-leaf alt="" src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27400%27 height=%27300%27/%3E"';
    if (['input', 'textarea', 'button', 'select', 'hr'].includes(tag)) attrs += ' data-sk-leaf tabindex="-1"';
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
    if (node.type === 2) return node.content.trim() ? this.text(ctx, node) : '';
    if (node.type === 5) { this.record('text', node.content.content, 'Replace interpolation', ctx, node); return this.text(ctx, node); }
    if (node.type !== 1) return '';
    const loop = node.props.find((p: any) => p.type === 7 && p.name === 'for');
    if (loop && !skipFor) {
      const match = loop.exp?.content.match(/^\s*\(?\s*([\w$]+)(?:\s*,\s*([\w$]+))?\s*\)?\s+(?:in|of)\s+(.+)$/);
      if (!match) return this.fallback(ctx, node, 'Unsupported v-for expression');
      const list = evaluateString(match[3], ctx);
      const count = this.hints.repeat ?? (Array.isArray(list) && list.length ? Math.min(list.length, 12) : typeof list === 'number' ? Math.min(Math.max(0, list), 12) : 4);
      this.record('repeat', match[3], `Generate ${count} placeholders`, ctx, node);
      let html = '';
      for (let i = 0; i < count; i++) {
        const local: RenderContext = { ...ctx, env: { ...ctx.env, [match[1]]: Array.isArray(list) ? list[i] ?? UNKNOWN : typeof list === 'number' ? i + 1 : UNKNOWN } };
        if (match[2]) local.env[match[2]] = i;
        html += await this.vueNode(node, local, true);
      }
      return html;
    }
    const props: Record<string, Value> = Object.create(null);
    let unknownLayout = false;
    for (const p of node.props) {
      if (p.type === 6) props[p.name] = p.value?.content ?? true;
      else if (p.name === 'bind' && p.arg?.isStatic) {
        const key = p.arg.content;
        let value = evaluateString(p.exp?.content ?? key, ctx);
        if (value === UNKNOWN && ['class', 'style', 'width', 'height'].includes(key)) {
          value = evaluateString(p.exp?.content ?? key, { ...ctx, defaultBranches: true });
          this.diagnose('LAYOUT_UNKNOWN', value === UNKNOWN ? `Cannot resolve :${key}; using a local fallback` : `Unknown :${key} condition: use the first static branch`, ctx, node);
          if (value === UNKNOWN) unknownLayout = true;
        }
        props[key] = key === 'class' && props.class != null ? [props.class, value] : value;
      } else if (p.name === 'show') {
        const show = evaluateString(p.exp?.content ?? '', ctx);
        if (show !== UNKNOWN && !show) return '';
      } else if (['html', 'text'].includes(p.name)) return this.fallback(ctx, node, `Dynamic v-${p.name} content needs an adapter`);
      else if (!['if', 'else', 'else-if', 'for', 'on', 'slot', 'model', 'once', 'memo', 'bind'].includes(p.name)) this.diagnose('DIRECTIVE_UNKNOWN', `Custom directive v-${p.name} may affect layout`, ctx, node);
    }
    const tag = node.tag;
    if (ctx.module.boundaries.has(tag) || tag === 'loading-boundary') return this.vueNodes(node.children, ctx);
    if (unknownGeometry(props.style)) unknownLayout = true;
    if (unknownLayout) return this.fallback(ctx, node, 'Unknown layout expression; add bindings or an adapter', this.attributes(props));
    if (tag === 'template') return this.vueNodes(node.children, ctx);
    if (tag === 'slot') {
      const name = typeof props.name === 'string' ? props.name : 'default';
      return ctx.slots?.[name] ?? (node.children.length ? this.vueNodes(node.children, ctx) : this.fallback(ctx, node, `No source content for slot ${name}`));
    }
    if (tag === 'component') return this.fallback(ctx, node, 'Dynamic component requires a finite adapter');
    const imported = ctx.module.imports.get(tag) ?? [...ctx.module.imports.entries()].find(([name]) => name.replace(/[A-Z]/g, (c, i) => `${i ? '-' : ''}${c.toLowerCase()}`) === tag)?.[1];
    if (imported || this.target.adapters?.[tag]) {
      const slots: Record<string, string> = {};
      const defaults: any[] = [];
      for (const child of node.children) {
        const slot = child.type === 1 && child.tag === 'template' ? child.props.find((p: any) => p.type === 7 && p.name === 'slot') : undefined;
        if (slot) slots[slot.arg?.content ?? 'default'] = await this.vueNodes(child.children, ctx);
        else defaults.push(child);
      }
      if (defaults.length) slots.default = await this.vueNodes(defaults, ctx);
      props.__skSlots = slots;
      const adapter = this.target.adapters?.[tag];
      if (adapter) { const file = path.resolve(this.root, adapter); await this.scan(file); return this.component(file, 'default', props, ctx, node); }
    }
    if (imported && /\.(vue|tsx|jsx|ts|js)$/.test(imported.file)) return this.component(imported.file, imported.exported, props, ctx, node);
    if (node.tagType === 1) return this.fallback(ctx, node, `No source adapter for ${tag}`, this.attributes(props));
    if (nonVisual.has(tag)) return '';
    const children = tag === 'p' ? this.text(ctx, node, true) : await this.vueNodes(node.children, ctx);
    return this.element(tag, props, children, ctx, node);
  }
  async compile(): Promise<{ view: { html: string; css: string }; dependencies: Record<string, string> }> {
    const source = path.resolve(this.root, this.target.source);
    await this.scan(source);
    for (const file of this.target.styles ?? []) {
      const resolved = path.resolve(this.root, file);
      this.css.set(resolved, (await loadStyle(resolved, f => this.read(f))).css);
    }
    const content = await this.component(source, this.target.export ?? 'default');
    const html = `<div data-sk-artifact="${this.target.id}" aria-hidden="true" style="--skeleton-min-height:${this.hints.minHeight ?? 96}px">${content}</div>`;
    let css = '';
    try { css = scopeCSS([...this.css.values()].join('\n'), this.target.id); }
    catch (error) { this.diagnostics.push({ code: 'STYLE_PARSE', message: String(error), file: this.target.source, line: 1 }); }
    return { view: { html, css: `${css}\n${baseCSS}` }, dependencies: this.dependencies };
  }
}
function resolvedIdentifier(node: Ast) { return node?.type === 'Identifier'; }

export async function compileTarget(root: string, target: SkeletonTarget, aliases: Record<string, string> = {}): Promise<{ artifact: SkeletonArtifact; dependencies: Record<string, string> }> {
  root = await realpath(root);
  const variants = target.variants && Object.keys(target.variants).length ? target.variants : { default: {} };
  const artifact: SkeletonArtifact = {
    id: target.id, kind: target.kind ?? 'request', render: target.render ?? 'light', source: target.source,
    defaultVariant: target.defaultVariant ?? Object.keys(variants)[0], variants: {}, diagnostics: [], evidence: [], sources: {},
  };
  let dependencies: Record<string, string> = {};
  for (const [name, hints] of Object.entries(variants)) {
    const compiler = new SourceCompiler(root, target, { ...target.hints, ...hints, bindings: { ...target.hints?.bindings, ...hints.bindings } }, aliases);
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
