import type { ComponentPreset, ComponentRole } from './types.js';
import {
  button,
  input,
  calendar,
  card,
  column,
  table,
  libraryExport,
  readonly,
  dimension,
  escape,
  scalar,
} from './shared.js';

const controls = new Set([
  'button',
  'input',
  'input.textarea',
  'inputnumber',
  'select',
  'select.option',
  'selectoption',
  'datepicker',
  'timepicker',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'pagination',
  'calendar',
]);
const data = new Set([
  'table',
  'avatar',
  'image',
  'statistic',
  'tag',
  'progress',
  'list',
  'list.item',
  'listitem',
  'typography.text',
  'typography.title',
  'typography.paragraph',
  'typographytext',
  'typographytitle',
  'typographyparagraph',
]);
const layouts = new Set([
  'card',
  'card.meta',
  'cardmeta',
  'table.column',
  'tablecolumn',
  'row',
  'col',
  'space',
  'flex',
  'form',
  'form.item',
  'formitem',
  'layout',
  'layout.header',
  'layout.content',
  'layout.footer',
  'layout.sider',
  'layoutheader',
  'layoutcontent',
  'layoutfooter',
  'layoutsider',
  'divider',
  'configprovider',
  'descriptions',
  'descriptions.item',
  'descriptionsitem',
]);
const deep = Object.fromEntries(
  [
    'button',
    'input',
    'input-number',
    'select',
    'date-picker',
    'time-picker',
    'checkbox',
    'radio',
    'switch',
    'slider',
    'pagination',
    'calendar',
    'table',
    'avatar',
    'image',
    'statistic',
    'tag',
    'progress',
    'list',
    'typography',
    'card',
    'row',
    'col',
    'space',
    'flex',
    'form',
    'layout',
    'divider',
    'config-provider',
    'descriptions',
  ].map((n) => [n, n.replace(/-/g, '')]),
);
function role(name: string, props: Record<string, unknown>): ComponentRole | undefined {
  return controls.has(name)
    ? readonly(props) && ['input', 'input.textarea', 'inputnumber'].includes(name)
      ? 'data'
      : 'control'
    : data.has(name)
    ? 'data'
    : layouts.has(name)
    ? 'layout'
    : undefined;
}
export function antDesignPreset(id: 'antd' | 'ant-design-vue'): ComponentPreset {
  return {
    id,
    package: id,
    resolve: (ref) => libraryExport(ref, id, deep),
    role,
    slots: (name) => (name === 'table.column' || name === 'tablecolumn' ? ['default'] : name === 'calendar' ? ['header'] : ['default', 'header', 'footer', 'title', 'extra']),
    present(name, props, children, text, hints, policy) {
      if (name === 'button') return button(children, props);
      if (['input', 'inputnumber', 'input.textarea', 'select', 'datepicker', 'timepicker'].includes(name))
        return input(name === 'input.textarea' ? { ...props, type: 'textarea' } : props);
      if (name === 'select.option' || name === 'selectoption')
        return { tag: 'option', children: children || escape(scalar(props.label ?? props.value)) };
      if (name === 'calendar') return calendar(children);
      if (name === 'checkbox' || name === 'radio')
        return {
          tag: 'label',
          style: 'display:inline-flex;align-items:center;gap:6px',
          children: `<input type="${name}" disabled tabindex="-1">${children}`,
        };
      if (name === 'switch' || name === 'slider' || name === 'pagination')
        return {
          tag: 'div',
          style: `min-height:24px;min-width:${
            name === 'switch' ? '40px' : '120px'
          };border:1px solid #d9d9d9;border-radius:4px`,
          children,
        };
      if (name === 'table') return table(props, policy.columns.resolve(children), text, hints,false,policy.mask);
      if (name === 'table.column' || name === 'tablecolumn') return column(props, children, policy.columns);
      if (name === 'card') return card(children, props.title, text, '24px');
      if (name === 'card.meta' || name === 'cardmeta')
        return {
          tag: 'div',
          children: (props.title ? text : '') + (props.description ? text : '') + children,
        };
      if (name === 'avatar' || name === 'image')
        return {
          tag: 'span',
          leaf: true,
          style: `display:inline-block;width:${dimension(
            props.size,
            name === 'avatar' ? '32px' : '160px',
          )};height:${dimension(props.size, name === 'avatar' ? '32px' : '120px')};flex-shrink:0`,
          children: '',
        };
      if (name === 'statistic')
        return {
          tag: 'div',
          style: 'min-height:60px',
          children:
            (props.title
              ? `<div style="color:var(--skeleton-control-color,#606266)">${escape(
                  scalar(props.title),
                )}</div>`
              : '') + text,
        };
      if (name === 'tag')
        return { tag: 'span', style: 'display:inline-block;padding:2px 8px', children: children || text };
      if (name === 'progress')
        return { tag: 'div', leaf: true, style: 'height:16px;width:100%', children: '' };
      if (name === 'list') {
        const count = Math.min(24, Math.max(0, Math.floor(hints?.repeat ?? (Array.isArray(props.dataSource) ? props.dataSource.length : 4))));
        return {
          tag: 'ul',
          style: 'margin:0;padding:0;list-style:none',
          children:
            children ||
            (count ? Array.from({length:count}, () => `<li style="padding:12px 0;border-bottom:1px solid #eee">${text}</li>`).join('') : '<li data-sk-control style="padding:24px;text-align:center">No data</li>'),
          notes:
            props.renderItem != null
              ? ['List renderItem is not invoked; use a source adapter for a custom row layout.']
              : undefined,
        };
      }
      if (name === 'list.item' || name === 'listitem')
        return { tag: 'li', style: 'padding:12px 0;border-bottom:1px solid #eee', children };
      if (name.startsWith('typography'))
        return {
          tag: name.includes('title') ? 'h3' : name.includes('paragraph') ? 'p' : 'span',
          children: children || text,
        };
      if (['row', 'space', 'flex'].includes(name))
        return { tag: 'div', style: 'display:flex;flex-wrap:wrap;min-width:0;gap:12px', children };
      if (name === 'col')
        return {
          tag: 'div',
          style: `min-width:0;flex:0 1 ${
            typeof props.span === 'number' ? (Math.max(1, Math.min(24, props.span)) / 24) * 100 : 100
          }%`,
          children,
        };
      if (name === 'form.item' || name === 'formitem')
        return {
          tag: 'div',
          style: 'display:flex;flex-direction:column;gap:6px;margin-bottom:24px',
          children:
            (props.label
              ? `<label style="color:var(--skeleton-control-color,#606266)">${escape(
                  scalar(props.label),
                )}</label>`
              : '') + children,
        };
      if (name === 'descriptions.item' || name === 'descriptionsitem')
        return {
          tag: 'div',
          style: 'display:flex;gap:12px;padding:8px 0',
          children:
            `<span style="color:var(--skeleton-control-color,#606266)">${escape(
              scalar(props.label),
            )}</span>` + children,
        };
      if (name === 'divider')
        return { tag: 'div', style: 'height:1px;margin:24px 0;background:#f0f0f0', children: '' };
      if (name === 'configprovider') return { tag: 'div', style: 'display:contents', children };
      if (layouts.has(name)) return { tag: 'div', style: 'min-width:0', children };
    },
  };
}
