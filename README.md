# SkelCast

**Source-derived skeleton screens for AI coding agents.**

Your code, cast as a skeleton. SkelCast analyzes React and Vue source, generates static HTML and CSS during development, and connects the result to your existing loading states. It does not run your application, call its APIs, or require a signed-in session to generate skeletons.

- **Source stays authoritative.** Preserve layout rules and replace content with placeholders, without maintaining a second page schema.
- **React and Vue 3.** Share static artifacts through thin framework adapters, with light DOM and optional Shadow DOM rendering.
- **Automatic onboarding.** Discover pages and explicit loading regions in existing Vite projects with `skelcast init`.
- **Incremental generation.** Reuse unchanged artifacts and invalidate them when their source, styles, dependencies, hints, or generator changes.
- **Preview and agent refinement.** Developers compare real content and skeletons; coding agents diagnose source locations, refine hints/adapters, and verify repairs through the CLI.

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
| Returned Vue composable operation awaits its API input and assigns an exposed reactive array | Add scoped pending state with concurrency-safe `try/finally`, then connect source-proved data consumers |
| Simple tsconfig/jsconfig paths, static Vite aliases, entry-point stylesheets | Include CSS, Sass and other supported layout dependencies in generation |

`withSkelCast()` wraps an existing Vite default export while preserving its plugins, server settings, and synchronous or asynchronous configuration factory. A generated target's `region` refers to the artifact import binding in the original source file; no duplicate page component is required.

New page boundaries without a proven pending relationship start in preview-only mode (`pending=false`) and report `PAGE_PREVIEW_ONLY`. Request instrumentation requires one unambiguous returned async operation and an exposed collection; explicit return types and ambiguous ownership are left for manual integration. No global request interceptor is added.

Init resolves immutable Vite root aliases, including `process.cwd()`, from syntax. For explicit ESM TypeScript configurations with legacy Node/Classic resolution, it updates resolution to `Bundler`, retaining comments. `withSkelCast` preserves the caller's Vite configuration types across supported Vite versions.

Reusable Vue request components receive finite `data-sk-context` identifiers at
source call sites. Init records each caller under the request target's `contexts`
and connects the inner boundary's `context` prop. The compiler traverses the caller
and extracts only the selected request region, retaining props and scoped slots.
Runtime selects a precompiled context/state view; it never reads response data to
invent markup. Repeated calls inside loops and dynamic component identities remain
explicit diagnostics. Manual contexts use `{ contexts: { key: { source: 'Page.vue' } } }`
and a matching `data-sk-context="key"` on that source call.

Repeated runs preserve existing boundaries and scan their components for newly added loading regions. Already managed guards and loading attributes are not wrapped again; new regions receive separate targets while existing IDs, hints and manual boundaries remain intact. Adapter import aliases and Vue Options API boundary registrations are reused. New targets are appended to existing static configuration while retaining manual targets and comments. Originals are saved under `.skelcast/init-backups/`; the change list and diagnostics are written to `.skelcast/init-report.json`. A generation failure rolls back this run's source, configuration, and artifact changes.

Ambiguous loading relationships are left intact and reported. Routes inferred from file locations have a `ROUTE_CONVENTION` diagnostic and should be checked against the router. Dynamic configurations or Vite roots, Vue 2, Next/Nuxt, other bundlers, complex conditional chains, and boundaries inside table rows require explicit adapters. Init reports these cases instead of claiming they are integrated. Rerun `init --dry-run --json` to review newly introduced regions, then `init` to integrate them; use `sync` when only the contents of existing regions change.

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

Vue components defined with imported `defineComponent({ props, render })` and
functional components returning imported `h()` calls can also be expanded without
executing them. The finite renderer handles literal/default props, `this.$attrs`,
native elements, imported child components and zero-argument default/named slot
forwarding. Helper aliases and Vue namespace imports retain their package identity.
Simple `setup(props, { attrs, slots })` closures returning a zero-argument render
function also retain defaults and forwarded slots. Imported Vue `useAttrs` and
`useSlots` are interpreted as source capabilities; setup itself is never called.
Local component wrappers are transparent only when their available source proves
an identity return, optionally attaching an `install` callback. Optional extension
branches must be statically absent; render replacement and unknown branches stay
opaque. Bounded dependency entry files can supply this proof without importing
the package. A wrapper name alone does not establish the relationship.
Direct render closures can retain native structure, typography and finite local
render helpers even when setup contains lifecycle handlers. Mutable state stays
unknown and the partial shell keeps a diagnostic; those handlers never run.
Selected Vue regions retain enclosing loop and scoped-slot contexts. Slot
arguments, destructuring aliases and defaults can pass through template, JSX and
finite `h()` wrappers. Surrounding UI is traversed for context without becoming
part of the region; guards inside the selected region retain their normal rules.
Imperative render bodies, mixins, dynamic component factories and scoped render-slot
callbacks retain a local fallback. Setup hooks and business functions are not run.

### Auto-imported Vue components and preprocessed styles

Vue templates use DOM parsing rules, including native void elements such as `<input>`.
SkelCast statically reads `GlobalComponents` entries in `components.d.ts` and
`src/components.d.ts` to expand local auto-imported components. It never imports
their business modules. Explicit imports take precedence; `components` overrides
declaration mappings. Missing declarations are tracked so creating one invalidates
existing artifacts. Override the file list with `componentDeclarations` (use `[]`
to disable discovery).

Enable additional presentation and style support in the development configuration:

```js
export default {
  components: { ChartPanel: 'src/skeletons/ChartPanel.vue' },
  componentBindings: {
    'src/components/Card.vue': { theme: { borderColor: '#dce1e7' } },
  },
  componentDeclarations: ['components.d.ts'],
  componentPresets: ['naive-ui'], // Enable only the libraries used by the project.
  styles: {
    // Sass/SCSS and CSS-first Tailwind 4 are detected automatically.
    // Set sass: false or tailwind: false to reject those inputs explicitly.
    less: true,
    unocss: {
      theme: { colors: { primary: '#1ea54c' } },
      shortcuts: { panel: 'p-24px rounded border' },
      safelist: [],
      attributify: true,
    },
  },
  targets: [/* source targets */],
};
```

Opt-in presets supply finite presentation primitives for common data components,
containers and controls. They approximate default geometry, rather than executing
the actual component library. Unsupported components retain local diagnostics and
fallbacks; custom themes and complex layouts can use project-local source adapters.

| Preset | Typical use | Data/layout coverage |
| --- | --- | --- |
| `naive-ui` | Vue / `naive-ui` | Cards, grids, code output, statistics, images, tags, data tables |
| `element-plus` | Vue / `element-plus` | Tables/columns, cards, descriptions, statistics/countdowns, progress, images, avatars, tags, layout/form containers |
| `ant-design-vue` | Vue / `ant-design-vue` | Tables/columns, cards, lists, descriptions, statistics, images, avatars, tags, layout/form containers |
| `antd` | React / `antd` | The same basic Ant Design shapes, including JSX compound components such as `Table.Column` and `Form.Item` |

Each preset also handles basic buttons, inputs, selection controls and calendar
frames. These are inert control representations, not blanket gray placeholders.
Presets match the package and export in source imports or `GlobalComponents`
declarations, including renamed and namespace imports. A tag prefix alone never
enables a library rule. Resolvable local source and explicit project adapters take
precedence. Common `/es`, `/lib` entry points and explicitly listed component deep
imports are supported. Library rendering and slot rules live in separate modules under
`src/compiler/presets/`; the compiler only dispatches confirmed component identities.

The Element Plus row/column preset retains numeric gutters, alignment and the
24-column grid's `span`, `offset`, `push` and `pull` fields. Numeric and object
`xs`/`sm`/`md`/`lg`/`xl` overrides generate viewport media rules; zero spans hide
columns at the corresponding breakpoint. Nested rows provide their own gutters.
Unknown grid values retain a `PRESET_LIMIT` diagnostic instead of claiming exact
responsive geometry.

Element Plus cards retain separate header/body/footer wrappers, body styles and
classes, and theme padding variables. Statistics and countdowns share finite title,
value, prefix and suffix structure; timers and formatter callbacks are not run.
Scrollbar height/max-height and progress stroke/circle dimensions retain explicit
source props. Vue hyphenated template props are normalized before preset dispatch.

Mask the data that is loading, rather than every element containing text. Buttons,
form labels, editable inputs, navigation and calendar date-grid frames keep their
static text/geometry. Data text, images, statistics, table cells and read-only output
fields receive placeholders. Table headers remain readable and wide tables scroll
inside their container. A control-only target can legitimately have zero data
placeholders; `quality` reports `preservedNodes` separately.
Known arrays determine table row count (up to 24); unknown arrays default to four
rows. A source-proved adjacent Element Plus pagination component can supply its
initial page size when its state belongs to the same composable as the table data. Use `hints.repeat` to request a finite loading capacity, including for an initially empty
array. Table bodies simplify action buttons, selection and expand controls into
placeholder shapes while retaining cell layout, column proportions and row capacity.
Source-visible cell text still reserves its wrapping space. Finite local JSX components, Vue JSX slot objects and source-origin render props retain their presentation structure. Read-only field/key helpers use bounded syntax interpretation; unresolved table data-slot calls use text geometry and retain `PRESET_LIMIT`. No application helper is invoked. SVG and Canvas retain
their native viewport, CSS dimensions and aspect ratio as a single placeholder;
paths, chart labels and canvas fallback details are not expanded. Use
`data-sk-preserve` to retain a specific region's existing presentation policy.
React `map` and Vue `v-for` use the same rule: known arrays keep their length up to
256 for finite source presentation lists, known empty arrays stay empty, and unknown collections default to four items. Larger finite lists report `COLLECTION_LIMIT` instead of silently claiming complete output. Unknown loading capacity and table bodies remain bounded separately at 24.
An explicit `hints.repeat` overrides those counts.
Set `--skeleton-control-color` and `--skeleton-control-background` to match preserved
controls to the application's light/dark theme.

Vue layouts can project finite initial collection recipes and slot bookkeeping, including source-declared defaults, `provide`/`inject`, immediate watchers and collapsed visibility. Source-proven resize comparisons become CSS media rules. Interpretation is bounded and cannot mutate input collections, access the DOM, or execute event handlers; unsupported effects retain layout diagnostics.

Request loading views can project a source collection template when static writes
prove that the collection and its count come from the same response scope. Simple
length/count guards are eligible; permission guards and unrelated conditions are
preserved. No handler or request runs. A finite slice range supplies an upper
capacity, otherwise the default is four masked items, capped at 24. Projection
retains `LOADING_PROJECTION` diagnostics rather than predicting response data.
In Vue loading templates, sibling strict-equality alternatives for one unknown
scalar use one representative branch, retaining uncertainty diagnostics rather
than displaying mutually exclusive icons together. Definite source flex/grid
containers constrain direct opaque children; explicit child dimensions and
aspect-ratio defaults retain precedence.
Use `hints.state: 'source'` (also in a variant) to preserve the source-default
empty/content view; explicit bindings take precedence. Unproven empty branches
retain `EMPTY_STATE`. A repeat hint alone does not reopen an arbitrary false guard.

Global Vue registrations are read from entry `app.component` calls and narrowly
recognized plugin installers. Package source is considered only for an opted-in
library dependency. A reachable table that forwards source props and columns can
provide a partial table core; callback cells, surrounding wrapper UI and adaptive
runtime sizing keep `PRESET_LIMIT`. Component names or a `columns` prop alone are
not sufficient evidence. Literal table cells retain source text wrapping, column
minimum widths, explicit heights, header visibility and scroll constraints.

Use `data-sk-preserve` on a static subtree to retain its resolved content, or
`data-sk-mask` to force placeholders for a data subtree. These attributes work in
Vue and JSX and follow source slots/children through local wrappers. Unknown values
cannot be reconstructed by a preserve hint and retain an inert empty footprint.

```vue
<el-button>Refresh</el-button>
<aside data-sk-preserve>Fixed instructions</aside>
<section data-sk-mask>{{ report.summary }}</section>
```

Known source-visible text and finite text bindings retain their actual font layout
instead of a fixed-width bar. Escaped text is stored in artifact metadata and drawn
as transparent CSS generated content, preserving font advances, inline emphasis,
line height and natural wrapping without adding searchable text nodes. Paragraphs
keep their source children unless an explicit `hints.lines` override is supplied.
Unknown text still uses a representative width; set `data-sk-text-width="18ch"`
on a local container (inherited by its text) to override it, or supply a finite
text binding. `--skeleton-text-width` sets the fallback width through CSS.

Image placeholders retain width/height attributes and source CSS. For resolvable
local SVG, PNG, JPEG, GIF and WebP files, including default asset imports and
public-root URLs, intrinsic dimensions are read without rendering the image and
their bytes are included in dependency fingerprints. Source CSS aspect ratios take
precedence over the default intrinsic ratio. Use `data-sk-image-ratio="16 / 9"`
on an image for a local ratio override, or `--skeleton-image-ratio` in CSS. Remote
images are never fetched; explicit dimensions describe their predicted geometry.
Images with no known dimensions retain a representative 400 × 300 intrinsic size.

Prefer request boundaries around the data region, with real controls outside the
boundary when they must remain interactive during loading. Preserved controls in a
generated artifact have no event handlers and are hidden from assistive technology;
they do not replace live application controls. A calendar's asynchronous event cells
are data regions even though its date-grid frame is a control. Current dates, custom
calendar cells, grouped/custom table renderers and list render callbacks are not
executed or inferred; finite approximations retain `PRESET_LIMIT` diagnostics.
Table column APIs follow [Element Plus](https://element-plus.org/en-US/component/table),
[Ant Design](https://ant.design/components/table/) and
[Ant Design Vue](https://github.com/vueComponent/ant-design-vue/blob/main/components/table/index.en-US.md).
Local component roots inherit parent classes, styles and supported utility attributes;
`defineOptions({ inheritAttrs: false })` disables attribute forwarding.
Declared local Vue props retain absent/Boolean defaults, literal default factories,
`v-model` values, `useVModel` aliases and named-slot presence. Array/object `v-for`
aliases can destructure values, keys and indexes; statically empty lists stay empty.
Bounded `computed` bodies and literal-array `map`/`find` callbacks are interpreted
without invoking their implementation. Unsupported calls remain unknown; collection
operations have size, depth and work limits.

Local JavaScript/TypeScript constants can cross relative/aliased imports, explicit
reexports and export-star barrels, including default and namespace imports. Export
conflicts and value cycles remain unknown. Imported object aliases with writes or
escapes to opaque calls are conservative; this is source analysis, not a live ESM
snapshot. Static array spreads, `slice`, `concat`, `toReversed`, `Array.of` and finite
`Array.from` are supported. Mutating `reverse` is interpreted only on an owned
temporary, such as `items.slice().reverse()`, and never changes the interpreter's
input array. An unconditional source return object can expose independently
declared immutable fields such as column configuration without invoking its
factory or hook. Mutated/escaped fields, conditional returns and async results
stay unknown. Source-proven `typeof` predicates are finite source expressions.
Arbitrary function implementations and runtime data sources remain unsupported.

An escaped literal collection or a finite `slice` bound can supply representative
placeholder capacity, capped at 24. This metadata is not an array value: `.length`
and item fields remain unknown, and diagnostics distinguish the frame from actual
result data. Tables can also use source-declared pagination capacity; explicit
repeat hints take precedence. Reachable library pagination siblings retain their
literal base spacing, with runtime style overrides still marked for review.
Masked table cells can reserve wrapping from literal source glyph prototypes
when a row collection escapes to opaque code. These prototypes remain separate
from expression values and retain diagnostics: they cannot drive branches,
attributes, layout bindings, callbacks or preserved content, and do not establish
the actual result values after a helper runs.
Bounded structural-copy recipes can also be proved from helper source: fresh
plain-object/array outputs, own-field iteration and finite recursive child copies.
Names and package identities alone are insufficient. Input writes, modified
intrinsics, getters, unsupported shapes and unknown deep-copy inputs keep the
helper opaque. Function-valued fields carry only a function-type fact and are
never invoked. Mutable Vue setup state keeps initial presentation facts in a
separate channel; only loading presentation consumers may use those facts, while
ordinary expressions and native layout bindings remain unknown.

Source-proven Element Plus table wrappers can retain a viewport-bottom constraint
when the generated table's ref, own DOM root, height formula, lifecycle activation
and finite offset are established. Runtime layout measures only the generated
skeleton, updates it for viewport/ancestor layout changes and releases observers
on unmount. It does not inspect business data, execute lifecycle handlers during
generation or infer new skeleton markup. Unknown offsets/activation and unrelated
refs keep the existing finite fallback. Pagination retains declared control groups
and intrinsic wrapping; unknown totals and localized labels use neutral frames.

The Naive preset also preserves configuration-provider children, code-output lines,
vertical dividers and numeric/responsive grids. Grid breakpoints follow the container
by default or the viewport with `responsive="screen"`. Code with unknown content uses
three representative lines; it does not claim to infer arbitrary output length.
Known string `v-html` content becomes inert semantic placeholders, with word lengths
and whitespace retained for natural wrapping. Event handlers, URLs and directives in
that HTML are not rendered or evaluated; unknown HTML keeps its local diagnostic.
Runtime-mounted widgets remain opaque. An empty native ref host is masked using
its source container geometry and retains a diagnostic; no internal tree is inferred.
Editor toolbars, panes and content are outside the built-in fidelity scope. Declare
finite empty/result variants for ordinary application state when needed. Stored-value
defaults supplied as explicit bindings describe a source-default snapshot, not a
user's persisted content.

CSS keyframes and locally declared font families receive artifact/content-specific names, including references in inline styles and finite CSS variable chains/fallbacks. Local relative CSS `url(...)` resources are embedded as data URLs and their binary bytes are fingerprinted, including resources in CSS/Less imports and resolved inline styles. This keeps resource paths valid on nested routes and in production without copying assets. Public-root, fragment, remote and existing data URLs retain their original semantics. Embedding resources increases artifact size; use public-root resources when embedding large assets is undesirable. CSS custom properties carrying opaque animation/font names still require an explicit static presentation value.

Sass/SCSS is compiled automatically before scoped CSS and CSS Modules processing,
including `@use`, `@forward`, partials, indented syntax and static project aliases.
Every loaded file and missing resolution alternative participates in invalidation.
Local assets in Sass partials retain their original directory through source maps.
Application Sass importers, functions and JavaScript modules are never executed.

Local stylesheets linked from `index.html` and direct stylesheet imports in its
module entry scripts are read statically. Entry scripts themselves are not run;
styles imported only through other application modules may still need target `styles`.

Tailwind 4 CSS directives are detected automatically. CSS themes, custom utilities,
variants, `@apply` and inline safelists compile against the generated markup's class
tokens. Application JavaScript `@config` and `@plugin` modules are rejected rather
than executed. External `@source` paths are not scanned and receive a diagnostic.
Runtime-built class names and JavaScript plugin utilities require supplied CSS.

Less is compiled before scoped CSS and CSS Modules processing. Imported Less files
are fingerprinted. JavaScript, `@plugin` and remote Less imports are disabled.
CSS/Less/Sass imports and local asset URLs use the same project aliases as component
imports, including nested stylesheets. Resolved style and asset dependencies are
fingerprinted so subsequent edits invalidate their artifacts.
Static CSS pruning defaults on. Positive class selectors that cannot match the
artifact and provably unreferenced font resources are removed; unknown pseudos,
negative selectors, theme alternatives, variable-dependent fonts and keyframes
remain conservative. Set `styles.prune: false` for full CSS inspection, including
unused safelisted utilities. Source native nodes retain their box model. Only
generated preset layout nodes receive SkelCast's border-box default.
CSS `v-bind()` expressions are resolved from each component instance's props,
defaults, aliases, bounded computed expressions and explicit bindings. Values are
written as component-scoped CSS variables on its roots, so two instances can keep
different dimensions. Unresolved expressions retain `STYLE_BINDING` diagnostics.
Use `componentBindings` for source-file-specific hook results such as a selected
static theme; hooks themselves are never invoked. A variant's `bindings` can
override an expression for one component with a key such as
`'src/components/Card.vue::theme.borderColor'`. Refresh explicit theme bindings
when their source values change.

UnoCSS uses the Mini and Attributify presets. Set `unocss: true` for their defaults,
or supply serializable theme, shortcuts and safelist data as above. SkelCast
generates utilities from artifact markup and preserves supported layout attributes
such as `flex`, `items-center`, `gap-8px`, `px8`, `pb6` and `important:p0`. It does
not execute application UnoCSS or Vite configuration, load arbitrary presets, or run source transformers. Copy
relevant theme/shortcut data into this configuration; advanced UnoCSS features need
precompiled CSS supplied through each target's `styles`.
Scoped utilities retain `.dark` and `.light` ancestor selectors, allowing a theme
class on the document root to affect its skeletons without leaking artifact CSS.

Use `bindings` to resolve expressions that affect branches, classes, or dimensions, such as `{ 'data.mode': 'grid' }`. The analyzer supports bounded expressions, aliases, destructuring, component props, React children, and Vue default/named slots. It never invokes arbitrary business functions or requests. Runtime slot parameters, render props, and complex helper functions need explicit hints or adapters.

Finite `clsx` and `classnames` calls imported from those exact packages are interpreted from static arguments (including aliases, arrays and object conditions). Their implementations are never imported or called. Shadowed helpers, unknown conditions and lookalike packages stay unresolved and diagnostic. This reduces hints for common class composition without evaluating business helpers.

Static `data-*`, `dir` and `lang` layout attributes are retained. Source IDs become
`data-sk-source-id`; generated CSS rewrites ID selectors (including `[id]` selectors)
to match without introducing duplicate DOM IDs, and preserves ID selector specificity.
The `data-sk-*` namespace is reserved for generated metadata and supported hints, including `data-sk-anchor`.
Unresolved layout attribute values produce `LAYOUT_ATTRIBUTE_UNKNOWN` diagnostics.

Ordinary `sync` commands load the trusted development configuration as executable code; application source is parsed only. Do not import the application entry point from the configuration.

### Generate and inspect

```bash
pnpm exec skelcast sync
pnpm exec skelcast diagnose --id products.list --json
pnpm exec skelcast check
```

Commit `.skelcast/*.mjs`, its manifest, and `skelcast.hints.json` alongside your source. The manifest records dependency fingerprints and artifact paths, not a second layout tree. Unchanged inputs reuse existing outputs. Generation stages all changed artifacts before replacing any output; a failed target leaves the previous generation intact. CLI, init, development-server mutations and artifact readers share an output-directory lock. Interrupted output commits are recovered from a local journal on the next operation. `check` exits with a nonzero status for stale, missing, or modified artifacts and can run in CI.

Generated modules use compact JSON while retaining all source locations, evidence and diagnostics. `inspect --json` provides formatted output for review. Production Vite builds additionally minify skeleton CSS (including the pre-JavaScript HTML shell), extract shared base CSS into one module, and remove `data-sk-node` location attributes when skeleton CSS does not depend on them. Text whitespace, layout attributes, variants and Shadow DOM behavior are preserved; development preview and diagnostic artifacts retain their location markers. Unsupported CSS is kept unchanged with a build warning. Use `skelcastPlugin({ optimize: false })` to disable production optimization when comparing output. HTTP Brotli/gzip compression should be configured on the deployment server or CDN for HTML, JavaScript and CSS.

For production client builds with one HTML entry and a matching page target, the default page view is carried by the HTML shell only. A small module snapshots its markup and styles before application entries run; page imports and matching shared base styles reuse that snapshot without another copy in JavaScript or an extra data request. The snapshot remains available after the shell is hidden or removed, including lazy page imports and SPA navigation. Other variants and page targets retain their own data. Multi-entry, library, SSR and async-entry builds keep standalone artifacts. Use `skelcastPlugin({ reuseInitial: false })` to retain standalone page data while keeping the other production optimizations.

Opaque components and unknown render calls produce local fallback blocks with source diagnostics. Caller classes, scopes and explicit width/height are retained; source height, min-height and aspect-ratio rules override the generic footprint. Unknown children in source-visible inline contexts use a font-relative footprint, while ordinary blocks default to 96px. These remain estimates, not inferred widget internals. The toolbar is for preview and visual acceptance; coding agents own diagnosis, source/hint/adapter changes, and automated verification.

`diagnose --id <target> --json` returns artifact freshness, effective target configuration, config/hints paths, and per-variant structural quality, diagnostics, source expressions, evidence, and repair examples grouped by source node. It reads generated metadata without executing business code or applying examples. It excludes the raw HTML/CSS; `inspect --id <target> --json` retains the original raw-artifact output when that detail is needed. Omit `--variant` to inspect every generated variant:

```bash
pnpm exec skelcast diagnose --id products.list --json
pnpm exec skelcast diagnose --id products.list --variant grid --node <source-node> --json
pnpm exec skelcast diagnose --id products.list --strict
```

Get node IDs from the first report. Unknown targets, variants, and nodes fail explicitly. `--strict` exits nonzero when the selected scope needs review; structural quality still describes the whole selected variant. Missing or modified artifacts return their freshness state with no repair context. Stale context is marked as such; sync before relying on source locations or examples after edits.

Repair examples contain illustrative presentation values, not inferred business values. For unresolved dimensions or finite branches, merge reviewed bindings with existing target bindings. For opaque components, create the suggested presentation adapter and merge its mapping into the existing target. Variant-level bindings take precedence over shared hints; when a variant overrides a suggested scoped binding, the example points to that variant's configuration instead.

To save small shared hints through the CLI, prepare a JSON object such as `{ "repeat": 4, "lines": 2 }` in `hint-patch.json` and run:

```bash
pnpm exec skelcast hints --id products.list --file hint-patch.json --json
pnpm exec skelcast sync
pnpm exec skelcast check
pnpm exec skelcast diagnose --id products.list --json
```

`--file` is resolved relative to `--root` (the project directory by default). The file contains a hint patch for one target, not a target-ID map. `hints` validates values and saves them to the configured hints file, preserving unrelated targets and omitted fields; it does not regenerate artifacts. Supplied `bindings` replace the entire shared object, so merge existing keys before saving. To clear shared bindings, supply `{ "bindings": {} }`. The effective saved hints are returned with `--json`. Structural layout changes belong in source; component adapters and variant hints belong in configuration. Direct project-file edits remain available to the agent.

Inspect structural quality separately from artifact freshness:

```bash
pnpm exec skelcast quality --json
pnpm exec skelcast quality --id products.list --strict
```

`quality` reports placeholder counts, fallback counts, unresolved component tags and
generation diagnostics for every variant. `--strict` exits nonzero for targets
needing review, including stale or missing artifacts. `check` retains its existing
freshness/integrity behavior. Each variant also reports `fallbackRatio`, and `review.locations` counts unique source locations with diagnostics across variants. These are review-work estimates, not measured human edits or visual similarity scores. Capture the first generated result before adding hints/adapters, then compare it after refinement:

```bash
pnpm exec skelcast quality --save-baseline skelcast.quality-baseline.json
# Refine source, hints or adapters, then sync.
pnpm exec skelcast sync
pnpm exec skelcast quality --baseline skelcast.quality-baseline.json --json
```

The comparison reports `before`, `remaining`, `resolved` and `added` review locations per current target. Locations use source node identity (or line number for file-level diagnostics); moving/reformatting source can change those identities. Use the same source revision when measuring hint/adapter repair work. Baselines require current artifacts. Keep initial reports from representative real project pages to measure adoption cost; the included fixtures do not establish a production first-pass success rate.

Structural quality cannot establish CSS visibility or
visual similarity: verify representative pages at desktop and mobile widths in a
browser, then compare them with the real application.

### Check rendered layout in the browser

Coding agents can run `skelcast audit` against an existing development server or use the browser-only API below in acceptance tests after real data is ready. Each check
briefly shows real content and the selected skeleton variant, then restores the
previous preview state, including comparison mode and opacity. It reports width/height differences, the change in the
region's bottom edge (potential displacement of following content), uncontained
horizontal overflow, and whether data placeholders have visible painted boxes.
Light DOM and open Shadow DOM are supported. Existing scroll containers are not
reported as uncontained overflow.

Use the browser-only API in development or browser acceptance tests:

```ts
import { auditBoundaryLayout } from 'skelcast/browser';

const boundary = document.querySelector<HTMLElement>(
  '[data-sk-boundary="products.list"]',
)!;
const report = await auditBoundaryLayout(boundary, {
  variant: 'grid',
  tolerancePx: 4,
  toleranceRatio: 0.05,
  overflowTolerancePx: 1,
});
console.log(report.needsReview, report.delta, report.issues);
```

Run this at representative desktop/mobile widths after fonts, images, data and
transitions have settled. Checks refuse pending or hidden content and abort if the
region or preview changes during measurement. Concurrent checks must run serially.
The default dimension tolerance is **4px + 5% of the real dimension**; position
uses 4px and overflow uses 1px. Exported `captureLayout()` and `compareLayouts()`
also support custom browser fixtures and stored geometry snapshots.

This is a geometry snapshot, not pixel similarity or the browser's CLS metric.
Equal outer dimensions do not prove matching internal layout, colors or content.
Native tables with visible headers are also checked for table count, column count
and header-row structure, including grouped headers and columns inside horizontal
scroll containers. Placeholder row counts can describe loading capacity, so they
are not compared with a server result count.
Use screenshots/overlays for those checks. `skelcast quality` remains a separate,
source-only structural check and never launches or signs into the application.
Source IDs are paired automatically with generated `data-sk-source-id` nodes. Add `data-sk-anchor="summary"` to a native presentation container for an explicit internal layout checkpoint (React and Vue). Repeated anchors are matched in DOM order; open Shadow DOM is traversed. Reports include compared/missing/mismatched anchors and detect column-width or position differences even when the region has identical outer dimensions. Unmarked internal content still needs visual review.

### Batch viewport checks and screenshot overlays

Run a browser audit against an existing SkelCast Vite development server:

```bash
pnpm add -D @playwright/test
pnpm exec playwright install chromium
pnpm exec skelcast audit --url http://localhost:5173/products \
  --id products.list --viewports 1440x900,390x844 --out .skelcast-audit
```

Reusable request instances are audited against their own context variants; the
toolbar lists state names instead of another caller's layouts. To validate empty,
error or permission states, drive the real application into each declared state
and call `auditBoundaryLayout` there. A CLI audit enumerates declared variants but
does not change application business state or simulate permissions.

The command reloads the URL at each viewport, waits for mounted boundaries, loading state, fonts and non-lazy images, and checks every variant of the selected region. Omit `--id` to check all regions mounted on that route. It writes `report.json`, real/skeleton PNGs and an `index.html` report with opacity sliders for screenshot overlays; a geometry mismatch or measurement error exits nonzero. It does not calculate a pixel-similarity score. Inspect screenshots when anchors do not cover the important layout. The browser-only API accepts an optional asynchronous `capture(phase)` callback (`content` or `skeleton`) for custom screenshot workflows and restores preview even if capture fails.

For an authenticated project, supply an existing Playwright state file with `--storage-state path/to/state.json`. The audit does not perform login. Storage state includes cookies/local storage, not session storage; applications using session-only sign-in need their own authenticated acceptance fixture. Keep reports and authentication state in your project's intended local/test output directories.

Import `skelcast/browser` only in development/test code when automated measurements
are needed; the production Vite integration does not inject the preview toolbar.

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

The development plugin injects the preview toolbar and consumes existing artifacts. Source edits mark artifacts out of date. The CLI, your coding agent, or **Update skeletons** performs deterministic regeneration. Production builds require current artifacts and exclude the toolbar, development endpoints, and URL preview controls.

Portable inspection artifacts embed local image/font bytes. Production builds emit shared image/font assets once and reference them from artifact JavaScript and initial HTML, including relative-base deployments. This avoids repeating large base64 literals across page chunks.

Transient generation locks and staging journals are excluded from Vite's watcher,
including under custom output directories. Reading development state does not
invalidate artifacts or reload the application. Existing user watcher exclusions
are preserved.

Element Plus presets also retain finite tree hierarchy/expansion, upload triggers
and declared file slots, alerts, watermark containers, active tab bodies, grouped
table headers, finite index-based cell spans, and native description-table sizing.
The `vuedraggable` preset preserves initial source list order and scoped item slots;
it does not run Sortable callbacks. All presets require confirmed package identity.

Source-proven custom directives are classified from imports and local plugin
registrations. Event callbacks are not run. Finite initial style writes are kept;
opaque DOM effects remain diagnostics. Visibility-changing directives can use
explicit presentation variants with bindings such as
`{ 'Component.vue::v-permission.visible': false }`. This describes the declared
view, not the current user's permissions. Do not infer roles or credentials.

Static Vite `define` data can project local JSON inputs and exported config object
syntax, including `JSON.stringify` data definitions. Config factories, serializer
hooks, clocks, environment loaders and application modules are never executed;
unknown parts remain opaque. Imported JSON is parsed as data and fingerprinted.

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

Skeleton markup is mounted on its first display and reused while hidden. Repeated light DOM instances share styles; different generated artifacts also share the common base sheet, retaining its cascade position and releasing the final reference. Shadow DOM instances share constructed stylesheets when available. Boundary updates notify only the affected preview or artifact subscribers.

Boundaries preserve mounted content when switching forced preview, so form state is retained. Application code must still guard data that has not arrived. Initial requests, background refreshes, errors, and retries remain under your application's control; SkelCast does not intercept `fetch`.

Exiting preview resumes the real loading state. Hidden content is inert, `aria-busy` reflects real pending state, and skeletons are hidden from assistive technology.
During pending state and forced preview, hidden content is clipped to zero height
while retaining its intrinsic inline size and measurable viewport position. Flex
siblings keep their source widths, and hidden content stays inert. React
layout effects and Vue mount hooks can initialize responsive widgets without
reading zero-sized `display:none` ancestors. Loading completion restores normal
flow without remounting the content.

### Show a skeleton before application JavaScript

A matching `kind: 'page'` target is injected into the initial HTML. Specific routes take precedence over parameters and catch-all patterns, including Vue's `:pathMatch(.*)*`. A mounted page boundary permanently takes over from the initial shell, including when a static SPA entry contains another route's shell. Navigating between pages does not restore the old overlay. If you do not use a page boundary, release the initial skeleton at an explicit application readiness point:

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

The toolbar keeps **Loading region**, **Show skeleton**, **Compare**, and a brief generation status in view. Select a page or region and turn on **Show skeleton** to hold its skeleton; turn it off to resume real loading behavior. Multiple layout variants appear only when available. Choose **Pick region…** in the region selector to select a boundary directly on the page, or choose **Cancel picking** to stop. **Update skeletons** appears only when generation artifacts need updating. Use DevTools device emulation for viewport testing.

The toolbar is a preview and acceptance surface. Diagnosis, source navigation, hint editing, repair examples, and automated layout checks belong to the coding agent through project files and the CLI. An update failure gives a short prompt to run `skelcast sync` with the agent. Development HTTP endpoints expose preview state and regeneration only; hint-writing and editor-opening endpoints are removed.

Choose a **Loading region**, then turn on **Compare** to overlay its generated skeleton on real content in React or Vue. The comparison controls appear only while comparing; **Comparison mode** offers:

- **Side by side** shows real content on the left and the skeleton on the right in equal-width panes. Each pane contains its own horizontal overflow; its available width is half the region, so use overlay or switching to check full-width geometry.
- **Overlay** aligns both at the same origin and blends the skeleton over the real content. Adjust **Opacity** from 0–100% (default 50%); pointer input passes through to the real content.
- **One-click switch** keeps the original width and lets **Show skeleton** / **Show real content** toggle between the two.

Comparison retains mounted content and form state without triggering requests. Regions that are still loading show their real loading skeleton, then resume comparison when ready. Turn off **Compare** or **Show skeleton** to return to normal loading behavior. Comparison mode, variant, opacity, and the selected switch view are reflected in the address bar and survive reloads. Copy the browser address manually to share a preview:

```text
/products?__sk=products.list&__sk_compare=side-by-side
/products?__sk=products.list&__sk_compare=overlay&__sk_opacity=0.5
/products?__sk=products.list&__sk_compare=switch&__sk_view=skeleton
```

### Refine with a coding agent

When a preview looks wrong, give the agent the target ID, variant, viewport, and a description of the mismatch. The current browser address includes the preview settings and can be copied manually. The agent uses `quality` to triage targets, `diagnose` for source-linked repair context, and source/config/hint edits to correct the result. After `sync` and `check`, run an appropriate browser `audit` when visual verification is needed, then return to the toolbar to accept the result. Generation and source diagnosis do not need a running application; browser audits use an existing application session and may exercise real application requests.

Shared hints are stored as a target-ID map in the configured hints file (`skelcast.hints.json` by default), as shown below. The agent can edit this file directly. When using `skelcast hints --id <target> --file <patch.json>`, put only that target's hint object in the patch file, without the outer target-ID map:

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

Saving a `bindings` object replaces the target's shared bindings as a whole;
save `{ "bindings": {} }` to clear them, including bindings from the target's
configuration. Omit `bindings` when updating other hints to retain the current
bindings. Explicit variant bindings and component-scoped configuration still apply.

See the [coding agent skill](skills/skelcast/SKILL.md) for the generation and integration workflow.

## Supported scope

- React function components with JSX/TSX; Vue 3 SFC templates and script setup.
- Plain CSS, CSS Modules, Vue scoped CSS, CSS imports, media and container queries; opt-in Less and UnoCSS Mini/Attributify generation.
- Local components, simple prefix aliases, bounded conditions and repetition, static classes/styles, source locations, and visible fallbacks.
- Static light DOM or Shadow DOM rendering, without generating from screenshots or authenticated sessions.

The compatibility matrix separates source generation from automatic onboarding:

| Project feature | Direct support | Hints or configuration | Adapter / manual integration |
| --- | --- | --- | --- |
| React function components / Vue 3 SFC templates | Source layout, props, local children and supported slots | Explicit values for opaque layout expressions | Class components, arbitrary render functions |
| Vite React / Vue 3 project onboarding | Static page/loading patterns, aliases and lazy route imports | Verify inferred routes and dynamic relationships | Other bundlers, dynamic configs, Vue 2 |
| Conditions, repeated lists, finite variants | Bounded expressions and known arrays | `bindings`, `repeat`, explicit `variants` for unknown state | Business helper execution is not supported |
| Local CSS, CSS Modules, scoped CSS, media/container queries | Static CSS and imports | Ancestor styles may need target `styles` or light DOM | Runtime-generated styles require a source adapter or supplied CSS |
| Sass/SCSS / Tailwind 4 CSS | Automatic stylesheet compilation and finite markup candidates | Explicit stylesheet roots for styles outside entry/target imports | Application JS plugins, runtime classes and external Tailwind source scans |
| Less / UnoCSS Mini + Attributify | After explicitly enabling the matching style option | Copy serializable theme/shortcut data | Pug and arbitrary UnoCSS plugins/transformers |
| Local default/named slots and React children | Source-visible content | Bind finite slot-presence/prop values where supported | Scoped slot parameters, render props and arbitrary callbacks |
| Naive UI / Element Plus / Ant Design | Listed finite primitives after enabling the preset | Local adapters for custom themes or unsupported components | Full library behavior is not executed |
| CSS-in-JS, Canvas and imperative widgets | Opaque source container only | Explicit dimensions can describe the footprint | Local presentation adapter; widget internals are not inferred |
| Page shell before JavaScript | Vite HTML injection and explicit route matching | Multi-route static SPA shell selection | Next/Nuxt adapters and generic request-level SSR hydration are not implemented |

The checked-in [acceptance projects](tests/fixtures/projects/README.md) cover an
aliased, lazy-routed React administration page with CSS Modules and a scrollable
table, plus a Vue workspace with named slots, scoped Less and prop-based CSS
variables. Browser tests copy these projects to temporary directories, run init
and production builds, and compare real/skeleton geometry at 1440px and 390px.
These are representative reproducible fixtures, not a claim of compatibility with
arbitrary production applications. Real adopters should run the same checks on
their own authenticated pages and component libraries.

Layout audits use compiler-recorded source IDs and explicit `data-sk-anchor`
markers. Runtime-only IDs created by widget internals are not source anchors;
legacy/manual artifacts without ID provenance retain the previous full-ID check.
Uncontained overflow remains in both raw snapshots. Only an increase beyond the
source baseline fails the comparison; pre-existing source overflow is not a
generator regression. Missing declared anchors and displaced repeated anchors
still fail independently of matching outer dimensions.

Full type-system inference, arbitrary function evaluation, runtime CSS-in-JS, Pug compilation, arbitrary dynamic components, Canvas, and complete third-party design-system adapters are not included. Dynamic aliases and complex path mappings need manual configuration. Vue Options API dynamic values need bindings or adapters. Review ancestor-dependent styles, intrinsic asset dimensions, and complex scoped slots in the real page.

Boundaries use block containers with `min-width: 0` so the additional wrapper can shrink inside flex and grid parents. Wide content must still provide its intended scroll container. Place boundaries around suitable block regions rather than directly inside table rows or layouts that require specific direct children. Shadow DOM isolates selectors but still needs a known style context; choose light DOM when application ancestor selectors are essential.

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
