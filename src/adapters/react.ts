import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { SkeletonArtifact } from '../types.js';
import { boundarySnapshot, createSkeletonMount, currentArtifact, forced, getPreview, registerBoundary, serverSnapshot, subscribeBoundary } from '../runtime/core.js';

export interface LoadingBoundaryProps {
  artifact: SkeletonArtifact;
  pending: boolean;
  variant?: string;
  children?: ReactNode;
  className?: string;
}
export function LoadingBoundary({ artifact: initial, pending, variant, children, className }: LoadingBoundaryProps) {
  const subscription = useMemo(() => ({
    subscribe: (listener: () => void) => subscribeBoundary(initial.id, initial.kind, listener),
    snapshot: () => boundarySnapshot(initial.id, initial.kind),
  }), [initial.id, initial.kind]);
  useSyncExternalStore(subscription.subscribe, subscription.snapshot, serverSnapshot);
  const artifact = currentArtifact(initial);
  const show = pending || forced(artifact.id, artifact.kind);
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
    skeleton.current?.style.setProperty('display', show ? 'block' : 'none', 'important');
    skeleton.current?.nextElementSibling?.setAttribute('style', `display:${show ? 'none' : 'block'}!important`);
    if (skeleton.current) mount.update(skeleton.current, show, artifact, variant);
  }, [mount, show, artifact, variant, preview.target, preview.variant, preview.highlight]);
  useLayoutEffect(() => () => mount.dispose(), [mount]);
  return createElement('div', { ref: root, className, style: { minWidth: 0 }, 'data-sk-boundary': artifact.id, 'data-sk-visible': String(show), 'aria-busy': pending },
    createElement('div', { ref: skeleton, hidden: !show, style: { display: show ? 'block' : 'none' }, 'aria-hidden': true }),
    createElement('div', { hidden: show, style: { display: show ? 'none' : 'block' }, inert: show || undefined, 'data-sk-content': '' }, children),
  );
}
