import path from 'node:path';
import { readFile } from 'node:fs/promises';
import postcss, { type Container, type Root } from 'postcss';

const mime: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf' };

function assetURLs(value: string): RegExpExecArray[] {
  const pattern = /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|((?:\\.|[^\s)'"\\])+))\s*\)/iy;
  const matches: RegExpExecArray[] = [];
  for (let index = 0; index < value.length;) {
    const char = value[index];
    if (value.startsWith('/*', index)) { const end = value.indexOf('*/', index + 2); index = end < 0 ? value.length : end + 2; continue; }
    if (char === '"' || char === "'") {
      const quote = char;
      for (index++; index < value.length; index++) { if (value[index] === '\\') index++; else if (value[index] === quote) { index++; break; } }
      continue;
    }
    pattern.lastIndex = index;
    const match = !/[\w-]/.test(value[index - 1] ?? '') ? pattern.exec(value) : null;
    if (match) { matches.push(match); index = pattern.lastIndex; }
    else index += char === '\\' ? 2 : 1;
  }
  return matches;
}

/** Preserve each declaration's import origin. Embedded assets work in inline
 * styles, Shadow DOM, nested routes and production builds without a bundler hook. */
export async function embedStyleAssets(root: Root, entry: string, read: (file: string) => Promise<Uint8Array> = readFile, resolve?: (request: string, from: string) => Promise<string | undefined>): Promise<void> {
  const declarations: Promise<void>[] = [];
  root.walkDecls(declaration => {
    declarations.push((async () => {
      let result = '', previous = 0;
      for (const match of assetURLs(declaration.value)) {
        const url = match[1] ?? match[2] ?? match[3];
        if (/^(?:[a-z][\w+.-]*:|\/|#)/i.test(url)) continue;
        const [pathname, fragment] = url.split('#', 2);
        const filename = decodeURIComponent(pathname.split('?')[0].replace(/\\([ ()'"\\])/g, '$1'));
        const location = declaration.source;
        const mapped = location?.input.origin(location.start?.line ?? 1, location.start?.column ?? 1);
        const origin = mapped && mapped.file || location?.input.file || entry;
        const file = await resolve?.(filename, origin) ?? path.resolve(path.dirname(origin), filename);
        const bytes = await read(file);
        const data = `data:${mime[path.extname(file).toLowerCase()] ?? 'application/octet-stream'};base64,${Buffer.from(bytes).toString('base64')}${fragment ? `#${fragment}` : ''}`;
        result += declaration.value.slice(previous, match.index) + `url("${data}")`;
        previous = match.index + match[0].length;
      }
      if (previous) declaration.value = result + declaration.value.slice(previous);
    })());
  });
  await Promise.all(declarations);
}

const unquote = (value: string) => value.trim().replace(/^(['"])([\s\S]*)\1$/, '$2').replace(/\s+/g, ' ');
const animationKeywords = new Set(['none', 'infinite', 'normal', 'reverse', 'alternate', 'alternate-reverse', 'forwards', 'backwards', 'both', 'running', 'paused', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'step-start', 'step-end']);

/** CSS selectors do not scope keyframe or font names. Rewrite declarations and
 * their references, including inline style attributes, using an artifact prefix. */
export function namespaceGlobals(root: Root, prefix: string, inline: Container[] = []): void {
  const animations = new Map<string, string>(), fonts = new Map<string, string>();
  root.walkAtRules(rule => {
    if (/^(?:-webkit-)?keyframes$/i.test(rule.name)) {
      const name = unquote(rule.params);
      const mapped = `${prefix}-animation-${animations.size}`;
      if (!animations.has(name)) animations.set(name, mapped);
      rule.params = animations.get(name)!;
    }
    if (rule.name.toLowerCase() === 'font-face') rule.walkDecls(/^font-family$/i, declaration => {
      const name = unquote(declaration.value).toLowerCase();
      if (!fonts.has(name)) fonts.set(name, `${prefix}-font-${fonts.size}`);
    });
  });
  const containers = [root, ...inline];
  const variables = new Map<string, Set<string>>();
  const references = (value: string) => [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map(match => match[1]);
  const isReference = (property: string) => /^(?:-webkit-)?animation(?:-name)?$/.test(property) || property === 'font' || property === 'font-family';
  const add = (name: string, role: string) => {
    let roles = variables.get(name);
    if (!roles) variables.set(name, roles = new Set());
    const previous = roles.size;
    roles.add(role);
    return previous !== roles.size;
  };
  for (const container of containers) container.walkDecls(declaration => {
    const property = declaration.prop.toLowerCase();
    if (isReference(property)) for (const name of references(declaration.value)) add(name, property);
  });
  let changed: boolean;
  do {
    changed = false;
    for (const container of containers) container.walkDecls(declaration => {
      for (const role of variables.get(declaration.prop) ?? []) for (const name of references(declaration.value)) if (add(name, role)) changed = true;
    });
  } while (changed);
  const rewriteValue = (property: string, input: string): string => {
    // Rewrite finite fallback names as well as declarations supplying variables.
    let value = input.replace(/var\(\s*(--[\w-]+)\s*,\s*([^()]*)\)/g, (_match, name: string, fallback: string) => `var(${name}, ${rewriteValue(property, fallback)})`);
    if (/^(?:-webkit-)?animation(?:-name)?$/.test(property)) {
      value = postcss.list.comma(value).map(animation => postcss.list.space(animation).map(token => {
        const name = unquote(token);
        const isName = property.endsWith('-name') || /^['"]/.test(token) || !animationKeywords.has(name.toLowerCase());
        return isName ? animations.get(name) ?? token : token;
      }).join(' ')).join(', ');
    }
    if (property === 'font-family' || property === 'font') value = postcss.list.comma(value).map(family => {
      const tokens = postcss.list.space(family);
      for (let start = 0; start < tokens.length; start++) {
        if (property === 'font-family' && start > 0) break;
        const mapped = fonts.get(unquote(tokens.slice(start).join(' ')).toLowerCase());
        if (mapped) return [...tokens.slice(0, start), `"${mapped}"`].join(' ');
      }
      return family;
    }).join(', ');
    return value;
  };
  for (const container of containers) container.walkDecls(declaration => {
    const property = declaration.prop.toLowerCase();
    for (const role of isReference(property) ? [property] : variables.get(declaration.prop) ?? []) declaration.value = rewriteValue(role, declaration.value);
  });
}
