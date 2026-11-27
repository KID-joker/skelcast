import type { SkeletonHints } from '../../types.js';
import type { TableColumn } from './columns.js';
import { dimension, scalar } from './shared.js';
import { table, type TableGeometry } from './table.js';

/** Element Plus owns its selection columns, cell wrappers and flexible-width rules. */
const geometry: TableGeometry = {
  column(props) {
    const special = props.type === 'selection' || props.type === 'expand';
    return {
      width: dimension(props.width ?? props.minWidth, special ? '48px' : '80px'),
      fixed: props.width != null || special,
      type: scalar(props.type),
    };
  },
  layout(columns, width, props) {
    const flexWidth = columns.filter(column => !column.fixed).reduce((sum, column) => sum + (/^\d+px$/.test(column.width) ? parseFloat(column.width) : 0), 0);
    const flexible = columns.every(column => /^\d+px$/.test(column.width)) && flexWidth > 0;
    const fit = props.fit !== false;
    // Resolve spare space against the containing frame, avoiding table sizing cycles.
    const columnWidths = columns.map(column => column.fixed || !fit ? column.width : flexible
      ? `calc(${column.width} + max(0px, 100cqw - ${width}px) * ${parseFloat(column.width) / flexWidth})` : '');
    return {
      className: 'el-table',
      style: `font-size:14px;${flexible && fit ? 'container-type:inline-size;' : ''}`,
      width: fit ? '100%' : `${width}px`, columnWidths,
      headerPadding: '8px 0', cellPadding: '8px 0',
      cellOpen: '<div data-sk-layout class="cell" style="padding:0 12px;line-height:23px;overflow-wrap:break-word">',
      cellClose: '</div>',
    };
  },
};

export function elementTable(props: Record<string, unknown>, columns: readonly TableColumn[], text: string, hints: SkeletonHints = {}, masked = true) {
  return table(props, columns, text, hints, masked, geometry);
}
