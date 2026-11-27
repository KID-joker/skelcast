/** Wire-format marker shared by generation, bundling and runtime style reuse. */
export const sharedStyleSeparator = '/* skelcast-shared-base */';

export const escapeHTML = (value: unknown) => String(value).replace(/[&<>"']/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
