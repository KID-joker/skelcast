import { parseExpression } from '@babel/parser';
import type * as t from '@babel/types';
import { isRenderFunction, nodeName, unwrapExpression, walk } from './ast.js';
import type {CopyRecipe} from './copy-recipe.js';

export const UNKNOWN = Symbol('unknown');
export const CLASS_HELPER = Symbol('static-class-helper');
export const SOURCE_ACCESSOR = Symbol('source-accessor');
/** A field summary read from a source return object, never a callable function. */
export const SOURCE_PROJECTION = Symbol('source-projection');
export const SOURCE_INITIAL = Symbol('source-initial-state');
export const SOURCE_RENDER = Symbol('source-render-body');
export const SOURCE_RENDER_FILE = Symbol('source-render-file');
export const SOURCE_TYPE_TEST = Symbol('source-type-test');
export const SOURCE_COLLECTION = Symbol('source-collection-capacity');
export const SOURCE_CELL_GLYPHS = Symbol('source-declared-cell-glyphs');
export const SOURCE_COPY = Symbol('source-copy-recipe');
export const SOURCE_FUNCTION = Symbol('source-function-type');
export const SOURCE_VUE = Symbol('source-vue-helper');
export const SOURCE_ARRAY_LAYOUT = Symbol('source-array-layout');
export const SOURCE_NORMALIZED = Symbol('source-normalized-layout');
export const SOURCE_ICON = Symbol('source-library-icon');
export const SOURCE_FIELDS = Symbol('source-field-projector');
export function sourceCapacity(value:Value):number|undefined{return value&&typeof value==='object'&&Object.hasOwn(value,SOURCE_COLLECTION)?(value as {[SOURCE_COLLECTION]:number})[SOURCE_COLLECTION]:undefined;}
export function sourceCellGlyphs(value:Value):unknown[]|undefined{return value&&typeof value==='object'&&Object.hasOwn(value,SOURCE_CELL_GLYPHS)?(value as {[SOURCE_CELL_GLYPHS]:unknown[]})[SOURCE_CELL_GLYPHS]:undefined;}
const SOURCE_CLOSED = Symbol('source-complete-object');
export const sourceObject = (values: Record<string, Value>): Record<string, Value> => Object.defineProperty({ ...values }, SOURCE_CLOSED, { value: true });
const functionType=(value:Value)=>!!value&&typeof value==='object'&&[SOURCE_FUNCTION,SOURCE_COPY,SOURCE_PROJECTION,SOURCE_TYPE_TEST,SOURCE_RENDER,SOURCE_ACCESSOR,SOURCE_VUE,SOURCE_ARRAY_LAYOUT,SOURCE_FIELDS].some(key=>Object.hasOwn(value,key));
function copyValue(value:Value,deep:boolean,budget:{remaining:number},depth=0):Value{
 if(--budget.remaining<0||depth>32||value===UNKNOWN)return UNKNOWN;
 if(functionType(value))return value;
 if(value==null||['string','number','boolean','undefined'].includes(typeof value))return value;
 if(Array.isArray(value)){
  if(value.length>256||Object.hasOwn(value,'forEach'))return UNKNOWN;
  const result:Value[]=[];for(const item of value){const next=deep?copyValue(item,true,budget,depth+1):item;if(next===UNKNOWN)return UNKNOWN;result.push(next);}return result;
 }
 if(typeof value!=='object'||!Object.hasOwn(value,SOURCE_CLOSED)||Object.hasOwn(value,'hasOwnProperty'))return UNKNOWN;
 const result:Record<string,Value>=Object.create(null);
 for(const[key,item]of Object.entries(value)){if(!safeKey(key))return UNKNOWN;const next=deep?copyValue(item,true,budget,depth+1):item;if(next===UNKNOWN)return UNKNOWN;result[key]=next;}
 Object.defineProperty(result,SOURCE_CLOSED,{value:true});return result;
}
export type Value = unknown;
export type { Ast } from './ast.js';
export interface ExpressionContext {
  code: string;
  env: Record<string, Value>;
  bindings: Record<string, Value>;
  /** Immutable syntax shared within one compilation; expression values stay local. */
  expressions?: Map<string, t.Expression | null>;
  /** Source-proved projections keyed by syntax, without synthetic text bindings. */
  nodeValues?: Map<t.Node, Value>;
  defaultBranches?: boolean;
  unwrapRefs?: boolean;
  provides?: Record<string, Value>;
  initialValues?: Record<string, Value>;
  layoutFrame?: boolean;
  sourceFile?: string;
  /** Shared work limit for nested bounded collection operations. */
  budget?: { remaining: number };
}
export const expressionText = (node: t.Node | null | undefined, ctx: ExpressionContext): string =>
  node?.start != null && node?.end != null ? ctx.code.slice(node.start, node.end) : '';
const denied = new Set(['__proto__', 'prototype', 'constructor']);
function ownedArray(node:t.Node):boolean{
  const value=unwrapExpression(node);
  if(value?.type==='ArrayExpression')return true;
  if(value?.type!=='CallExpression'||value.callee.type!=='MemberExpression'||value.callee.computed)return false;
  const member=nodeName(value.callee.property);
  return ['slice','map','concat','toReversed'].includes(member??'')||nodeName(value.callee.object)==='Array'&&['from','of'].includes(member??'')||member==='reverse'&&ownedArray(value.callee.object);
}
export const safeKey = (key: unknown): key is string => typeof key === 'string' && !denied.has(key);
function inferredObject(name: string, ctx: ExpressionContext): Value {
  const result: Record<string, unknown> = Object.create(null);
  let found = false;
  for (const [key, value] of Object.entries(ctx.bindings)) {
    if (!key.startsWith(`${name}.`) || !/^[\w$]+(?:\.[\w$]+)+$/.test(key)) continue;
    const parts = key.slice(name.length + 1).split('.');
    if (!parts.every(safeKey)) continue;
    let object = result;
    for (let i = 0; i < parts.length - 1; i++) {
      const previous = object[parts[i]];
      if (!previous || typeof previous !== 'object') object[parts[i]] = Object.create(null);
      object = object[parts[i]] as Record<string, unknown>;
    }
    object[parts.at(-1)!] = value; found = true;
  }
  return found ? result : UNKNOWN;
}

/** Source-layout projections are opt-in. Helper identity and builtin shadowing
 * are supplied by the caller; ordinary expression evaluation stays unchanged. */
export interface SourceLayoutPolicy {
  helper(callee: t.Node, name: string): boolean;
  objectAssign: boolean;
}

// This is an abstract, bounded interpreter. No eval, Function, imports or business calls.
export function evaluate(node: t.Node | null | undefined, ctx: ExpressionContext, depth = 0, layout?: SourceLayoutPolicy): Value {
  if (layout) {
    if (!node) return UNKNOWN;
    const read = (input: t.Node | null | undefined): Value => evaluate(input, ctx, depth, layout);
    if (node.type === 'CallExpression') {
      const name = ['unref', 'computed'].find(name => layout.helper(node.callee, name));
      const wrapper = evaluateSourceWrapper(node, name, read, fn =>
        isRenderFunction(fn) && fn.body.type !== 'BlockStatement' ? { value: read(fn.body) } : undefined);
      if (wrapper) return wrapper.value;
      if (layout.objectAssign && node.callee.type === 'MemberExpression' && node.callee.object.type === 'Identifier'
        && node.callee.object.name === 'Object' && nodeName(node.callee.property) === 'assign'
        && node.arguments[0]?.type === 'ObjectExpression') {
        const first = read(node.arguments[0]);
        if (!first || typeof first !== 'object') return UNKNOWN;
        const result = { ...first };
        for (const argument of node.arguments.slice(1)) {
          const next = read(argument);
          if (next && typeof next === 'object') Object.assign(result, next);
        }
        return result;
      }
    }
    // Project nested unref reads only. Other nested expressions retain the
    // general interpreter's rules, rather than inheriting root layout policy.
    walk(node, child => {
      if (child !== node && child.type === 'CallExpression' && layout.helper(child.callee, 'unref')
        && child.start != null && child.end != null) {
        (ctx.nodeValues ??= new Map()).set(child, read(child.arguments[0]));
      }
    });
  }
  return evaluateNode(node, ctx, depth);
}

/** Finite wrapper rules shared by expression and table-layout evaluation.
 * Each caller decides which helper identity and computed bodies it accepts. */
export function evaluateSourceWrapper(
  node: t.CallExpression,
  name: string | undefined,
  read: (node: t.Node | null | undefined) => Value,
  computed: (fn: t.Node | undefined) => { value: Value } | undefined,
): { value: Value } | undefined {
  if (name === 'unref' || name === 'toRefs') return { value: node.arguments.length ? read(node.arguments[0]) : UNKNOWN };
  if (['ref', 'shallowRef', 'reactive', 'readonly'].includes(name ?? '')) {
    return { value: node.arguments.length ? read(node.arguments[0]) : name === 'ref' || name === 'shallowRef' ? undefined : UNKNOWN };
  }
  if (name === 'computed' || name === 'useMemo') return computed(node.arguments[0]);
}

function evaluateNode(node: t.Node | null | undefined, ctx: ExpressionContext, depth: number, readObject?: (node: t.Node, depth: number) => Value): Value {
  if (!ctx.budget) ctx = { ...ctx, budget: { remaining: 10000 } };
  if (--ctx.budget!.remaining < 0) return UNKNOWN;
  if (!node || depth > 40) return UNKNOWN;
  if (ctx.nodeValues?.has(node)) return ctx.nodeValues.get(node);
  const text = expressionText(node, ctx);
  if (Object.hasOwn(ctx.bindings, text)) return ctx.bindings[text];
  const ev = (n: t.Node | null | undefined) => evaluate(n, ctx, depth + 1);
  switch (node.type) {
    case 'TSAsExpression': case 'TSTypeAssertion': case 'TSSatisfiesExpression': case 'TSNonNullExpression': case 'ParenthesizedExpression': return ev(node.expression);
    case 'StringLiteral': case 'NumericLiteral': case 'BooleanLiteral': return node.value;
    case 'NullLiteral': return null;
    case 'ArrowFunctionExpression': case 'FunctionExpression': case 'FunctionDeclaration': {
      let visual = false;
      walk(node.body, child => { if (child.type === 'JSXElement' || child.type === 'JSXFragment') visual = true; });
      return visual && !node.async && !node.generator && ctx.sourceFile ? { [SOURCE_FUNCTION]: true, [SOURCE_RENDER]: node, [SOURCE_RENDER_FILE]: ctx.sourceFile } : { [SOURCE_FUNCTION]: true };
    }
    case 'ThisExpression': return ctx.env.this ?? UNKNOWN;
    case 'Identifier': {
      if (node.name === 'undefined' && !Object.hasOwn(ctx.env, node.name)) return undefined;
      const value = Object.hasOwn(ctx.env, node.name) ? ctx.env[node.name] : UNKNOWN;
      return value === UNKNOWN ? inferredObject(node.name, ctx) : value;
    }
    case 'ArrayExpression': {
      const values:Value[]=[];
      for(const item of node.elements){
        if(item?.type==='SpreadElement'){const spread=ev(item.argument);if(!Array.isArray(spread)||spread.length+values.length>256)return UNKNOWN;values.push(...spread);}
        else values.push(item?ev(item):UNKNOWN);
        if(values.length>256)return UNKNOWN;
      }
      return values;
    }
    case 'ObjectExpression': {
      const result: Record<string, Value> = Object.create(null);
      let complete=true;
      for (const p of node.properties) {
        if (p.type === 'SpreadElement') {
          const v = ev(p.argument);
          if (v && v !== UNKNOWN && typeof v === 'object') {
            for (const k of Object.keys(v)) if (safeKey(k)) result[k] = (v as Record<string, unknown>)[k];
            if(Object.hasOwn(v,SOURCE_INITIAL)){
              const previous=(v as {[SOURCE_INITIAL]:Record<string,Value>})[SOURCE_INITIAL],initial={...previous};
              if(previous&&typeof previous==='object'&&Object.hasOwn(previous,SOURCE_CLOSED))Object.defineProperty(initial,SOURCE_CLOSED,{value:true});
              Object.defineProperty(result,SOURCE_INITIAL,{value:initial,configurable:true});
            }
            else if(!Object.hasOwn(v,SOURCE_CLOSED))delete (result as {[SOURCE_INITIAL]?:Value})[SOURCE_INITIAL];
            if(!Object.hasOwn(v,SOURCE_CLOSED))complete=false;
          }
          else {complete=false;delete (result as {[SOURCE_INITIAL]?:Value})[SOURCE_INITIAL];}
        } else if (p.type === 'ObjectProperty') {
          const key = p.computed ? ev(p.key) : nodeName(p.key);
          if(key===UNKNOWN){complete=false;delete (result as {[SOURCE_INITIAL]?:Value})[SOURCE_INITIAL];continue;}
          if (safeKey(String(key))) {
            result[String(key)] = ev(p.value);
            const initial=(result as {[SOURCE_INITIAL]?:Record<string,Value>})[SOURCE_INITIAL];if(initial)initial[String(key)]=result[String(key)];
          }else complete=false;
        }else if(p.type==='ObjectMethod'&&p.kind==='method'&&!p.computed&&safeKey(nodeName(p.key)))result[nodeName(p.key)!]={[SOURCE_FUNCTION]:true};
        else complete=false;
      }
      if(complete)Object.defineProperty(result,SOURCE_CLOSED,{value:true});
      return result;
    }
    case 'MemberExpression': case 'OptionalMemberExpression': {
      const obj = readObject ? readObject(node.object, depth + 1) : ev(node.object);
      const key = node.computed ? ev(node.property) : nodeName(node.property);
      if (key === UNKNOWN || !safeKey(String(key))) return UNKNOWN;
      if (nodeName(node.property) === 'value' && obj !== UNKNOWN && (obj === null || typeof obj !== 'object')) return obj;
      if (ctx.unwrapRefs && nodeName(node.property) === 'value' && obj !== UNKNOWN && obj != null && !Object.hasOwn(Object(obj), 'value')) return obj;
      if (obj !== UNKNOWN && obj == null && node.type === 'OptionalMemberExpression' && node.optional) return undefined;
      if (obj === UNKNOWN || obj == null) return UNKNOWN;
      const name = String(key);
      const object = Object(obj) as Record<string, unknown>;
      if(['string','number','boolean'].includes(typeof obj)&&!Object.hasOwn(object,name))return undefined;
      if (node.object.type === 'Identifier' && node.object.name === '$slots' || node.object.type === 'MemberExpression' && node.object.object.type === 'ThisExpression' && nodeName(node.object.property) === '$slots') return Object.hasOwn(object, name) ? object[name] : undefined;
      return Object.hasOwn(object, name) ? object[name] : Object.hasOwn(object,SOURCE_CLOSED)?undefined:UNKNOWN;
    }
    case 'TemplateLiteral': {
      const values = node.expressions.map(ev);
      if (values.some(value=>value===UNKNOWN||value!==null&&['object','function'].includes(typeof value))) return UNKNOWN;
      return node.quasis.map((q, i) => q.value.cooked + (i < values.length ? String(values[i]) : '')).join('');
    }
    case 'ConditionalExpression': {
      const test = ev(node.test);
      return test === UNKNOWN ? ctx.defaultBranches ? ev(node.consequent) : UNKNOWN : ev(test ? node.consequent : node.alternate);
    }
    case 'LogicalExpression': {
      const a = ev(node.left);
      if (a === UNKNOWN) return UNKNOWN;
      if (node.operator === '&&') return a ? ev(node.right) : a;
      if (node.operator === '||') return a ? a : ev(node.right);
      return a == null ? ev(node.right) : a;
    }
    case 'UnaryExpression': {
      const a = ev(node.argument);
      if (a === UNKNOWN) return UNKNOWN;
      if (node.operator === '!') return !a;
      if (node.operator === 'typeof') return functionType(a)?'function':typeof a;
      if (node.operator === '-') return typeof a === 'number' ? -a : UNKNOWN;
      if (node.operator === '+') return typeof a === 'number' ? a : UNKNOWN;
      return UNKNOWN;
    }
    case 'BinaryExpression': {
      const a = ev(node.left), b = ev(node.right);
      if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
      switch (node.operator) {
        case '===': return a === b;
        case '!==': return a !== b;
        case '==': case '!=': {
          // Objects may contain business coercion hooks. Only compare primitives;
          // never invoke valueOf/toString while interpreting application source.
          const primitive = (value: unknown): value is string | number | boolean | bigint | symbol | null | undefined => value === null || !['object', 'function'].includes(typeof value);
          if (!primitive(a) || !primitive(b)) return UNKNOWN;
          const equal = a == b;
          return node.operator === '==' ? equal : !equal;
        }
        case '+': {
          if (typeof a === 'number' && typeof b === 'number') return a + b;
          const primitive = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
          return (typeof a === 'string' || typeof b === 'string') && primitive(a) && primitive(b) ? String(a) + String(b) : UNKNOWN;
        }
        case '-': return typeof a === 'number' && typeof b === 'number' ? a - b : UNKNOWN;
        case '*': return typeof a === 'number' && typeof b === 'number' ? a * b : UNKNOWN;
        case '%': return typeof a === 'number' && typeof b === 'number' && b !== 0 ? a % b : UNKNOWN;
        case '/': return typeof a === 'number' && typeof b === 'number' && b !== 0 ? a / b : UNKNOWN;
        case '>': case '<': case '>=': case '<=': {
          // Relational comparisons must not invoke business coercion hooks either.
          const comparable = (value: unknown): value is string | number | bigint => ['string', 'number', 'bigint'].includes(typeof value);
          const left = typeof a === 'boolean' || a == null ? Number(a) : a;
          const right = typeof b === 'boolean' || b == null ? Number(b) : b;
          if (!comparable(left) || !comparable(right)) return UNKNOWN;
          if (node.operator === '>') return left > right;
          if (node.operator === '<') return left < right;
          if (node.operator === '>=') return left >= right;
          return left <= right;
        }
      }
      return UNKNOWN;
    }
    case 'OptionalCallExpression': {
      const callee = node.callee;
      if (callee.type === 'OptionalMemberExpression') {
        const receiver = ev(callee.object);
        if (receiver === UNKNOWN) return UNKNOWN;
        if (receiver == null) return callee.optional || node.optional ? undefined : UNKNOWN;
        return evaluate({ ...node, type: 'CallExpression', callee: { ...callee, type: 'MemberExpression' } } as t.CallExpression, ctx, depth + 1);
      }
      const value = ev(callee);
      if (value !== UNKNOWN && value == null && node.optional) return undefined;
      return evaluate({ ...node, type: 'CallExpression' } as t.CallExpression, ctx, depth + 1);
    }
    case 'CallExpression': {
      // A method lookup and its finite implementation read the same receiver.
      // Share only this call's receiver, retaining the caller's bindings and depth.
      let receiver: { value: Value } | undefined;
      const readReceiver = (object: t.Node, atDepth: number) =>
        (receiver ??= { value: evaluate(object, ctx, atDepth) }).value;
      const accessor=evaluateNode(node.callee,ctx,depth+1,readReceiver);
      const object = () => node.callee.type === 'MemberExpression' ? readReceiver(node.callee.object, depth + 1) : UNKNOWN;
      const name=accessor&&typeof accessor==='object'&&Object.hasOwn(accessor,SOURCE_VUE)?(accessor as{[SOURCE_VUE]:string})[SOURCE_VUE]:nodeName(node.callee);
      if (ctx.layoutFrame && accessor && typeof accessor === 'object' && Object.hasOwn(accessor, SOURCE_ARRAY_LAYOUT)) {
        const recipe = (accessor as { [SOURCE_ARRAY_LAYOUT]: import('./array-layout.js').ArrayLayout })[SOURCE_ARRAY_LAYOUT];
        const rows = node.arguments[0] ? ev(node.arguments[0]) : UNKNOWN;
        if (!Array.isArray(rows)) return UNKNOWN;
        const result: Value[] = [];
        const normalize = (items: Value[], level: number): Value[] | undefined => {
          if (level > 16 || items.length > 256) return;
          const tree:Value[]=[];
          for (const item of items) {
            if (!item || typeof item !== 'object' || --ctx.budget!.remaining < 0) return;
            const row = item as Record<string, Value>, children = row[recipe.children];
            const copy:Record<string,Value>=Object.create(null,Object.getOwnPropertyDescriptors(row));
            for(const[key,value]of Object.entries(recipe.defaults))copy[key]??=value;
            if(Array.isArray(children)&&children.length){const nested=normalize(children,level+1);if(!nested)return;copy[recipe.children]=nested;}
            else result.push(copy);
            tree.push(copy);
          }
          Object.defineProperty(tree,SOURCE_NORMALIZED,{value:true});
          return tree;
        };
        const tree=normalize(rows,0);if(!tree)return UNKNOWN;Object.defineProperty(result,SOURCE_NORMALIZED,{value:true});
        const input=node.arguments[0]?expressionText(node.arguments[0],ctx):'';
        if(ctx.initialValues&&Object.hasOwn(ctx.initialValues,input))ctx.initialValues[input]=tree;
        return result;
      }
      if (name === 'inject' && accessor && typeof accessor === 'object' && Object.hasOwn(accessor, SOURCE_VUE)) {
        const key = node.arguments[0] ? ev(node.arguments[0]) : UNKNOWN;
        return typeof key === 'string' && Object.hasOwn(ctx.provides ?? {}, key) ? ctx.provides![key] : node.arguments[1] ? ev(node.arguments[1]) : UNKNOWN;
      }
      if (accessor && typeof accessor === 'object' && Object.hasOwn(accessor, SOURCE_FIELDS)) {
        const projector = (accessor as { [SOURCE_FIELDS]: { fn: t.ArrowFunctionExpression | t.FunctionExpression | t.FunctionDeclaration; code: string } })[SOURCE_FIELDS];
        return arrowValue(projector.fn, node.arguments.map(argument => argument.type === 'SpreadElement' ? UNKNOWN : ev(argument)), { ...ctx, code: projector.code, env: {}, bindings: {} }, depth + 1);
      }
      if(accessor&&typeof accessor==='object'&&Object.hasOwn(accessor,SOURCE_COPY)){
        const recipe=(accessor as {[SOURCE_COPY]:CopyRecipe})[SOURCE_COPY];
        const deep=typeof recipe.deep==='boolean'?recipe.deep:node.arguments[recipe.deep.argument]?ev(node.arguments[recipe.deep.argument]):false;
        if(typeof deep!=='boolean'&&deep!==undefined)return UNKNOWN;
        return node.arguments[recipe.input]?copyValue(ev(node.arguments[recipe.input]),!!deep,ctx.budget!):UNKNOWN;
      }
      if(accessor&&typeof accessor==='object'&&Object.hasOwn(accessor,SOURCE_TYPE_TEST)){
        const test=(accessor as {[SOURCE_TYPE_TEST]:{index:number;type:string;negate:boolean}})[SOURCE_TYPE_TEST];
        const value=node.arguments[test.index]?ev(node.arguments[test.index]):undefined;
        return value===UNKNOWN?UNKNOWN:((functionType(value)?'function':typeof value)===test.type)!==test.negate;
      }
      if(accessor&&typeof accessor==='object'&&Object.hasOwn(accessor,SOURCE_PROJECTION))return (accessor as {[SOURCE_PROJECTION]:Value})[SOURCE_PROJECTION];
      if(!node.arguments.length&&accessor&&typeof accessor==='object'&&Object.hasOwn(accessor,SOURCE_ACCESSOR))return (accessor as {[SOURCE_ACCESSOR]:Value})[SOURCE_ACCESSOR];
      if (node.callee.type === 'Identifier' && ctx.env[node.callee.name] === CLASS_HELPER) {
        const flatten = (value: Value, level: number): string | typeof UNKNOWN => {
          if (--ctx.budget!.remaining < 0 || level > 40 || value === UNKNOWN) return UNKNOWN;
          if (!value) return '';
          if (typeof value === 'string' || typeof value === 'number') return String(value);
          if (Array.isArray(value)) {
            const values = value.map(item => flatten(item, level + 1));
            return values.includes(UNKNOWN) ? UNKNOWN : values.filter(Boolean).join(' ');
          }
          if (typeof value === 'object') {
            if (Object.values(value).includes(UNKNOWN)) return UNKNOWN;
            return Object.keys(value).filter(key => (value as Record<string, unknown>)[key]).join(' ');
          }
          return '';
        };
        return flatten(node.arguments.map(argument => argument.type === 'SpreadElement' ? UNKNOWN : ev(argument)), depth);
      }
      const member = node.callee.type === 'MemberExpression' && !node.callee.computed ? nodeName(node.callee.property) : undefined;
      if(node.callee.type==='MemberExpression'&&!node.callee.computed&&nodeName(node.callee.object)==='Array'&&!Object.hasOwn(ctx.env,'Array')&&!Object.hasOwn(ctx.bindings,'Array')){
        if(member==='isArray'&&node.arguments.length===1){const value=ev(node.arguments[0]);return value===UNKNOWN?UNKNOWN:Array.isArray(value);}
        if(member==='of'&&node.arguments.length<=256&&!node.arguments.some(a=>a.type==='SpreadElement'))return node.arguments.map(ev);
        if(member==='from'&&node.arguments.length>=1&&node.arguments.length<=2){
          const source=ev(node.arguments[0]);
          const length=Array.isArray(source)?source.length:source&&typeof source==='object'?(source as {length?:Value}).length:UNKNOWN;
          if(typeof length!=='number'||!Number.isInteger(length)||length<0||length>256)return UNKNOWN;
          const mapper=node.arguments[1];
          if(mapper&&(mapper.type!=='ArrowFunctionExpression'||mapper.async))return UNKNOWN;
          const values:Value[]=[];
          for(let i=0;i<length;i++){const item=source&&typeof source==='object'&&Object.hasOwn(source,i)?(source as Record<number,Value>)[i]:undefined;values.push(mapper?.type==='ArrowFunctionExpression'?arrowValue(mapper,[item,i],ctx,depth+1):item);if(ctx.budget!.remaining<0)return UNKNOWN;}
          return values;
        }
      }
      if(node.callee.type==='MemberExpression'&&!node.callee.computed&&member==='includes'){
        const list=object(),value=node.arguments[0]?ev(node.arguments[0]):undefined;
        if(Array.isArray(list)&&list.length<=256&&node.arguments.length===1&&value!==UNKNOWN&&!list.includes(UNKNOWN))return list.includes(value);
      }
      if(node.callee.type==='MemberExpression'&&!node.callee.computed&&member==='filter'&&node.arguments.length===1&&node.arguments[0]?.type==='ArrowFunctionExpression'&&!node.arguments[0].async){
        const list=object();if(!Array.isArray(list)||list.length>256)return UNKNOWN;
        const result:Value[]=[];for(let i=0;i<list.length;i++){const keep=arrowValue(node.arguments[0],[list[i],i],ctx,depth+1);if(keep===UNKNOWN)return UNKNOWN;if(keep)result.push(list[i]);}if(ctx.layoutFrame&&Object.hasOwn(list,SOURCE_NORMALIZED))Object.defineProperty(result,SOURCE_NORMALIZED,{value:true});return result;
      }
      if(ctx.layoutFrame&&node.callee.type==='MemberExpression'&&!node.callee.computed&&member==='sort'&&node.arguments[0]?.type==='ArrowFunctionExpression'&&!node.arguments[0].async){
        const list=object();if(!Array.isArray(list)||list.length>256)return UNKNOWN;
        const result=[...list];for(let i=1;i<result.length;i++)for(let j=i;j>0;j--){const order=arrowValue(node.arguments[0],[result[j-1],result[j]],ctx,depth+1);if(typeof order!=='number'||!Number.isFinite(order)||order<=0)break;[result[j-1],result[j]]=[result[j],result[j-1]];}if(Object.hasOwn(list,SOURCE_NORMALIZED))Object.defineProperty(result,SOURCE_NORMALIZED,{value:true});return result;
      }
      if(node.callee.type==='MemberExpression'&&!node.callee.computed&&['slice','concat','toReversed','reverse'].includes(member??'')){
        const list=object();
        if(!Array.isArray(list)||list.length>256||node.arguments.some(a=>a.type==='SpreadElement'))return UNKNOWN;
        const args=node.arguments.map(ev);
        if(args.includes(UNKNOWN))return UNKNOWN;
        if(member==='slice')return args.length<=2&&args.every(a=>a===undefined||typeof a==='number'&&Number.isFinite(a))?list.slice(args[0] as number|undefined,args[1] as number|undefined):UNKNOWN;
        if(member==='toReversed'||member==='reverse'){
          // reverse mutates its receiver. Only an owned temporary expression is
          // safe to interpret; identifier/member receivers remain unknown.
          if(args.length||member==='reverse'&&!ownedArray(node.callee.object))return UNKNOWN;
          return [...list].reverse();
        }
        const result=[...list];for(const value of args){result.push(...Array.isArray(value)?value:[value]);if(result.length>256)return UNKNOWN;}return result;
      }
      if (node.callee.type === 'MemberExpression' && !node.callee.computed && nodeName(node.callee.property) === 'trim' && !node.arguments.length) {
        const value = object();
        return typeof value === 'string' ? value.trim() : UNKNOWN;
      }
      if (node.callee.type === 'MemberExpression' && nodeName(node.callee.object) === 'Object' && !node.callee.computed && ['keys', 'entries', 'values'].includes(member ?? '') && !Object.hasOwn(ctx.env, 'Object') && !Object.hasOwn(ctx.bindings, 'Object')) {
        const value = ev(node.arguments[0]);
        return value && value !== UNKNOWN && typeof value === 'object' ? nodeName(node.callee.property) === 'entries' ? Object.entries(value) : nodeName(node.callee.property) === 'values' ? Object.values(value) : Object.keys(value) : UNKNOWN;
      }
      if (node.callee.type === 'MemberExpression' && !node.callee.computed && ['map', 'find'].includes(member ?? '')) {
        const list = object(), fn = node.arguments[0];
        if (!Array.isArray(list) || list.length > 256 || fn?.type !== 'ArrowFunctionExpression' || fn.async || node.arguments.length !== 1) return UNKNOWN;
        const result = [];
        for (let index = 0; index < list.length; index++) {
          const value = arrowValue(fn, [list[index], index, list], ctx, depth + 1);
          if (nodeName(node.callee.property) === 'find') {
            if (value === UNKNOWN) return UNKNOWN;
            if (value) return list[index];
          } else result.push(value);
          if (ctx.budget!.remaining < 0) return UNKNOWN;
        }
        return nodeName(node.callee.property) === 'find' ? undefined : result;
      }
      if (node.callee.type === 'MemberExpression' && !node.callee.computed) {
        const receiver = object(), args = node.arguments.map(argument => ev(argument));
        if (member === 'split' && typeof receiver === 'string' && args.length === 1 && typeof args[0] === 'string' && receiver.length <= 10000) { const parts = receiver.split(args[0]); return parts.length <= 256 ? parts : UNKNOWN; }
        if (member === 'join' && Array.isArray(receiver) && receiver.length <= 256 && receiver.every(value => typeof value === 'string' || typeof value === 'number') && args.length <= 1 && (args[0] === undefined || typeof args[0] === 'string')) return receiver.join(args[0] as string | undefined);
      }
      // Recognize source-level wrappers; never invoke the actual implementation.
      const wrapper = evaluateSourceWrapper(node, name, ev, fn =>
        fn?.type === 'ArrowFunctionExpression' && !fn.async ? { value: arrowValue(fn, [], ctx, depth + 1) } : undefined);
      if (wrapper) return wrapper.value;
      if (name === 'useVModel') {
        const props = ev(node.arguments[0]), key = node.arguments[1] ? ev(node.arguments[1]) : 'modelValue';
        return props && props !== UNKNOWN && typeof props === 'object' && safeKey(key) && Object.hasOwn(props, key) ? (props as Record<string, unknown>)[key] : UNKNOWN;
      }
      return UNKNOWN;
    }
  }
  return UNKNOWN;
}

function arrowValue(fn: t.ArrowFunctionExpression | t.FunctionExpression | t.FunctionDeclaration, args: Value[], ctx: ExpressionContext, depth: number): Value {
  if (depth > 40) return UNKNOWN;
  const local = { ...ctx, env: { ...ctx.env } };
  fn.params.forEach((param, index) => bindPattern(param, args[index], local.env));
  const ev = (node: t.Node | null | undefined) => evaluate(node, local, depth + 1);
  if (fn.body.type !== 'BlockStatement') return ev(fn.body);
  const statements = (body: t.Statement[]): { value: Value } | undefined => {
    for (const statement of body) {
      if (--local.budget!.remaining < 0) return { value: UNKNOWN };
      if (statement.type === 'ReturnStatement') return { value: statement.argument ? ev(statement.argument) : undefined };
      if (statement.type === 'VariableDeclaration') {
        for (const item of statement.declarations) bindPattern(item.id, ev(item.init), local.env);
      } else if (statement.type === 'IfStatement') {
        const condition = ev(statement.test);
        if (condition === UNKNOWN) return { value: UNKNOWN };
        const branch = condition ? statement.consequent : statement.alternate;
        if (branch) {
          const result = statements(branch.type === 'BlockStatement' ? branch.body : [branch]);
          if (result) return result;
        }
      } else return { value: UNKNOWN };
    }
  };
  return statements(fn.body.body)?.value;
}

/** Evaluate only an already-proved read-only presentation recipe. */
export function sourceCall(value:Value,args:Value[]):Value{
  if(!value||typeof value!=='object'||!Object.hasOwn(value,SOURCE_FIELDS))return UNKNOWN;
  const recipe=(value as {[SOURCE_FIELDS]:{fn:t.ArrowFunctionExpression|t.FunctionExpression|t.FunctionDeclaration;code:string}})[SOURCE_FIELDS];
  return arrowValue(recipe.fn,args,{code:recipe.code,env:{},bindings:{},budget:{remaining:10000}},0);
}

export function parseSourceExpression(text: string, ctx?: ExpressionContext): t.Expression | undefined {
  const cached = ctx?.expressions?.get(text);
  if (cached !== undefined) return cached ?? undefined;
  let expression: t.Expression | null = null;
  try { expression = parseExpression(text, { plugins: ['typescript'] }); }
  catch { /* Invalid syntax stays opaque, including on later requests. */ }
  ctx?.expressions?.set(text, expression);
  return expression ?? undefined;
}

export function evaluateString(text: string, ctx: ExpressionContext): Value {
  if (Object.hasOwn(ctx.bindings, text.trim())) return ctx.bindings[text.trim()];
  try {
    const expression = parseSourceExpression(text, ctx);
    return expression ? evaluate(expression, { ...ctx, code: text }) : UNKNOWN;
  }
  catch { return UNKNOWN; }
}

interface PatternOptions {
  /** Slots interpret defaults, computed keys and object rest; declarations keep
   * opaque/missing values and leave component defaults to their caller. */
  context: ExpressionContext;
  onBind?: (name: string) => void;
}

export function bindPattern(pattern: t.Node | null | undefined, value: Value, env: Record<string, Value>, options?: PatternOptions): void {
  if (!pattern) return;
  const bind = (node: t.Node | null, next: Value) => bindPattern(node, next, env, options);
  if (pattern.type === 'Identifier') {
    env[pattern.name] = value;
    options?.onBind?.(pattern.name);
  } else if (pattern.type === 'AssignmentPattern') {
    bind(pattern.left, options && value === undefined ? evaluate(pattern.right, options.context) : value);
  } else if (pattern.type === 'ArrayPattern') {
    pattern.elements.forEach((p, i) => bind(p, Array.isArray(value) ? value[i] : UNKNOWN));
  } else if (pattern.type === 'ObjectPattern') {
    const object = value && value !== UNKNOWN && typeof value === 'object' ? value as Record<string, Value> : undefined;
    const omitted = new Set<string>();
    for (const property of pattern.properties) {
      if (property.type === 'RestElement') {
        if (options) bind(property.argument, object ? Object.fromEntries(Object.entries(object).filter(([key]) => safeKey(key) && !omitted.has(key))) : UNKNOWN);
        continue;
      }
      const key = options && property.computed ? evaluate(property.key, options.context) : nodeName(property.key);
      if (typeof key !== 'string' || options && !safeKey(key)) { bind(property.value, UNKNOWN); continue; }
      omitted.add(key);
      let field: Value = UNKNOWN;
      if (object) {
        if (Object.hasOwn(object, key)) field = object[key];
        else if (options) field = undefined;
      }
      bind(property.value, field);
    }
  }
}
