import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import base from './vite.config';

// vite.gate.config.ts — the harness build config (D-19/D-20/D-17).
//
// Inherits `base` (this app's OWN vite.config.ts) via `mergeConfig` and adds
// ONLY `build.outDir`, `build.emptyOutDir` and `build.rollupOptions.input`.
// This file declares NO `resolve` key, NO `plugins` key and NO
// `server`/`preview` key of its own — every one of those is inherited, and
// that is the entire point: 53-11's D-20 negative control removes
// `resolve.dedupe` from `vite.config.ts` and requires the identity gate to
// fail. If this file carried its own `resolve` block, that mutation would
// never reach the gate build, the control would silently pass, and it would
// be a lookalike rather than a real negative control. NEVER add a `resolve`,
// `plugins` or `server`/`preview` key here — mirrors `vite.config.ts`'s own
// binding "this config must NEVER gain a resolve.alias" rule, restated for
// this file's own binding rule instead.
//
// Two out dirs, no ordering trap (the D-17-vs-D-19 conflict 53-CONTEXT.md
// flagged as a risk): `yarn build` still emits the honest, election-fact-free
// `dist/` that D-17's scan walks; `yarn build:gate` emits ONLY this harness
// into `dist-gate/`. `vite.config.ts` itself gains no `rollupOptions.input`
// of its own, so production stays single-entry.
//
// `GATE_OVERRIDES` (53-11, D-20) is exported by name, separately from the
// merged default export, so `vite.mutant.config.ts` can pass `base` and
// these overrides to `applyNoDedupe` as the two SEPARATE halves that
// function needs — never a pre-merged object. This is what makes the
// `GATE CONFIG SELF-REFERENCE` detector possible: a `resolve` block added
// here (this file's own binding rule already forbids it) would be caught by
// that detector, not silently absorbed. Adding this export changes no gate
// behaviour — the default export below merges the identical object it
// always did.
export const GATE_OVERRIDES = {
	build: {
		outDir: 'dist-gate',
		emptyOutDir: true,
		rollupOptions: {
			input: fileURLToPath(new URL('./test/browser/election-shell-gate.html', import.meta.url)),
		},
	},
	// 53-09: the fourth point of packages/ui-web/README.md's harness contract
	// (build.outDir/build.rollupOptions.input/build.emptyOutDir/publicDir:
	// false). 56-06 audit: `public/` now exists (the D-20 favicon set + the
	// D-13 config template), which makes this override LOAD-BEARING rather
	// than anticipatory. It stays `false` because this config's entry is
	// `election-shell-gate.html`, never `index.html` — the gate mounts
	// components against fixtures and neither loads icons nor boots the peer
	// layer, so it needs neither. Keeping it also makes `dist-gate/` a
	// genuine `publicDir: false` artefact, which Task 3's D-20 assets-gate
	// negative control depends on: a build that provably omits `public/`.
	publicDir: false,
};

export default mergeConfig(base, GATE_OVERRIDES);
