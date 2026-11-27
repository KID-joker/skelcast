import type { Diagnostic, Evidence, SkeletonArtifact, SkeletonTarget, SourceLocation } from './types.js';

export interface RepairExample {
  kind: 'binding' | 'adapter' | 'source';
  title: string;
  description: string;
  files: { name: string; code: string }[];
  bindings?: Record<string, unknown>;
}
export interface RepairGuide {
  source?: SourceLocation;
  diagnostics: Diagnostic[];
  evidence: Evidence[];
  examples: RepairExample[];
}

function indexBy<T>(items: T[], keyOf: (item: T) => string | undefined): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === undefined) continue;
    const group = index.get(key);
    if (group) group.push(item); else index.set(key, [item]);
  }
  return index;
}

const locationKey = (source: SourceLocation) => JSON.stringify([source.file, source.line]);
const inVariant = (item: { variants?: string[] }, variant: string) => !item.variants || item.variants.includes(variant);

/** Index one artifact per inspection, preserving evidence order and line-level facts. */
export function createRepairGuideBuilder(artifact: SkeletonArtifact, target?: SkeletonTarget) {
  const diagnosticsByNode = indexBy(artifact.diagnostics, item => item.node);
  const evidence = artifact.evidence.map((item, order) => ({ item, order }));
  const evidenceByNode = indexBy(evidence, entry => entry.item.node);
  const evidenceByLocation = indexBy(evidence, entry => !entry.item.node ? locationKey(entry.item) : undefined);
  return (node: string, variant: string): RepairGuide => {
    const diagnostics = (diagnosticsByNode.get(node) ?? []).filter(item => inVariant(item, variant));
    const source = artifact.sources[node] ?? diagnostics[0];
    const candidates = [...(evidenceByNode.get(node) ?? []), ...(source ? evidenceByLocation.get(locationKey(source)) ?? [] : [])];
    const selected = candidates.sort((a, b) => a.order - b.order)
      .filter((entry, index) => (!index || entry.order !== candidates[index - 1].order) && inVariant(entry.item, variant))
      .map(entry => entry.item);
    return repairGuide(artifact, variant, target, source, diagnostics, selected);
  };
}

/** All snippets are reviewable suggestions; this module never writes project files. */
export function buildRepairGuide(artifact: SkeletonArtifact, node: string, variant: string, target?: SkeletonTarget): RepairGuide {
  return createRepairGuideBuilder(artifact, target)(node, variant);
}

function repairGuide(artifact: SkeletonArtifact, variant: string, target: SkeletonTarget | undefined, source: SourceLocation | undefined, diagnostics: Diagnostic[], evidence: Evidence[]): RepairGuide {
  const examples: RepairExample[] = [];
  const bindings: Record<string, unknown> = Object.create(null);
  for (const diagnostic of diagnostics) for (const [expression, value] of Object.entries(diagnostic.bindingExamples ?? {})) {
    bindings[`${diagnostic.file}::${expression}`] = value;
  }
  if (Object.keys(bindings).length) {
    const overridden = Object.keys(bindings).some(key => Object.hasOwn(target?.variants?.[variant]?.bindings ?? {}, key));
    examples.push({ kind: 'binding', title: 'Provide explicit bindings',
      description: `Illustrative values: replace them with the layout you expect.${overridden ? ' This variant overrides these bindings; edit its configuration instead of shared hints.' : ' Review values and merge them into the target hints with skelcast hints, then run skelcast sync.'}`,
      files: [{ name: overridden ? 'skelcast.config.mjs · variant bindings' : 'skelcast.hints.json', code: JSON.stringify(overridden
        ? { targets: [{ id: artifact.id, variants: { [variant]: { bindings } } }] }
        : { [artifact.id]: { bindings } }, null, 2) }],
      ...(!overridden ? { bindings } : {}),
    });
  }
  const components = [...new Set(diagnostics.map(d => d.component).filter((name): name is string => !!name))];
  for (const component of components) {
    const vue = (source?.file ?? artifact.source).endsWith('.vue');
    const name = component.replace(/[^a-zA-Z0-9_$]/g, '') || 'Component';
    const file = `src/skeletons/${name}Skeleton.${vue ? 'vue' : 'tsx'}`;
    examples.push({ kind: 'adapter', title: `Add a source adapter for ${component}`,
      description: 'Create a finite presentation component matching this region. Merge the adapter mapping into the existing target; retain its other settings.',
      files: [
        { name: file, code: vue ? '<template>\n  <section style="width:100%;min-height:240px"><span>Content</span></section>\n</template>\n' : 'export default function Skeleton() {\n  return <section style={{ width: "100%", minHeight: 240 }}><span>Content</span></section>;\n}\n' },
        { name: 'skelcast.config.mjs · target adapter', code: `// Merge into the existing target, then run skelcast sync.\n${JSON.stringify({ id: artifact.id, source: target?.source ?? artifact.source, adapters: { ...target?.adapters, [component]: file } }, null, 2)}` },
      ],
    });
  }
  if (!examples.length) examples.push({ kind: 'source', title: 'Review the presentation source',
    description: 'This region cannot be inferred safely. Simplify the expression or extract a finite presentation component and configure a source adapter for that component. Then sync and inspect the result.', files: [] });
  return { source, diagnostics, evidence, examples };
}
