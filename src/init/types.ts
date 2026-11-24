import type { SkeletonConfig, SkeletonTarget } from '../types.js';
import type { Edit } from './ast.js';

export interface InitDiagnostic { code: string; message: string; file: string; line?: number }
export interface InitChange { file: string; before: string | null; after: string; reason: string }
export interface InitOptions { dryRun?: boolean }
export interface InitReport {
  root: string;
  dryRun: boolean;
  scanned: number;
  targets: SkeletonTarget[];
  changes: InitChange[];
  diagnostics: InitDiagnostic[];
  generated?: { id: string; state: 'generated' | 'reused'; diagnostics: number }[];
  backup?: string;
}
export interface ComponentInfo { name: string; exported: string; node: any }
export interface FileAnalysis { edits: Edit[]; targets: SkeletonTarget[]; diagnostics: InitDiagnostic[] }
export interface AnalysisContext {
  file: string;
  source: string;
  page: boolean;
  routes: string[];
  existing: SkeletonConfig;
  usedIds: Set<string>;
}
export function targetId(ctx: AnalysisContext, suffix: string): string {
  const base = ctx.file.replace(/^(?:src\/)?(?:pages|views)\//, '').replace(/^src\//, '').replace(/\.(?:tsx?|jsx?|vue)$/, '').replace(/\/index$/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^a-zA-Z0-9]+/g, '.').toLowerCase();
  let id = `${base || 'app'}.${suffix}`, i = 2;
  while (ctx.usedIds.has(id)) id = `${base || 'app'}.${suffix}.${i++}`;
  ctx.usedIds.add(id);
  return id;
}
