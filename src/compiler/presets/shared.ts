import type { SkeletonHints } from '../../types.js';
import type { ComponentReference, Presentation } from './types.js';
import type { TableColumn, TableColumns } from './columns.js';
import { SOURCE_INITIAL, UNKNOWN, sourceCapacity, sourceCellGlyphs } from '../expression.js';
import { escapeHTML as escape } from '../../shared.js';

export { escape };
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
export function column(props: Record<string, unknown>, children: string, columns: TableColumns): Presentation {
  return {
    tag: 'template',
    children: columns.register({
      label: scalar(props.label ?? props.title),
      field: scalar(props.prop ?? props.dataIndex),
      width: dimension(props.width, '120px'),
      fixed: true,
      content: children,
    }),
  };
}
/** Finite row/column geometry only; render callbacks and business data parsers never run. */
export function table(
  props: Record<string, unknown>,
  slotColumns: readonly TableColumn[],
  text: string,
  hints: SkeletonHints = {},
  element = false,
  masked = true,
): Presentation {
  const descriptors: TableColumn[] = [];
  const notes: string[] = [];
  let columns = props.columns;
  if(hints.state==='loading'&&columns&&typeof columns==='object'&&Object.hasOwn(columns,SOURCE_INITIAL)){
    columns=(columns as{[SOURCE_INITIAL]:unknown})[SOURCE_INITIAL];notes.push('Use source-declared initial columns for the loading frame; runtime column changes remain unknown.');
  }
  if (Array.isArray(columns))
    for (const c of columns.slice(0, 24)) {
      if (!c || typeof c !== 'object') continue;
      if(c.hide===true)continue;
      descriptors.push({
        label: scalar(c.title ?? c.label),
        field: scalar(c.prop ?? c.dataIndex ?? c.key),
        width: dimension(c.width??c.minWidth, element&&['selection','expand'].includes(c.type)?'48px':element?'80px':'120px'),fixed:c.width!=null||element&&['selection','expand'].includes(c.type),type:element?scalar(c.type):undefined,
        align:['left','center','right'].includes(c.align)?c.align:'left',headerAlign:['left','center','right'].includes(c.headerAlign)?c.headerAlign:undefined,
      });
      if (c.render != null || c.customRender != null || c.cellRenderer!=null || c.hide!=null&&typeof c.hide!=='boolean' || Array.isArray(c.children))
        notes.push(
          'Custom/grouped table column renderers need a source adapter; body cells use finite placeholders.',
        );
    }
  if (!descriptors.length) descriptors.push(...slotColumns);
  if (!descriptors.length) {
    for (let i = 0; i < 3; i++) descriptors.push({ label: '', field: '', width: '120px' });
    notes.push(
      'Table columns are unknown; provide literal columns or column components for exact column count.',
    );
  }
  const cols = descriptors.slice(0, 24),
    data = props.data ?? props.dataSource ?? props['data-source'];
  const loadingEmpty=Array.isArray(data)&&data.length===0&&hints.state==='loading';
  if(loadingEmpty)notes.push('Empty source table is projected as a loading frame; response count and values are unknown. Use state: source for an empty-state view.');
  const pagination=props.pagination;
  const initial=pagination&&typeof pagination==='object'&&Object.hasOwn(pagination,SOURCE_INITIAL)?(pagination as {[SOURCE_INITIAL]:Record<string,unknown>})[SOURCE_INITIAL]:undefined;
  const size=pagination&&typeof pagination==='object'?(pagination as Record<string,unknown>).pageSize:undefined;
  const capacity=typeof size==='number'?size:initial?.pageSize;
  const declaredCapacity=hints.state==='loading'&&typeof capacity==='number'&&Number.isInteger(capacity)&&capacity>0?capacity:undefined;
  if(declaredCapacity!=null&&(data===UNKNOWN||!Array.isArray(data)||loadingEmpty))notes.push('Loading row capacity follows source-declared pagination; response count and cell values remain unknown.');
  const sourceBound=sourceCapacity(data);
  const glyphs=masked?sourceCellGlyphs(data):undefined;
  if(sourceBound!=null)notes.push('Representative row capacity follows the source collection declaration or slice bound; later mutations, result length and cell values remain unknown.');
  if(glyphs)notes.push('Masked cell wrapping follows literal source glyph prototypes; helper mutations and actual cell values remain unknown. These prototypes are not expression bindings.');
  const rows = Math.min(24, Math.max(0, Math.floor(hints.repeat ?? (Array.isArray(data)&&!loadingEmpty ? data.length : declaredCapacity??sourceBound??4))));
  const width = cols.reduce((sum, c) => sum + (/^\d+px$/.test(c.width) ? parseFloat(c.width) : 120), 0);
  const flexWidth=cols.filter(c=>!c.fixed).reduce((sum,c)=>sum+(/^\d+px$/.test(c.width)?parseFloat(c.width):0),0);
  const pixelColumns=cols.every(c=>/^\d+px$/.test(c.width));
  // Percentages on <col> participate in the table's own sizing cycle. Resolve
  // spare space against the containing frame so overflow keeps each minimum.
  const columnWidth=(c:typeof cols[number])=>!element||c.fixed||props.fit===false?c.width:pixelColumns&&flexWidth>0?`calc(${c.width} + max(0px, 100cqw - ${width}px) * ${parseFloat(c.width)/flexWidth})`:'';
  const header = cols
    .map(
      (c) =>
        `<th data-sk-layout data-sk-control style="padding:${element?'8px 0':'10px'};text-align:${c.headerAlign??c.align??'left'};font-weight:500;border-bottom:1px solid #e4e7ed;color:var(--skeleton-control-color,#606266)">${element?'<div data-sk-layout class="cell" style="padding:0 12px;line-height:23px;overflow-wrap:break-word">':''}${
          c.type==='selection'?'<input data-sk-layout type="checkbox" disabled tabindex="-1" data-sk-control style="width:14px;height:14px;margin:0;vertical-align:middle">':c.type==='expand'?'':escape(c.label) || text
        }${element?'</div>':''}</th>`,
    )
    .join('');
  const body = Array.from(
    { length: rows },
    (_,index) =>
      `<tr data-sk-layout>${cols
        .map((c) => {
          const row=Array.isArray(data)?data[index]:glyphs?.[index],value=row&&typeof row==='object'&&Object.hasOwn(row,c.field)?(row as Record<string,unknown>)[c.field]:undefined;
          const content=c.type==='selection'?'<input data-sk-layout type="checkbox" disabled tabindex="-1" data-sk-control style="width:14px;height:14px;margin:0;vertical-align:middle">':c.type==='expand'?'<span data-sk-layout data-sk-control>›</span>':c.content||((typeof value==='string'||typeof value==='number')?`<span data-sk-layout data-sk-text data-sk-measured data-sk-leaf data-sk-text-content="${escape(value)}"></span>`:text);
          return `<td data-sk-layout style="padding:${element?'8px 0':'12px 10px'};text-align:${c.align??'left'};border-bottom:1px solid #eee">${element?'<div data-sk-layout class="cell" style="padding:0 12px;line-height:23px;overflow-wrap:break-word">':''}${content}${element?'</div>':''}</td>`;
        })
        .join('')}</tr>`,
  ).join('');
  return {
    tag: 'div',
    className:element?'el-table':undefined,
    style: `min-width:0;max-width:100%;overflow-x:auto;${element?'font-size:14px;':''}${element&&pixelColumns&&flexWidth>0&&props.fit!==false?'container-type:inline-size;':''}${props.height!=null?'height:'+dimension(props.height,'auto')+';':''}${props.maxHeight!=null?'max-height:'+dimension(props.maxHeight,'none')+';':''}`,
    children: `<table data-sk-layout data-sk-data-table style="width:${element&&props.fit===false?`${width}px`:'100%'};min-width:${width}px;border-collapse:collapse;table-layout:fixed"><colgroup data-sk-layout>${cols
      .map((c) => `<col data-sk-layout${columnWidth(c)?` style="width:${columnWidth(c)}"`:''}>`)
      .join('')}</colgroup>${props.showHeader===false?'':`<thead data-sk-layout><tr data-sk-layout>${header}</tr></thead>`}<tbody data-sk-layout>${
      body ||
      `<tr data-sk-layout><td data-sk-layout data-sk-control colspan="${cols.length}" style="padding:24px;text-align:center;color:var(--skeleton-control-color,#909399)">No data</td></tr>`
    }</tbody></table>`,
    notes: [...new Set(notes)],
  };
}
