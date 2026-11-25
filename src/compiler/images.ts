/** Read intrinsic dimensions only; never decode, execute or fetch image content. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const data = Buffer.from(bytes);
  const size = (width: number, height: number) => width > 0 && height > 0 && Number.isFinite(width + height) ? { width, height } : undefined;
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return size(data.readUInt32BE(16), data.readUInt32BE(20));
  if (data.length >= 10 && /^GIF8[79]a$/.test(data.toString('ascii', 0, 6))) return size(data.readUInt16LE(6), data.readUInt16LE(8));
  if (data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const kind = data.toString('ascii', 12, 16);
    if (kind === 'VP8X') return size(data.readUIntLE(24, 3) + 1, data.readUIntLE(27, 3) + 1);
    if (kind === 'VP8 ' && data.toString('hex', 23, 26) === '9d012a') return size(data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff);
    if (kind === 'VP8L' && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21);
      return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
  }
  if (data[0] === 0xff && data[1] === 0xd8) {
    for (let offset = 2; offset + 3 < data.length;) {
      if (data[offset++] !== 0xff) return;
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xd9 || marker === 0xda || offset + 2 > data.length) return;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) return;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) return size(data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3));
      offset += length;
    }
  }
  const svg = data.toString('utf8', 0, Math.min(data.length, 32768)).match(/<svg\b([^>]*)>/i)?.[1];
  if (svg) {
    const attribute = (name: string) => svg.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1];
    const length = (value?: string) => value && /^\d+(?:\.\d+)?(?:px)?$/.test(value.trim()) ? parseFloat(value) : undefined;
    const width = length(attribute('width')), height = length(attribute('height'));
    if (width && height) return size(width, height);
    const viewBox = attribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
      const ratio = size(viewBox[2], viewBox[3]);
      if (ratio) return width ? size(width, width * ratio.height / ratio.width) : height ? size(height * ratio.width / ratio.height, height) : ratio;
    }
  }
}

export function imageRatio(value: unknown): number | undefined {
  if (typeof value === 'number') return value > 0 && Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return;
  const match = /^\s*(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?\s*$/.exec(value);
  if (!match) return;
  const ratio = Number(match[1]) / Number(match[2] ?? 1);
  return ratio > 0 && Number.isFinite(ratio) ? ratio : undefined;
}
