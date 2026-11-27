import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import base from './vite.config';

// vite.offline.config.ts — the build config for 56-12's offline/config-fault
// gate (D-17/D-13).
//
// Same shape and the SAME BINDING RULE as `vite.gate.config.ts` and
// `vite.live.config.ts`: it inherits `base` (this app's own vite.config.ts)
// through `mergeConfig` and adds ONLY `build.outDir`, `build.emptyOutDir`,
// `build.rollupOptions.input` and `publicDir`. It declares NO `resolve` key,
// NO `plugins` key and NO `server`/`preview` key of its own — that absence is
// the control that lets the repo's existing build-level mutations
// (53-11's D-20 `resolve.dedupe` removal, 54-12's two-`@quereus`-roots
// artefact-level proof) reach a build made from this config. NEVER add a
// `resolve`, `plugins` or `server`/`preview` key here.
//
// WHY THIS HARNESS LIVES IN `test/offline/` RATHER THAN THE ESTABLISHED
// `test/browser/`. This is a wave-level file fence, not a new architectural
// convention: 56-12's Wave-4 sibling (56-16) owns `src/peer/strand-read.js`
// plus three `test/node/*.test.mjs` files, a disjoint set, so the wave is
// genuinely parallel; `56-11` (Wave 5) then owns `test/browser/` plus its own
// new Vite config, and `56-13` (Wave 6) reaches into `test/browser/` again.
// Putting this plan's own new harness in a sibling directory with its own
// one-config-per-gate file is what lets `56-11` and `56-13` own
// `test/browser/` outright, with none of this gate's files in the way.
// Recorded here so a later reader consolidates `test/offline/` into
// `test/browser/` deliberately, rather than treating the split as drift.
//
// Fourth out dir, still no ordering trap: `yarn build` emits `dist/`,
// `build:gate` emits `dist-gate/`, `build:live` (54-15) emits `dist-live/`,
// and this config emits `dist-offline/` — each from its own entry, none of
// them touching the others.
//
// `publicDir` VERDICT (56-06's five-config table): **`false`.** The gate's
// whole subject is a served root whose `config.json` the RUNNER controls
// between page loads — writing and removing the file directly in
// `dist-offline/` between navigations. A build-time copy of `public/` would
// defeat all three config rungs by making a `config.json` permanently
// present (or permanently absent) regardless of what the runner writes.
export const OFFLINE_OVERRIDES = {
	build: {
		outDir: 'dist-offline',
		emptyOutDir: true,
		rollupOptions: {
			input: fileURLToPath(new URL('./test/offline/offline-gate.html', import.meta.url)),
		},
	},
	publicDir: false,
};

export default mergeConfig(base, OFFLINE_OVERRIDES);
