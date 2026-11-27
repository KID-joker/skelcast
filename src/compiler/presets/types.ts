import type { SkeletonConfig, SkeletonHints } from '../../types.js';
import type { TableColumns } from './columns.js';

/** Identity from a source import or GlobalComponents declaration, never a tag prefix. */
export interface ComponentReference {
  request: string;
  exported: string;
  file?: string;
}
export type ComponentRole = 'layout' | 'data' | 'control';
export interface Presentation {
  tag: string;
  style?: string;
  leaf?: boolean;
  /** Preset-owned tags carry data-sk-layout; source slot markup stays unchanged. */
  children: string;
  css?: string;
  className?: string;
  notes?: string[];
}
export interface ComponentPreset {
  id: NonNullable<SkeletonConfig['componentPresets']>[number];
  package: string;
  resolve?: (reference: ComponentReference) => string | undefined;
  role: (name: string, props: Record<string, unknown>) => ComponentRole | undefined;
  slots: (name: string) => readonly string[];
  present: (
    name: string,
    props: Record<string, unknown>,
    children: string,
    text: string,
    hints: SkeletonHints,
    policy: { mask: boolean; slots: Record<string, string>; columns: TableColumns },
  ) => Presentation | undefined;
}
