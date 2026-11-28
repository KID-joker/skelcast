import type { SkeletonHints } from '../../types.js';
import { SOURCE_INITIAL, UNKNOWN, sourceCall, sourceObject, sourceCapacity, sourceCellGlyphs } from '../expression.js';
import type { TableColumn } from './columns.js';
import type { Presentation } from './types.js';
import { dimension, escape, scalar } from './shared.js';

interface TableLayout {
  className?: string;
  rowClass?: string;
  headerClass?: string;
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

/** Loading capacity is representative and independent of response values. */
export function tableOutline(props: Record<string, unknown>, declarations: readonly TableColumn[], hints: SkeletonHints = {}, native = false): Presentation {
  const configured: {label:string;width:string}[] = [];
  const source = props.columns && typeof props.columns === 'object' && Object.hasOwn(props.columns, SOURCE_INITIAL)
    ? (props.columns as {[SOURCE_INITIAL]:unknown})[SOURCE_INITIAL] : props.columns;
  let visited = 0;
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const column of value) {
      if (++visited > 64 || configured.length >= 6) return;
      if (!column || typeof column !== 'object' || column.hide === true) continue;
      if (Array.isArray(column.children)) collect(column.children);
      else configured.push({label:scalar(column.title ?? column.label),width:dimension(column.width ?? column.minWidth,'')});
    }
  };
  collect(source);
  const columns = configured.length ? configured : declarations.length ? declarations.slice(0,6)
    : Array.from({length:3},()=>({label:'',width:''}));
  const rows = Math.min(24, Math.max(1, Math.floor(hints.repeat ?? 4)));
  const text = '<span data-sk-layout data-sk-text data-sk-leaf></span>';
  const headers = props.showHeader === false ? '' : `<thead data-sk-layout><tr data-sk-layout>${columns.map(column=>`<th data-sk-layout data-sk-control>${column.label ? escape(column.label) : text}</th>`).join('')}</tr></thead>`;
  const data = props.data ?? props.dataSource ?? props['data-source'];
  const body = hints.state === 'source' && Array.isArray(data) && data.length === 0 && hints.repeat == null
    ? `<tr data-sk-layout><td data-sk-layout data-sk-control colspan="${columns.length}">No data</td></tr>`
    : Array.from({length:rows},()=>`<tr data-sk-layout>${columns.map(()=>`<td data-sk-layout>${text}</td>`).join('')}</tr>`).join('');
  const children = `<colgroup data-sk-layout>${columns.map(c=>`<col data-sk-layout${c.width ? ` style="width:${c.width}"` : ''}>`).join('')}</colgroup>${headers}<tbody data-sk-layout>${body}</tbody>`;
  const tableStyle = 'width:100%;table-layout:fixed;border-collapse:collapse;';
  const dimensions = `${props.height != null ? 'height:'+dimension(props.height,'auto')+';' : ''}${props.maxHeight != null ? 'max-height:'+dimension(props.maxHeight,'none')+';' : ''}${hints.minHeight != null ? 'min-height:'+dimension(hints.minHeight,'0px')+';' : ''}`;
  return native ? {tag:'table',style:tableStyle+dimensions,children}
    : {tag:'div',className:'sk-table-outline',style:'min-width:0;max-width:100%;overflow-x:auto;'+dimensions,
      children:`<table data-sk-layout data-sk-outline data-sk-data-table style="${tableStyle}">${children}</table>`};
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
const selectionPlaceholder = '<span data-sk-layout data-sk-leaf style="display:inline-block;width:14px;height:14px;vertical-align:middle"></span>';
const expandPlaceholder = '<span data-sk-layout data-sk-leaf style="display:inline-block;width:7px;height:14px;vertical-align:middle"></span>';

/** Render finite table structure; library-specific sizing is supplied once per table. */
export function table(
  props: Record<string, unknown>,
  slotColumns: readonly TableColumn[],
  text: string,
  hints: SkeletonHints = {},
  masked = true,
  geometry: TableGeometry = plainGeometry,
): Presentation {
  if (masked) return tableOutline(props, slotColumns, hints);
  const { columns: roots, data, glyphs, rows, notes } = tableData(props, slotColumns, hints, masked, geometry);
  const columns:TableColumn[]=[];
  const leaves=(column:TableColumn,depth=0)=>{if(depth>16||columns.length>=256)return;if(column.children?.length)column.children.forEach(child=>leaves(child,depth+1));else columns.push(column)};roots.forEach(column=>leaves(column));
  const width = columns.reduce((sum, column) => sum + (/^\d+px$/.test(column.width) ? parseFloat(column.width) : 120), 0);
  const layout = geometry.layout(columns, width, props);
  const depth=(column:TableColumn,level=0):number=>level>16?1:column.children?.length?1+Math.max(...column.children.map(child=>depth(child,level+1))):1;
  const levels=Math.max(1,...roots.map(column=>depth(column))),headers:string[][]=Array.from({length:levels},()=>[]);
  const leafCount=(column:TableColumn,level=0):number=>level>16?1:column.children?.length?column.children.reduce((sum,child)=>sum+leafCount(child,level+1),0):1;
  const headerCell=(column:TableColumn,level:number)=>{
    const content=column.type==='selection'?selection:column.type==='expand'?'':column.header||escape(column.label)||text;
    headers[level].push(`<th data-sk-layout data-sk-control colspan="${leafCount(column)}" rowspan="${column.children?.length?1:levels-level}" style="padding:${layout.headerPadding};text-align:${column.headerAlign??column.align??'left'};font-weight:500;border-bottom:1px solid #e4e7ed;color:var(--skeleton-control-color,#606266)">${layout.cellOpen}${content}${layout.cellClose}</th>`);
    for(const child of column.children??[])if(level+1<levels)headerCell(child,level+1);
  };roots.forEach(column=>headerCell(column,0));
  const header=headers.map(row=>`<tr data-sk-layout>${row.join('')}</tr>`).join('');
  const body = Array.from({ length: rows }, (_, index) => {
    const row = Array.isArray(data) ? data[index] : glyphs?.[index];
    const cells = columns.map((column,columnIndex) => {
      const span=props.spanMethod?sourceCall(props.spanMethod,[sourceObject({row:row??UNKNOWN,column:UNKNOWN,rowIndex:index,columnIndex})]):undefined;
      if(span===UNKNOWN&&!notes.some(note=>note.startsWith('Cell span callback')))notes.push('Cell span callback depends on opaque or response values; only source-proven index recipes can preserve merged cells.');
      const rowSpan=Array.isArray(span)?span[0]:span&&typeof span==='object'?(span as Record<string,unknown>).rowspan:undefined;
      const colSpan=Array.isArray(span)?span[1]:span&&typeof span==='object'?(span as Record<string,unknown>).colspan:undefined;
      if(rowSpan===0||colSpan===0)return'';
      const spans=`${typeof rowSpan==='number'&&Number.isInteger(rowSpan)&&rowSpan>0?` rowspan="${Math.min(24,rowSpan)}"`:''}${typeof colSpan==='number'&&Number.isInteger(colSpan)&&colSpan>0?` colspan="${Math.min(256,colSpan)}"`:''}`;
      const value = row && typeof row === 'object' && Object.hasOwn(row, column.field) ? (row as Record<string, unknown>)[column.field] : undefined;
      const content = column.type === 'selection' ? masked ? selectionPlaceholder : selection
        : column.type === 'expand' ? masked ? expandPlaceholder : '<span data-sk-layout data-sk-control>›</span>'
        : column.content || (typeof value === 'string' || typeof value === 'number'
          ? escape(value) : text);
      return `<td data-sk-layout${spans} style="padding:${layout.cellPadding};text-align:${column.align ?? 'left'};border-bottom:1px solid #eee">${layout.cellOpen}${content}${layout.cellClose}</td>`;
    }).join('');
    return `<tr data-sk-layout${layout.rowClass ? ` class="${escape(layout.rowClass)}"` : ''}>${cells}</tr>`;
  }).join('');
  const colgroup = layout.columnWidths.map(width => `<col data-sk-layout${width ? ` style="width:${width}"` : ''}>`).join('');
  const empty = `<tr data-sk-layout><td data-sk-layout data-sk-control colspan="${columns.length}" style="padding:24px;text-align:center;color:var(--skeleton-control-color,#909399)">No data</td></tr>`;
  return {
    tag: 'div', className: layout.className,
    style: `min-width:0;max-width:100%;overflow-x:auto;${layout.style}${props.height != null ? 'height:' + dimension(props.height, 'auto') + ';' : ''}${props.maxHeight != null ? 'max-height:' + dimension(props.maxHeight, 'none') + ';' : ''}`,
    children: `<table data-sk-layout data-sk-data-table style="width:${layout.width};min-width:${width}px;border-collapse:collapse;table-layout:fixed"><colgroup data-sk-layout>${colgroup}</colgroup>${props.showHeader === false ? '' : `<thead data-sk-layout${layout.headerClass ? ` class="${escape(layout.headerClass)}"` : ''}>${header}</thead>`}<tbody data-sk-layout>${body || empty}</tbody>${props.showSummary===true?`<tfoot data-sk-layout><tr data-sk-layout>${columns.map(()=>`<td data-sk-layout style="padding:${layout.cellPadding}">${layout.cellOpen}${text}${layout.cellClose}</td>`).join('')}</tr></tfoot>`:''}</table>`,
    notes,
  };
}
