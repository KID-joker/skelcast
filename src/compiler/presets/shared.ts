import { parse } from '@vue/compiler-dom';
import type { SkeletonHints } from '../../types.js';
import type { ComponentReference, Presentation } from './types.js';

export const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
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
export const normalize = (name: string) => name.replace(/[-_:]/g, '').toLowerCase();
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
    children: `<header style="min-height:32px">${
      children || 'Calendar'
    }</header><div style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr))">${weekdays
      .map((day) => `<span style="padding:4px;text-align:center;font-size:12px">${day}</span>`)
      .join('')}${Array.from(
      { length: 42 },
      () =>
        '<span data-sk-calendar-cell style="min-width:0;min-height:32px;border-top:1px solid #eee"></span>',
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
export function column(props: Record<string, unknown>, children = ''): Presentation {
  return {
    tag: 'template',
    children: `<span data-sk-column data-label="${escape(
      scalar(props.label ?? props.title),
    )}" data-field="${escape(scalar(props.prop ?? props.dataIndex))}" data-width="${escape(
      dimension(props.width, '120px'),
    )}" data-cell="${escape(children)}"></span>`,
  };
}
/** Finite row/column geometry only; render callbacks and business data parsers never run. */
export function table(
  props: Record<string, unknown>,
  children: string,
  text: string,
  hints: SkeletonHints = {},
): Presentation {
  const descriptors: { label: string; field: string; width: string; content?: string }[] = [];
  const notes: string[] = [];
  const columns = props.columns;
  if (Array.isArray(columns))
    for (const c of columns.slice(0, 24)) {
      if (!c || typeof c !== 'object') continue;
      descriptors.push({
        label: scalar(c.title ?? c.label),
        field: scalar(c.dataIndex ?? c.key),
        width: dimension(c.width, '120px'),
      });
      if (c.render != null || c.customRender != null || Array.isArray(c.children))
        notes.push(
          'Custom/grouped table column renderers need a source adapter; body cells use finite placeholders.',
        );
    }
  if (!descriptors.length) {
    const walk = (node: any) => {
      if (node.type === 1 && node.props.some((p: any) => p.name === 'data-sk-column')) {
        const attrs = Object.fromEntries(node.props.map((p: any) => [p.name, p.value?.content]));
        descriptors.push({
          label: attrs['data-label'] ?? '',
          field: attrs['data-field'] ?? '',
          width: attrs['data-width'] ?? '120px',
          content: attrs['data-cell'] ?? '',
        });
      }
      for (const n of node.children ?? []) walk(n);
    };
    walk(parse(children));
  }
  if (!descriptors.length) {
    for (let i = 0; i < 3; i++) descriptors.push({ label: '', field: '', width: '120px' });
    notes.push(
      'Table columns are unknown; provide literal columns or column components for exact column count.',
    );
  }
  const cols = descriptors.slice(0, 24),
    data = props.data ?? props.dataSource ?? props['data-source'];
  const rows = Math.min(24, Math.max(0, Math.floor(hints.repeat ?? (Array.isArray(data) ? data.length : 4))));
  const width = cols.reduce((sum, c) => sum + (/^\d+px$/.test(c.width) ? parseFloat(c.width) : 120), 0);
  const header = cols
    .map(
      (c) =>
        `<th data-sk-control style="padding:10px;text-align:left;font-weight:500;border-bottom:1px solid #e4e7ed;color:var(--skeleton-control-color,#606266)">${
          escape(c.label) || text
        }</th>`,
    )
    .join('');
  const body = Array.from(
    { length: rows },
    () =>
      `<tr>${cols
        .map((c) => `<td style="padding:12px 10px;border-bottom:1px solid #eee">${c.content || text}</td>`)
        .join('')}</tr>`,
  ).join('');
  return {
    tag: 'div',
    style: 'min-width:0;max-width:100%;overflow-x:auto',
    children: `<table data-sk-data-table style="width:100%;min-width:${width}px;border-collapse:collapse;table-layout:fixed"><colgroup>${cols
      .map((c) => `<col style="width:${c.width}">`)
      .join('')}</colgroup><thead><tr>${header}</tr></thead><tbody>${
      body ||
      `<tr><td data-sk-control colspan="${cols.length}" style="padding:24px;text-align:center;color:var(--skeleton-control-color,#909399)">No data</td></tr>`
    }</tbody></table>`,
    notes: [...new Set(notes)],
  };
}
