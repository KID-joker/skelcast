import type * as t from '@babel/types';
import type { ElementNode, TemplateChildNode } from '@vue/compiler-dom';
import type { parse as parseSFC } from '@vue/compiler-sfc';
import type { Ast, ExpressionContext, Value } from './expression.js';
import type { CSSBinding } from './styles.js';
import type { ComponentReference } from './presets/types.js';

export interface ModuleInfo {
  file: string;
  code: string;
  ast: t.File;
  functions: Map<string, Ast>;
  imports: Map<string, ComponentReference>;
  exports: Map<string, string>;
  reexports: Map<string, ComponentReference>;
  exportAll: ComponentReference[];
  env: Record<string, Value>;
  setupDeclarations: t.VariableDeclarator[];
  descriptor?: ReturnType<typeof parseSFC>['descriptor'];
  scopes: string[];
  boundaries: Set<string>;
  propDefaults: Record<string, Value>;
  propBindings: string[];
  inheritAttrs: boolean;
  cssBindings: CSSBinding[];
}
export interface ResolvedComponent { module: ModuleInfo; fn?: Ast }
export const ambiguousExport = Symbol('ambiguous-export');
export type SourceSlot = (
  | { nodes: Ast[]; context: RenderContext; framework: 'jsx' }
  | { nodes: Ast[]; context: RenderContext; framework: 'render'; slots?: Record<string, SourceSlot> }
  | { nodes: TemplateChildNode[]; context: RenderContext; framework: 'vue' }) & { parameter?:Ast;renderFunction?:Ast };
/** Only source positions cross the Babel/Vue frontend boundary. */
export interface SourceNode { start?: number | null; end?: number | null; loc?: { start: { line: number; offset?: number }; end?: { line?: number; offset?: number } } | null }
export const slotValue = Symbol('source-slot');
export interface RenderContext extends ExpressionContext { module: ModuleInfo; scopes: string[]; depth: number; slots?: Record<string, SourceSlot>; slotNodes?: Value[]; layoutUnresolved?: boolean; initialValues?:Record<string,Value>; mode?: 'auto' | 'preserve' | 'mask'; control?: boolean; dataSlot?: boolean; textWidth?: string; loading?:boolean; projectedCollections?:Set<string>; viewportFrames?: { min: number; max?: number; provides: Record<string, Value> }[]; fallthrough?: { node: ElementNode; props: Record<string, Value> } }
