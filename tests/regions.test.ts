import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, type ElementNode } from '@vue/compiler-dom';
import { VueRegion } from '../src/compiler/regions.js';
import type { RenderContext, SourceSlot } from '../src/compiler/context.js';

test('region selection shares subtree checks and still recognizes cloned dynamic ancestors', () => {
  const root = parse('<main>' + '<div>'.repeat(100) + '<section/><aside/>' + '</div>'.repeat(100) + '</main>');
  const nodes: ElementNode[] = [];
  const collect = (node: ElementNode) => {
    nodes.push(node);
    for (const child of node.children) if (child.type === 1) collect(child);
  };
  collect(root.children[0] as ElementNode);
  const target = nodes.find(node => node.tag === 'section')!;
  let reads = 0;
  for (const node of nodes) {
    const children = node.children;
    Object.defineProperty(node, 'children', { enumerable: true, get() { reads++; return children; } });
  }
  const ctx = { module: { file: 'View.vue' } } as RenderContext;
  const region = new VueRegion('View.vue', target);
  for (const node of nodes) {
    const expected = node === target ? 'target' : node.tag === 'aside' ? 'skip' : 'ancestor';
    assert.equal(region.mode(node, ctx), expected);
    assert.equal(region.mode(node, ctx), expected);
  }
  assert.ok(reads <= nodes.length, 'selection visits each immutable subtree at most once');
  assert.equal(region.mode({ ...nodes[0], tag: 'article' }, ctx), 'ancestor');
  assert.equal(new VueRegion('View.vue', target).mode(nodes[0], ctx), 'ancestor');
});

test('region containment keeps slot context, capture suspension and cyclic forwarding policies', async () => {
  const root = parse('<main><section/></main>').children[0] as ElementNode;
  const target = root.children[0] as ElementNode;
  const region = new VueRegion('View.vue', target);
  const ctx = { module: { file: 'View.vue' } } as RenderContext;
  const slot: SourceSlot = { framework: 'vue', nodes: [root], context: ctx };
  const forwarded = { ...ctx, module: { ...ctx.module, file: 'Wrapper.vue' }, slots: { default: slot } };
  assert.equal(region.mode(root, forwarded), 'ancestor');
  assert.equal(region.carries({ ...slot, framework: 'jsx', nodes: [] }), false);
  const cyclic: SourceSlot = { framework: 'vue', nodes: [], context: forwarded };
  forwarded.slots = { default: cyclic };
  assert.equal(region.carries(cyclic), false);
  assert.equal(region.mode(root, forwarded), 'skip');
  await assert.rejects(region.capture(async () => { throw new Error('failed render'); }), /failed render/);
  assert.equal(region.active, true);
  assert.equal(region.mode(root, ctx), 'ancestor');
  await region.capture(async () => {
    assert.equal(region.active, false);
    assert.equal(region.mode(root, ctx), undefined);
    return 'selected';
  });
  assert.equal(region.result, 'selected');
  assert.equal(region.mode(root, ctx), 'skip');
});
