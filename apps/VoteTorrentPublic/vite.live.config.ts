import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import base from './vite.config';

// vite.live.config.ts — the build config for D-27's live-read gate (54-15).
//
// Same shape and the SAME BINDING RULE as `vite.gate.config.ts`: it inherits
// `base` (this app's own vite.config.ts) through `mergeConfig` and adds ONLY
// `build.outDir`, `build.emptyOutDir`, `build.rollupOptions.input` and
// `publicDir`. It declares NO `resolve` key, NO `plugins` key and NO
// `server`/`preview` key of its own.
//
// That absence is the whole point, and it is a control rather than tidiness.
// 53-11's D-20 negative control removes `resolve.dedupe` from `vite.config.ts`
// and requires the identity gate to fail; 54-12 then proved at ARTEFACT level
// that dropping the two `@quereus` entries ships TWO on-disk engine roots in a
// build that still exits 0. If this file carried its own `resolve` block,
// neither mutation would reach a build made from it, the control would pass
// silently, and this config would be a lookalike. NEVER add a `resolve`,
// `plugins` or `server`/`preview` key here.
//
// Third out dir, still no ordering trap: `yarn build` emits the honest
// production `dist/`, `build:gate` emits `dist-gate/`, and this config emits
// `dist-live/` — each from its own entry, none of them touching the others.
// `dist-live` is listed in this app's `.gitignore` because the root
// `.gitignore`'s bare `dist` rule matches only an entry named exactly `dist`,
// which is why `dist-gate` and `dist-mutant-*` are already listed there.
//
// Deliberately NOT wired into `package.json` or `web-gates.yml`: attaching this
// gate to the runner and to CI is 54-18's, and a script added here would be
// this plan claiming a hand-off it did not make.
export const LIVE_OVERRIDES = {
	build: {
		outDir: 'dist-live',
		emptyOutDir: true,
		rollupOptions: {
			input: fileURLToPath(new URL('./test/browser/live-read-gate.html', import.meta.url)),
		},
	},
	// The fourth point of packages/ui-web/README.md's harness contract. 56-06
	// audit: `public/` now exists (the D-20 favicon set + the D-13 config
	// template), so this override is LOAD-BEARING, not anticipatory. It stays
	// `false` because `live-read-gate.html` seeds its store directly and
	// never boots the peer layer — it needs no icons and no `config.json`.
	publicDir: false,
};

export default mergeConfig(base, LIVE_OVERRIDES);
