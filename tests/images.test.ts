import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageDimensions, imageRatio } from '../src/compiler/images.js';

test('intrinsic image metadata handles raster headers, SVG viewBox and malformed files without decoding', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  assert.deepEqual(imageDimensions(png), { width: 1, height: 1 });
  assert.deepEqual(imageDimensions(gif), { width: 1, height: 1 });
  const jpeg = Buffer.from('ffd8ffc0000b080010002001011100ffd9', 'hex');
  assert.deepEqual(imageDimensions(jpeg), { width: 32, height: 16 });
  const webp = Buffer.from('524946461600000057454250565038580a000000000000001f00000f0000', 'hex');
  assert.deepEqual(imageDimensions(webp), { width: 32, height: 16 });
  assert.deepEqual(imageDimensions(Buffer.from('<svg width="120px" viewBox="0 0 300 100"/>')), { width: 120, height: 40 });
  assert.deepEqual(imageDimensions(Buffer.from('<svg height="40" viewBox="0 0 300 100"/>')), { width: 120, height: 40 });
  assert.equal(imageDimensions(Buffer.from('<svg viewBox="0 0 0 0"/>')), undefined);
  for (const bytes of [png.subarray(0, 12), gif.subarray(0, 8), Buffer.from([255, 216, 255, 224, 0, 255]), Buffer.from('not an image')]) assert.equal(imageDimensions(bytes), undefined);
  for (const bytes of [jpeg, webp]) for (let length = 0; length < bytes.length; length++) assert.doesNotThrow(() => imageDimensions(bytes.subarray(0, length)));
  assert.equal(imageRatio('16 / 9'), 16 / 9);
  for (const value of ['1 / 0', '-2', '1; color:red', Infinity, {}]) assert.equal(imageRatio(value), undefined);
});
