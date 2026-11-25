import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundarySnapshot, registerBoundary, replaceArtifacts, selectedView, setPreview, subscribe, subscribeBoundary } from '../src/runtime/core.js';
import type { SkeletonArtifact } from '../src/types.js';

test('initial shell retires for a different SPA entry route and stays retired across navigation', () => {
  const declarations: unknown[][] = [];
  const initial = { dataset: { skInitial: 'static-shell' }, hidden: false, style: { setProperty: (...args: unknown[]) => declarations.push(args) } };
  const previous = globalThis.document;
  Object.assign(globalThis, { document: { querySelector: () => initial } });
  const artifact = (id: string): SkeletonArtifact => ({ id, kind: 'page', render: 'light', source: 'Page.vue', defaultVariant: 'default', variants: { default: { html: '<div/>', css: '' } }, diagnostics: [], evidence: [], sources: {} });
  let dispose: (() => void) | undefined;
  try {
    const first = registerBoundary({ id: 'first', kind: 'page', pending: false, artifact: artifact('first') });
    assert.equal(initial.hidden, true);
    assert.deepEqual(declarations.at(-1), ['display', 'none', 'important']);
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

const artifact = (id: string): SkeletonArtifact => ({ id, kind: 'request', render: 'light', source: 'Page.vue', defaultVariant: 'default', variants: { default: { html: '<div/>', css: '' }, list: { html: '<section/>', css: '' } }, diagnostics: [], evidence: [], sources: {} });

test('pending updates do not notify 1000 unrelated boundary subscribers', () => {
  let notifications = 0, inspectorUpdates = 0;
  const stop = Array.from({ length: 1000 }, (_, i) => subscribeBoundary(`region-${i}`, 'request', () => notifications++));
  const inspect = subscribe(() => inspectorUpdates++);
  const registration = registerBoundary({ id: 'active', kind: 'request', pending: false, artifact: artifact('active') });
  try {
    for (let i = 0; i < 100; i++) registration.update({ pending: i % 2 === 0 });
    assert.equal(notifications, 0);
    assert.equal(inspectorUpdates, 101);
  } finally { registration.dispose(); inspect(); stop.forEach(dispose => dispose()); }
});

test('preview and artifact updates notify only affected boundaries', () => {
  const calls = { first: 0, second: 0, page: 0 };
  const stops = Object.keys(calls).map(key => subscribeBoundary(key, key === 'page' ? 'page' : 'request', () => calls[key as keyof typeof calls]++));
  try {
    const before = boundarySnapshot('second', 'request');
    setPreview({ target: 'first', variant: 'list' });
    assert.deepEqual(calls, { first: 1, second: 0, page: 0 });
    assert.equal(boundarySnapshot('second', 'request'), before);
    assert.equal(selectedView(artifact('second')).html, '<div/>');
    assert.equal(selectedView(artifact('first')).html, '<section/>');
    setPreview({ target: 'page' });
    assert.deepEqual(calls, { first: 2, second: 0, page: 1 });
    replaceArtifacts([artifact('second')]);
    assert.deepEqual(calls, { first: 2, second: 1, page: 1 });
    replaceArtifacts([artifact('second')]);
    assert.equal(calls.second, 1, 'identical refreshes retain cached trees');
  } finally { stops.forEach(stop => stop()); setPreview({ target: null, variant: undefined, highlight: false }); }
});
