import { forced, getPreview } from './core.js';

/** Share comparison geometry and visibility between React and Vue. Pending
 * boundaries always keep their real loading presentation until content is ready. */
export function boundaryPresentation(id: string, kind: string, pending: boolean) {
  const preview = getPreview();
  const held = forced(id, kind);
  const comparison = held && !pending ? preview.comparison : 'off';
  const skeletonVisible = comparison === 'off' ? pending || held : comparison !== 'switch' || preview.comparisonView === 'skeleton';
  const contentVisible = comparison === 'off' ? !skeletonVisible : comparison !== 'switch' || preview.comparisonView === 'content';
  const rootStyle: Record<string, string | number> = { minWidth: 0 };
  const skeletonStyle: Record<string, string | number> = { display: skeletonVisible ? 'block' : 'none', minWidth: 0 };
  const contentStyle: Record<string, string | number> = { display: contentVisible ? 'block' : 'none', minWidth: 0 };
  if(!contentVisible){
    // Keep the source's intrinsic inline size during pending and preview. The
    // zero-height host precedes the skeleton, preserving its mount position
    // without adding height, leaking margins or removing it from width sizing.
    Object.assign(contentStyle,{display:'flow-root',maxHeight:0,overflow:'clip',visibility:'hidden',pointerEvents:'none'});
  }
  if (comparison === 'side-by-side') {
    Object.assign(rootStyle, { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '16px', alignItems: 'start' });
    Object.assign(contentStyle, { gridColumn: '1', gridRow: '1', overflowX: 'auto' });
    Object.assign(skeletonStyle, { gridColumn: '2', gridRow: '1', overflowX: 'auto' });
  } else if (comparison === 'overlay') {
    Object.assign(rootStyle, { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', isolation: 'isolate' });
    Object.assign(contentStyle, { gridArea: '1 / 1', alignSelf: 'start' });
    Object.assign(skeletonStyle, { gridArea: '1 / 1', alignSelf: 'start', zIndex: 1, opacity: preview.opacity, pointerEvents: 'none' });
  }
  return { comparison, skeletonVisible, contentVisible, rootStyle, skeletonStyle, contentStyle };
}

/** Preserve visibility even when application CSS uses display: block !important. */
export function applyPresentationDisplay(root: HTMLElement, skeleton: HTMLElement, presentation: ReturnType<typeof boundaryPresentation>) {
  root.style.setProperty('display', String(presentation.rootStyle.display ?? ''), presentation.rootStyle.display ? 'important' : '');
  skeleton.style.setProperty('display', String(presentation.skeletonStyle.display), 'important');
  (root.querySelector(':scope > [data-sk-content]') as HTMLElement | null)?.style.setProperty('display', String(presentation.contentStyle.display), 'important');
}
