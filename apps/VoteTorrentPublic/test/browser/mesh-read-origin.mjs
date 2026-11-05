#!/usr/bin/env node
/**
 * mesh-read-origin.mjs — the mesh-read gate's origin process. Spawned by
 * `run-mesh-read-gate.mjs` (Task 3); boots `56-08`'s REAL gateway in-process
 * via its `startGateway` export, re-asserts every precondition that would
 * otherwise let the gate certify a cold-start or unpatched node, seeds a
 * production-length election into the strand, and mutates it on command over
 * a pipe the driver already owns.
 *
 * CadreNode boot is CPU-heavy, and a busy host has previously manufactured
 * false failures (`project_voter_emulator_boot_needs_quiet_host`) — do not
 * run this alongside `nx run-many` or any other CPU-heavy concurrent task.
 *
 * ALL GATE-ONLY CODE LIVES HERE, NEVER IN THE GATEWAY. `gateway.mjs` gained
 * exactly one named export and a CLI guard; no seeding, no fixture import
 * and no write path was added to it. This file is where the phase's own
 * D-19(a) production-length seed (`seedFoundingAuthority`/
 * `seedElectionSurface`) and the one `Keyholder` mutation live instead.
 *
 * PER-RUN STRAND ID, WITHOUT A NEW GATEWAY FLAG OR CONFIG KEY. The driver
 * passes a fresh strandId every run (`/^[A-Za-z0-9-_]{1,128}$/`), but
 * `startGateway` takes only `{ config: <path> }` — no strand-id override
 * parameter, by the plan's own "no new flag, no new config key" prohibition.
 * This file resolves that by reading the OPERATOR'S config file for every
 * key EXCEPT `publicObserverStrandIds` (which it overrides to exactly this
 * run's strand id), resolving `tls.certPath`/`tls.keyPath` to ABSOLUTE paths
 * (so the temp file's own directory never matters), and writing the result
 * to a throwaway temp file that `startGateway` loads like any other config.
 * `gateway.mjs` itself changes NOTHING to support this — the override lives
 * entirely on this side of the `startGateway` boundary.
 *
 * PRECONDITIONS RE-ASSERTED, NOT ASSUMED. `56-08`'s own boot sequence
 * already refuses a cold-start/plaintext/open-enrollment gateway, but
 * `project_device_proof_bundle_provenance` cost three runs to a stale server
 * and `feedback_read_back_preconditions_dont_infer` is the discipline D-07
 * exists to enforce — so this file re-checks the same four facts at ITS OWN
 * consumer boundary, each fatal with its own name, before ever touching the
 * strand.
 *
 * NO SOCKET, NO HTTP ENDPOINT. This process is driven exclusively over the
 * stdin pipe the driver already owns (newline-delimited commands, a CLOSED
 * vocabulary of exactly two: `mutate`, `stop`). Error NAMES only ever reach
 * stdout — a Quereus constraint message can carry row values, and this
 * process must never let one reach the pipe.
 *
 * TWO ADDITIVE EMISSIONS (`56-13` Task 1), over that same pipe — no new
 * socket, no new flag, no new config key, and `gateway.mjs` untouched:
 *
 *   1. `ORIGIN_PROVENANCE=<verdict>` is emitted FIRST, before this file can
 *      fatally refuse for any reason, by running `56-08`'s shipped
 *      `--check-dist` CLI against the `@serfab/cadre-core` package root
 *      resolved RELATIVE TO `gateway.mjs` (never relative to this app's own
 *      tree, which is a different workspace copy and would silently check
 *      the wrong bytes). Only a `PASS` proceeds to `startGateway`. This
 *      ordering is what lets a control that reverts the patch observe
 *      `PREFLIGHT_FAILED:origin-provenance` instead of an ambiguous timeout
 *      or a generic child exit — without it, the strongest control this
 *      phase can run would fail unattributably.
 *
 *   2. `ORIGIN_PEER_CONNECTED=<peerId>` / `ORIGIN_PEER_DISCONNECTED=<peerId>`,
 *      one line per inbound connection to the started gateway's CONTROL node
 *      — the node whose multiaddr `ORIGIN_CONTROL_ADDR` advertises and which
 *      a browser's bootstrap config names. Peer NAMES only: no addresses, no
 *      durations, no payload beyond each line's own arrival order. This is
 *      general instrumentation, built unconditionally; a consumer that
 *      windows these lines per page load is a separate concern and lives
 *      elsewhere.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve as resolvePath, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startGateway } from '../../../../packages/p2p-probe-host/gateway.mjs';

/** The gateway module this origin boots, and the module every provenance
 * question below is resolved RELATIVE TO. */
const GATEWAY_MODULE_URL = new URL('../../../../packages/p2p-probe-host/gateway.mjs', import.meta.url);
const GATEWAY_MODULE_PATH = fileURLToPath(GATEWAY_MODULE_URL);
const CADRE_CORE_SPECIFIER = '@serfab/cadre-core';

/**
 * The `@serfab/cadre-core` package ROOT that `gateway.mjs` would resolve.
 *
 * `createRequire(<gateway url>).resolve('@serfab/cadre-core')` cannot be used
 * directly: the package publishes an ESM-only `exports` map with no `require`
 * condition, so CJS resolution throws `ERR_PACKAGE_PATH_NOT_EXPORTED` —
 * `gateway.mjs`'s own boot gate records the same finding. What `createRequire`
 * DOES give, correctly and without hand-rolling anything, is Node's own
 * ordered `node_modules` candidate list for that module URL
 * (`require.resolve.paths`). The first candidate holding the package is the
 * one the gateway's process would load. Resolving from THIS file's own URL
 * instead would find the app's independent workspace copy
 * (`nmHoistingLimits: workspaces` — three copies, no root copy) and would
 * prove nothing about the gateway.
 *
 * @returns {string | null}
 */
function resolveGatewayCadreCoreRoot() {
	const req = createRequire(GATEWAY_MODULE_URL);
	const candidates = req.resolve.paths(CADRE_CORE_SPECIFIER) ?? [];
	for (const dir of candidates) {
		const root = join(dir, CADRE_CORE_SPECIFIER);
		if (existsSync(join(root, 'package.json'))) return root;
	}
	return null;
}

/**
 * Run `56-08`'s shipped `node gateway.mjs --check-dist <packageRoot>` and
 * return the verdict it prints. The provenance decision matrix is CONSUMED,
 * never re-derived here — two copies of a provenance check are two
 * instruments that diverge silently, and consuming the CLI is also why this
 * file needs no protocol token of its own.
 *
 * @param {string} packageRoot
 * @returns {Promise<string>} `PASS` or `FAIL:<reason>` or `UNRESOLVED:<reason>`
 */
function checkDistVerdict(packageRoot) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [GATEWAY_MODULE_PATH, '--check-dist', packageRoot], {
			cwd: dirname(GATEWAY_MODULE_PATH),
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let out = '';
		child.stdout.on('data', (d) => {
			out += d;
		});
		child.stderr.on('data', (d) => {
			out += d;
		});
		child.on('error', (err) => resolve(`UNRESOLVED:spawn-failed-${err?.name ?? 'Error'}`));
		child.on('exit', () => {
			const match = out.match(/PROVENANCE=([^\s]+)/);
			resolve(match ? match[1] : 'UNRESOLVED:no-provenance-line');
		});
	});
}

/**
 * Print an `ORIGIN_FATAL:<name>` line naming the offending precondition and
 * exit non-zero. Never optional — every precondition below is asserted,
 * never assumed.
 * @param {string} name
 * @param {string} reason
 * @returns {never}
 */
function fatal(name, reason) {
	console.error(`ORIGIN_FATAL:${name}: ${reason}`);
	process.exit(1);
}

/**
 * @param {string[]} argv
 * @returns {{ config: string, strandId: string }}
 */
function parseArgs(argv) {
	/** @type {{ config?: string, strandId?: string }} */
	const args = {};
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === '--config') args.config = argv[i + 1];
		else if (argv[i] === '--strand-id') args.strandId = argv[i + 1];
	}
	if (!args.config) fatal('config', '--config is required');
	if (!args.strandId || !/^[A-Za-z0-9_-]{1,128}$/.test(args.strandId)) {
		fatal('strand-id', '--strand-id is required and must match /^[A-Za-z0-9_-]{1,128}$/');
	}
	return /** @type {{ config: string, strandId: string }} */ (args);
}

async function main() {
	// ── Emission 1, FIRST, before this process can fatally refuse for any
	// reason at all. See this file's header for why the ordering is what makes
	// a reverted-patch run attributable rather than an ambiguous timeout.
	const cadreCoreRoot = resolveGatewayCadreCoreRoot();
	const provenanceVerdict = cadreCoreRoot
		? await checkDistVerdict(cadreCoreRoot)
		: `UNRESOLVED:no-${CADRE_CORE_SPECIFIER}-under-gateway`;
	console.log('ORIGIN_PROVENANCE=' + provenanceVerdict);
	if (provenanceVerdict !== 'PASS') {
		fatal('origin-provenance', `--check-dist on ${cadreCoreRoot ?? '(unresolved)'} reported ${provenanceVerdict}`);
	}

	const args = parseArgs(process.argv.slice(2));

	const originalConfigPath = resolvePath(process.cwd(), args.config);
	if (!existsSync(originalConfigPath)) {
		fatal('config', `--config file not found at ${originalConfigPath}`);
	}
	const originalConfigDir = dirname(originalConfigPath);
	/** @type {any} */
	let baseConfig;
	try {
		baseConfig = JSON.parse(readFileSync(originalConfigPath, 'utf8'));
	} catch (err) {
		fatal('config', `--config file is not valid JSON (${err && /** @type {any} */ (err).name})`);
	}

	// Every key EXCEPT publicObserverStrandIds is transcribed unchanged; tls
	// paths are made absolute so this run's temp config file can live
	// anywhere. See this file's header for why this is done here, never in
	// gateway.mjs.
	const overrideConfig = {
		...baseConfig,
		publicObserverStrandIds: [args.strandId],
		tls: {
			certPath: resolvePath(originalConfigDir, baseConfig.tls.certPath),
			keyPath: resolvePath(originalConfigDir, baseConfig.tls.keyPath),
		},
	};
	const tempDir = mkdtempSync(join(tmpdir(), 'mesh-read-origin-'));
	const tempConfigPath = join(tempDir, 'gateway.config.json');
	writeFileSync(tempConfigPath, JSON.stringify(overrideConfig, null, 2));

	const handle = await startGateway({ config: tempConfigPath });

	// -- Re-assert every precondition, fatally, each with its own name. ------
	if (handle.provenance.verdict !== 'PASS') {
		fatal('origin-provenance', `provenance.verdict is "${handle.provenance.verdict}", expected "PASS"`);
	}
	// The gateway's OWN boot-gate verdict and the pre-boot `--check-dist`
	// verdict above are two readings of the same decision matrix over the
	// same package root. They must agree; a disagreement means one of the two
	// read a different copy, which would make every verdict downstream of
	// either one unattributable.
	if (handle.provenance.verdict !== provenanceVerdict) {
		fatal(
			'origin-provenance-disagreement',
			`pre-boot --check-dist said "${provenanceVerdict}" but the gateway's own boot gate said "${handle.provenance.verdict}"`,
		);
	}
	if (!(handle.authorizedMemberCount >= 1)) {
		fatal('origin-cold-start', `authorizedMemberCount is ${handle.authorizedMemberCount}, expected >= 1`);
	}
	// cadre-core 1.14 deleted the enrollment window; a LIVE cadre invitation is the stranger
	// window that replaced it, so the gateway must hold none for admission to be attributable to
	// the observer allowlist.
	if (handle.liveCadreInvitations !== 0) {
		fatal('origin-stranger-window-open', `liveCadreInvitations is ${handle.liveCadreInvitations}, expected 0`);
	}
	for (const addr of handle.controlAddrs) {
		if (!addr.includes('/tls/ws')) {
			fatal('origin-plaintext-addr', `control address does not carry /tls/ws`);
		}
	}
	if (!handle.tls.spkiSha256Base64) {
		fatal('tls-pin-absent', 'the gateway reported no SPKI pin');
	}

	// ORIGIN_PROVENANCE is NOT re-printed here: it is emitted once, at the top
	// of main(), and the assertion above already proves the gateway's own boot
	// gate agrees with it. A second line carrying the same key would let a
	// consumer that keeps the LAST value silently read a different fact from
	// one that keeps the FIRST.
	console.log('ORIGIN_AUTHORIZED_MEMBERS=' + handle.authorizedMemberCount);
	console.log('ORIGIN_LIVE_CADRE_INVITATIONS=' + handle.liveCadreInvitations);
	console.log('ORIGIN_RELAY=' + (handle.enableRelay ? 'on' : 'off'));
	console.log('ORIGIN_STRAND_ID=' + args.strandId);
	for (const addr of handle.controlAddrs) {
		console.log('ORIGIN_CONTROL_ADDR=' + addr);
	}
	// The strand node's own addresses: upstream's open-strand read route (sereus#23) dials a
	// node RUNNING the strand, not the control node.
	for (const addr of handle.strandAddrs?.[args.strandId] ?? []) {
		if (addr.includes('/tls/ws')) console.log('ORIGIN_STRAND_ADDR=' + addr);
	}
	console.log('ORIGIN_TLS_SPKI=' + handle.tls.spkiSha256Base64);
	console.log('ORIGIN_TLS_CAROOT=' + (handle.tls.caRoot ?? ''));

	// ── Emission 2: one line per inbound connection to the CONTROL node --
	// the node whose multiaddr ORIGIN_CONTROL_ADDR advertises. Peer NAMES
	// only; no addresses, no durations, no payload beyond arrival order.
	// Attached here, before any strand work, so a connection arriving at any
	// point in the run is reported. Wrapped so a substrate that does not
	// expose these events can never fail a run that is otherwise healthy --
	// this is additive instrumentation, not a precondition.
	try {
		const controlNode = handle.node.getControlNode();
		controlNode.addEventListener('connection:open', (evt) => {
			const peer = evt?.detail?.remotePeer;
			if (peer) console.log('ORIGIN_PEER_CONNECTED=' + peer.toString());
		});
		controlNode.addEventListener('connection:close', (evt) => {
			const peer = evt?.detail?.remotePeer;
			if (peer) console.log('ORIGIN_PEER_DISCONNECTED=' + peer.toString());
		});
	} catch (err) {
		console.log('ORIGIN_PEER_STREAM=unavailable:' + (err && /** @type {any} */ (err).name ? /** @type {any} */ (err).name : 'Error'));
	}

	// -- Reach the hosted strand's Quereus Database. -------------------------
	const strand = handle.node.getStrand(args.strandId);
	if (!strand || !strand.database) {
		fatal('strand', `getStrand("${args.strandId}") returned no hosted strand database`);
	}
	const db = strand.database.getDatabase();
	// D-14 transparency (rn-db-factory.ts:146-148), the same call
	// strand-read.js's reader makes: bare engine SQL table names resolve to
	// App.<Table> first, with main as the fallback. Every INSERT below
	// breaks without this call.
	db.setSchemaPath(['App', 'main']);
	// registerDbPlugins is "per-Database-instance state (not persisted) --
	// must run on EVERY database" (vote-engine/initialize.ts's own doc
	// comment). The strand's Database is a SEPARATE instance from the local
	// UI store attachNetworkDb/createNetworkDb already register it on, and
	// this origin is the first writer this phase ever drives against a
	// strand-connected Database -- without this call, the signing ceremony's
	// SignatureValid/SignatureValidP256 UDFs are unresolved at query-build
	// time (the planner must resolve every function name referenced in a
	// CHECK expression even on a short-circuited OR branch), and Quereus
	// throws "Function not found" before any row is ever touched.
	const { registerDbPlugins } = await import('@votetorrent/vote-engine/browser');
	await registerDbPlugins(db);

	// -- Dynamic-import both fixtures INSIDE this file only -- they must
	// never enter the gateway's import graph. --------------------------------
	const { seedFoundingAuthority } = await import('../../../../packages/web-data/test/fixtures/seed-founding-authority.js');
	const { seedElectionSurface, SEED_ELECTION, SEED_PHASE_INSTANTS } = await import(
		'../../../../packages/web-data/test/fixtures/seed-election-surface.js'
	);
	// Not exported by seed-election-surface.js -- its own founding
	// ElectionRevision is created with `revision: 0` internally
	// (`seedElectionSurface`'s `R.revision`), the same local constant
	// `live-read-gate.js:123` declares for the identical reason.
	const SEED_REVISION = 0;

	// 62-02 (D-26): seed-bound-keyholder.js, dynamic-imported for the same
	// "never enter the gateway's import graph" reason as the two fixtures
	// above.
	const { seedKeyholderPrerequisites, insertBoundKeyholder } = await import('../fixtures/seed-bound-keyholder.js');

	/** @returns {Promise<number>} */
	async function countKeyholders() {
		const row = await db.prepare('select count(*) as c from Keyholder').get({});
		return Number(/** @type {any} */ (row)?.c ?? 0);
	}

	/** @type {{ userId: string, inviteSlotCid: string, signerPublicKey: string } | null} */
	let u1Prereq = null;
	try {
		await seedFoundingAuthority(db);
		await seedElectionSurface(db);
		// 62-02 (D-26): prerequisites for the `mutate` command's signed
		// keyholder write -- 'u1' (the founding officer) gets an
		// InviteSlot/InviteResult/UserKey here so `mutate` later produces
		// exactly one new Keyholder row (plus its now-mandatory binding).
		u1Prereq = await seedKeyholderPrerequisites(db, {
			electionId: SEED_ELECTION.id,
			userId: 'u1',
			userName: 'mesh-read origin Officer',
			now: new Date().toISOString().slice(0, 19),
		});
	} catch (err) {
		fatal('origin-seed', `${err && /** @type {any} */ (err).name}`);
	}

	const keyholdersBefore = await countKeyholders();

	console.log('ORIGIN_ELECTION_ID=' + SEED_ELECTION.id);
	console.log('ORIGIN_ELECTION_TITLE=' + SEED_ELECTION.title);
	// The `settling` phase, not `pre` -- the phase whose fact set actually
	// carries the key-release card. `pre` renders no card, which would make
	// the gate go red naming a missing sentence rather than proving liveness.
	console.log('ORIGIN_AT_INSTANT=' + SEED_PHASE_INSTANTS.settling);
	console.log('ORIGIN_KEYHOLDERS_BEFORE=' + keyholdersBefore);
	console.log('ORIGIN_SEEDED=ok');
	console.log('ORIGIN_READY');

	let stopped = false;
	/** @returns {Promise<void>} */
	async function shutdown() {
		if (stopped) return;
		stopped = true;
		// drone.mjs:427-436's shape: no extra cleanup beyond stopping the node.
		try {
			await handle.stop();
		} catch {
			// Swallowed -- an aborted gate must not hang on its own teardown.
		}
	}

	for (const sig of ['SIGINT', 'SIGTERM']) {
		process.on(sig, async () => {
			await shutdown();
			process.exit(0);
		});
	}

	// -- Closed-vocabulary command loop over stdin. Exactly two commands; any
	// other line is refused with no state change. --------------------------
	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
	rl.on('line', async (rawLine) => {
		const line = rawLine.trim();
		if (line === 'mutate') {
			try {
				// 62-02 (D-26): Keyholder.InsertValid now requires a signed
				// KeyholderDkgBinding in the SAME transaction -- this call still
				// produces exactly one new Keyholder row (the observed mutation
				// below), plus its now-mandatory binding.
				if (u1Prereq === null) throw new Error('u1Prereq was not seeded');
				await insertBoundKeyholder(db, u1Prereq, { electionId: SEED_ELECTION.id, revision: SEED_REVISION, tid: 900 });
				const keyholdersAfter = await countKeyholders();
				console.log('ORIGIN_KEYHOLDERS_AFTER=' + keyholdersAfter);
				console.log('ORIGIN_MUTATED=ok');
			} catch (err) {
				const name = err && typeof (/** @type {any} */ (err).name) === 'string' ? /** @type {any} */ (err).name : 'Error';
				console.log('ORIGIN_MUTATED=fail:' + name);
			}
		} else if (line === 'stop') {
			await shutdown();
			process.exit(0);
		} else if (line.length > 0) {
			console.log('ORIGIN_REFUSED=unknown-command');
		}
	});
}

main().catch((err) => {
	console.error('ORIGIN_FATAL:unhandled: ' + (err && /** @type {any} */ (err).stack ? /** @type {any} */ (err).stack : err));
	process.exit(1);
});
