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
- Run `pnpm exec skelcast sync`, then `pnpm exec skelcast inspect --id <id> --json`. Review diagnostics and evidence, repair relevant unknown layout decisions, and run `pnpm exec skelcast check`. Generated modules and manifest are reproducible artifacts, not manual editing targets.

## Integration and preview

- React/Vue boundaries consume `virtual:skelcast/<id>` and real pending state. Guard missing business data. Preserve mounted state when toggling visual preview.
- Page targets inject initial HTML via the Vite plugin. Let a page boundary take over or call `releasePageSkeleton()` at an explicit ready point.
- Developers may run the business app, log in, and navigate to preview. `?__sk=page` holds page skeletons; `?__sk=<id>` holds one region; `__sk_variant` selects a generated variant. DevTools controls viewport sizes.
- Toolbar corrections save hints; structural changes belong in business source. Sync after corrections. Do not ask the runtime/browser to infer a new skeleton.
- Verify normal loading and forced preview independently. Exiting preview must still show a skeleton when real pending remains true. Check responsive rules and fallback sizes, and ensure production output excludes development tooling.

Use light DOM when the component relies on business ancestor selectors. Shadow DOM is an optional style encapsulation backend; it does not remove the need to trace style context or prevent business execution.
