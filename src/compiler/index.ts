import type * as t from '@babel/types';
import { isRenderFunction, nodeName } from './ast.js';
import { loadingFrame, prepareRenderFunction } from './branches.js';
import { fallthroughAttrs, inheritRootScopes } from './attributes.js';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { type TemplateChildNode as VueNode, type ElementNode, type RootNode, type DirectiveNode, type ExpressionNode } from '@vue/compiler-dom';
import type { Diagnostic, Evidence, SkeletonArtifact, SkeletonHints, SkeletonTarget, SourceLocation, SkeletonView } from '../types.js';
import { diagnosticDetails } from './diagnostics.js';
import { UNKNOWN, bindPattern, evaluate, evaluateString, expressionText, sourceCapacity, type Ast, type Value } from './expression.js';
import { baseCSS, digest, scopeArtifactStyles, utilityCSS } from './styles.js';
import { componentName } from './components.js';
import { resolvePreset } from './presets/index.js';
import type { ComponentReference } from './presets/types.js';
import { TableColumns } from './presets/columns.js';
import { SourceModules, type CompilerOptions } from './modules.js';
import { vueOptions, vueOptionProps, vueRenderFunction, vueSetupFunction, prepareVueSetup, prepareVueRender, renderVueExpression } from './vue-render.js';
import { ambiguousExport, type ModuleInfo, type RenderContext, type SourceSlot, type SourceNode } from './context.js';
import { escapeHTML, styleString, visit } from './html.js';
import { renderAttributes, renderElement, renderStaticHTML } from './output.js';
import { renderJSX } from './react.js';
import { renderVueNodes, renderVueNode } from './vue.js';
import postcss from 'postcss';
import { embedStyleAssets } from './css-resources.js';
import { imageDimensions } from './images.js';
import { fallbackAttributes } from './fallback.js';
import { compileTailwind } from './tailwind.js';
import { fileURLToPath } from 'node:url';
import { pruneCSS } from './prune-css.js';
import {tableWrapper} from './table-wrapper.js';
import {VueRegion,bindSlotArgument,bindSlotInitial,projectSelectedSlots} from './regions.js';
import{presentationInputs}from'./initial-state.js';
import { SourceFiles } from './source-files.js';
import { sharedStyleSeparator } from '../shared.js';

export class SourceCompiler extends SourceModules {
  evidence: Evidence[] = [];
  sources: Record<string, SourceLocation> = {};
  private renderedNodes = 0;
  private budgetReported = false;
  private inlineStyles = new Map<string, { value: string; file: string }>();
  private sourceIds=new Set<string>();
  private region?:VueRegion;
  private expressions = new Map<string, t.Expression | null>();
  private tableColumns = new TableColumns();
  selectVueNode(node:VueNode,ctx:RenderContext){return this.region?.mode(node,ctx);}
  captureVueRegion(render:()=>Promise<string>){return this.region?this.region.capture(render):render();}
  hasSelectedSlot(slot:SourceSlot){return !!this.region?.active&&this.region.carries(slot);}
  constructor(root: string, readonly target: SkeletonTarget, hints: SkeletonHints, aliases: Record<string, string> = {}, options: CompilerOptions = {}, files?: SourceFiles) { super(root, hints, aliases, options, files); }
  diagnose(code: string, message: string, ctx: RenderContext, node?: SourceNode, id?: string) {
    const line = this.sourceLine(ctx, node);
    const diagnostic = { code, message, file: this.relative(ctx.module.file), line, node: id ?? (node ? this.nodeId(ctx, node) : undefined), ...diagnosticDetails(ctx, node) };
    this.diagnostics.push(diagnostic);
    return diagnostic;
  }
  record(kind: Evidence['kind'], expression: string, decision: string, ctx: RenderContext, node?: SourceNode) {
    this.evidence.push({ kind, expression, decision, file: this.relative(ctx.module.file), line: this.sourceLine(ctx, node), node: node ? this.nodeId(ctx, node) : undefined });
  }
  private sourceLine(ctx: RenderContext, node?: SourceNode) {
    return (node?.loc?.start?.line ?? 1) + (ctx.module.descriptor?.template && ctx.code === ctx.module.descriptor.template.content ? ctx.module.descriptor.template.loc.start.line - 1 : 0);
  }
  nodeId(ctx: RenderContext, node?: SourceNode): string {
    const id = digest(`${this.relative(ctx.module.file)}:${node?.start ?? node?.loc?.start.offset ?? 0}`).slice(0, 12);
    this.sources[id] = { file: this.relative(ctx.module.file), line: this.sourceLine(ctx, node) };
    return id;
  }
  fallback(ctx: RenderContext, node: SourceNode | undefined, message: string, attrs = '') {
    const id = this.nodeId(ctx, node);
    this.diagnose('FALLBACK', message, ctx, node, id);
    return `<div data-sk-node="${id}" data-sk-fallback${ctx.mode === 'preserve' ? ' data-sk-control' : ' data-sk-leaf'}${ctx.scopes.map(s => ` ${s}`).join('')}${fallbackAttributes(attrs, this.hints.minHeight)}></div>`;
  }
  text(ctx: RenderContext, node: SourceNode | undefined, multiline = false): string {
    const id = this.nodeId(ctx, node);
    if (ctx.mode === 'preserve') return `<span data-sk-node="${id}" data-sk-text>&nbsp;</span>`;
    if (multiline && (this.hints.lines ?? 1) > 1) return `<span data-sk-node="${id}" data-sk-multiline>${Array.from({ length: this.hints.lines! }, () => '<span></span>').join('')}</span>`;
    return `<span data-sk-node="${id}" data-sk-text data-sk-leaf${ctx.textWidth ? ` style="width:${ctx.textWidth};min-width:0"` : ''}>&nbsp;</span>`;
  }
  budget(ctx: RenderContext, node: SourceNode | undefined): string | undefined {
    if (++this.renderedNodes <= 6000) return;
    if (this.budgetReported) return '';
    this.budgetReported = true;
    return this.fallback(ctx, node, 'Static expansion budget reached; simplify the boundary or supply a local adapter');
  }
  private inheritRootScopes(html: string, scopes: string[], attrs: Record<string, Value> = {}, rootStyle = ''): string {
    return inheritRootScopes(html, scopes, attrs, rootStyle, props => this.attributes(props));
  }
  async jsxNodes(nodes: (Ast | null)[], ctx: RenderContext): Promise<string> {
    let html = '';
    for (const node of nodes) html += await this.jsx(node, ctx);
    return html;
  }
  private context(mod: ModuleInfo, props: Record<string, Value> = {}, parent?: RenderContext): RenderContext {
    const file = this.relative(mod.file);
    const prefix = `${file}::`;
    const scoped = Object.fromEntries(Object.entries(this.hints.bindings ?? {}).filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]));
    const bindings = { ...this.options.componentBindings?.[file], ...this.hints.bindings, ...scoped };
    const input=presentationInputs(props);
    const camelProps = Object.fromEntries(Object.entries(input.values).map(([key, value]) => [key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), value]));
    const values = { ...mod.propDefaults, ...input.values, ...camelProps };
    const initialValues={...input.initial};
    const env: Record<string, Value> = { ...mod.env, ...values, $slots: props.__skSlots ?? {}, $attrs: this.fallthroughAttrs(mod, props) };
    for (const name of mod.propBindings){env[name] = values;for(const[key,value]of Object.entries(input.initial))initialValues[name+'.'+key]=value;}
    for (const [name, value] of Object.entries(bindings)) if (/^[\w$]+$/.test(name)) env[name] = value;
    if (mod.descriptor?.scriptSetup) {
      for (const statement of mod.ast.program.body) {
        const declaration = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? statement.declaration ?? statement : statement;
        if (declaration.type !== 'VariableDeclaration') continue;
        for (const item of declaration.declarations) {
          if (item.id.type === 'Identifier' && mod.propBindings.includes(item.id.name)) continue;
          if(item.id.type==='Identifier'&&mod.sourceValues&&Object.hasOwn(mod.sourceValues,item.id.name)){
            const value=mod.sourceValues[item.id.name];
            if(sourceCapacity(value)!=null||value===UNKNOWN&&['ObjectExpression','ArrayExpression','Identifier'].includes(item.init?.type??'')){env[item.id.name]=value;continue;}
          }
          if (item.id.type === 'ObjectPattern' && item.init?.type === 'CallExpression' && nodeName(item.init.callee) === 'toRefs') {
            bindPattern(item.id, evaluate(item.init.arguments[0], { code: mod.code, env, bindings, unwrapRefs: true }), env);
          } else {
            const value=evaluate(item.init, { code: mod.code, env, bindings, unwrapRefs: true });
            bindPattern(item.id,value===UNKNOWN&&item.id.type==='Identifier'&&sourceCapacity(mod.env[item.id.name])!=null?mod.env[item.id.name]:value,env);
          }
        }
      }
    }
    return { module: mod, code: mod.code, env, bindings, expressions: this.expressions, initialValues, unwrapRefs: !!mod.descriptor, scopes: mod.scopes, depth: (parent?.depth ?? 0) + 1, slots: props.__skSlots as Record<string, SourceSlot> | undefined, mode: parent?.mode, control: parent?.control, textWidth: parent?.textWidth, loading: loadingFrame(this.hints.state, parent?.loading ?? this.target.kind === 'request') };
  }
  private fallthroughAttrs(mod: ModuleInfo, props: Record<string, Value>): Record<string, Value> {
    return fallthroughAttrs(mod, props);
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
  prepareFunction(fn: Ast | undefined, ctx: RenderContext, props: Record<string, Value>): Ast | undefined {
    return prepareRenderFunction(fn, ctx, props, test => {
      this.record('branch', expressionText(test, ctx), 'Unknown early-return guard: prefer the later content return', ctx, test);
    });
  }
  async component(file: string, exported: string, props: Record<string, Value> = {}, parent?: RenderContext, node?: SourceNode): Promise<string> {
    const selectedSlots=Object.values((props.__skSlots??{}) as Record<string,SourceSlot>).some(slot=>this.hasSelectedSlot(slot));
    if(this.region?.active&&parent&&file!==this.region.file&&!selectedSlots)return'';
    const resolved = await this.resolveExport(file, exported, !parent);
    const component = resolved === ambiguousExport ? undefined : resolved;
    const base = component?.module ?? await this.module(file);
    const options = vueOptions(base, component?.fn ?? base.functions.get('default'));
    const sourceValues=await this.moduleValues(base);
    const mod = {...base,sourceValues,env:{...base.env,...sourceValues},propDefaults:{...base.propDefaults}};
    if (options) vueOptionProps(mod, options);
    const ctx = this.context(mod, props, parent);
    const origin = parent && node ? parent : ctx;
    const opaque = (message: string) => this.fallback(origin, node, message, this.attributes(props));
    if (ctx.depth > 16) return opaque('Component recursion limit reached');
    if (!component) return opaque(`${resolved === ambiguousExport ? 'Ambiguous' : 'Cannot locate'} exported component ${exported}`);
    const setup = !mod.descriptor?.template ? vueSetupFunction(mod, component.fn ?? mod.functions.get('default')) : undefined;
    const render = setup ? prepareVueSetup.call(this,setup,ctx,props) : vueRenderFunction(mod, component.fn ?? mod.functions.get('default'));
    if(setup&&!render){
      const projection=tableWrapper(mod,setup,this.options.componentPresets,{...mod.propDefaults,...props},!!ctx.loading);
      if(projection){
        let html=await this.preset(exported,projection.reference,projection.columns?{...props,columns:projection.columns}:props,{framework:'render',nodes:[],context:ctx},setup);
        if(html!==undefined){
          if(projection.viewportOffset!==undefined){html=html.replace(' data-sk-node=',` data-sk-viewport-bottom="${projection.viewportOffset}" data-sk-node=`);this.record('component','viewport height','Follow a source-proved own-table viewport constraint',origin,node);}
          if(projection.pagination){const pager=await this.preset('pagination',projection.pagination.reference,projection.pagination.props,{framework:'render',nodes:[],context:ctx},setup);if(pager!==undefined)html=`<div style="width:100%">${html}${pager}</div>`;}
          this.diagnose('PRESET_LIMIT','Source-proven table frame: wrapper callbacks, conditional UI and runtime style overrides remain unresolved',origin,node);return this.inheritRootScopes(html,parent?.scopes??[],{},'');
        }
      }
    }
    if (render && !mod.descriptor?.template) {
      const body = prepareVueRender.call(this, render, ctx, setup ? {} : props, !!options && !setup);
      if (!body) return opaque('Vue render body requires a finite presentation adapter');
      if(selectedSlots&&this.region?.active){await projectSelectedSlots(this,body,ctx);return'';}
      this.record('component', exported, 'Statically expand a Vue render function without executing business code', origin, node);
      return this.inheritRootScopes(await this.vueExpression(body, ctx), parent?.scopes ?? [], mod.inheritAttrs ? this.fallthroughAttrs(mod, props) : {});
    }
    if (mod.descriptor) {
      const rootStyle = this.cssVariables(ctx);
      if (!mod.descriptor.scriptSetup && mod.descriptor.script) {
        this.diagnose('VUE_OPTIONS', 'Options API script values are not interpreted; use bindings for dynamic layout', ctx);
      }
      const template = mod.descriptor.template;
      if (!template) return opaque('Vue component has no static template');
      if (template.lang && template.lang !== 'html') return opaque(`Template language ${template.lang} needs an adapter`);
      const ast = this.files.template(mod.file, template.content);
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
        const previous=this.region,selection=new VueRegion(mod.file,region);this.region=selection;
        try{
          await this.vueNodes(ast.children,ctx);
          return this.inheritRootScopes(selection.result??this.fallback(ctx,region,'Cannot resolve the loading region through its source slot context'),[],{},rootStyle);
        }finally{this.region=previous;}
      }
      return this.inheritRootScopes(await this.vueNodes(ast.children, ctx), parent?.scopes ?? [], mod.inheritAttrs && !root ? this.fallthroughAttrs(mod, props) : {}, rootStyle);
    }
    const fn = component.fn;
    if (!fn) return opaque(`Cannot locate exported component ${exported}`);
    if (!isRenderFunction(fn)) return opaque(`Unsupported component declaration ${fn.type}`);
    const body = this.prepareFunction(fn, ctx, props);
    if (this.target.region && ctx.depth === 1) {
      let region: t.JSXElement | undefined;
      visit(fn.body, n => {
        if (n.type === 'JSXElement' && mod.boundaries.has(nodeName(n.openingElement.name) ?? '') && n.openingElement.attributes.some((a: Ast) => a.type === 'JSXAttribute' && a.name.name === 'artifact' && a.value?.type === 'JSXExpressionContainer' && a.value.expression.type === 'Identifier' && a.value.expression.name === this.target.region) && n.children.some((c: Ast) => c.type !== 'JSXText' || c.value.trim())) region = n;
      });
      return region ? this.jsxNodes(region.children, ctx) : this.fallback(ctx, node, `Missing source region ${this.target.region}`);
    }
    return body ? this.jsx(body, ctx) : this.fallback(ctx, fn.body, `No supported render return in ${exported}`);
  }
  jsx(node: Ast | null | undefined, ctx: RenderContext): Promise<string> { return renderJSX.call(this, node, ctx); }
  vueExpression(node: Ast | null | undefined, ctx: RenderContext): Promise<string> { return renderVueExpression.call(this, node, ctx); }
  masked(ctx: RenderContext) { return ctx.mode === 'mask' || ctx.mode !== 'preserve' && !ctx.control; }
  contentText(value: unknown, ctx: RenderContext, node: SourceNode | undefined): string {
    if (!this.masked(ctx) && (typeof value === 'string' || typeof value === 'number')) return escapeHTML(value);
    if (this.masked(ctx) && !ctx.textWidth && (typeof value === 'string' || typeof value === 'number' && Number.isFinite(value))) {
      // Transparent source-visible text keeps the actual font advances, line
      // breaks and intrinsic size. The browser lays it out without measuring DOM.
      return value === '' ? '' : `<span data-sk-node="${this.nodeId(ctx, node)}" data-sk-text data-sk-measured data-sk-leaf data-sk-text-content="${escapeHTML(value)}"></span>`;
    }
    return this.text(ctx, node);
  }
  contentContext(ctx: RenderContext, props: Record<string, Value>, tag = ''): RenderContext {
    let mode = ctx.mode;
    if (props['data-sk-preserve'] === true || props['data-sk-preserve'] === '' || props['data-sk-preserve'] === 'true') mode = 'preserve';
    if (props['data-sk-mask'] === true || props['data-sk-mask'] === '' || props['data-sk-mask'] === 'true') mode = 'mask';
    const control = ['button','label','select','option','input','textarea','nav','th'].includes(tag) ? !(['input','textarea'].includes(tag) && (props.readonly === true || props.readOnly === true)) : ctx.control;
    let textWidth = ctx.textWidth;
    if (props['data-sk-text-width'] != null) {
      const width = String(props['data-sk-text-width']);
      if (/^(?:0|\d+(?:\.\d+)?(?:px|em|rem|ch|ex|%|vw|vh))$/.test(width)) textWidth = width;
      else this.diagnose('PLACEHOLDER_HINT', 'data-sk-text-width must be a nonnegative CSS length or percentage', ctx);
    }
    return { ...ctx, mode, control, textWidth };
  }
  async renderSlot(slot: SourceSlot, ctx: RenderContext, argument:Value = {},initial:Value=UNKNOWN): Promise<string> {
    const parent = { ...slot.context,env:{...slot.context.env},initialValues:{...slot.context.initialValues}, mode: ctx.mode, control: ctx.control, textWidth: ctx.textWidth, depth: Math.max(ctx.depth, slot.context.depth) };
    if(slot.parameter){bindSlotArgument(slot.parameter,argument,parent);bindSlotInitial(slot.parameter,initial,parent);}
    if(slot.renderFunction){
      const fn=slot.renderFunction;
      if(!isRenderFunction(fn))return this.fallback(parent,fn,'Unsupported source slot function');
      const body=this.prepareFunction({...fn,params:[]},parent,{});
      if(body&&this.hasSelectedSlot(slot)){await projectSelectedSlots(this,body,parent);return'';}
      return this.vueExpression(body,parent);
    }
    if (slot.framework === 'vue') return this.vueNodes(slot.nodes, parent);
    if (slot.framework === 'jsx') return this.jsxNodes(slot.nodes, parent);
    let html = '';
    for (const node of slot.nodes) html += await this.vueExpression(node, parent);
    return html;
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
  async preset(tag: string, reference: ComponentReference | undefined, props: Record<string, Value>, slot: SourceSlot, node: SourceNode): Promise<string | undefined> {
    const ctx = slot.context;
    const resolved = resolvePreset(this.options.componentPresets, reference);
    if (!resolved) return;
    const {preset,name} = resolved;
    // Vue component props use camelCase even when templates spell them with
    // hyphens. Keep original keys for adapters that accept library aliases.
    props = { ...props };
    for (const [key,value] of Object.entries(props)) if (!/^(?:data|aria)-/.test(key)) {
      const camel = key.replace(/-([a-z])/g, (_match,letter:string)=>letter.toUpperCase());
      if (!(camel in props)) props[camel] = value;
    }
    const role = preset.role(name, props);
    const local = { ...ctx, control: role === 'control' ? true : role === 'data' ? false : ctx.control };
    const slots = preset.slots(name);
    const renderedSlots: Record<string,string> = {};
    for (const key of slots) {
      renderedSlots[key] = slot.framework === 'render'
        ? slot.slots?.[key] ? await this.renderSlot(slot.slots[key], local) : key === 'default' ? await this.renderSlot(slot, local) : ''
        : slot.framework === 'jsx'
        ? key === 'default' ? await this.jsxNodes(slot.nodes, local) : ''
        : await this.vueNodes(slot.nodes.flatMap(n => {
          const name = n.type === 1 && n.tag === 'template' ? n.props.find((p): p is DirectiveNode => p.type === 7 && p.name === 'slot')?.arg : undefined;
          return name?.type === 4 && n.type === 1 ? name.content === key ? n.children : [] : key === 'default' ? [n] : [];
        }), local);
    }
    const children = slots.map(key=>renderedSlots[key]).join('');
    const presentation = preset.present(name, props, children, this.masked(local) ? this.text(local,node) : this.contentText(props.value ?? props.title ?? UNKNOWN,local,node), {...this.hints,state:this.hints.state??(local.loading?'loading':'source')}, {mask:this.masked(local),slots:renderedSlots,columns:this.tableColumns});
    if (!presentation) return;
    // Own primitive wrappers use border-box; source slot nodes keep the source
    // box model instead of being globally forced to border-box.
    presentation.children=presentation.children.replace(/<[a-z][^<>]*>/gi,tag=>tag.includes('data-sk-node=')||tag.includes('data-sk-layout')?tag:tag.replace(/\/?\>$/,end=>' data-sk-layout'+end));
    this.record('component',tag,`Use ${preset.id} ${role} adapter for ${reference!.request}::${reference!.exported}`,ctx,node);
    for (const note of presentation.notes ?? []) this.diagnose('PRESET_LIMIT',note,ctx,node);
    let html = this.element(presentation.tag, { ...props, class: [props.class ?? props.className,presentation.className], className: undefined, style: `${presentation.style ?? ''};${styleString(props.style)}` },presentation.children,local,node);
    html=html.replace(' data-sk-node=',' data-sk-layout data-sk-node=');
    // One source node can render multiple instances with different props. Keep
    // every distinct presentation stylesheet and deduplicate identical ones.
    if (presentation.css) this.css.set(`preset:${digest(presentation.css)}`,presentation.css);
    if ((presentation.leaf && this.masked(local) || ctx.mode === 'mask' && role === 'control') && !html.match(/^<[^>]* data-sk-leaf/)) html = html.replace(' data-sk-node=',' data-sk-leaf data-sk-node=');
    return html;
  }
  attributes(props: Record<string, Value>): string { if((typeof props.id==='string'||typeof props.id==='number')&&String(props.id))this.sourceIds.add(String(props.id));return renderAttributes.call(this, props); }
  element(tag: string, props: Record<string, Value>, children: string, ctx: RenderContext, node: SourceNode | undefined): string {
    let value = styleString(props.style);
    if (/(?:^|;)\s*display\s*:\s*inline(?:-flex|-grid|-block)?\s*(?:;|$)/.test(value)) {
      value += ';--sk-inline-footprint:1em';
      props = {...props,style:value};
    }
    if (/url\s*\(/i.test(value)) {
      const key = digest(`${ctx.module.file}:${value}`).slice(0, 16);
      this.inlineStyles.set(key, { value, file: ctx.module.file });
      props = { ...props, style: `--sk-inline-${key}:0` };
    }
    return renderElement.call(this, tag, props, children, ctx, node);
  }
  vueNodes(nodes: VueNode[], ctx: RenderContext): Promise<string> { return renderVueNodes.call(this, nodes, ctx); }
  vueNode(node: VueNode, ctx: RenderContext, skipFor = false): Promise<string> { return renderVueNode.call(this, node, ctx, skipFor); }
  staticHTML(source: string, ctx: RenderContext, origin: Ast): string { return renderStaticHTML.call(this, source, ctx, origin); }
  async image(props: Record<string, Value>, ctx: RenderContext, node: SourceNode): Promise<string> {
    const source = props.src;
    let size: ReturnType<typeof imageDimensions>;
    if (typeof source === 'string') {
      try {
        let bytes: Uint8Array | undefined;
        if (source.startsWith('data:image/')) {
          const match = /^data:image\/[^;,]+(;base64)?,([\s\S]*)$/.exec(source);
          if (match) bytes = match[1] ? Buffer.from(match[2], 'base64') : Buffer.from(decodeURIComponent(match[2]));
        } else if (!/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(source) || source.startsWith('file:')) {
          const file = source.startsWith('file:') ? fileURLToPath(source) : source.startsWith('/')
            ? await this.resolve(path.join(this.root, 'public', '__entry'), `.${source}`)
            : await this.resolve(ctx.module.file, source);
          if (file) bytes = await this.readAsset(file);
        }
        if (bytes) size = imageDimensions(bytes);
      } catch (error) {
        this.diagnose('IMAGE_GEOMETRY', `Cannot read local image dimensions: ${String(error)}`, ctx, node);
      }
    }
    return this.element('img', { ...props, __skImageSize: size }, '', ctx, node);
  }
  async compile(): Promise<{ view: SkeletonView; dependencies: Record<string, string> }> {
    const source = path.resolve(this.root, this.target.source);
    await this.entryStyles();
    await this.scan(source);
    for (const file of this.target.styles ?? []) {
      const resolved = path.resolve(this.root, file);
      this.css.set(resolved, (await this.readStyle(resolved)).css);
    }
    const content = await this.component(source, this.target.export ?? 'default');
    let html = `<div data-sk-artifact="${this.target.id}" aria-hidden="true" style="--skeleton-min-height:${this.hints.minHeight ?? 96}px">${content}</div>`;
    for (const [key, style] of this.inlineStyles) {
      const root = postcss.parse(`a{${style.value}}`, { from: style.file });
      await embedStyleAssets(root, style.file, file => this.readAsset(file), (request, from) => this.resolve(from, request));
      html = html.replaceAll(`--sk-inline-${key}:0`, escapeHTML(root.first!.toString().slice(2, -1)));
    }
    const compiledStyles = await compileTailwind([...this.css.values()].join('\n'), html, this.styleSource(), async file => (await this.readStyle(file)).css, this.options.styles?.tailwind !== false);
    if (compiledStyles.sourcesIgnored) this.diagnostics.push({ code: 'STYLE_SOURCE_LIMIT', file: this.target.source, line: 1, message: 'Tailwind uses generated markup and inline safelists only; external @source paths are not scanned' });
    let css = '';
    try { const styles=[compiledStyles.css, await utilityCSS(html, this.options.styles)].join('\n');({ html, css } = scopeArtifactStyles(this.options.styles?.prune===false?styles:pruneCSS(styles,html), html, this.target.id)); }
    catch (error) { this.diagnostics.push({ code: 'STYLE_PARSE', message: String(error), file: this.target.source, line: 1 }); }
    return { view: { html, css: `${css}\n${sharedStyleSeparator}${baseCSS.replace(/sk-pulse/g, 'skelcast-base-pulse-v1')}`,sourceIds:[...this.sourceIds].sort() }, dependencies: this.dependencies };
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
  const diagnostics = new Map<string, Diagnostic>();
  const evidence = new Map<string, Evidence>();
  const files = new SourceFiles();
  for (const [name, hints] of Object.entries(variants)) {
    const compiler = new SourceCompiler(root, target, { ...target.hints, ...hints, bindings: { ...target.hints?.bindings, ...hints.bindings } }, aliases, options, files);
    const result = await compiler.compile();
    artifact.variants[name] = result.view;
    dependencies = { ...dependencies, ...result.dependencies };
    collectVariants(diagnostics, compiler.diagnostics, name);
    collectVariants(evidence, compiler.evidence, name);
    Object.assign(artifact.sources, compiler.sources);
  }
  artifact.diagnostics = [...diagnostics.values()];
  artifact.evidence = [...evidence.values()];
  return { artifact, dependencies };
}

function collectVariants<T extends { variants?: string[] }>(collection: Map<string, T>, items: T[], variant: string) {
  for (const item of items) {
    const key = JSON.stringify(item), previous = collection.get(key);
    if (!previous) collection.set(key, { ...item, variants: [variant] });
    else if (!previous.variants?.includes(variant)) previous.variants?.push(variant);
  }
}
