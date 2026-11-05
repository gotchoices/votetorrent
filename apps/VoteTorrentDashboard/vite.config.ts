import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// D-19 binding rule: this config must NEVER gain a `resolve.alias`, a `define`, or a
// plugin that shims a Node builtin (`buffer`, `process`, `crypto`, `stream`, `path`,
// `vite-plugin-node-polyfills`, `node-stdlib-browser`). If the build needs one of those
// to succeed, the fix is to remove the offending import from the engine subpath
// (`@votetorrent/vote-engine/browser`), never to add a polyfill here. A build that
// silently shims a Node builtin has failed the zero-polyfill bar that
// `scripts/assert-no-node-polyfills.mjs` exists to enforce.
//
// D-16 amendment (53-02): this config now carries a `resolve` key below. `resolve.dedupe`
// is NOT `resolve.alias` — it adds no module redirection and shims nothing; it forces a
// single copy of two packages this app already depends on directly. Do not read the bare
// `resolve` key as evidence the rule above was relaxed: `resolve.alias`, a `define`, and an
// envPrefix/Node-builtin-shimming plugin remain forbidden, verbatim.
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
// 54-03a amendment: the same `nmHoistingLimits: workspaces` hazard applies to
// `@quereus/quereus` and `@quereus/plugin-indexeddb` now that this app depends on
// `@votetorrent/web-data`, which declares both in peerDependencies + devDependencies (the
// same on-disk shape that makes React's dedupe entry necessary above). A duplicate
// `@quereus/quereus` means a second `Database` class identity and a second
// `@quereus/plugin-indexeddb` module registry — plugin registration or an `instanceof`
// boundary fails in a build that still exits 0, the same spike-089 signature one stack down.
//
// The lazy peer chunk. The peer layer (`src/peer/`: the member node, the strand reader, the
// replication, pairing and the live boot) and everything it pulls in -- cadre-core, libp2p,
// the IndexedDB block storage -- loads only through a dynamic `import()`: the pairing screen and
// the live shell import `peer/boot.js` / `peer/pairing.js` that way, and
// `lifecycle/forget-network.js` (statically imported by the shell) reaches
// `peer/member-node.js` the same way, so this build already carries the peer chunk. `manualChunks`
// names only files under `src/peer/` 'peer'; it never routes a `node_modules` package by name,
// because a package the entry also uses (for example a crypto plugin shared with the local store)
// would then drag the peer chunk into the entry. `onlyExplicitManualChunks` keeps the chunk to
// exactly those files: without it Rollup also moves every dependency of a manual chunk into it,
// shared ones included (the local store's engine, measured: the entry then imported the peer chunk
// statically and carried all seven cadre-core protocol ids). `build.manifest` exists for the dist proof in
// `test/node/boot.test.mjs`, which checks that the entry's static-import closure carries no
// cadre-core protocol id while the dynamic closure does. Neither key is an alias, a define or a
// polyfill: the D-19 rule above stands unchanged.
const PEER_SOURCE_DIR = '/apps/VoteTorrentDashboard/src/peer/';

export default defineConfig({
	plugins: [react()],
	resolve: { dedupe: ['react', 'react-dom', '@quereus/quereus', '@quereus/plugin-indexeddb'] },
	server: { port: 5180, strictPort: true },
	preview: { port: 5180, strictPort: true },
	build: {
		target: 'es2022',
		sourcemap: true,
		manifest: true,
		rollupOptions: {
			output: {
				onlyExplicitManualChunks: true,
				manualChunks(id: string): string | undefined {
					return id.replace(/\\/g, '/').includes(PEER_SOURCE_DIR) ? 'peer' : undefined;
				},
			},
		},
	},
});
