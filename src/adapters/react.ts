import { createElement, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { SkeletonArtifact } from '../types.js';
import { currentArtifact, forced, getPreview, mountSkeleton, registerBoundary, serverSnapshot, snapshot, subscribe } from '../runtime/core.js';

export interface LoadingBoundaryProps {
  artifact: SkeletonArtifact;
  pending: boolean;
  variant?: string;
  children?: ReactNode;
  className?: string;
}
export function LoadingBoundary({ artifact: initial, pending, variant, children, className }: LoadingBoundaryProps) {
  useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const artifact = currentArtifact(initial);
  const show = pending || forced(artifact.id, artifact.kind);
  const root = useRef<HTMLDivElement>(null);
  const skeleton = useRef<HTMLDivElement>(null);
  const registration = useRef<ReturnType<typeof registerBoundary> | null>(null);
  useEffect(() => {
      registration.current = registerBoundary({ id: artifact.id, kind: artifact.kind, pending, variant, artifact, element: root.current! });
    return () => { registration.current?.dispose(); registration.current = null; };
  }, [artifact.id]);
  useEffect(() => { registration.current?.update({ pending, variant, kind: artifact.kind, artifact }); }, [pending, artifact, variant]);
  const preview = getPreview();
  useLayoutEffect(() => {
    if (skeleton.current) return mountSkeleton(skeleton.current, artifact, variant);
  }, [artifact, variant, preview.variant, preview.highlight]);
  return createElement('div', { ref: root, className, style: { minWidth: 0 }, 'data-sk-boundary': artifact.id, 'data-sk-visible': String(show), 'aria-busy': pending },
    createElement('div', { ref: skeleton, hidden: !show, 'aria-hidden': true }),
    createElement('div', { hidden: show, inert: show || undefined, 'data-sk-content': '' }, children),
  );
}
