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
  outDir?: string;
  hintsFile?: string;
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
