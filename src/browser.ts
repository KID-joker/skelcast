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
}
export interface LayoutTolerance { tolerancePx?: number; toleranceRatio?: number; overflowTolerancePx?: number }
export interface LayoutIssue {
  code: 'CONTENT_INVISIBLE' | 'SKELETON_INVISIBLE' | 'PLACEHOLDERS_INVISIBLE' | 'WIDTH_MISMATCH' | 'HEIGHT_MISMATCH' | 'POSITION_MISMATCH' | 'HORIZONTAL_OVERFLOW' | 'ANCHOR_MISSING' | 'ANCHOR_MISMATCH';
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
function visible(element: Element): boolean {
  const box = element.getBoundingClientRect();
  if (!box.width || !box.height || !element.getClientRects().length) return false;
  let left = box.left, right = box.right, top = box.top, bottom = box.bottom;
  for (let node: Element | null = element; node; node = parentElement(node)) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return false;
    // Ignore viewport clipping, but reject boxes fully clipped by local containers.
    if (node === element || node === element.ownerDocument.scrollingElement) continue;
    const clip = node.getBoundingClientRect();
    if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX)) {
      left = Math.max(left, clip.left); right = Math.min(right, clip.right);
    }
    if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY)) {
      top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
    }
    if (right <= left || bottom <= top) return false;
  }
  return true;
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
function paintedPlaceholder(element: Element): boolean {
  if (!visible(element)) return false;
  const style = getComputedStyle(element);
  return style.backgroundImage !== 'none' || !['transparent', 'rgba(0, 0, 0, 0)'].includes(style.backgroundColor);
}

/** Measure rendered geometry, including open Shadow DOM, without viewport clipping. */
export function captureLayout(root: HTMLElement): LayoutSnapshot {
  const elements = descendants(root);
  const placeholders = elements.filter(element => element.matches('[data-sk-leaf], [data-sk-multiline] > span'));
  const style = getComputedStyle(root);
  const containsOverflow = ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX);
  const box = layoutBox(root);
  const anchors: Record<string, LayoutBox[]> = Object.create(null);
  for (const element of elements) {
    // Only the visible branch of nested boundaries participates. Skipping the
    // entire boundary would lose anchors that exist in the page artifact.
    if (!visible(element)) continue;
    const explicit = element.getAttribute('data-sk-anchor');
    const id = element.getAttribute('data-sk-source-id') ?? element.id;
    const key = explicit ? `anchor:${explicit}` : id ? `id:${id}` : undefined;
    if (!key) continue;
    const child = layoutBox(element);
    (anchors[key] ??= []).push({ ...child, x: child.x - box.x, y: child.y - box.y });
  }
  return {
    box, visible: visible(root), anchors,
    overflowX: containsOverflow ? 0 : Math.max(0, root.scrollWidth - root.clientWidth),
    placeholders: placeholders.length,
    visiblePlaceholders: placeholders.filter(paintedPlaceholder).length,
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
  if (skeleton.overflowX > overflow) add('HORIZONTAL_OVERFLOW', `Skeleton has ${skeleton.overflowX.toFixed(1)}px of uncontained horizontal overflow`);
  const anchors = { compared: 0, mismatched: 0, missing: 0 };
  for (const key of new Set([...Object.keys(content.anchors ?? {}), ...Object.keys(skeleton.anchors ?? {})])) {
    const real = content.anchors?.[key] ?? [], generated = skeleton.anchors?.[key] ?? [];
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

function captureBoundaryHost(host: HTMLElement, boundary: HTMLElement): LayoutSnapshot {
  const snapshot = captureLayout(host);
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
  const variant = options.variant ?? (original.target === boundary.id || original.target === 'page' && boundary.kind === 'page' ? original.variant : undefined) ?? boundary.variant ?? artifact.defaultVariant;
  if (!Object.hasOwn(artifact.variants, variant)) throw new Error(`Unknown variant: ${variant}`);
  const window = element.ownerDocument.defaultView!;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const scroll = { x: window.scrollX, y: window.scrollY };
  const focused = element.ownerDocument.activeElement;
  let owned = original;
  const select = (target: string | null, variant?: string) => {
    setPreview({ target, variant });
    owned = getPreview();
  };
  const ensureStable = () => {
    const current = listBoundaries().find(item => item.element === element);
    if (!element.isConnected || !current || current.pending || current.id !== boundary.id || current.variant !== boundary.variant) throw new Error('Loading region changed during layout check; retry when ready');
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
    const skeletonHost = contentHost?.previousElementSibling;
    if (!contentHost || !(skeletonHost instanceof HTMLElement)) throw new Error('Loading region has no supported content and skeleton hosts');
    const content = captureBoundaryHost(contentHost, element);
    if (!content.visible) throw new Error('Real content is hidden by an ancestor; show the region before checking layout');
    await options.capture?.('content');
    ensureStable();
    select(boundary.id, variant);
    await nextLayout();
    ensureStable();
    const skeleton = captureBoundaryHost(skeletonHost, element);
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
