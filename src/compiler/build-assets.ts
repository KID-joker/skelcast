import path from 'node:path';
import { parseSource, walk } from './ast.js';
import { digest } from './styles.js';
import type { SkeletonArtifact } from '../types.js';

const embedded = /data:([\w.+/-]+);base64,([A-Za-z0-9+/]+={0,2})/g;
const extensions: Record<string, string> = { 'image/png': 'png', 'image/svg+xml': 'svg', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'font/woff': 'woff', 'font/woff2': 'woff2', 'font/ttf': 'ttf', 'font/otf': 'otf' };

/** Portable inspection artifacts keep their bytes. Production assets are emitted
 * once, without putting large image/font literals into JavaScript chunks. */
export class BuildAssets {
  private assets = new Map<string, string>();
  externalize(input: SkeletonArtifact, emit: (name: string, bytes: Uint8Array) => string): SkeletonArtifact {
    const replace = (value: string) => value.replace(embedded, (url, mime: string, data: string) => {
      const extension = extensions[mime];
      if (!extension) return url;
      const bytes = Buffer.from(data, 'base64');
      const hash = digest(bytes);
      let reference = this.assets.get(hash);
      if (!reference) {
        reference = emit(`skelcast-${hash.slice(0, 16)}.${extension}`, bytes);
        this.assets.set(hash, reference);
      }
      return `__SKELCAST_ASSET_${reference}__`;
    });
    return { ...input, variants: Object.fromEntries(Object.entries(input.variants).map(([key, view]) => [key, { ...view, css: replace(view.css), html: replace(view.html) }])) };
  }
  chunk(code: string, filename: string, fileName: (reference: string) => string): string | undefined {
    if (!code.includes('__SKELCAST_ASSET_')) return;
    const edits: { start: number; end: number; text: string }[] = [];
    walk(parseSource(code, filename), node => {
      if (node.type !== 'StringLiteral' || !node.value.includes('__SKELCAST_ASSET_')) return;
      const pieces: string[] = [];
      let previous = 0;
      for (const match of node.value.matchAll(/__SKELCAST_ASSET_(\w+)__/g)) {
        pieces.push(JSON.stringify(node.value.slice(previous, match.index)));
        let relative = path.posix.relative(path.posix.dirname(filename), fileName(match[1]));
        if (!relative.startsWith('.')) relative = './' + relative;
        pieces.push(`new URL(${JSON.stringify(relative)},import.meta.url).href`);
        previous = match.index! + match[0].length;
      }
      pieces.push(JSON.stringify(node.value.slice(previous)));
      edits.push({ start: node.start!, end: node.end!, text: `(${pieces.join('+')})` });
    });
    for (const edit of edits.sort((a, b) => b.start - a.start)) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
    return code;
  }
  html(html: string, filename: string, base: string, fileName: (reference: string) => string): string {
    return html.replace(/__SKELCAST_ASSET_(\w+)__/g, (_, reference: string) => {
      const name = fileName(reference);
      return base === '' || base === './' ? path.posix.relative(path.posix.dirname(filename), name) : base + name;
    });
  }
}
