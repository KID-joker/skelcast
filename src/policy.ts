/** Explicit presentation policy. Names alone never identify a widget. */
export type ComponentPolicy = 'live' | 'graphic';
export function enabledMarker(value: unknown): boolean { return value === true || value === '' || value === 'true'; }
export function liveElement(props: Record<string,unknown>): boolean {
  const editable=props.contentEditable??props.contenteditable;
  return enabledMarker(props['data-sk-live'])||enabledMarker(editable)||editable==='plaintext-only';
}
export function configuredPolicy(policies:Record<string,ComponentPolicy>|undefined,tag:string):ComponentPolicy|undefined{
  const normalize=(name:string)=>name.replace(/-/g,'').toLowerCase();
  return Object.entries(policies??{}).find(([name])=>normalize(name)===normalize(tag))?.[1];
}

export function importedPolicy(request: string, exported: string): ComponentPolicy | undefined {
  if (request === '@monaco-editor/react' && ['default', 'Editor', 'DiffEditor'].includes(exported)
    || request === '@tinymce/tinymce-react' && exported === 'Editor'
    || ['@tiptap/react', '@tiptap/vue-3'].includes(request) && exported === 'EditorContent') return 'live';
  if (request === 'vue-echarts' && exported === 'default'
    || request === 'echarts-for-react' && exported === 'default') return 'graphic';
}
