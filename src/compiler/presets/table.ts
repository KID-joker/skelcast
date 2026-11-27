import type { SkeletonHints } from '../../types.js';
import { SOURCE_INITIAL, UNKNOWN, sourceCapacity, sourceCellGlyphs } from '../expression.js';
import type { TableColumn } from './columns.js';
import type { Presentation } from './types.js';
import { dimension, escape, scalar } from './shared.js';

interface TableLayout {
  className?: string;
  style: string;
  width: string;
  columnWidths: string[];
  headerPadding: string;
  cellPadding: string;
  cellOpen: string;
  cellClose: string;
}
export interface TableGeometry {
  column(props: Record<string, unknown>): Pick<TableColumn, 'width' | 'fixed' | 'type'>;
  layout(columns: readonly TableColumn[], width: number, props: Record<string, unknown>): TableLayout;
}
const plainGeometry: TableGeometry = {
  column: props => ({ width: dimension(props.width ?? props.minWidth, '120px'), fixed: props.width != null, type: undefined }),
  layout: columns => ({
    style: '', width: '100%', columnWidths: columns.map(column => column.width),
    headerPadding: '10px', cellPadding: '12px 10px', cellOpen: '', cellClose: '',
  }),
};

/** Normalize source columns and loading capacity independently of library geometry. */
function tableData(props: Record<string, unknown>, slotColumns: readonly TableColumn[], hints: SkeletonHints, masked: boolean, geometry: TableGeometry) {
  const descriptors: TableColumn[] = [];
  const notes: string[] = [];
  let columns = props.columns;
  if (hints.state === 'loading' && columns && typeof columns === 'object' && Object.hasOwn(columns, SOURCE_INITIAL)) {
    columns = (columns as { [SOURCE_INITIAL]: unknown })[SOURCE_INITIAL];
    notes.push('Use source-declared initial columns for the loading frame; runtime column changes remain unknown.');
  }
  if (Array.isArray(columns)) for (const column of columns.slice(0, 24)) {
    if (!column || typeof column !== 'object' || column.hide === true) continue;
    descriptors.push({
      label: scalar(column.title ?? column.label),
      field: scalar(column.prop ?? column.dataIndex ?? column.key),
      ...geometry.column(column),
      align: ['left', 'center', 'right'].includes(column.align) ? column.align : 'left',
      headerAlign: ['left', 'center', 'right'].includes(column.headerAlign) ? column.headerAlign : undefined,
    });
    if (column.render != null || column.customRender != null || column.cellRenderer != null
      || column.hide != null && typeof column.hide !== 'boolean' || Array.isArray(column.children)) {
      notes.push('Custom/grouped table column renderers need a source adapter; body cells use finite placeholders.');
    }
  }
  if (!descriptors.length) descriptors.push(...slotColumns);
  if (!descriptors.length) {
    for (let i = 0; i < 3; i++) descriptors.push({ label: '', field: '', width: '120px' });
    notes.push('Table columns are unknown; provide literal columns or column components for exact column count.');
  }
  const data = props.data ?? props.dataSource ?? props['data-source'];
  const loadingEmpty = Array.isArray(data) && data.length === 0 && hints.state === 'loading';
  if (loadingEmpty) notes.push('Empty source table is projected as a loading frame; response count and values are unknown. Use state: source for an empty-state view.');
  const pagination = props.pagination;
  const initial = pagination && typeof pagination === 'object' && Object.hasOwn(pagination, SOURCE_INITIAL)
    ? (pagination as { [SOURCE_INITIAL]: Record<string, unknown> })[SOURCE_INITIAL] : undefined;
  const size = pagination && typeof pagination === 'object' ? (pagination as Record<string, unknown>).pageSize : undefined;
  const capacity = typeof size === 'number' ? size : initial?.pageSize;
  const declaredCapacity = hints.state === 'loading' && typeof capacity === 'number' && Number.isInteger(capacity) && capacity > 0 ? capacity : undefined;
  if (declaredCapacity != null && (data === UNKNOWN || !Array.isArray(data) || loadingEmpty)) notes.push('Loading row capacity follows source-declared pagination; response count and cell values remain unknown.');
  const sourceBound = sourceCapacity(data);
  const glyphs = masked ? sourceCellGlyphs(data) : undefined;
  if (sourceBound != null) notes.push('Representative row capacity follows the source collection declaration or slice bound; later mutations, result length and cell values remain unknown.');
  if (glyphs) notes.push('Masked cell wrapping follows literal source glyph prototypes; helper mutations and actual cell values remain unknown. These prototypes are not expression bindings.');
  const rows = Math.min(24, Math.max(0, Math.floor(hints.repeat ?? (Array.isArray(data) && !loadingEmpty ? data.length : declaredCapacity ?? sourceBound ?? 4))));
  return { columns: descriptors.slice(0, 24), data, glyphs, rows, notes: [...new Set(notes)] };
}

const selection = '<input data-sk-layout type="checkbox" disabled tabindex="-1" data-sk-control style="width:14px;height:14px;margin:0;vertical-align:middle">';

/** Render finite table structure; library-specific sizing is supplied once per table. */
export function table(
  props: Record<string, unknown>,
  slotColumns: readonly TableColumn[],
  text: string,
  hints: SkeletonHints = {},
  masked = true,
  geometry: TableGeometry = plainGeometry,
): Presentation {
  const { columns, data, glyphs, rows, notes } = tableData(props, slotColumns, hints, masked, geometry);
  const width = columns.reduce((sum, column) => sum + (/^\d+px$/.test(column.width) ? parseFloat(column.width) : 120), 0);
  const layout = geometry.layout(columns, width, props);
  const header = columns.map(column => {
    const content = column.type === 'selection' ? selection : column.type === 'expand' ? '' : escape(column.label) || text;
    return `<th data-sk-layout data-sk-control style="padding:${layout.headerPadding};text-align:${column.headerAlign ?? column.align ?? 'left'};font-weight:500;border-bottom:1px solid #e4e7ed;color:var(--skeleton-control-color,#606266)">${layout.cellOpen}${content}${layout.cellClose}</th>`;
  }).join('');
  const body = Array.from({ length: rows }, (_, index) => {
    const row = Array.isArray(data) ? data[index] : glyphs?.[index];
    const cells = columns.map(column => {
      const value = row && typeof row === 'object' && Object.hasOwn(row, column.field) ? (row as Record<string, unknown>)[column.field] : undefined;
      const content = column.type === 'selection' ? selection
        : column.type === 'expand' ? '<span data-sk-layout data-sk-control>›</span>'
        : column.content || (typeof value === 'string' || typeof value === 'number'
          ? `<span data-sk-layout data-sk-text data-sk-measured data-sk-leaf data-sk-text-content="${escape(value)}"></span>` : text);
      return `<td data-sk-layout style="padding:${layout.cellPadding};text-align:${column.align ?? 'left'};border-bottom:1px solid #eee">${layout.cellOpen}${content}${layout.cellClose}</td>`;
    }).join('');
    return `<tr data-sk-layout>${cells}</tr>`;
  }).join('');
  const colgroup = layout.columnWidths.map(width => `<col data-sk-layout${width ? ` style="width:${width}"` : ''}>`).join('');
  const empty = `<tr data-sk-layout><td data-sk-layout data-sk-control colspan="${columns.length}" style="padding:24px;text-align:center;color:var(--skeleton-control-color,#909399)">No data</td></tr>`;
  return {
    tag: 'div', className: layout.className,
    style: `min-width:0;max-width:100%;overflow-x:auto;${layout.style}${props.height != null ? 'height:' + dimension(props.height, 'auto') + ';' : ''}${props.maxHeight != null ? 'max-height:' + dimension(props.maxHeight, 'none') + ';' : ''}`,
    children: `<table data-sk-layout data-sk-data-table style="width:${layout.width};min-width:${width}px;border-collapse:collapse;table-layout:fixed"><colgroup data-sk-layout>${colgroup}</colgroup>${props.showHeader === false ? '' : `<thead data-sk-layout><tr data-sk-layout>${header}</tr></thead>`}<tbody data-sk-layout>${body || empty}</tbody></table>`,
    notes,
  };
}
