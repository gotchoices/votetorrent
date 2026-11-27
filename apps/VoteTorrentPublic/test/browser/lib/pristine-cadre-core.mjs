#!/usr/bin/env node
/**
 * pristine-cadre-core.mjs — the pristine-bytes helper 56-13's master control
 * (D-05.1) is built on: materialise an UNPATCHED `@serfab/cadre-core` from
 * the registry, ask 56-08's own provenance CLI what it thinks of a package
 * root, and swap the gateway's resolved copy for the pristine one with a
 * guaranteed restore.
 *
 * ── STANDING WARNING, READ BEFORE RUNNING ANYTHING IN THIS FILE ───────────
 *
 * `withRevertedProbeHostCadreCore` MUTATES INSTALLED DEPENDENCY BYTES in the
 * shared checkout for the duration of one control leg. Two consequences, both
 * previously paid for in this project:
 *
 *   1. A second session working in the SAME tree must not run it concurrently
 *      (`project_shared_checkout_concurrent_session_hazard`). While the swap
 *      is in flight, every process in this checkout that resolves
 *      `@serfab/cadre-core` from `packages/p2p-probe-host` loads UNPATCHED
 *      bytes — a gateway booted by anyone else during that window will refuse
 *      provenance and look like a code defect.
 *   2. CadreNode boot is CPU-heavy enough that a busy host has manufactured
 *      false failures before (`project_voter_emulator_boot_needs_quiet_host`)
 *      — do not run this alongside `nx run-many` or any other CPU-heavy task.
 *
 * ── WHAT THIS FILE DELIBERATELY DOES NOT DO ──────────────────────────────
 *
 * It never re-derives provenance. 56-08 shipped `node gateway.mjs
 * --check-dist <dir>`, which runs the SAME decision matrix the gateway's own
 * boot gate runs, and this file CONSUMES it as a verdict. Two copies of a
 * provenance check are two instruments that diverge silently — and consuming
 * the CLI is also why nothing in this file (or anywhere in 56-13) needs to
 * write the protocol token that check looks for, which is the
 * self-tripping-checker failure this repo has paid for three times
 * (`project_self_tripping_checker_headers`).
 *
 * It also never INSTALLS the pristine copy. The tarball is unpacked into a
 * scratch directory and used only as a comparison target and a
 * module-resolution redirect target; no manifest gains a dependency and
 * `yarn.lock` is never written.
 *
 * ── ONE MEASURED CAVEAT, RECORDED BECAUSE IT COSTS A RUN TO REDISCOVER ────
 *
 * An unpacked tarball is a BARE package root: it has no `node_modules` of its
 * own. That is exactly right for `checkDistVerdict` (which reads the package's
 * own files) and for `withRevertedProbeHostCadreCore` (which drops the copy
 * INTO a resolved `node_modules` position, where the surrounding tree supplies
 * the dependencies). It is NOT sufficient, on its own, for a BUNDLER redirect:
 * measured live on 2026-09-07, a `vite build` with the `cadre-patch-reverted`
 * mutation pointed at a bare unpacked directory redirects correctly
 * (`.mutation-report.json` records `removals: 1`, `redirected: ["."]`) and
 * then fails resolving the pristine package's OWN bare dependency imports —
 * `Rollup failed to resolve import "@serfab/quereus-plugin-sereus" from
 * <pristineDir>/dist/types.js`. That failure is downstream of the mutation,
 * not a property of it, and any leg that builds a production variant from a
 * pristine directory must first place that directory somewhere its transitive
 * bare specifiers resolve. Recorded here as a precondition, not solved here:
 * the leg that needs it does not run this round.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..', '..', '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');
const PROBE_HOST = path.join(REPO_ROOT, 'packages', 'p2p-probe-host');
const GATEWAY_SCRIPT = path.join(PROBE_HOST, 'gateway.mjs');

/** The package this helper materialises, pinned. */
const CADRE_CORE_SPECIFIER = '@serfab/cadre-core';

/**
 * The exact version the master control compares against. Pinned, never
 * floated: a control that fetched "whatever is latest" would compare the
 * patched workspace copy against a moving target and could report a
 * load-bearing verdict about a version this repo does not resolve.
 * @type {string}
 */
export const PRISTINE_CADRE_CORE_VERSION = '0.12.0';

/** Where the patched copy the gateway actually resolves lives (56-13 fact 7:
 * `nmHoistingLimits: workspaces`, so there is no root copy and the three
 * workspace copies are independent). */
const PROBE_HOST_PACKAGE_DIR = path.join(PROBE_HOST, 'node_modules', CADRE_CORE_SPECIFIER);

/** The aside-name the swap moves the patched copy to. Its PRESENCE on entry
 * means a previous run aborted between the move and the restore, and is a
 * refusal — never something to clean up silently, because "clean up" and
 * "compound the damage" are indistinguishable from inside a broken run. */
const BACKUP_DIR = `${PROBE_HOST_PACKAGE_DIR}.56-13-backup`;

/**
 * Run a command, capturing both streams. Never `shell: true`.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (d) => {
			stdout += d;
		});
		child.stderr.on('data', (d) => {
			stderr += d;
		});
		child.on('error', reject);
		child.on('exit', (code) => resolve({ code, stdout, stderr }));
	});
}

/**
 * Ask 56-08's shipped provenance CLI what it thinks of an arbitrary package
 * root. The verdict string is parsed from the `PROVENANCE=` line the CLI
 * already prints (`PASS` or `FAIL:<reason>`); the decision matrix behind it
 * is the gateway's own and is never re-implemented here.
 *
 * @param {string} dir a `@serfab/cadre-core` package ROOT
 * @returns {Promise<{ verdict: string, exitCode: number | null, line: string }>}
 */
export async function checkDistVerdict(dir) {
	const { code, stdout, stderr } = await run(process.execPath, [GATEWAY_SCRIPT, '--check-dist', path.resolve(dir)], {
		cwd: PROBE_HOST,
	});
	const combined = `${stdout}\n${stderr}`;
	const match = combined.match(/PROVENANCE=([^\s]+)/);
	if (!match) {
		throw new Error(
			`checkDistVerdict("${dir}"): gateway.mjs --check-dist printed no PROVENANCE= line (exit ${code}). ` +
				'A missing verdict is never treated as a passing one.',
		);
	}
	return { verdict: match[1], exitCode: code, line: combined.split('\n').find((l) => l.includes('PROVENANCE=')) ?? '' };
}

/**
 * `npm pack @serfab/cadre-core@0.12.0` into `scratchDir`, unpack it, and
 * REFUSE unless the result is what this control assumes it is:
 *
 *   - the unpacked `package.json` version is exactly the pinned one, and
 *   - 56-08's `--check-dist` returns a FAIL verdict on it.
 *
 * The second refusal is the load-bearing one. A "pristine" copy that PASSED
 * provenance would mean the registry no longer serves the bytes this control
 * assumes — continuing from there would build a "reverted" variant that is
 * not reverted at all and would silently invert nothing.
 *
 * @param {{ scratchDir: string }} options
 * @returns {Promise<{ dir: string, tarballSha256: string, verdict: string }>}
 */
export async function materializePristineCadreCore({ scratchDir }) {
	const root = path.resolve(scratchDir);
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });

	const packed = await run('npm', ['pack', `${CADRE_CORE_SPECIFIER}@${PRISTINE_CADRE_CORE_VERSION}`, '--silent'], {
		cwd: root,
	});
	if (packed.code !== 0) {
		throw new Error(
			`npm pack ${CADRE_CORE_SPECIFIER}@${PRISTINE_CADRE_CORE_VERSION} exited ${packed.code}: ${packed.stderr.trim()}`,
		);
	}
	const tarball = readdirSync(root).find((name) => name.endsWith('.tgz'));
	if (!tarball) {
		throw new Error(`npm pack produced no .tgz in ${root} (stdout: ${packed.stdout.trim()})`);
	}
	const tarballPath = path.join(root, tarball);
	const tarballSha256 = createHash('sha256').update(readFileSync(tarballPath)).digest('hex');

	const untarred = await run('tar', ['xzf', tarballPath, '-C', root]);
	if (untarred.code !== 0) {
		throw new Error(`tar xzf ${tarballPath} exited ${untarred.code}: ${untarred.stderr.trim()}`);
	}
	const dir = path.join(root, 'package');
	const manifestPath = path.join(dir, 'package.json');
	if (!existsSync(manifestPath)) {
		throw new Error(`the unpacked tarball has no package.json at ${manifestPath}`);
	}
	/** @type {Record<string, any>} */
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	if (manifest.name !== CADRE_CORE_SPECIFIER || manifest.version !== PRISTINE_CADRE_CORE_VERSION) {
		throw new Error(
			`the unpacked tarball is ${manifest.name}@${manifest.version}, not ` +
				`${CADRE_CORE_SPECIFIER}@${PRISTINE_CADRE_CORE_VERSION} — refusing to compare against the wrong baseline.`,
		);
	}

	const { verdict } = await checkDistVerdict(dir);
	if (!verdict.startsWith('FAIL')) {
		throw new Error(
			`the "pristine" copy at ${dir} returned PROVENANCE=${verdict}. A pristine copy that PASSES provenance means ` +
				'the registry no longer serves unpatched bytes for this version, so the revert would invert nothing. ' +
				'Refusing loudly rather than reporting a control that could not fail.',
		);
	}

	return { dir, tarballSha256, verdict };
}

/**
 * Swap the gateway's resolved `@serfab/cadre-core` for `pristineDir`, run
 * `fn`, and restore the patched copy — in a `finally`, and again from
 * `SIGINT`/`SIGTERM`, so an aborted control never leaves reverted bytes in a
 * shared checkout (T-56-13-03).
 *
 * Refusals, all before anything is moved:
 *   - a leftover backup marker from an aborted run (prints the manual
 *     recovery command rather than compounding the damage);
 *   - a live copy that does not already PASS `--check-dist` (there is no
 *     patched state to restore TO, so a revert would be unattributable).
 *
 * @template T
 * @param {string} pristineDir
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withRevertedProbeHostCadreCore(pristineDir, fn) {
	if (existsSync(BACKUP_DIR)) {
		throw new Error(
			`REFUSING TO START: a leftover backup from an aborted run exists at\n  ${BACKUP_DIR}\n` +
				'The gateway\'s resolved package may currently hold reverted bytes. Recover MANUALLY, then re-run:\n' +
				`  rm -rf "${PROBE_HOST_PACKAGE_DIR}" && mv "${BACKUP_DIR}" "${PROBE_HOST_PACKAGE_DIR}"\n` +
				'This is deliberately not automatic: from inside a broken run, "clean up" and "compound the damage" are ' +
				'indistinguishable.',
		);
	}
	if (!existsSync(PROBE_HOST_PACKAGE_DIR)) {
		throw new Error(`REFUSING TO START: no resolved package at ${PROBE_HOST_PACKAGE_DIR}`);
	}
	const before = await checkDistVerdict(PROBE_HOST_PACKAGE_DIR);
	if (before.verdict !== 'PASS') {
		throw new Error(
			`REFUSING TO START: the live copy at ${PROBE_HOST_PACKAGE_DIR} reports PROVENANCE=${before.verdict}, not PASS. ` +
				'There is no patched state to revert FROM, so any failure observed under the swap would be unattributable.',
		);
	}
	if (!existsSync(path.join(pristineDir, 'package.json'))) {
		throw new Error(`REFUSING TO START: no package.json under the pristine dir ${pristineDir}`);
	}

	let restored = false;
	const restore = () => {
		if (restored) return;
		restored = true;
		try {
			rmSync(PROBE_HOST_PACKAGE_DIR, { recursive: true, force: true });
			if (existsSync(BACKUP_DIR)) renameSync(BACKUP_DIR, PROBE_HOST_PACKAGE_DIR);
		} catch (err) {
			console.error(
				`[pristine-cadre-core] RESTORE FAILED — recover manually with:\n` +
					`  rm -rf "${PROBE_HOST_PACKAGE_DIR}" && mv "${BACKUP_DIR}" "${PROBE_HOST_PACKAGE_DIR}"\n`,
				err,
			);
		}
	};
	/** @type {Array<[NodeJS.Signals, () => void]>} */
	const signalHandlers = [];
	for (const signal of /** @type {NodeJS.Signals[]} */ (['SIGINT', 'SIGTERM'])) {
		const handler = () => {
			restore();
			process.exit(1);
		};
		signalHandlers.push([signal, handler]);
		process.on(signal, handler);
	}

	try {
		renameSync(PROBE_HOST_PACKAGE_DIR, BACKUP_DIR);
		cpSync(pristineDir, PROBE_HOST_PACKAGE_DIR, { recursive: true });
		const swapped = await checkDistVerdict(PROBE_HOST_PACKAGE_DIR);
		if (swapped.verdict === 'PASS') {
			throw new Error(
				`the swap did not take: ${PROBE_HOST_PACKAGE_DIR} still reports PROVENANCE=PASS after the pristine copy ` +
					'was written over it. A leg run in this state would grade the patched bytes while claiming to grade reverted ones.',
			);
		}
		return await fn({ revertedVerdict: swapped.verdict });
	} finally {
		restore();
		for (const [signal, handler] of signalHandlers) process.off(signal, handler);
		const after = await checkDistVerdict(PROBE_HOST_PACKAGE_DIR);
		if (after.verdict !== 'PASS') {
			throw new Error(
				`RESTORE VERIFICATION FAILED: ${PROBE_HOST_PACKAGE_DIR} reports PROVENANCE=${after.verdict} after restore. ` +
					'The checkout may be poisoned for every other process and session in this tree — recover before doing anything else.',
			);
		}
	}
}

/** The paths this helper touches, exported so a runner can print them rather
 * than re-deriving them. */
export const PRISTINE_CADRE_CORE_PATHS = Object.freeze({
	probeHost: PROBE_HOST,
	gatewayScript: GATEWAY_SCRIPT,
	livePackageDir: PROBE_HOST_PACKAGE_DIR,
	backupDir: BACKUP_DIR,
});
