import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// D-19 binding rule (carried from apps/VoteTorrentDashboard/vite.config.ts): this config
// must NEVER gain a `resolve.alias`, a `define`, or a plugin that shims a Node builtin
// (`buffer`, `process`, `crypto`, `stream`, `path`, `vite-plugin-node-polyfills`,
// `node-stdlib-browser`). If the build needs one of those to succeed, the fix is to remove
// the offending import from the engine subpath (`@votetorrent/vote-engine/browser`), never
// to add a polyfill here. A build that silently shims a Node builtin has failed the
// zero-polyfill bar that `scripts/assert-no-node-polyfills.mjs` exists to enforce.
//
// D-16 amendment: this config carries a `resolve` key below. `resolve.dedupe` is NOT
// `resolve.alias` — it adds no module redirection and shims nothing; it forces a single
// copy of two packages this app already depends on directly. Do not read the bare `resolve`
// key as evidence the rule above was relaxed: `resolve.alias`, a `define`, and an
// envPrefix/Node-builtin-shimming plugin remain forbidden, verbatim.
//
// Second binding rule, this app's own: `resolve.dedupe` must contain exactly the four
// entries below, in that order, and must never be deleted "because the build is green" —
// the build is green in every broken variant; the identity gate 53-09 adds is the only
// thing that can see its absence.
//
// Why `dedupe` is here: this repo has no hoisted React (`.yarnrc.yml` sets
// `nmHoistingLimits: workspaces`), each workspace owns its own `19.0.0` copy, and
// `@votetorrent/ui-web` declares `react`/`react-dom` in both `peerDependencies` and
// `devDependencies` — the same on-disk layout that breaks *without* dedupe. `dedupe` is
// what makes it safe.
//
// The failure it prevents, with the measured signature (spike 089): a duplicate React is
// harmless for purely presentational components — the dedupe-removed control passed 18/18
// against a zero-hook component — and bites only at the **hook dispatcher**, dropping the
// same control to 8/12 once one `useState` was involved, in a build that still exits 0.
// Deleting this line fails no build; it fails at the first hook in a shared component.
//
// 53-12's repo-root assertion (D-21) will make this line mandatory for every workspace
// declaring `@votetorrent/ui-web`; a comment merely discussing `dedupe` will not satisfy it,
// because that assertion strips comment lines before scanning.
//
// 54-11 amendment — the two quereus entries, and why they are NOT unrelated to React.
// This app now reaches a real browser database through `@votetorrent/web-data`
// (`src/election-index-source.js`), and that package declares `@quereus/quereus` and
// `@quereus/plugin-indexeddb` in BOTH `peerDependencies` and `devDependencies` — the same
// on-disk shape that makes React's entry above necessary, one stack down. `.yarnrc.yml`
// sets `nmHoistingLimits: workspaces`, so nothing is hoisted and a second copy of
// `@quereus/quereus` means a second `Database` CLASS IDENTITY and a second plugin registry:
// plugin registration, or an `instanceof` boundary between the handle this app's data
// package opens and the engine code that declares the schema onto it, fails in a build that
// still exits 0 — the identical spike-089 signature measured for React. That is why the two
// packages are also declared as direct dependencies of this app: `dedupe` resolves its
// entries from the project root, and an entry the root cannot resolve is an inert config
// line rather than a guarantee. `apps/VoteTorrentDashboard/vite.config.ts` carries the same
// four entries for the same reason (54-03a); do not delete these two as "not about React".
export default defineConfig({
	plugins: [react()],
	resolve: { dedupe: ['react', 'react-dom', '@quereus/quereus', '@quereus/plugin-indexeddb'] },
	server: { port: 5181, strictPort: true },
	preview: { port: 5181, strictPort: true },
	build: { target: 'es2022', sourcemap: true },
});
