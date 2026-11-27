import { readProjectState, type Project } from './generator.js';
import { analyzeQuality } from './quality.js';
import { createRepairGuideBuilder } from './repairs.js';

export interface DiagnoseOptions { node?: string; variant?: string }

/** Source-only repair context for coding agents. Never executes application code
 * or applies the illustrative repair examples. */
export async function diagnoseProject(project: Project, id: string, options: DiagnoseOptions = {}) {
  const target = project.config.targets.find(target => target.id === id);
  if (!target) throw new Error(`Unknown skeleton ${id}`);
  if (options.variant && !Object.hasOwn(target.variants ?? { default: {} }, options.variant)) throw new Error(`Unknown variant ${options.variant} for ${id}`);
  const { statuses: [status], artifacts } = await readProjectState(project, id);
  const context = { ...status, configFile: project.configFile, hintsFile: project.hintsFile, target };
  if (status.state === 'missing' || status.state === 'corrupt') {
    if (options.node) throw new Error(`Cannot select a node in a ${status.state} artifact; run skelcast sync first`);
    return { ...context, needsReview: true, variants: {} };
  }
  const artifact = artifacts.get(id)!;
  if (options.variant && !Object.hasOwn(artifact.variants, options.variant)) throw new Error(`Variant ${options.variant} is not generated; run skelcast sync first`);
  const names = options.variant ? [options.variant] : Object.keys(artifact.variants);
  if (options.node && !Object.hasOwn(artifact.sources, options.node) && !artifact.diagnostics.some(d => d.node === options.node)) throw new Error(`Unknown source node ${options.node} for ${id}`);
  const quality = analyzeQuality(artifact);
  const repairGuide = createRepairGuideBuilder(artifact, target);
  const variants = Object.fromEntries(names.map(variant => {
    const diagnostics = artifact.diagnostics.filter(d => (!d.variants || d.variants.includes(variant)) && (!options.node || d.node === options.node));
    const nodes = options.node ? [options.node] : [...new Set(diagnostics.flatMap(d => d.node ? [d.node] : []))];
    const locations = nodes.map(node => {
      const guide = repairGuide(node, variant);
      return { node, ...guide, examples: guide.diagnostics.length ? guide.examples : [] };
    });
    const evidence = artifact.evidence.filter(e => (!e.variants || e.variants.includes(variant)) && (!options.node || e.node === options.node));
    return [variant, { quality: quality.variants[variant], diagnostics, evidence, locations }];
  }));
  const needsReview = status.state !== 'ready' || Object.values(variants).some(view => view.diagnostics.length > 0 || view.quality.issues.length > 0);
  return { ...context, defaultVariant: artifact.defaultVariant, needsReview, variants };
}
