import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseDOM, type TemplateChildNode as VueNode, type ElementNode, type RootNode, type DirectiveNode, type ExpressionNode } from '@vue/compiler-dom';
import type { Evidence, SkeletonArtifact, SkeletonHints, SkeletonTarget, SourceLocation } from '../types.js';
import { UNKNOWN, bindPattern, evaluate, evaluateString, expressionText, type Ast, type Value } from './expression.js';
import { baseCSS, digest, loadStyle, scopeCSS, utilityCSS } from './styles.js';
import { componentName } from './components.js';
import { resolvePreset } from './presets/index.js';
import type { ComponentReference } from './presets/types.js';
import { SourceModules, type CompilerOptions } from './modules.js';
import { ambiguousExport, type ModuleInfo, type RenderContext, type SourceSlot } from './context.js';
import { escapeHTML, styleString, classString, visit } from './html.js';
import { renderAttributes, renderElement, renderStaticHTML } from './output.js';
import { renderJSX } from './react.js';
import { renderVueNodes, renderVueNode } from './vue.js';

export class SourceCompiler extends SourceModules {
  evidence: Evidence[] = [];
  sources: Record<string, SourceLocation> = {};
  private renderedNodes = 0;
  private budgetReported = false;
  constructor(root: string, readonly target: SkeletonTarget, hints: SkeletonHints, aliases: Record<string, string> = {}, options: CompilerOptions = {}) { super(root, hints, aliases, options); }
  diagnose(code: string, message: string, ctx: RenderContext, node?: Ast, id?: string) {
    const line = this.sourceLine(ctx, node);
    this.diagnostics.push({ code, message, file: this.relative(ctx.module.file), line, node: id });
  }
  record(kind: Evidence['kind'], expression: string, decision: string, ctx: RenderContext, node?: Ast) {
    this.evidence.push({ kind, expression, decision, file: this.relative(ctx.module.file), line: this.sourceLine(ctx, node) });
  }
  private sourceLine(ctx: RenderContext, node?: Ast) {
    return (node?.loc?.start?.line ?? 1) + (ctx.module.descriptor?.template && ctx.code === ctx.module.descriptor.template.content ? ctx.module.descriptor.template.loc.start.line - 1 : 0);
  }
  nodeId(ctx: RenderContext, node?: Ast): string {
    const id = digest(`${this.relative(ctx.module.file)}:${node?.start ?? node?.loc?.start?.offset ?? 0}`).slice(0, 12);
    this.sources[id] = { file: this.relative(ctx.module.file), line: this.sourceLine(ctx, node) };
    return id;
  }
  fallback(ctx: RenderContext, node: Ast, message: string, attrs = '') {
    const id = this.nodeId(ctx, node);
    this.diagnose('FALLBACK', message, ctx, node, id);
    const style = attrs.match(/ style="([^"]*)"/)?.[1];
    attrs = attrs.replace(/ style="[^"]*"/, '');
    return `<div data-sk-node="${id}" data-sk-fallback${ctx.mode === 'preserve' ? ' data-sk-control' : ' data-sk-leaf'}${attrs} style="${style ? `${style};` : ''}min-height:${this.hints.minHeight ?? 96}px"></div>`;
  }
  text(ctx: RenderContext, node: Ast, multiline = false): string {
    const id = this.nodeId(ctx, node);
    if (ctx.mode === 'preserve') return `<span data-sk-node="${id}" data-sk-text>&nbsp;</span>`;
    if (multiline && (this.hints.lines ?? 1) > 1) return `<span data-sk-node="${id}" data-sk-multiline>${Array.from({ length: this.hints.lines! }, () => '<span></span>').join('')}</span>`;
    return `<span data-sk-node="${id}" data-sk-text data-sk-leaf>&nbsp;</span>`;
  }
  budget(ctx: RenderContext, node: Ast): string | undefined {
    if (++this.renderedNodes <= 6000) return;
    if (this.budgetReported) return '';
    this.budgetReported = true;
    return this.fallback(ctx, node, 'Static expansion budget reached; simplify the boundary or supply a local adapter');
  }
  private inheritRootScopes(html: string, scopes: string[], attrs: Record<string, Value> = {}, rootStyle = ''): string {
    if (!html) return html;
    const roots = parseDOM(html).children.filter((node): node is ElementNode => node.type === 1);
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
      const extra = scopes.filter(s => !node.props.some(prop => prop.name === s));
      const offset = node.loc.start.offset + node.tag.length + 1;
      html = html.slice(0, offset) + inherited + extra.map(s => ` ${s}`).join('') + html.slice(offset);
    }
    return html;
  }
  async jsxNodes(nodes: Ast[], ctx: RenderContext): Promise<string> {
    let html = '';
    for (const node of nodes) html += await this.jsx(node, ctx);
    return html;
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
  prepareFunction(fn: Ast, ctx: RenderContext, props: Record<string, Value>): Ast | undefined {
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
  async component(file: string, exported: string, props: Record<string, Value> = {}, parent?: RenderContext, node?: Ast): Promise<string> {
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
      const roots = ast.children.filter(child => child.type === 1 || child.type === 5 || child.type === 2 && child.content.trim());
      const root = roots.length === 1 && roots[0].type === 1 && roots[0].tag !== 'template' && !mod.boundaries.has(roots[0].tag) ? roots[0] : undefined;
      if (mod.inheritAttrs && root) ctx.fallthrough = { node: root, props: this.fallthroughAttrs(mod, props) };
      if (this.target.region && ctx.depth === 1) {
        let region: ElementNode | undefined;
        const find = (n: RootNode | VueNode | ExpressionNode) => {
          if (n.type === 1 && mod.boundaries.has(n.tag) && n.props.some(p => p.type === 7 && p.name === 'bind' && p.arg?.type === 4 && p.arg.content === 'artifact' && p.exp?.type === 4 && p.exp.content === this.target.region)) region = n;
          if ('children' in n) for (const child of n.children) if (typeof child === 'object') find(child);
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
  jsx(node: Ast, ctx: RenderContext): Promise<string> { return renderJSX.call(this, node, ctx); }
  masked(ctx: RenderContext) { return ctx.mode === 'mask' || ctx.mode !== 'preserve' && !ctx.control; }
  contentText(value: unknown, ctx: RenderContext, node: Ast): string {
    if (!this.masked(ctx) && (typeof value === 'string' || typeof value === 'number')) return escapeHTML(value);
    return this.text(ctx, node);
  }
  contentContext(ctx: RenderContext, props: Record<string, Value>, tag = ''): RenderContext {
    let mode = ctx.mode;
    if (props['data-sk-preserve'] === true || props['data-sk-preserve'] === '' || props['data-sk-preserve'] === 'true') mode = 'preserve';
    if (props['data-sk-mask'] === true || props['data-sk-mask'] === '' || props['data-sk-mask'] === 'true') mode = 'mask';
    const control = ['button','label','select','option','input','textarea','nav','th'].includes(tag) ? !(['input','textarea'].includes(tag) && (props.readonly === true || props.readOnly === true)) : ctx.control;
    return { ...ctx, mode, control };
  }
  renderSlot(slot: SourceSlot, ctx: RenderContext): Promise<string> {
    const parent = { ...slot.context, mode: ctx.mode, control: ctx.control, depth: Math.max(ctx.depth, slot.context.depth) };
    return slot.framework === 'vue' ? this.vueNodes(slot.nodes, parent) : this.jsxNodes(slot.nodes, parent);
  }
  async componentReference(tag: string, ctx: RenderContext): Promise<ComponentReference | undefined> {
    const [root, ...members] = tag.split('.');
    const base = ctx.module.imports.get(root);
    const qualified = members.length && base ? { ...base, exported: base.exported === '*' ? members.join('.') : base.exported+'.'+members.join('.') } : undefined;
    const direct = ctx.module.imports.get(tag) ?? qualified ?? [...ctx.module.imports.entries()].find(([name]) => componentName(name) === componentName(tag))?.[1];
    if (direct?.file) return direct;
    const configured = Object.keys(this.options.components ?? {}).some(name => componentName(name) === componentName(tag));
    return configured ? (await this.globalComponents()).get(componentName(tag)) ?? direct : direct ?? (await this.globalComponents()).get(componentName(tag));
  }
  async preset(tag: string, reference: ComponentReference | undefined, props: Record<string, Value>, nodes: Ast[], ctx: RenderContext, node: Ast, framework: 'vue' | 'jsx'): Promise<string | undefined> {
    const resolved = resolvePreset(this.options.componentPresets, reference);
    if (!resolved) return;
    const {preset,name} = resolved;
    const role = preset.role(name, props);
    const local = { ...ctx, control: role === 'control' ? true : role === 'data' ? false : ctx.control };
    const slots = preset.slots(name);
    const childrenNodes = framework === 'jsx' ? slots.includes('default') ? nodes : [] : (nodes as VueNode[]).flatMap(n => {
      const slot = n.type === 1 && n.tag === 'template' ? n.props.find((p): p is DirectiveNode => p.type === 7 && p.name === 'slot')?.arg : undefined;
      return slot && slot.type === 4 && n.type === 1 ? slots.includes(slot.content) ? n.children : [] : slots.includes('default') ? [n] : [];
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
  attributes(props: Record<string, Value>): string { return renderAttributes.call(this, props); }
  element(tag: string, props: Record<string, Value>, children: string, ctx: RenderContext, node: Ast): string { return renderElement.call(this, tag, props, children, ctx, node); }
  vueNodes(nodes: VueNode[], ctx: RenderContext): Promise<string> { return renderVueNodes.call(this, nodes, ctx); }
  vueNode(node: VueNode, ctx: RenderContext, skipFor = false): Promise<string> { return renderVueNode.call(this, node, ctx, skipFor); }
  staticHTML(source: string, ctx: RenderContext, origin: Ast): string { return renderStaticHTML.call(this, source, ctx, origin); }
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
export async function compileTarget(root: string, target: SkeletonTarget, aliases: Record<string, string> = {}, options: CompilerOptions = {}): Promise<{ artifact: SkeletonArtifact; dependencies: Record<string, string> }> {
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
