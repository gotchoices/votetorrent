/**
 * strand-entry-reachability.test.mjs — `56-16` Task 1: settles the two
 * preconditions the rest of this plan's design rests on, and pins the
 * resolution facts as a standing instrument so a future `@serfab/*` bump is
 * noticed rather than silently absorbed.
 *
 * PRECONDITION 1 (`56-02`'s bundling verdict) is read from
 * `.planning/phases/56-public-election-view-as-a-live-libp2p-edge-subscriber/56-02-BUNDLE-MEASUREMENT.md`,
 * never re-derived: POSITIVE for both `@serfab/quereus-plugin-sereus` and
 * `@serfab/cadre-core` (root-specifier-only, one on-disk root each, non-zero
 * sourcemap match). `apps/VoteTorrentPublic/package.json`'s `dependencies`
 * already declares both — no contingency edit was needed (see this plan's
 * SUMMARY for the confirming `git diff`, which is empty).
 *
 * PRECONDITION 2 (the SQL-layer wall) is measured directly by GROUP B below:
 * whether an anonymous, non-member reader can complete `StrandDatabase`'s
 * `initialize()` against a strand that exists nowhere, with no reachable
 * bootstrap peer. GROUP B is the first-class deliverable this comment
 * promises — its recorded outcome class is restated in this plan's SUMMARY
 * with file:line evidence.
 *
 * ANCHOR HAZARD (`project_self_tripping_checker_headers`'s class of failure,
 * applied to resolution rather than string-matching): `import.meta.resolve`
 * has NO second "parent" argument in this Node runtime -- measured this
 * session (`import.meta.resolve.length === 1`; a second URL argument is
 * silently ignored and resolution stays anchored to the CALLING module's own
 * location). This file's own location -- inside
 * `apps/VoteTorrentPublic/test/node/` -- IS the anchor for every
 * `import.meta.resolve` call below, and GROUP A's first test asserts that
 * location is genuinely inside `apps/VoteTorrentPublic` (derived through
 * `scripts/lib/source-paths.mjs`) and not a scratch/temp directory that would
 * report `ERR_MODULE_NOT_FOUND` for everything and look exactly like a
 * genuine negative. `module.createRequire`-based resolution was measured and
 * rejected for this file: `createRequire(...).resolve(...)` uses the CJS
 * `require` export condition, which none of these packages define (only
 * `import`/`browser`), so it reports `ERR_PACKAGE_PATH_NOT_EXPORTED` even for
 * `@serfab/cadre-core`'s ROOT specifier -- something that resolves and works
 * perfectly well via `import`. A `require`-based instrument would be
 * permanently red for the wrong reason.
 *
 * FALSIFICATION, PERFORMED MANUALLY DURING THIS PLAN'S EXECUTION (not baked
 * into this file, since `import.meta.resolve` accepts no anchor parameter to
 * flip programmatically): the resolution logic below was copied into a
 * throwaway script run from OUTSIDE any workspace (the executor's scratch
 * directory), where `@serfab/cadre-core` cannot resolve at all. It reported
 * `ERR_MODULE_NOT_FOUND` for every specifier, including the ones this file
 * asserts DO resolve -- proving the positive assertions below are measuring
 * a real resolution chain, not a chain that always reports "found" from
 * wherever it runs. Recorded in this plan's SUMMARY, not repeated as an
 * automated in-suite mutation (that would require moving this file outside
 * the repo at test time, which is worse than the manual check it replaces).
 *
 * GROUP B's REAL-NODE COST, recorded honestly: constructing a real Edge node
 * (`56-05`'s `createEdgeNode`) with an unreachable bootstrap address and
 * driving a real `StrandDatabase.initialize()` measured (this session) at
 * roughly 0.1-1.6s to settle, but the Node PROCESS takes an additional
 * ~15-25s to exit afterward even once every awaited call here has returned
 * and `stop()`/`close()` have both resolved -- a dangling dial attempt to the
 * unreachable bootstrap address that neither `node.stop()` nor
 * `StrandDatabase.close()` aborts, and which is not this module's to fix.
 * This test's own declared timeout is set well above that drain so the
 * suite reports GROUP B's real, settled outcome rather than a runner-forced
 * timeout that would look identical to a genuine hang.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import 'fake-indexeddb/auto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { StrandDatabase } from '@serfab/cadre-core';
import { VOTETORRENT_SCHEMA_SQL } from '@votetorrent/vote-engine/browser';
import { publicRoot, moduleUrl } from '../../../../scripts/lib/source-paths.mjs';
import { createEdgeNode } from '../../src/peer/edge-node.js';

// ---------------------------------------------------------------------------
// GROUP A -- the resolution facts that force the StrandDatabase choice
// ---------------------------------------------------------------------------

test('GROUP A.0 (anchor sanity) -- this file resolves from inside apps/VoteTorrentPublic, not a scratch directory', () => {
	const anchorRoot = moduleUrl(publicRoot());
	assert.ok(
		import.meta.url.startsWith(anchorRoot),
		`this test file's own import.meta.url (${import.meta.url}) is not inside apps/VoteTorrentPublic (${anchorRoot}) -- every import.meta.resolve() call below is anchored HERE, and an instrument anchored outside the app reports the same "not found" verdict for every specifier, positive or negative alike`,
	);
});

test('GROUP A.1 -- @serfab/cadre-core resolves, and its resolved module exports StrandDatabase', async () => {
	// If this ever stops resolving, the whole design this plan implements is
	// unreachable and this plan's Task 2 module cannot be built as written.
	const resolved = import.meta.resolve('@serfab/cadre-core');
	assert.match(resolved, /@serfab\/cadre-core\/dist\/index\.js$/);
	const mod = await import('@serfab/cadre-core');
	assert.equal(typeof mod.StrandDatabase, 'function');
	assert.equal(mod.StrandDatabase, StrandDatabase, 'this file\'s own StrandDatabase import must resolve to the SAME export the reachability probe just measured');
});

test('GROUP A.2 -- @serfab/quereus-plugin-sereus/plugin-browser resolves', () => {
	// If this ever stops resolving, the "one browser entry IS exported"
	// half of <critical_framing> (b) is false and the whole basis for
	// preferring StrandDatabase over connectToStrandBrowser needs re-reading.
	const resolved = import.meta.resolve('@serfab/quereus-plugin-sereus/plugin-browser');
	assert.match(resolved, /quereus-plugin-sereus\/dist\/plugin-browser\.js$/);
});

test('GROUP A.3 -- @serfab/quereus-plugin-sereus/dist/connect-browser.js does NOT resolve (ERR_PACKAGE_PATH_NOT_EXPORTED specifically)', () => {
	// If this ever starts resolving, connectToStrandBrowser becomes reachable
	// through an exported path and the second-node/second-store cost in
	// <critical_framing> (c) -- and this module's whole design -- can be
	// revisited. A bare "it throws" would also pass on a typo'd specifier and
	// would prove nothing about the exports map specifically.
	assert.throws(
		() => import.meta.resolve('@serfab/quereus-plugin-sereus/dist/connect-browser.js'),
		(/** @type {any} */ err) => err && err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
	);
});

test('GROUP A.4 -- @serfab/quereus-plugin-sereus/dist/compose-strand.js does NOT resolve (ERR_PACKAGE_PATH_NOT_EXPORTED specifically)', () => {
	// Same reasoning as A.3, for the shared composition entry point itself --
	// neither browser-adjacent Node entry is directly reachable from an app
	// outside this package.
	assert.throws(
		() => import.meta.resolve('@serfab/quereus-plugin-sereus/dist/compose-strand.js'),
		(/** @type {any} */ err) => err && err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
	);
});

test('GROUP A.5 -- @serfab/quereus-plugin-sereus\'s exports map has EXACTLY the keys [".", "./plugin", "./plugin-browser"] (set equality, not a length check)', () => {
	// A length check would pass even if one of the three keys were renamed to
	// something this module does not expect. Set equality is the only
	// assertion that actually pins what A.2/A.3/A.4 depend on.
	const rootUrl = import.meta.resolve('@serfab/quereus-plugin-sereus');
	const pkgJsonPath = fileURLToPath(new URL('../package.json', rootUrl));
	const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
	assert.deepEqual(Object.keys(pkg.exports).sort(), ['.', './plugin', './plugin-browser']);
});

// ---------------------------------------------------------------------------
// GROUP B -- the SQL-layer wall: can an anonymous, non-member reader
// complete StrandDatabase.initialize() against a strand that exists nowhere,
// with no reachable bootstrap peer?
// ---------------------------------------------------------------------------

/** Outer test-runner budget. Generous over GROUP B's measured ~15-25s
 * post-settle drain (see this file's header) so a real settle is reported
 * as itself, not as a runner-forced timeout. @type {number} */
const COLD_CONNECT_TEST_TIMEOUT_MS = 60_000;

/** The internal race deadline THIS test enforces on `initialize()` itself --
 * distinct from the outer test-runner budget above, and the boundary that
 * turns "never resolves" into a recorded, named outcome class instead of a
 * runner-forced kill that looks identical to a genuine hang. @type {number} */
const INITIALIZE_RACE_TIMEOUT_MS = 30_000;

// Byte-for-byte the same outer-wrapper strip as `rn-db-factory.ts:29-32` and
// `strand-read.js`'s `VOTETORRENT_INNER_DDL` -- duplicated here, not
// imported, because this file settles a precondition Task 2's module is not
// guaranteed to exist yet when this task halts the plan.
const INNER_DDL = VOTETORRENT_SCHEMA_SQL.replace(/^\s*declare\s+schema\s+\w+\s*\{/, '')
	.replace(/\}\s*apply\s+schema\s+\w+\s*;\s*$/, '')
	.trim();

test(
	'GROUP B -- cold, anonymous, non-member StrandDatabase.initialize() against an unreachable bootstrap: records the real outcome class',
	{ timeout: COLD_CONNECT_TEST_TIMEOUT_MS },
	async () => {
		const strandId = 'strand-entry-reachability-cold-connect-nonexistent-0001';

		// A syntactically-valid, reserved-and-unroutable (TEST-NET-3, RFC 5737)
		// bootstrap multiaddr with a real (but never-published) peer id, so
		// libp2p's own multiaddr/peer-id parsing succeeds and the ONLY thing
		// that can fail is reachability -- exactly the condition this group
		// needs. Fresh key per run; never reused, never a fixture peer id.
		const bogusKey = await generateKeyPair('Ed25519');
		const bogusPeerId = peerIdFromPrivateKey(bogusKey);
		const bootstrapNodes = [`/ip4/203.0.113.7/tcp/4001/ws/p2p/${bogusPeerId.toString()}`];

		const readerKey = await generateKeyPair('Ed25519');
		const edge = await createEdgeNode({
			strandId,
			networkName: `strand-${strandId}`,
			bootstrapNodes,
			privateKey: readerKey,
		});

		/** @type {'resolved' | 'rejected' | 'timedOut'} */
		let outcomeClass;
		/** @type {any} */
		let capturedError;
		let resolvedTransactor;
		let rowCount;

		const strandDb = new StrandDatabase({
			strandId,
			sAppConfig: { id: 'org.votetorrent', version: '1.0.0', schema: INNER_DDL, latencyHint: 'interactive' },
			libp2pNode: edge.node,
			coordinatedRepo: edge.node.coordinatedRepo,
			strandType: 'o',
			founder: false,
		});

		try {
			/** @type {any} */
			const TIMEOUT_SENTINEL = Symbol('strand-entry-reachability:cold-connect-timeout');
			const timeout = new Promise((resolve) => setTimeout(() => resolve(TIMEOUT_SENTINEL), INITIALIZE_RACE_TIMEOUT_MS));

			try {
				const result = await Promise.race([strandDb.initialize().then(() => 'initialized'), timeout]);
				if (result === TIMEOUT_SENTINEL) {
					outcomeClass = 'timedOut';
				} else {
					outcomeClass = 'resolved';
					resolvedTransactor = strandDb.getTransactor();
					const db = strandDb.getDatabase();
					db.setSchemaPath(['App', 'main']);
					const rows = [];
					// 'Election' -- a real member of PUBLIC_SUBSCRIBED_TABLES,
					// never a fixture table -- see this group's own name.
					for await (const row of db.eval('select * from Election')) rows.push(row);
					rowCount = rows.length;
					await strandDb.close();
				}
			} catch (err) {
				outcomeClass = 'rejected';
				capturedError = err;
			}
		} finally {
			await edge.stop();
		}

		// The record this test exists to produce -- restated with file:line
		// evidence in this plan's SUMMARY, not left only in test output.
		if (outcomeClass === 'resolved') {
			assert.equal(resolvedTransactor, 'network', 'a resolved cold connect must resolve the "network" transactor, never "local" or "test"');
			assert.equal(rowCount, 0, 'a cold, freshly-applied strand must have zero Election rows -- any other count would mean this test reused state from a prior run');
		} else if (outcomeClass === 'rejected') {
			assert.ok(capturedError, 'a rejected outcome must carry the rejection error');
			// Record class, never message text (T-56-16-09) -- constructor.name
			// and the stack's top frame are enough to attribute the wall to a
			// specific file:line without embedding any offending value.
			assert.equal(typeof capturedError.name, 'string');
		} else {
			assert.equal(outcomeClass, 'timedOut');
		}

		// This assertion is the group's own falsifiability control: it fails
		// unless the outcome is exactly one of the three declared classes,
		// so a future change to this test that silently drops a branch (and
		// leaves `outcomeClass` `undefined`) is caught here rather than
		// passing vacuously.
		assert.ok(['resolved', 'rejected', 'timedOut'].includes(outcomeClass));
	},
);
