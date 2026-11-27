import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundarySnapshot, getPreview, registerBoundary, replaceArtifacts, selectedVariant, selectedView, setPreview, snapshot, subscribe, subscribeBoundary } from '../src/runtime/core.js';
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

test('toolbar and mounted views share preview, boundary and default variant precedence', () => {
  const original = getPreview(), item = artifact('variant-selection');
  try {
    for (const [target, previewVariant, boundaryVariant, expected] of [
      [null, 'list', 'default', 'default'],
      [null, undefined, 'list', 'list'],
      [item.id, 'list', 'default', 'list'],
      [item.id, 'missing', 'list', 'default'],
      [item.id, undefined, 'list', 'list'],
      [null, undefined, 'missing', 'default'],
    ] as const) {
      setPreview({ target, variant: previewVariant });
      assert.equal(selectedVariant(item, boundaryVariant), expected);
      assert.equal(selectedView(item, boundaryVariant), item.variants[expected]);
    }
    const legacy = { ...item, defaultVariant: 'absent' };
    assert.equal(selectedVariant(legacy, 'missing'), 'absent');
    assert.equal(selectedView(legacy, 'missing'), item.variants.default);
    const empty = { ...legacy, variants: {} };
    assert.equal(selectedView(empty), undefined);
  } finally { setPreview(original); }
});

test('identical normalized preview states preserve identity and do not notify subscribers', () => {
  const original = getPreview();
  setPreview({ target: 'stable', comparison: 'overlay', opacity: 1 });
  const stable = getPreview(), before = snapshot();
  let inspectors = 0, boundaries = 0;
  const stop = subscribe(() => inspectors++);
  const stopBoundary = subscribeBoundary('stable', 'request', () => boundaries++);
  try {
    for (let i = 0; i < 10; i++) setPreview({ ...stable, opacity: 2 });
    setPreview({});
    assert.equal(getPreview(), stable);
    assert.equal(snapshot(), before);
    assert.equal(inspectors, 0);
    assert.equal(boundaries, 0);
    setPreview({ opacity: 0.25 });
    assert.equal(inspectors, 1);
    assert.equal(boundaries, 1);
  } finally { stop(); stopBoundary(); setPreview(original); }
});

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

test('unchanged artifacts do not notify inspectors, while changed artifacts notify once', () => {
  let notifications = 0;
  const stop = subscribe(() => notifications++);
  try {
    assert.equal(replaceArtifacts([artifact('inspector-refresh')]), true);
    assert.equal(notifications, 1);
    assert.equal(replaceArtifacts([artifact('inspector-refresh')]), false);
    assert.equal(replaceArtifacts([]), false);
    assert.equal(notifications, 1);
    const updated = artifact('inspector-refresh');
    updated.variants.default.html = '<article/>';
    assert.equal(replaceArtifacts([updated]), true);
    assert.equal(notifications, 2);
  } finally { stop(); }
});

test('comparison updates notify only their target and clamp overlay opacity', () => {
  const calls = { selected: 0, other: 0 };
  const stops = Object.keys(calls).map(id => subscribeBoundary(id, 'request', () => calls[id as keyof typeof calls]++));
  try {
    setPreview({ target: 'selected', comparison: 'side-by-side' });
    assert.deepEqual(calls, { selected: 1, other: 0 });
    setPreview({ comparison: 'overlay', opacity: 2 });
    assert.equal(getPreview().opacity, 1);
    assert.deepEqual(calls, { selected: 2, other: 0 });
    setPreview({ opacity: -1 });
    assert.equal(getPreview().opacity, 0);
    setPreview({ opacity: Number.NaN });
    assert.equal(getPreview().opacity, 0.5);
    setPreview({ comparison: 'switch', comparisonView: 'content' });
    const before = calls.selected;
    setPreview({ comparisonView: 'skeleton' });
    assert.equal(calls.selected, before + 1);
    assert.equal(calls.other, 0);
    setPreview({ target: null });
    const released = calls.selected;
    setPreview({ comparisonView: 'content', opacity: 0.75 });
    assert.equal(calls.selected, released, 'inactive comparisons do not update boundaries');
  } finally {
    stops.forEach(stop => stop());
    setPreview({ target: null, comparison: 'off', opacity: 0.5, comparisonView: 'content' });
  }
});

test('versioned refreshes retain notifications across versioned and direct callers', () => {
  const id = 'versioned-refresh';
  let notifications = 0;
  const stop = subscribeBoundary(id, 'request', () => notifications++);
  try {
    assert.equal(replaceArtifacts([artifact(id)], { [id]: 'first' }), true);
    assert.equal(replaceArtifacts([artifact(id)], { [id]: 'first' }), false);
    assert.equal(notifications, 1);
    const updated = artifact(id);
    updated.variants.default.css = 'section{height:80px}';
    assert.equal(replaceArtifacts([updated], { [id]: 'second' }), true);
    assert.equal(replaceArtifacts([structuredClone(updated)]), false);
    assert.equal(replaceArtifacts([structuredClone(updated)], { [id]: 'second' }), false);
    assert.equal(notifications, 2);
    assert.equal(replaceArtifacts([artifact(id)]), true);
    assert.equal(replaceArtifacts([artifact(id)], { [id]: 'first' }), false);
    assert.equal(notifications, 3);
  } finally { stop(); }
});

test('preview comparison preserves duplicate subscribers and reentrant state changes', () => {
  const original = getPreview();
  const calls: string[] = [];
  const stops = [
    subscribeBoundary('reentrant', 'request', () => {
      calls.push('first');
      if (getPreview().comparison === 'overlay') setPreview({ comparison: 'switch' });
    }),
    subscribeBoundary('reentrant', 'request', () => calls.push('second')),
    subscribeBoundary('reentrant', 'page', () => calls.push('page')),
  ];
  try {
    setPreview({ target: 'reentrant', comparison: 'overlay' });
    assert.deepEqual(calls, ['first', 'first', 'second', 'page', 'second', 'page']);
    const before = calls.length;
    setPreview({ opacity: 0.25 });
    assert.equal(calls.length, before, 'opacity changes do not affect switch comparisons');
    assert.deepEqual(JSON.parse(boundarySnapshot('reentrant', 'request')).slice(4), ['switch', null, 'content']);
  } finally { stops.forEach(stop => stop()); setPreview(original); }
});
