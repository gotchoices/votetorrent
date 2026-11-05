#!/usr/bin/env node
/**
 * live-mesh-host.mjs — the Node half of `gate:live-mesh` (phase 66 plan 26). Gate-only test tooling:
 * it is never imported by `src/`, never part of the dashboard build, and never shipped.
 *
 * WHAT IT IS. Three REAL CadreNodes in one process, standing in for the network's relay and two
 * officer phones:
 *   - relay R: an in-process circuit relay with relay-only.mjs's serve posture (party
 *     `votetorrent-relay`, profile storage, no strands, no genesis, no claim, no relay init option so
 *     cadre-core's uncapped defaults apply). It listens on 127.0.0.1 ONLY (ws for A and B, wss for the
 *     browser) and announces only `/dns4/<alias>/tcp/<wss-port>/wss`, the non-private host alias the
 *     browser dials (ruling R-G8: one self-signed certificate per run, pinned by SPKI in the driver).
 *   - owner A: the Authority provider's node shape. Founds a VoteTorrent network, runs the
 *     `/votetorrent/pair-mint/1.0.0` owner service (vote-engine `createPairMintService`, ports bound to
 *     A's OWN network hash and strand database) and the R-D revocation sweep.
 *   - officer B: a cadre member that is NOT an owner and a current Officer with a P-256 UserKey. It
 *     builds pairing codes over the wire exactly as the Authority's `requestPairingCode` does (66-11
 *     steps 2-9) and inserts its own signed revocation rows.
 *   A and B have no listen address: everything reaches them through R as `/p2p-circuit`.
 *
 * WHY COPIED, NOT IMPORTED. relay-only.mjs cannot serve this gate: it binds every interface and only
 * announces a public `wss` name on 443 or a private LAN IPv4. vote-cli's `Device` hard-codes a strand
 * cluster size of 2 and has no relay. RN app code (the Authority host's `planRevocationActions`)
 * cannot be imported from Node, so the sweep here mirrors that rule the way 66-09's spec-local sweep
 * does. A and B run the browser bundle's cluster size (read from the same package member-node.js
 * reads), never 2.
 *
 * NO GATER. The relay copies relay-only.mjs (no gater option). A and B copy the Authority network
 * block MINUS its permissive gater: Node libp2p's default already allows loopback dials. If a Node
 * peer's loopback dial is ever denied, the executor stops and reports; it never adds an override.
 *
 * STDOUT CONTRACT (column 0, ANSI-free, printed ONLY through `out()`):
 *   boot:    HOST_STACK {json} | HOST_PROVENANCE=PASS|FAIL:<reason> | HOST_CLUSTER_SIZE=<n> |
 *            HOST_RELAY_PEER_ID=<id> | HOST_RELAY_ADDR=<loopback addr> | HOST_RELAY_ALIAS_ADDR=<alias addr> |
 *            HOST_A_PEER_ID=<id> | HOST_B_PEER_ID=<id> | HOST_RESERVED a=<bool> b=<bool> |
 *            HOST_FOUNDING keyType=<P|M> thresholds=<csv> | HOST_NETWORK_HASH=<hash> |
 *            HOST_AUTHORITY_NAME=<name> | HOST_OFFICER_NAME=<name> | HOST_OFFICER_USER_ID=<uuid> |
 *            HOST_OFFICER_B current=<bool> keyType=<t> adminGenerations=<n> notOwner=<bool> |
 *            HOST_PAIR_MINT attached | HOST_SWEEP held | HOST_READY
 *   replies: HOST_MINTED label= chars= members= aliasMembers= droppedLoopback= ms= | HOST_MINT_FAILED label= reason=<closed> |
 *            HOST_SEEDED name=<name> | HOST_REVOKED label= | HOST_SWEEP_RELEASED |
 *            HOST_SWEEP outcome=<closed> row=<n> | HOST_REMOVED label= removedPeer=<bool> |
 *            HOST_STATUS {json} | HOST_REFUSED <token> | HOST_FATAL <token> |
 *            HOST_SELF_CHECK PASS|FAIL:<leg> | HOST_STOPPED
 * STDIN (one command per line, closed vocabulary; labels match ^[a-z0-9-]{1,16}$):
 *   mint <label> | mint-tampered <label> | seed-change | revoke <label> | sweep-release |
 *   remove <label> | status <label> | stop
 * FD 3 (the secret channel; never stdout or stderr): exactly one line `<label> <code>` per successful
 *   `mint` / `mint-tampered`. With no fd 3 socket or pipe open, `mint` replies HOST_REFUSED
 *   no-secret-channel.
 *
 * BEARER HYGIENE (R-9). Pairing codes, join codes, encoded invitations, invite shares, invite private
 * keys and signing private keys live only in variables named pairingCode, joinCode, encodedInvitation,
 * inviteShare, invitePrivate and privBytes; none of them is ever printed, put in an error, written to a
 * file or compared other than as a boolean. Nothing is written to disk.
 * LOG HYGIENE (R-10). Only `err.name`, closed tokens, counts, lengths, timings and peer ids are printed;
 * never Quereus message text or row values.
 *
 * Args: --relay-port <int> --relay-wss-port <int> --tls-cert <pem> --tls-key <pem> --alias <name> [--self-check].
 *   The certificate is the driver's per-run self-signed one for the alias (ruling R-G8); its private key
 *   is read once and never printed. Env: LIVE_MESH_TIMEOUT_SCALE (1 or 2).
 */
import { fstatSync, readFileSync, writeSync, existsSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import { createInterface } from 'node:readline';
import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');
const MEMBER_NODE_SRC = path.join(APP_ROOT, 'src', 'peer', 'member-node.js');

const RELAY_PARTY = 'votetorrent-relay';
const PARTY_ID = 'votetorrent';
const SAPP_ID = 'org.votetorrent';
const FOUNDING_OFFICER_SCOPES = ['rn', 'rad', 'vrg', 'iad', 'uai', 'ceb', 'mel', 'cap', 'ik'];
const AUTHORITY_NAME = 'Live Mesh Authority';
const FOUNDER_NAME = 'Live Mesh Founder';
const OFFICER_NAME = 'Live Mesh Officer B';
/**
 * 66.1 (D-02): the shipped administration-change delay is one hour (vote-core ADMIN_CHANGE_DELAY_MS).
 * This harness injects 5 s as the proposal's effectiveAt, as the vote-engine specs do; nothing switches it.
 */
const OFFICER_CHANGE_TEST_DELAY_MS = 5_000;
const NETWORK_NAME = 'Live Mesh Network';
const LABEL_RE = /^[a-z0-9-]{1,16}$/;
const ALIAS_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
/** The 66-06 edge-host patch, as it reads in cadre-core `dist/strand-reactivity.js`. */
const EDGE_HOST_MARKERS = Object.freeze(['VoteTorrent patch (edge-host)', 'config.edgeHost === true']);
const STATEMENT_LIFETIME_MS = 14 * 60_000;
const PAIRING_INVITE_MS = 15 * 60_000;
const INVITE_MAX_ADDRS = 4;
/** Notes "From 66-09" item 2: 6 requests a minute per caller, so B spaces EVERY request >= 11 s. */
const B_REQUEST_SPACING_MS = 11_000;
const GUARD_RETRIES = 6;
const GUARD_RETRY_MS = 5_000;
const SWEEP_EVERY_MS = 5_000;
const SWEEP_MAX_ACTIONS = 10;
const PRE_REPLAY_REFUSALS = new Set(['refused:switched-off', 'refused:expired', 'refused:requester-mismatch']);

const SCALE = (() => {
	const raw = process.env.LIVE_MESH_TIMEOUT_SCALE;
	if (raw === undefined || raw === '') return 1;
	const n = Number(raw);
	return n === 1 || n === 2 ? n : NaN;
})();
const ms = (/** @type {any} */ n) => Math.round(n * SCALE);

// ---- output: the ONE printer ------------------------------------------------------------------------
function out(/** @type {any} */ line) {
	process.stdout.write(`${line}\n`);
}
function errName(/** @type {any} */ err) {
	return String(err?.name ?? 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60) || 'Error';
}
const sleep = (/** @type {any} */ n) => new Promise((resolve) => setTimeout(resolve, n));

class StepTimeoutError extends Error {
	constructor(/** @type {any} */ step) {
		super(`step timed out: ${step}`);
		this.name = 'StepTimeoutError';
		this.step = step;
	}
}
class HostFatal extends Error {
	constructor(/** @type {any} */ token) {
		super(`host fatal: ${token}`);
		this.name = 'HostFatal';
		this.token = token;
	}
}

/** A step bounded by `n` ms (already scaled by the caller). */
async function bounded(/** @type {any} */ promise, /** @type {any} */ n, /** @type {any} */ step) {
	let timer;
	const limit = new Promise((_resolve, reject) => {
		timer = setTimeout(() => reject(new StepTimeoutError(step)), n);
	});
	try {
		return await Promise.race([promise, limit]);
	} finally {
		clearTimeout(timer);
	}
}

/** Poll `read` until `done(value)`; a throw from `read` is "not yet". */
async function pollUntil(/** @type {any} */ read, /** @type {any} */ done, /** @type {any} */ n, /** @type {any} */ step, intervalMs = 1_000) {
	const deadline = Date.now() + n;
	for (;;) {
		try {
			const v = await read();
			if (done(v)) return v;
		} catch {
			// not ready yet
		}
		if (Date.now() >= deadline) throw new StepTimeoutError(step);
		await sleep(intervalMs);
	}
}

// ---- args ---------------------------------------------------------------------------------------------
function parseArgs(/** @type {any} */ argv) {
	const opts = { selfCheck: false, relayPort: NaN, relayWssPort: NaN, tlsCert: '', tlsKey: '', alias: '' };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--self-check') opts.selfCheck = true;
		else if (a === '--relay-port') opts.relayPort = Number(argv[++i]);
		else if (a === '--alias') opts.alias = String(argv[++i] ?? '');
		else if (a === '--relay-wss-port') opts.relayWssPort = Number(argv[++i]);
		else if (a === '--tls-cert') opts.tlsCert = String(argv[++i] ?? '');
		else if (a === '--tls-key') opts.tlsKey = String(argv[++i] ?? '');
		else return null;
	}
	return opts;
}
function aliasOk(/** @type {any} */ alias) {
	return ALIAS_RE.test(alias) && !alias.endsWith('localhost') && !IPV4_RE.test(alias);
}

// ---- package provenance -------------------------------------------------------------------------------
/** The directory of `<name>` as Node resolution would find it from `startDir` (node_modules walk). */
function findPackageDir(/** @type {any} */ startDir, /** @type {any} */ name) {
	let dir = startDir;
	for (;;) {
		const candidate = path.join(dir, 'node_modules', ...name.split('/'));
		if (existsSync(path.join(candidate, 'package.json'))) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}
function versionAt(/** @type {any} */ dir) {
	if (dir === null) return null;
	try {
		return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version ?? null;
	} catch {
		return null;
	}
}
function stripJsComments(/** @type {any} */ text) {
	return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ---- in-memory seams ------------------------------------------------------------------------------------
/** vote-core `LocalStorage` in memory (vote-cli `FileLocalStorage` minus the file). */
class MemoryLocalStorage {
	constructor() {
		this.map = new Map();
	}
	async getItem(/** @type {any} */ key) {
		return this.map.has(key) ? structuredClone(this.map.get(key)) : undefined;
	}
	async setItem(/** @type {any} */ key, /** @type {any} */ value) {
		this.map.set(key, structuredClone(value));
	}
	async removeItem(/** @type {any} */ key) {
		this.map.delete(key);
	}
	async clear() {
		this.map.clear();
	}
}

/** relay-only.mjs `scopedProvider`: one MemoryRawStorage per storage scope. */
function scopedProvider(/** @type {any} */ MemoryRawStorage) {
	const byScope = new Map();
	return (/** @type {any} */ scope) => {
		const id = typeof scope === 'string' ? scope : JSON.stringify(scope ?? 'default');
		if (!byScope.has(id)) byScope.set(id, new MemoryRawStorage());
		return byScope.get(id);
	};
}

function canonical(/** @type {any} */ msEpoch) {
	return new Date(msEpoch).toISOString().slice(0, 19);
}
function base64url(/** @type {any} */ bytes) {
	return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function expiryMs(/** @type {any} */ v) {
	if (typeof v === 'number') return v;
	const s = String(v);
	return /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? Date.parse(s) : Date.parse(`${s}Z`);
}
async function first(/** @type {any} */ db, /** @type {any} */ sql, params = {}) {
	for await (const row of db.eval(sql, params)) return row;
	return undefined;
}
async function all(/** @type {any} */ db, /** @type {any} */ sql, params = {}) {
	const rows = [];
	for await (const row of db.eval(sql, params)) rows.push(row);
	return rows;
}

// ---- teardown (module scope so EVERY failure path stops every started node) -----------------------------
/** @type {Array<{ name: string, node: any }>} */
const started = [];
let stopping = false;
/** @type {ReturnType<typeof setInterval>|null} */
let sweepTimer = null;
/** @type {(() => Promise<void>)|null} */
let detachPairMint = null;

async function stopAll() {
	if (sweepTimer !== null) clearInterval(sweepTimer);
	try {
		await detachPairMint?.();
	} catch {
		// node may already be down
	}
	// R, then B, then A; each bounded 10 s, errors swallowed.
	for (const name of ['R', 'B', 'A']) {
		const entry = started.find((s) => s.name === name);
		if (!entry) continue;
		await Promise.race([entry.node.stop().catch(() => undefined), sleep(10_000)]);
	}
}
async function shutdown(/** @type {any} */ code) {
	if (stopping) return;
	stopping = true;
	await stopAll();
	out('HOST_STOPPED');
	process.exit(code);
}
function tokenOf(/** @type {any} */ err) {
	return err instanceof StepTimeoutError ? `${err.step}-timeout` : err instanceof HostFatal ? err.token : errName(err);
}
async function fatal(/** @type {any} */ err) {
	out(`HOST_FATAL ${tokenOf(err)}`);
	if (!stopping) {
		stopping = true;
		await stopAll();
	}
	process.exit(1);
}

// ---- the host -------------------------------------------------------------------------------------------
async function main() {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed === null) {
		out('HOST_REFUSED usage');
		process.exit(2);
	}
	const opts = parsed;
	if (!Number.isFinite(SCALE)) {
		out('HOST_REFUSED timeout-scale');
		process.exit(2);
	}
	if (!Number.isInteger(opts.relayPort) || opts.relayPort < 1024 || opts.relayPort > 65535) {
		out('HOST_REFUSED relay-port');
		process.exit(2);
	}
	if (!aliasOk(opts.alias)) {
		out('HOST_REFUSED alias');
		process.exit(2);
	}
	const wssPortOk = Number.isInteger(opts.relayWssPort) && opts.relayWssPort >= 1024 && opts.relayWssPort <= 65535 && opts.relayWssPort !== opts.relayPort;
	if (!wssPortOk || !existsSync(opts.tlsCert) || !existsSync(opts.tlsKey)) {
		out('HOST_REFUSED tls');
		process.exit(2);
	}

	// Every package by bare specifier from THIS file: the dashboard workspace, the same cadre-core bytes
	// the browser bundle uses.
	const cadre = /** @type {any} */ (await import('@serfab/cadre-core'));
	const { CadreNode } = cadre;
	const { MemoryRawStorage } = /** @type {any} */ (await import('@optimystic/db-p2p'));
	const { webSockets } = /** @type {any} */ (await import('@libp2p/websockets'));
	const { circuitRelayTransport } = /** @type {any} */ (await import('@libp2p/circuit-relay-v2'));
	const { generateKeyPair } = /** @type {any} */ (await import('@libp2p/crypto/keys'));
	const { p256 } = /** @type {any} */ (await import('@noble/curves/nist.js'));
	const { bytesToHex } = /** @type {any} */ (await import('@noble/curves/utils.js'));
	// NetworksEngine, the pairing barrel, createEdgeReaderRefusal, UserEngine and the rest are on the
	// `/rn` entry both apps import (NetworksEngine is deliberately absent from the package root).
	const VE = /** @type {any} */ (await import('@votetorrent/vote-engine/rn'));
	const veEntryPath = fileURLToPath(import.meta.resolve('@votetorrent/vote-engine/rn'));
	// declareViewsInMain is not exported; vote-cli loads it by file path from the built dist.
	const { declareViewsInMain } = /** @type {any} */ (await import(new URL('./database/initialize.js', import.meta.resolve('@votetorrent/vote-engine/rn')).href));
	const sereusPlugin = /** @type {any} */ (await import('@serfab/quereus-plugin-sereus'));

	const cadreDir = findPackageDir(HERE, '@serfab/cadre-core');
	const veDir = path.resolve(path.dirname(veEntryPath), '..');
	const quereusHere = findPackageDir(HERE, '@quereus/quereus');
	const quereusVe = findPackageDir(veDir, '@quereus/quereus');
	out(
		`HOST_STACK ${JSON.stringify({
			node: process.versions.node,
			cadreCore: { dir: cadreDir, version: versionAt(cadreDir) },
			dbP2p: versionAt(findPackageDir(HERE, '@optimystic/db-p2p')),
			quereusFromHere: { dir: quereusHere, version: versionAt(quereusHere) },
			quereusFromVoteEngine: { dir: quereusVe, version: versionAt(quereusVe) },
			timeoutScale: SCALE,
		})}`,
	);

	process.on('SIGTERM', () => void shutdown(0));
	process.on('SIGINT', () => void shutdown(0));
	process.on('uncaughtException', (e) => void fatal(e));
	// relay-only.mjs posture for stray libp2p rejections: named and counted, never fatal on their own.
	// (Draft decision D-H3: recorded in the SUMMARY if any appear.)
	process.on('unhandledRejection', (e) => out(`HOST_LATE_ERROR ${errName(e)}`));

	// ---- 1. provenance and cluster size --------------------------------------------------------------
	let provenance = 'FAIL:unread';
	try {
		const text = readFileSync(path.join(cadreDir ?? '', 'dist', 'strand-reactivity.js'), 'utf8');
		provenance = EDGE_HOST_MARKERS.every((m) => text.includes(m)) ? 'PASS' : 'FAIL:marker-missing';
	} catch (err) {
		provenance = `FAIL:${errName(err)}`;
	}
	out(`HOST_PROVENANCE=${provenance}`);
	const clusterSize = Number(sereusPlugin.DEFAULT_STRAND_CLUSTER_SIZE ?? cadre.DEFAULT_STRAND_CLUSTER_SIZE);
	out(`HOST_CLUSTER_SIZE=${clusterSize}`);
	const memberSrc = stripJsComments(readFileSync(MEMBER_NODE_SRC, 'utf8'));
	const memberUsesDefault = /export\s+const\s+MEMBER_STRAND_CLUSTER_SIZE\s*=\s*DEFAULT_STRAND_CLUSTER_SIZE\s*;/.test(memberSrc);
	if (clusterSize !== 4 || !memberUsesDefault) throw new HostFatal('cluster-size');

	// ---- 2. relay R ---------------------------------------------------------------------------------------
	const port = opts.relayPort;
	const loopListen = `/ip4/127.0.0.1/tcp/${port}/ws`;
	// R-G8: the browser's default gater refuses every insecure ws dial, so the browser reaches R over
	// wss on a second loopback listener, with the driver's per-run self-signed certificate for the alias.
	const wssListen = `/ip4/127.0.0.1/tcp/${opts.relayWssPort}/wss`;
	const aliasListen = `/dns4/${opts.alias}/tcp/${opts.relayWssPort}/wss`;
	const tlsCert = readFileSync(opts.tlsCert);
	const tlsKeyPem = readFileSync(opts.tlsKey);
	// The gateway.mjs computeSpkiSha256Base64 recipe: sha256 over the certificate's SPKI DER, base64.
	const spkiPin = createHash('sha256').update(new X509Certificate(tlsCert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
	out(`HOST_TLS_SPKI=${spkiPin}`);
	// The relay ANNOUNCES only its alias, as a deployed relay announces only its public name. A and B
	// still dial it at the loopback address (Node cannot resolve the reserved `.test` name; the browser
	// maps it with a host-resolver rule). Instrument fix (66-26 run 1): with the loopback address also
	// announced, every member's circuit address and so the code's relay list led with a loopback relay
	// address; the browser's gater refused it, and libp2p's dial queue folded the alias dial into that
	// refused target, so the browser never opened a WebSocket.
	const relayNetwork = { transports: [webSockets({ https: { cert: tlsCert, key: tlsKeyPem } })], listenAddrs: [loopListen, wssListen], announceAddrs: [aliasListen] };
	const relay = new CadreNode({
		privateKey: await generateKeyPair('Ed25519'),
		controlNetwork: { partyId: RELAY_PARTY, bootstrapNodes: [] },
		profile: 'storage',
		strandFilter: { mode: 'none' },
		requireSignedSchemas: false,
		storage: { provider: scopedProvider(MemoryRawStorage) },
		hibernation: { enabled: false },
		network: relayNetwork,
	});
	started.push({ name: 'R', node: relay });
	await bounded(relay.start(), ms(30_000), 'relay-start');
	const relayId = String(relay.peerId);
	const relayAddr = `${loopListen}/p2p/${relayId}`;
	const relayAliasAddr = `${aliasListen}/p2p/${relayId}`;
	const relayControl = relay.getControlNode();
	const relayListening = relayControl.getMultiaddrs().map(String);
	const strandCount = (() => {
		const s = relay.getStrands();
		return s?.size ?? s?.length ?? 0;
	})();
	const relayReadbackOk =
		!relayListening.some((/** @type {any} */ a) => a.includes('/ip4/127.')) &&
		relayListening.includes(relayAliasAddr) &&
		(relay.getTrustedOwnerStore()?.all().size ?? 0) === 0 &&
		strandCount === 0 &&
		relayControl.services?.relay != null;
	out(`HOST_RELAY_PEER_ID=${relayId}`);
	out(`HOST_RELAY_ADDR=${relayAddr}`);
	out(`HOST_RELAY_ALIAS_ADDR=${relayAliasAddr}`);
	if (!relayReadbackOk) throw new HostFatal('relay-readback');

	// ---- 3. nodes A and B (the Authority provider shape, no gater key) -------------------------------------
	function memberConfig(/** @type {any} */ privateKey) {
		return {
			privateKey,
			controlNetwork: { partyId: PARTY_ID, bootstrapNodes: [relayAddr] },
			profile: 'transaction',
			requireSignedSchemas: false,
			strandFilter: { mode: 'all' },
			strandClusterSize: clusterSize,
			storage: { provider: scopedProvider(MemoryRawStorage) },
			hibernation: { enabled: false },
			strandReactivity: { enabled: true },
			// One tracker per node (66-28), never shared between A and B.
			strandCohortRefusal: VE.createEdgeReaderRefusal().hook,
			network: {
				controlCohort: { strandAddrRefreshMs: 30_000 },
				transports: [webSockets(), circuitRelayTransport({ reservationConcurrency: 1 })],
				listenAddrs: [],
				relayAddrs: [relayAddr],
				requireRelay: false,
			},
		};
	}
	const keyA = await generateKeyPair('Ed25519');
	const nodeA = new CadreNode(memberConfig(keyA));
	started.push({ name: 'A', node: nodeA });
	await bounded(nodeA.start(), ms(60_000), 'node-a-start');
	// vote-cli's identity-owner-key shim, then owner genesis while A is the cadre's only machine.
	const ownerPair = cadre.ed25519KeyPairFromLibp2p(keyA);
	nodeA.getIdentityOwnerKey = () => ({ publicKeyB64: ownerPair.publicKeyB64, privateKeyB64: ownerPair.privateKeyB64 });
	nodeA.getIdentityOwnerSigner = () => cadre.softwareOwnerSigner(ownerPair.privateKeyB64);
	await nodeA.trustOwnerKeys([ownerPair.publicKeyB64], 'operator');
	await nodeA.getControlDatabase().ensureOwnerKey(ownerPair.publicKeyB64);
	await bounded(nodeA.initializeSeedBootstrap(ownerPair.privateKeyB64), ms(60_000), 'owner-genesis');

	const nodeB = new CadreNode(memberConfig(await generateKeyPair('Ed25519')));
	started.push({ name: 'B', node: nodeB });
	await bounded(nodeB.start(), ms(60_000), 'node-b-start');
	const aPeerId = nodeA.peerId.toString();
	const bPeerId = nodeB.peerId.toString();
	out(`HOST_A_PEER_ID=${aPeerId}`);
	out(`HOST_B_PEER_ID=${bPeerId}`);

	const circuitVia = (/** @type {any} */ node) => node.getControlNode().getMultiaddrs().map(String).some((/** @type {any} */ a) => a.includes(`/p2p/${relayId}/p2p-circuit`));
	const directAddrs = (/** @type {any} */ node) => node.getControlNode().getMultiaddrs().map(String).filter((/** @type {any} */ a) => !a.includes('/p2p-circuit'));
	let reserved = { a: false, b: false };
	try {
		reserved = await pollUntil(
			async () => ({ a: circuitVia(nodeA), b: circuitVia(nodeB) }),
			(/** @type {any} */ v) => v.a && v.b,
			ms(60_000),
			'reservation',
			500,
		);
	} catch (err) {
		reserved = { a: circuitVia(nodeA), b: circuitVia(nodeB) };
		out(`HOST_RESERVED a=${reserved.a} b=${reserved.b}`);
		throw err;
	}
	out(`HOST_RESERVED a=${reserved.a} b=${reserved.b}`);
	if (directAddrs(nodeA).length > 0 || directAddrs(nodeB).length > 0) throw new HostFatal('direct-addr');

	// ---- strand db factories (vote-cli Device.openStrandDb, cluster size from config) --------------------
	function strandDbFactory(/** @type {any} */ node, /** @type {any} */ isFounder) {
		const cache = new Map();
		return (/** @type {any} */ hash) => {
			let p = cache.get(hash);
			if (p) return p;
			p = (async () => {
				const founder = isFounder();
				await node
					.addStrand({
						strandRow: { Id: hash, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null },
						sAppConfig: { id: SAPP_ID, version: '1.0.0', schema: innerDdl(VE.VOTETORRENT_SCHEMA_SQL), latencyHint: 'interactive' },
						founder,
						...(founder ? { awaitFirstSync: false } : {}),
					})
					.catch((/** @type {any} */ e) => {
						if (!/AwaitingFirstSync/i.test(e?.name ?? '') && !/first sync/i.test(e?.message ?? '')) throw e;
					});
				await node.whenStrandWritable(hash, { timeoutMs: ms(120_000) });
				const db = node.getStrand(hash).database.getDatabase();
				db.setSchemaPath(['App', 'main']);
				return db;
			})();
			cache.set(hash, p);
			p.catch(() => {
				if (cache.get(hash) === p) cache.delete(hash);
			});
			return p;
		};
	}
	const localA = new MemoryLocalStorage();
	const localB = new MemoryLocalStorage();
	await localA.setItem('recentNetworks', []);
	await localB.setItem('recentNetworks', []);
	let foundingIntent = false;
	const networksA = new VE.NetworksEngine(localA, strandDbFactory(nodeA, () => foundingIntent));
	const networksB = new VE.NetworksEngine(localB, strandDbFactory(nodeB, () => false));
	const peerCount = (/** @type {any} */ node) => node.getControlNode()?.getConnections().length ?? 0;

	// ---- 4. users and signers --------------------------------------------------------------------------
	function p256Identity(/** @type {any} */ name) {
		const privBytes = p256.utils.randomSecretKey();
		const keyPub = bytesToHex(p256.getPublicKey(privBytes));
		const user = { id: randomUUID(), name, imageRef: { url: '' }, activeKeys: [{ key: keyPub, type: 'P', expiration: Date.now() + 365 * 86_400_000 }] };
		const sign = async (/** @type {any} */ digest) => ({ signerUserId: user.id, signerKey: keyPub, signature: bytesToHex(p256.sign(digest, privBytes)) });
		return { user, keyPub, sign };
	}
	/** vote-cli's secp256k1 'M' founder key: used only if the founding builder refuses a 'P' key. */
	async function mobileIdentity(/** @type {any} */ name) {
		const { secp256k1 } = /** @type {any} */ (await import('@noble/curves/secp256k1.js'));
		const privBytes = secp256k1.utils.randomSecretKey();
		const keyPub = bytesToHex(secp256k1.getPublicKey(privBytes, true));
		const user = { id: randomUUID(), name, imageRef: { url: '' }, activeKeys: [{ key: keyPub, type: 'M', expiration: Date.now() + 365 * 86_400_000 }] };
		const sign = async (/** @type {any} */ digest) => ({ signerUserId: user.id, signerKey: keyPub, signature: bytesToHex(secp256k1.sign(digest, privBytes)) });
		return { user, keyPub, sign };
	}
	let F = p256Identity(FOUNDER_NAME);
	const B = p256Identity(OFFICER_NAME);

	// ---- 5. A founds the network (vote-cli createNetwork, relays = the alias address) -------------------
	function networkInitFor(/** @type {any} */ founder, /** @type {any} */ thresholdPolicies) {
		return {
			name: NETWORK_NAME,
			relays: [relayAliasAddr],
			primaryAuthority: { name: AUTHORITY_NAME, domainName: 'authority.vt-live-mesh.test' },
			admin: {
				officers: [{ init: { name: founder.user.name, title: 'Chair', scopes: [...FOUNDING_OFFICER_SCOPES] } }],
				effectiveAt: Date.now(),
				thresholdPolicies,
			},
			policies: { timestampAuthorities: [], numberRequiredTSAs: 0, electionType: 'o' },
		};
	}
	const BASE_THRESHOLDS = [{ policy: 'rn', threshold: 1 }, { policy: 'mel', threshold: 1 }, { policy: 'ceb', threshold: 1 }];
	const WITH_RAD_IAD = [...BASE_THRESHOLDS, { policy: 'rad', threshold: 1 }, { policy: 'iad', threshold: 1 }];
	let builder = null;
	/** @type {Array<{ policy: string, threshold: number }>} */
	let thresholds = [];
	for (const candidate of [
		{ id: F, policies: WITH_RAD_IAD },
		{ id: F, policies: BASE_THRESHOLDS },
	]) {
		const b = networksA.buildCreate().update({ networkInit: networkInitFor(candidate.id, candidate.policies), user: candidate.id.user });
		if (b.isValid()) {
			builder = b;
			thresholds = candidate.policies;
			break;
		}
	}
	if (builder === null) {
		F = await mobileIdentity(FOUNDER_NAME);
		const b = networksA.buildCreate().update({ networkInit: networkInitFor(F, BASE_THRESHOLDS), user: F.user });
		if (!b.isValid()) throw new HostFatal('founding-invalid');
		builder = b;
		thresholds = BASE_THRESHOLDS;
	}
	out(`HOST_FOUNDING keyType=${F.user.activeKeys[0].type} thresholds=${thresholds.map((p) => p.policy).join(',')}`);
	foundingIntent = true;
	try {
		await bounded(builder.commit(), ms(180_000), 'founding');
	} finally {
		foundingIntent = false;
	}
	const refA = (await networksA.getRecentNetworks())[0];
	if (!refA) throw new HostFatal('founding-unconfirmed');
	const hash = refA.hash;
	const networkEngineA = await networksA.open(refA, F.user, true, () => peerCount(nodeA));
	const ctxA = networksA.getEstablishedContext(hash);
	await declareViewsInMain(ctxA.db);
	const dbA = ctxA.db;
	const detailsA = await networkEngineA.getDetails();
	const authorityId = detailsA.network.primaryAuthorityId;
	const authorityA = await networkEngineA.openAuthority(authorityId);
	out(`HOST_NETWORK_HASH=${hash}`);
	out(`HOST_AUTHORITY_NAME=${AUTHORITY_NAME}`);

	// ---- 6. B joins as a member (vote-cli joinNetworkWorkflow over a 1-use vtjoin2. code) -----------------
	{
		const minted = await nodeA.createCadreInvitation({ uses: 1, expiresInMs: PAIRING_INVITE_MS });
		const anchor = await networksA.getJoinAnchor(hash);
		const encodedInvitation = minted.encoded;
		const joinCode = VE.encodeNetworkJoinCode({ v: 2, invitation: encodedInvitation, networkHash: anchor.networkHash, name: anchor.name, genesis: anchor.genesis, digest: anchor.digest });
		const decoded = VE.decodeNetworkJoinCode(joinCode);
		if (!decoded.ok) throw new HostFatal('join-code-undecodable');
		/** @type {string[]} */
		let members = [];
		const result = await bounded(
			VE.joinNetwork({
				node: nodeB,
				networksEngine: networksB,
				user: B.user,
				code: decoded.code,
				decodeInvitation: (/** @type {any} */ encoded) => {
					const invitation = cadre.decodeCadreInvitation(encoded);
					members = Array.isArray(invitation.members) ? [...invitation.members] : [];
					return invitation;
				},
				invitationExpiresAtMs: (/** @type {any} */ invitation) => {
					const at = invitation?.invite?.expiresAt;
					if (typeof at !== 'string' || at.length === 0) return null;
					const t = expiryMs(at);
					return Number.isFinite(t) ? t : null;
				},
				isSelfAdmitted: () => isSelfAdmitted(cadre, nodeB),
				afterFallbackAdmission: async () => {
					const controlNode = nodeB.getControlNode();
					const memberIds = new Set(members.map((a) => a.split('/p2p/').pop()).filter(Boolean));
					for (const conn of controlNode?.getConnections() ?? []) {
						if (memberIds.has(conn?.remotePeer?.toString())) await conn.close?.().catch(() => undefined);
					}
					const seeds = (await nodeB.getControlDatabase()?.querySeedPeers().catch(() => [])) ?? [];
					if (controlNode) await cadre.mergeSeedPeers(controlNode, seeds.filter((/** @type {any} */ p) => p.peerId !== bPeerId)).catch(() => undefined);
					await nodeB.refreshMembershipGate('invitation-redeemed');
					await nodeB.reconcileControlCohort().catch(() => undefined);
				},
				rememberBootstrap: async () => {
					await localB.setItem('joinBootstrap', members);
				},
				getPeerCount: () => peerCount(nodeB),
			}),
			ms(180_000),
			'b-join',
		);
		if (!result?.ok) throw new HostFatal(`b-join-${String(result?.reason ?? 'failed').replace(/[^a-z0-9-]/g, '')}`);
	}
	const refB = (await networksB.getRecentNetworks()).find((/** @type {any} */ r) => r.hash === hash);
	if (!refB) throw new HostFatal('b-join-no-ref');
	await networksB.open(refB, B.user, true, () => peerCount(nodeB));
	const ctxB = networksB.getEstablishedContext(hash);
	await declareViewsInMain(ctxB.db);
	const dbB = ctxB.db;
	if ((await nodeA.isAuthorizedMember(bPeerId)) !== true) throw new HostFatal('b-not-member');
	let notOwner = false;
	try {
		await nodeB.createCadreInvitation({ uses: 1 });
	} catch {
		notOwner = true;
	}

	// ---- 7. B becomes a current officer (real invite, accept, promotion; no hand-written rows) -----------
	{
		const inviteShare = authorityA.createOfficerInvite({ name: OFFICER_NAME, title: 'Officer', scopes: ['iad', 'mel'] });
		await authorityA.saveInviteWithSigning(inviteShare, 'rad', F.sign);
		const invitationsB = new VE.InvitationEngine(ctxB);
		const resolution = await pollUntil(
			() => invitationsB.resolveInviteSlot(inviteShare.inviteKey, 'of'),
			(/** @type {any} */ r) => r?.status === 'live',
			ms(60_000),
			'officer-slot',
		);
		const slotCid = resolution.cid;
		const invitePrivate = inviteShare.invitePrivate;
		// 66.1 (D-12): the engine writes the officer's User, UserKey and InviteResult in one transaction (no hand-written rows, Phase 66 planning risk l.290).
		await invitationsB.respondToInvite(slotCid, true, invitePrivate, undefined, undefined, undefined, { userId: B.user.id, name: B.user.name, signingKey: B.user.activeKeys[0] });
	}
	const invitationsA = new VE.InvitationEngine(ctxA);
	const accepted = await pollUntil(
		() => invitationsA.getAcceptedOfficerInvitees(),
		(/** @type {any} */ list) => Array.isArray(list) && list.some((/** @type {any} */ i) => i.userId === B.user.id),
		ms(60_000),
		'officer-accepted-invitee',
	);
	const invitee = accepted.find((/** @type {any} */ i) => i.userId === B.user.id);
	if (!(await VE.isCurrentPairingOfficer(dbA, { userId: B.user.id, nowCanonical: canonical(Date.now()) }))) {
		if (!invitee) throw new HostFatal('officer-not-accepted');
		const admin = (await authorityA.getAdminDetails()).admin;
		const officers = admin.officers.map((/** @type {any} */ o) => ({ existing: { userId: o.userId, authorityId, title: o.title, scopes: o.scopes } }));
		// Mirrors vote-core's officerSelectionFromInvitee (vote-core is not resolvable from this workspace).
		officers.push({ existing: { userId: invitee.userId, authorityId, title: 'Officer', scopes: ['iad', 'mel'] } });
		const effectiveAt = canonical(Date.now() + OFFICER_CHANGE_TEST_DELAY_MS);
		await authorityA.proposeAdmin({ proposed: { officers, effectiveAt, thresholdPolicies: admin.thresholdPolicies }, signers: [F.user.id] }, F.sign);
		if (authorityA.lastPromotionOutcome?.status !== 'promoted') throw new HostFatal('officer-not-promoted');
		const futureRow = await first(dbA, 'select count(*) as n from Admin where AuthorityId = :authorityId and EffectiveAt = :eff', { authorityId, eff: effectiveAt });
		if (Number(futureRow?.n ?? 0) !== 1) throw new HostFatal('officer-not-future-dated');
	}
	const officerCurrent = await pollUntil(
		async () => {
			const nowC = canonical(Date.now());
			return (
				(await VE.isCurrentPairingOfficer(dbA, { userId: B.user.id, nowCanonical: nowC })) &&
				(await VE.isCurrentPairingOfficer(dbB, { userId: B.user.id, nowCanonical: nowC }))
			);
		},
		(/** @type {any} */ v) => v === true,
		ms(90_000),
		'officer-current',
	).catch(() => false);
	const keyRow = await first(dbA, 'select Type from UserKey where UserId = :id', { id: B.user.id });
	const genRow = await first(dbA, 'select count(*) as n from Admin where AuthorityId = :id', { id: authorityId });
	const adminGenerations = Number(genRow?.n ?? 0);
	out(`HOST_OFFICER_NAME=${OFFICER_NAME}`);
	// A generated id, not a bearer: the driver checks the registry's officerUserId against it (L2).
	out(`HOST_OFFICER_USER_ID=${B.user.id}`);
	out(`HOST_OFFICER_B current=${officerCurrent === true} keyType=${String(keyRow?.Type ?? 'none')} adminGenerations=${adminGenerations} notOwner=${notOwner}`);

	// ---- 8. owner pair-mint on A (66-09 Task 1 step 5 binding, 66-10 mint-log semantics) --------------
	/** @type {Array<{ nonce: string, userId: string, inviteKey: string|null, at: number, expiresAt: string|null, outcome: string, withdrawn?: boolean }>} */
	const mintEntries = [];
	const mintLog = {
		async hasNonce(/** @type {any} */ nonce) {
			return mintEntries.some((e) => e.nonce === nonce && !PRE_REPLAY_REFUSALS.has(e.outcome));
		},
		async record(/** @type {any} */ entry) {
			mintEntries.push({ ...entry });
		},
		async findByNonce(/** @type {any} */ nonce) {
			const forNonce = mintEntries.filter((e) => e.nonce === nonce);
			return forNonce.find((e) => e.outcome === 'approved') ?? forNonce[forNonce.length - 1] ?? null;
		},
		async liveMintsFor(/** @type {any} */ userId, /** @type {any} */ nowMs) {
			return mintEntries.filter((e) => e.userId === userId && e.outcome === 'approved' && e.expiresAt !== null && expiryMs(e.expiresAt) > nowMs && e.withdrawn !== true);
		},
	};
	const inviteUsagePeer = async (/** @type {any} */ inviteKey) => {
		const rows = await nodeA.getControlDatabase().queryCadreInviteUsages();
		return rows.find((/** @type {any} */ r) => r.inviteKey === inviteKey)?.peerId ?? null;
	};
	const ports = {
		isAllowed: (/** @type {any} */ p) => nodeA.isAuthorizedMember(p),
		isEnabled: () => true,
		now: () => Date.now(),
		async createInvitation(/** @type {any} */ { uses, expiresInMs }) {
			const minted = await nodeA.createCadreInvitation({ uses, expiresInMs });
			// cadre-core stores UTC datetime() text with no zone: read it as UTC (66-09 instrument rule).
			return { encoded: minted.encoded, inviteKey: minted.invitation.invite.key, expiresAt: canonical(expiryMs(minted.invitation.invite.expiresAt)) };
		},
		// Bound to A's OWN network hash and strand database, never the hash a request carries.
		isCurrentOfficer: async (/** @type {any} */ u, /** @type {any} */ nowCanonical) => await VE.isCurrentPairingOfficer(dbA, { userId: u, nowCanonical }),
		verifyStatement: async (/** @type {any} */ m) =>
			await VE.verifyPairingStatement(dbA, {
				networkHash: hash,
				statement: { userId: m.userId, nonce: m.nonce, expiresAt: m.expiresAt, requesterPeerId: m.requesterPeerId, keyPub: m.keyPub, sig: m.sig },
				nowCanonical: canonical(Date.now()),
				checkExpiry: true,
			}),
		async verifyRemove(/** @type {any} */ m) {
			const verdict = await VE.verifyPairingRemove(dbA, {
				networkHash: hash,
				request: { userId: m.userId, nonce: m.nonce, peerId: m.peerId, expiresAt: m.expiresAt, keyPub: m.keyPub, sig: m.sig },
				nowCanonical: canonical(Date.now()),
			});
			return verdict.ok === true;
		},
		inviteUsagePeer,
		async removeMachine(/** @type {any} */ peerId) {
			await nodeA.removeMachine(peerId);
		},
		mintLog,
	};
	const service = VE.createPairMintService(ports);
	detachPairMint = await VE.attachPairMint(nodeA.getControlNode(), service);
	const aTarget = nodeA.getControlNode().peerId;
	out('HOST_PAIR_MINT attached');

	// ---- 9. the R-D sweep (mirrors 66-10 planRevocationActions / 66-09 sweepRevocationsOnce) ------------
	const actedOn = new Set();
	/** @type {Promise<unknown>|null} */
	let sweepInFlight = null;
	/** Every outcome this process printed, in order (the self-check counts them). */
	/** @type {string[]} */
	const sweepOutcomes = [];
	async function sweepRevocationsOnce() {
		const rows = await all(dbA, 'select UserId, Nonce from DashboardPairingRevocation');
		const machines = new Set((await nodeA.listMachines()).map((/** @type {any} */ m) => m.peerId));
		let actions = 0;
		for (let i = 0; i < rows.length && actions < SWEEP_MAX_ACTIONS; i++) {
			const userId = String(rows[i].UserId);
			const nonce = String(rows[i].Nonce);
			const key = `${userId}|${nonce}`;
			if (actedOn.has(key)) continue;
			actions++;
			const entry = await mintLog.findByNonce(nonce);
			let outcome;
			// Officer AND pairing must match an APPROVED entry of this owner's own mint log.
			if (entry === null || entry.outcome !== 'approved' || entry.inviteKey === null || entry.userId !== userId) {
				outcome = 'no-mint-entry';
			} else {
				const peer = await inviteUsagePeer(entry.inviteKey);
				if (peer === null) {
					try {
						if (typeof nodeA.withdrawCadreInvitation === 'function') await nodeA.withdrawCadreInvitation(entry.inviteKey);
						entry.withdrawn = true;
						outcome = 'unredeemed-revoked';
					} catch (err) {
						outcome = 'withdraw-failed';
						out(`HOST_SWEEP_ERROR ${errName(err)}`);
					}
				} else if (!machines.has(peer)) {
					outcome = 'already-gone';
				} else {
					try {
						await nodeA.removeMachine(peer);
						machines.delete(peer);
						outcome = 'removed';
					} catch (err) {
						const code = /** @type {any} */ (err)?.code;
						outcome = code === 'not-an-owner' || code === 'self' ? 'refused-terminal' : 'remove-failed';
						if (outcome === 'remove-failed') out(`HOST_SWEEP_ERROR ${errName(err)}`);
					}
				}
			}
			// Failures retry on the next sweep; every other outcome is final for that pairing.
			if (outcome !== 'withdraw-failed' && outcome !== 'remove-failed') actedOn.add(key);
			sweepOutcomes.push(outcome);
			out(`HOST_SWEEP outcome=${outcome} row=${i}`);
		}
	}
	function sweepSingleFlight() {
		if (sweepInFlight !== null) return sweepInFlight;
		sweepInFlight = sweepRevocationsOnce()
			.catch((err) => out(`HOST_SWEEP_ERROR ${errName(err)}`))
			.finally(() => {
				sweepInFlight = null;
			});
		return sweepInFlight;
	}
	function releaseSweep() {
		if (sweepTimer !== null) return false;
		void sweepSingleFlight();
		sweepTimer = setInterval(() => void sweepSingleFlight(), SWEEP_EVERY_MS);
		return true;
	}
	out('HOST_SWEEP held');

	// ---- officer B's mint (66-11 requestPairingCode steps 2-9) -------------------------------------------
	/** @type {Map<string, { nonce: string, inviteKey: string, userId: string }>} */
	const labels = new Map();
	let lastBRequestAt = 0;
	async function paceB() {
		const wait = lastBRequestAt + B_REQUEST_SPACING_MS - Date.now();
		if (wait > 0) await sleep(wait);
	}
	async function sendFromB(/** @type {any} */ request) {
		for (let attempt = 0; ; attempt++) {
			await paceB();
			try {
				return await VE.requestPairMint(nodeB.getControlNode(), aTarget, request, { timeoutMs: 20_000 });
			} catch (caught) {
				const err = /** @type {any} */ (caught);
				// A guard reset on a member admitted seconds ago is retryable; a sent request never is.
				if (err instanceof VE.PairMintTransportError && err.requestSent === false && attempt < GUARD_RETRIES) {
					out(`HOST_MINT_RETRY attempt=${attempt + 1} reason=${String(err.reason)}`);
					await sleep(GUARD_RETRY_MS);
					continue;
				}
				throw err;
			} finally {
				lastBRequestAt = Date.now();
			}
		}
	}
	function secretChannelOpen() {
		try {
			const st = fstatSync(3);
			// fd 3 can be a libuv kqueue on macOS when no channel was passed: only a pipe or socket counts.
			return st.isFIFO() || st.isSocket();
		} catch {
			return false;
		}
	}

	/**
	 * One pairing code. `tampered`: the CODE carries a valid-format signature from a fresh unrelated
	 * P-256 key; the mint request itself carries the genuine one. Returns the code to the caller (the fd 3
	 * writer or the self-check validator), never to a printer.
	 */
	async function buildPairing(/** @type {any} */ label, /** @type {any} */ tampered) {
		const t0 = Date.now();
		const requesterPeerId = bPeerId;
		const anchor = await networksB.getJoinAnchor(hash);
		const nonce = base64url(randomBytes(16));
		const expiresAt = canonical(Date.now() + STATEMENT_LIFETIME_MS);
		const digest = await VE.pairingStatementDigest(dbB, { networkHash: hash, userId: B.user.id, nonce, expiresAt, requesterPeerId });
		const signature = await B.sign(digest);
		const request = { t: 'mint', v: 1, networkHash: hash, userId: B.user.id, nonce, expiresAt, requesterPeerId, keyPub: B.keyPub, sig: signature.signature };
		let reply;
		try {
			reply = await sendFromB(request);
		} catch (caught) {
			const err = /** @type {any} */ (caught);
			if (err instanceof VE.PairMintTransportError && err.requestSent === true) return { failed: 'no-reply' };
			return { failed: err instanceof VE.PairMintTransportError ? `transport-${String(err.reason)}` : 'request-failed' };
		}
		if (reply?.t === 'refused') return { failed: String(reply.code) };
		if (reply?.t !== 'minted') return { failed: 'reply-invalid' };
		const invitation = cadre.decodeCadreInvitation(reply.invitation);
		const ownerKeys = new Set((await nodeA.listOwnerKeys()).map((/** @type {any} */ k) => k.key));
		const invite = invitation?.invite;
		const replyOk =
			invite?.totalUses === 1 &&
			invite?.peerId === null &&
			invite?.key === reply.inviteKey &&
			invitation.partyId === nodeB.partyId &&
			typeof invite?.issuerKey === 'string' &&
			ownerKeys.has(invite.issuerKey) &&
			Array.isArray(invitation.ownerKeys) &&
			invitation.ownerKeys.length > 0 &&
			invitation.ownerKeys.every((/** @type {any} */ k) => ownerKeys.has(k));
		if (!replyOk) return { failed: 'reply-invalid' };
		// Instrument stand-in for a deployed relay (66-26 runs 1-2): A and B reach R at its loopback address,
		// so cadre-core lists loopback circuit members too. A deployed relay has only its public name, so
		// those members are dropped BEFORE the 66-11 trim (their count is printed). Left in, they lead the
		// code's relay list; the browser's gater refuses that address and libp2p's dial queue folds the
		// alias dial into the refused target, so the browser never opens a WebSocket (SUMMARY finding).
		const allMembers = Array.isArray(invitation.members) ? invitation.members : [];
		const isLoopbackMember = (/** @type {any} */ m) => typeof m === 'string' && (m.includes('/ip4/127.') || m.includes('/ip6/::1/') || m.includes('/dns4/localhost/'));
		const droppedLoopback = allMembers.filter(isLoopbackMember).length;
		// 66-11 trimInvitationMembers: at most 4, relay-circuit first, stable within each group.
		const memberList = allMembers.filter((/** @type {any} */ m) => !isLoopbackMember(m));
		const circuit = memberList.filter((/** @type {any} */ m) => typeof m === 'string' && m.includes('/p2p-circuit'));
		const direct = memberList.filter((/** @type {any} */ m) => !(typeof m === 'string' && m.includes('/p2p-circuit')));
		const trimmed = { ...invitation, members: [...circuit, ...direct].slice(0, INVITE_MAX_ADDRS) };
		const aliasMembers = trimmed.members.filter((/** @type {any} */ m) => m.includes(`/dns4/${opts.alias}/`) && m.includes('/p2p-circuit')).length;
		if (aliasMembers === 0) return { failed: 'no-alias-member' };
		// R-G8: the wss alias address leads the code, so the F-2 ordering failure can never hide a pass.
		const lead = trimmed.members[0];
		if (!(lead.startsWith(`/dns4/${opts.alias}/tcp/${opts.relayWssPort}/wss/p2p/${relayId}/p2p-circuit`))) return { failed: 'alias-not-first' };
		let codeSig = signature.signature;
		if (tampered) {
			const privBytes = p256.utils.randomSecretKey();
			codeSig = bytesToHex(p256.sign(digest, privBytes));
		}
		const encodedInvitation = cadre.encodeCadreInvitation(trimmed);
		const joinCode = VE.encodeNetworkJoinCode({ v: 2, invitation: encodedInvitation, networkHash: anchor.networkHash, name: anchor.name, genesis: anchor.genesis, digest: anchor.digest });
		const pairingCode = VE.encodePairingCode({ statement: { userId: B.user.id, requesterPeerId, nonce, expiresAt, keyPub: B.keyPub, sig: codeSig }, joinCode });
		const chars = pairingCode.length;
		if (chars > VE.PAIRING_QR_BYTE_BUDGET) return { failed: 'over-budget' };
		labels.set(label, { nonce, inviteKey: reply.inviteKey, userId: B.user.id });
		return { pairingCode, chars, members: trimmed.members.length, aliasMembers, droppedLoopback, ms: Date.now() - t0 };
	}

	async function cmdMint(/** @type {any} */ label, /** @type {any} */ tampered) {
		if (!secretChannelOpen()) {
			out('HOST_REFUSED no-secret-channel');
			return;
		}
		if (labels.has(label)) {
			out('HOST_REFUSED label-used');
			return;
		}
		const built = await buildPairing(label, tampered);
		if (built.failed !== undefined) {
			out(`HOST_MINT_FAILED label=${label} reason=${built.failed}`);
			return;
		}
		const { pairingCode } = built;
		writeSync(3, `${label} ${pairingCode}\n`);
		out(`HOST_MINTED label=${label} chars=${built.chars} members=${built.members} aliasMembers=${built.aliasMembers} droppedLoopback=${built.droppedLoopback} ms=${built.ms}`);
	}

	async function cmdSeedChange() {
		const name = `Live Mesh Seed ${randomBytes(3).toString('hex')}`;
		const inviteShare = authorityA.createAuthorityInvite(name);
		await authorityA.saveInviteWithSigning(inviteShare, 'iad', F.sign);
		const inviteKey = inviteShare.inviteKey;
		await pollUntil(() => first(dbB, 'select 1 as x from InviteSlot where InviteKey = :k', { k: inviteKey }), (/** @type {any} */ r) => r != null, ms(60_000), 'seed-replica');
		out(`HOST_SEEDED name=${name}`);
	}

	async function cmdRevoke(/** @type {any} */ label) {
		const entry = labels.get(label);
		if (!entry) {
			out('HOST_REFUSED unknown-label');
			return;
		}
		await VE.revokeDashboardPairing(ctxB, { userId: B.user.id, nonce: entry.nonce, signer: { userId: B.user.id, signingPublicKey: B.keyPub, sign: B.sign } });
		await pollUntil(() => VE.isPairingRevoked(dbA, { userId: B.user.id, nonce: entry.nonce }), (/** @type {any} */ v) => v === true, ms(60_000), 'revocation-replica');
		out(`HOST_REVOKED label=${label}`);
	}

	async function cmdRemove(/** @type {any} */ label) {
		const entry = labels.get(label);
		if (!entry) {
			out('HOST_REFUSED unknown-label');
			return;
		}
		const peer = await inviteUsagePeer(entry.inviteKey);
		if (peer === null) {
			out(`HOST_REMOVED label=${label} removedPeer=false`);
			return;
		}
		await nodeA.removeMachine(peer);
		const still = (await nodeA.listMachines()).some((/** @type {any} */ m) => m.peerId === peer);
		out(`HOST_REMOVED label=${label} removedPeer=${!still}`);
	}

	async function cmdStatus(/** @type {any} */ label) {
		const entry = labels.get(label);
		if (!entry) {
			out('HOST_REFUSED unknown-label');
			return;
		}
		const usagePeer = await inviteUsagePeer(entry.inviteKey);
		const machines = await nodeA.listMachines();
		const machine = usagePeer === null ? undefined : machines.find((/** @type {any} */ m) => m.peerId === usagePeer);
		const invites = await nodeA.listCadreInvitations();
		const inv = invites.find((/** @type {any} */ s) => s.invite.key === entry.inviteKey);
		const controlConns = nodeA.getControlNode().getConnections();
		const controlViaCircuit = usagePeer !== null && controlConns.some((/** @type {any} */ c) => String(c.remotePeer) === usagePeer && String(c.remoteAddr).includes('/p2p-circuit'));
		const bStrandPeer = String(nodeB.getStrand(hash)?.libp2pNode?.peerId ?? '');
		const strandConns = nodeA.getStrand(hash)?.libp2pNode?.getConnections() ?? [];
		const strandCircuitConns = strandConns.filter((/** @type {any} */ c) => String(c.remoteAddr).includes('/p2p-circuit') && String(c.remotePeer) !== bStrandPeer).length;
		out(
			`HOST_STATUS ${JSON.stringify({
				label,
				usagePeer,
				authorized: usagePeer === null ? false : await nodeA.isAuthorizedMember(usagePeer),
				inMachines: machine !== undefined,
				lastPublishedAgeMs: typeof machine?.lastPublishedAt === 'number' ? Date.now() - machine.lastPublishedAt : null,
				usesRecorded: inv?.usesRecorded ?? null,
				totalUses: inv?.invite?.totalUses ?? null,
				controlViaCircuit,
				strandCircuitConns,
				bAuthorized: await nodeA.isAuthorizedMember(bPeerId),
			})}`,
		);
	}

	out('HOST_READY');

	// ---- --self-check ---------------------------------------------------------------------------------
	if (opts.selfCheck) {
		let leg = 'mint';
		try {
			const built = await buildPairing('sc-1', false);
			if (built.failed !== undefined) throw new HostFatal(`mint-${built.failed}`);
			leg = 'decode';
			const decodedPairing = VE.decodePairingCode(built.pairingCode);
			const decodedJoin = VE.decodeNetworkJoinCode(decodedPairing.joinCode);
			if (!decodedJoin.ok) throw new HostFatal('decode');
			leg = 'verify';
			const verdict = await VE.verifyPairingStatement(dbA, { networkHash: hash, statement: decodedPairing.statement, nowCanonical: canonical(Date.now()), checkExpiry: true });
			if (verdict.ok !== true) throw new HostFatal('verify');
			if (built.aliasMembers < 1 || built.chars > VE.PAIRING_QR_BYTE_BUDGET) throw new HostFatal('shape');
			leg = 'revoke';
			await cmdRevoke('sc-1');
			leg = 'sweep';
			const entry = labels.get('sc-1');
			if (entry === undefined) throw new HostFatal('label');
			releaseSweep();
			out('HOST_SWEEP_RELEASED');
			await pollUntil(async () => actedOn.has(`${B.user.id}|${entry.nonce}`), (/** @type {any} */ v) => v === true, ms(30_000), 'sweep');
			// Two more sweep ticks: a pairing is acted on once, so nothing else may print.
			await sleep(2 * SWEEP_EVERY_MS + 500);
			const unredeemed = sweepOutcomes.filter((o) => o === 'unredeemed-revoked').length;
			const removed = sweepOutcomes.filter((o) => o === 'removed').length;
			const withdrawn = mintEntries.some((e) => e.nonce === entry.nonce && e.withdrawn === true);
			if (unredeemed !== 1 || removed !== 0 || !withdrawn) throw new HostFatal('sweep');
			leg = 'tampered';
			const bad = await buildPairing('sc-2', true);
			if (bad.failed !== undefined) throw new HostFatal(`mint-${bad.failed}`);
			const badPairing = VE.decodePairingCode(bad.pairingCode);
			const badVerdict = await VE.verifyPairingStatement(dbA, { networkHash: hash, statement: badPairing.statement, nowCanonical: canonical(Date.now()), checkExpiry: true });
			if (badVerdict.ok !== false || badVerdict.reason !== 'bad-signature') throw new HostFatal('tampered');
			out('HOST_SELF_CHECK PASS');
			await shutdown(0);
		} catch (err) {
			out(`HOST_SELF_CHECK FAIL:${leg}`);
			out(`HOST_SELF_CHECK_ERROR ${tokenOf(err)}`);
			if (!stopping) {
				stopping = true;
				await stopAll();
			}
			out('HOST_STOPPED');
			process.exit(1);
		}
		return;
	}

	// ---- stdin command loop (serialized; `stop` is immediate) ----------------------------------------------
	let chain = Promise.resolve();
	const rl = createInterface({ input: process.stdin });
	rl.on('line', (raw) => {
		const line = raw.trim();
		if (line === 'stop') {
			void shutdown(0);
			return;
		}
		const [cmd, label, extra] = line.split(/\s+/);
		const needsLabel = new Set(['mint', 'mint-tampered', 'revoke', 'remove', 'status']);
		const bare = new Set(['seed-change', 'sweep-release']);
		if (extra !== undefined || (!needsLabel.has(cmd) && !bare.has(cmd))) {
			out('HOST_REFUSED unknown-command');
			return;
		}
		if (needsLabel.has(cmd) && (label === undefined || !LABEL_RE.test(label))) {
			out('HOST_REFUSED bad-label');
			return;
		}
		if (bare.has(cmd) && label !== undefined) {
			out('HOST_REFUSED unknown-command');
			return;
		}
		chain = chain.then(async () => {
			try {
				if (cmd === 'mint') await cmdMint(label, false);
				else if (cmd === 'mint-tampered') await cmdMint(label, true);
				else if (cmd === 'seed-change') await cmdSeedChange();
				else if (cmd === 'revoke') await cmdRevoke(label);
				else if (cmd === 'remove') await cmdRemove(label);
				else if (cmd === 'status') await cmdStatus(label);
				else if (cmd === 'sweep-release') {
					releaseSweep();
					out('HOST_SWEEP_RELEASED');
				}
			} catch (err) {
				const token = tokenOf(err);
				if (cmd === 'mint' || cmd === 'mint-tampered') out(`HOST_MINT_FAILED label=${label} reason=${token}`);
				else out(`HOST_REFUSED ${cmd}-${token}`);
			}
		});
	});
	rl.on('close', () => void shutdown(0));
}

/** VOTETORRENT_SCHEMA_SQL without its `declare schema … apply schema` wrapper (vote-cli engine.mjs). */
function innerDdl(/** @type {any} */ sql) {
	return sql
		.replace(/^\s*declare\s+schema\s+\w+\s*\{/, '')
		.replace(/\}\s*apply\s+schema\s+\w+\s*;\s*$/, '')
		.trim();
}

/** Voter `isSelfAdmitted` / Authority `isSelfVouched`, invitation branch (vote-cli common.mjs). */
async function isSelfAdmitted(/** @type {any} */ cadre, /** @type {any} */ node) {
	const store = node.getTrustedOwnerStore();
	const db = node.getControlDatabase();
	if (!store || !db) return false;
	const selfId = node.peerId.toString();
	const self = (await db.queryCadrePeers()).find((/** @type {any} */ row) => row.peerId === selfId);
	if (!self || !(self.vouchSig === null && self.vouchUsage != null)) return false;
	const [usages, invites] = await Promise.all([db.queryCadreInviteUsages(), db.queryCadreInvites()]);
	const usage = usages.find((/** @type {any} */ u) => u.usageStampId === self.vouchUsage);
	const invite = usage === undefined ? undefined : invites.find((/** @type {any} */ i) => i.key === usage.inviteKey);
	if (usage === undefined || invite === undefined) return false;
	return cadre.verifyInvitationAdmission(node.partyId, self, usage, invite, (/** @type {any} */ key) => store.has(key));
}

main().catch((err) => void fatal(err));
