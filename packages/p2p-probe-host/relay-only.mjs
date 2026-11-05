/**
 * packages/p2p-probe-host/relay-only.mjs - the D-17 LAN relay of the Phase 64 device rig
 * (notes section 9 "Relay").
 *
 * WHAT IT IS. A long-running CadreNode of party `votetorrent-relay` (NOT `votetorrent`), profile
 * `storage`, that does one job: carry circuit-relay-v2 reservations for the rig's phones, emulators and
 * host voters on the Mac's LAN. It has a persistent Ed25519 key (so its peer id and multiaddr survive a
 * stop and a restart) and a fixed port, and it writes the scratch `bootstrap.config.json` that both rig
 * Metros serve to the apps. Run it from `packages/p2p-probe-host` so this package's own patched
 * node_modules resolve.
 *
 * IT MUST NEVER BE REPLACED BY `drone.mjs`. drone.mjs always runs owner genesis and addStrand, and so it
 * forks a device-founded strand (memory project_drone_forks_device_founded_strand). This node has no
 * owner genesis, no strand, no invitation and no trusted owner, and its readback proves it on every start.
 *
 * WHY NO RELAY INIT. cadre-core's party-run relay defaults (relay-server.js) are an uncapped reservation
 * (no data or duration limit), 128 slots and a 2 h TTL. db-p2p refuses limited connections, so a capped
 * relay cuts off every sync (memory project_drone_relay_128kib_cap_and_dial_self). The defaults are the
 * point, so no relay option is passed and the LIVE reservation store is read back instead.
 *
 * WHY NO CLAIM. A claim makes `isAwaitingClaim` refuse every reservation until the claim lands.
 * WHY NO GENESIS. With no owner anchor the admission path falls to its empty-anchor branch, which admits
 * every reservation without spending the small unauthorized-reservation budget.
 *
 * STDOUT LINE CONTRACT (column 0):
 *   RELAY_STACK {json}   RELAY_REFUSED <token> (then exit 2)   RELAY_KEY created|loaded type=Ed25519
 *   RELAY_PEER_ID=<id>   RELAY_MULTIADDR=<addr>   RELAY_READBACK {json}   RELAY_LIMITS {json}
 *   RELAY_BOOTSTRAP written|unchanged sha256=<12 hex>   RELAY_READY   RELAY_STATUS {json}
 *   RELAY_LATE_ERROR <name>   RELAY_STOPPED (exit 0)   RELAY_FATAL <token> (exit 1)
 *   PROBE_CLIENT {json}   (--probe-client mode, exit 0)
 *
 * PUBLIC MODE (--announce). Behind a TLS tunnel or proxy (ngrok, Caddy) that forwards
 * `wss://<host>:443` to this port, `--announce /dns4/<host>/tcp/443/wss` makes the node advertise that
 * address instead of its LAN one (cadre-core `network.announceAddrs`). A relayed phone's own address
 * is built from what the relay advertises, so a LAN address would leave phones off the LAN unable to
 * dial it; and a release build refuses cleartext `ws://`, so a public relay must be `wss`.
 * `--lan-ip` is then not needed.
 *
 * USAGE
 *   serve : node relay-only.mjs --key-file <abs> --port <int> --lan-ip <IPv4> --bootstrap-out <abs .json>
 *                               [--status-ms 60000]
 *           node relay-only.mjs --key-file <abs> --port <int> --announce /dns4/<host>/tcp/443/wss
 *                               --bootstrap-out <abs .json> [--status-ms 60000]
 *   probe : node relay-only.mjs --probe-client <multiaddr> [--timeout-ms 60000]
 */
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname, basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CadreNode, resolveRelayServer } from '@serfab/cadre-core';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const RELAY_PARTY = 'votetorrent-relay';
const CLIENT_PARTY = 'votetorrent';

// ---- output helpers ----------------------------------------------------------------------------------
let transferLimitErrors = 0;
const realStdoutWrite = process.stdout.write.bind(process.stdout);
const realStderrWrite = process.stderr.write.bind(process.stderr);
function countTransferLimit(chunk) {
	const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
	let idx = text.indexOf('TransferLimitError');
	while (idx !== -1) {
		transferLimitErrors++;
		idx = text.indexOf('TransferLimitError', idx + 1);
	}
}
function out(line) {
	realStdoutWrite(line + '\n');
}
function refuse(token) {
	out('RELAY_REFUSED ' + token);
	process.exit(2);
}
function fatal(token) {
	out('RELAY_FATAL ' + token);
	process.exit(1);
}

// ---- argument parsing --------------------------------------------------------------------------------
function parseArgs(argv) {
	const opts = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--help' || a === '-h') {
			opts.help = true;
		} else if (a.startsWith('--')) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('--')) {
				refuse('usage');
			}
			opts[key] = next;
			i++;
		} else {
			refuse('usage');
		}
	}
	return opts;
}

function usage() {
	out('usage: relay-only.mjs --key-file <abs> --port <int> --lan-ip <IPv4> --bootstrap-out <abs.json> [--status-ms N]');
	out('       relay-only.mjs --key-file <abs> --port <int> --announce /dns4/<host>/tcp/443/wss --bootstrap-out <abs.json> [--status-ms N]');
	out('       relay-only.mjs --probe-client <multiaddr> [--timeout-ms N]');
}

/** The resolved path of `p`, using the real path of its nearest existing ancestor. */
function resolvedPath(p) {
	let cur = resolve(p);
	const tail = [];
	while (!existsSync(cur)) {
		const parent = dirname(cur);
		if (parent === cur) break;
		tail.unshift(basename(cur));
		cur = parent;
	}
	let real = cur;
	try {
		real = realpathSync(cur);
	} catch {
		// keep the raw path
	}
	return tail.length > 0 ? join(real, ...tail) : real;
}
function insideRepo(p) {
	const r = resolvedPath(p);
	let repoReal = REPO;
	try {
		repoReal = realpathSync(REPO);
	} catch {
		// keep the raw path
	}
	return r === repoReal || r.startsWith(repoReal + sep);
}

/** A public relay is reached as wss on 443 by DNS name, the shape a TLS tunnel or proxy serves. */
const PUBLIC_WSS_ANNOUNCE = /^\/dns4\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+\/tcp\/443\/wss$/;

function isPrivateLanIp(ip) {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
	if (!m) return false;
	const o = m.slice(1).map(Number);
	if (o.some((n) => n > 255)) return false;
	if (o[0] === 10) return true;
	if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
	if (o[0] === 192 && o[1] === 168) return true;
	return o[0] === 127 && o[1] === 0 && o[2] === 0 && o[3] === 1;
}

// ---- stack preflight ---------------------------------------------------------------------------------
function versionOf(specifier) {
	let file = fileURLToPath(import.meta.resolve(specifier));
	for (let i = 0; i < 12; i++) {
		const dir = dirname(file);
		const pkgPath = join(dir, 'package.json');
		if (existsSync(pkgPath)) {
			const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
			if (pkg.name === specifier) return { version: pkg.version, dir };
		}
		if (dir === file) break;
		file = dir;
	}
	return { version: null, dir: null };
}
function stackPreflight() {
	const names = ['@serfab/cadre-core', '@optimystic/db-p2p', 'main-event', 'libp2p', '@libp2p/circuit-relay-v2'];
	const versions = {};
	let cadreDir = null;
	for (const n of names) {
		try {
			const v = versionOf(n);
			versions[n] = v.version;
			if (n === '@serfab/cadre-core') cadreDir = v.dir;
		} catch {
			versions[n] = null;
		}
	}
	let patch = false;
	try {
		patch = readFileSync(join(cadreDir, 'dist/cadre-node.js'), 'utf8').includes(
			'VoteTorrent patch (public-observer-protocol)',
		);
	} catch {
		patch = false;
	}
	const nodeOk = (() => {
		const [maj, min] = process.versions.node.split('.').map(Number);
		return maj > 20 || (maj === 20 && min >= 19);
	})();
	out('RELAY_STACK ' + JSON.stringify({ node: process.versions.node, versions, patch }));
	const ok =
		versions['@serfab/cadre-core'] === '1.21.0' &&
		patch &&
		versions['@optimystic/db-p2p'] === '1.25.0' &&
		versions['main-event'] === '1.0.5' &&
		nodeOk;
	if (!ok) refuse('stack');
}

// ---- cause-chain helper ------------------------------------------------------------------------------
function causeHas(err, pred) {
	let cur = err;
	for (let i = 0; i < 8 && cur; i++) {
		if (pred(cur)) return true;
		cur = cur.cause ?? (Array.isArray(cur.errors) ? cur.errors.find(pred) : undefined);
	}
	return false;
}
function isAddrInUse(err) {
	return causeHas(err, (e) => e.code === 'EADDRINUSE' || /EADDRINUSE/.test(String(e.message ?? '')));
}

function scopedProvider() {
	const byScope = new Map();
	return (scope) => {
		const id = typeof scope === 'string' ? scope : JSON.stringify(scope ?? 'default');
		if (!byScope.has(id)) byScope.set(id, new MemoryRawStorage());
		return byScope.get(id);
	};
}

function stopBounded(node, ms) {
	return Promise.race([
		node.stop().catch(() => undefined),
		new Promise((r) => setTimeout(r, ms)),
	]);
}

// ---- serve mode --------------------------------------------------------------------------------------
async function serve(opts) {
	const keyFile = opts['key-file'];
	const bootstrapOut = opts['bootstrap-out'];
	const lanIp = opts['lan-ip'];
	const announce = opts.announce;
	const port = Number(opts.port);
	const statusMs = opts['status-ms'] === undefined ? 60000 : Number(opts['status-ms']);
	if (!keyFile || !bootstrapOut || (!lanIp && !announce) || opts.port === undefined) refuse('usage');
	if (!keyFile.startsWith('/') || !bootstrapOut.startsWith('/')) refuse('usage');
	if (!bootstrapOut.endsWith('.json')) refuse('usage');
	if (insideRepo(keyFile) || insideRepo(bootstrapOut)) refuse('inside-repo');
	if (!Number.isInteger(port) || port < 1024 || port > 65535) refuse('port');
	if (announce !== undefined && !PUBLIC_WSS_ANNOUNCE.test(announce)) refuse('announce');
	if (announce === undefined && !isPrivateLanIp(lanIp)) refuse('lan-ip');
	if (!Number.isInteger(statusMs) || statusMs < 1000) refuse('usage');
	if (existsSync(keyFile) && (statSync(keyFile).mode & 0o077) !== 0) refuse('key-mode');
	stackPreflight();

	// Key: loaded from the protobuf file, or created (0600 in a 0700 dir) when absent. Never printed.
	let privateKey;
	if (existsSync(keyFile)) {
		privateKey = privateKeyFromProtobuf(readFileSync(keyFile));
		if (privateKey.type !== 'Ed25519') refuse('key-type');
		out('RELAY_KEY loaded type=Ed25519');
	} else {
		mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
		privateKey = await generateKeyPair('Ed25519');
		writeFileSync(keyFile, privateKeyToProtobuf(privateKey), { mode: 0o600, flag: 'wx' });
		out('RELAY_KEY created type=Ed25519');
	}

	// After this point stdout/stderr are watched for the one error name the cap would raise.
	process.stdout.write = (chunk, ...rest) => {
		countTransferLimit(chunk);
		return realStdoutWrite(chunk, ...rest);
	};
	process.stderr.write = (chunk, ...rest) => {
		countTransferLimit(chunk);
		return realStderrWrite(chunk, ...rest);
	};

	let lateErrors = 0;
	const lateNames = {};
	const onLate = (e) => {
		lateErrors++;
		const name = String(e?.name ?? 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60) || 'Error';
		lateNames[name] = (lateNames[name] ?? 0) + 1;
		out('RELAY_LATE_ERROR ' + name);
	};
	process.on('uncaughtException', onLate);
	process.on('unhandledRejection', onLate);

	const network = {
		transports: [webSockets()],
		listenAddrs: ['/ip4/0.0.0.0/tcp/' + port + '/ws'],
		...(announce !== undefined ? { announceAddrs: [announce] } : {}),
	};
	const node = new CadreNode({
		privateKey,
		controlNetwork: { partyId: RELAY_PARTY, bootstrapNodes: [] },
		profile: 'storage',
		strandFilter: { mode: 'none' },
		requireSignedSchemas: false,
		storage: { provider: scopedProvider() },
		hibernation: { enabled: false },
		network,
	});

	// Instrument only: count how many reservations the admission check lets in or turns away. The wrapper
	// awaits the original, bound to the node, and returns its answer unchanged.
	let admitted = 0;
	let refused = 0;
	let admissionInstrument = 'unavailable';
	if (typeof node.admitControlRelayReservation === 'function') {
		const original = node.admitControlRelayReservation.bind(node);
		node.admitControlRelayReservation = async (remotePeerId) => {
			const answer = await original(remotePeerId);
			if (answer) admitted++;
			else refused++;
			return answer;
		};
		admissionInstrument = 'wrapped';
	}

	try {
		await node.start();
	} catch (err) {
		if (isAddrInUse(err)) fatal('eaddrinuse');
		fatal('start-failed');
	}

	const peerId = String(node.peerId);
	out('RELAY_PEER_ID=' + peerId);
	const control = node.getControlNode();
	const multiaddr = (announce ?? '/ip4/' + lanIp + '/tcp/' + port + '/ws') + '/p2p/' + peerId;
	const listening = control.getMultiaddrs().map((m) => m.toString());
	if (!listening.includes(multiaddr)) fatal(announce !== undefined ? 'announce-not-advertised' : 'lan-ip-not-listening');
	if (!multiaddr.startsWith('/') || !multiaddr.includes('/p2p/') || multiaddr.length > 256) fatal('multiaddr-shape');
	out('RELAY_MULTIADDR=' + multiaddr);

	const readback = {
		partyId: node.partyId,
		trustedOwners: node.getTrustedOwnerStore()?.all().size ?? 0,
		ownerKeys: (await node.getControlDatabase().getOwnerKeys()).size,
		strands: (() => {
			const s = node.getStrands();
			return s?.size ?? s?.length ?? 0;
		})(),
		awaitingClaim: node.isAwaitingClaim(),
		relayService: control.services?.relay != null,
	};
	out('RELAY_READBACK ' + JSON.stringify(readback));
	if (
		readback.partyId !== RELAY_PARTY ||
		readback.trustedOwners !== 0 ||
		readback.ownerKeys !== 0 ||
		readback.strands !== 0 ||
		readback.awaitingClaim !== false ||
		readback.relayService !== true
	) {
		await stopBounded(node, 10000);
		fatal('readback');
	}

	const store = control.services.relay.reservationStore;
	const resolved = resolveRelayServer(network, 'storage').init.reservations;
	out(
		'RELAY_LIMITS ' +
			JSON.stringify({
				applyDefaultLimit: store.applyDefaultLimit,
				maxReservations: store.maxReservations,
				reservationTtlMs: store.reservationTtl,
				resolvedDefaults: {
					applyDefaultLimit: resolved.applyDefaultLimit,
					maxReservations: resolved.maxReservations,
					reservationTtl: resolved.reservationTtl,
				},
			}),
	);
	if (store.applyDefaultLimit !== false) {
		await stopBounded(node, 10000);
		fatal('default-limit');
	}

	// Bootstrap file: written only when the content differs (a restart rewrites nothing).
	const content = JSON.stringify({ bootstrapNodes: [multiaddr] }, null, '\t') + '\n';
	const sha = createHash('sha256').update(content).digest('hex').slice(0, 12);
	let same = false;
	try {
		same = existsSync(bootstrapOut) && readFileSync(bootstrapOut, 'utf8') === content;
	} catch {
		same = false;
	}
	if (same) {
		out('RELAY_BOOTSTRAP unchanged sha256=' + sha);
	} else {
		mkdirSync(dirname(bootstrapOut), { recursive: true });
		const tmp = bootstrapOut + '.tmp-' + process.pid;
		writeFileSync(tmp, content);
		renameSync(tmp, bootstrapOut);
		out('RELAY_BOOTSTRAP written sha256=' + sha);
	}

	const started = Date.now();
	function status() {
		const reservations = store.reservations;
		let active = 0;
		let limited = 0;
		for (const [, r] of reservations) {
			active++;
			if (r?.limit != null && (r.limit.data != null || r.limit.duration != null)) limited++;
		}
		out(
			'RELAY_STATUS ' +
				JSON.stringify({
					t: new Date().toISOString(),
					uptimeS: Math.round((Date.now() - started) / 1000),
					connections: control.getConnections().length,
					activeReservations: active,
					limitedReservations: limited,
					applyDefaultLimit: store.applyDefaultLimit,
					reservationsAdmitted: admitted,
					reservationsRefused: refused,
					admissionInstrument,
					transferLimitErrors,
					lateErrors,
				}),
		);
	}
	out('RELAY_READY');
	status();
	const timer = setInterval(status, statusMs);

	let stopping = false;
	async function stop(signal) {
		if (stopping) return;
		stopping = true;
		clearInterval(timer);
		void signal;
		status();
		await stopBounded(node, 10000);
		out('RELAY_STOPPED');
		process.exit(0);
	}
	process.on('SIGTERM', () => void stop('SIGTERM'));
	process.on('SIGINT', () => void stop('SIGINT'));
	void lateNames;
}

// ---- probe-client mode -------------------------------------------------------------------------------
async function probeClient(opts) {
	const relayAddr = opts['probe-client'];
	const timeoutMs = opts['timeout-ms'] === undefined ? 60000 : Number(opts['timeout-ms']);
	if (!relayAddr || !relayAddr.startsWith('/') || !relayAddr.includes('/p2p/')) refuse('usage');
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) refuse('usage');
	const relayPeerId = relayAddr.split('/p2p/')[1].split('/')[0];

	// The Authority shape (CadreNodeProvider.tsx): party votetorrent, relay addresses only. With
	// `listenAddrs: []` plus `relayAddrs` the node listens only on the bare /p2p-circuit (cadre-core
	// relay-addrs.js, the React Native cannot-listen case); a relay-qualified listen address is rejected by
	// cadre-core 0.12+.
	const node = new CadreNode({
		privateKey: await generateKeyPair('Ed25519'),
		controlNetwork: { partyId: CLIENT_PARTY, bootstrapNodes: [relayAddr] },
		profile: 'transaction',
		requireSignedSchemas: false,
		strandFilter: { mode: 'all' },
		storage: { provider: scopedProvider() },
		hibernation: { enabled: false },
		network: {
			controlCohort: { strandAddrRefreshMs: 30_000 },
			transports: [webSockets(), circuitRelayTransport({ reservationConcurrency: 1 })],
			listenAddrs: [],
			relayAddrs: [relayAddr],
			connectionGater: { denyDialMultiaddr: async () => false },
		},
	});

	const t0 = Date.now();
	let error = null;
	let circuit = null;
	let addrs = [];
	try {
		await node.start();
		const control = node.getControlNode();
		while (Date.now() - t0 < timeoutMs) {
			addrs = control.getMultiaddrs().map((m) => m.toString());
			circuit = addrs.find((a) => a.includes('/p2p/' + relayPeerId + '/p2p-circuit')) ?? null;
			if (circuit) break;
			await new Promise((r) => setTimeout(r, 250));
		}
	} catch (err) {
		error = String(err?.name ?? 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60) || 'Error';
	}
	const result = {
		reserved: circuit != null,
		ms: Date.now() - t0,
		circuitViaRelay: circuit != null,
		directAddrs: addrs.filter((a) => !a.includes('/p2p-circuit')).length,
		error,
	};
	out('PROBE_CLIENT ' + JSON.stringify(result));
	await stopBounded(node, 10000);
	process.exit(0);
}

// ---- entry -------------------------------------------------------------------------------------------
const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
	usage();
	process.exit(0);
}
if (opts['probe-client'] !== undefined) {
	probeClient(opts).catch(() => fatal('probe-failed'));
} else {
	serve(opts).catch(() => fatal('serve-failed'));
}
