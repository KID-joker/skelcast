export interface TableColumn {
  label: string;
  field: string;
  width: string;
  fixed?: boolean;
  content?: string;
  type?: string;
  align?: string;
  headerAlign?: string;
}

/** Keep column data structured. References follow the rendered children, so
 * discarded slots and columns consumed by nested tables cannot leak out. */
export class TableColumns {
  private values: TableColumn[] = [];

  register(column: TableColumn): string {
    return `<!--skelcast-column:${this.values.push(column) - 1}-->`;
  }

  resolve(children: string): TableColumn[] {
    return [...children.matchAll(/<!--skelcast-column:(\d+)-->/g)].flatMap(match => {
      const column = this.values[Number(match[1])];
      return column ? [column] : [];
    });
  }
}
