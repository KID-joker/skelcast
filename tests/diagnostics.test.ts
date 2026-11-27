import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@vue/compiler-dom';
import { diagnosticDetails } from '../src/compiler/diagnostics.js';
import { evaluateString, UNKNOWN } from '../src/compiler/expression.js';
import type { RenderContext } from '../src/compiler/context.js';

test('Vue diagnostics share expression syntax while using current values and bindings', () => {
  const code = `<Widget :style="{width:size,height:flag ? 20 : 40}" :class="layout"/>`;
  const node = parse(code).children[0];
  if (node.type !== 1) throw new Error('Expected element');
  const style = '{width:size,height:flag ? 20 : 40}';
  const expressions = new Map();
  const ctx = { code, env: { size: UNKNOWN, flag: UNKNOWN, layout: UNKNOWN }, bindings: {}, expressions } as unknown as RenderContext;
  evaluateString(style, ctx);
  const syntax = expressions.get(style);
  const first = diagnosticDetails(ctx, node);
  assert.equal(first.component, 'Widget');
  assert.deepEqual({ ...first.bindingExamples }, { size: 320, 'flag ? 20 : 40': 20, layout: 'your-layout-class' });
  assert.equal(expressions.size, 2);
  assert.equal(expressions.get(style), syntax);
  const known = diagnosticDetails({ ...ctx, env: { size: 80, flag: false, layout: 'grid' } }, node);
  assert.equal(known.bindingExamples, undefined);
  const bound = diagnosticDetails({ ...ctx, bindings: { size: 80, flag: true, layout: 'list' } }, node);
  assert.equal(bound.bindingExamples, undefined);
  assert.deepEqual(diagnosticDetails(ctx, node), first);
  assert.equal(expressions.size, 2);
});

test('malformed diagnostic expressions stay opaque and share the failed syntax cache', () => {
  const code = `<section :style="size +"/>`;
  const node = parse(code).children[0];
  const expressions = new Map();
  const ctx = { code, env: {}, bindings: {}, expressions } as unknown as RenderContext;
  const first = diagnosticDetails(ctx, node);
  assert.equal(first.bindingExamples, undefined);
  assert.equal(expressions.get('size +'), null);
  assert.deepEqual(diagnosticDetails(ctx, node), first);
  assert.equal(expressions.size, 1);
});
