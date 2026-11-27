import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import base from './vite.config';

// vite.liveness.config.ts — the build config for 56-14's liveness/live-update
// gate (D-16's UI feedback half, D-19's UI half).
//
// Same shape and the SAME BINDING RULE as `vite.gate.config.ts`,
// `vite.live.config.ts` and `vite.offline.config.ts`: it inherits `base`
// (this app's own vite.config.ts) through `mergeConfig` and adds ONLY
// `build.outDir`, `build.emptyOutDir`, `build.rollupOptions.input` and
// `publicDir`. It declares NO `resolve` key, NO `plugins` key and NO
// `server`/`preview` key of its own — that absence is the control that lets
// the repo's existing build-level mutations reach a build made from this
// config. NEVER add a `resolve`, `plugins` or `server`/`preview` key here.
//
// WHY THIS HARNESS LIVES IN `test/liveness/` RATHER THAN `test/browser/` OR
// `test/offline/`. This is a wave-level file fence, not a new architectural
// convention — same reason `vite.offline.config.ts`'s own header states for
// `test/offline/`: `56-11` (Wave 5) owns `test/browser/` plus its own Vite
// config, and `56-13` (Wave 6, parallel to this plan) reaches into
// `test/browser/` again for its D-16 gate-inversion variants. Putting this
// plan's own new harness in a THIRD sibling directory, with its own
// one-config-per-gate file, is what lets `56-13` own `test/browser/` outright
// with none of this gate's files in the way. Recorded here so a later reader
// consolidates `test/browser/`, `test/offline/` and `test/liveness/`
// deliberately, rather than treating the three-way split as drift — the
// phase's full port map is fixed in `56-PLAN-OUTLINE.md` Amendment 3.
//
// Fifth out dir, still no ordering trap: `yarn build` emits `dist/`,
// `build:gate` emits `dist-gate/`, `build:live` (54-15) emits `dist-live/`,
// `build:offline` (56-12) emits `dist-offline/`, and this config emits
// `dist-liveness` — each from its own entry, none of them touching the
// others.
//
// `publicDir` VERDICT: **`false`.** This gate serves no assets and boots no
// peer layer — the harness drives the real external-write seam directly
// (`applyPeerRowBatch` + `notifyPeerWrite`) rather than a real libp2p dial,
// so there is no bootstrap config for it to fetch. A build-time copy of
// `public/` would add a `config.json` this page must never see: were one
// present, `PublicApp.tsx`'s own composition would attempt a real peer boot,
// which this gate's harness deliberately bypasses.
export const LIVENESS_OVERRIDES = {
	build: {
		outDir: 'dist-liveness',
		emptyOutDir: true,
		rollupOptions: {
			input: fileURLToPath(new URL('./test/liveness/liveness-gate.html', import.meta.url)),
		},
	},
	publicDir: false,
};

export default mergeConfig(base, LIVENESS_OVERRIDES);
