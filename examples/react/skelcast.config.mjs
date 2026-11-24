export default {
  targets: [
    { id: 'products.page', source: 'src/CatalogPage.tsx', kind: 'page', route: '/', hints: { repeat: 6, bindings: { mode: 'grid' } } },
    { id: 'products.list', source: 'src/ProductGrid.tsx', kind: 'request', render: 'shadow', hints: { repeat: 6 }, variants: { grid: { bindings: { mode: 'grid' } }, list: { bindings: { mode: 'list' } } }, defaultVariant: 'grid' },
  ],
};
