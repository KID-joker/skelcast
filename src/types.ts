export type RenderMode = 'light' | 'shadow';
export interface SkeletonHints {
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
  aliases?: Record<string, string>;
  /** Static component names mapped to local source; explicit mappings win over declarations. */
  components?: Record<string, string>;
  /** Static expression values scoped to a project-relative component source file. */
  componentBindings?: Record<string, Record<string, unknown>>;
  /** Defaults to components.d.ts and src/components.d.ts. Never executes declaration imports. */
  componentDeclarations?: string[];
  /** Opt-in library layout adapters; require imports or component declarations identifying the package/export. */
  componentPresets?: ('naive-ui' | 'element-plus' | 'ant-design-vue' | 'antd')[];
  styles?: StyleOptions;
  outDir?: string;
  hintsFile?: string;
}
export interface StyleOptions {
  less?: boolean;
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
}
export interface Evidence {
  kind: 'repeat' | 'branch' | 'binding' | 'component' | 'text' | 'style';
  expression: string;
  decision: string;
  file: string;
  line: number;
}
export interface SourceLocation { file: string; line: number }
export interface SkeletonView { html: string; css: string }
export interface SkeletonArtifact {
  id: string;
  kind: 'page' | 'request';
  render: RenderMode;
  defaultVariant: string;
  variants: Record<string, SkeletonView>;
  diagnostics: Diagnostic[];
  evidence: Evidence[];
  sources: Record<string, SourceLocation>;
  source: string;
}
export interface ManifestEntry {
  file: string;
  hash: string;
  outputHash: string;
  dependencies: Record<string, string>;
}
export interface Manifest { version: string; configHash: string; targets: Record<string, ManifestEntry> }

export function defineSkelCastConfig(config: SkeletonConfig): SkeletonConfig { return config; }
