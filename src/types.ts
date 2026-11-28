export type RenderMode = 'light' | 'shadow';
export interface SkeletonHints {
  /** Loading projects proven collection guards; source preserves source-default state. */
  state?: 'loading' | 'source';
  repeat?: number;
  lines?: number;
  minHeight?: number;
  bindings?: Record<string, unknown>;
}
export interface SkeletonTarget {
  id: string;
  source: string;
  export?: string;
  /** Import binding used by an init-generated boundary; selects its source subtree. */
  region?: string;
  /** Finite source call sites, selected by their data-sk-context attribute. */
  contexts?: Record<string, { source: string }>;
  kind?: 'page' | 'request';
  render?: RenderMode;
  styles?: string[];
  adapters?: Record<string, string>;
  hints?: SkeletonHints;
  variants?: Record<string, SkeletonHints>;
  defaultVariant?: string;
  route?: string | string[];
}
export interface SkeletonConfig {
  targets: SkeletonTarget[];
  /** Explicit source binding names for live widgets or opaque graphic regions. */
  componentPolicies?: Record<string, import('./policy.js').ComponentPolicy>;
  aliases?: Record<string, string>;
  /** Static component names mapped to local source; explicit mappings win over declarations. */
  components?: Record<string, string>;
  /** Static expression values scoped to a project-relative component source file. */
  componentBindings?: Record<string, Record<string, unknown>>;
  /** Defaults to components.d.ts and src/components.d.ts. Never executes declaration imports. */
  componentDeclarations?: string[];
  /** Opt-in library layout adapters; require imports or component declarations identifying the package/export. */
  componentPresets?: ('naive-ui' | 'element-plus' | 'ant-design-vue' | 'antd' | 'vuedraggable')[];
  styles?: StyleOptions;
  outDir?: string;
  hintsFile?: string;
}
export interface StyleOptions {
  /** Keep only statically possible class selectors. Defaults on. */
  prune?: boolean;
  less?: boolean;
  /** SCSS/Sass data compilation defaults on; no application JS importers run. */
  sass?: boolean;
  /** Tailwind 4 CSS directives are detected automatically; JS plugins/configs never run. */
  tailwind?: boolean;
  /** Mini + Attributify utilities. Configuration is data, not application config execution. */
  unocss?: boolean | {
    theme?: Record<string, unknown>;
    shortcuts?: Record<string, string>;
    safelist?: string[];
    attributify?: boolean;
  };
}
export interface Diagnostic {
  code: string;
  message: string;
  file: string;
  line: number;
  node?: string;
  expression?: string;
  component?: string;
  /** Illustrative values for review, never applied automatically. */
  bindingExamples?: Record<string, unknown>;
  variants?: string[];
}
export interface Evidence {
  kind: 'repeat' | 'branch' | 'binding' | 'component' | 'text' | 'style';
  expression: string;
  decision: string;
  file: string;
  line: number;
  node?: string;
  variants?: string[];
}
export interface SourceLocation { file: string; line: number }
export interface SkeletonView { html: string; css: string; sourceIds?:string[] }
export interface SkeletonArtifact {
  id: string;
  kind: 'page' | 'request';
  render: RenderMode;
  defaultVariant: string;
  variants: Record<string, SkeletonView>;
  /** Context + declared state -> precompiled view; runtime never infers markup. */
  contexts?: Record<string, Record<string, string>>;
  diagnostics: Diagnostic[];
  evidence: Evidence[];
  sources: Record<string, SourceLocation>;
  source: string;
}
export interface ManifestEntry {
  hash: string;
  outputHash: string;
  dependencies: Record<string, string>;
}
export interface Manifest { version: string; targets: Record<string, ManifestEntry> }

export function defineSkelCastConfig(config: SkeletonConfig): SkeletonConfig { return config; }
