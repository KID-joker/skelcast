import type { SkeletonTarget } from '../types.js';
import { uniqueName } from './ast.js';
import { targetId, type AnalysisContext } from './types.js';

interface TargetOptions {
  suffix: string;
  kind: 'page' | 'request';
  bindings: Record<string, boolean>;
  export?: string;
}

/** Keep target IDs, imports and route metadata consistent across boundary edits. */
export function targetBuilder(ctx: AnalysisContext, targets: SkeletonTarget[]) {
  const imports: string[] = [];
  return {
    imports,
    add({ suffix, kind, bindings, export: exported }: TargetOptions) {
      const id = targetId(ctx, suffix);
      const artifact = uniqueName(ctx.source + imports.join('\n'), `__skelcast${targets.length}`);
      imports.push(`import ${artifact} from 'virtual:skelcast/${id}';`);
      const target: SkeletonTarget = { id, source: ctx.file, ...(exported === undefined ? {} : { export: exported }), kind, region: artifact, hints: { bindings } };
      if (kind === 'page' && ctx.routes.length) target.route = ctx.routes.length === 1 ? ctx.routes[0] : ctx.routes;
      targets.push(target);
      return artifact;
    },
  };
}
