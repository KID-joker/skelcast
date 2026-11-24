import path from 'node:path';
import { createHash } from 'node:crypto';
import postcss from 'postcss';
import modules from 'postcss-modules';
import postcssImport from 'postcss-import';
import { compileStyleAsync } from '@vue/compiler-sfc';

export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
export async function loadStyle(file: string, read: (file: string) => Promise<string>, scopedId?: string, inline?: string) {
  let mapping: Record<string, string> = {};
  const source = inline ?? await read(file);
  const processed = await postcss([
    postcssImport({ load: async (f) => read(f) }),
    ...(file.includes('.module.') ? [modules({
      generateScopedName: (name: string, filename: string) => `sk_${digest(path.basename(filename) + source).slice(0, 8)}_${name}`,
      getJSON: (_: string, json: Record<string, string>) => { mapping = json; },
    })] : []),
  ]).process(source, { from: file });
  let css = processed.css;
  if (scopedId) {
    const result = await compileStyleAsync({ source: css, filename: file, id: scopedId, scoped: true });
    if (result.errors.length) throw new Error(String(result.errors[0]));
    css = result.code;
  }
  return { css, mapping };
}

export function scopeCSS(css: string, id: string): string {
  const scope = `[data-sk-artifact="${id}"]`;
  const root = postcss.parse(css);
  root.walkRules(rule => {
    let parent: any = rule.parent;
    while (parent) {
      if (parent.type === 'atrule' && /keyframes$/i.test(parent.name)) return;
      parent = parent.parent;
    }
    rule.selectors = rule.selectors.map(selector => {
      const s = selector.trim().replace(/(?:^|\s)(?:html|body|:root)(?=[\s.#:[>+~]|$)/g, match => match.startsWith(' ') ? ' ' : '').trim();
      return s ? `${scope} ${s}` : scope;
    });
  });
  return root.toString();
}

export const baseCSS = `
[data-sk-artifact] { color: transparent; pointer-events: none; }
[data-sk-artifact] *, [data-sk-artifact] *::before, [data-sk-artifact] *::after { box-sizing: border-box; }
[data-sk-artifact] [data-sk-leaf] { color: transparent !important; background-color: var(--skeleton-color, #e5e9ef) !important; border-color: transparent !important; border-radius: var(--skeleton-radius, 6px); }
[data-sk-artifact] [data-sk-text] { display: inline-block; width: min(100%, 12ch); min-width: 3ch; height: .85em; vertical-align: middle; }
[data-sk-artifact] [data-sk-image] { display: block; min-width: 40px; min-height: 40px; aspect-ratio: var(--skeleton-image-ratio, 4 / 3); }
[data-sk-artifact] [data-sk-fallback] { display: block; width: 100%; min-height: var(--skeleton-min-height, 96px); }
[data-sk-artifact] [data-sk-multiline] { display: block; width: 100%; }
[data-sk-artifact] [data-sk-multiline] > span { display: block; height: .85em; margin-block: .35em; background: var(--skeleton-color, #e5e9ef); border-radius: 4px; }
[data-sk-artifact] [data-sk-multiline] > span:last-child { width: 72%; }
[data-sk-artifact][data-sk-highlight] [data-sk-fallback] { outline: 2px dashed #e18b2e; outline-offset: -2px; }
@media (prefers-reduced-motion: no-preference) { [data-sk-artifact] [data-sk-leaf] { animation: sk-pulse 1.6s ease-in-out infinite alternate; } }
@keyframes sk-pulse { to { opacity: .55; } }
`;
