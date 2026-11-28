import { parse, type RootNode, type TemplateChildNode, type SimpleExpressionNode } from '@vue/compiler-dom';
import type { SkeletonArtifact } from './types.js';
import { readProjectState, type Project } from './generator.js';
import { digest } from './compiler/styles.js';

export interface VariantQuality {
  nodes: number;
  placeholders: number;
  preservedNodes: number;
  fallbacks: number;
  unresolvedComponents: string[];
  issues: string[];
  fallbackRatio: number;
}
export interface ReviewLocation { key: string; file: string; line: number; node?: string; codes: string[]; expressions: string[]; components: string[]; variants: string[] }
export interface ArtifactQuality {
  id: string;
  needsReview: boolean;
  variants: Record<string, VariantQuality>;
  diagnostics: Record<string, number>;
  /** Unique source locations needing human review, not a count of human edits. */
  review: { locations: number; items: ReviewLocation[] };
}
/** Structural analysis only. CSS visibility and similarity require browser verification. */
export function analyzeQuality(artifact: SkeletonArtifact): ArtifactQuality {
  const result: ArtifactQuality = { id: artifact.id, needsReview: false, variants: {}, diagnostics: {}, review: { locations: 0, items: [] } };
  const locations = new Map<string, ReviewLocation>();
  for (const diagnostic of artifact.diagnostics) {
    const key = digest(JSON.stringify([diagnostic.file, diagnostic.node ?? diagnostic.line]));
    let location = locations.get(key);
    if (!location) {
      location = { key, file: diagnostic.file, line: diagnostic.line, node: diagnostic.node, codes: [], expressions: [], components: [], variants: [] };
      locations.set(key, location);
    }
    if (!location.codes.includes(diagnostic.code)) location.codes.push(diagnostic.code);
    if (diagnostic.expression && !location.expressions.includes(diagnostic.expression)) location.expressions.push(diagnostic.expression);
    if (diagnostic.component && !location.components.includes(diagnostic.component)) location.components.push(diagnostic.component);
    for (const variant of diagnostic.variants ?? Object.keys(artifact.variants)) if (!location.variants.includes(variant)) location.variants.push(variant);
  }
  result.review.items = [...locations.values()];
  result.review.locations = locations.size;
  for (const diagnostic of artifact.diagnostics) result.diagnostics[diagnostic.code] = (result.diagnostics[diagnostic.code] ?? 0) + 1;
  for (const [name, view] of Object.entries(artifact.variants)) {
    const quality: VariantQuality = { nodes: 0, placeholders: 0, preservedNodes: 0, fallbacks: 0, fallbackRatio: 0, unresolvedComponents: [], issues: [] };
    const walk = (node: RootNode | TemplateChildNode | SimpleExpressionNode) => {
      if (node.type === 1) {
        const has = (name: string) => node.props.some((prop) => prop.type === 6 && prop.name === name);
        quality.nodes++;
        if (has('data-sk-leaf') || has('data-sk-multiline')) quality.placeholders++;
        if (has('data-sk-control') || node.children.some(child=>child.type===2&&!!child.content.trim())) quality.preservedNodes++;
        if (has('data-sk-fallback') || has('data-sk-opaque')) quality.fallbacks++;
        if (node.tagType === 1) quality.unresolvedComponents.push(node.tag);
      }
      if ('children' in node) for (const child of node.children) if (typeof child === 'object') walk(child);
    };
    try { walk(parse(view.html)); }
    catch (error) { quality.issues.push(`INVALID_HTML: ${String(error)}`); }
    quality.unresolvedComponents = [...new Set(quality.unresolvedComponents)].sort();
    quality.fallbackRatio = quality.nodes ? quality.fallbacks / quality.nodes : 0;
    if (!quality.placeholders && !quality.preservedNodes) quality.issues.push('EMPTY_SKELETON: No placeholder leaves');
    if (quality.fallbacks) quality.issues.push('FALLBACK_REGIONS: Review opaque layout regions');
    if (quality.unresolvedComponents.length) quality.issues.push('UNRESOLVED_COMPONENTS: Custom tags remain in static HTML');
    result.variants[name] = quality;
  }
  result.needsReview = Object.values(result.variants).some(v => v.issues.length > 0) || artifact.diagnostics.length > 0;
  return result;
}

export interface QualityBaseline { version: 1; targets: Record<string, { locations: ReviewLocation[] }> }
export interface ReviewProgress { before: number; remaining: number; resolved: number; added: number }
type QualityRow = Awaited<ReturnType<typeof qualityProject>>[number];
export function createQualityBaseline(rows: QualityRow[]): QualityBaseline {
  return { version: 1, targets: Object.fromEntries(rows.map(row => {
    if (!('review' in row) || row.state !== 'ready') throw new Error(`Cannot baseline ${row.state} artifact ${row.id}; sync first`);
    return [row.id, { locations: row.review.items }];
  })) };
}
export function compareQualityBaseline(rows: QualityRow[], baseline: QualityBaseline): Record<string, ReviewProgress> {
  if (baseline?.version !== 1 || !baseline.targets || typeof baseline.targets !== 'object' || Array.isArray(baseline.targets) || Object.values(baseline.targets).some(target => !target || !Array.isArray(target.locations) || target.locations.some(item => !item || typeof item.key !== 'string'))) throw new Error('Invalid SkelCast quality baseline');
  return Object.fromEntries(rows.map(row => {
    if (!('review' in row)) throw new Error(`Cannot compare unavailable artifact ${row.id}`);
    const before = new Set((baseline.targets[row.id]?.locations ?? []).map(location => location.key));
    const after = new Set(row.review.items.map(location => location.key));
    return [row.id, { before: before.size, remaining: after.size, resolved: [...before].filter(key => !after.has(key)).length, added: [...after].filter(key => !before.has(key)).length }];
  }));
}

export async function qualityProject(project: Project, id?: string) {
  const { statuses, artifacts } = await readProjectState(project, id);
  return statuses.map(status => {
    if (status.state === 'missing' || status.state === 'corrupt') return { id: status.id, state: status.state, needsReview: true, reason: status.reason };
    const quality = analyzeQuality(artifacts.get(status.id)!);
    return { ...quality, state: status.state, needsReview: quality.needsReview || status.state !== 'ready', reason: status.reason };
  });
}
