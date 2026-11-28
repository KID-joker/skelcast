import { currentArtifact, getPreview, listBoundaries, setPreview } from './runtime/core.js';

export interface LayoutBox { x: number; y: number; width: number; height: number }
export interface LayoutSnapshot {
  box: LayoutBox;
  visible: boolean;
  /** Horizontal overflow escaping this region, excluding intentional scroll containers. */
  overflowX: number;
  placeholders: number;
  visiblePlaceholders: number;
  /** Visible source IDs and explicit data-sk-anchor nodes, relative to this box.
   * Repeated anchors are paired in DOM order, including inside open shadow roots. */
  anchors?: Record<string, LayoutBox[]>;
  /** Visible native header-bearing tables; row counts are loading capacity. */
  tables?: { columns: number; headerRows: number; outline?: boolean; parent?: number }[];
  /** Component outlines compare their outer box; internal source anchors are intentionally omitted. */
  regions?: { kind: 'table' | 'graphic'; key?: string; outline: boolean; anchors: {key:string;index:number}[] }[];
}
export interface LayoutTolerance { tolerancePx?: number; toleranceRatio?: number; overflowTolerancePx?: number }
export interface LayoutIssue {
  code: 'CONTENT_INVISIBLE' | 'SKELETON_INVISIBLE' | 'PLACEHOLDERS_INVISIBLE' | 'WIDTH_MISMATCH' | 'HEIGHT_MISMATCH' | 'POSITION_MISMATCH' | 'HORIZONTAL_OVERFLOW' | 'ANCHOR_MISSING' | 'ANCHOR_MISMATCH' | 'TABLE_STRUCTURE_MISMATCH';
  message: string;
  anchor?: string;
}
export interface LayoutComparison {
  needsReview: boolean;
  delta: { width: number; height: number; x: number; y: number; followingContentShift: number };
  issues: LayoutIssue[];
  anchors: { compared: number; mismatched: number; missing: number };
}
export interface BoundaryLayoutReport extends LayoutComparison {
  id: string;
  variant: string;
  viewport: { width: number; height: number };
  content: LayoutSnapshot;
  skeleton: LayoutSnapshot;
}

function parentElement(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}
/** Measurements are stable during one synchronous capture, but never across
 * captures: preview, styles and scroll positions may change between them. */
function layoutMeasurements() {
  const measurements = new Map<Element, { box: DOMRect; style: CSSStyleDeclaration }>();
  const visibility = new Map<Element, boolean>();
  const read = (element: Element) => {
    let value = measurements.get(element);
    if (!value) {
      value = { box: element.getBoundingClientRect(), style: getComputedStyle(element) };
      measurements.set(element, value);
    }
    return value;
  };
  const measureVisibility = (element: Element): boolean => {
    const { box } = read(element);
    if (!box.width || !box.height || !element.getClientRects().length) return false;
    let left = box.left, right = box.right, top = box.top, bottom = box.bottom;
    for (let node: Element | null = element; node; node = parentElement(node)) {
      const { box: clip, style } = read(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return false;
      // Ignore viewport clipping, but reject boxes fully clipped by local containers.
      if (node === element || node === element.ownerDocument.scrollingElement) continue;
      if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX)) {
        left = Math.max(left, clip.left); right = Math.min(right, clip.right);
      }
      if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY)) {
        top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
      }
      if (right <= left || bottom <= top) return false;
    }
    return true;
  };
  return {
    read,
    visible(element: Element) {
      if (!visibility.has(element)) visibility.set(element, measureVisibility(element));
      return visibility.get(element)!;
    },
    box(element: Element): LayoutBox {
      const { x, y, width, height } = read(element).box;
      return { x, y, width, height };
    },
  };
}
function descendants(root: Element): Element[] {
  const elements: Element[] = [];
  const visit = (node: Element) => {
    elements.push(node);
    for (const child of node.children) visit(child);
    if (node.shadowRoot) for (const child of node.shadowRoot.children) visit(child);
  };
  visit(root);
  return elements;
}
function layoutBox(element: Element): LayoutBox {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
}
/** Measure rendered geometry, including open Shadow DOM, without viewport clipping. */
export function captureLayout(root: HTMLElement, sourceIds?:ReadonlySet<string>): LayoutSnapshot {
  const measure = layoutMeasurements();
  const elements = descendants(root);
  const placeholders = elements.filter(element => element.matches('[data-sk-leaf], [data-sk-multiline] > span'));
  const { style } = measure.read(root);
  const containsOverflow = ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX);
  const box = measure.box(root);
  const anchors: Record<string, LayoutBox[]> = Object.create(null);
  const tableNodes=elements.filter((node):node is HTMLTableElement=>node.tagName==='TABLE'&&!!(node as HTMLTableElement).tHead&&measure.visible(node)&&measure.visible((node as HTMLTableElement).tHead!));
  const tables=tableNodes.map(table=>{
    const occupied:number[]=[],rows=[...table.tHead!.rows];let columns=0;
    rows.forEach((row,index)=>{
      let column=0;
      for(const cell of row.cells){
        if(cell.getAttribute('aria-hidden')==='true'||['presentation','none'].includes(cell.getAttribute('role')??'')||measure.read(cell).style.display==='none'||measure.read(cell).box.width===0)continue;
        while((occupied[column]??0)>index)column++;
        const span=Math.min(256,Math.max(1,cell.colSpan));
        for(let offset=0;offset<span;offset++)occupied[column+offset]=index+Math.min(256,Math.max(1,cell.rowSpan));
        column+=span;columns=Math.max(columns,column);
      }
    });
    const parent=tableNodes.indexOf(table.parentElement?.closest('table') as HTMLTableElement);
    return{columns,headerRows:rows.length,...(table.hasAttribute('data-sk-outline')?{outline:true}:{}),...(parent>=0?{parent}:{})};
  });
  const anchorKey=(element:Element)=>{
    const explicit=element.getAttribute('data-sk-anchor');
    const id=element.getAttribute('data-sk-source-id')??element.id;
    return explicit?`anchor:${explicit}`:id&&(!sourceIds||sourceIds.has(id))?`id:${id}`:undefined;
  };
  const regionSelector='table,svg,canvas,[data-sk-outline]';
  const anchorOrdinals=new Map<Element,{key:string;index:number}>();
  for (const element of elements) {
    // Only the visible branch of nested boundaries participates. Skipping the
    // entire boundary would lose anchors that exist in the page artifact.
    const explicit = element.getAttribute('data-sk-anchor');
    const id = element.getAttribute('data-sk-source-id') ?? element.id;
    const key = explicit ? `anchor:${explicit}` : id&&(!sourceIds||sourceIds.has(id)) ? `id:${id}` : undefined;
    if (!key || !measure.visible(element)) continue;
    const child = measure.box(element);
    anchorOrdinals.set(element,{key,index:anchors[key]?.length??0});
    (anchors[key] ??= []).push({ ...child, x: child.x - box.x, y: child.y - box.y });
  }
  const regions=elements.filter(element=>element.matches(regionSelector)&&measure.visible(element)&&!element.parentElement?.closest(regionSelector)).map(element=>({
    kind:(element.tagName==='TABLE'||element.querySelector('table')?'table':'graphic') as 'table'|'graphic',
    key:anchorKey(element),outline:element.hasAttribute('data-sk-outline'),
    anchors:descendants(element).slice(1).flatMap(child=>{const anchor=anchorOrdinals.get(child);return anchor?[anchor]:[];}),
  }));
  return {
    box, visible: measure.visible(root), anchors, tables, regions,
    overflowX: containsOverflow ? 0 : Math.max(0, root.scrollWidth - root.clientWidth),
    placeholders: placeholders.length,
    visiblePlaceholders: placeholders.filter(element => {
      if (!measure.visible(element)) return false;
      const { style } = measure.read(element);
      return style.backgroundImage !== 'none' || !['transparent', 'rgba(0, 0, 0, 0)'].includes(style.backgroundColor);
    }).length,
  };
}

function threshold(value: number | undefined, fallback: number): number {
  if (value == null) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new Error('Layout tolerances must be finite nonnegative numbers');
  return value;
}
/** Compare geometry snapshots; this reports displacement in pixels, not a CLS score. */
export function compareLayouts(content: LayoutSnapshot, skeleton: LayoutSnapshot, options: LayoutTolerance = {}): LayoutComparison {
  const pixels = threshold(options.tolerancePx, 4);
  const ratio = threshold(options.toleranceRatio, 0.05);
  const overflow = threshold(options.overflowTolerancePx, 1);
  const delta = {
    width: skeleton.box.width - content.box.width,
    height: skeleton.box.height - content.box.height,
    x: skeleton.box.x - content.box.x,
    y: skeleton.box.y - content.box.y,
    followingContentShift: skeleton.box.y + skeleton.box.height - content.box.y - content.box.height,
  };
  const issues: LayoutIssue[] = [];
  const add = (code: LayoutIssue['code'], message: string) => issues.push({ code, message });
  if (!content.visible) add('CONTENT_INVISIBLE', 'Real content has no visible layout box; compare after data is ready and the region is shown');
  if (!skeleton.visible) add('SKELETON_INVISIBLE', 'Skeleton has no visible layout box');
  if (skeleton.placeholders > 0 && skeleton.visiblePlaceholders === 0) add('PLACEHOLDERS_INVISIBLE', 'No data placeholders have a visible painted box');
  if (Math.abs(delta.width) > pixels + content.box.width * ratio) add('WIDTH_MISMATCH', `Skeleton width differs by ${delta.width.toFixed(1)}px`);
  if (Math.abs(delta.height) > pixels + content.box.height * ratio) add('HEIGHT_MISMATCH', `Skeleton height differs by ${delta.height.toFixed(1)}px`);
  if (Math.abs(delta.x) > pixels || Math.abs(delta.y) > pixels) add('POSITION_MISMATCH', `Skeleton origin differs by ${delta.x.toFixed(1)}px horizontally and ${delta.y.toFixed(1)}px vertically`);
  if (skeleton.overflowX > content.overflowX+overflow) add('HORIZONTAL_OVERFLOW', `Skeleton has ${(skeleton.overflowX-content.overflowX).toFixed(1)}px of additional uncontained horizontal overflow (source: ${content.overflowX.toFixed(1)}px)`);
  if(content.tables&&skeleton.tables){
    const realTables=content.tables,generatedTables=skeleton.tables;
    const children=(tables:NonNullable<LayoutSnapshot['tables']>,parent?:number)=>tables.flatMap((table,index)=>table.parent===parent?[{table,index}]:[]);
    const compare=(realParent?:number,generatedParent?:number,depth=0)=>{
      if(depth>16)return;
      const real=children(realTables,realParent),generated=children(generatedTables,generatedParent);
      if(real.length!==generated.length)add('TABLE_STRUCTURE_MISMATCH',`${real.length} real header-bearing tables, ${generated.length} skeleton tables`);
      for(let index=0;index<Math.min(real.length,generated.length);index++){
        const a=real[index],b=generated[index];
        if(b.table.outline)continue;
        if(a.table.columns!==b.table.columns||a.table.headerRows!==b.table.headerRows)add('TABLE_STRUCTURE_MISMATCH',`Table ${a.index+1}: ${a.table.columns} real columns/${a.table.headerRows} header rows, ${b.table.columns} skeleton columns/${b.table.headerRows} header rows`);
        compare(a.index,b.index,depth+1);
      }
    };
    compare();
  }
  const anchors = { compared: 0, mismatched: 0, missing: 0 };
  const ignored=new Map<string,Set<number>>(),ignoredGenerated=new Map<string,Set<number>>();
  const ignore=(target:Map<string,Set<number>>,items:{key:string;index:number}[])=>{for(const{key,index}of items){if(!target.has(key))target.set(key,new Set());target.get(key)!.add(index);}};
  for(const kind of ['table','graphic'] as const){
    const real=content.regions?.filter(region=>region.kind===kind)??[];
    const generated=skeleton.regions?.filter(region=>region.kind===kind)??[];
    // Do not hide missing-region regressions by guessing across unmatched lists.
    if(real.length!==generated.length)continue;
    for(let index=0;index<real.length;index++){
      const source=real[index],outline=generated[index];
      if(outline.outline&&(!source.key&&!outline.key||source.key===outline.key)){ignore(ignored,source.anchors);ignore(ignoredGenerated,outline.anchors);}
    }
  }
  for (const key of new Set([...Object.keys(content.anchors ?? {}), ...Object.keys(skeleton.anchors ?? {})])) {
    const real = (content.anchors?.[key] ?? []).filter((_,index)=>!ignored.get(key)?.has(index));
    const generated = (skeleton.anchors?.[key] ?? []).filter((_,index)=>!ignoredGenerated.get(key)?.has(index));
    if (real.length !== generated.length) {
      anchors.missing += Math.abs(real.length - generated.length);
      issues.push({ code: 'ANCHOR_MISSING', anchor: key, message: `${key}: ${real.length} real nodes, ${generated.length} skeleton nodes` });
    }
    for (let index = 0; index < Math.min(real.length, generated.length); index++) {
      anchors.compared++;
      const a = real[index], b = generated[index];
      if (Math.abs(a.x - b.x) > pixels || Math.abs(a.y - b.y) > pixels || Math.abs(a.width - b.width) > pixels + a.width * ratio || Math.abs(a.height - b.height) > pixels + a.height * ratio) {
        anchors.mismatched++;
        issues.push({ code: 'ANCHOR_MISMATCH', anchor: key, message: `${key}[${index}]: x Δ ${(b.x - a.x).toFixed(1)}px, y Δ ${(b.y - a.y).toFixed(1)}px, width Δ ${(b.width - a.width).toFixed(1)}px, height Δ ${(b.height - a.height).toFixed(1)}px` });
      }
    }
  }
  return { needsReview: issues.length > 0, delta, issues, anchors };
}

function captureBoundaryHost(host: HTMLElement, boundary: HTMLElement, sourceIds?:ReadonlySet<string>): LayoutSnapshot {
  const snapshot = captureLayout(host,sourceIds);
  const box = layoutBox(boundary);
  for (const anchors of Object.values(snapshot.anchors ?? {})) for (const anchor of anchors) {
    anchor.x += snapshot.box.x - box.x;
    anchor.y += snapshot.box.y - box.y;
  }
  snapshot.box = box;
  return snapshot;
}

let auditInProgress = false;
const nextLayout = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/** Development/acceptance check against mounted, ready application content.
 * Temporarily selects real content and one skeleton variant, then restores preview.
 * Wait for application fonts, images and transitions before calling this function.
 */
export async function auditBoundaryLayout(element: HTMLElement, options: LayoutTolerance & { variant?: string; capture?: (phase: 'content' | 'skeleton') => Promise<void> } = {}): Promise<BoundaryLayoutReport> {
  if (auditInProgress) throw new Error('A layout check is already running');
  const boundary = listBoundaries().find(boundary => boundary.element === element);
  if (!boundary) throw new Error('Select a mounted SkelCast boundary');
  if (boundary.pending) throw new Error('Wait for real loading to finish before checking layout');
  const artifact = currentArtifact(boundary.artifact);
  const original = getPreview();
  let variant = options.variant ?? (original.target === boundary.id || original.target === 'page' && boundary.kind === 'page' ? original.variant : undefined) ?? boundary.variant ?? artifact.defaultVariant;
  if (!Object.hasOwn(artifact.variants, variant)) throw new Error(`Unknown variant: ${variant}`);
  const selected = boundary.context && artifact.contexts?.[boundary.context]?.[variant];
  if (selected) variant = selected;
  const ids=artifact.variants[variant].sourceIds,sourceIds=ids?new Set(ids):undefined;
  const window = element.ownerDocument.defaultView!;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const scroll = { x: window.scrollX, y: window.scrollY };
  const focused = element.ownerDocument.activeElement;
  let owned = original;
  const select = (target: string | null, variant?: string) => {
    setPreview({ target, variant, comparison: 'off' });
    owned = getPreview();
  };
  const ensureStable = () => {
    const current = listBoundaries().find(item => item.element === element);
    if (!element.isConnected || !current || current.pending || current.id !== boundary.id || current.variant !== boundary.variant || current.context !== boundary.context) throw new Error('Loading region changed during layout check; retry when ready');
    const latest = currentArtifact(current.artifact), view = latest.variants[variant], previous = artifact.variants[variant];
    // Metadata-only dev refreshes can replace the object without changing the
    // rendered layout. Abort only when presentation or region state changes.
    if (latest.render !== artifact.render || latest.kind !== artifact.kind || !view || view.html !== previous.html || view.css !== previous.css) throw new Error('Loading region changed during layout check; retry when ready');
    if (window.innerWidth !== viewport.width || window.innerHeight !== viewport.height) throw new Error('Viewport changed during layout check; retry');
    if (getPreview() !== owned) throw new Error('Preview changed during layout check; retry');
  };
  auditInProgress = true;
  try {
    select(null);
    await nextLayout();
    ensureStable();
    const contentHost = [...element.children].find((child): child is HTMLElement => child instanceof HTMLElement && child.hasAttribute('data-sk-content'));
    const skeletonHost = [...element.children].find(child=>child.hasAttribute('data-sk-skeleton')) ?? contentHost?.previousElementSibling;
    if (!contentHost || !(skeletonHost instanceof HTMLElement)) throw new Error('Loading region has no supported content and skeleton hosts');
    const content = captureBoundaryHost(contentHost, element,sourceIds);
    if (!content.visible) throw new Error('Real content is hidden by an ancestor; show the region before checking layout');
    await options.capture?.('content');
    ensureStable();
    select(boundary.id, variant);
    await nextLayout();
    ensureStable();
    const skeleton = captureBoundaryHost(skeletonHost, element,sourceIds);
    await options.capture?.('skeleton');
    ensureStable();
    return { id: boundary.id, variant, viewport, content, skeleton, ...compareLayouts(content, skeleton, options) };
  } finally {
    // A user-selected preview takes precedence over our temporary selection.
    if (getPreview() === owned) {
      setPreview(original);
      await nextLayout();
      window.scrollTo(scroll.x, scroll.y);
      if (focused instanceof HTMLElement && focused.isConnected && element.contains(focused)) focused.focus({ preventScroll: true });
    }
    auditInProgress = false;
  }
}
