/**
 * vite.mutant.config.ts — the dashboard's MUTANT build config (53-11, D-20).
 *
 * This config exists ONLY to produce a deliberately broken bundle for a
 * negative control (`--prove-no-dedupe` / `--prove-token-missing` in
 * `packages/ui-web/scripts/run-ui-gates.mjs`). Its output is never served,
 * never deployed and never committed — `dist-mutant-` + the mutation name is gitignored
 * app-locally (see `.gitignore`). It cannot run at all without
 * `UI_GATE_MUTATION` naming a known mutation (`resolveMutation()` throws at
 * module scope, before Vite does anything), which is what stops this file
 * from ever becoming a second, quietly-healthy shipping path — mirroring the
 * binding-rule discipline `vite.config.ts`'s own D-19 header comment states
 * for that file.
 *
 * Merges the app's own PRODUCTION config (`./vite.config`) with its own GATE
 * overrides (`./test/browser/vite.gate.config`'s named `GATE_OVERRIDES`
 * export, not its merged default export — the two halves `applyNoDedupe`
 * needs separately), applies exactly the selected mutation, then overrides
 * ONLY `build.outDir`/`build.emptyOutDir` to land in a mutation-named,
 * gitignored directory. Nothing else about the build is overridden — same
 * `build.target`, same harness entry, same everything the healthy gate
 * build already uses, or a control run against this bundle would be
 * inverting a different build than the one it claims to invert.
 */
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import baseConfig from './vite.config';
import { GATE_OVERRIDES } from './test/browser/vite.gate.config';
import { resolveMutation, applyNoDedupe, stripTokensPlugin, writeMutationReportPlugin } from '@votetorrent/ui-web/mutations';

// Throws before Vite does anything if UI_GATE_MUTATION is unset, empty, or unknown.
const mutation = resolveMutation();

const OUT_DIR = fileURLToPath(new URL(`./dist-mutant-${mutation}`, import.meta.url));

// vite.config.ts's own export is a plain UserConfig object today (never a
// function) — mirrors test/browser/vite.gate.config.ts's own `as any` note.
const resolvedBaseConfig =
	typeof baseConfig === 'function' ? (baseConfig as any)({ command: 'build', mode: 'production' }) : baseConfig;

let mutatedConfig: Record<string, any>;

if (mutation === 'no-dedupe') {
	const { config, report } = applyNoDedupe(
		resolvedBaseConfig,
		GATE_OVERRIDES,
		'apps/VoteTorrentDashboard/vite.config.ts',
	);
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
} else {
	// FAIL-CLOSED, and the reason this is not a bare `else`. Until this
	// commit the trailing branch treated ANY non-`no-dedupe` value as
	// `token-missing`, so `UI_GATE_MUTATION=gap-cues-flattened` here would
	// have silently built a token-stripped variant — measured.
	//
	// The dashboard DELIBERATELY has no `gap-cues-flattened` branch: that
	// mutation flattens the public election view's gap-card rule, and this
	// app renders no `.fact-card` surface at all, so a branch here would
	// build something with nothing to mutate. It still needs this throw,
	// because `resolveMutation()` accepts the name GLOBALLY — the absence of
	// the branch is only safe while the unhandled case is loud.
	throw new Error(
		`vite.mutant.config.ts (VoteTorrentDashboard): UI_GATE_MUTATION="${mutation}" is a known mutation that this app's ` +
			'mutant config does not handle (this app renders no gap-card surface). Refusing to build rather than silently ' +
			'producing a different mutation than the one requested.',
	);
}

export default mergeConfig(mutatedConfig, {
	build: {
		outDir: OUT_DIR,
		emptyOutDir: true,
	},
});
