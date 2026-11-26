interface StyleEntry { references: number; remove: () => void; last:()=>void }
const styles = new WeakMap<Document | ShadowRoot, Map<string, StyleEntry>>();
interface SharedSheet { sheet: CSSStyleSheet; references: number }
const sheets = new WeakMap<Document, Map<string, SharedSheet>>();

/** Light DOM instances share one style element per document. Shadow roots share
 * constructed sheets when available, with a scoped style-element fallback. */
export function acquireStyle(root: Document | ShadowRoot, css: string, shared=false): () => void {
  const separator='/* skelcast-shared-base */',index=css.indexOf(separator);
  if(index>=0){
    const local=acquireStyle(root,css.slice(0,index)),base=acquireStyle(root,css.slice(index+separator.length),true);
    return()=>{base();local();};
  }
  let cache = styles.get(root);
  if (!cache) styles.set(root, cache = new Map());
  let entry = cache.get(css);
  if (!entry) {
    const document = root instanceof Document ? root : root.ownerDocument;
    const Sheet = document.defaultView?.CSSStyleSheet;
    let remove: (() => void) | undefined,last=()=>{};
    if (root instanceof ShadowRoot && Sheet?.prototype.replaceSync && 'adoptedStyleSheets' in root) {
      let shared = sheets.get(document);
      if (!shared) sheets.set(document, shared = new Map());
      let item = shared.get(css);
      if (!item) {
        const sheet = new Sheet(); sheet.replaceSync(css);
        shared.set(css, item = { sheet, references: 0 });
      }
      item.references++;
      const { sheet } = item;
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      last=()=>{root.adoptedStyleSheets=[...root.adoptedStyleSheets.filter(value=>value!==sheet),sheet];};
      remove = () => {
        root.adoptedStyleSheets = root.adoptedStyleSheets.filter(value => value !== sheet);
        if (--item.references === 0) shared.delete(css);
      };
    } else {
      const style = document.createElement('style');
      style.dataset.skStyle = ''; style.textContent = css;
      if(shared)style.dataset.skShared='';
      (root instanceof Document ? root.head : root).append(style);
      last=()=>{(root instanceof Document?root.head:root).append(style);};
      remove = () => style.remove();
    }
    cache.set(css, entry = { references: 0, remove, last });
  }
  if(shared)entry.last();
  entry.references++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--entry.references === 0) { entry.remove(); cache.delete(css); }
  };
}
