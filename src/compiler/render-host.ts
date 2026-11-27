import type { TemplateChildNode as VueNode } from '@vue/compiler-dom';
import type { Diagnostic, Evidence, SkeletonHints, SkeletonTarget } from '../types.js';
import type { Ast, Value } from './expression.js';
import type { RenderContext, SourceSlot, SourceNode } from './context.js';
import type { CompilerOptions } from './modules.js';
import type { ComponentReference } from './presets/types.js';

/** Internal capabilities consumed by framework frontends and HTML output. */
export interface ElementMarkers { layout?: boolean; leaf?: boolean; opaque?: boolean }

export interface RenderHost {
  readonly root: string;
  readonly target: SkeletonTarget;
  readonly hints: SkeletonHints;
  readonly options: CompilerOptions;
  budget(ctx: RenderContext, node: SourceNode | undefined, cost?: number): string | undefined;
  diagnose(code: string, message: string, ctx: RenderContext, node?: SourceNode, id?: string): Diagnostic;
  record(kind: Evidence['kind'], expression: string, decision: string, ctx: RenderContext, node?: SourceNode): void;
  nodeId(ctx: RenderContext, node?: SourceNode): string;
  fallback(ctx: RenderContext, node: SourceNode | undefined, message: string, attrs?: string): string;
  text(ctx: RenderContext, node: SourceNode | undefined, multiline?: boolean): string;
  masked(ctx: RenderContext): boolean;
  contentText(value: unknown, ctx: RenderContext, node: SourceNode | undefined): string;
  contentContext(ctx: RenderContext, props: Record<string, Value>, tag?: string): RenderContext;
  attributes(props: Record<string, Value>): string;
  element(tag: string, props: Record<string, Value>, children: string, ctx: RenderContext, node: SourceNode | undefined, markers?: ElementMarkers): string;
  staticHTML(source: string, ctx: RenderContext, origin: SourceNode): string;
  image(props: Record<string, Value>, ctx: RenderContext, node: SourceNode): Promise<string>;
  jsx(node: Ast | null | undefined, ctx: RenderContext): Promise<string>;
  vueExpression(node: Ast | null | undefined, ctx: RenderContext): Promise<string>;
  jsxNodes(nodes: (Ast | null)[], ctx: RenderContext): Promise<string>;
  vueNode(node: VueNode, ctx: RenderContext, skipFor?: boolean): Promise<string>;
  vueNodes(nodes: VueNode[], ctx: RenderContext): Promise<string>;
  renderSlot(slot: SourceSlot, ctx: RenderContext, argument?:Value,initial?:Value): Promise<string>;
  selectVueNode(node:VueNode,ctx:RenderContext):'skip'|'ancestor'|'target'|undefined;
  captureVueRegion(render:()=>Promise<string>):Promise<string>;
  hasSelectedSlot(slot:SourceSlot):boolean;
  scan(file: string): Promise<void>;
  component(file: string, exported: string, props?: Record<string, Value>, parent?: RenderContext, node?: SourceNode): Promise<string>;
  componentReference(tag: string, ctx: RenderContext): Promise<ComponentReference | undefined>;
  prepareFunction(fn: Ast | undefined, ctx: RenderContext, props: Record<string, Value>): Ast | undefined;
  preset(tag: string, reference: ComponentReference | undefined, props: Record<string, Value>, slot: SourceSlot, node: SourceNode): Promise<string | undefined>;
}
