import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import base from './vite.config';

// vite.closure.config.ts — the build config for RESEARCH Assumption A2's
// Wave-1 settlement (56-02): whether the seven-package libp2p + strand-read
// closure bundles cleanly under Vite for a browser target.
//
// Same shape and the SAME BINDING RULE as `vite.live.config.ts` and
// `vite.gate.config.ts`: it inherits `base` (this app's own vite.config.ts)
// through `mergeConfig` and adds ONLY `build.outDir`, `build.emptyOutDir`,
// `build.rollupOptions.input` and `publicDir`. It declares NO `resolve` key,
// NO `plugins` key, NO `server`/`preview` key of its own — and, specific to
// THIS file, it must NEVER override `build.sourcemap`, because
// `scripts/assert-libp2p-closure.mjs` section 5's anti-vacuity presence
// check reads the emitted sourcemaps' `sources` arrays and is blind without
// them. `base` already sets `build.sourcemap: true`; this file inherits it
// and must not touch it.
//
// That absence is a control, not tidiness. If this file carried its own
// `resolve`, `plugins`, `server`/`preview` or `sourcemap` key, a mutation
// aimed at the shared `base` config would not reach a build made from THIS
// file, and this config would be a lookalike rather than the real production
// resolver/plugin/target pipeline the A2 verdict is supposed to be about.
//
// `publicDir: false` here is SETTLED, not provisional — 56-06 owns the
// `publicDir` audit across this app's configs once `public/` exists, but
// this file's posture was decided during 56-02's planning and must not be
// "fixed" to match whatever 56-06 does to the other four configs. The
// reason is specific to this file: Task 3's bundle re-measure reads
// `dist-closure/` as MODULE-GRAPH WEIGHT, and copied static assets
// (`config.json`, the D-20 favicon set) would inflate that figure with
// bytes that have nothing to do with whether libp2p bundles.
//
// 56-06 audit, confirmed: `public/` now exists (the D-20 favicon set + the
// D-13 config template) and this override is now LOAD-BEARING rather than
// hypothetical, for the reason stated above — distinct from the other two
// gate configs' reasons (they mount no page and dial nothing; this one
// imports symbols and loads no page at all).
//
// Deliberately NOT added to `tsconfig.json`'s `include` array — its siblings
// `vite.gate.config.ts` and `vite.live.config.ts` are both absent from it
// too, and this file follows them.
export const CLOSURE_OVERRIDES = {
	build: {
		outDir: 'dist-closure',
		emptyOutDir: true,
		rollupOptions: {
			input: fileURLToPath(new URL('./test/browser/libp2p-closure-probe.html', import.meta.url)),
		},
	},
	publicDir: false,
};

export default mergeConfig(base, CLOSURE_OVERRIDES);
