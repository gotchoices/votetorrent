# @votetorrent/ui-web

Shared web UI package for `apps/VoteTorrentDashboard` (the authority dashboard) and the public
no-login election view (`apps/VoteTorrentPublic`, 53-06). Web only — the two React Native apps
(`VoteTorrentAuthority`, `VoteTorrentVoter`) are out of scope and never consume this package.

Ships as source, consumed as `workspace:*`. No build step, no `dist/`.

## Consumer recipe (D-16)

Rules with the measured reason attached, not prose — follow every step below to add a new
consumer.

### 1. Add the dependency

In the consuming app's `package.json` `dependencies`:

```json
"@votetorrent/ui-web": "workspace:*"
```

### 2. Add `resolve.dedupe` to the app's `vite.config.ts`

```ts
resolve: { dedupe: ['react', 'react-dom'] },
```

This is per-**app** config — a shared package cannot enforce its own correctness for a consumer
that omits it.

Measured reason: this repo has no hoisted React (`.yarnrc.yml` sets `nmHoistingLimits: workspaces`;
`node_modules/react` does not exist at the root). Each workspace owns its own `19.0.0` copy, and
this package declares `react`/`react-dom` in both `peerDependencies` and `devDependencies` — the
same on-disk layout that breaks *without* `dedupe`. `dedupe` is what makes it safe.

A duplicate React is harmless for purely presentational components — spike 089 measured a
dedupe-removed control passing 18/18 against a zero-hook component. It bites only at the **hook
dispatcher**: the same control dropped to 8/12 once a single `useState` was involved, in a build
that still exited 0. The failure surfaces long after the commit that caused it — add this line from
the app's first commit, not after the first hook lands.

53-12's repo-root static assertion (D-21) will make this line mandatory for every consumer of this
package; a comment merely discussing `dedupe` will not satisfy it, because that assertion strips
comment lines before scanning.

### 3. Import the stylesheet(s)

```
@votetorrent/ui-web/tokens.css
```

One import per app — see "Consuming the design tokens" below for the canonical form and position
(fixed by 53-03, D-15).

```
@votetorrent/ui-web/components.css
```

Added at 53-CR01 (the D-15 revision — see "Shared component default styles" below). Any consumer
that mounts `@votetorrent/ui-web/components` must ALSO `@import` this stylesheet, immediately after
`tokens.css`, in that consumer's own `app.css`: it carries the default rules for the class names
`AdvisoryDisclosure`, `LifecyclePill` and `DetailsToggle` themselves render
(`.pv-disclosure`, `.lifecycle-pill` + 3 modifiers, `.dt-toggle-group`). A consumer that mounts none
of those components does not need this import.

### 4. Import the right subpath

- `@votetorrent/ui-web` — plain-JS values, importable from `node --test` with no bundler.
- `@votetorrent/ui-web/components` — React components, bundler-only.
- `@votetorrent/ui-web/lifecycle` — `derivePhase`/`resolveComparisonInstant`/`PHASE_IDS`, plain-JS,
  importable from `node --test` with no bundler. Kept out of the `.` barrel because its only
  external dependency is `@votetorrent/vote-engine/browser`, a database engine — re-exporting it
  through `.` would load that engine for every consumer of any plain-JS value (measured
  0.30-0.44s vs 0.02s bare).
- `@votetorrent/ui-web/lifecycle-core` — `ELECTION_EVENT_ORDER`/`parseTimeline`/`normalizeInstant`/
  `finestStage` and the `TimelineStageId` typedef (D-19/D-21, 59-02), plain-JS, importable from
  `node --test` with no bundler. This is the ZERO-IMPORT half of `./lifecycle` — it imports
  nothing, not even `@votetorrent/vote-engine/browser`. **React Native consumers (e.g. the voter
  app) must import this subpath and never `./lifecycle`**: `./lifecycle` reaches the vote-engine
  browser entry, which a React Native/Metro bundle should not pay for.
- `@votetorrent/ui-web/facts` — the fact/gap model (`FACTS`, `factsFor`, `headline`,
  `FACT_GROUPS`, `GAP_IDS`, `FACT_COPY_KEYS`), plain-JS, importable from `node --test` with no
  bundler. Deliberately **not** reachable through `./lifecycle` — `election-phase.js` imports
  `@votetorrent/vote-engine/browser`, so routing the fact model through it would load a database
  engine for a consumer that only wants pure data. `headline` takes `t` as a parameter rather than
  importing it, which is what keeps this subpath free of any dependency at all.
- `@votetorrent/ui-web/tokens.css` / `@votetorrent/ui-web/components.css` — see step 3 above.
- `@votetorrent/ui-web/mutations` — the shared build-time mutation machinery (`MUTATIONS`,
  `resolveMutation`, `applyNoDedupe`, `stripTokensPlugin`, `readMutationReport`) the D-20 negative
  controls need. Plain-JS, loaded by a Vite config in a Node process, never by a bundler — every
  consumer's `vite.mutant.config.ts` imports it.

Importing `@votetorrent/ui-web/components` under plain Node throws `ERR_MODULE_NOT_FOUND` — Vite
resolves a `./Name.js` specifier to a same-named `.tsx` file via its extension probing; plain Node
does not perform that probe. That throw is intended: it is what keeps a `.tsx` re-export out of the
bundler-less `node --test` tier.

### 5. Extend the shared tsconfig base

```json
"extends": "../../packages/ui-web/tsconfig.base.json"
```

By **relative path**, not by package specifier — a package-specifier `extends` would require a new
key in this package's `exports` map, and this package's own gate (`test/package-shape.test.mjs`
rung 5) proves that map's exact key count and order — eight as of 59-02 (`.`, `./components`,
`./lifecycle`, `./lifecycle-core`, `./facts`, `./tokens.css`, `./components.css`, `./mutations`).
`tsconfig.base.json` carries the full `compilerOptions` block (14 options); no
consumer redeclares any of them.

### 6. Binding rule: never hoist React

`react`/`react-dom` must NEVER appear in the root `package.json` (any dependency field) or the root
`resolutions`. The loud `Rollup failed to resolve import "react/jsx-runtime"` failure tempts you
into hoisting React to fix it — don't. The hoisted shape builds green and dies at the first hook,
which is strictly worse than the loud failure it "fixes".

This package declares `react`/`react-dom` in **both** `peerDependencies` and `devDependencies`.
Peer alone fails `tsc` with `TS2875: This JSX tag requires the module path 'react/jsx-runtime' to
exist` — the package needs a local React to resolve and typecheck itself. This is the same on-disk
layout that breaks *without* `dedupe` (step 2) — `dedupe` is what makes it safe.

### 7. Not provided: a shared vite-config factory

Declined at D-16. A shared package reaching into build config fights any consumer needing an
override. Revisit only if a fourth consumer appears.

## Consuming the design tokens

The canonical import form (D-15, decided in 53-03): make

```css
@import '@votetorrent/ui-web/tokens.css';
```

the **first statement** in the consumer's own `app.css`, above that app's own layout rules, with
only the file-header comment before it. Chosen over an `index.html` `<link>` and over an ESM
`import` in `main.tsx` for three reasons: it is literally the one import D-15 promises; it keeps
working through both an `index.html` `<link href="/src/app.css">` and a `main.tsx`
`import './app.css'` entry path with no change to either; and it fixes cascade order
deterministically — tokens and base/reset land before any consumer rule, which an ESM import
ordering across two entry paths cannot guarantee. Vite resolves the bare package specifier through
its own resolver, honouring the `exports` map from step 3. A CSS `@import` is only valid before any
other rule in the file, so it must never drift below the consumer's own layout rules.

The consumer's own `app.css` then holds only that app's own layout and its own classes (classes it
renders directly, not through a shared component — e.g. `apps/VoteTorrentPublic/src/app.css`'s own
`.election-title` rule) — see `apps/VoteTorrentDashboard/src/app.css` for the reference layout shape
(`.layout`, its `900px` collapse, `.panel-grid`, and nothing else). A shared component's OWN default
styles do not belong here — see "Shared component default styles" below.

For the D-23 token probe's enumeration contract (one declaration per line, no comment inside
`:root`, no declaration-shaped text in any comment) and the `getComputedStyle` normalisation
semantics a consumer or a probe needs to know about, see the header of
`packages/ui-web/src/tokens.css` itself — that file is the single place to correct either if a real
browser run ever disagrees, so neither is restated here.

## Shared component default styles (D-15 revision, 53-CR01)

D-15 originally read "each app owns its own component styles" (53-03). Code review CR-01 (Phase 53)
measured the consequence: `apps/VoteTorrentPublic/src/app.css` never authored rules for
`.pv-disclosure`, `.lifecycle-pill` (+ 3 modifiers) or `.dt-toggle-group` — the class names
`AdvisoryDisclosure`, `LifecyclePill` and `DetailsToggle` themselves render — so on the shipped
public page the D-16 binding advisory disclosure and the lifecycle indicator rendered as unstyled
text, on a page whose entire stated purpose is that its claims can be checked. No gate this phase
built could see it: the D-19 `shared-components-mounted` rung only asserted
`childElementCount > 0` on a harness-created wrapper, true regardless of styling.

D-15 is REVISED: **the package that owns a shared component's markup also owns that component's
default CSS rules, for exactly the class names that component renders — no more, no less.**
`packages/ui-web/src/components.css` (exported as `./components.css`) carries
`.pv-disclosure`, `.lifecycle-pill` + its 3 modifiers, and `.dt-toggle-group`. A consumer may still
override anything in it through the normal CSS cascade (it declares no `!important` anywhere); what
a consumer may no longer do is forget to author the rule at all. This does NOT reclaim
`.election-title` (rendered directly by `ElectionShell.tsx`, not by a shared component) or
`.dt-toggle`/`.dt-body` (already correctly authored, independently, in every current consumer's own
`app.css` — CR-01 found no gap there, so nothing moves them).

Every consumer that imports `@votetorrent/ui-web/components` must ALSO `@import
'@votetorrent/ui-web/components.css';` in its own `app.css`, immediately after the `tokens.css`
import (both are `@import` statements and must stay together at the top of the file, before any
other rule — see step 3 above). This gate is not yet mechanically enforced the way `resolve.dedupe`
is (D-21, 53-12) — a future consumer that forgets the import gets unstyled shared components again,
caught (if at all) by the D-19 resolved-style rung below or the tier-1 class-name coverage check,
never silently.

Two new checks close the gap CR-01 measured:

- **`resolved-component-styles`** (D-19 browser rung, `packages/ui-web/scripts/run-ui-gates.mjs`):
  for each shared component with a default rule in `components.css`, reads a declared CSS property
  off the component's OWN rendered element (never the harness's `[data-ui-gate]` wrapper, which
  carries no rule of its own) and requires it to match the value `components.css` declares.
- **CSS class-name coverage** (tier-1, dependency-free, `scripts/lib/css-class-coverage.mjs`): every
  class name a consumer's own `src/` renders, plus every class name rendered by any
  `@votetorrent/ui-web/components` export that consumer mounts, must resolve to a real selector
  somewhere in that consumer's own reachable CSS (every `.css` file under its `src/`, plus any
  package stylesheet reachable from those files' `@import`s). This is the cheaper, no-browser-needed
  half — it would have caught all five of CR-01's missing selectors before any browser ever ran.

## Browser gates (D-19)

The shared browser-gate runner lives at `packages/ui-web/scripts/run-ui-gates.mjs`, with
`playwright: ^1.62.1` declared as a `packages/ui-web` **devDependency** — not at the repo root, and
not as an additional `exports` entry.

**Why it lives here, not at the repo root (measured, not assumed).** `.yarnrc.yml` sets
`nmHoistingLimits: workspaces`, so nothing hoists to the repo root — root `node_modules` carries
`playwright-core` but not `playwright`. A runner at repo-root `scripts/` would therefore need a new
root-level dependency on a browser driver, on every workspace's resolution path. Each workspace
instead gets its own `node_modules` under this hoisting limit, so a script at
`packages/ui-web/scripts/` resolves `playwright` from `packages/ui-web/node_modules` by **file
location**, independent of the cwd it is invoked from — that file-location resolution is what lets
ONE declaration serve BOTH the dashboard and the public app. The declared range `^1.62.1` is
byte-identical to the dashboard's own existing declaration and resolves to the same
`"playwright@npm:^1.62.1"` lockfile entry — `git diff -- yarn.lock` after adding it gains zero new
`resolution:` lines.

**Invocation**, run from a consuming app directory:

```
node ../../packages/ui-web/scripts/run-ui-gates.mjs --app .
```

**The harness contract every consumer must satisfy** — four numbered requirements:

1. A gate vite config importing and merging the app's own `vite.config.ts`, overriding only
   `build.outDir`, `build.rollupOptions.input`, `build.emptyOutDir` and `publicDir: false`, and
   declaring no `dedupe` of its own — its path and its `outDir` are the app's own choice, passed to
   the runner as `--gate-config` and `--gate-dist` (the dashboard's own
   `test/browser/vite.gate.config.ts` → `test/browser/dist` are the runner's *defaults* only because
   it is the first consumer, never because they are canonical).
2. A harness HTML entry plus a module entry, the HTML filename passed as `--gate-entry` (default
   `ui-gate.html`).
3. The entry importing **exactly one** stylesheet — the app's own `src/app.css` — and naming no
   stylesheet the app itself is responsible for wiring. **Why this is a requirement:** if the
   harness imported `tokens.css` directly it would render correctly even on an app that forgot the
   import, and the D-23 probe could never catch the one failure it exists for.
4. The entry mounting every named export of `@votetorrent/ui-web/components` inside an element
   carrying `data-ui-gate="<ExportName>"`, driving props so each renders non-empty output, then
   publishing a frozen `window.__UI_GATE__` and setting `window.__UI_GATE_DONE__ = true`.

`--gate-config`, `--gate-dist`, `--gate-entry` and `--port` (or the `UI_GATE_PORT` environment
variable) are documented CLI overrides whose defaults are the dashboard's own layout values — see
`run-ui-gates.mjs`'s own header for the full flag catalogue and the port-policy note (5180/5181
dev-preview, 5183 the dashboard's gate port, 5191 the public app's).
