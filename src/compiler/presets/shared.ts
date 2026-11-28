import type { ComponentReference, Presentation } from './types.js';
import type { TableColumns } from './columns.js';
import { escapeHTML as escape } from '../../shared.js';
import { componentName as normalize } from '../components.js';

export { escape, normalize };
export const scalar = (value: unknown, fallback = '') =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
export const dimension = (value: unknown, fallback: string) =>
  typeof value === 'number' && Number.isFinite(value)
    ? `${Math.max(0, value)}px`
    : typeof value === 'string' && /^\d+(?:\.\d+)?(?:px|%|rem|em)?$/.test(value)
    ? /^\d+(?:\.\d+)?$/.test(value)
      ? value + 'px'
      : value
    : fallback;
export const readonly = (props: Record<string, unknown>) =>
  props.readonly === true || props.readOnly === true;

/** Explicit package entry points/deep-import names; no component-prefix guessing. */
export function libraryExport(
  reference: ComponentReference,
  pkg: string,
  deep: Record<string, string>,
): string | undefined {
  if ([pkg, pkg + '/es', pkg + '/lib'].includes(reference.request)) return normalize(reference.exported);
  for (const [path, name] of Object.entries(deep))
    for (const format of ['es', 'lib']) {
      if (
        ![
          `${pkg}/${format}/${path}`,
          `${pkg}/${format}/${path}/index`,
          `${pkg}/${format}/${path}/index.js`,
          `${pkg}/${format}/${path}/index.mjs`,
        ].includes(reference.request)
      )
        continue;
      const exported = reference.exported;
      return exported === 'default'
        ? normalize(name)
        : exported.startsWith('default.')
        ? normalize(name + exported.slice(7))
        : normalize(exported);
    }
}

export function button(children: string, _props: Record<string, unknown>, height = '32px'): Presentation {
  return {
    tag: 'button',
    style: `display:inline-flex;align-items:center;justify-content:center;gap:6px;flex-shrink:0;min-height:${height};padding:0 15px;border:1px solid #d9d9d9;border-radius:4px;background:var(--skeleton-control-background,#fff);font:inherit`,
    children,
  };
}
export function choice(type: 'checkbox' | 'radio', children: string): Presentation {
  return {
    tag: 'label',
    style: 'display:inline-flex;align-items:center;gap:6px',
    children: `<input data-sk-layout type="${type}" disabled tabindex="-1">${children}`,
  };
}
export function imagePlaceholder(size: unknown, width: string, height: string): Presentation {
  return {
    tag: 'span',
    leaf: true,
    style: `display:inline-block;width:${dimension(size, width)};height:${dimension(size, height)};flex-shrink:0`,
    children: '',
  };
}
export function formItem(children: string, label: unknown, margin = '18px'): Presentation {
  return {
    tag: 'div',
    style: `display:flex;flex-direction:column;gap:6px;margin-bottom:${margin}`,
    children: (label ? `<label data-sk-layout style="color:var(--skeleton-control-color,#606266)">${escape(scalar(label))}</label>` : '') + children,
  };
}
export function descriptionItem(children: string, label: unknown): Presentation {
  return {
    tag: 'div',
    style: 'display:flex;gap:12px;padding:8px 0',
    children: `<span data-sk-layout style="color:var(--skeleton-control-color,#606266)">${escape(scalar(label))}</span>` + children,
  };
}
export function input(props: Record<string, unknown>, height = '32px'): Presentation {
  return {
    tag: props.type === 'textarea' ? 'textarea' : 'input',
    style: `display:block;min-width:0;width:100%;height:${
      props.type === 'textarea' ? '80px' : height
    };padding:4px 11px;border:1px solid #d9d9d9;border-radius:4px;background:var(--skeleton-control-background,#fff);font:inherit`,
    leaf: readonly(props),
    children: '',
  };
}
export function calendar(children: string): Presentation {
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return {
    tag: 'section',
    style: 'min-width:0;width:100%;padding:12px;border:1px solid #d9d9d9;border-radius:4px',
    children: `<header data-sk-layout style="min-height:32px">${
      children || 'Calendar'
    }</header><div data-sk-layout style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr))">${weekdays
      .map((day) => `<span data-sk-layout style="padding:4px;text-align:center;font-size:12px">${day}</span>`)
      .join('')}${Array.from(
      { length: 42 },
      () =>
        '<span data-sk-layout data-sk-calendar-cell style="min-width:0;min-height:32px;border-top:1px solid #eee"></span>',
    ).join('')}</div>`,
    notes: [
      'Calendar uses an inert neutral date grid; current dates and custom event-cell renderers are not inferred.',
    ],
  };
}
export function card(children: string, title: unknown, text: string, padding = '20px'): Presentation {
  return {
    tag: 'section',
    style: `display:block;min-width:0;padding:${padding};border:1px solid #e4e7ed;border-radius:4px`,
    children: (title != null ? text : '') + children,
  };
}
export function column(props: Record<string, unknown>, children: string, columns: TableColumns, geometry: Partial<import('./columns.js').TableColumn> = {}): Presentation {
  const nested=columns.resolve(children);
  return {
    tag: 'template',
    children: columns.register({
      label: scalar(props.label ?? props.title),
      field: scalar(props.prop ?? props.dataIndex),
      width: dimension(props.width, '120px'),
      fixed: true,
      content: nested.length?undefined:children,
      children:nested.length?nested:undefined,
      ...geometry,
    }),
  };
}
