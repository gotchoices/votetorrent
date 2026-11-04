#!/usr/bin/env node
/**
 * run-live-mesh-gate.mjs — `gate:live-mesh` (phase 66 plan 26): the first real-node, real-browser
 * proof of the dashboard's whole pairing and live path, on the host (no device).
 *
 * Usage, from `apps/VoteTorrentDashboard`:  yarn gate:live-mesh
 * Env overrides: LIVE_MESH_HOST_ALIAS, LIVE_MESH_PORT, LIVE_MESH_RELAY_PORT, LIVE_MESH_TIMEOUT_SCALE
 * (1, or 2 only when `uptime` shows a 1- or 5-minute load at or above 6; nothing else is accepted).
 *
 * WHAT RUNS. A spawned, never-imported `vite build` of the REAL dashboard (default production
 * config) served by `serveDist` on 127.0.0.1; a spawned `live-mesh-host.mjs` (relay R reached by a
 * non-private `.test` alias, owner A, non-owner officer B; all real CadreNodes); one headless Chromium
 * launched in exactly one place with exactly two flags: one maps the alias to 127.0.0.1, the other
 * pins THIS run's relay certificate by its SPKI sha256 (ruling R-G8, the Public mesh-read gate's
 * recipe). libp2p's default browser gater refuses every insecure `ws` dial, so the browser reaches the
 * relay over `wss` with a self-signed certificate for the alias that this driver generates per run
 * (outside the repo, removed afterwards). No other certificate flag, no gater override, and no
 * system trust change. The page recorder `live-mesh-gate.js` is injected with `addInitScript` at
 * runtime and is never built into dist.
 *
 * FAILURE TAXONOMY, on stderr: `PREFLIGHT_FAILED:<reason>` for every way the run could certify
 * something false before a meaningful grade (a `PreflightFailedError`); `RUNGS_FAILED` once rungs ran
 * and fewer than 9 passed. ONE navigation for the whole run: no second navigation and no reload or
 * history step anywhere in this file. The browser, the server and the host are torn down in one
 * `finally`, always awaited; the host gets `stop`, then SIGKILL after 10 s.
 *
 * RUNGS (D-NN covered):
 *   R0  recorder self-check on a second page: it sees chip changes, marks and a policy violation, so
 *       every later "zero" is not vacuous
 *   R1  host boot facts re-asserted at this boundary: provenance, cluster size 4, both reservations,
 *       a current non-owner P-256 officer after a second Admin generation, pair-mint attached, sweep held
 *   L1  D-26 control: a statement signed by a different P-256 key ends officer-not-valid in the real
 *       bundle (after a real join over the alias) and leaves no registry entry or storage
 *   L2  D-01 D-02 D-06 D-17 D-18 D-26: the genuine code pairs; Catching up then Live; the browser is a
 *       machine on A (identity peer id, numeric lastPublishedAt, 1 of 1 uses); every WebSocket goes to
 *       the alias; A sees it over /p2p-circuit; the registry's relays come from the code
 *   L3  D-02 D-14: one seeded authority invite marks exactly one row in Invite authorities, no reload,
 *       cleared within 6 s
 *   L4a D-27: B's signed revocation row unpairs the browser and wipes its storage (sweep still held)
 *   L4b D-27 R-D: releasing A's sweep removes exactly that machine; B stays a member
 *   L5  D-27 PM-8 local relay-circuit leg: a fresh pairing reaches Live again; A's removeMachine
 *       unpairs it (removed notice) with the same wipe evidence
 *   H1  hygiene: no CSP violation or CSP console error; no pairing code or invitation text in any
 *       console line, page error, storage value, URL or WebSocket URL; no navigation after the first
 * NOT PROVEN HERE: a CA-issued `wss` certificate and the deployment relay (66-27), iOS and Android.
 *
 * Bearer hygiene (R-9): codes travel host -> driver only on the host's fd 3 and driver -> page only
 * through `page.fill`; this file never prints, stores or interpolates one. Equality checks on a code
 * compare SHA-256 digests computed on each side.
 *
 * LIBRARY: `runLiveMeshGate(options)` never calls `process.exit`; the CLI entry is guarded on
 * `process.argv[1]`, so importing this module never starts a run.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');
const DIST = path.join(APP_ROOT, 'dist');
const HOST_SCRIPT = path.join(HERE, 'live-mesh-host.mjs');
const RECORDER = path.join(HERE, 'live-mesh-gate.js');
const SRC_FILES = Object.freeze({
	registry: path.join(REPO_ROOT, 'packages', 'web-data', 'src', 'networks-registry.js'),
	openDb: path.join(REPO_ROOT, 'packages', 'web-data', 'src', 'open-db.js'),
	deviceKey: path.join(APP_ROOT, 'src', 'peer', 'device-key.js'),
	memberNode: path.join(APP_ROOT, 'src', 'peer', 'member-node.js'),
	status: path.join(APP_ROOT, 'src', 'live', 'status.js'),
	pairing: path.join(APP_ROOT, 'src', 'screens', 'Pairing.tsx'),
});

export const LIVE_MESH_DEFAULTS = Object.freeze({ port: 5297, relayPort: 15297, relayWssPort: 15298, alias: 'relay.vt-live-mesh.test', timeoutScale: 1 });
export const LIVE_MESH_RUNG_IDS = Object.freeze(['R0', 'R1', 'L1', 'L2', 'L3', 'L4a', 'L4b', 'L5', 'H1']);
/** @type {Readonly<Record<string, string>>} */
const RUNG_NAMES = Object.freeze({
	R0: 'recorder sees chip, marks and policy violations',
	R1: 'host boot facts re-asserted',
	L1: 'tampered statement ends officer-not-valid with no residue',
	L2: 'genuine code pairs over the relay alias and reaches Live',
	L3: 'one seeded change marks one row without reload',
	L4a: 'revocation row unpairs and wipes',
	L4b: 'owner sweep removes exactly that machine',
	L5: 'fresh pairing goes Live, removeMachine unpairs and wipes',
	H1: 'no CSP violation and no bearer leak',
});
/** A failed rung blocks these later ones (L2 carries the paired browser the later legs need). */
/** @type {Readonly<Record<string, string[]>>} */
const BLOCKS = Object.freeze({ R1: ['L1', 'L2', 'L3', 'L4a', 'L4b', 'L5', 'H1'], R0: ['H1'], L2: ['L3', 'L4a', 'L4b', 'L5'], L4a: ['L4b'] });
const BEARER_RE = /vtpair1\.|sereus-invite:/;
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const ALIAS_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const SANITIZE_SOURCE = "networkHash.replace(/[^A-Za-z0-9-]/g, '_')";

export class PreflightFailedError extends Error {
	/** @param {string} reason */
	constructor(reason) {
		super(`PREFLIGHT_FAILED:${reason}`);
		this.name = 'PreflightFailedError';
		this.reason = reason;
	}
}
class LegFailure extends Error {
	/** @param {string} detail */
	constructor(detail) {
		super(detail);
		this.name = 'LegFailure';
		this.detail = detail;
	}
}
const sleep = (/** @type {any} */ n) => new Promise((resolve) => setTimeout(resolve, n));
const sha256 = (/** @type {any} */ text) => createHash('sha256').update(text, 'utf8').digest('hex');
function errName(/** @type {any} */ err) {
	return String(err?.name ?? 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60) || 'Error';
}
function aliasOk(/** @type {any} */ alias) {
	return typeof alias === 'string' && ALIAS_RE.test(alias) && !alias.endsWith('localhost') && !IPV4_RE.test(alias);
}
function check(/** @type {any} */ cond, /** @type {any} */ detail) {
	if (!cond) throw new LegFailure(detail);
}

// ---- pure comparators (exported so a later prove-matchers control can drive them) ---------------------
/**
 * D-02 chip order after one paste: a catching-up entry exists, no live entry precedes the first
 * catching-up entry, and the first live entry's "Last checked at HH:MM:SS" is not earlier than the
 * first catching-up entry's wall second (local seconds of day, both read in the page's time zone).
 * @param {{ entries: Array<{ text: string|null, title: string|null, kind: string|null, at: number }>,
 *   liveText: string, catchingText: string, catchingSecondOfDay: number|null }} m
 */
export function evaluateChipSequence(m) {
	const isLive = (/** @type {any} */ e) => e.kind === 'live' && e.text === m.liveText;
	const isCatching = (/** @type {any} */ e) => e.kind === 'catching-up' && e.text === m.catchingText;
	const firstCatching = m.entries.findIndex(isCatching);
	const firstLive = m.entries.findIndex(isLive);
	if (firstCatching < 0) return { passed: false, detail: 'no-catching-up-entry' };
	if (firstLive < 0) return { passed: false, detail: 'no-live-entry' };
	if (firstLive < firstCatching) return { passed: false, detail: 'live-before-catching-up' };
	const title = m.entries[firstLive].title ?? '';
	const hm = /(\d{2}):(\d{2}):(\d{2})/.exec(title);
	if (hm === null) return { passed: false, detail: 'live-title-without-time' };
	if (typeof m.catchingSecondOfDay !== 'number') return { passed: false, detail: 'catching-second-unread' };
	let liveSec = Number(hm[1]) * 3600 + Number(hm[2]) * 60 + Number(hm[3]);
	if (liveSec < m.catchingSecondOfDay && m.catchingSecondOfDay - liveSec > 43_200) liveSec += 86_400;
	if (liveSec < m.catchingSecondOfDay) return { passed: false, detail: `live-time-before-catching-up (${liveSec} < ${m.catchingSecondOfDay})` };
	return { passed: true, detail: `catching-up@${firstCatching} live@${firstLive}` };
}

/**
 * D-18 registry entry: exactly one entry for the hash, paired, the officer's id, every relay address
 * ends `/p2p/<relay>` with no `/p2p-circuit`, at least one names the alias.
 * @param {{ entries: Array<{ networkHash: string, officerUserId: string|null, relayAddrs: string[]|null, hasPairing: boolean }>,
 *   networkHash: string, officerUserId: string, relayPeerId: string, alias: string }} m
 */
export function evaluateRegistryEntry(m) {
	const mine = m.entries.filter((e) => e.networkHash === m.networkHash);
	if (mine.length !== 1) return { passed: false, detail: `entries=${mine.length}` };
	const e = mine[0];
	if (!e.hasPairing) return { passed: false, detail: 'no-pairing-record' };
	if (e.officerUserId !== m.officerUserId) return { passed: false, detail: 'officer-mismatch' };
	const addrs = Array.isArray(e.relayAddrs) ? e.relayAddrs : [];
	if (addrs.length === 0) return { passed: false, detail: 'no-relay-addrs' };
	if (!addrs.every((a) => a.endsWith(`/p2p/${m.relayPeerId}`))) return { passed: false, detail: 'relay-addr-not-relay' };
	if (addrs.some((a) => a.includes('/p2p-circuit'))) return { passed: false, detail: 'relay-addr-is-circuit' };
	if (!addrs.some((a) => a.startsWith(`/dns4/${m.alias}/`))) return { passed: false, detail: 'no-alias-relay-addr' };
	return { passed: true, detail: `relayAddrs=${addrs.length}` };
}

/** D-17: at least `min` WebSocket URLs, every one `wss:` to the alias, none to a loopback name. */
export function evaluateWebSocketHosts(/** @type {any} */ urls, /** @type {any} */ alias, /** @type {any} */ min) {
	const parsed = urls.map((/** @type {any} */ u) => {
		try {
			const url = new URL(u);
			return { host: url.hostname, protocol: url.protocol };
		} catch {
			return { host: '<unparseable>', protocol: '' };
		}
	});
	const hosts = parsed.map((/** @type {any} */ x) => x.host);
	const insecure = parsed.filter((/** @type {any} */ x) => x.protocol !== 'wss:').length;
	if (insecure > 0) return { passed: false, detail: `ws=${hosts.length} not-wss=${insecure}` };
	if (hosts.length < min) return { passed: false, detail: `ws=${hosts.length}` };
	const loopback = hosts.filter((/** @type {any} */ h) => h === '127.0.0.1' || h === 'localhost' || h === '[::1]').length;
	const other = hosts.filter((/** @type {any} */ h) => h !== alias).length;
	if (loopback > 0 || other > 0) return { passed: false, detail: `ws=${hosts.length} non-alias=${other} loopback=${loopback}` };
	return { passed: true, detail: `ws=${hosts.length} all-alias` };
}

/** D-27 wipe evidence for one network (no reopen of any deleted database). */
export function evaluateWipe(/** @type {any} */ m) {
	const parts = [];
	if (m.registryHas) parts.push('registry-entry');
	if (m.names.includes(m.liveStoreName)) parts.push('live-store');
	if (m.names.some((/** @type {any} */ n) => n.startsWith(m.memberPrefix))) parts.push('member-storage');
	if (typeof m.keyRecords === 'number' && m.keyRecords > 0) parts.push(`key-records=${m.keyRecords}`);
	return parts.length === 0 ? { passed: true, detail: 'wiped' } : { passed: false, detail: `left:${parts.join(',')}` };
}

// ---- source constants (read from the shipped sources, never retyped) -------------------------------------
function readSourceConstants() {
	const text = (/** @type {any} */ file) => readFileSync(file, 'utf8');
	const pick = (/** @type {any} */ name, /** @type {any} */ file, /** @type {any} */ re) => {
		const m = re.exec(text(file));
		if (m === null) throw new PreflightFailedError(`source-constant:${name}`);
		return m[1];
	};
	const pairingSrc = text(SRC_FILES.pairing);
	const headingKey = (/** @type {any} */ reason) => {
		const re = new RegExp(`'?${reason.replace(/-/g, '\\-')}'?:\\s*Object\\.freeze\\(\\{\\s*headingKey:\\s*'([^']+)'`);
		const m = re.exec(pairingSrc);
		if (m === null) throw new PreflightFailedError(`source-constant:FAILURE_VIEWS.${reason}`);
		return m[1];
	};
	const chipKinds = pick('CHIP_KINDS', SRC_FILES.status, /export const CHIP_KINDS = Object\.freeze\(\[([^\]]+)\]\)/)
		.split(',')
		.map((/** @type {any} */ s) => s.trim().replace(/^'|'$/g, ''));
	if (!chipKinds.includes('live') || !chipKinds.includes('catching-up')) throw new PreflightFailedError('source-constant:CHIP_KINDS');
	if (!text(SRC_FILES.memberNode).includes(SANITIZE_SOURCE)) throw new PreflightFailedError('source-constant:sanitizeHash');
	return Object.freeze({
		registryKey: pick('NETWORKS_REGISTRY_KEY', SRC_FILES.registry, /export const NETWORKS_REGISTRY_KEY = '([^']+)'/),
		liveDbPrefix: pick('DB_NAME_PREFIX', SRC_FILES.openDb, /export const DB_NAME_PREFIX = '([^']+)'/),
		deviceKeysDb: pick('DEVICE_KEYS_DB_NAME', SRC_FILES.deviceKey, /export const DEVICE_KEYS_DB_NAME = '([^']+)'/),
		keysStore: pick('KEYS_STORE', SRC_FILES.deviceKey, /export const KEYS_STORE = '([^']+)'/),
		memberDbPrefix: pick('member DB_NAME_PREFIX', SRC_FILES.memberNode, /const DB_NAME_PREFIX = '([^']+)'/),
		headingKeys: Object.freeze({
			'officer-not-valid': headingKey('officer-not-valid'),
			unreachable: headingKey('unreachable'),
			'digest-mismatch': headingKey('digest-mismatch'),
			spent: headingKey('spent'),
		}),
	});
}
const sanitizeHash = (/** @type {any} */ networkHash) => networkHash.replace(/[^A-Za-z0-9-]/g, '_');

// ---- host controller ----------------------------------------------------------------------------------
/**
 * The spawned host: ANSI-stripped `HOST_*` fact map, line waits, commands on stdin, and a PRIVATE fd 3
 * reader holding minted codes in a Map that nothing ever prints.
 */
export class HostController {
	/** @param {import('node:child_process').ChildProcess} child */
	constructor(child) {
		this.child = child;
		/** @type {Record<string, string>} */
		this.facts = {};
		/** @type {string[]} */
		this.lines = [];
		this.bearerLines = 0;
		this.exited = false;
		/** @type {Set<(line: string) => void>} */
		this.listeners = new Set();
		/** @type {Map<string, string>} */
		this.codes = new Map();
		/** @type {Set<() => void>} */
		this.codeWaiters = new Set();
		createInterface({ input: /** @type {import('node:stream').Readable} */ (child.stdout) }).on('line', (raw) => this._onLine(raw));
		createInterface({ input: /** @type {import('node:stream').Readable} */ (child.stderr) }).on('line', (raw) => {
			const line = raw.replace(ANSI_RE, '');
			if (BEARER_RE.test(line)) {
				this.bearerLines++;
				process.stderr.write('[host:err] <line withheld: bearer marker>\n');
			} else process.stderr.write(`[host:err] ${line}\n`);
		});
		const secret = child.stdio[3];
		if (secret) {
			createInterface({ input: /** @type {any} */ (secret) }).on('line', (raw) => {
				const space = raw.indexOf(' ');
				if (space <= 0) return;
				this.codes.set(raw.slice(0, space), raw.slice(space + 1).trim());
				for (const fn of [...this.codeWaiters]) fn();
			});
		}
		child.on('exit', () => {
			this.exited = true;
			for (const fn of [...this.listeners]) fn('HOST_EXITED');
		});
	}

	/** @param {string} raw */
	_onLine(raw) {
		const line = raw.replace(ANSI_RE, '');
		if (BEARER_RE.test(line)) {
			this.bearerLines++;
			console.log('[host] <line withheld: bearer marker>');
			return;
		}
		console.log(`[host] ${line}`);
		this.lines.push(line);
		if (line.startsWith('HOST_')) {
			const space = line.indexOf(' ');
			const eq = line.indexOf('=');
			if (eq > 0 && (space < 0 || eq < space)) this.facts[line.slice(0, eq)] = line.slice(eq + 1);
			else if (space > 0) this.facts[line.slice(0, space)] = line.slice(space + 1);
			else this.facts[line] = '';
		}
		for (const fn of [...this.listeners]) fn(line);
	}

	/**
	 * @param {(line: string) => boolean} match
	 * @param {number} timeoutMs
	 * @param {string} label
	 * @returns {Promise<string>}
	 */
	waitForLine(match, timeoutMs, label) {
		return new Promise((resolve, reject) => {
			/** @type {(line: string) => void} */
			let listener;
			const timer = setTimeout(() => {
				this.listeners.delete(listener);
				reject(new LegFailure(`timeout:${label}`));
			}, timeoutMs);
			listener = (line) => {
				if (line === 'HOST_EXITED') {
					clearTimeout(timer);
					this.listeners.delete(listener);
					reject(new LegFailure(`host-exited:${label}`));
					return;
				}
				if (match(line)) {
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
		this.child.stdin?.write(`${command}\n`);
	}

	/** Sends `command` with the reply wait registered FIRST. */
	request(/** @type {any} */ command, /** @type {any} */ match, /** @type {any} */ timeoutMs) {
		const wait = this.waitForLine(match, timeoutMs, command);
		this.send(command);
		return wait;
	}

	/**
	 * The code minted for `label`, removed from the Map on read. Never logged; the caller hands it to
	 * `page.fill` and drops it.
	 * @param {string} label @param {number} timeoutMs @returns {Promise<string>}
	 */
	takeCode(label, timeoutMs) {
		return new Promise((resolve, reject) => {
			const tryTake = () => {
				if (!this.codes.has(label)) return false;
				const value = /** @type {string} */ (this.codes.get(label));
				this.codes.delete(label);
				resolve(value);
				return true;
			};
			if (tryTake()) return;
			const timer = setTimeout(() => {
				this.codeWaiters.delete(waiter);
				reject(new LegFailure(`no-code:${label}`));
			}, timeoutMs);
			const waiter = () => {
				if (tryTake()) {
					clearTimeout(timer);
					this.codeWaiters.delete(waiter);
				}
			};
			this.codeWaiters.add(waiter);
		});
	}

	/** `stop`, then exit awaited 10 s, then SIGKILL. */
	async stopAndAwaitExit() {
		if (this.exited) return;
		try {
			this.send('stop');
		} catch {
			// already gone
		}
		const exited = () =>
			new Promise((resolve) => {
				if (this.exited) return resolve(true);
				this.child.once('exit', () => resolve(true));
			});
		const done = await Promise.race([exited(), sleep(10_000).then(() => false)]);
		if (!done && !this.exited) {
			this.child.kill('SIGKILL');
			await Promise.race([exited(), sleep(5_000)]);
		}
	}
}

// ---- preflight helpers --------------------------------------------------------------------------------
function assertPortFree(/** @type {any} */ port, /** @type {any} */ name) {
	return new Promise((resolve, reject) => {
		const sock = net.connect({ host: '127.0.0.1', port });
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new PreflightFailedError(`${name}-port-unknown`));
		}, 2_000);
		sock.once('connect', () => {
			clearTimeout(timer);
			sock.destroy();
			reject(new PreflightFailedError(`${name}-port-in-use`));
		});
		sock.once('error', (err) => {
			clearTimeout(timer);
			if (/** @type {any} */ (err).code === 'ECONNREFUSED') resolve(undefined);
			else reject(new PreflightFailedError(`${name}-port-unknown`));
		});
	});
}

function findViteBin() {
	let dir = APP_ROOT;
	for (;;) {
		const candidate = path.join(dir, 'node_modules', 'vite', 'bin', 'vite.js');
		if (existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) throw new PreflightFailedError('vite-missing');
		dir = parent;
	}
}

/** The dashboard's own production build, spawned (never imported). */
function viteBuild() {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [findViteBin(), 'build'], {
			cwd: APP_ROOT,
			env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		child.stdout?.on('data', (d) => process.stdout.write(`[vite] ${d}`));
		child.stderr?.on('data', (d) => process.stderr.write(`[vite] ${d}`));
		child.on('error', () => reject(new PreflightFailedError('build-spawn')));
		child.on('exit', (code) => (code === 0 ? resolve(undefined) : reject(new PreflightFailedError('build-failed'))));
	});
}

/** `/usr/bin/grep -rl` (never the harness ugrep, which skips gitignored dist). True when found. */
function distContains(/** @type {any} */ pattern, /** @type {any} */ fixed) {
	const r = spawnSync('/usr/bin/grep', ['-rl', fixed ? '-F' : '-E', pattern, DIST], { encoding: 'utf8' });
	if (r.status === 0) return true;
	if (r.status === 1) return false;
	throw new PreflightFailedError('dist-scan-failed');
}
const escapeRe = (/** @type {any} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * R-G8: ONE self-signed P-256 certificate for the alias, made for this run in a fresh temp directory
 * outside the repo. Returns its paths and the SPKI sha256 pin (gateway.mjs computeSpkiSha256Base64).
 * The key never leaves that directory; the directory is removed in the run's `finally`.
 */
function makeRunCertificate(/** @type {any} */ alias) {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'vt-live-mesh-tls-'));
	const cert = path.join(dir, 'relay-cert.pem');
	const key = path.join(dir, 'relay-key.pem');
	const r = spawnSync(
		'openssl',
		['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', `/CN=${alias}`, '-addext', `subjectAltName=DNS:${alias}`],
		{ encoding: 'utf8' },
	);
	if (r.status !== 0 || !existsSync(cert) || !existsSync(key)) {
		rmSync(dir, { recursive: true, force: true });
		throw new PreflightFailedError('tls-cert');
	}
	chmodSync(key, 0o600);
	const pin = createHash('sha256').update(new X509Certificate(readFileSync(cert)).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
	return { dir, cert, key, pin };
}

function resolveConfig(/** @type {any} */ options) {
	const envNum = (/** @type {any} */ name) => (process.env[name] !== undefined && process.env[name] !== '' ? Number(process.env[name]) : undefined);
	const cfg = {
		port: options.port ?? envNum('LIVE_MESH_PORT') ?? LIVE_MESH_DEFAULTS.port,
		relayPort: options.relayPort ?? envNum('LIVE_MESH_RELAY_PORT') ?? LIVE_MESH_DEFAULTS.relayPort,
		relayWssPort: options.relayWssPort ?? envNum('LIVE_MESH_RELAY_WSS_PORT') ?? LIVE_MESH_DEFAULTS.relayWssPort,
		alias: options.alias ?? process.env.LIVE_MESH_HOST_ALIAS ?? LIVE_MESH_DEFAULTS.alias,
		timeoutScale: options.timeoutScale ?? envNum('LIVE_MESH_TIMEOUT_SCALE') ?? LIVE_MESH_DEFAULTS.timeoutScale,
	};
	return Object.freeze(cfg);
}

// ---- the gate ----------------------------------------------------------------------------------------
/**
 * @param {{ port?: number, relayPort?: number, relayWssPort?: number, alias?: string, timeoutScale?: number }} [options]
 * @returns {Promise<Readonly<{ ok: boolean, exitCode: 0|1, rungs: Array<{ id: string, ok: boolean, detail: string }>,
 *   hostFacts: Record<string, string>, preflightReason: string|null }>>}
 */
export async function runLiveMeshGate(options = {}) {
	const cfg = resolveConfig(options);
	const ms = (/** @type {any} */ n) => Math.round(n * cfg.timeoutScale);
	/** @type {Map<string, { id: string, ok: boolean, detail: string }>} */
	const rungs = new Map();
	const record = (/** @type {any} */ id, /** @type {any} */ ok, /** @type {any} */ detail) => {
		if (!LIVE_MESH_RUNG_IDS.includes(id)) throw new Error(`unknown rung ${id}`);
		rungs.set(id, { id, ok, detail });
	};
	const blocked = new Set();
	const failRung = (/** @type {any} */ id, /** @type {any} */ detail) => {
		record(id, false, detail);
		for (const dep of BLOCKS[id] ?? []) blocked.add(dep);
	};

	/** @type {HostController|null} */
	let host = null;
	/** @type {{ url: string, close: () => Promise<void> }|null} */
	let server = null;
	/** @type {import('playwright').Browser|null} */
	let browser = null;
	let preflightReason = null;
	/** @type {{ dir: string, cert: string, key: string, pin: string }|null} */
	let tls = null;
	/** @type {{ console: Array<{ type: string, text: string, bearer: boolean }>, pageErrors: Array<{ bearer: boolean, name: string }>, wsUrls: string[], navigations: string[], withheld: number }} */
	const pageLog = { console: [], pageErrors: [], wsUrls: [], navigations: [], withheld: 0 };

	try {
		// ---- 1. preflight -----------------------------------------------------------------------------
		if (!aliasOk(cfg.alias)) throw new PreflightFailedError('alias');
		if (cfg.timeoutScale !== 1 && cfg.timeoutScale !== 2) throw new PreflightFailedError('timeout-scale');
		for (const [name, p] of [['serve', cfg.port], ['relay', cfg.relayPort], ['relay-wss', cfg.relayWssPort]]) {
			if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new PreflightFailedError(`${name}-port`);
		}
		const SRC = readSourceConstants();
		await assertPortFree(cfg.port, 'serve');
		await assertPortFree(cfg.relayPort, 'relay');
		await assertPortFree(cfg.relayWssPort, 'relay-wss');
		if (new Set([cfg.port, cfg.relayPort, cfg.relayWssPort]).size !== 3) throw new PreflightFailedError('ports-not-distinct');
		tls = makeRunCertificate(cfg.alias);
		const buildStart = Date.now();
		await viteBuild();
		const indexFile = path.join(DIST, 'index.html');
		if (!existsSync(indexFile) || statSync(indexFile).mtimeMs < buildStart) throw new PreflightFailedError('dist-stale');
		if (distContains(`__LIVE_MESH__|live-mesh|${escapeRe(cfg.alias)}|${cfg.relayPort}|${cfg.relayWssPort}`, false)) throw new PreflightFailedError('dist-contaminated');
		const { serveDist } = await import(pathToFileURL(path.join(REPO_ROOT, 'packages', 'ui-web', 'scripts', 'lib', 'serve-dist.mjs')).href);
		const { t } = await import(pathToFileURL(path.join(REPO_ROOT, 'packages', 'ui-web', 'src', 'copy.js')).href);
		try {
			server = await serveDist(DIST, cfg.port);
		} catch (err) {
			throw new PreflightFailedError(/** @type {any} */ (err)?.code === 'EADDRINUSE' ? 'serve-port-in-use' : 'serve-failed');
		}
		const serverUrl = /** @type {{ url: string }} */ (server).url;
		const pageUrl = new URL('/', serverUrl).href;
		const served = Buffer.from(await (await fetch(new URL('/index.html', serverUrl))).arrayBuffer());
		if (!served.equals(readFileSync(indexFile))) throw new PreflightFailedError('served-bundle-stale');

		// ---- host boot (R1) ----------------------------------------------------------------------------
		const child = spawn(process.execPath, [HOST_SCRIPT, '--relay-port', String(cfg.relayPort), '--relay-wss-port', String(cfg.relayWssPort), '--tls-cert', tls.cert, '--tls-key', tls.key, '--alias', cfg.alias], {
			cwd: APP_ROOT,
			env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', LIVE_MESH_TIMEOUT_SCALE: String(cfg.timeoutScale) },
			stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
		});
		host = new HostController(child);
		const hostRef = host;
		const tHost = Date.now();
		const readyLine = await host
			.waitForLine((l) => l === 'HOST_READY' || l.startsWith('HOST_FATAL'), ms(300_000), 'host-ready')
			.catch((err) => `HOST_FATAL ${err instanceof LegFailure ? err.detail : errName(err)}`);
		const F = host.facts;
		const officer = /^current=true keyType=P adminGenerations=(\d+) notOwner=true$/.exec(F.HOST_OFFICER_B ?? '');
		const r1 = [
			[readyLine === 'HOST_READY', `ready:${readyLine === 'HOST_READY' ? 'yes' : readyLine}`],
			[F.HOST_PROVENANCE === 'PASS', `provenance=${F.HOST_PROVENANCE}`],
			[F.HOST_CLUSTER_SIZE === '4', `cluster=${F.HOST_CLUSTER_SIZE}`],
			[F.HOST_RESERVED === 'a=true b=true', `reserved=${F.HOST_RESERVED}`],
			[officer !== null && Number(officer[1]) >= 2, `officer=${F.HOST_OFFICER_B}`],
			[(F.HOST_RELAY_ALIAS_ADDR ?? '').startsWith(`/dns4/${cfg.alias}/tcp/${cfg.relayWssPort}/wss/p2p/`), 'alias-wss-addr'],
			[F.HOST_TLS_SPKI === tls.pin, 'tls-pin-mismatch'],
			[F.HOST_PAIR_MINT === 'attached', 'pair-mint'],
			[F.HOST_SWEEP === 'held', 'sweep-held'],
			[typeof F.HOST_NETWORK_HASH === 'string' && F.HOST_NETWORK_HASH.length > 0, 'network-hash'],
			[typeof F.HOST_OFFICER_USER_ID === 'string' && F.HOST_OFFICER_USER_ID.length > 0, 'officer-user-id'],
		];
		const r1Bad = r1.filter(([ok]) => !ok).map(([, d]) => d);
		if (r1Bad.length === 0) record('R1', true, `host ready after ${Date.now() - tHost} ms`);
		else failRung('R1', r1Bad.join('; '));
		console.log(`[lm-R1] host ready after ${Date.now() - tHost} ms`);

		const hash = F.HOST_NETWORK_HASH ?? '';
		const relayPeerId = F.HOST_RELAY_PEER_ID ?? '';
		const officerUserId = F.HOST_OFFICER_USER_ID ?? '';
		const officerName = F.HOST_OFFICER_NAME ?? '';
		const authorityName = F.HOST_AUTHORITY_NAME ?? '';

		// ---- 2. browser: launched in exactly one place; the alias map and THIS run's pin (R-G8) ----------
		browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${cfg.alias} 127.0.0.1`, `--ignore-certificate-errors-spki-list=${tls.pin}`] });
		const context = await browser.newContext();
		await context.addInitScript({ path: RECORDER });
		const page = await context.newPage();
		page.on('console', (msg) => {
			const text = msg.text();
			if (BEARER_RE.test(text)) {
				pageLog.withheld++;
				pageLog.console.push({ type: msg.type(), text: '<withheld: bearer marker>', bearer: true });
			} else pageLog.console.push({ type: msg.type(), text, bearer: false });
		});
		page.on('pageerror', (err) => {
			const text = `${err.name}: ${err.message}`;
			pageLog.pageErrors.push({ bearer: BEARER_RE.test(text), name: errName(err) });
		});
		page.on('websocket', (ws) => pageLog.wsUrls.push(ws.url()));
		page.on('framenavigated', (frame) => {
			if (frame === page.mainFrame()) pageLog.navigations.push(frame.url());
		});
		const readState = () => page.evaluate(() => JSON.parse(JSON.stringify(/** @type {any} */ (window).__LIVE_MESH__ ?? null)));

		// ---- 3. R0: recorder self-check on a SECOND page ---------------------------------------------------
		try {
			const r0Page = await context.newPage();
			try {
				await r0Page.evaluate(() => {
					const s = document.createElement('div');
					s.setAttribute('role', 'status');
					s.textContent = 'A';
					document.body.appendChild(s);
				});
				await sleep(100);
				await r0Page.evaluate(() => {
					/** @type {HTMLElement} */ (document.querySelector('[role="status"]')).textContent = 'B';
					for (let i = 0; i < 2; i++) {
						const m = document.createElement('span');
						m.className = 'change-mark';
						m.textContent = `mark ${i}`;
						document.body.appendChild(m);
					}
				});
				await sleep(100);
				await r0Page.evaluate(() => {
					for (const m of document.querySelectorAll('.change-mark')) m.remove();
					document.dispatchEvent(
						new SecurityPolicyViolationEvent('securitypolicyviolation', {
							effectiveDirective: 'connect-src',
							violatedDirective: 'connect-src',
							blockedURI: 'wss://r0.invalid/',
							originalPolicy: "connect-src 'self'",
							disposition: 'enforce',
							statusCode: 0,
						}),
					);
				});
				await sleep(100);
				const s = await r0Page.evaluate(() => JSON.parse(JSON.stringify(/** @type {any} */ (window).__LIVE_MESH__ ?? null)));
				const chipTexts = (s?.chip ?? []).map((/** @type {any} */ e) => e.text).filter((/** @type {any} */ x) => x !== null);
				const ok = s?.contract === 'live-mesh-gate/1' && chipTexts.length === 2 && chipTexts[0] === 'A' && chipTexts[1] === 'B' && s.marks.maxCount === 2 && s.csp.length === 1;
				if (ok) record('R0', true, 'chip 2, maxCount 2, csp 1');
				else failRung('R0', `contract=${s?.contract ?? 'none'} chip=${chipTexts.length} maxCount=${s?.marks?.maxCount} csp=${s?.csp?.length}`);
			} finally {
				await r0Page.close();
			}
		} catch (err) {
			failRung('R0', `error:${errName(err)}`);
		}

		// ---- 4. the ONE navigation --------------------------------------------------------------------------
		await page.goto(pageUrl, { waitUntil: 'load' });
		const timeOrigin0 = await page.evaluate(() => performance.timeOrigin);
		await page.getByRole('heading', { level: 1, name: t('pairing.title'), exact: true }).waitFor({ timeout: ms(60_000) });

		// ---- 5. leg helpers ------------------------------------------------------------------------------
		const liveText = t('status.chip.live');
		const catchingText = t('status.chip.catching-up');
		/** @type {Map<string, string>} sha256 of each pasted code, by label (the code itself is dropped) */
		const pastedDigest = new Map();

		async function mint(/** @type {any} */ label, /** @type {any} */ tampered) {
			const line = await hostRef.request(
				`${tampered ? 'mint-tampered' : 'mint'} ${label}`,
				(/** @type {any} */ l) => l.startsWith(`HOST_MINTED label=${label} `) || l.startsWith(`HOST_MINT_FAILED label=${label} `) || l.startsWith('HOST_REFUSED'),
				ms(150_000),
			);
			check(line.startsWith('HOST_MINTED'), `mint:${line.split(' ').slice(1).join(' ')}`);
		}
		async function pairWith(/** @type {any} */ label) {
			const pairingCode = await hostRef.takeCode(label, ms(30_000));
			pastedDigest.set(label, sha256(pairingCode));
			await page.getByLabel(t('pairing.fieldLabel'), { exact: true }).fill(pairingCode);
			await page.getByRole('button', { name: t('pairing.cta'), exact: true }).click();
		}
		async function status(/** @type {any} */ label) {
			const line = await hostRef.request(`status ${label}`, (/** @type {any} */ l) => l.startsWith('HOST_STATUS ') || l.startsWith('HOST_REFUSED'), ms(30_000));
			check(line.startsWith('HOST_STATUS '), `status:${line}`);
			const s = JSON.parse(line.slice('HOST_STATUS '.length));
			check(s.label === label, 'status-label');
			return s;
		}
		const registry = () =>
			page.evaluate((key) => {
				let parsed = [];
				try {
					parsed = JSON.parse(window.localStorage.getItem(key) ?? '[]');
				} catch {
					parsed = [];
				}
				return (Array.isArray(parsed) ? parsed : []).map((e) => ({
					networkHash: e?.networkHash ?? null,
					officerUserId: e?.officerUserId ?? null,
					relayAddrs: Array.isArray(e?.pairing?.relayAddrs) ? e.pairing.relayAddrs.map(String) : null,
					hasPairing: e?.pairing != null,
				}));
			}, SRC.registryKey);
		/** Database names, and key records for the hash ONLY if the device-key database is listed. */
		const idbSnapshot = (/** @type {any} */ networkHash) =>
			page.evaluate(
				async ({ networkHash: h, deviceKeysDb, keysStore }) => {
					const names = (await indexedDB.databases()).map((d) => String(d.name));
					if (!names.includes(deviceKeysDb)) return { names, keyRecords: null };
					const keyRecords = await new Promise((resolve) => {
						const req = indexedDB.open(deviceKeysDb);
						// It vanished between the listing and the open: abort the creation, never resurrect it.
						req.onupgradeneeded = () => req.transaction?.abort();
						req.onerror = () => resolve(-1);
						req.onsuccess = () => {
							const db = req.result;
							try {
								if (!db.objectStoreNames.contains(keysStore)) {
									db.close();
									resolve(0);
									return;
								}
								const count = db.transaction(keysStore, 'readonly').objectStore(keysStore).count(IDBKeyRange.bound([h], [h, []]));
								count.onsuccess = () => {
									db.close();
									resolve(count.result);
								};
								count.onerror = () => {
									db.close();
									resolve(-1);
								};
							} catch {
								db.close();
								resolve(-1);
							}
						};
					});
					return { names, keyRecords };
				},
				{ networkHash, deviceKeysDb: SRC.deviceKeysDb, keysStore: SRC.keysStore },
			);
		async function wipeVerdict(/** @type {any} */ networkHash) {
			const reg = await registry();
			const snap = await idbSnapshot(networkHash);
			return evaluateWipe({
				registryHas: reg.some((e) => e.networkHash === networkHash),
				names: snap.names,
				liveStoreName: `${SRC.liveDbPrefix}${networkHash}`,
				memberPrefix: `${SRC.memberDbPrefix}${sanitizeHash(networkHash)}-`,
				keyRecords: snap.keyRecords,
			});
		}
		async function waitWiped(/** @type {any} */ networkHash, /** @type {any} */ budget) {
			const deadline = Date.now() + budget;
			let v = await wipeVerdict(networkHash);
			while (!v.passed && Date.now() < deadline) {
				await sleep(1_000);
				v = await wipeVerdict(networkHash);
			}
			check(v.passed, `wipe:${v.detail}`);
		}
		const waitChip = (/** @type {any} */ text, /** @type {any} */ budget) =>
			page.waitForFunction((want) => {
				const el = document.querySelector('[role="status"]');
				return el !== null && (el.textContent ?? '').trim() === want;
			}, text, { timeout: budget, polling: 250 });
		async function chipSequenceSince(/** @type {any} */ tPaste) {
			const s = await readState();
			const entries = s.chip.filter((/** @type {any} */ e) => e.at >= tPaste);
			const firstCatching = entries.find((/** @type {any} */ e) => e.kind === 'catching-up' && e.text === catchingText);
			const catchingSecondOfDay =
				firstCatching === undefined
					? null
					: await page.evaluate((at) => {
							const d = new Date(at);
							return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
						}, firstCatching.at);
			return evaluateChipSequence({ entries, liveText, catchingText, catchingSecondOfDay });
		}
		async function waitNotice(/** @type {any} */ body, /** @type {any} */ budget) {
			await page.waitForFunction(
				({ heading, want }) => {
					const h = document.querySelector('.pr-notice .pr-notice-heading');
					const b = document.querySelector('.pr-notice .pr-notice-body');
					return h !== null && b !== null && (h.textContent ?? '').trim() === heading && (b.textContent ?? '').trim() === want;
				},
				{ heading: t('unpaired.heading'), want: body },
				{ timeout: budget, polling: 250 },
			);
		}
		const pageNow = () => page.evaluate(() => Date.now());
		/** True when any form field's contents hash to the pasted code's digest (the code never re-enters the page). */
		const fieldHoldsCode = (/** @type {any} */ digest) =>
			page.evaluate(async (want) => {
				const hex = async (/** @type {any} */ s) =>
					Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))
						.map((b) => b.toString(16).padStart(2, '0'))
						.join('');
				for (const el of document.querySelectorAll('input, textarea')) {
					const v = /** @type {HTMLInputElement} */ (el).value;
					if (typeof v === 'string' && v.length > 0 && (await hex(v)) === want) return true;
				}
				return false;
			}, digest);

		async function leg(/** @type {any} */ id, /** @type {any} */ budget, /** @type {any} */ fn) {
			if (blocked.has(id)) {
				record(id, false, `blocked`);
				for (const dep of BLOCKS[id] ?? []) blocked.add(dep);
				return;
			}
			let timer;
			try {
				const detail = await Promise.race([
					fn(),
					new Promise((_resolve, reject) => {
						timer = setTimeout(() => reject(new LegFailure(`budget ${budget} ms exceeded`)), budget);
					}),
				]);
				record(id, true, String(detail ?? ''));
			} catch (err) {
				failRung(id, err instanceof LegFailure ? err.detail : `error:${errName(err)}`);
				// Instrument diagnostic: rendered UI copy and connection facts only (never a field's contents).
				try {
					const ui = await page.evaluate(() => {
						const texts = (/** @type {any} */ sel) => Array.from(document.querySelectorAll(sel)).map((el) => (el.textContent ?? '').trim().slice(0, 160));
						return {
							title: texts('.pr-title'),
							status: texts('.pr-status'),
							headings: texts('.pr-heading, .pr-notice-heading'),
							steps: texts('.pr-step'),
							slow: texts('.pr-slow'),
							alert: texts('.pr-alert .pr-body'),
							chip: texts('[role="status"]'),
							panels: document.querySelectorAll('section.panel').length,
						};
					});
					/** @type {Record<string, number>} */
					const wsHosts = {};
					for (const u of pageLog.wsUrls) {
						let h = '<unparseable>';
						try {
							h = new URL(u).host;
						} catch {
							// counted as unparseable
						}
						wsHosts[h] = (wsHosts[h] ?? 0) + 1;
					}
					console.log(`[lm-${id}-diag] ${JSON.stringify({ ui, wsHosts, consoleLines: pageLog.console.length })}`);
				} catch (diagErr) {
					console.log(`[lm-${id}-diag] unavailable ${errName(diagErr)}`);
				}
			} finally {
				clearTimeout(timer);
			}
		}

		// ---- 7. L2 pair and Live (D-01 D-02 D-06 D-17 D-18) -----------------------------------------------
		await leg('L2', ms(420_000), async () => {
			const tPaste = await pageNow();
			const t0 = Date.now();
			await mint('p1', false);
			await pairWith('p1');
			await waitChip(liveText, ms(360_000));
			const liveMs = Date.now() - t0;
			const seq = await chipSequenceSince(tPaste);
			check(seq.passed, `chip:${seq.detail}`);
			const s0 = await readState();
			check(s0.marks.maxCount === 0, `marks-before-seed=${s0.marks.maxCount}`);
			const reg = evaluateRegistryEntry({ entries: await registry(), networkHash: hash, officerUserId, relayPeerId, alias: cfg.alias });
			check(reg.passed, `registry:${reg.detail}`);
			const ws = evaluateWebSocketHosts(pageLog.wsUrls, cfg.alias, 1);
			check(ws.passed, `websocket:${ws.detail}`);
			check(!distContains(relayPeerId, true) && !distContains(cfg.alias, true), 'dist-names-relay-or-alias');
			const s = await status('p1');
			check(s.authorized === true && s.inMachines === true, `machine:authorized=${s.authorized} inMachines=${s.inMachines}`);
			check(typeof s.lastPublishedAgeMs === 'number', 'lastPublishedAt-not-numeric');
			check(s.usesRecorded === 1 && s.totalUses === 1, `uses=${s.usesRecorded}/${s.totalUses}`);
			check(s.controlViaCircuit === true, 'control-not-via-circuit');
			check(s.strandCircuitConns >= 1, `strandCircuitConns=${s.strandCircuitConns}`);
			check((await page.locator('textarea#pr-code').count()) === 0, 'pairing-field-still-present');
			check(!(await fieldHoldsCode(/** @type {string} */ (pastedDigest.get('p1')))), 'a-field-holds-the-code');
			console.log(`[lm-L2] live after ${liveMs} ms`);
			return `live after ${liveMs} ms; ${reg.detail}; ${ws.detail}`;
		});

		// ---- 8. L3 one seeded change, one mark (D-02 D-14) --------------------------------------------------
		await leg('L3', ms(120_000), async () => {
			const steadyFrom = await pageNow();
			await sleep(10_000);
			const s0 = await readState();
			check(s0.marks.maxCount === 0, `marks-before-seed=${s0.marks.maxCount}`);
			check(s0.chip.filter((/** @type {any} */ e) => e.at >= steadyFrom).every((/** @type {any} */ e) => e.kind === 'live'), 'not-steady-live');
			const seededLine = await hostRef.request('seed-change', (/** @type {any} */ l) => l.startsWith('HOST_SEEDED name=') || l.startsWith('HOST_REFUSED'), ms(90_000));
			check(seededLine.startsWith('HOST_SEEDED'), `seed:${seededLine}`);
			const seededName = seededLine.slice('HOST_SEEDED name='.length);
			const tSeed = await pageNow();
			const t0 = Date.now();
			await page.waitForFunction(() => document.querySelectorAll('.change-mark').length > 0, undefined, { timeout: ms(60_000), polling: 100 });
			const markMs = Date.now() - t0;
			const where = await page.evaluate(
				({ panelTitle, name, word }) =>
					Array.from(document.querySelectorAll('.change-mark')).map((el) => {
						const panel = el.closest('section.panel');
						const title = (panel?.querySelector('.panel-title')?.textContent ?? '').trim();
						const text = el.textContent ?? '';
						return { inPanel: title.includes(panelTitle), hasName: text.includes(name), hasWord: text.includes(word) };
					}),
				{ panelTitle: t('panels.inviteAuthorities.title'), name: seededName, word: t('marks.updated') },
			);
			check(where.length === 1, `marks-at-appearance=${where.length}`);
			check(where[0].inPanel && where[0].hasName && where[0].hasWord, `mark:inPanel=${where[0].inPanel} name=${where[0].hasName} word=${where[0].hasWord}`);
			await page.waitForFunction(() => document.querySelectorAll('.change-mark').length === 0, undefined, { timeout: ms(8_000), polling: 100 }).catch(() => undefined);
			await sleep(Math.max(0, 10_000 - (Date.now() - t0)));
			const s1 = await readState();
			const after = s1.marks.events.filter((/** @type {any} */ e) => e.at >= tSeed);
			check(after.length > 0 && after[0].count === 1, `first-mark-count=${after[0]?.count}`);
			check(s1.marks.maxCount === 1, `maxCount=${s1.marks.maxCount}`);
			const appeared = after[0].at;
			const cleared = after.find((/** @type {any} */ e) => e.count === 0);
			check(cleared !== undefined && cleared.at - appeared <= 6_000, `cleared=${cleared === undefined ? 'never' : cleared.at - appeared}`);
			const last = s1.chip[s1.chip.length - 1];
			check(last?.kind === 'live', `chip-at-end=${last?.kind}`);
			check((await page.evaluate(() => performance.timeOrigin)) === timeOrigin0 && pageLog.navigations.length === 1, 'reloaded');
			console.log(`[lm-L3] mark after ${markMs} ms, cleared after ${cleared.at - appeared} ms`);
			return `mark after ${markMs} ms, cleared after ${cleared.at - appeared} ms`;
		});

		// ---- 9. L4a revocation row unpairs (D-27; sweep still held) ----------------------------------------
		await leg('L4a', ms(180_000), async () => {
			const t0 = Date.now();
			const line = await hostRef.request('revoke p1', (/** @type {any} */ l) => l.startsWith('HOST_REVOKED label=p1') || l.startsWith('HOST_REFUSED'), ms(90_000));
			check(line.startsWith('HOST_REVOKED'), `revoke:${line}`);
			await waitNotice(t('unpaired.body.revoked', { officerName, authorityName }), ms(150_000));
			const unpairMs = Date.now() - t0;
			await waitWiped(hash, ms(30_000));
			const s = await status('p1');
			check(s.authorized === true, 'machine-already-gone (only the dashboard should have acted)');
			console.log(`[lm-L4a] unpaired(revoked) after ${unpairMs} ms`);
			return `unpaired(revoked) after ${unpairMs} ms`;
		});

		// ---- 10. L4b owner sweep removes the machine (D-27 R-D) ----------------------------------------------
		await leg('L4b', ms(90_000), async () => {
			const t0 = Date.now();
			const removedLine = hostRef.waitForLine((l) => l.startsWith('HOST_SWEEP outcome=removed'), ms(80_000), 'sweep-removed');
			hostRef.send('sweep-release');
			await removedLine;
			const sweepMs = Date.now() - t0;
			const removedCount = hostRef.lines.filter((l) => l.startsWith('HOST_SWEEP outcome=removed')).length;
			check(removedCount === 1, `removed-outcomes=${removedCount}`);
			const s = await status('p1');
			check(s.authorized === false && s.inMachines === false, `machine:authorized=${s.authorized} inMachines=${s.inMachines}`);
			check(s.bAuthorized === true, 'officer-B-lost-membership');
			console.log(`[lm-L4b] removed by sweep after ${sweepMs} ms`);
			return `removed by sweep after ${sweepMs} ms`;
		});

		// ---- 11. L5 fresh pairing, then removeMachine (D-27 PM-8) --------------------------------------------
		await leg('L5', ms(480_000), async () => {
			const dismiss = page.getByRole('button', { name: t('unpaired.dismiss'), exact: true });
			if ((await dismiss.count()) > 0) await dismiss.click();
			const tPaste = await pageNow();
			const t0 = Date.now();
			await mint('p2', false);
			await pairWith('p2');
			await waitChip(liveText, ms(360_000));
			const liveMs = Date.now() - t0;
			const seq = await chipSequenceSince(tPaste);
			check(seq.passed, `chip:${seq.detail}`);
			const s = await status('p2');
			check(s.controlViaCircuit === true, 'control-not-via-circuit');
			const t1 = Date.now();
			const line = await hostRef.request('remove p2', (/** @type {any} */ l) => l.startsWith('HOST_REMOVED label=p2 ') || l.startsWith('HOST_REFUSED'), ms(60_000));
			check(line.startsWith('HOST_REMOVED'), `remove:${line}`);
			await waitNotice(t('unpaired.body.removed'), ms(90_000));
			const unpairMs = Date.now() - t1;
			await waitWiped(hash, ms(30_000));
			const s2 = await status('p2');
			check(s2.inMachines === false, 'still-in-machines');
			console.log(`[lm-L5] live after ${liveMs} ms, unpaired(removed) after ${unpairMs} ms`);
			return `live after ${liveMs} ms, unpaired(removed) after ${unpairMs} ms`;
		});

		// ---- 6. L1 tampered-statement control (D-26), run LAST of the legs --------------------------------
		// Order change (66-26 run under R-G8, rungs unchanged): after an officer-not-valid failure the pairing
		// field renders empty while the failure stays set, so the CTA stays disabled until a reload
		// (DEFECT-66-26-01, Pairing.tsx). With ONE navigation for the run, L1 first made every later leg
		// unreachable. L1 now follows L5 and the trap itself is observed below on every run.
		await leg('L1', ms(300_000), async () => {
			const t0 = Date.now();
			const wsBefore = pageLog.wsUrls.length;
			await mint('ctl', true);
			await pairWith('ctl');
			const headingTexts = Object.fromEntries(Object.entries(SRC.headingKeys).map(([k, v]) => [k, t(v)]));
			await page.waitForFunction(() => document.querySelector('.pr-alert .pr-heading') !== null, undefined, { timeout: ms(240_000), polling: 250 });
			const heading = (await page.locator('.pr-alert .pr-heading').first().textContent())?.trim() ?? '';
			check(heading === headingTexts['officer-not-valid'], `heading:${Object.entries(headingTexts).find(([, v]) => v === heading)?.[0] ?? 'other'}`);
			const ms1 = Date.now() - t0;
			const wsAlias = pageLog.wsUrls.slice(wsBefore).some((u) => new URL(u).hostname === cfg.alias);
			check(wsAlias, 'no-websocket-to-alias');
			await waitWiped(hash, ms(60_000));
			const s = await status('ctl');
			check(typeof s.usagePeer === 'string', 'no-usage-peer');
			const removed = await hostRef.request('remove ctl', (/** @type {any} */ l) => l.startsWith('HOST_REMOVED label=ctl ') || l.startsWith('HOST_REFUSED'), ms(60_000));
			console.log(`[lm-L1] officer-not-valid after ${ms1} ms (${removed.split(' ').pop()})`);
			// DEFECT-66-26-01 observation (not a rung): a harmless non-code text typed into the field.
			const field = page.getByLabel(t('pairing.fieldLabel'), { exact: true });
			await field.fill('defect-probe').catch(() => undefined);
			const trap = await page.evaluate(() => {
				const area = /** @type {HTMLTextAreaElement|null} */ (document.querySelector('textarea#pr-code'));
				const cta = /** @type {HTMLButtonElement|null} */ (document.querySelector('.pr-cta'));
				return { fieldEmpty: area !== null && area.value === '', ctaDisabled: cta !== null && cta.disabled, alertShown: document.querySelector('.pr-alert') !== null };
			});
			console.log(`[lm-obs] DEFECT-66-26-01 after officer-not-valid: fieldEmpty=${trap.fieldEmpty} ctaDisabled=${trap.ctaDisabled} alertShown=${trap.alertShown}`);
			return `officer-not-valid after ${ms1} ms`;
		});

		// ---- 12. H1 hygiene ------------------------------------------------------------------------------
		await leg('H1', ms(30_000), async () => {
			const s = await readState();
			const cspConsole = pageLog.console.filter((c) => /Content Security Policy/i.test(c.text)).length;
			const storageBearer = await page.evaluate((src) => {
				const re = new RegExp(src);
				const store = window.localStorage;
				for (let i = 0; i < store.length; i++) {
					const k = store.key(i);
					if (k !== null && re.test(store.getItem(k) ?? '')) return true;
				}
				return false;
			}, BEARER_RE.source);
			const urlBearer = pageLog.navigations.some((u) => BEARER_RE.test(u)) || BEARER_RE.test(page.url()) || pageLog.wsUrls.some((u) => BEARER_RE.test(u));
			const consoleBearer = pageLog.withheld + pageLog.pageErrors.filter((e) => e.bearer).length;
			check(s.csp.length === 0, `csp-violations=${s.csp.length} (${s.csp.map((/** @type {any} */ c) => `${c.directive}:${c.scheme}`).join(',')})`);
			check(cspConsole === 0, `csp-console-lines=${cspConsole}`);
			check(consoleBearer === 0, `bearer-in-console=${consoleBearer}`);
			check(!storageBearer, 'bearer-in-storage');
			check(!urlBearer, 'bearer-in-url');
			check(hostRef.bearerLines === 0, `bearer-in-host-output=${hostRef.bearerLines}`);
			check((await page.evaluate(() => performance.timeOrigin)) === timeOrigin0, 'time-origin-changed');
			check(pageLog.navigations.length === 1, `navigations=${pageLog.navigations.length}`);
			return 'clean';
		});
	} catch (err) {
		if (err instanceof PreflightFailedError) preflightReason = err.reason;
		else {
			console.error(`[live-mesh-gate] driver error ${errName(err)}`);
			preflightReason = preflightReason ?? null;
			for (const id of LIVE_MESH_RUNG_IDS) if (!rungs.has(id)) record(id, false, `driver-error:${errName(err)}`);
		}
	} finally {
		for (const c of pageLog.console) console.log(`[page:${c.type}] ${c.text}`);
		console.log(`[page] console lines ${pageLog.console.length}, withheld ${pageLog.withheld}, page errors ${pageLog.pageErrors.length} (${pageLog.pageErrors.map((e) => e.name).join(',')})`);
		try {
			await browser?.close();
		} catch {
			// best effort
		}
		try {
			await server?.close();
		} catch {
			// best effort
		}
		await host?.stopAndAwaitExit();
		if (tls !== null) rmSync(tls.dir, { recursive: true, force: true });
	}

	if (preflightReason !== null) {
		console.error(`PREFLIGHT_FAILED:${preflightReason}`);
		return Object.freeze({ ok: false, exitCode: 1, rungs: [], hostFacts: { ...(host?.facts ?? {}) }, preflightReason });
	}
	const list = LIVE_MESH_RUNG_IDS.map((id) => rungs.get(id) ?? { id, ok: false, detail: blocked.has(id) ? 'blocked' : 'not-run' });
	for (const r of list) {
		if (r.ok) console.log(`  ok  ${r.id} · ${RUNG_NAMES[r.id]}`);
		else console.log(`  FAIL ${r.id} · ${RUNG_NAMES[r.id]} — ${r.detail}`);
	}
	const passed = list.filter((r) => r.ok).length;
	console.log(`RUNGS: ${passed}/${LIVE_MESH_RUNG_IDS.length}`);
	const ok = passed === LIVE_MESH_RUNG_IDS.length;
	if (!ok) console.error('RUNGS_FAILED');
	return Object.freeze({ ok, exitCode: ok ? 0 : 1, rungs: list, hostFacts: { ...(host?.facts ?? {}) }, preflightReason: null });
}

async function main() {
	const result = await runLiveMeshGate();
	if (result.exitCode !== 0) process.exitCode = 1;
}

// `process.argv[1]` is only this file when Node loaded it as the entry module; an import never starts a run.
const isCliEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntry) {
	main().catch((err) => {
		console.error(`[live-mesh-gate] driver error ${errName(err)}`);
		process.exitCode = 1;
	});
}
