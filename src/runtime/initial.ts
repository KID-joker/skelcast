import type { SkeletonView } from '../types.js';

/** Read before application code runs; the module holding this snapshot outlives the shell. */
export function captureInitialView(id: string): SkeletonView & { baseCSS: string } {
  const shell = typeof document === 'undefined' ? undefined : [...document.querySelectorAll<HTMLElement>('[data-sk-initial]')].find(node => node.dataset.skInitial === id);
  const root = shell?.shadowRoot ?? shell?.querySelector<HTMLTemplateElement>('template[shadowrootmode]')?.content ?? shell;
  const element = root && [...root.children].find(node => node.getAttribute('data-sk-artifact') === id);
  const local = root?.querySelector<HTMLStyleElement>('style[data-sk-initial-style]');
  const base = root?.querySelector<HTMLStyleElement>('style[data-sk-initial-base]');
  if (!element || !local) throw new Error(`Missing initial skeleton ${id}. Preserve the generated shell until modules run, or use skelcastPlugin({ reuseInitial: false }).`);
  const baseCSS = base?.textContent ?? '';
  return { html: element.outerHTML, css: (local.textContent ?? '') + (base ? '/* skelcast-shared-base */' + baseCSS : ''), baseCSS };
}
