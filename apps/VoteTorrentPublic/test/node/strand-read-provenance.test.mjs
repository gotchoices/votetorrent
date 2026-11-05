/**
 * strand-read-provenance.test.mjs — `56-16` Task 3: the anti-false-green
 * controls that make a green read from `strand-read.js` mean something.
 *
 * WHAT THIS FILE PROVES, at Node tier: that a green read from
 * `createStrandRowSource` cannot have come from a locally seeded store
 * (GROUP B), that the UI handle's `'store'` routing survives a strand
 * connection running alongside it (GROUP A), that the resolved transactor
 * really is `'network'` and really could have been otherwise (GROUP C), and
 * that the two prohibition sets `strand-read.js`'s header names are pinned by
 * a comment-stripped, non-self-tripping scan (GROUP D).
 *
 * WHAT THIS FILE DOES NOT PROVE: the browser, liveness (`56-11`'s gate), or
 * the D-16 inversion (`56-13`). It also does not duplicate
 * `strand-entry-reachability.test.mjs`'s resolution-facts instrument (Task 1
 * owns GROUP A of that file) or its cold-connect settlement (Task 1's own
 * GROUP B) — this file's GROUP B reuses the SAME real, bounded probe
 * technique for a DIFFERENT purpose: proving emptiness survives a seeded
 * block store, not settling whether the connection completes at all.
 *
 * REAL-NODE COST, same measured drain as `strand-entry-reachability.test.mjs`
 * (see that file's header): constructing a real Edge node against an
 * unreachable bootstrap leaves a dangling dial attempt that neither
 * `node.stop()` nor `StrandDatabase.close()` aborts, adding roughly
 * 15-25s to this process's exit even after every awaited call here has
 * settled. GROUP B's declared test timeout is sized for two such probes run
 * in sequence.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Database } from '@quereus/quereus';
import { connectToStrand } from '@serfab/quereus-plugin-sereus';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { PUBLIC_SUBSCRIBED_TABLES, openStoreHandle } from '@votetorrent/web-data/public';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';
import { publicSrc } from '../../../../scripts/lib/source-paths.mjs';
import { createEdgeNode, openStrandBlockStorage } from '../../src/peer/edge-node.js';
import { openStrandReadHandle, createStrandRowSource, StrandReadError } from '../../src/peer/strand-read.js';

/**
 * A fake `uiDb` declaring a generic single-column schema for every member of
 * `PUBLIC_SUBSCRIBED_TABLES` -- `readRows` resolves a UI schema for every
 * allowlisted table on every call regardless of whether the strand side has
 * rows for it, so any fixture that drives `readRows` needs all eight.
 * @returns {any}
 */
function makeUiDbForAllTables() {
	return {
		schemaManager: {
			getCurrentSchemaName: () => 'main',
			getTable: (/** @type {string} */ _schemaName, /** @type {string} */ tableName) =>
				PUBLIC_SUBSCRIBED_TABLES.includes(tableName) ? { name: tableName, columns: [{ name: 'Id' }] } : undefined,
		},
	};
}

// ---------------------------------------------------------------------------
// GROUP A -- routing non-interference: the UI handle's 'store' routing
// survives openStrandReadHandle, with a negative half proving the flip to
// 'optimystic' is a real, observable thing and not an assumption.
// ---------------------------------------------------------------------------

test('GROUP A -- the UI handle stays routed to "store" across openStrandReadHandle, and a throwaway handle really does flip to "optimystic"', async () => {
	const networkHash = `strand-read-provenance-routing-${randomUUID()}`;
	const uiDb = await openStoreHandle(networkHash);
	try {
		// Positive control FIRST -- an assertion that only ever ran after the
		// interesting step could pass on a handle that was never routed at all.
		assert.equal(uiDb.getDefaultVtabModule().name, 'store', 'positive control: the UI handle must already be routed to "store" before the strand step runs');
		const argsBefore = uiDb.getDefaultVtabModule().args;

		// A fake StrandDatabase -- this control is about the UI handle's OWN
		// routing surviving a strand connection running alongside it, not about
		// proving a real strand connects (Task 1's GROUP B and this file's own
		// GROUP B own that).
		class FakeStrandDatabaseForRoutingControl {
			/** @param {any} config */
			constructor(config) {
				this.config = config;
			}
			async initialize() {}
			getDatabase() {
				return { getDefaultVtabModule: () => ({ name: 'optimystic', args: {} }), setSchemaPath: () => undefined };
			}
			getTransactor() {
				return 'network';
			}
			async close() {}
		}
		await openStrandReadHandle(
			{ networkHash, node: /** @type {any} */ ({}), coordinatedRepo: /** @type {any} */ ({}) },
			/** @type {any} */ ({ StrandDatabase: FakeStrandDatabaseForRoutingControl }),
		);

		assert.equal(uiDb.getDefaultVtabModule().name, 'store', 'the UI handle must STILL be routed to "store" after openStrandReadHandle has run');
		assert.deepEqual(uiDb.getDefaultVtabModule().args, argsBefore, 'the UI handle\'s default vtab args must be unchanged too');

		// THE NEGATIVE HALF -- a control that cannot fail proves nothing. A
		// THROWAWAY third `Database`, handed DIRECTLY to the real strand
		// composition (never to production code -- this exists only inside this
		// test), really does flip to 'optimystic'. `transactor: 'test'` skips
		// node acquisition entirely (measured this session: completes offline in
		// well under a second), so this half needs no network and no Edge node.
		const throwaway = new Database();
		assert.notEqual(throwaway.getDefaultVtabModule().name, 'optimystic', 'sanity: a fresh Database is never already routed to optimystic');
		const strandResult = await connectToStrand(throwaway, {
			strandId: `routing-negative-half-${randomUUID()}`,
			transactor: 'test',
			enableCache: false,
		});
		try {
			assert.equal(throwaway.getDefaultVtabModule().name, 'optimystic', 'the real strand composition really does flip the default vtab name -- the trap this control demonstrates is real');
		} finally {
			await strandResult.shutdown();
		}
	} finally {
		await uiDb.close();
	}
});

// ---------------------------------------------------------------------------
// GROUP B -- the no-peer emptiness control, with the half that makes it
// discriminate: seeding the per-strand BLOCK store does not change the
// outcome.
// ---------------------------------------------------------------------------

/**
 * Drives one full `createStrandRowSource(...).readRows(...)` attempt over a
 * real, unreachable-bootstrap Edge node for `strandId`, and classifies the
 * outcome. Never lets a non-empty batch array escape unexamined -- the
 * assertion lives at the call site, this helper only classifies.
 * @param {string} strandId
 * @param {ReadonlyArray<string>} bootstrapNodes
 * @returns {Promise<{ kind: 'batches', batches: any[] } | { kind: 'error', name: string } | { kind: 'timedOut' }>}
 */
async function attemptNoPeerRead(strandId, bootstrapNodes) {
	const readerKey = await generateKeyPair('Ed25519');
	const edge = await createEdgeNode({
		strandId,
		networkName: `strand-${strandId}`,
		bootstrapNodes,
		privateKey: readerKey,
	});
	try {
		/** @type {any} */
		const TIMEOUT_SENTINEL = Symbol('strand-read-provenance:no-peer-read-timeout');
		const timeout = new Promise((resolve) => setTimeout(() => resolve(TIMEOUT_SENTINEL), 25_000));

		const attempt = (async () => {
			// Opening the handle is part of the attempt: since @optimystic 1.11.0 a node that has
			// not heard from its bootstrap peers refuses to conclude the catalog is absent, so the
			// open itself throws `BlockUnavailableError` (cohort-unreachable) rather than hydrating
			// an empty catalog. That is the 'error' outcome class, not a test failure.
			let handle;
			try {
				handle = await openStrandReadHandle({ networkHash: strandId, node: edge.node, coordinatedRepo: edge.node.coordinatedRepo });
			} catch (err) {
				const name = err && typeof (/** @type {any} */ (err).name) === 'string' ? /** @type {any} */ (err).name : 'Error';
				return { kind: /** @type {const} */ ('error'), name };
			}
			try {
				const { readRows, close } = createStrandRowSource({ uiDb: makeUiDbForAllTables(), strandDb: handle });
				const batches = await readRows({ collectionId: 'x', revision: 1, invalidation: false });
				await close();
				return { kind: /** @type {const} */ ('batches'), batches: Array.isArray(batches) ? batches : [] };
			} catch (err) {
				await handle.close().catch(() => undefined);
				const name = err && typeof (/** @type {any} */ (err).name) === 'string' ? /** @type {any} */ (err).name : 'Error';
				return { kind: /** @type {const} */ ('error'), name };
			}
		})();

		const result = await Promise.race([attempt, timeout]);
		if (result === TIMEOUT_SENTINEL) return { kind: 'timedOut' };
		return /** @type {any} */ (result);
	} finally {
		await edge.stop();
	}
}

test(
	'GROUP B -- a row source over an unreachable bootstrap and an empty block store returns no rows, and seeding the block store does not change that',
	{ timeout: 90_000 },
	async () => {
		const strandId = `strand-read-provenance-nopeer-${randomUUID()}`;
		const bogusKey = await generateKeyPair('Ed25519');
		const bogusPeerId = peerIdFromPrivateKey(bogusKey);
		const bootstrapNodes = [`/ip4/203.0.113.9/tcp/4001/ws/p2p/${bogusPeerId.toString()}`];

		const first = await attemptNoPeerRead(strandId, bootstrapNodes);
		if (first.kind === 'batches') {
			assert.deepEqual(first.batches, [], 'a no-peer, empty-block-store read must never return a non-empty batch array');
		} else {
			assert.ok(['error', 'timedOut'].includes(first.kind));
		}

		// The half that makes this discriminate: seed the per-strand BLOCK
		// store with bytes unrelated to any real committed content (this
		// process never wrote a genuine committed row anywhere), then re-run
		// and assert the SAME outcome class. A row source that returned rows
		// here would be reading local cache, and every downstream green in
		// this plan would be worthless.
		const seeded = await openStrandBlockStorage(strandId);
		await seeded.storage.saveMetadata('strand-read-provenance-planted-block', { ranges: [[0, 1]] });
		await seeded.db.close?.();

		const second = await attemptNoPeerRead(strandId, bootstrapNodes);
		if (second.kind === 'batches') {
			assert.deepEqual(second.batches, [], 'seeding the block store must not fabricate rows -- still never a non-empty batch array');
		} else {
			assert.ok(['error', 'timedOut'].includes(second.kind));
		}

		assert.equal(second.kind, first.kind, 'seeding the block store must not change the OUTCOME CLASS -- a local-cache leak would show up as a class change (error/timeout -> batches)');
	},
);

// ---------------------------------------------------------------------------
// GROUP C -- the resolved-transactor control, with the forced-'local'
// inversion. Without the inversion this assertion is a tautology over a
// value nothing could have changed.
// ---------------------------------------------------------------------------

test('GROUP C -- openStrandReadHandle asserts the RESOLVED transactor, read from StrandDatabase.getTransactor(), never assumed -- and the inversion proves it', async () => {
	/** @param {string} transactor @returns {any} */
	const fakeCtorReporting = (transactor) =>
		class FakeStrandDatabaseForTransactorControl {
			/** @param {any} config */
			constructor(config) {
				this.config = config;
			}
			async initialize() {}
			getDatabase() {
				return { getDefaultVtabModule: () => ({ name: 'optimystic', args: {} }), setSchemaPath: () => undefined };
			}
			getTransactor() {
				return transactor;
			}
			async close() {}
		};

	// The positive case: a resolved 'network' is accepted and reported back.
	const handle = await openStrandReadHandle(
		{ networkHash: `strand-read-provenance-transactor-${randomUUID()}`, node: /** @type {any} */ ({}), coordinatedRepo: /** @type {any} */ ({}) },
		/** @type {any} */ ({ StrandDatabase: fakeCtorReporting('network') }),
	);
	assert.equal(handle.transactor, 'network');

	// THE INVERSION -- construct the SAME composition with 'local' forced
	// through the test's own fake, and assert the rejection names the
	// resolved value. Without this half, the assertion above is a tautology:
	// nothing in this test could ever have produced a different verdict.
	await assert.rejects(
		openStrandReadHandle(
			{ networkHash: `strand-read-provenance-transactor-local-${randomUUID()}`, node: /** @type {any} */ ({}), coordinatedRepo: /** @type {any} */ ({}) },
			/** @type {any} */ ({ StrandDatabase: fakeCtorReporting('local') }),
		),
		(/** @type {any} */ err) => err instanceof StrandReadError && err.subject === 'local',
	);
});

// ---------------------------------------------------------------------------
// GROUP D -- the comment-stripped source scan, with its own strip self-check
// so the scan cannot report a false clean by having eaten the whole file.
// ---------------------------------------------------------------------------

/**
 * Assembled from concatenated fragments at RUNTIME, so this instrument's own
 * source does not contain the literal tokens it searches for -- the
 * self-tripping-checker class of failure this repo has hit repeatedly
 * (`project_self_tripping_checker_headers`).
 * @type {ReadonlyArray<string>}
 */
const STORE_SIDE_TOKENS = Object.freeze([
	['open', 'Store', 'Handle'].join(''),
	['db', 'Name', 'For'].join(''),
	['attach', 'Network', 'Db'].join(''),
	['STORE', '_MODULE', '_NAME'].join(''),
	['plugin', '-indexeddb'].join(''),
]);

/** @type {ReadonlyArray<string>} */
const WRITE_SIDE_TOKENS = Object.freeze([
	['getTableFor', 'ExternalWrite'].join(''),
	['applyExternal', 'RowChanges'].join(''),
	['ingestExternal', 'RowChanges'].join(''),
]);

/** @type {ReadonlyArray<string>} */
const TRANSACTOR_TOKENS = Object.freeze([["'", 'local', "'"].join(''), ["'", 'test', "'"].join('')]);

test('GROUP D -- strip self-check: a token inside a synthetic comment is removed, and a known executable identifier survives stripping strand-read.js', () => {
	const syntheticToken = STORE_SIDE_TOKENS[0];
	const syntheticSource = `// this comment mentions ${syntheticToken} by name\nconst x = 1;`;
	const stripped = stripComments(syntheticSource);
	assert.ok(!stripped.includes(syntheticToken), 'the strip helper must remove a token that appears only inside a comment');

	const sourcePath = publicSrc('peer', 'strand-read.js');
	const source = readFileSync(sourcePath, 'utf8');
	const strippedSource = stripComments(source);
	// A known EXECUTABLE identifier from Task 2's own export list -- if the
	// strip helper ate the whole file (or malfunctioned on real source), this
	// would report zero tokens found for every scan below and look exactly
	// like a clean pass. This half is what rules that out.
	assert.ok(strippedSource.includes('createStrandRowSource'), 'stripping strand-read.js must leave recognizable executable content behind');
});

test('GROUP D -- the store-side and write-side prohibition sets, plus the transactor literals, are absent from strand-read.js\'s EXECUTABLE code (comments stripped first)', () => {
	const sourcePath = publicSrc('peer', 'strand-read.js');
	const source = readFileSync(sourcePath, 'utf8');
	const stripped = stripComments(source);

	const allTokens = [...STORE_SIDE_TOKENS, ...WRITE_SIDE_TOKENS, ...TRANSACTOR_TOKENS];
	const found = allTokens.filter((token) => stripped.includes(token));

	// A frozen empty expectation, with the found tokens listed on failure --
	// never a bare `=== 0` on an unfiltered count.
	assert.deepEqual(found, [], `strand-read.js's executable code must reference none of the prohibited tokens; found: ${JSON.stringify(found)}`);
});
