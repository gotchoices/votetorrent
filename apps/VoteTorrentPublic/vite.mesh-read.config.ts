import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import base from './vite.config';

// vite.mesh-read.config.ts — the build config for 56-11's mesh-read gate.
//
// Same shape and the SAME BINDING RULE as `vite.live.config.ts` and
// `vite.gate.config.ts`: it inherits `base` (this app's own `vite.config.ts`)
// through `mergeConfig` and adds ONLY `build.outDir`, `build.emptyOutDir`,
// `build.rollupOptions.input` and `publicDir`. It declares NO `resolve` key,
// NO `plugins` key and NO `server`/`preview` key of its own.
//
// That absence is a CONTROL, not tidiness — `53-11`'s D-20 negative control
// removes `resolve.dedupe` from `vite.config.ts` and requires the identity
// gate built from it to fail. A config with its own `resolve` block would
// make that mutation unreachable from a build made through this file.
// NEVER add a `resolve`, `plugins` or `server`/`preview` key here.
export const MESH_READ_OVERRIDES = {
	build: {
		outDir: 'dist-mesh-read',
		emptyOutDir: true,
		rollupOptions: {
			input: fileURLToPath(new URL('./test/browser/mesh-read-gate.html', import.meta.url)),
		},
	},
	// `56-06`'s verdict table recommends `publicDir: false` for this gate's
	// config specifically, for its own reason (restated here as this file's
	// own sentence, not copied from a sibling): the gateway's peerId is
	// minted per run, so a build-time-copied `config.json` would be stale by
	// construction. This gate writes its OWN `config.json` (and its own
	// `gate-expectations.json`) into `dist-mesh-read/` at RUNTIME, after the
	// build, so `emptyOutDir` cannot erase them — see `run-mesh-read-gate.mjs`.
	publicDir: false,
};

export default mergeConfig(base, MESH_READ_OVERRIDES);
