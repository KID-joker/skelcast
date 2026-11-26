import path from 'node:path';
import { parse } from '@vue/compiler-dom';
import postcss from 'postcss';
import { resolveStylesheet, type StyleSource } from './stylesheet-source.js';

/** Compile only CSS and the generated markup's finite class tokens. Application
 * JS configs/plugins and filesystem content scanners are intentionally absent. */
export async function compileTailwind(css: string, html: string, io: StyleSource, load: (file: string) => Promise<string>, enabled = true) {
  let detected = false;
  postcss.parse(css).walkAtRules(rule => { if (['theme','utility','tailwind','custom-variant','apply','variant','reference','source','plugin','config'].includes(rule.name)) detected = true; });
  if (!detected) return { css, sourcesIgnored: false };
  if (!enabled) throw new Error('Tailwind CSS directives require styles.tailwind to be enabled');
  const { compile } = await import('tailwindcss');
  const compiler = await compile(css, {
    base: io.root,
    async loadStylesheet(id, base) {
      const file = await resolveStylesheet(id, path.join(base, '__tailwind.css'), io);
      return { path: file, base: path.dirname(file), content: await load(file) };
    },
    async loadModule(id, _base, type) { throw new Error(`Tailwind JavaScript ${type} is not executed during static generation: ${id}`); },
  });
  const candidates = new Set<string>();
  const visit = (node: ReturnType<typeof parse> | ReturnType<typeof parse>['children'][number] | import('@vue/compiler-dom').SimpleExpressionNode) => {
    if (node.type === 1) for (const prop of node.props) if (prop.type === 6 && prop.name === 'class') for (const value of (prop.value?.content ?? '').split(/\s+/)) if (value) candidates.add(value);
    if ('children' in node) for (const child of node.children) if (typeof child === 'object') visit(child);
  };
  visit(parse(html));
  return { css: compiler.build([...candidates]), sourcesIgnored: compiler.sources.length > 0 || !!compiler.root && compiler.root !== 'none' };
}
