import type { TemplateChildNode as VueNode } from '@vue/compiler-dom';
import type { Evidence, SkeletonHints, SkeletonTarget } from '../types.js';
import type { Ast, Value } from './expression.js';
import type { RenderContext, SourceSlot } from './context.js';
import type { CompilerOptions } from './modules.js';
import type { ComponentReference } from './presets/types.js';

/** Internal capabilities consumed by framework frontends and HTML output. */
export interface RenderHost {
  readonly root: string;
  readonly target: SkeletonTarget;
  readonly hints: SkeletonHints;
  readonly options: CompilerOptions;
  budget(ctx: RenderContext, node: Ast): string | undefined;
  diagnose(code: string, message: string, ctx: RenderContext, node?: Ast, id?: string): void;
  record(kind: Evidence['kind'], expression: string, decision: string, ctx: RenderContext, node?: Ast): void;
  nodeId(ctx: RenderContext, node?: Ast): string;
  fallback(ctx: RenderContext, node: Ast, message: string, attrs?: string): string;
  text(ctx: RenderContext, node: Ast, multiline?: boolean): string;
  masked(ctx: RenderContext): boolean;
  contentText(value: unknown, ctx: RenderContext, node: Ast): string;
  contentContext(ctx: RenderContext, props: Record<string, Value>, tag?: string): RenderContext;
  attributes(props: Record<string, Value>): string;
  element(tag: string, props: Record<string, Value>, children: string, ctx: RenderContext, node: Ast): string;
  staticHTML(source: string, ctx: RenderContext, origin: Ast): string;
  jsx(node: Ast, ctx: RenderContext): Promise<string>;
  jsxNodes(nodes: Ast[], ctx: RenderContext): Promise<string>;
  vueNode(node: VueNode, ctx: RenderContext, skipFor?: boolean): Promise<string>;
  vueNodes(nodes: VueNode[], ctx: RenderContext): Promise<string>;
  renderSlot(slot: SourceSlot, ctx: RenderContext): Promise<string>;
  scan(file: string): Promise<void>;
  component(file: string, exported: string, props?: Record<string, Value>, parent?: RenderContext, node?: Ast): Promise<string>;
  componentReference(tag: string, ctx: RenderContext): Promise<ComponentReference | undefined>;
  prepareFunction(fn: Ast, ctx: RenderContext, props: Record<string, Value>): Ast | undefined;
  preset(tag: string, reference: ComponentReference | undefined, props: Record<string, Value>, nodes: Ast[], ctx: RenderContext, node: Ast, framework: 'vue' | 'jsx'): Promise<string | undefined>;
}
