const paths = {
  layers: '<path d="m3 7 9-4 9 4-9 4-9-4Z"/><path d="m3 12 9 4 9-4M3 17l9 4 9-4"/>',
  region: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9h16M9 9v11"/>',
  compare: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16M6 9h3m6 6h3"/>',
} as const;

export function icon(name: keyof typeof paths): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
