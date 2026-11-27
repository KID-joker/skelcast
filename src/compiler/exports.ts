import { ambiguousExport, type ModuleInfo } from './context.js';
import type { ComponentReference } from './presets/types.js';

type ExportResult<T> = T | typeof ambiguousExport | undefined;

/** Shared ESM re-export rules; callers retain their own local binding and cycle limits. */
export async function resolveReexports<T>(
  module: Pick<ModuleInfo, 'reexports' | 'exportAll'>,
  name: string,
  follow: (reference: ComponentReference, name?: string) => ExportResult<T> | Promise<ExportResult<T>>,
  same: (left: T, right: T) => boolean,
): Promise<ExportResult<T>> {
  const explicit = module.reexports.get(name);
  if (explicit) return follow(explicit);
  // Star exports never forward default; diamonds are valid only for the same binding.
  if (name === 'default') return;
  let result: T | undefined;
  for (const reference of module.exportAll) {
    const candidate = await follow(reference, name);
    if (candidate === ambiguousExport) return ambiguousExport;
    if (!candidate) continue;
    if (result && !same(result, candidate)) return ambiguousExport;
    result = candidate;
  }
  return result;
}
