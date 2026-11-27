import { parse, type ElementNode } from '@vue/compiler-dom';
import type { ModuleInfo } from './context.js';
import type { Value } from './expression.js';
import { classString, styleString } from './html.js';
import { sourceIdAttribute } from './styles.js';
import { camelizeProp } from './props.js';

export function fallthroughAttrs(module: Pick<ModuleInfo, 'propDefaults'>, props: Record<string, Value>): Record<string, Value> {
  return Object.fromEntries(Object.entries(props).filter(([key]) => {
    return !key.startsWith('__sk') && !Object.hasOwn(module.propDefaults, camelizeProp(key));
  }));
}

/** Forward layout attributes to component roots, merging existing classes/styles. */
export function inheritRootScopes(
  html: string,
  scopes: string[],
  attrs: Record<string, Value>,
  rootStyle: string,
  attributes: (props: Record<string, Value>) => string,
): string {
  if (!html || !scopes.length && !Object.keys(attrs).length && !rootStyle) return html;
  const roots = parse(html).children.filter((node): node is ElementNode => node.type === 1);
  // Work backwards so source offsets remain valid as attributes are inserted.
  for (const node of [...roots].reverse()) {
    let inherited = '';
    if (roots.length === 1 || rootStyle) {
      const forwarded = roots.length === 1 ? { ...attrs } : {};
      if (rootStyle) forwarded.style = `${rootStyle};${styleString(forwarded.style)}`;
      for (const attribute of [...node.props].reverse()) {
        const key = attribute.name === sourceIdAttribute ? 'id' : attribute.name;
        if (attribute.type !== 6 || forwarded[key] == null || !attributes({ [key]: forwarded[key] })) continue;
        if (attribute.name === 'class') forwarded.class = `${attribute.value?.content ?? ''} ${classString(forwarded.class)}`;
        else if (attribute.name === 'style') forwarded.style = `${attribute.value?.content ?? ''};${styleString(forwarded.style)}`;
        html = html.slice(0, attribute.loc.start.offset) + html.slice(attribute.loc.end.offset);
      }
      inherited = attributes(forwarded);
    }
    const extra = scopes.filter(scope => !node.props.some(property => property.name === scope));
    const offset = node.loc.start.offset + node.tag.length + 1;
    html = html.slice(0, offset) + inherited + extra.map(scope => ` ${scope}`).join('') + html.slice(offset);
  }
  return html;
}
