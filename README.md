# SkelCast

**Source-derived skeleton screens for AI coding agents.**

Your code, cast as a skeleton. SkelCast analyzes React and Vue source, generates static HTML and CSS during development, and connects the result to your existing loading states. It does not run your application, call its APIs, or require a signed-in session to generate skeletons.

- **Source stays authoritative.** Preserve layout rules and replace content with placeholders, without maintaining a second page schema.
- **React and Vue 3.** Share static artifacts through thin framework adapters, with light DOM and optional Shadow DOM rendering.
- **Automatic onboarding.** Discover pages and explicit loading regions in existing Vite projects with `skelcast init`.
- **Incremental generation.** Reuse unchanged artifacts and invalidate them when their source, styles, dependencies, hints, or generator changes.
- **Inspectable results.** Preview real and forced loading states, inspect source locations, adjust hints, and review visible fallbacks.

The browser renders generated artifacts. Source analysis and layout decisions happen during development, not at runtime.

## Try the demos

Requires Node.js 22.12+ and pnpm 11.17.0, pinned in `packageManager`.

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run sync
pnpm run dev:react
# In another terminal:
pnpm run dev:vue
```

- [React demo](http://localhost:5173/)
- [Vue demo](http://localhost:5174/)

Choose **Enter demo workspace** to use the local sign-in simulation. No account is required. **Refresh assets** triggers the delayed demo API so you can observe normal request loading. Use browser DevTools to inspect responsive layouts.

The demo API runs in Vite development middleware. Production demo builds verify integration; replace the API with your backend before deploying a working application.

## Add SkelCast to an existing project

SkelCast has not been published to npm yet. Build this repository, then install it as a local dependency or use it as a workspace package:

```bash
pnpm add -D /absolute/path/to/skelcast
```

### Automatic integration

Run this in a Vite + React or Vue 3 project that already has SkelCast installed:

```bash
pnpm exec skelcast init
```

The command scans existing source, discovers pages and explicit loading regions, creates `skelcast.config.mjs`, integrates loading boundaries and the Vite plugin, adds virtual module types, and generates skeleton artifacts. It does not execute application, router, Vite, or existing SkelCast configuration modules.

To inspect the exact changes without writing files, or target another project:

```bash
pnpm exec skelcast init --dry-run --json
pnpm exec skelcast init --root /absolute/path/to/app
```

The dry-run JSON includes targets, diagnostics, and the before/after content of each proposed file change.

| Source pattern | Integration |
| --- | --- |
| `pages/`, `views/`, `*Page`, or `App` when no page directories exist | Page-level boundaries |
| Static routes, relative/aliased imports, static lazy imports, nested and index routes | Page-to-route associations |
| React `loading ? <Spinner /> : <Content />` | Replace the placeholder while preserving data guards |
| React `if (loading) return <Spinner />` | Preserve early-return evaluation order |
| Data and pending from the same query declaration, followed by a data list | Connect that list to the existing pending state |
| JSX `loading={flag}`, Vue `v-loading` and `:loading` | Connect explicit loading regions, excluding small controls such as buttons |
| Vue `v-if/v-else` loading branches | Preserve content guards; support script setup and regular Options API registration |
| Simple tsconfig/jsconfig paths, static Vite aliases, entry-point CSS | Include layout dependencies in generation |

`withSkelCast()` wraps an existing Vite default export while preserving its plugins, server settings, and synchronous or asynchronous configuration factory. A generated target's `region` refers to the artifact import binding in the original source file; no duplicate page component is required.

Repeated runs preserve already integrated components instead of adding nested boundaries. New targets are appended to existing static configuration while retaining manual targets and comments. Originals are saved under `.skelcast/init-backups/`; the change list and diagnostics are written to `.skelcast/init-report.json`. A generation failure rolls back this run's source, configuration, and artifact changes.

Ambiguous loading relationships are left intact and reported. Routes inferred from file locations have a `ROUTE_CONVENTION` diagnostic and should be checked against the router. Dynamic configurations or Vite roots, Vue 2, Next/Nuxt, other bundlers, complex conditional chains, and boundaries inside table rows require explicit adapters. Init reports these cases instead of claiming they are integrated. Ask your coding agent to add newly introduced regions in already integrated components; use `sync` to update their artifacts.

### Manual configuration

Create `skelcast.config.mjs` in the project root:

```js
export default {
  targets: [
    {
      id: 'products.page',
      source: 'src/ProductsPage.tsx', // Use .vue for a Vue SFC.
      kind: 'page',
      route: '/',
      hints: { repeat: 6 },
    },
    {
      id: 'products.list',
      source: 'src/ProductGrid.tsx',
      kind: 'request',
      render: 'light', // Or 'shadow' for a self-contained style context.
      hints: { repeat: 6, lines: 2, minHeight: 96 },
      variants: {
        grid: { bindings: { mode: 'grid' } },
        list: { bindings: { mode: 'list' } },
      },
      defaultVariant: 'grid',
      // styles: ['src/theme.css'],
      // adapters: { VendorChart: 'src/skeletons/ChartSkeleton.tsx' },
    },
  ],
};
```

Point `source` at a presentation component when possible. `export` selects a named React component; the default is its default export. Adapters are also statically analyzed presentation components.

Use `bindings` to resolve expressions that affect branches, classes, or dimensions, such as `{ 'data.mode': 'grid' }`. The analyzer supports bounded expressions, aliases, destructuring, component props, React children, and Vue default/named slots. It never invokes arbitrary business functions or requests. Runtime slot parameters, render props, and complex helper functions need explicit hints or adapters.

Ordinary `sync` commands load the trusted development configuration as executable code; application source is parsed only. Do not import the application entry point from the configuration.

### Generate and inspect

```bash
pnpm exec skelcast sync
pnpm exec skelcast inspect --id products.list --json
pnpm exec skelcast check
```

Commit `.skelcast/*.mjs`, its manifest, and `skelcast.hints.json` alongside your source. The manifest records dependency fingerprints and artifact paths, not a second layout tree. Unchanged inputs reuse existing outputs. `check` exits with a nonzero status for stale, missing, or modified artifacts and can run in CI.

Opaque components and unknown render calls produce local fallback blocks with source diagnostics. Feed `inspect` output to your coding agent to refine hints or adapters before regenerating.

### Register the Vite plugin

```ts
import { defineConfig } from 'vite';
import { skelcastPlugin } from 'skelcast/vite';

export default defineConfig({
  plugins: [/* react() or vue() */, skelcastPlugin()],
});
```

Add the virtual module declaration to your project's `env.d.ts`:

```ts
/// <reference types="skelcast/virtual" />
```

The development plugin injects the preview toolbar and consumes existing artifacts. Source edits mark artifacts out of date. The CLI, your coding agent, or **Sync artifacts** performs deterministic regeneration. Production builds require current artifacts and exclude the toolbar, development endpoints, and URL preview controls.

### Connect real loading state

React:

```tsx
import { LoadingBoundary } from 'skelcast/react';
import skeleton from 'virtual:skelcast/products.list';

<LoadingBoundary artifact={skeleton} pending={isInitialLoading} variant={mode}>
  {data && <ProductGrid items={data.items} mode={mode} />}
</LoadingBoundary>
```

Vue:

```vue
<script setup>
import { LoadingBoundary } from 'skelcast/vue';
import skeleton from 'virtual:skelcast/products.list';
</script>

<template>
  <LoadingBoundary :artifact="skeleton" :pending="pending" :variant="mode">
    <ProductGrid v-if="data" :items="data.items" :mode="mode" />
  </LoadingBoundary>
</template>
```

Boundaries preserve mounted content when switching forced preview, so form state is retained. Application code must still guard data that has not arrived. Initial requests, background refreshes, errors, and retries remain under your application's control; SkelCast does not intercept `fetch`.

Exiting preview resumes the real loading state. Hidden content is inert, `aria-busy` reflects real pending state, and skeletons are hidden from assistive technology.

### Show a skeleton before application JavaScript

A matching `kind: 'page'` target is injected into the initial HTML. A mounted page boundary takes over. If you do not use a page boundary, release the initial skeleton at an explicit application readiness point:

```ts
import { releasePageSkeleton } from 'skelcast/runtime';
releasePageSkeleton();
```

Use application readiness rather than `window.load` or global network-idle heuristics. The Vite integration matches explicit paths, `:param`, `*`, and route arrays. Development requests are matched individually; production HTML is generated per HTML entry, so a single-file static SPA needs additional shell selection for multiple direct-entry routes. Next/Nuxt need framework adapters; generic request-level SSR hydration is not implemented.

If a sign-in gate shares the same URL as the application, call `releasePageSkeleton({ preview: false })` when that gate is ready, then restore the default call after sign-in. Page-boundary preview continues to work normally.

## Preview and refine

Open your normal local application, sign in if needed, and use its real routes. Add a query parameter to hold a skeleton:

```text
/products?__sk=page
/products?__sk=products.list
/products?__sk=products.list&__sk_variant=list
```

The toolbar provides **Follow loading**, **Hold page**, **Hold region**, variant selection, playback, region picking, link copying, source navigation, diagnostics, fallback highlighting, and hint editing. Use DevTools device emulation for viewport testing.

Saved hints go to `skelcast.hints.json`:

```json
{
  "products.list": {
    "repeat": 4,
    "lines": 2,
    "minHeight": 120,
    "bindings": { "data.mode": "grid" }
  }
}
```

Hints describe only differences the source cannot determine. Supported ranges: `repeat` 1–24, `lines` 1–8, `minHeight` 16–2000. Edit layout structure in application source, and use adapters for complex local components. Explicit variant hints take precedence over shared hints.

See the [coding agent skill](skills/skelcast/SKILL.md) for the generation and integration workflow.

## Supported scope

- React function components with JSX/TSX; Vue 3 SFC templates and script setup.
- Plain CSS, CSS Modules, Vue scoped CSS, CSS imports, media and container queries.
- Local components, simple prefix aliases, bounded conditions and repetition, static classes/styles, source locations, and visible fallbacks.
- Static light DOM or Shadow DOM rendering, without generating from screenshots or authenticated sessions.

Full type-system inference, arbitrary function evaluation, runtime CSS-in-JS, Sass/Less/Pug compilation, arbitrary dynamic components, Canvas, and complete third-party design-system adapters are not included. Dynamic aliases and complex path mappings need manual configuration. Vue Options API dynamic values need bindings or adapters. Review ancestor-dependent styles, intrinsic asset dimensions, and complex scoped slots in the real page.

Boundaries use block containers. Place them around suitable block regions rather than directly inside table rows or layouts that require specific direct children. Shadow DOM isolates selectors but still needs a known style context; choose light DOM when application ancestor selectors are essential.

## Development

```bash
pnpm run typecheck
pnpm test
pnpm run build
pnpm run sync
pnpm run check
pnpm run build:examples
pnpm exec playwright install chromium
pnpm run test:browser
```

Tests cover static generation without executing business code, dependency invalidation, source transformations and rollback, and real browser loading/preview behavior for both frameworks.
