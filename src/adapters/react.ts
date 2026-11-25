import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { applyPresentationDisplay, boundaryPresentation } from '../runtime/presentation.js';
import type { SkeletonArtifact } from '../types.js';
import { boundarySnapshot, createSkeletonMount, currentArtifact, getPreview, registerBoundary, serverSnapshot, subscribeBoundary } from '../runtime/core.js';

export interface LoadingBoundaryProps {
  artifact: SkeletonArtifact;
  pending: boolean;
  variant?: string;
  children?: ReactNode;
  className?: string;
}
export function LoadingBoundary({ artifact: initial, pending, variant, children, className }: LoadingBoundaryProps): ReactElement {
  const subscription = useMemo(() => ({
    subscribe: (listener: () => void) => subscribeBoundary(initial.id, initial.kind, listener),
    snapshot: () => boundarySnapshot(initial.id, initial.kind),
  }), [initial.id, initial.kind]);
  useSyncExternalStore(subscription.subscribe, subscription.snapshot, serverSnapshot);
  const artifact = currentArtifact(initial);
  const presentation = boundaryPresentation(artifact.id, artifact.kind, pending);
  const show = presentation.skeletonVisible;
  const root = useRef<HTMLDivElement>(null);
  const skeleton = useRef<HTMLDivElement>(null);
  const mount = useMemo(createSkeletonMount, []);
  const registration = useRef<ReturnType<typeof registerBoundary> | null>(null);
  useEffect(() => {
    registration.current = registerBoundary({ id: artifact.id, kind: artifact.kind, pending, variant, artifact, element: root.current! });
    return () => { registration.current?.dispose(); registration.current = null; };
  }, [artifact.id]);
  useEffect(() => { registration.current?.update({ pending, variant, kind: artifact.kind, artifact }); }, [pending, artifact, variant]);
  const preview = getPreview();
  useLayoutEffect(() => {
    if (root.current && skeleton.current) applyPresentationDisplay(root.current, skeleton.current, presentation);
    if (skeleton.current) mount.update(skeleton.current, show, artifact, variant);
  }, [mount, show, pending, artifact, variant, preview.target, preview.variant, preview.highlight, preview.comparison, preview.opacity, preview.comparisonView]);
  useLayoutEffect(() => () => mount.dispose(), [mount]);
  return createElement('div', { ref: root, className, style: presentation.rootStyle, 'data-sk-comparison': presentation.comparison, 'data-sk-boundary': artifact.id, 'data-sk-visible': String(show), 'aria-busy': pending },
    createElement('div', { ref: skeleton, hidden: !show, style: presentation.skeletonStyle, 'aria-hidden': true }),
    createElement('div', { hidden: !presentation.contentVisible, style: presentation.contentStyle, inert: !presentation.contentVisible || undefined, 'data-sk-content': '' }, children),
  );
}
