/**
 * vite.mutant.config.ts — the public app's MUTANT build config (53-11, D-20).
 *
 * This config exists ONLY to produce a deliberately broken bundle for a
 * negative control (`--prove-no-dedupe` / `--prove-token-missing` in
 * `packages/ui-web/scripts/run-ui-gates.mjs`). Its output is never served,
 * never deployed and never committed — `dist-mutant-` + the mutation name is gitignored
 * app-locally (see `.gitignore`, beside 53-07's `dist-gate` entry). It
 * cannot run at all without `UI_GATE_MUTATION` naming a known mutation
 * (`resolveMutation()` throws at module scope, before Vite does anything),
 * which is what stops this file from ever becoming a second, quietly-healthy
 * shipping path — mirroring the binding-rule discipline `vite.config.ts`'s
 * own header comment states for that file.
 *
 * Merges the app's own PRODUCTION config (`./vite.config`) with its own GATE
 * overrides (`./vite.gate.config`'s named `GATE_OVERRIDES` export, not its
 * merged default export — the two halves `applyNoDedupe` needs separately),
 * applies exactly the selected mutation, then overrides ONLY
 * `build.outDir`/`build.emptyOutDir` to land in a mutation-named, gitignored
 * directory. Nothing else about the build is overridden — same
 * `build.target`, same harness entry, same everything the healthy gate
 * build already uses, or a control run against this bundle would be
 * inverting a different build than the one it claims to invert.
 *
 * 56-06 `publicDir` audit: this file declares no `publicDir` key of its
 * own and must not gain one — it inherits `false` from `GATE_OVERRIDES`
 * (via `./vite.gate.config`), and "nothing else about the build is
 * overridden" above already covers this.
 */
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import baseConfig from './vite.config';
import { GATE_OVERRIDES } from './vite.gate.config';
import { MESH_READ_OVERRIDES } from './vite.mesh-read.config';
import {
	resolveMutation,
	applyNoDedupe,
	stripTokensPlugin,
	flattenGapCuesPlugin,
	revertPillRetonePlugin,
	redirectCadreCorePlugin,
	stripPeerNotifyPlugin,
	writeMutationReportPlugin,
} from '@votetorrent/ui-web/mutations';

// Throws before Vite does anything if UI_GATE_MUTATION is unset, empty, or unknown.
const mutation = resolveMutation();

const OUT_DIR = fileURLToPath(new URL(`./dist-mutant-${mutation}`, import.meta.url));

// vite.config.ts's own export is a plain UserConfig object today (never a
// function) — mirrors vite.gate.config.ts's own `as any` note.
const resolvedBaseConfig =
	typeof baseConfig === 'function' ? (baseConfig as any)({ command: 'build', mode: 'production' }) : baseConfig;

let mutatedConfig: Record<string, any>;

if (mutation === 'no-dedupe') {
	const { config, report } = applyNoDedupe(resolvedBaseConfig, GATE_OVERRIDES, 'apps/VoteTorrentPublic/vite.config.ts');
	mutatedConfig = mergeConfig(config, {
		plugins: [
			writeMutationReportPlugin({ mutation, removedDedupe: report.removedDedupe, selfReference: report.selfReference }),
		],
	});
} else if (mutation === 'token-missing') {
	// token-missing: the gate build's own shape, unchanged, plus the
	// token-stripping plugin — no config-level mutation, the mutation is
	// entirely inside the Vite plugin pipeline.
	const merged = mergeConfig(resolvedBaseConfig, GATE_OVERRIDES);
	mutatedConfig = mergeConfig(merged, { plugins: [stripTokensPlugin()] });
} else if (mutation === 'gap-cues-flattened') {
	// gap-cues-flattened: same shape again, plus the plugin that empties the
	// gap-card rule's declaration body. Applied to SOURCE before the build,
	// never to dist and never at runtime.
	const merged = mergeConfig(resolvedBaseConfig, GATE_OVERRIDES);
	mutatedConfig = mergeConfig(merged, { plugins: [flattenGapCuesPlugin()] });
} else if (mutation === 'pill-retone-reverted') {
	// pill-retone-reverted (56-03 Task 3): same shape again, plus the plugin
	// that restores the PRE-retone declarations on
	// `.lifecycle-pill--indeterminate`. Applied to SOURCE before the build,
	// never to dist and never at runtime.
	const merged = mergeConfig(resolvedBaseConfig, GATE_OVERRIDES);
	mutatedConfig = mergeConfig(merged, { plugins: [revertPillRetonePlugin()] });
} else if (mutation === 'cadre-patch-reverted') {
	// 56-13 Task 1: same shape as the token-missing branch — the mutation
	// lives entirely in the Vite plugin pipeline — plus the plugin that
	// redirects every @serfab/cadre-core specifier to a PRISTINE, unpatched
	// copy of the package. It is a module-RESOLUTION redirect, never a dist
	// edit; see the plugin's own header for the measured reason. It throws at
	// plugin construction when UI_GATE_PRISTINE_CADRE_CORE is unset, so a
	// mutant build with no redirect target never emits a bundle at all.
	//
	// MESH_READ_OVERRIDES, NOT GATE_OVERRIDES, and the reason is MEASURED,
	// not stylistic. GATE_OVERRIDES builds `election-shell-gate.html`, a
	// pure-UI entry whose closure contains no peer layer at all: a build made
	// through it redirects ZERO specifiers and dies on this plugin's own
	// `MUTATION IS A NO-OP` guard every single time, whatever the package
	// bytes say — an inversion that can never fire is exactly the
	// green-that-cannot-fail this mutation exists to prevent. The entry whose
	// closure actually resolves the package, and the entry the control that
	// drives this mutation then serves, is the mesh-read gate's. The trailing
	// outDir/emptyOutDir override below still lands the result in the
	// mutation-named, gitignored directory, so `dist-mesh-read/` is untouched.
	const merged = mergeConfig(resolvedBaseConfig, MESH_READ_OVERRIDES);
	mutatedConfig = mergeConfig(merged, { plugins: [redirectCadreCorePlugin()] });
} else if (mutation === 'notify-disabled') {
	// 56-13 Task 1: same shape again, plus the plugin that removes the ONE
	// single-line peer-notify statement from the replication bridge. Applied
	// to SOURCE before the build, never to dist and never at runtime.
	//
	// MESH_READ_OVERRIDES for the same MEASURED reason as the branch above,
	// and one more that is specific to this mutation: the statement it
	// removes lives in `src/peer/reactivity-bridge.js`, which the shell-gate
	// entry's closure never imports. Built through GATE_OVERRIDES this
	// mutation is a permanent no-op; built through the mesh-read entry it
	// reaches the module the liveness rungs it inverts actually depend on.
	const merged = mergeConfig(resolvedBaseConfig, MESH_READ_OVERRIDES);
	mutatedConfig = mergeConfig(merged, { plugins: [stripPeerNotifyPlugin()] });
} else {
	// FAIL-CLOSED, and the reason this is not a bare `else`. Until 53-11 the
	// trailing branch treated ANY non-`no-dedupe` value as `token-missing`.
	// With two mutations that was merely lucky; with three (now six) it is a
	// fail-open — a control believing it had built one
	// variant would actually be driving a different one and would report a
	// shape nobody asked for. `resolveMutation()` validates the name against
	// MUTATIONS globally, so a name this file does not handle is a real gap
	// here, not an unknown value, and must say so.
	throw new Error(
		`vite.mutant.config.ts (VoteTorrentPublic): UI_GATE_MUTATION="${mutation}" is a known mutation that this app's ` +
			'mutant config does not handle. Refusing to build rather than silently producing a different mutation than the one requested.',
	);
}

export default mergeConfig(mutatedConfig, {
	build: {
		outDir: OUT_DIR,
		emptyOutDir: true,
	},
});
