/**
 * vite.chart-geometry.config.ts — the D-24 chart-geometry gate's own build
 * config (60-07). Modelled file-for-file on `vite.gate.config.ts`: imports
 * and MERGES the app's own `../../vite.config` — this file never re-states
 * an inherited plugin array, an inherited module-resolution override, or
 * either dev-time port key — so everything that makes the production build
 * production-SHAPED (the module-single-copy fix, the zero-Node-polyfill
 * plugin set) is INHERITED, not restated. Re-stating that module-resolution
 * override here would break the repo's existing single-copy-removed
 * inversion control the same way `vite.gate.config.ts`'s own header
 * explains for its own gate.
 *
 * `root` is set explicitly (via `fileURLToPath`) rather than left to the
 * invoking cwd, so the build's behaviour does not depend on which directory
 * `vite build --config` happens to be run from.
 *
 * `build.outDir` is `dist-chart-geometry`, at the APP ROOT — deliberately
 * NOT under `test/browser/`, for two reasons: the root `.gitignore`'s bare
 * `dist` rule matches only an entry named exactly `dist` (a `dist-*`
 * sibling needs its own app-local `.gitignore` line, added alongside this
 * file), and `tsconfig.json`'s `include` covers `test/` with `checkJs` on,
 * so a built `.js` chunk left under `test/` would itself be typechecked.
 *
 * `CHART_GEOMETRY_OVERRIDES` is exported by name, separately from the
 * merged default export, mirroring `vite.gate.config.ts`'s own
 * `GATE_OVERRIDES` export — kept for the same future inversion-tooling
 * shape, even though this gate has no mutant-config consumer today.
 */
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import baseConfig from '../../vite.config';

const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// vite.config.ts's own export is a plain UserConfig object today (never a
// function) — the `as any` call below only ever matters if that ever
// changes to the `(env) => UserConfig` form; TypeScript otherwise narrows
// the `typeof === 'function'` branch to `never` and refuses the call.
const resolvedBaseConfig =
	typeof baseConfig === 'function' ? (baseConfig as any)({ command: 'build', mode: 'production' }) : baseConfig;

export const CHART_GEOMETRY_OVERRIDES = {
	root: APP_ROOT,
	build: {
		outDir: fileURLToPath(new URL('../../dist-chart-geometry', import.meta.url)),
		emptyOutDir: true,
		rollupOptions: {
			input: fileURLToPath(new URL('./chart-geometry-gate.html', import.meta.url)),
		},
	},
	publicDir: false,
};

export default mergeConfig(resolvedBaseConfig, CHART_GEOMETRY_OVERRIDES);
