import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerBoundary, setPreview } from '../src/runtime/core.js';
import type { SkeletonArtifact } from '../src/types.js';

test('initial shell retires for a different SPA entry route and stays retired across navigation', () => {
  const initial = { dataset: { skInitial: 'static-shell' }, hidden: false };
  const previous = globalThis.document;
  Object.assign(globalThis, { document: { querySelector: () => initial } });
  const artifact = (id: string): SkeletonArtifact => ({ id, kind: 'page', render: 'light', source: 'Page.vue', defaultVariant: 'default', variants: { default: { html: '<div/>', css: '' } }, diagnostics: [], evidence: [], sources: {} });
  let dispose: (() => void) | undefined;
  try {
    const first = registerBoundary({ id: 'first', kind: 'page', pending: false, artifact: artifact('first') });
    assert.equal(initial.hidden, true);
    first.dispose();
    assert.equal(initial.hidden, true);
    setPreview({ target: 'page' });
    const next = registerBoundary({ id: 'next', kind: 'page', pending: false, artifact: artifact('next') });
    dispose = next.dispose;
    assert.equal(initial.hidden, true);
    next.dispose(); dispose = undefined;
    assert.equal(initial.hidden, true);
  } finally {
    dispose?.(); setPreview({ target: null });
    if (previous) Object.assign(globalThis, { document: previous });
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
