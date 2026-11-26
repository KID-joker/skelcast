import { parse, type ElementNode, type RootNode } from '@vue/compiler-dom';
import { transform } from 'lightningcss';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import type { SkeletonArtifact, SkeletonView } from '../types.js';

const separator = '/* skelcast-shared-base */';

/** Remove only source-location attributes, without reserializing text or whitespace. */
function withoutSourceNodes(html: string): string {
  const edits: { start: number; end: number }[] = [];
  const visit = (node: RootNode | ElementNode) => {
    if (node.type === 1) for (const prop of node.props) {
      if (prop.type === 6 && prop.name === 'data-sk-node') {
        const start = prop.loc.start.offset;
        edits.push({ start: /\s/.test(html[start - 1] ?? '') ? start - 1 : start, end: prop.loc.end.offset });
      }
    }
    for (const child of node.children) if (child.type === 1) visit(child);
  };
  try { visit(parse(html)); } catch { return html; }
  for (const edit of edits.sort((a, b) => b.start - a.start)) html = html.slice(0, edit.start) + html.slice(edit.end);
  return html;
}

function needsSourceNodes(css: string): boolean {
  let needed = false;
  try {
    const root = postcss.parse(css);
    root.walkRules(rule => {
      selectorParser(selectors => {
        selectors.walkAttributes(attribute => { if (attribute.attribute.toLowerCase() === 'data-sk-node') needed = true; });
      }).processSync(rule.selector);
    });
    // Preserve markers for selector tests, scope preludes and unfamiliar escaped syntax.
    root.walkAtRules(rule => { if (/data-sk-node|\\/i.test(rule.params)) needed = true; });
  } catch { return true; }
  return needed;
}

export function createArtifactOptimizer(warn: (message: string) => void = () => {}) {
  const styles = new Map<string, string>();
  const minify = (css: string): string => {
    const cached = styles.get(css);
    if (cached !== undefined) return cached;
    let result = css;
    try { result = transform({ filename: 'skelcast.css', code: Buffer.from(css), minify: true, errorRecovery: false }).code.toString(); }
    catch { warn('SkelCast kept a stylesheet unchanged because CSS minification failed.'); }
    styles.set(css, result);
    return result;
  };
  const optimizeView = (view: SkeletonView): SkeletonView => {
    const index = view.css.indexOf(separator);
    const css = index < 0 ? minify(view.css) : minify(view.css.slice(0, index)) + separator + minify(view.css.slice(index + separator.length));
    return { ...view, html: needsSourceNodes(view.css) ? view.html : withoutSourceNodes(view.html), css };
  };
  const artifact = (input: SkeletonArtifact): SkeletonArtifact => ({
    ...input, diagnostics: [], evidence: [], sources: {}, source: '',
    variants: Object.fromEntries(Object.entries(input.variants).map(([name, view]) => [name, optimizeView(view)])),
  });
  return {
    artifact,
    module(input: SkeletonArtifact, sharedModule: (css: string) => string, initialModule?: string): string {
      const optimized = artifact(input);
      const imports = new Map<string, { name: string; id: string }>();
      const variants = Object.entries(optimized.variants).map(([name, view]) => {
        if (initialModule && name === optimized.defaultVariant) {
          const properties = Object.entries(view).map(([key, value]) => `${JSON.stringify(key)}:${key === 'html' || key === 'css' ? `initialView.${key}` : JSON.stringify(value)}`);
          return `${JSON.stringify(name)}:{${properties.join(',')}}`;
        }
        const index = view.css.indexOf(separator);
        let css = JSON.stringify(view.css);
        if (index >= 0) {
          const shared = view.css.slice(index + separator.length);
          let entry = imports.get(shared);
          if (!entry) {
            entry = { name: `appendBase${imports.size}`, id: sharedModule(shared) };
            imports.set(shared, entry);
          }
          css = `${entry.name}(${JSON.stringify(view.css.slice(0, index))})`;
        }
        const properties = Object.entries(view).map(([key, value]) => `${JSON.stringify(key)}:${key === 'css' ? css : JSON.stringify(value)}`);
        return `${JSON.stringify(name)}:{${properties.join(',')}}`;
      });
      const properties = Object.entries(optimized).map(([key, value]) => `${JSON.stringify(key)}:${key === 'variants' ? `{${variants.join(',')}}` : JSON.stringify(value)}`);
      return (initialModule ? `import initialView from ${JSON.stringify(initialModule)};\n` : '') + [...imports.values()].map(entry => `import ${entry.name} from ${JSON.stringify(entry.id)};`).join('\n') + `\nexport default {${properties.join(',')}};`;
    },
  };
}

/** A function keeps bundlers from folding the shared string back into every view. */
export function sharedStyleModule(css: string, initialModule?: string): string {
  if (initialModule) return `import initialView from ${JSON.stringify(initialModule)};export default function(css){return css+${JSON.stringify(separator)}+initialView.baseCSS};`;
  return `export default function(css){return css+${JSON.stringify(separator + css)}};`;
}
