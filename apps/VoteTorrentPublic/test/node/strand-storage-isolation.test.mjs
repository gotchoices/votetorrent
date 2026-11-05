/**
 * strand-storage-isolation.test.mjs — the D-18 cross-strand
 * non-contamination proof for `openStrandBlockStorage`, with a positive
 * control that makes it falsifiable.
 *
 * WHAT THIS PROVES. That two strands' block stores, opened through
 * `openStrandBlockStorage`, do not cross-contaminate (D-18).
 *
 * WHAT FAILURE LOOKS LIKE. If both strands resolved to one database — the
 * rejected "single shared store" alternative, or a `strandStorageDbName`
 * that silently fell back to the package default `optimystic` — then
 * strand B's `getMetadata` for strand A's blockId returns A's metadata
 * instead of `undefined`, and rung 2 goes red. This is the browser
 * instance of `project_strand_storage_per_network_isolation`, where a
 * shared handle contaminated `count(*)` across networks on the RN side.
 *
 * WHY `getStoreIdentity()` IS NOT THE ASSERTION. Read from
 * `@optimystic/db-p2p/dist/src/storage/store-identity.js`: `identityForHandle`
 * tags per OBJECT IDENTITY via a `WeakMap` and hands out `idb-handle:<ordinal>`
 * — a strictly increasing global counter — so two handles opened over the
 * SAME database name also report two different identities. Asserting that
 * strand A's and strand B's storages report distinct identities would be a
 * gate that CANNOT FAIL, even on the exact bug this file exists to catch.
 * Behaviour is asserted instead, never identity strings.
 *
 * WHAT THIS TEST DOES NOT PROVE. It runs on `fake-indexeddb`, a Node
 * approximation of the browser's IndexedDB. It says nothing about a real
 * browser, and nothing about liveness — the real-browser mesh read is
 * `56-11`'s gate. It also performs no `deleteDatabase`, so it is out of
 * scope of the `project_indexeddb_delete_resurrection` class entirely.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openStrandBlockStorage, strandStorageDbName, EdgeNodeConfigError } from '../../src/peer/edge-node.js';

/**
 * A production-shaped, per-run-unique strandId: 32 lowercase hex characters
 * (H16-hex-shaped), never a two-character stub —
 * `project_ui_defects_invisible_to_every_tier` measured that a too-short
 * fixture cannot fail. Freshly generated per call so `fake-indexeddb`'s
 * in-process persistence cannot let one rung's writes leak into another's.
 * @returns {string}
 */
function makeStrandId() {
	return randomBytes(16).toString('hex');
}

/** A minimal valid `BlockMetadata`: one closed revision range. `latest` is
 * optional and this test does not need it.
 * @type {{ ranges: Array<[number, (number | undefined)?]> }} */
const FIXTURE_METADATA = { ranges: [[0, 5]] };
const FIXTURE_BLOCK_ID = 'block-fixture-0001';

test('rung 1 -- distinct names for two production-shaped strandIds, neither the package default', () => {
	const strandA = makeStrandId();
	const strandB = makeStrandId();
	const nameA = strandStorageDbName(strandA);
	const nameB = strandStorageDbName(strandB);
	assert.notStrictEqual(nameA, nameB);
	assert.notStrictEqual(nameA, 'optimystic');
	assert.notStrictEqual(nameB, 'optimystic');
});

test('rung 2 (load-bearing) -- a block written through strand A storage is NOT readable through strand B storage', async () => {
	const strandA = makeStrandId();
	const strandB = makeStrandId();
	const openedA = await openStrandBlockStorage(strandA);
	const openedB = await openStrandBlockStorage(strandB);
	try {
		await openedA.storage.saveMetadata(FIXTURE_BLOCK_ID, FIXTURE_METADATA);
		// Applied to strand A's object stores before strand B looks (see rung 3): without it,
		// B reading `undefined` could only mean the write had not landed yet, and this rung
		// could not fail on the shared-database bug it exists to catch.
		await openedA.storage.flush();

		const readBackA = await openedA.storage.getMetadata(FIXTURE_BLOCK_ID);
		assert.deepStrictEqual(readBackA, FIXTURE_METADATA);

		// The load-bearing assertion: strand B must NOT see strand A's block.
		const readBackB = await openedB.storage.getMetadata(FIXTURE_BLOCK_ID);
		assert.strictEqual(readBackB, undefined);

		const idsA = [];
		for await (const id of openedA.storage.listBlockIds()) idsA.push(id);
		assert.deepStrictEqual(idsA, [FIXTURE_BLOCK_ID]);

		const idsB = [];
		for await (const id of openedB.storage.listBlockIds()) idsB.push(id);
		assert.deepStrictEqual(idsB, []);
	} finally {
		openedA.db.close();
		openedB.db.close();
	}
});

// Rung 3 is what makes rung 2 mean anything: without it, rung 2 would ALSO
// pass if `saveMetadata` silently no-op'd or `getMetadata` always returned
// `undefined` -- a green gate that cannot fail. A second handle over
// strand A's OWN name proving a REAL read makes rung 2's `undefined`
// evidence rather than an artifact of a dead write path.
test('rung 3 (positive control) -- a second handle over strand A OWN name reads strand A block', async () => {
	const strandA = makeStrandId();
	const openedA1 = await openStrandBlockStorage(strandA);
	try {
		await openedA1.storage.saveMetadata(FIXTURE_BLOCK_ID, FIXTURE_METADATA);
		// @optimystic 1.16+ (Optimystic#37): the browser store records each write group in a
		// journal at once and applies it to the object stores within its durability window
		// (at most 5 s), so a SECOND handle sees the row only once it is applied. Measured
		// 2026-10-26 on 1.19.0: immediately undefined, after flush() or a 6 s wait the row.
		// flush() is the store's own way to apply now; the control still proves that the same
		// name opens the same database.
		await openedA1.storage.flush();

		const openedA2 = await openStrandBlockStorage(strandA);
		try {
			const readBack = await openedA2.storage.getMetadata(FIXTURE_BLOCK_ID);
			assert.deepStrictEqual(readBack, FIXTURE_METADATA);
		} finally {
			openedA2.db.close();
		}
	} finally {
		openedA1.db.close();
	}
});

test('rung 4 -- strandStorageDbName fails closed on an invalid strandId, never the package default name', () => {
	for (const invalid of ['', '   ', null, undefined]) {
		assert.throws(() => strandStorageDbName(/** @type {any} */ (invalid)), EdgeNodeConfigError);
	}
});
