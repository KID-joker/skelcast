import { parse, type RootNode, type TemplateChildNode, type SimpleExpressionNode } from '@vue/compiler-dom';
import type { SkeletonArtifact } from './types.js';
import { checkProject, readArtifact, type Project } from './generator.js';

export interface VariantQuality {
  nodes: number;
  placeholders: number;
  preservedNodes: number;
  fallbacks: number;
  unresolvedComponents: string[];
  issues: string[];
}
export interface ArtifactQuality {
  id: string;
  needsReview: boolean;
  variants: Record<string, VariantQuality>;
  diagnostics: Record<string, number>;
}
/** Structural analysis only. CSS visibility and similarity require browser verification. */
export function analyzeQuality(artifact: SkeletonArtifact): ArtifactQuality {
  const result: ArtifactQuality = { id: artifact.id, needsReview: false, variants: {}, diagnostics: {} };
  for (const diagnostic of artifact.diagnostics) result.diagnostics[diagnostic.code] = (result.diagnostics[diagnostic.code] ?? 0) + 1;
  for (const [name, view] of Object.entries(artifact.variants)) {
    const quality: VariantQuality = { nodes: 0, placeholders: 0, preservedNodes: 0, fallbacks: 0, unresolvedComponents: [], issues: [] };
    const walk = (node: RootNode | TemplateChildNode | SimpleExpressionNode) => {
      if (node.type === 1) {
        const has = (name: string) => node.props.some((prop) => prop.type === 6 && prop.name === name);
        quality.nodes++;
        if (has('data-sk-leaf') || has('data-sk-multiline')) quality.placeholders++;
        if (has('data-sk-control')) quality.preservedNodes++;
        if (has('data-sk-fallback') || has('data-sk-opaque')) quality.fallbacks++;
        if (node.tagType === 1) quality.unresolvedComponents.push(node.tag);
      }
      if ('children' in node) for (const child of node.children) if (typeof child === 'object') walk(child);
    };
    try { walk(parse(view.html)); }
    catch (error) { quality.issues.push(`INVALID_HTML: ${String(error)}`); }
    quality.unresolvedComponents = [...new Set(quality.unresolvedComponents)].sort();
    if (!quality.placeholders && !quality.preservedNodes) quality.issues.push('EMPTY_SKELETON: No placeholder leaves');
    if (quality.fallbacks) quality.issues.push('FALLBACK_REGIONS: Review opaque layout regions');
    if (quality.unresolvedComponents.length) quality.issues.push('UNRESOLVED_COMPONENTS: Custom tags remain in static HTML');
    result.variants[name] = quality;
  }
  result.needsReview = Object.values(result.variants).some(v => v.issues.length > 0) || artifact.diagnostics.length > 0;
  return result;
}

export async function qualityProject(project: Project, id?: string) {
  if (id && !project.config.targets.some(target => target.id === id)) throw new Error(`Unknown skeleton ${id}`);
  const statuses = (await checkProject(project)).filter(status => !id || status.id === id);
  return Promise.all(statuses.map(async status => {
    if (status.state === 'missing' || status.state === 'corrupt') return { id: status.id, state: status.state, needsReview: true, reason: status.reason };
    const quality = analyzeQuality(await readArtifact(project, status.id));
    return { ...quality, state: status.state, needsReview: quality.needsReview || status.state !== 'ready', reason: status.reason };
  }));
}
