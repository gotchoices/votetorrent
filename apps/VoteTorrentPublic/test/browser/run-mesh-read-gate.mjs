#!/usr/bin/env node
/**
 * run-mesh-read-gate.mjs — the driver: origin preflight, runtime
 * config/expectations emission, pinned-TLS browser launch, rung grading, and
 * the exported liveness-rung id list `56-13` consumes.
 *
 * Usage, from `apps/VoteTorrentPublic`:
 *
 *   NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" node test/browser/run-mesh-read-gate.mjs
 *
 * `56-08`'s user_setup (inherited, not re-decided here): `mkcert -install`
 * must already have been run on this host, and this gate dials the
 * gateway's REAL WSS listener from a real Chromium — it does not disable
 * TLS validation, it PINS the leaf's SPKI.
 *
 * `vite build` is SPAWNED, never imported, so the gate exercises a real
 * artefact of a real build — same discipline `run-live-read-gate.mjs`
 * established. This driver binds port 5197 (the settled map in
 * `56-PLAN-OUTLINE.md` Amendment 3) and fails loudly on `EADDRINUSE` rather
 * than silently grading another server's page.
 *
 * FAILURE TAXONOMY, on stderr: `PREFLIGHT_FAILED:<reason>` for every way
 * this gate could certify something false before a browser is launched (a
 * `PreflightFailedError`, thrown from anywhere in the run — including
 * post-launch checks like the served-bundle-provenance value check and the
 * origin-mutate handshake, both of which are preconditions for a
 * MEANINGFUL grade, not a graded rung themselves); `RUNGS_FAILED` for every
 * other failure, once rungs actually ran. The origin is ALWAYS told to stop
 * and its exit ALWAYS awaited, in one `finally`, regardless of which path
 * was taken — an aborted run must leave no orphaned CadreNode.
 *
 * DELIBERATELY NOT WIRED into a `gate:prove-*` script: `56-13` owns every
 * inversion this gate's design makes possible. Adding one here would be
 * this plan claiming a control it does not run.
 *
 * CALLABLE AS A LIBRARY (`56-13` Task 1), behaviour byte-identical. The
 * driver is `runMeshReadGate(options)`; the CLI entry below is guarded on
 * `process.argv[1]` exactly as `56-11` guarded `gateway.mjs`, so
 * `node test/browser/run-mesh-read-gate.mjs` and `yarn test:mesh-read`
 * behave precisely as `56-11` shipped them. `options` carries a build config
 * path, a served `outDir`, an origin config path, a port and a strand id,
 * each defaulting to `56-11`'s own value (`MESH_READ_GATE_DEFAULTS`).
 *
 * THREE PROHIBITIONS ON THIS FILE, each load-bearing:
 *   1. NOTHING MOVES OUT OF IT. `56-11`'s acceptance greps run against this
 *      path — exactly one `page.goto`, zero reload calls, the
 *      certificate-pin occurrence set, and zero must-fail vocabulary.
 *      Relocating the driver into a `lib/` module would silently retire all
 *      four.
 *   2. NO `--prove-*` FLAG AND NO MUST-FAIL LIST IS ADDED HERE. Every
 *      inversion vocabulary item lives in `56-13`'s own control files, so
 *      `56-11`'s "this plan claims no inversion" property keeps holding for
 *      the file it was asserted on.
 *   3. NO PREFLIGHT IS WEAKENED, SKIPPED OR MADE OPTIONAL. There is no
 *      `options` key that can disable one — that would be the exact bypass
 *      `T-56-11-01` exists to prevent.
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';

import { chromium } from 'playwright';
import { serveDist } from '../../../../packages/ui-web/scripts/lib/serve-dist.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');
const DIST_MESH_READ = path.join(APP_ROOT, 'dist-mesh-read');
const BUILD_CONFIG = 'vite.mesh-read.config.ts';
const ENTRY_NAME = 'mesh-read-gate.html';
const ORIGIN_SCRIPT = path.join(APP_ROOT, 'test', 'browser', 'mesh-read-origin.mjs');
const GATEWAY_CONFIG = path.join(REPO_ROOT, 'packages', 'p2p-probe-host', 'gateway.config.json');
const PORT = 5197;

/**
 * `56-11`'s own values, exported as the default `options` every caller of
 * `runMeshReadGate` inherits. A caller that passes nothing gets exactly the
 * run `yarn test:mesh-read` has always performed.
 * @type {Readonly<{ buildConfig: string, outDir: string, entryName: string, originConfig: string, port: number }>}
 */
export const MESH_READ_GATE_DEFAULTS = Object.freeze({
	buildConfig: BUILD_CONFIG,
	outDir: DIST_MESH_READ,
	entryName: ENTRY_NAME,
	originConfig: GATEWAY_CONFIG,
	port: PORT,
});

/** The D-16 inversion's exact rung ids — exported so `56-13` imports this
 * contract instead of re-typing two integers that can drift.
 * @type {ReadonlyArray<number>} */
export const LIVENESS_RUNGS = Object.freeze([9, 10]);
/** @type {number} */
export const TOTAL_RUNGS = 10;

/**
 * `56-24`: the exact `weald` (the `@libp2p/logger` wrapper) namespace list
 * enabled on the page BEFORE any page script runs, so libp2p's OWN dial-path
 * diagnostics reach this driver's captured console instead of being
 * swallowed into a logger nobody enables. Each component name below is
 * read from the app's OWN resolved `node_modules`, at the exact site named,
 * never guessed:
 *   - `libp2p:bootstrap` — `@libp2p/bootstrap` `dist/src/index.js:59` — the
 *     module whose fire-and-forget dial this measurement is instrumenting.
 *   - `libp2p:connection-manager` — `libp2p` `dist/src/connection-manager/index.js:55`.
 *   - `libp2p:connection-manager:dial-queue` — `libp2p`
 *     `dist/src/connection-manager/dial-queue.js:47` — the actual dial
 *     attempt path `openConnection` reaches.
 *   - `libp2p:websockets` — `@libp2p/websockets` `dist/src/index.js:39`.
 *   - `libp2p:websockets:connection` — `@libp2p/websockets`
 *     `dist/src/index.js:65`.
 * An empty string here (this driver's own negative control) disables every
 * namespace, proving the constant is load-bearing rather than dead config.
 * @type {string}
 */
export const LIBP2P_DIAL_DEBUG_NAMESPACES =
	'libp2p:bootstrap,libp2p:connection-manager,libp2p:connection-manager:dial-queue,libp2p:websockets,libp2p:websockets:connection';

/**
 * MESH_READ_DIAG=1 (diagnostic, opt-in): also arm the page's reactivity watch, subscription and
 * cohort-topic channels (`@optimystic/db-p2p` / `db-core` `createLogger` namespaces), and pass `diag=1`
 * to the page so it logs each replication pass by table and row count.
 * @type {string}
 */
export const MESH_READ_DIAG_NAMESPACES =
	'optimystic:db-p2p:reactivity-collection-watch*,optimystic:db-p2p:reactivity-subscription*,optimystic:db-p2p:reactivity-subscribers*,optimystic:db-core:cohort-topic:service*,optimystic:db-core:cohort-topic:registration*';

/** A way this gate could certify something false, named and thrown from
 * anywhere in the run — never a bare `process.exit`, so the origin is
 * always stopped and every opened resource always closed. */
export class PreflightFailedError extends Error {
	/** @param {string} reason */
	constructor(reason) {
		super(`PREFLIGHT_FAILED:${reason}`);
		this.name = 'PreflightFailedError';
		this.reason = reason;
	}
}

/**
 * Wraps the spawned origin child: parses its `ORIGIN_*` stdout lines into a
 * fact map, exposes a line-matching wait primitive for the handshake, and
 * forwards every line (both streams) into this process's own log.
 */
export class OriginController {
	/** @param {import('node:child_process').ChildProcessWithoutNullStreams} child */
	constructor(child) {
		this.child = child;
		/** @type {Record<string, string>} */
		this.facts = {};
		/** @type {string[]} */
		this.controlAddrs = [];
		/** @type {string[]} */
		this.strandAddrs = [];
		/** @type {Set<(line: string) => void>} */
		this.listeners = new Set();
		this.exited = false;
		this.exitCode = /** @type {number | null} */ (null);
		const rl = createInterface({ input: child.stdout });
		rl.on('line', (line) => this._onLine(line));
		child.stderr.on('data', (d) => process.stderr.write(`[origin] ${d}`));
		child.on('exit', (code) => {
			this.exited = true;
			this.exitCode = code;
		});
	}

	/** @param {string} line */
	_onLine(line) {
		console.log(`[origin] ${line}`);
		const eq = line.indexOf('=');
		if (eq > 0) {
			const key = line.slice(0, eq);
			const value = line.slice(eq + 1);
			if (key === 'ORIGIN_CONTROL_ADDR') this.controlAddrs.push(value);
			if (key === 'ORIGIN_STRAND_ADDR') this.strandAddrs.push(value);
			else this.facts[key] = value;
		}
		for (const fn of [...this.listeners]) fn(line);
	}

	/**
	 * @param {(line: string) => boolean} matchFn
	 * @param {number} timeoutMs
	 * @param {string} label
	 * @returns {Promise<string>}
	 */
	waitForLine(matchFn, timeoutMs, label) {
		return new Promise((resolve, reject) => {
			/** @type {(line: string) => void} */
			let listener;
			const timer = setTimeout(() => {
				this.listeners.delete(listener);
				reject(new Error(`timed out waiting for ${label}`));
			}, timeoutMs);
			listener = (line) => {
				if (matchFn(line)) {
					clearTimeout(timer);
					this.listeners.delete(listener);
					resolve(line);
				}
			};
			this.listeners.add(listener);
		});
	}

	/** @param {string} command */
	send(command) {
		this.child.stdin.write(command + '\n');
	}

	/** Sends `stop`, then awaits exit up to 10s. @returns {Promise<void>} */
	async stopAndAwaitExit() {
		try {
			this.send('stop');
		} catch {
			// The child may already be gone; nothing to do.
		}
		await new Promise((resolve) => {
			if (this.exited) {
				resolve(undefined);
				return;
			}
			this.child.once('exit', () => resolve(undefined));
			setTimeout(() => resolve(undefined), 10_000);
		});
	}
}

/**
 * The spawned-never-imported `vite build` step, exported so `56-13`'s
 * controls drive the SAME build this gate drives rather than a second copy
 * of the recipe.
 * @param {string} [buildConfig]
 * @returns {Promise<void>}
 */
export function buildGate(buildConfig = BUILD_CONFIG) {
	return new Promise((resolve, reject) => {
		const viteBin = path.join(APP_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
		const child = spawn(process.execPath, [viteBin, 'build', '--config', buildConfig], {
			cwd: APP_ROOT,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		child.stdout?.on('data', (d) => process.stdout.write(`[vite] ${d}`));
		child.stderr?.on('data', (d) => process.stderr.write(`[vite] ${d}`));
		child.on('error', reject);
		child.on('exit', (code) =>
			code === 0 ? resolve(undefined) : reject(new Error(`vite build --config ${buildConfig} exited ${code}`)),
		);
	});
}

/**
 * Walk `dir` for the one file named `name` and return its path RELATIVE to
 * `dir`. Zero matches and more than one are both hard failures.
 * @param {string} dir
 * @param {string} name
 * @returns {string}
 */
function resolveEntry(dir, name) {
	/** @type {string[]} */
	const matches = [];
	/** @param {string} current */
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name === name) matches.push(path.relative(dir, full));
		}
	};
	walk(dir);
	if (matches.length === 0) throw new Error(`the gate build emitted no "${name}" under ${dir}`);
	if (matches.length > 1) throw new Error(`the gate build emitted ${matches.length} files named "${name}": ${matches.join(', ')}`);
	return matches[0];
}

/**
 * The exact string-literal contract token, read from a comment-stripped
 * scan of the harness's own SOURCE (never from the served/built artefact) —
 * this is the value the served page must publish at runtime.
 * @returns {string}
 */
function readContractFromSource() {
	const source = readFileSync(path.join(APP_ROOT, 'test', 'browser', 'mesh-read-gate.js'), 'utf8');
	const stripped = source
		.split('\n')
		.filter((line) => !/^\s*[*/]/.test(line))
		.join('\n');
	const match = stripped.match(/MESH_READ_GATE_CONTRACT\s*=\s*'([^']+)'/);
	if (!match) throw new Error('could not find MESH_READ_GATE_CONTRACT in mesh-read-gate.js source');
	return match[1];
}

/**
 * Spawn the origin and drive it to `ORIGIN_READY`, then re-assert every
 * precondition at THIS consumer boundary — read back, never inferred from
 * the origin's own exit code alone.
 * Exported for `56-13`'s controls. NO PARAMETER CAN DISABLE A PRECONDITION:
 * every check below is unconditional, and adding an opt-out would be the
 * bypass `T-56-11-01` exists to prevent.
 *
 * @param {string} strandId
 * @param {string} [originConfig]
 * @returns {Promise<OriginController>}
 */
export async function bootOrigin(strandId, originConfig = GATEWAY_CONFIG) {
	const originChild = spawn(process.execPath, [ORIGIN_SCRIPT, '--config', originConfig, '--strand-id', strandId], {
		cwd: APP_ROOT,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	const origin = new OriginController(originChild);

	try {
		await origin.waitForLine((line) => line === 'ORIGIN_READY' || line.startsWith('ORIGIN_FATAL:'), 120_000, 'ORIGIN_READY');
	} catch (err) {
		throw new PreflightFailedError(`origin-startup-timeout: ${/** @type {any} */ (err)?.message}`);
	}
	if (origin.exited) {
		throw new PreflightFailedError(`origin-crashed: exited with code ${origin.exitCode} before ORIGIN_READY`);
	}

	if (origin.facts.ORIGIN_PROVENANCE !== 'PASS') {
		throw new PreflightFailedError(`origin-provenance: verdict is "${origin.facts.ORIGIN_PROVENANCE}", expected "PASS"`);
	}
	const authorizedMembers = Number(origin.facts.ORIGIN_AUTHORIZED_MEMBERS ?? 'NaN');
	if (!(authorizedMembers >= 1)) {
		throw new PreflightFailedError(`origin-cold-start: ORIGIN_AUTHORIZED_MEMBERS is "${origin.facts.ORIGIN_AUTHORIZED_MEMBERS}", expected >= 1`);
	}
	if (origin.facts.ORIGIN_LIVE_CADRE_INVITATIONS !== '0') {
		throw new PreflightFailedError(
			`origin-stranger-window-open: ORIGIN_LIVE_CADRE_INVITATIONS is "${origin.facts.ORIGIN_LIVE_CADRE_INVITATIONS}", expected "0"`,
		);
	}
	if (origin.controlAddrs.length === 0 || !origin.controlAddrs.every((addr) => addr.includes('/tls/ws'))) {
		throw new PreflightFailedError('origin-plaintext-addr: no ORIGIN_CONTROL_ADDR carries /tls/ws');
	}
	if (!origin.facts.ORIGIN_TLS_SPKI) {
		throw new PreflightFailedError('tls-pin-absent: ORIGIN_TLS_SPKI is empty');
	}
	if (origin.facts.ORIGIN_SEEDED !== 'ok') {
		throw new PreflightFailedError(`origin-seed: ORIGIN_SEEDED is "${origin.facts.ORIGIN_SEEDED}", expected "ok"`);
	}

	console.log('[mesh-read-gate] origin preflight PASS');
	return origin;
}

/**
 * Write the two runtime files AFTER the build so `emptyOutDir` cannot erase
 * them. 56-06's recorded reason: the peerId is minted per run, so a
 * build-time copy would be stale by construction. Exported so a control can
 * reuse the writer rather than growing a second, drifting copy of the
 * payload shape.
 *
 * @param {{ outDir: string, origin: OriginController, strandId: string }} args
 * @returns {{ config: any, expectations: any }}
 */
export function writeGateRuntimeFiles({ outDir, origin, strandId }) {
	// MESH_READ_HOST_ALIAS (experiment): libp2p's browser gater denies `localhost` and private IPs
	// (`isPrivate`), so hand the browser a non-private name that launchPinnedBrowser maps to loopback.
	const alias = process.env.MESH_READ_HOST_ALIAS;
	// MESH_READ_BOOTSTRAP=strand (experiment): bootstrap to the gateway's STRAND node, per
	// upstream's open-strand read route (sereus#23), instead of its control node.
	const baseAddr = process.env.MESH_READ_BOOTSTRAP === 'strand' ? origin.strandAddrs[0] : origin.controlAddrs[0];
	if (!baseAddr) throw new PreflightFailedError(`bootstrap-addr-absent: no ${process.env.MESH_READ_BOOTSTRAP === 'strand' ? 'ORIGIN_STRAND_ADDR' : 'ORIGIN_CONTROL_ADDR'}`);
	const bootAddr = alias
		? baseAddr.replace(/^\/ip4\/127\.0\.0\.1\/|^\/dns4\/localhost\//, `/dns4/${alias}/`)
		: baseAddr;
	const configJson = { bootstrapNodes: [bootAddr] };
	writeFileSync(path.join(outDir, 'config.json'), JSON.stringify(configJson, null, 2));
	const gateExpectations = {
		electionId: origin.facts.ORIGIN_ELECTION_ID,
		networkHash: strandId,
		title: origin.facts.ORIGIN_ELECTION_TITLE,
		atInstant: origin.facts.ORIGIN_AT_INSTANT,
		keyholdersBefore: Number(origin.facts.ORIGIN_KEYHOLDERS_BEFORE ?? '0'),
	};
	writeFileSync(path.join(outDir, 'gate-expectations.json'), JSON.stringify(gateExpectations, null, 2));
	return { config: configJson, expectations: gateExpectations };
}

/**
 * The SPKI-PINNED browser launch, exported so no control ever hand-rolls a
 * second launch and quietly drops the pin. The pin, and NOTHING else — a
 * different certificate still fails, so this gate can still fail on a bad
 * chain.
 *
 * @param {string} spkiPin the origin's reported SPKI, base64 sha256
 * @returns {Promise<import('playwright').Browser>}
 */
export async function launchPinnedBrowser(spkiPin) {
	if (!spkiPin) throw new PreflightFailedError('tls-pin-absent: refusing to launch a browser with no pin');
	return await chromium.launch({
		headless: true,
		args: [
			`--ignore-certificate-errors-spki-list=${spkiPin}`,
			...(process.env.MESH_READ_HOST_ALIAS ? [`--host-resolver-rules=MAP ${process.env.MESH_READ_HOST_ALIAS} 127.0.0.1`] : []),
		],
	});
}

/**
 * @param {OriginController} origin
 * @param {string} strandId
 * @param {{ buildConfig?: string, outDir?: string, entryName?: string, port?: number }} [options]
 * @returns {Promise<any>} the page's published readout
 */
export async function runBrowserPhase(origin, strandId, options = {}) {
	const buildConfig = options.buildConfig ?? MESH_READ_GATE_DEFAULTS.buildConfig;
	const outDir = options.outDir ?? MESH_READ_GATE_DEFAULTS.outDir;
	const entryName = options.entryName ?? MESH_READ_GATE_DEFAULTS.entryName;
	const port = options.port ?? MESH_READ_GATE_DEFAULTS.port;

	await buildGate(buildConfig);
	const entryRel = resolveEntry(outDir, entryName);

	writeGateRuntimeFiles({ outDir, origin, strandId });

	const server = await serveDist(outDir, port);
	/** @type {string[]} */
	const lines = [];
	/** @type {import('playwright').Browser | undefined} */
	let browser;
	try {
		// The pin, and NOTHING else. The bare certificate-error override is
		// forbidden; see `launchPinnedBrowser` above, which is the ONE place a
		// browser is launched in this gate and in every control built on it.
		browser = await launchPinnedBrowser(origin.facts.ORIGIN_TLS_SPKI);
		const context = await browser.newContext();
		// 56-24: enable weald's browser debug namespaces BEFORE any page script
		// runs, so libp2p's own dial-path diagnostics reach this driver's
		// captured console. `weald`'s browser build reads `localStorage`'s
		// `debug` key at module load (`dist/src/browser.js:190`), so this must
		// land before `context.newPage()` navigates anywhere. Wrapped so a
		// storage-denied context can never fail the run; touches nothing else
		// -- no rung, no pin, no navigation and no exit condition.
		try {
			await context.addInitScript((/** @type {string} */ namespaces) => {
				try {
					window.localStorage.setItem('debug', namespaces);
				} catch {
					// A storage-denied context must never fail this run.
				}
			}, process.env.MESH_READ_DIAG === '1' ? `${LIBP2P_DIAL_DEBUG_NAMESPACES},${MESH_READ_DIAG_NAMESPACES}` : LIBP2P_DIAL_DEBUG_NAMESPACES);
		} catch {
			// addInitScript itself failing must never fail this run either.
		}
		const page = await context.newPage();
		page.on('console', (m) => lines.push(`[${m.type()}] ${m.text()}`));
		page.on('pageerror', (e) => lines.push(`[pageerror] ${e.message}`));

		// ONE navigation, for the whole run. No second `page.goto` and no
		// `location.reload()` anywhere — either would prove nothing about the
		// seam.
		const url = `${server.url}/${entryRel}?network=${encodeURIComponent(strandId)}&election=${encodeURIComponent(origin.facts.ORIGIN_ELECTION_ID)}${process.env.MESH_READ_DIAG === '1' ? '&diag=1' : ''}`;
		console.log(`[mesh-read-gate] ${url}`);
		await page.goto(url, { waitUntil: 'load' });

		await page
			.waitForFunction(() => /** @type {any} */ (window).__MESH_READ_GATE_READY__ === true, null, { timeout: 240_000 })
			.catch(() => {});

		// Served-artefact provenance — a VALUE check, not a presence check.
		const expectedContract = readContractFromSource();
		const publishedContract = await page.evaluate(() => /** @type {any} */ (window).__MESH_READ_GATE__?.contract ?? null);
		if (publishedContract !== expectedContract) {
			throw new PreflightFailedError(`served-bundle-stale: served contract "${publishedContract}" !== source contract "${expectedContract}"`);
		}

		origin.send('mutate');
		const mutatedLine = await origin.waitForLine((line) => line.startsWith('ORIGIN_MUTATED='), 30_000, 'ORIGIN_MUTATED');
		if (mutatedLine !== 'ORIGIN_MUTATED=ok') {
			throw new PreflightFailedError(`origin-mutate: origin replied "${mutatedLine}"`);
		}
		await page.evaluate(() => {
			/** @type {any} */ (window).__MESH_READ_GATE_MUTATED__ = true;
		});

		await page
			.waitForFunction(() => /** @type {any} */ (window).__MESH_READ_GATE_DONE__ === true, null, { timeout: 240_000 })
			.catch(() => {});
		return await page.evaluate(() => /** @type {any} */ (window).__MESH_READ_GATE__ ?? null);
	} finally {
		console.log('\n===== page output =====');
		for (const line of lines) console.log(line);
		if (browser) await browser.close();
		await server.close();
	}
}

/**
 * The driver, callable as a library. Returns a structured result and NEVER
 * calls `process.exit` — the CLI entry below owns the exit code, so a
 * control that drives this function can grade the run rather than being
 * killed by it.
 *
 * Every preflight below is unconditional. There is deliberately no
 * `options` key that can skip, weaken or soften one.
 *
 * @param {{ buildConfig?: string, outDir?: string, entryName?: string, originConfig?: string, port?: number, strandId?: string }} [options]
 * @returns {Promise<Readonly<{ ok: boolean, exitCode: number, strandId: string, readout: any, originFacts: Record<string, string>, controlAddrs: string[], preflightReason: string | null }>>}
 */
export async function runMeshReadGate(options = {}) {
	const buildConfig = options.buildConfig ?? MESH_READ_GATE_DEFAULTS.buildConfig;
	const outDir = options.outDir ?? MESH_READ_GATE_DEFAULTS.outDir;
	const entryName = options.entryName ?? MESH_READ_GATE_DEFAULTS.entryName;
	const originConfig = options.originConfig ?? MESH_READ_GATE_DEFAULTS.originConfig;
	const port = options.port ?? MESH_READ_GATE_DEFAULTS.port;
	const strandId = options.strandId ?? `vtx-mesh-read-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
	console.log(`[mesh-read-gate] strandId=${strandId} port=${port} config=${buildConfig} out=${path.basename(outDir)}`);

	/** @type {OriginController | null} */
	let origin = null;
	let exitCode = 0;
	/** @type {any} */
	let readout = null;
	/** @type {string | null} */
	let preflightReason = null;
	try {
		origin = await bootOrigin(strandId, originConfig);
		readout = await runBrowserPhase(origin, strandId, { buildConfig, outDir, entryName, port });

		if (!readout) {
			console.error('[mesh-read-gate] NO READOUT — the page never published __MESH_READ_GATE__');
			exitCode = 1;
		} else {
			if (readout.crashed) console.error('[mesh-read-gate] CRASHED:\n' + readout.crashed);
			console.log('\n===== rungs =====');
			for (const r of readout.rungs ?? []) {
				console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${String(r.id).padStart(2)} · ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
			}
			console.log(`RUNGS: ${readout.passed}/${readout.total}`);
			console.log(`before: ${JSON.stringify(String(readout.beforeText ?? '').slice(0, 200))}`);
			console.log(`after:  ${JSON.stringify(String(readout.afterText ?? '').slice(0, 200))}`);
			console.log(`navigation entries: ${readout.navBefore} -> ${readout.navAfter}; load nonce ${readout.loadNonce}`);
			console.log(`peerId: ${readout.peerId}`);

			if (readout.passed !== readout.total || readout.total !== TOTAL_RUNGS) {
				console.error(`[mesh-read-gate] FAIL — expected ${TOTAL_RUNGS}/${TOTAL_RUNGS}, got ${readout.passed}/${readout.total}`);
				exitCode = 1;
			} else {
				console.log('[mesh-read-gate] PASS — mesh read proven, liveness proven in one page load');
			}
		}
	} catch (err) {
		if (err instanceof PreflightFailedError) {
			console.error(err.message);
			preflightReason = err.reason;
		} else {
			console.error('[mesh-read-gate] RUNGS_FAILED:', err);
		}
		exitCode = 1;
	} finally {
		// Always stop the origin and await its exit — an aborted run must leave
		// no orphaned CadreNode.
		if (origin) await origin.stopAndAwaitExit();
	}

	return Object.freeze({
		ok: exitCode === 0,
		exitCode,
		strandId,
		readout,
		originFacts: origin ? { ...origin.facts } : {},
		controlAddrs: origin ? [...origin.controlAddrs] : [],
		preflightReason,
	});
}

async function main() {
	const result = await runMeshReadGate();
	if (result.exitCode !== 0) process.exit(1);
}

// `process.argv[1]` is only set when Node loaded this file as the entry
// module — an `import()` never sets it to this file's path. The ESM
// equivalent of `require.main === module`, and the same guard `56-11` put on
// `gateway.mjs`: importing this module for its exports must never boot a run
// as a side effect of the import itself.
const isCliEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntry) {
	main().catch((err) => {
		console.error('[mesh-read-gate] driver error:', err);
		process.exit(1);
	});
}
