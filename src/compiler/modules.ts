import type * as t from '@babel/types';
import { isRenderFunction, nodeName, unwrapExpression } from './ast.js';
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import type { Diagnostic, SkeletonConfig, SkeletonHints } from '../types.js';
import { UNKNOWN, CLASS_HELPER, bindPattern, evaluate, type Ast } from './expression.js';
import { digest, loadStyle, bindStyleVariables } from './styles.js';
import { componentName, declarationComponents } from './components.js';
import type { ComponentReference } from './presets/types.js';
import { ambiguousExport, type ModuleInfo, type ResolvedComponent } from './context.js';
import { visit } from './html.js';
import { resolveStylesheet, type StyleSource } from './stylesheet-source.js';
import { parse as parseDOM } from '@vue/compiler-dom';
import { StaticValues } from './static-values.js';
import { identityArgument } from './identity-wrapper.js';
import { vueOptions } from './vue-render.js';
import { resolutionCandidates } from './resolution.js';
import { SourceFiles } from './source-files.js';
import { resolveReexports } from './exports.js';

export type CompilerOptions = Pick<SkeletonConfig, 'components' | 'componentBindings' | 'componentDeclarations' | 'componentPresets' | 'styles'>;

export class SourceModules {
  dependencies: Record<string, string> = {};
  diagnostics: Diagnostic[] = [];
  protected modules = new Map<string, Promise<ModuleInfo>>();
  protected css = new Map<string, string>();
  protected scanned = new Set<string>();
  protected registry?: Promise<Map<string, ComponentReference>>;
  private styleLoads = new Map<string, ReturnType<typeof loadStyle>>();
  private staticValues = new StaticValues(file=>this.module(file),request=>this.helperModule(request));
  private helperPackages=new Map<string,Promise<ModuleInfo|undefined>>();
  private helperModule(request:string){let result=this.helperPackages.get(request);if(!result){result=this.packageModule(request,false);this.helperPackages.set(request,result);}return result;}
  private entryScripts=new Set<string>();
  protected moduleValues(mod:ModuleInfo) { return this.staticValues.environment(mod); }
  constructor(readonly root: string, readonly hints: SkeletonHints, protected aliases: Record<string, string> = {}, readonly options: CompilerOptions = {}, protected files = new SourceFiles()) {}
  relative(file: string) { return path.relative(this.root, file).split(path.sep).join('/'); }
  async read(file: string): Promise<string> {
    const source = await this.files.read(file);
    this.dependencies[this.relative(source.file)] = source.hash;
    return source.bytes.toString('utf8');
  }
  async readAsset(file: string): Promise<Uint8Array> {
    const source = await this.files.read(file);
    this.dependencies[this.relative(source.file)] = source.hash;
    return source.bytes;
  }
  protected styleSource(): StyleSource {
    const read = async (file: string) => {
      try { return await this.read(file); }
      catch (error) { if (['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) this.dependencies[this.relative(file)] = '!missing'; throw error; }
    };
    return { root: this.root, aliases: this.aliases, read };
  }
  protected readStyle(file: string, scopedId?: string, inline?: string, lang?: string) {
    const key = JSON.stringify([file, scopedId, inline, lang]);
    const existing = this.styleLoads.get(key);
    if (existing) return existing;
    const io = this.styleSource();
    const resolve = async (request: string, from: string) => {
      const local = await this.resolve(from, request);
      if (local) return local;
      if (/^[a-z][\w+.-]*:|^\/\//i.test(request)) return;
      try { return await resolveStylesheet(request, from, io); }
      catch (error) { if (String(error).includes('Cannot resolve stylesheet')) return; throw error; }
    };
    const result = loadStyle(file, io.read, scopedId, inline, this.options.styles, lang, f => this.readAsset(f), resolve, io);
    this.styleLoads.set(key, result);
    return result;
  }
  protected async entryStyles(): Promise<void> {
    const io = this.styleSource();
    let html: string;
    try { html = await io.read(path.join(this.root, 'index.html')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const scripts: string[] = [], sheets: string[] = [];
    const visit = (node: ReturnType<typeof parseDOM> | ReturnType<typeof parseDOM>['children'][number] | import('@vue/compiler-dom').SimpleExpressionNode) => {
      if (node.type === 1) {
        const attrs = Object.fromEntries(node.props.filter(p=>p.type===6).map(p=>[p.name,p.value?.content]));
        if (node.tag === 'script' && attrs.type === 'module' && attrs.src) scripts.push(attrs.src);
        if (node.tag === 'link' && attrs.rel === 'stylesheet' && attrs.href) sheets.push(attrs.href);
      }
      if ('children' in node) for (const child of node.children) if (typeof child === 'object') visit(child);
    };
    visit(parseDOM(html));
    const local = (url: string) => !/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(url);
    for (const url of scripts.filter(local)) {
      const file = path.resolve(this.root, url.split(/[?#]/)[0].replace(/^\//,''));
      const code = await io.read(file);
      this.entryScripts.add(file);
      const ast = this.files.ast(file, code);
      for (const statement of ast.program.body) if (statement.type === 'ImportDeclaration' && /\.(?:css|less|scss|sass)(?:[?#].*)?$/.test(statement.source.value)) {
        const request = statement.source.value.split(/[?#]/)[0];
        const dep = await resolveStylesheet(request.startsWith('/') ? path.join(this.root,request) : request, file, io);
        this.css.set(dep, (await this.readStyle(dep)).css);
      }
    }
    for (const url of sheets.filter(local)) {
      const request = url.split(/[?#]/)[0];
      let file: string;
      try { file = await resolveStylesheet(`.${request.startsWith('/') ? request : '/'+request}`, path.join(this.root,'public','__entry.css'), io); }
      catch { file = await resolveStylesheet(`.${request.startsWith('/') ? request : '/'+request}`, path.join(this.root,'__entry.css'), io); }
      this.css.set(file, (await this.readStyle(file)).css);
    }
  }
  async resolve(from: string, request: string): Promise<string | undefined> {
    for (const candidate of resolutionCandidates(this.root, from, request, this.aliases, true)) {
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
      // Direct registrations and source-proven plugin installers are data, not
      // application execution. Explicit/declaration mappings retain precedence.
      for(const file of this.entryScripts){
        const mod=await this.module(file),apps=new Set<string>();
        for(const statement of mod.ast.program.body)if(statement.type==='VariableDeclaration')for(const d of statement.declarations)if(d.id.type==='Identifier'&&d.init?.type==='CallExpression'&&d.init.callee.type==='Identifier'){
          const ref=mod.imports.get(d.init.callee.name);if(ref?.request==='vue'&&ref.exported==='createApp')apps.add(d.id.name);
        }
        const calls:t.CallExpression[]=[];visit(mod.ast,n=>{if(n.type==='CallExpression'&&n.callee.type==='MemberExpression'&&!n.callee.computed)calls.push(n);});
        const root=(n:t.Node):string|undefined=>n.type==='Identifier'?n.name:n.type==='CallExpression'&&n.callee.type==='MemberExpression'?root(n.callee.object):undefined;
        for(const call of calls){
          if(call.callee.type!=='MemberExpression'||!apps.has(root(call.callee.object)??''))continue;
          const method=nodeName(call.callee.property),first=call.arguments[0];
          if(method==='component'&&first?.type==='StringLiteral'&&call.arguments[1]?.type==='Identifier'){
            const ref=mod.imports.get(call.arguments[1].name);if(ref&&!result.has(componentName(first.value)))result.set(componentName(first.value),ref);
          }
          if(method!=='use'||first?.type!=='Identifier')continue;
          const imported=mod.imports.get(first.name);if(!imported||imported.file)continue;
          const plugin=await this.packageModule(imported.request);if(!plugin)continue;
          const resolved=await this.resolveExport(plugin.file,imported.exported);if(!resolved||resolved===ambiguousExport||!resolved.fn)continue;
          const options=vueOptions(resolved.module,resolved.fn);if(!options)continue;
          const name=options.properties.find(p=>p.type==='ObjectProperty'&&nodeName(p.key)==='name');
          if(name?.type!=='ObjectProperty'||name.value.type!=='StringLiteral')continue;
          let registeredName:string|undefined;
          const registrations:{node:t.CallExpression;parameter:string}[]=[];
          let definition=plugin.functions.get(plugin.exports.get(imported.exported)??'');const seen=new Set<string>();
          while(definition?.type==='Identifier'&&!seen.has(definition.name)){seen.add(definition.name);definition=plugin.functions.get(definition.name);}
          if(definition?.type==='CallExpression'&&definition.arguments[1]?.type==='ObjectExpression')for(const n of definition.arguments[1].properties){
            const fn=n.type==='ObjectProperty'&&nodeName(n.key)==='install'&&isRenderFunction(n.value)?n.value:n.type==='ObjectMethod'&&nodeName(n.key)==='install'?n:undefined;
            const parameter=fn?.params[0];if(!fn||parameter?.type!=='Identifier')continue;
            visit(fn.body,c=>{if(c.type==='CallExpression'&&c.callee.type==='MemberExpression'&&c.callee.object.type==='Identifier'&&c.callee.object.name===parameter.name&&nodeName(c.callee.property)==='component')registrations.push({node:c,parameter:parameter.name});});
          }
          for(const {node}of registrations){const value=node.arguments[1];if(value?.type!=='Identifier')continue;const component=await this.resolveExport(plugin.file,value.name,true);if(component&&component!==ambiguousExport&&component.module===resolved.module&&component.fn===resolved.fn){const key=node.arguments[0];if(key?.type==='StringLiteral')registeredName=key.value;else if(key?.type==='MemberExpression'&&key.object.type==='Identifier'&&key.object.name===value.name&&nodeName(key.property)==='name')registeredName=name.value.value;}}
          if(registeredName&&!result.has(componentName(registeredName)))result.set(componentName(registeredName),{request:imported.request,exported:imported.exported,file:plugin.file});
        }
      }
      return result;
    })();
  }
  private async packageModule(request:string,libraryPlugin=true):Promise<ModuleInfo|undefined>{
    if(libraryPlugin&&!this.options.componentPresets?.length||request.startsWith('.')||request.startsWith('/'))return;
    const name=request.startsWith('@')?request.split('/').slice(0,2).join('/'):request.split('/')[0];
    if(name!==request)return;
    const directory=path.join(this.root,'node_modules',name),file=path.join(directory,'package.json');
    try{
      const text=await this.read(file);this.dependencies[this.relative(file)]=digest(text);
      const meta=JSON.parse(text),dependencies={...meta.dependencies,...meta.peerDependencies};
      if(libraryPlugin&&!this.options.componentPresets?.some(name=>Object.hasOwn(dependencies,name)))return;
      const entry=meta.module??meta.exports?.['.']?.import??meta.main;
      if(typeof entry!=='string'||!entry.startsWith('.')&&path.isAbsolute(entry))return;
      const source=path.resolve(directory,entry);if(path.relative(directory,source).startsWith('..')||!/\.[cm]?js$/.test(source))return;
      const contents=await this.read(source);if(contents.length>500000)return;
      return this.module(source);
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'||error instanceof SyntaxError)return;throw error;}
  }
  async scan(file: string): Promise<void> {
    if (this.scanned.has(file)) return;
    this.scanned.add(file);
    const text = await this.read(file);
    if (/\.(css|less|scss|sass)$/.test(file)) { this.css.set(file, (await this.readStyle(file)).css); return; }
    // Conservative import graph: include helpers even when not expanded in the render tree.
    const { code, sfc } = this.files.script(file, text);
    const jsx = sfc ? [sfc.descriptor.script?.lang, sfc.descriptor.scriptSetup?.lang].some(lang => lang === 'jsx' || lang === 'tsx') : undefined;
    try {
      const ast = this.files.ast(file, code, jsx);
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
    const { code, sfc } = this.files.script(file, raw);
    if (sfc?.errors.length) throw new Error(String(sfc.errors[0]));
    const descriptor = sfc?.descriptor;
    const ast = this.files.ast(file, code, descriptor ? [descriptor.script?.lang, descriptor.scriptSetup?.lang].some(lang => lang === 'jsx' || lang === 'tsx') : undefined);
    const classHelpers = new Set<string>();
    for (const statement of ast.program.body) if (statement.type === 'ImportDeclaration' && ['clsx', 'classnames'].includes(statement.source.value) && statement.importKind !== 'type') {
      for (const specifier of statement.specifiers) if (specifier.type === 'ImportDefaultSpecifier' || specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' && ['clsx', 'default'].includes(nodeName(specifier.imported) ?? '')) classHelpers.add(specifier.local.name);
    }
    const mod: ModuleInfo = { file, code, ast, descriptor, functions: new Map(), imports: new Map(), exports: new Map(), reexports: new Map(), exportAll: [], env: Object.create(null), scopes: [], boundaries: new Set(['LoadingBoundary']), propDefaults: {}, propBindings: [], inheritAttrs: true, cssBindings: [] };
    const ec = { code, env: mod.env, bindings: this.hints.bindings ?? {} };
    for (const statement of ast.program.body) {
      const decl = statement.type === 'ExportDefaultDeclaration' || statement.type === 'ExportNamedDeclaration' ? statement.declaration ?? statement : statement;
      if (decl.type === 'FunctionDeclaration' && decl.id) { mod.functions.set(decl.id.name, decl); mod.env[decl.id.name] = UNKNOWN; }
      if (decl.type === 'VariableDeclaration') for (const d of decl.declarations) {
        let init: t.Node | null | undefined = unwrapExpression(d.init);
        if (init?.type === 'CallExpression' && ['memo', 'forwardRef'].includes(nodeName(init.callee) ?? '')) init = init.arguments[0];
        if (d.id.type === 'Identifier' && init && (isRenderFunction(init) || init.type === 'CallExpression' || init.type === 'ObjectExpression' || init.type === 'Identifier')) mod.functions.set(d.id.name, init);
        if (!isRenderFunction(init)) bindPattern(d.id, evaluate(d.init, ec), mod.env);
      }
      if (statement.type === 'ExportDefaultDeclaration') {
        mod.exports.set('default', 'default');
        const d = unwrapExpression(statement.declaration)!;
        if (d.type === 'Identifier') mod.functions.set('default', d);
        else if (d.type === 'CallExpression' && ['memo', 'forwardRef'].includes(nodeName(d.callee) ?? '')) { if (d.arguments[0]) mod.functions.set('default', d.arguments[0]); }
        else mod.functions.set('default', d);
      }
      if (statement.type === 'ImportDeclaration') {
        for (const spec of statement.specifiers) mod.env[spec.local.name] = classHelpers.has(spec.local.name) ? CLASS_HELPER : UNKNOWN;
        if (['skelcast/react', 'skelcast/vue'].includes(statement.source.value)) for (const spec of statement.specifiers) {
          if (spec.type === 'ImportSpecifier' && nodeName(spec.imported) === 'LoadingBoundary') mod.boundaries.add(spec.local.name);
          if (spec.type === 'ImportNamespaceSpecifier') mod.boundaries.add(`${spec.local.name}.LoadingBoundary`);
        }
        const resolved = await this.resolve(file, statement.source.value);
        if (resolved && /\.(?:png|jpe?g|gif|webp|svg)$/i.test(resolved) && !/[?&](?:raw|inline)(?:[=&]|$)/.test(statement.source.value)) {
          for (const spec of statement.specifiers) if (spec.type === 'ImportDefaultSpecifier') mod.env[spec.local.name] = pathToFileURL(resolved).href;
        }
        for (const spec of statement.specifiers) if ((spec.type !== 'ImportSpecifier' || spec.importKind !== 'type') && statement.importKind !== 'type') mod.imports.set(spec.local.name, {
          file: resolved, request: statement.source.value,
          exported: spec.type === 'ImportNamespaceSpecifier' ? '*' : spec.type === 'ImportDefaultSpecifier' ? 'default' : nodeName(spec.imported)!,
        });
        if (resolved && /\.(css|less|scss|sass)$/.test(resolved)) {
          const { css, mapping } = await this.readStyle(resolved);
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
      visit(ast, node => {
        if (node.type !== 'ObjectProperty' || nodeName(node.key) !== 'components' || node.value.type !== 'ObjectExpression') return;
        for (const prop of node.value.properties) if (prop.type === 'ObjectProperty' && mod.boundaries.has(nodeName(prop.value) ?? '')) {
          const name = nodeName(prop.key);
          if (name) mod.boundaries.add(name);
        }
      });
      for (const name of [...mod.boundaries]) mod.boundaries.add(name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase());
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
        if (style.lang && style.lang !== 'css' && !(style.lang === 'less' && this.options.styles?.less) && !(['scss','sass'].includes(style.lang) && this.options.styles?.sass !== false)) {
          this.diagnostics.push({ code: 'STYLE_UNSUPPORTED', message: `Style language ${style.lang} needs an adapter`, file: this.relative(file), line: style.loc.start.line }); continue;
        }
        const styleFile = style.src ? await this.resolve(file, style.src) : file;
        if (!styleFile) continue;
        if (style.scoped && !mod.scopes.includes(scopeId)) mod.scopes.push(scopeId);
        const bound = bindStyleVariables(style.src ? await this.read(styleFile) : style.content, this.relative(file));
        mod.cssBindings.push(...bound.bindings.map(binding => ({ ...binding, line: binding.line + (style.src ? 0 : style.loc.start.line - 1) })));
        const { css, mapping } = await this.readStyle(style.module ? `${styleFile}.module.css` : styleFile, style.scoped ? scopeId : undefined, bound.css, style.lang);
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
    const binding = mod.exports.get(exported) ?? (allowLocal && (mod.functions.has(exported)||mod.imports.has(exported)) ? exported : undefined);
    if (binding !== undefined) {
      let local: string = binding;
      const bindings = new Set<string>();
      while (!bindings.has(local)) {
        bindings.add(local);
        const fn = mod.functions.get(local);
        if (fn?.type === 'Identifier') { local = fn.name; continue; }
        if (fn) {
          if(fn.type==='CallExpression'&&fn.callee.type==='MemberExpression'&&fn.callee.object.type==='Identifier'&&fn.callee.object.name==='Object'&&!Object.hasOwn(mod.env,'Object')&&nodeName(fn.callee.property)==='assign'&&fn.arguments.length===2&&fn.arguments[0]?.type==='Identifier'&&fn.arguments[1]?.type==='ObjectExpression'&&fn.arguments[1].properties.length===1){
            const property=fn.arguments[1].properties[0];
            if((property.type==='ObjectMethod'||property.type==='ObjectProperty')&&!property.computed&&nodeName(property.key)==='install'&&(property.type==='ObjectMethod'&&property.kind==='method'||property.type==='ObjectProperty'&&isRenderFunction(property.value)))return this.resolveExport(mod.file,fn.arguments[0].name,true,next,budget);
          }
          if(fn.type==='CallExpression'&&fn.callee.type==='Identifier'){
            const imported=mod.imports.get(fn.callee.name);
            const dependency=imported&&!imported.file?await this.helperModule(imported.request):undefined;
            const helper=dependency&&imported?await this.resolveExport(dependency.file,imported.exported,false,next,budget):await this.resolveExport(mod.file,fn.callee.name,true,next,budget);
            const argument=helper&&helper!==ambiguousExport&&helper.fn?identityArgument(helper.fn,fn.arguments,{code:mod.code,env:mod.env,bindings:{}}):undefined;
            const actual=argument===undefined?undefined:unwrapExpression(fn.arguments[argument]);
            if(actual?.type==='Identifier')return this.resolveExport(mod.file,actual.name,true,next,budget);
            if(actual?.type==='ObjectExpression'||actual?.type==='CallExpression'||isRenderFunction(actual))return{module:mod,fn:actual};
          }
          return { module: mod, fn };
        }
        const imported = mod.imports.get(local);
        return imported ? follow(imported) : undefined;
      }
      return;
    }
    const [namespace, ...members] = exported.split('.');
    const reference = mod.reexports.get(namespace) ?? mod.imports.get(mod.exports.get(namespace) ?? '');
    if (!mod.reexports.has(exported) && members.length && reference?.exported === '*') return follow(reference, members.join('.'));
    return resolveReexports(mod, exported, follow, (left, right) => left.module === right.module && left.fn === right.fn);
  }
}
