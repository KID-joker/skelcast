import type { parse as parseSFC } from '@vue/compiler-sfc';
import type { Ast, ExpressionContext, Value } from './expression.js';
import type { CSSBinding } from './styles.js';
import type { ComponentReference } from './presets/types.js';

export interface ModuleInfo {
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
export interface ResolvedComponent { module: ModuleInfo; fn?: Ast }
export const ambiguousExport = Symbol('ambiguous-export');
export interface SourceSlot { nodes: Ast[]; context: RenderContext; framework: 'vue' | 'jsx' }
export const slotValue = Symbol('source-slot');
export interface RenderContext extends ExpressionContext { module: ModuleInfo; scopes: string[]; depth: number; slots?: Record<string, SourceSlot>; mode?: 'auto' | 'preserve' | 'mask'; control?: boolean; fallthrough?: { node: Ast; props: Record<string, Value> } }
