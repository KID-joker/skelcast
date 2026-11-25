import path from 'node:path';
import { createHash } from 'node:crypto';
import postcss from 'postcss';
import modules from 'postcss-modules';
import postcssImport from 'postcss-import';
import selectorParser from 'postcss-selector-parser';
import { compileStyleAsync } from '@vue/compiler-sfc';
import type { StyleOptions } from '../types.js';
import { embedStyleAssets, namespaceGlobals } from './css-resources.js';
import { escapeHTML } from './html.js';

export const digest = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');
export const sourceIdAttribute = 'data-sk-source-id';
export interface CSSBinding { variable: string; expression: string; line: number }
/** Rewrite bindings before preprocessing so variable names are stable per source component. */
export function bindStyleVariables(source: string, file: string): { css: string; bindings: CSSBinding[] } {
  const bindings: CSSBinding[] = [];
  const scan = source.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\/\*[\s\S]*?\*\/|\/\/[^\n]*)/g, (text, quoted) => quoted ? text : text.replace(/[^\n]/g, ' '));
  const pattern = /v-bind\s*\(/g;
  let css = '', previous = 0, match: RegExpExecArray | null;
  while ((match = pattern.exec(scan))) {
    const start = pattern.lastIndex;
    let depth = 1, quote = '', end = start;
    for (; end < source.length; end++) {
      const char = source[end];
      if (char === '\\') { end++; continue; }
      if (quote) { if (char === quote) quote = ''; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '(') depth++;
      if (char === ')' && --depth === 0) break;
    }
    if (depth !== 0) continue;
    let expression = source.slice(start, end).trim();
    if ((expression.startsWith("'") && expression.endsWith("'")) || (expression.startsWith('"') && expression.endsWith('"'))) expression = expression.slice(1, -1);
    const variable = `--sk-bind-${digest(`${file}:${expression}`).slice(0, 12)}`;
    bindings.push({ variable, expression, line: source.slice(0, match.index).split('\n').length });
    css += source.slice(previous, match.index) + `var(${variable})`;
    previous = end + 1; pattern.lastIndex = previous;
  }
  return { css: css + source.slice(previous), bindings };
}
export async function loadStyle(file: string, read: (file: string) => Promise<string>, scopedId?: string, inline?: string, options?: StyleOptions, lang?: string, readAsset?: (file: string) => Promise<Uint8Array>) {
  let mapping: Record<string, string> = {};
  let source = inline ?? await read(file);
  if (lang === 'less' || file.endsWith('.less')) {
    if (!options?.less) throw new Error(`Enable styles.less to compile ${file}`);
    const { default: less } = await import('less');
    class TrackedFileManager extends less.FileManager {
      supports() { return true; }
      supportsSync() { return false; }
      async loadFile(filename: string, directory: string) {
        if (/^(?:[a-z]+:|\/\/)/i.test(filename)) throw new Error('Remote Less imports are not supported');
        let lastError: unknown;
        for (const candidate of [filename, `${filename}.less`]) {
          const resolved = path.resolve(directory, candidate);
          try { return { contents: await read(resolved), filename: resolved }; }
          catch (error: any) { if (error.code !== 'ENOENT') throw error; lastError = error; }
        }
        throw lastError;
      }
    }
    const output = await less.render(source, {
      filename: file, javascriptEnabled: false, rewriteUrls: 'all',
      // Less @plugin can execute JS independently of javascriptEnabled.
      disablePluginRule: true,
      plugins: [{ install: (_less: unknown, manager: any) => manager.addFileManager(new TrackedFileManager()) }],
    } as Less.Options);
    source = output.css;
  }
  const processed = await postcss([
    postcssImport({ load: async (f) => read(f) }),
    ...(file.includes('.module.') ? [modules({
      generateScopedName: (name: string, filename: string) => `sk_${digest(path.basename(filename) + source).slice(0, 8)}_${name}`,
      getJSON: (_: string, json: Record<string, string>) => { mapping = json; },
    })] : []),
  ]).process(source, { from: file });
  await embedStyleAssets(processed.root, file, readAsset);
  let css = processed.root.toString();
  if (scopedId) {
    const result = await compileStyleAsync({ source: css, filename: file, id: scopedId, scoped: true });
    if (result.errors.length) throw new Error(String(result.errors[0]));
    css = result.code;
  }
  return { css, mapping };
}

/** Preserve only layout utility attributes, never event handlers or business bindings. */
export function utilityAttribute(name: string): boolean {
  return /^(?:(?:sm|md|lg|xl|2xl|dark|light|important):)*(?:flex|grid|block|inline|hidden|items|justify|content|self|place|gap|space|order|col|row|w|h|min-w|max-w|min-h|max-h|m[atrblxyse]?|p[atrblxyse]?|text|font|fw|lh|leading|tracking|align|vertical|rounded|border|b|rd|bg|overflow|position|relative|absolute|fixed|sticky|inset|top|right|bottom|left|z|shadow|opacity|op)(?:[-:].*|\d[\w.%/-]*)?$/.test(name);
}

export async function utilityCSS(html: string, options?: StyleOptions): Promise<string> {
  if (!options?.unocss) return '';
  const [{ createGenerator }, { default: presetMini }, { default: presetAttributify }] = await Promise.all([
    import('@unocss/core'), import('@unocss/preset-mini'), import('@unocss/preset-attributify'),
  ]);
  const config = typeof options.unocss === 'object' ? options.unocss : {};
  const generator = await createGenerator({
    presets: [presetMini(), ...(config.attributify === false ? [] : [presetAttributify({ ignoreAttributes: ['size'] })])],
    theme: config.theme, shortcuts: config.shortcuts, safelist: config.safelist,
  });
  // Mini's transform utilities depend on preflight CSS variables. scopeCSS keeps
  // these defaults inside the artifact instead of affecting the application.
  return (await generator.generate(html)).css;
}

export function scopeCSS(css: string, id: string): string {
  return scopeArtifactStyles(css, '', id).css;
}
export function scopeArtifactStyles(css: string, html: string, id: string): { css: string; html: string } {
  const scope = `[data-sk-artifact="${id}"]`;
  const root = postcss.parse(css);
  const inline: postcss.Root[] = [];
  for (const match of html.matchAll(/ style="([^"]*)"/g)) {
    const value = match[1];
    const decoded = value.replace(/&(quot|apos|lt|gt|amp|#39);/g, (_match, name: string) => ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&', '#39': "'" })[name]!);
    inline.push(postcss.parse(`a{${decoded}}`));
  }
  namespaceGlobals(root, `sk-${digest(id + css).slice(0, 12)}`, inline);
  let index = 0;
  html = html.replace(/ style="([^"]*)"/g, () => ` style="${escapeHTML(inline[index++].first!.toString().slice(2, -1))}"`);
  root.walkRules(rule => {
    let parent: any = rule.parent;
    while (parent) {
      if (parent.type === 'atrule' && /keyframes$/i.test(parent.name)) return;
      parent = parent.parent;
    }
    rule.selectors = rule.selectors.flatMap(selector => {
      const rewritten = selectorParser(selectors => {
        selectors.walkAttributes(attribute => {
          if (attribute.attribute === 'id' && !attribute.namespace) attribute.attribute = sourceIdAttribute;
        });
        // Collect first so walking cannot revisit the ID kept for specificity.
        const ids: selectorParser.Identifier[] = [];
        selectors.walkIds(node => { ids.push(node); });
        for (const node of ids) {
          const attribute = selectorParser.attribute({ attribute: sourceIdAttribute, operator: '=', value: node.value, quoteMark: '"', raws: {} });
          attribute.setValue(node.value, { quoteMark: '"' });
          const original = selectorParser.selector({ value: '' }); original.append(node.clone());
          const mapped = selectorParser.selector({ value: '' }); mapped.append(attribute);
          // :is() retains ID specificity while matching the mapped attribute.
          const replacement = selectorParser.pseudo({ value: ':is' });
          replacement.append(original); replacement.append(mapped);
          node.replaceWith(replacement);
        }
      }).processSync(selector);
      const s = rewritten.trim().replace(/(?:^|\s)(?:html|body|:root)(?=[\s.#:[>+~]|$)/g, match => match.startsWith(' ') ? ' ' : '').trim();
      if (!s) return [scope];
      const theme = s.match(/^(\.(?:dark|light))\s+(.+)$/);
      return theme ? [`${scope} ${s}`, `${theme[1]} ${scope} ${theme[2]}`, `${scope}${theme[1]} ${theme[2]}`] : [`${scope} ${s}`];
    });
  });
  return { css: root.toString(), html };
}

export const baseCSS = `
[data-sk-artifact] { color: transparent; pointer-events: none; }
[data-sk-artifact] [data-sk-control] { color: var(--skeleton-control-color, #606266); }
[data-sk-artifact] [data-sk-control] [data-sk-image]:not([data-sk-leaf]) { outline:1px solid currentColor;outline-offset:-1px;border-radius:2px; }
[data-sk-artifact] *, [data-sk-artifact] *::before, [data-sk-artifact] *::after { box-sizing: border-box; }
[data-sk-artifact] [data-sk-leaf] { color: transparent !important; background-color: var(--skeleton-color, #e5e9ef) !important; border-color: transparent !important; border-radius: var(--skeleton-radius, 6px); }
[data-sk-artifact] [data-sk-text] { display: inline-block; width: min(100%, 12ch); min-width: 3ch; height: .85em; vertical-align: middle; }
[data-sk-artifact] [data-sk-image] { display: block; min-width: 40px; min-height: 40px; aspect-ratio: var(--skeleton-image-ratio, 4 / 3); }
[data-sk-artifact] [data-sk-fallback] { display: block; width: 100%; min-height: var(--skeleton-min-height, 96px); }
[data-sk-artifact] [data-sk-multiline] { display: block; width: 100%; }
[data-sk-artifact] [data-sk-multiline] > span { display: block; height: .85em; margin-block: .35em; background: var(--skeleton-color, #e5e9ef); border-radius: 4px; }
[data-sk-artifact] [data-sk-multiline] > span:last-child { width: 72%; }
[data-sk-artifact][data-sk-highlight] :is([data-sk-fallback], [data-sk-opaque]) { outline: 2px dashed #e18b2e; outline-offset: -2px; }
[data-sk-artifact][data-sk-highlight] :is([data-sk-fallback], [data-sk-opaque]) { pointer-events:auto; cursor:help; }
@media (prefers-reduced-motion: no-preference) { [data-sk-artifact] [data-sk-leaf] { animation: sk-pulse 1.6s ease-in-out infinite alternate; } }
@keyframes sk-pulse { to { opacity: .55; } }
`;
