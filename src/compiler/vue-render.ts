import type * as t from '@babel/types';
import { isRenderFunction, nodeName, patternNames, unwrapExpression, walk } from './ast.js';
import { UNKNOWN, SOURCE_ACCESSOR, SOURCE_RENDER,SOURCE_COPY,SOURCE_TYPE_TEST, bindPattern, evaluate, expressionText, type Ast } from './expression.js';
import { slotValue, type ModuleInfo, type RenderContext, type SourceSlot } from './context.js';
import { nonVisual, unknownGeometry } from './html.js';
import type { RenderHost } from './render-host.js';
import {renderSlotCall,bindSlotInitial} from './regions.js';
import{initialExpression,propagateInitialAliases}from'./initial-state.js';
import { mutationTarget, propagateAliases, rootName } from './mutations.js';
import { renderComponent } from './component-render.js';
import { componentInputs } from './props.js';
import { renderJSXNode } from './react.js';

/** Helper identity is established from imports, including aliases/namespaces. */
export function vueHelper(mod: ModuleInfo, callee: Ast, name: string): boolean {
  if (callee.type === 'Identifier') {
    const ref = mod.imports.get(callee.name);
    return ref?.request === 'vue' && ref.exported === name;
  }
  if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier') {
    const ref = mod.imports.get(callee.object.name);
    return ref?.request === 'vue' && ref.exported === '*' && nodeName(callee.property) === name;
  }
  return false;
}

export function vueOptions(mod: ModuleInfo, value: Ast | undefined): t.ObjectExpression | undefined {
  if (value?.type === 'ObjectExpression') return value;
  if (value?.type === 'CallExpression' && vueHelper(mod, value.callee, 'defineComponent') && value.arguments[0]?.type === 'ObjectExpression') return value.arguments[0];
}

export function vueRenderFunction(mod: ModuleInfo, value: Ast | undefined): t.FunctionExpression | t.ArrowFunctionExpression | t.FunctionDeclaration | undefined {
  const options = vueOptions(mod, value);
  if (options) {
    if (options.properties.some(p => p.type === 'SpreadElement' || ['mixins', 'extends'].includes(nodeName(p.key) ?? ''))) return;
    const render = options.properties.find(p => p.type !== 'SpreadElement' && nodeName(p.key) === 'render');
    if (render?.type === 'ObjectMethod' && render.kind === 'method' && !render.async && !render.generator) return { ...render, type: 'FunctionExpression', id: null };
    if (render?.type === 'ObjectProperty' && isRenderFunction(render.value) && !render.value.async && !render.value.generator) return render.value;
    return;
  }
  if (isRenderFunction(value)) {
    let found = false;
    walk(value.body, n => { if (n.type === 'CallExpression' && vueHelper(mod, n.callee, 'h')) found = true; });
    if (found && !value.async && !value.generator) return value;
  }
}

export function vueSetupFunction(mod:ModuleInfo,value:Ast|undefined){
  const options=vueOptions(mod,value);
  if(options){
    if(options.properties.some(p=>p.type==='SpreadElement'||['mixins','extends','render'].includes(nodeName(p.key)??'')))return;
    const setup=options.properties.find(p=>p.type!=='SpreadElement'&&nodeName(p.key)==='setup');
    if(setup?.type==='ObjectMethod'&&setup.kind==='method'&&!setup.async&&!setup.generator)return {...setup,type:'FunctionExpression' as const,id:null};
    if(setup?.type==='ObjectProperty'&&isRenderFunction(setup.value))return setup.value;
  }
  if(value?.type==='CallExpression'&&vueHelper(mod,value.callee,'defineComponent')&&isRenderFunction(value.arguments[0]))return value.arguments[0];
}

export function prepareVueSetup(this:RenderHost,setup:t.FunctionExpression|t.FunctionDeclaration|t.ArrowFunctionExpression,ctx:RenderContext,props:Record<string,unknown>){
  if(setup.async||setup.generator||setup.params.length>2)return;
  const partial=!supportedBody(setup.body);
  if(partial){
    if(setup.body.type!=='BlockStatement'||setup.body.body.at(-1)?.type!=='ReturnStatement')return;
    // A direct return shell can be read without executing setup. Control-flow
    // returns and imperative loops/throws cannot establish that shell.
    if(!setup.body.body.every(s=>['VariableDeclaration','FunctionDeclaration','ExpressionStatement','ReturnStatement'].includes(s.type)))return;
  }
  ctx.unwrapRefs=true;
  const slots=Object.fromEntries(Object.entries(ctx.slots??{}).map(([name,slot])=>[name,{[slotValue]:slot}]));
  const attrs=ctx.env.$attrs;
  bindPattern(setup.params[1],{attrs,slots,emit:UNKNOWN,expose:UNKNOWN},ctx.env);
  for(const [name,ref]of ctx.module.imports){
    if(ref.request!=='vue')continue;
    if(ref.exported==='useAttrs'||ref.exported==='useSlots')ctx.env[name]={[SOURCE_ACCESSOR]:ref.exported==='useAttrs'?attrs:slots};
    if(ref.exported==='*')ctx.env[name]={...(ctx.env[name]&&typeof ctx.env[name]==='object'?ctx.env[name]:{}),useAttrs:{[SOURCE_ACCESSOR]:attrs},useSlots:{[SOURCE_ACCESSOR]:slots}};
  }
  const input = componentInputs(props, ctx.module.propDefaults, 'setup');
  const values=input.values;
  if(setup.params[0])bindSlotInitial(setup.params[0],input.initial,ctx);
  if(setup.body.type==='BlockStatement')for(const statement of setup.body.body){
    const names=statement.type==='VariableDeclaration'?statement.declarations.flatMap(d=>patternNames(d.id)):statement.type==='FunctionDeclaration'&&statement.id?[statement.id.name]:[];
    for(const name of names)for(const key of Object.keys(ctx.initialValues??{}))if(key===name||key.startsWith(name+'.'))delete ctx.initialValues![key];
  }
  let render=unwrapExpression(this.prepareFunction(setup,ctx,values));
  const seen=new Set<string>();
  while(render?.type==='Identifier'&&setup.body.type==='BlockStatement'&&!seen.has(render.name)){
    const name=render.name;seen.add(name);
    const declaration=setup.body.body.flatMap(s=>s.type==='VariableDeclaration'?s.declarations:[]).find(d=>d.id.type==='Identifier'&&d.id.name===name);
    if(!declaration||(declaration.start??Infinity)>=(render.start??0))return;
    render=unwrapExpression(declaration.init);
  }
  if(!isRenderFunction(render)||render.async||render.generator||render.params.length||!supportedBody(render.body))return;
  if(partial){let visual=false;walk(setup.body,n=>{if(n.type==='JSXElement'||n.type==='JSXFragment'||n.type==='CallExpression'&&vueHelper(ctx.module,n.callee,'h'))visual=true;});if(!visual)return;}
  if(setup.body.type==='BlockStatement'){
    const written=new Set<string>();
    walk(setup.body,n=>{
      const name=rootName(mutationTarget(n));
      if(name)written.add(name);
      if(n.type==='CallExpression'){
        const capability=evaluate(n.callee,ctx),readonly=capability&&typeof capability==='object'&&(Object.hasOwn(capability,SOURCE_COPY)||Object.hasOwn(capability,SOURCE_TYPE_TEST));
        if(!readonly&&!(n.callee.type==='Identifier'&&ctx.module.imports.get(n.callee.name)?.request==='vue'))for(const argument of n.arguments)if(argument.type==='Identifier'&&ctx.env[argument.name]&&typeof ctx.env[argument.name]==='object')written.add(argument.name);
      }
    });
    const declarations=setup.body.body.flatMap(s=>s.type==='VariableDeclaration'?s.declarations:[]);
    const aliases=declarations.flatMap((d):[string,string][]=>d.id.type==='Identifier'&&d.init?.type==='Identifier'?[[d.id.name,d.init.name]]:[]);
    propagateAliases(written,aliases);
    ctx.initialValues??={};
    for(const d of declarations){
      if(d.id.type!=='Identifier'||!written.has(d.id.name)||d.init?.type!=='CallExpression'||!['ref','shallowRef','reactive'].some(name=>vueHelper(ctx.module,d.init!.type==='CallExpression'?d.init!.callee:d.init!,name)))continue;
      let value=ctx.env[d.id.name];
      if(value===UNKNOWN){
        const env={...ctx.env};for(const later of declarations)if((later.start??0)>=(d.start??0))for(const name of patternNames(later.id))env[name]=UNKNOWN;
        value=initialExpression(d.init,{...ctx,env});
      }
      if(value!==UNKNOWN){ctx.initialValues[d.id.name]=value;if(['ref','shallowRef'].some(name=>vueHelper(ctx.module,(d.init as t.CallExpression).callee,name)))ctx.initialValues[d.id.name+'.value']=value;}
    }
    propagateInitialAliases(ctx.initialValues, aliases);
    for(const name of written)ctx.env[name]=UNKNOWN;
    for(const statement of setup.body.body){
      const declarations=statement.type==='VariableDeclaration'?statement.declarations.map(d=>({name:nodeName(d.id),fn:d.init})):statement.type==='FunctionDeclaration'?[{name:statement.id?.name,fn:statement}]:[];
      for(const {name,fn}of declarations)if(name&&isRenderFunction(fn)&&!fn.async&&!fn.generator&&supportedBody(fn.body)&&!written.has(name)){
        let visual=false;walk(fn.body,n=>{if(n.type==='JSXElement'||n.type==='JSXFragment'||n.type==='CallExpression'&&vueHelper(ctx.module,n.callee,'h'))visual=true;});
        if(visual)ctx.env[name]={[SOURCE_RENDER]:fn};
      }
    }
    if(partial)this.diagnose('PRESET_LIMIT','Read a direct source render shell; setup effects, lifecycle handlers and mutable state are not executed or reconstructed',ctx,setup);
  }
  return render;
}

export function vueOptionProps(mod: ModuleInfo, options: t.ObjectExpression): void {
  const ec = { code: mod.code, env: mod.env, bindings: {} };
  let props = options.properties.find(p => p.type === 'ObjectProperty' && nodeName(p.key) === 'props');
  if(props?.type==='ObjectProperty'&&props.value.type==='Identifier'){
    const declaration=mod.functions.get(props.value.name);
    if(declaration?.type==='ObjectExpression')props={...props,value:declaration};
  }
  if (props?.type === 'ObjectProperty' && props.value.type === 'ArrayExpression') {
    for (const name of props.value.elements) if (name?.type === 'StringLiteral') mod.propDefaults[name.value] = undefined;
  }
  if (props?.type === 'ObjectProperty' && props.value.type === 'ObjectExpression') for (const prop of props.value.properties) {
    if (prop.type !== 'ObjectProperty' || prop.computed) continue;
    const name = nodeName(prop.key);
    if (!name) continue;
    const spec = prop.value;
    const type = spec.type === 'ObjectExpression' ? spec.properties.find(p => p.type === 'ObjectProperty' && nodeName(p.key) === 'type') : undefined;
    const boolean = !Object.hasOwn(mod.env, 'Boolean') && (nodeName(spec) === 'Boolean' || type?.type === 'ObjectProperty' && nodeName(type.value) === 'Boolean');
    mod.propDefaults[name] = boolean ? false : undefined;
    if (spec.type !== 'ObjectExpression') continue;
    const defaultValue = spec.properties.find(p => p.type === 'ObjectProperty' && nodeName(p.key) === 'default');
    if (defaultValue?.type === 'ObjectProperty') {
      const value = defaultValue.value;
      mod.propDefaults[name] = value.type === 'ArrowFunctionExpression' && !value.async && !value.params.length && value.body.type !== 'BlockStatement'
        ? evaluate(value.body, ec) : evaluate(value, ec);
    }
  }
  const inherit = options.properties.find(p => p.type === 'ObjectProperty' && nodeName(p.key) === 'inheritAttrs');
  if (inherit?.type === 'ObjectProperty' && inherit.value.type === 'BooleanLiteral') mod.inheritAttrs = inherit.value.value;
}

function supportedBody(body: Ast): boolean {
  if (body.type !== 'BlockStatement') return true;
  const statement = (s: t.Statement): boolean => s.type === 'VariableDeclaration' || s.type === 'ReturnStatement' || s.type === 'BlockStatement' && s.body.every(statement) || s.type === 'IfStatement' && statement(s.consequent) && (!s.alternate || statement(s.alternate));
  return body.body.every(statement);
}

async function renderLocalCall(this:RenderHost,node:t.CallExpression,ctx:RenderContext,value:unknown):Promise<string|undefined>{
  if(!value||typeof value!=='object'||!Object.hasOwn(value,SOURCE_RENDER))return;
  const fn=(value as {[SOURCE_RENDER]:t.FunctionExpression|t.FunctionDeclaration|t.ArrowFunctionExpression})[SOURCE_RENDER];
  if(ctx.depth>16||node.arguments.some(a=>a.type==='SpreadElement'))return this.fallback(ctx,node,'Local source render recursion or arguments exceed the finite limit');
  const local={...ctx,env:{...ctx.env},depth:ctx.depth+1};
  fn.params.forEach((param,i)=>bindPattern(param,node.arguments[i]?evaluate(node.arguments[i],ctx):undefined,local.env));
  const body=this.prepareFunction({...fn,params:[]},local,{});
  return body?.type==='CallExpression'&&vueHelper(ctx.module,body.callee,'h')?this.vueExpression(body,local):this.jsx(body,local);
}

export function prepareVueRender(this: RenderHost, fn: t.FunctionExpression | t.FunctionDeclaration | t.ArrowFunctionExpression, ctx: RenderContext, props: Record<string, unknown>, options = true): Ast | undefined {
  // Stateful render bodies, lifecycle/setup hooks and business calls are not run.
  if (!supportedBody(fn.body)) return;
  ctx.unwrapRefs = true;
  if (options) ctx.env.this = { ...ctx.env, $slots: Object.fromEntries(Object.entries(ctx.slots ?? {}).map(([name, slot]) => [name, { [slotValue]: slot }])) };
  return this.prepareFunction(fn, ctx, props);
}

export async function renderVueExpression(this: RenderHost, node: Ast | null | undefined, ctx: RenderContext): Promise<string> {
  if (!node) return '';
  const expression = unwrapExpression(node);
  if (expression && expression !== node) return this.vueExpression(expression, ctx);
  // Vue values include both a render-expression and a shared-node unit. Keep
  // that weight at the frontend boundary, independent of renderer delegation.
  if (node.type !== 'ConditionalExpression' && node.type !== 'LogicalExpression' && node.type !== 'ArrayExpression'
    && node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') {
    return this.budget(ctx, node, 2) ?? renderJSXNode.call(this, node, ctx);
  }
  const exhausted = this.budget(ctx, node);
  if (exhausted !== undefined) return exhausted;
  if (node.type === 'ConditionalExpression') {
    const value = evaluate(node.test, ctx);
    if (value === UNKNOWN) this.diagnose('BRANCH_DEFAULT', 'Unknown render condition; chose consequent', ctx, node);
    return this.vueExpression(value === UNKNOWN || value ? node.consequent : node.alternate, ctx);
  }
  if (node.type === 'LogicalExpression') {
    const value = evaluate(node.left, ctx);
    if (value === UNKNOWN) { this.diagnose('BRANCH_DEFAULT', 'Unknown render guard; include optional content', ctx, node); return this.vueExpression(node.right, ctx); }
    if (node.operator === '&&') return value ? this.vueExpression(node.right, ctx) : '';
    return this.vueExpression(node.operator === '??' ? value == null ? node.right : node.left : value ? node.left : node.right, ctx);
  }
  if (node.type === 'ArrayExpression') {
    let html = '';
    for (const child of node.elements) html += await this.vueExpression(child, ctx);
    return html;
  }
  return renderCall.call(this, node, ctx, 'render');
}

/** Classify a call once, then render it directly instead of crossing frontends. */
export async function renderCall(this: RenderHost, node: t.CallExpression | t.OptionalCallExpression, ctx: RenderContext, framework: 'jsx' | 'render'): Promise<string> {
  const calleeValue = evaluate(node.callee, ctx);
  if (node.type === 'CallExpression') {
    const local = await renderLocalCall.call(this, node, ctx, calleeValue);
    if (local !== undefined) return local;
  }
  const slot = await renderSlotCall(this, node, ctx, calleeValue);
  if (slot !== undefined) return slot;
  if (node.type === 'OptionalCallExpression') return framework === 'render'
    ? calleeValue == null && node.optional ? '' : this.fallback(ctx, node, 'Unresolved optional render call needs a finite binding')
    : this.fallback(ctx, node, `Unknown render call: ${expressionText(node.callee, ctx)}`);
  if (!vueHelper(ctx.module, node.callee, 'h')) return this.fallback(ctx, node, `Unknown render call: ${expressionText(node.callee, ctx)}`);
  // A JSX h() expression also consumes a Vue call-expansion unit.
  if (framework === 'jsx') {
    const exhausted = this.budget(ctx, node);
    if (exhausted !== undefined) return exhausted;
  }
  const tagNode = node.arguments[0];
  const name = (value: Ast | undefined): string | undefined => value?.type === 'MemberExpression' && !value.computed ? `${name(value.object)}.${nodeName(value.property)}` : value ? nodeName(value) : undefined;
  const tagValue = evaluate(tagNode, ctx);
  const native = typeof tagValue === 'string';
  const tag = native ? tagValue : name(tagNode);
  if (!tag || !/^[\w.-]+$/.test(tag)) return this.fallback(ctx, node, 'Dynamic h() component needs a finite binding or adapter');
  if (native && tag.includes('-')) return this.fallback(ctx, node, 'Custom elements need an inert source adapter');
  const propsNode = node.arguments[1];
  const childNode = node.arguments.length > 2 ? node.arguments[2] : propsNode && (propsNode.type === 'ArrayExpression' || propsNode.type === 'StringLiteral' || propsNode.type === 'CallExpression' && vueHelper(ctx.module, propsNode.callee, 'h')) ? propsNode : undefined;
  const value = propsNode && propsNode !== childNode && propsNode.type !== 'NullLiteral' ? evaluate(propsNode, ctx) : {};
  if (!value || value === UNKNOWN || typeof value !== 'object' || Array.isArray(value)) return this.fallback(ctx, node, 'Unresolved h() props need a finite binding');
  const props: Record<string, unknown> = { ...value };
  if (propsNode?.type === 'ObjectExpression') for (const prop of propsNode.properties) if (prop.type === 'SpreadElement' && evaluate(prop.argument, ctx) === UNKNOWN) this.diagnose('SPREAD_UNKNOWN', 'Unresolved h() spread props may affect layout', ctx, prop);
  const local = this.contentContext(ctx, props, native ? tag : '');
  if ((unknownGeometry(props.style) || ['class', 'style', 'width', 'height'].some(key => props[key] === UNKNOWN))&&!Object.values(ctx.slots??{}).some(slot=>this.hasSelectedSlot(slot))) return this.fallback(local, node, 'Unresolved h() layout props', props);
  const slots: Record<string, SourceSlot> = {};
  const forward=(value:unknown)=>{
    if(!value||value===UNKNOWN||typeof value!=='object'||Array.isArray(value))return false;
    for(const [key,slot]of Object.entries(value)){
      if(!slot||typeof slot!=='object'||!Object.hasOwn(slot,slotValue))return false;
      slots[key]=(slot as {[slotValue]:SourceSlot})[slotValue];
    }
    return true;
  };
  if (childNode?.type === 'ObjectExpression') {
    for (const property of childNode.properties) {
      if(property.type==='SpreadElement'){
        if(!forward(evaluate(property.argument,ctx)))return this.fallback(local,node,'Unresolved forwarded h() slots need an adapter');
        continue;
      }
      if(property.type==='ObjectProperty'&&!property.computed){
        const value=evaluate(property.value,ctx),key=nodeName(property.key);
        if(key&&value&&typeof value==='object'&&Object.hasOwn(value,slotValue)){slots[key]=(value as {[slotValue]:SourceSlot})[slotValue];continue;}
      }
      if (property.type !== 'ObjectProperty' || property.computed || !isRenderFunction(property.value) || property.value.params.length>1 || property.value.async || !supportedBody(property.value.body)) return this.fallback(local, node, 'Dynamic/scoped h() slots need an adapter');
      const key = nodeName(property.key);
      const slotContext = { ...local, env: { ...local.env } };
      if (key) slots[key] = { framework: 'render', nodes: [], context: slotContext,parameter:property.value.params[0],renderFunction:property.value };
    }
  } else if (childNode && !forward(evaluate(childNode,ctx))) slots.default = { framework: 'render', nodes: [childNode], context: local };
  const children = async () => slots.default ? this.renderSlot(slots.default, local) : '';
  if (!native) {
    const ref = await this.componentReference(tag, ctx);
    if (vueHelper(ctx.module, tagNode!, 'Fragment')) return children();
    props.__skSlots = slots;
    const presentation = await renderComponent(this, tag, props, { framework: 'render', nodes: [], slots, context: local }, node, ref);
    if (presentation !== undefined) return presentation;
    return this.fallback(local, node, `No source adapter for ${tag}`, props);
  }
  if (nonVisual.has(tag)) return '';
  if (tag === 'img') return this.image(props, local, node);
  if (Object.hasOwn(props, 'innerHTML')) return typeof props.innerHTML === 'string' ? this.element(tag, props, this.staticHTML(props.innerHTML, local, node), local, node) : this.fallback(local, node, 'Unknown h() innerHTML needs a finite binding');
  const content = Object.hasOwn(props, 'textContent') ? this.contentText(props.textContent, local, node) : await children();
  const opaque = !content && ['div', 'section', 'article', 'main', 'canvas'].includes(tag) && Object.hasOwn(props, 'ref');
  const html = this.element(tag, props, content, local, node, { opaque, leaf: opaque && this.masked(local) });
  if (opaque) {
    this.diagnose('FALLBACK', 'Opaque native mount point: preserve source container geometry', local, node);
  }
  return html;
}
