---
name: skelcast
description: Generate, integrate, inspect, and update source-derived loading skeletons in React or Vue projects using skelcast. Use for page or request loading boundaries and development preview corrections.
---

# SkelCast

Use the project's `skelcast.config.mjs`, hints, and existing loading state. Read the package README for exact supported syntax and the project's boundary conventions before changing integration.

SkelCast's documentation, generated messages, developer tools, and examples use English. Preserve the application's original language when integrating existing source; recognizing localized loading labels does not authorize translating application content.

## Generation

- For an existing Vite React/Vue 3 app with SkelCast installed, use `pnpm exec skelcast init --dry-run --json` to inspect discovered pages, loading regions, and exact edits. Apply `pnpm exec skelcast init` within the user's requested integration scope. Init generates artifacts without executing application, router, Vite, or existing SkelCast config modules. Review route conventions and skipped patterns rather than treating discovery as proof of every loading relationship.
- Init preserves loading guards and early returns, writes backups and diagnostics under `.skelcast/`, and avoids duplicate boundaries on repeat runs. Dynamic configurations, other bundlers and SSR frameworks need explicit adapters; do not force a generic codemod through their diagnostics.
- Trace the target's render structure, CSS, imported components, and API field consumption. Identify text/image leaves, repetition, optional regions, and fields controlling classes, sizes, or branches.
- Business source is parsed only. Do not start the business application, authenticate, call APIs, import the business entry, or execute business functions to generate skeletons. The development config itself is trusted executable configuration.
- Choose explicit page/request boundary IDs. Use existing pending/route state; do not introduce a global network interceptor.
- Keep layout in business source. Add small hints for repeat count, text lines, fallback height, or bindings. For finite layouts, declare variants and their bindings before generation. Field names alone are not evidence of layout.
- For opaque local regions, use a source adapter if its layout is known; otherwise keep a visible local fallback and its diagnostic. Avoid inventing a detailed layout for arbitrary server-driven content.
- Vue auto-imports can be resolved from `GlobalComponents` declarations or explicit `components` mappings. Enable `styles.less`, `styles.unocss`, or `componentPresets: ['naive-ui']` only when appropriate for the application's source. UnoCSS accepts Mini/Attributify theme, shortcuts and safelist data; it does not execute the application's configuration. Preserve layout attributes, and review approximated third-party geometry and CSS `v-bind` diagnostics.
- Run `pnpm exec skelcast sync`, then `pnpm exec skelcast inspect --id <id> --json`. Review diagnostics and evidence, repair relevant unknown layout decisions, and run `pnpm exec skelcast check`. Generated modules and manifest are reproducible artifacts, not manual editing targets.
- Run `pnpm exec skelcast quality --json` to find empty variants, fallback regions and unresolved component tags independently of freshness checks. `--strict` fails for targets needing review. Structural counts do not establish painted geometry or similarity; verify representative layouts in a browser at desktop and mobile widths.
- CSS `v-bind()` resolves per instance from static props, defaults and bounded expressions. Use project-relative `componentBindings` for explicit theme/hook results; never invoke application hooks to obtain them. Variant bindings can target one component using `source/file.vue::expression`. Refresh explicit bindings after source theme edits and retain diagnostics for expressions that remain unknown.
- Declared Vue props, named slots, `v-model`, destructured loops and bounded collection callbacks can resolve source branches. Do not replace genuinely unknown outputs with empty values just to reduce diagnostics. Explicit storage/hook bindings describe a documented finite state, not the user's current persisted data.
- Keep editor internals outside the default fidelity scope. Treat runtime-mounted widgets as opaque regions using source container dimensions; do not reconstruct toolbars, panes or editor content unless explicitly requested. Known string `v-html` remains a generic inert-HTML feature. Preserve compact UnoCSS attributes such as `important:p0` and `px8`.
- Component library presets are opt-in and require a package/export identity from imports or component declarations. Never infer library membership from a tag prefix. Prefer resolvable local source and project adapters; keep finite library rendering and slot rules in their own modules. Do not add another library merely because its components exist in a project.
- Available basic presets are `naive-ui`, `element-plus`, `ant-design-vue` and `antd`. Enable only the project's libraries. Mask loading data, not every visual component: keep buttons, labels, editable controls and calendar date-grid frames; replace data cells, images, statistics and read-only output. Use `data-sk-preserve` / `data-sk-mask` for local source overrides, and prefer request boundaries around data when live controls must stay interactive. Preserve hints do not execute or reconstruct unknown values.
- Calendar event cells are data even though the date frame is a control. Custom cells, render callbacks and grouped tables need source adapters for exact layouts; do not invoke callbacks or fabricate dates. Retain `PRESET_LIMIT` diagnostics. Zero data placeholders are valid when a target contains preserved controls; review `preservedNodes` and painted geometry instead of forcing gray blocks.

## Integration and preview

- React/Vue boundaries consume `virtual:skelcast/<id>` and real pending state. Guard missing business data. Preserve mounted state when toggling visual preview.
- Page targets inject initial HTML via the Vite plugin. Let a page boundary take over or call `releasePageSkeleton()` at an explicit ready point.
- Developers may run the business app, log in, and navigate to preview. `?__sk=page` holds page skeletons; `?__sk=<id>` holds one region; `__sk_variant` selects a generated variant. DevTools controls viewport sizes.
- Toolbar corrections save hints; structural changes belong in business source. Sync after corrections. Do not ask the runtime/browser to infer a new skeleton.
- Verify normal loading and forced preview independently. Exiting preview must still show a skeleton when real pending remains true. Check responsive rules and fallback sizes, and ensure production output excludes development tooling.
- Verify that initial shells retire after mounting and SPA navigation, that theme variants follow the application's real theme state, and that horizontal content scrolls inside its own container. Check both real content and forced skeletons; page-wide overflow can be hidden by the application's outer layout.

Use light DOM when the component relies on business ancestor selectors. Shadow DOM is an optional style encapsulation backend; it does not remove the need to trace style context or prevent business execution.
