/**
 * vite.gap-probe.config.ts — throwaway build config for `gap-probe.tsx`,
 * modelled on `vite.chart-geometry.config.ts` (same MERGE-not-restate
 * discipline: everything that makes the build production-SHAPED is
 * inherited from `../../vite.config`, never re-stated here).
 *
 * This is a Nyquist gap-closure measurement harness only (G8/G9/G10 in
 * `.planning/phases/60-.../deferred-items.md`'s WR-01/WR-02/WR-03 entries).
 * It is NOT wired into any package.json script and NOT referenced by
 * `web-gates.yml` — it exists purely so `measure-gap-probe.mjs` can build and
 * observe real Recharts DOM for three specific edge shapes that no existing
 * gate fixture reaches.
 */
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import baseConfig from '../../vite.config';

const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const resolvedBaseConfig =
	typeof baseConfig === 'function' ? (baseConfig as any)({ command: 'build', mode: 'production' }) : baseConfig;

export const GAP_PROBE_OVERRIDES = {
	root: APP_ROOT,
	build: {
		outDir: fileURLToPath(new URL('../../dist-gap-probe', import.meta.url)),
		emptyOutDir: true,
		rollupOptions: {
			input: fileURLToPath(new URL('./gap-probe.html', import.meta.url)),
		},
	},
	publicDir: false,
};

export default mergeConfig(resolvedBaseConfig, GAP_PROBE_OVERRIDES);
