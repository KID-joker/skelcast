import type { SkeletonArtifact } from '../types.js';

/** Browser delivery omits source inspection data without changing the artifact. */
export const previewArtifact = (artifact: SkeletonArtifact): SkeletonArtifact => ({
  ...artifact, diagnostics: [], evidence: [], sources: {}, source: '',
});
