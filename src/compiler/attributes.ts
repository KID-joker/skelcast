import { parse, type ElementNode } from '@vue/compiler-dom';
import type { ModuleInfo } from './context.js';
import type { Value } from './expression.js';
import { classString, styleString, voids } from './html.js';
import { sourceIdAttribute } from './styles.js';
import { camelizeProp } from './props.js';
import { outputAttribute } from './output.js';
import type { StyleOptions } from '../types.js';

export function fallthroughAttrs(module: Pick<ModuleInfo, 'propDefaults'>, props: Record<string, Value>): Record<string, Value> {
  return Object.fromEntries(Object.entries(props).filter(([key]) => {
    return !key.startsWith('__sk') && !Object.hasOwn(module.propDefaults, camelizeProp(key));
  }));
}

interface RootElement { start: number; tag: string; opening: string; node?: ElementNode }

/** Operation-local root metadata. Native output already knows its opening tag;
 * fragments use the existing parser once, then carry roots through inheritance. */
export class RootMarkup {
  private elements = new Map<string, RootElement[]>();
  constructor(private parseHTML = parse) {}

  rememberElement(html: string, tag: string, opening: string): void {
    this.elements.set(html, [{ start: 0, tag, opening }]);
  }

  rewrite(html: string, update: (opening: string, node: ElementNode, count: number) => string): string {
    let roots = this.elements.get(html);
    if (!roots) {
      roots = this.parseHTML(html).children.filter((node): node is ElementNode => node.type === 1).map(node => {
        const start = node.loc.start.offset;
        const end = html.indexOf('>', node.props.at(-1)?.loc.end.offset ?? start + node.tag.length + 1) + 1;
        return { start, tag: node.tag, opening: html.slice(start, end) };
      });
      this.elements.set(html, roots);
    }
    const chunks: string[] = [], updated: RootElement[] = [];
    let cursor = 0, delta = 0;
    for (const root of roots) {
      const suffix = voids.has(root.tag) || root.opening.endsWith('/>') ? '' : `</${root.tag}>`;
      const node = root.node ??= this.parseHTML(root.opening + suffix).children[0] as ElementNode;
      const opening = update(root.opening, node, roots.length);
      chunks.push(html.slice(cursor, root.start), opening);
      updated.push({ start: root.start + delta, tag: root.tag, opening, node: opening === root.opening ? node : undefined });
      cursor = root.start + root.opening.length;
      delta += opening.length - root.opening.length;
    }
    chunks.push(html.slice(cursor));
    const result = chunks.join('');
    this.elements.set(result, updated);
    return result;
  }
}

/** Forward layout attributes to component roots, merging existing classes/styles. */
export function inheritRootScopes(
  html: string,
  scopes: string[],
  attrs: Record<string, Value>,
  rootStyle: string,
  attributes: (props: Record<string, Value>) => string,
  styles?: StyleOptions,
  markup = new RootMarkup(),
): string {
  if (!html || !scopes.length && !Object.keys(attrs).length && !rootStyle) return html;
  return markup.rewrite(html, (opening, node, count) => {
    let inherited = '';
    if (count === 1 || rootStyle) {
      const forwarded = count === 1 ? { ...attrs } : {};
      if (rootStyle) forwarded.style = `${rootStyle};${styleString(forwarded.style)}`;
      for (const attribute of [...node.props].reverse()) {
        const key = attribute.name === sourceIdAttribute ? 'id' : attribute.name;
        if (attribute.type !== 6 || !outputAttribute(key, forwarded[key], styles)) continue;
        if (attribute.name === 'class') forwarded.class = `${attribute.value?.content ?? ''} ${classString(forwarded.class)}`;
        else if (attribute.name === 'style') forwarded.style = `${attribute.value?.content ?? ''};${styleString(forwarded.style)}`;
        opening = opening.slice(0, attribute.loc.start.offset) + opening.slice(attribute.loc.end.offset);
      }
      inherited = attributes(forwarded);
    }
    const extra = scopes.filter(scope => !node.props.some(property => property.name === scope));
    const offset = node.tag.length + 1;
    return opening.slice(0, offset) + inherited + extra.map(scope => ` ${scope}`).join('') + opening.slice(offset);
  });
}
