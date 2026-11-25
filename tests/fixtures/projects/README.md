# Project acceptance fixtures

These runnable, representative projects exercise complete onboarding and browser
verification beyond isolated compiler snippets. They contain no external APIs or
real account data; they are not copies of third-party production repositories.

| Project | Integration coverage | Browser coverage |
| --- | --- | --- |
| `react-admin` | Aliased static lazy routes, query loading guard, CSS Modules, local table component, preserved action controls | Desktop/mobile geometry, intentional horizontal scrolling, filter state, light DOM |
| `vue-workspace` | Aliased static lazy routes, `v-loading`, named/default local slots, scoped Less, prop-based CSS variables | Desktop/mobile geometry, filter state, Shadow DOM |

`tests/browser/acceptance.spec.ts` copies each fixture to a temporary directory,
links the repository's installed dependencies, verifies init dry-run and repeat
runs, builds the app, and invokes `auditBoundaryLayout()` against its real content.
No fixture source or generated outputs are changed in place.

Run the repository development checks from README before the browser suite. To
inspect a fixture interactively, copy it outside `tests/`, install the indicated
framework/Vite dependencies and the local built SkelCast package, then run
`skelcast init`, `skelcast sync`, and Vite.

Unsupported behavior remains covered separately: compiler tests require local
fallbacks for opaque calls/widgets and init tests require diagnostics for dynamic
configuration and unsupported frameworks. The compatibility matrix in the root
README is authoritative about the supported scope.
