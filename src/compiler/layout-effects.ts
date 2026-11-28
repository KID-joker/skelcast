import type * as t from '@babel/types';
import { isRenderFunction, nodeName, unwrapExpression, walk } from './ast.js';
import { UNKNOWN, evaluate, bindPattern, type Value } from './expression.js';
import type { RenderContext } from './context.js';

class Unsupported {}
class Returned { constructor(readonly value: Value) {} }
class SourceThrow { constructor(readonly value: Value) {} }

/** Bounded abstract initialization for source slot-layout bookkeeping. This
 * interpreter has no JS callable values, imports, DOM or application effects.
 * Writes are restricted to local variables and source-declared ref cells. */
export function initializeLayout(ctx: RenderContext): boolean {
  let changed = false;
  const refs = new Set(ctx.module.setupDeclarations.flatMap(d => d.id.type === 'Identifier' && d.init?.type === 'CallExpression' && d.init.callee.type === 'Identifier' && ctx.module.imports.get(d.init.callee.name)?.request === 'vue' && ['ref','shallowRef'].includes(ctx.module.imports.get(d.init.callee.name)!.exported) ? [d.id.name] : []));
  const slotBindings = ctx.module.setupDeclarations.filter(d => {
    if (d.id.type !== 'Identifier') return false;
    const init = unwrapExpression(d.init);
    if (init?.type !== 'CallExpression') return false;
    const callee = unwrapExpression(init.callee);
    if (callee?.type !== 'MemberExpression' || nodeName(callee.property) !== 'default' || callee.object.type !== 'CallExpression' || callee.object.callee.type !== 'Identifier') return false;
    const imported = ctx.module.imports.get(callee.object.callee.name);
    return imported?.request === 'vue' && imported.exported === 'useSlots';
  });
  const entries: { fn: t.ArrowFunctionExpression | t.FunctionExpression; args: Value[] }[] = [];
  for (const statement of ctx.module.ast.program.body) {
    if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'CallExpression' || statement.expression.callee.type !== 'Identifier') continue;
    const call = statement.expression, imported = call.callee.type === 'Identifier' ? ctx.module.imports.get(call.callee.name) : undefined;
    if (imported?.request !== 'vue') continue;
    if (imported.exported === 'onBeforeMount' && slotBindings.length && ctx.slotNodes && isRenderFunction(call.arguments[0])) entries.push({ fn: call.arguments[0], args: [] });
    if (imported.exported === 'watch' && isRenderFunction(call.arguments[0]) && isRenderFunction(call.arguments[1]) && call.arguments[2]?.type === 'ObjectExpression') {
      const options = evaluate(call.arguments[2], ctx);
      if (options && typeof options === 'object' && (options as Record<string, Value>).immediate === true && call.arguments[0].body.type !== 'BlockStatement') {
        const value = evaluate(call.arguments[0].body, ctx);
        if (value !== UNKNOWN) entries.push({ fn: call.arguments[1], args: [value] });
      }
    }
  }
  for (const entry of entries) {
    let work = 1500, depth = 0;
    const env = { ...ctx.env };
    for (const binding of slotBindings) if (binding.id.type === 'Identifier') env[binding.id.name] = ctx.slotNodes;
    const owned = new Set<string>();
    const arrays = new WeakSet<object>();
    const read = (node: t.Node | null | undefined, scope = env): Value => {
      if (--work < 0 || depth > 16 || !node) throw new Unsupported();
      const input = unwrapExpression(node);
      if (input !== node) return read(input, scope);
      if (node.type === 'AssignmentExpression') {
        let value = read(node.right, scope);
        if (node.operator !== '=') value = read({ ...node, type:'BinaryExpression', operator:node.operator.slice(0,-1), left:node.left, right:node.right } as t.BinaryExpression, scope);
        if (value === UNKNOWN) throw new Unsupported();
        if (node.left.type === 'Identifier' && owned.has(node.left.name)) scope[node.left.name] = value;
        else if (node.left.type === 'MemberExpression' && node.left.object.type === 'Identifier' && nodeName(node.left.property) === 'value' && refs.has(node.left.object.name)) scope[node.left.object.name] = value;
        else throw new Unsupported();
        return value;
      }
      if (node.type === 'LogicalExpression') {
        const left = read(node.left, scope);
        if (left === UNKNOWN) throw new Unsupported();
        return node.operator === '&&' ? left ? read(node.right, scope) : left : node.operator === '||' ? left || read(node.right, scope) : left ?? read(node.right, scope);
      }
      if (node.type === 'ConditionalExpression') return read(node.test,scope) ? read(node.consequent,scope) : read(node.alternate,scope);
      if (node.type === 'CallExpression') {
        if (node.callee.type === 'Identifier') {
          if (['Number','parseInt'].includes(node.callee.name) && !Object.hasOwn(ctx.module.env,node.callee.name)) {
            const value = read(node.arguments[0],scope);
            if (!['string','number','boolean'].includes(typeof value)) throw new Unsupported();
            return node.callee.name === 'Number' ? Number(value) : parseInt(String(value),10);
          }
          const fn = ctx.module.functions.get(node.callee.name);
          if (isRenderFunction(fn) && !fn.async && !fn.generator) return invoke(fn,node.arguments.map(a=>read(a,scope)),scope);
        }
        if (node.callee.type === 'MemberExpression') {
          const name = nodeName(node.callee.property);
          if (nodeName(node.callee.object) === 'console' && name === 'log' && !Object.hasOwn(ctx.module.env,'console')) return undefined;
          if (nodeName(node.callee.object) === 'Array' && name === 'isArray' && !Object.hasOwn(ctx.module.env,'Array')) return Array.isArray(read(node.arguments[0],scope));
          const object = read(node.callee.object,scope);
          if (Array.isArray(object) && object.length <= 256) {
            if (name === 'push' && arrays.has(object) && node.callee.object.type === 'Identifier' && owned.has(node.callee.object.name)) { for (const arg of node.arguments) object.push(...(arg.type === 'SpreadElement' ? read(arg.argument,scope) as Value[] : [read(arg,scope)])); return object.length; }
            const callback = node.arguments[0];
            if (isRenderFunction(callback) && !callback.async && (name === 'forEach' || name === 'reduce')) {
              let accumulator = name === 'reduce' ? read(node.arguments[1],scope) : undefined;
              for (let i=0;i<object.length;i++) { const value=invoke(callback,name==='reduce'?[accumulator,object[i],i]:[object[i],i],scope);if(name==='reduce')accumulator=value; }
              return accumulator;
            }
          }
        }
      }
      const nodeValues = new Map<t.Node, Value>();
      if (node.type === 'BinaryExpression') { nodeValues.set(node.left,read(node.left,scope));nodeValues.set(node.right,read(node.right,scope)); }
      if (node.type === 'UnaryExpression') nodeValues.set(node.argument,read(node.argument,scope));
      const value = evaluate(node,{...ctx,code:ctx.module.code,env:scope,nodeValues});
      if (value === UNKNOWN) throw new Unsupported();
      if (node.type === 'ArrayExpression' && Array.isArray(value)) arrays.add(value);
      return value;
    };
    const run = (statements: t.Statement[], scope: Record<string, Value>): void => {
      for (const statement of statements) {
        if (--work < 0) throw new Unsupported();
        if (statement.type === 'VariableDeclaration') for (const declaration of statement.declarations) {
          if (declaration.id.type !== 'Identifier') throw new Unsupported();
          owned.add(declaration.id.name);scope[declaration.id.name]=declaration.init?read(declaration.init,scope):undefined;
        }
        else if (statement.type === 'ExpressionStatement') read(statement.expression,scope);
        else if (statement.type === 'IfStatement') { const branch=read(statement.test,scope)?statement.consequent:statement.alternate;if(branch)run(branch.type==='BlockStatement'?branch.body:[branch],scope); }
        else if (statement.type === 'ReturnStatement') throw new Returned(statement.argument?read(statement.argument,scope):undefined);
        else if (statement.type === 'ThrowStatement') throw new SourceThrow(read(statement.argument,scope));
        else if (statement.type === 'BlockStatement') run(statement.body,scope);
        else if (statement.type === 'TryStatement') {
          try { run(statement.block.body,scope); }
          catch(error){if(!(error instanceof SourceThrow)||!statement.handler)throw error;const local={...scope};if(statement.handler.param)bindPattern(statement.handler.param,error.value,local);run(statement.handler.body.body,local);}
          finally { if(statement.finalizer)run(statement.finalizer.body,scope); }
        } else throw new Unsupported();
      }
    };
    const invoke = (fn: t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression, args: Value[], parent: Record<string, Value>): Value => {
      if (++depth > 16) throw new Unsupported();
      const local = { ...parent };
      const shadows = new Set<string>();
      for (const parameter of fn.params) if (parameter.type === 'Identifier') shadows.add(parameter.name);
      walk(fn.body,(node,ancestors)=>{if(ancestors.some(isRenderFunction))return false;if(node.type==='VariableDeclarator'&&node.id.type==='Identifier')shadows.add(node.id.name);});
      fn.params.forEach((parameter,index)=>{const pattern=parameter.type==='AssignmentPattern'?parameter.left:parameter;if(pattern.type==='Identifier')owned.add(pattern.name);bindPattern(pattern,args[index]??(parameter.type==='AssignmentPattern'?read(parameter.right,parent):undefined),local);});
      try { if(fn.body.type==='BlockStatement')run(fn.body.body,local);else return read(fn.body,local); }
      catch(error){if(error instanceof Returned)return error.value;throw error;}
      finally { for(const key of Object.keys(parent))if((refs.has(key)||owned.has(key))&&!shadows.has(key)&&Object.hasOwn(local,key))parent[key]=local[key];depth--; }
      return undefined;
    };
    try { invoke(entry.fn,entry.args,env);for(const ref of refs)if(Object.hasOwn(env,ref)){changed ||= !Object.is(ctx.env[ref],env[ref]);ctx.env[ref]=env[ref];} }
    catch { ctx.layoutUnresolved = true; }
  }
  return changed;
}
