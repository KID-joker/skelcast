import type * as t from '@babel/types';
import { isRenderFunction, nodeName, patternNames, unwrapExpression } from './ast.js';
import { UNKNOWN, SOURCE_ACCESSOR, SOURCE_RENDER,SOURCE_COPY,SOURCE_TYPE_TEST, bindPattern, evaluate, type Ast } from './expression.js';
import { slotValue, type ModuleInfo, type RenderContext } from './context.js';
import type { RenderHost } from './render-host.js';
import {bindSlotInitial} from './regions.js';
import{initialExpression,propagateInitialAliases}from'./initial-state.js';
import { propagateAliases } from './mutations.js';
import { renderCall } from './render-call.js';
import { renderBranch } from './render-branches.js';
import { vueHelper, supportedBody, visualSyntax, setupSyntax } from './vue-syntax.js';
import { componentInputs } from './props.js';
import { renderJSXNode } from './render-node.js';
import { renderBudget } from './render-budget.js';

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
    if (visualSyntax(mod, value.body).h && !value.async && !value.generator) return value;
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

  const { declarations, declarationByName, localNames, renderBindings, aliases, effects } = setupSyntax(setup.body);
  for (const key of Object.keys(ctx.initialValues ?? {})) {
    if (localNames.has(key.split('.')[0])) delete ctx.initialValues![key];
  }
  let render=unwrapExpression(this.prepareFunction(setup,ctx,values));
  const seen=new Set<string>();
  while(render?.type==='Identifier'&&setup.body.type==='BlockStatement'&&!seen.has(render.name)){
    const name=render.name;seen.add(name);
    const declaration=declarationByName.get(name);
    if(!declaration||(declaration.start??Infinity)>=(render.start??0))return;
    render=unwrapExpression(declaration.init);
  }
  if(!isRenderFunction(render)||render.async||render.generator||render.params.length||!supportedBody(render.body))return;
  if (partial) { const visual = visualSyntax(ctx.module, setup.body); if (!visual.jsx && !visual.h) return; }
  if(setup.body.type==='BlockStatement'){
    const written=new Set<string>();
    for (const effect of effects) {
      if (effect.written) written.add(effect.written);
      const n = effect.call;
      if (n) {
        const capability=evaluate(n.callee,ctx),readonly=capability&&typeof capability==='object'&&(Object.hasOwn(capability,SOURCE_COPY)||Object.hasOwn(capability,SOURCE_TYPE_TEST));
        if(!readonly&&!(n.callee.type==='Identifier'&&ctx.module.imports.get(n.callee.name)?.request==='vue'))for(const argument of n.arguments)if(argument.type==='Identifier'&&ctx.env[argument.name]&&typeof ctx.env[argument.name]==='object')written.add(argument.name);
      }
    }
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
    for (const { name, fn } of renderBindings) {
      if (!name || !isRenderFunction(fn) || fn.async || fn.generator || !supportedBody(fn.body) || written.has(name)) continue;
      const visual = visualSyntax(ctx.module, fn.body);
      if(visual.jsx || visual.h)ctx.env[name]={[SOURCE_RENDER]:fn};
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
  const exhausted = renderBudget(this, node, ctx, 'render');
  if (exhausted !== undefined) return exhausted;
  if (node.type !== 'ConditionalExpression' && node.type !== 'LogicalExpression' && node.type !== 'ArrayExpression'
    && node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') {
    return renderJSXNode.call(this, node, ctx);
  }
  if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression' || node.type === 'ArrayExpression') return renderBranch.call(this, node, ctx, 'render');
  if(node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&nodeName(node.callee.property)==='map')return renderJSXNode.call(this,node,ctx);
  return renderCall.call(this, node, ctx, 'render');
}
