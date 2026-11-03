/**
 * Tier-1 coverage of `src/lifecycle/refresh.js` (D-12's byte-intact refresh)
 * and `src/lifecycle/officer-swap.js` (D-14's single-flight classify-then-
 * replace seam).
 *
 * HONESTY NOTE (mirrors Task 1's suite): `fake-indexeddb` proves the
 * ORDERING, the CLASSIFICATION and the byte-intact guarantee this module
 * enforces -- NOT durability across a real page load. That further proof is
 * Task 4's two-page browser gate.
 *
 * `import 'fake-indexeddb/auto'` first, then `node:test` + `node:assert/strict`,
 * then 50-08's fixture module and a `Map`-backed storage double. Sequential
 * and stateful, one network hash per test, `deleteNetworkDb` at the top of
 * each.
 *
 * The deriveOfficerUserIdFromEnvelope and classifyRedemption classifier cases moved to `officer-swap.test.mjs`.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dashboardSrc } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';
import { buildSnapshot } from '@votetorrent/vote-engine/bootstrap';
import {
	deleteNetworkDb,
	closeNetworkDb,
	attachNetworkDb,
	readRowCounts,
	rowCountsKeyFor,
	findNetwork,
} from '@votetorrent/web-data/officer';
import { redeemAndBootstrap } from '../../src/lifecycle/bootstrap.js';
import { redeemSignInCode } from '../../src/transport/bootstrap-transport-client.js';
import {
	buildFixtureEnvelope,
	withDroppedRows,
	withMutatedCell,
	withForeignSchemaHash,
	withExtraUserRow,
	makeFakeTransport,
} from '../fixtures/bootstrap-envelope.js';
import {
	RowCountRecordNotUpdatedError,
	refreshNetwork,
	captureNetworkState,
	assertNetworkStateUnchanged,
} from '../../src/lifecycle/refresh.js';
import {
	createSingleFlightTransport,
	classifyRedemption,
	performOfficerSwap,
} from '../../src/lifecycle/officer-swap.js';

const SECRET = 'a'.repeat(40);
const SECRET_2 = 'b'.repeat(40);

/** A `Map`-backed localStorage-shaped fake, exposing its raw key set for
 * test-only inspection (Node 22 has no real `localStorage`). */
function makeFakeStorage() {
	/** @type {Map<string, string>} */
	const map = new Map();
	return {
		getItem: (/** @type {string} */ key) => (map.has(key) ? /** @type {string} */ (map.get(key)) : null),
		setItem: (/** @type {string} */ key, /** @type {string} */ value) => {
			map.set(key, value);
		},
		removeItem: (/** @type {string} */ key) => {
			map.delete(key);
		},
		/** Test-only escape hatch. @returns {string[]} */
		_keys: () => [...map.keys()],
	};
}

/**
 * A storage double that can be told, at an explicit point in a test, to start
 * reporting `rowCountsKey` as absent -- simulating the row-count record not
 * surviving to refresh.js's post-swap check while the registry entry does.
 * Writes ALWAYS land in the real underlying map, and `_raw` reads that map
 * directly, so a test can distinguish "the reader could not see it" from
 * "something overwrote it".
 *
 * Deliberately armed by an explicit `_vanish()` call rather than by counting
 * reads: a read-count trigger silently couples the instrument to how many
 * times the implementation happens to read the key, which is exactly how the
 * previous version of this double kept passing after refresh.js stopped
 * reading it pre-swap.
 *
 * @param {string} rowCountsKey
 */
function makeVanishingRowCountsStorage(rowCountsKey) {
	/** @type {Map<string, string>} */
	const map = new Map();
	let vanished = false;
	return {
		getItem: (/** @type {string} */ key) => {
			if (key === rowCountsKey && vanished) return null;
			return map.has(key) ? map.get(key) : null;
		},
		setItem: (/** @type {string} */ key, /** @type {string} */ value) => {
			map.set(key, value);
		},
		removeItem: (/** @type {string} */ key) => {
			map.delete(key);
		},
		/** Test-only: start reporting `rowCountsKey` as absent from here on. */
		_vanish: () => {
			vanished = true;
		},
		/** Test-only: read the underlying map, bypassing the vanish. @returns {string | null} */
		_raw: (/** @type {string} */ key) => (map.has(key) ? /** @type {string} */ (map.get(key)) : null),
	};
}

/**
 * A storage double that can be told, at an explicit point in a test, to start
 * reporting `rowCountsKey`'s stored record with its `counts` object forced to
 * `{}` -- the EDGE CASE the "vanished" double does not exercise: a record
 * that is PRESENT (not `undefined`) but whose `counts` is already empty.
 * `refresh.js`'s `tableNames.length === 0` guard must catch this branch too,
 * distinctly from the `!record` branch. Writes land in the real map; `_raw`
 * bypasses the lens, exactly like {@link makeVanishingRowCountsStorage}.
 *
 * @param {string} rowCountsKey
 */
function makeEmptyCountsRowCountsStorage(rowCountsKey) {
	/** @type {Map<string, string>} */
	const map = new Map();
	let emptied = false;
	return {
		getItem: (/** @type {string} */ key) => {
			if (key === rowCountsKey && emptied) {
				const raw = map.has(key) ? map.get(key) : undefined;
				if (raw === undefined) return null;
				const parsed = JSON.parse(/** @type {string} */ (raw));
				return JSON.stringify({ ...parsed, counts: {} });
			}
			return map.has(key) ? map.get(key) : null;
		},
		setItem: (/** @type {string} */ key, /** @type {string} */ value) => {
			map.set(key, value);
		},
		removeItem: (/** @type {string} */ key) => {
			map.delete(key);
		},
		/** Test-only: start reporting `rowCountsKey`'s record with empty `counts`. */
		_empty: () => {
			emptied = true;
		},
		/** Test-only: read the underlying map, bypassing the lens. @returns {string | null} */
		_raw: (/** @type {string} */ key) => (map.has(key) ? /** @type {string} */ (map.get(key)) : null),
	};
}

/**
 * A storage double that can be told, at an explicit point in a test, to start
 * reporting `rowCountsKey`'s stored record with ONE table's count nudged by
 * +1 relative to what is actually stored -- simulating a GENUINE divergence
 * between the persisted record and live counts, as opposed to the record
 * being absent or empty. Armed with `_corrupt()` AFTER the swap's own write
 * has already landed in the real map, so `redeemAndBootstrap`'s step 9 write
 * is unaffected -- only `refresh.js`'s OWN post-swap read sees the corrupted
 * value. `_raw` bypasses the lens and reads the real, uncorrupted map.
 *
 * @param {string} rowCountsKey
 */
function makeCorruptingRowCountsStorage(rowCountsKey) {
	/** @type {Map<string, string>} */
	const map = new Map();
	let corrupt = false;
	return {
		getItem: (/** @type {string} */ key) => {
			if (key === rowCountsKey && corrupt) {
				const raw = map.has(key) ? map.get(key) : undefined;
				if (raw === undefined) return null;
				const parsed = JSON.parse(/** @type {string} */ (raw));
				const tables = Object.keys(parsed.counts);
				const corrupted = { ...parsed.counts, [tables[0]]: parsed.counts[tables[0]] + 1 };
				return JSON.stringify({ ...parsed, counts: corrupted });
			}
			return map.has(key) ? map.get(key) : null;
		},
		setItem: (/** @type {string} */ key, /** @type {string} */ value) => {
			map.set(key, value);
		},
		removeItem: (/** @type {string} */ key) => {
			map.delete(key);
		},
		/** Test-only: start returning a corrupted `counts` for `rowCountsKey`. */
		_corrupt: () => {
			corrupt = true;
		},
		/** Test-only: read the underlying (uncorrupted) map. @returns {string | null} */
		_raw: (/** @type {string} */ key) => (map.has(key) ? /** @type {string} */ (map.get(key)) : null),
	};
}

/**
 * A storage double that records the ORDER of every `getItem`/`setItem`/
 * `removeItem` call as a monotonically increasing sequence number, so a test
 * can assert "this read happened after that write" directly from the
 * recorded sequence -- never as a proxy for ordering such as "the record was
 * non-empty", which would pass even if the read raced the write.
 *
 * @returns {{ getItem: (key: string) => string | null, setItem: (key: string, value: string) => void, removeItem: (key: string) => void, _log: () => Array<{ op: 'get' | 'set' | 'remove', key: string, seq: number }>, _reset: () => void }}
 */
function makeSequenceTrackingStorage() {
	/** @type {Map<string, string>} */
	const map = new Map();
	/** @type {Array<{ op: 'get' | 'set' | 'remove', key: string, seq: number }>} */
	let log = [];
	let seq = 0;
	return {
		getItem: (key) => {
			log.push({ op: 'get', key, seq: seq++ });
			return map.has(key) ? /** @type {string} */ (map.get(key)) : null;
		},
		setItem: (key, value) => {
			log.push({ op: 'set', key, seq: seq++ });
			map.set(key, value);
		},
		removeItem: (key) => {
			log.push({ op: 'remove', key, seq: seq++ });
			map.delete(key);
		},
		/** Test-only: the recorded call sequence so far. */
		_log: () => log.slice(),
		/** Test-only: clear the recorded sequence (but not the underlying map) so a
		 * test can isolate the storage traffic of ONE call under test. */
		_reset: () => {
			log = [];
		},
	};
}

/** @param {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot} envelope @param {string} [secret] */
function codeFor(envelope, secret = SECRET) {
	return `${secret}.${envelope.digest}`;
}

/**
 * Rebuild a fixture envelope for the SAME network with a DIFFERENT officer
 * (`User.Id` = 'u2' instead of 'u1'), rebuilt through `buildSnapshot` so the
 * manifest/digest/schemaHash stay internally consistent -- this envelope
 * VERIFIES successfully; only the officer it carries differs.
 *
 * @param {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot} baseEnvelope
 */
function buildSwapOfficerEnvelope(baseEnvelope) {
	const firstUser = /** @type {Record<string, unknown>} */ (baseEnvelope.tables.User?.[0]);
	const firstOfficer = /** @type {Record<string, unknown>} */ (baseEnvelope.tables.Officer?.[0]);
	const tables = {
		...baseEnvelope.tables,
		User: [{ ...firstUser, Id: 'u2' }],
		Officer: [{ ...firstOfficer, UserId: 'u2' }],
	};
	return buildSnapshot({ networkHash: baseEnvelope.networkHash, tables, generatedAt: baseEnvelope.generatedAt });
}

/**
 * Rebuild a fixture envelope for the SAME network with a changed
 * `Registrant.PrivateCid`, rebuilt through `buildSnapshot` so the
 * manifest/digest/schemaHash stay internally consistent -- a legitimately
 * DIFFERENT, self-verifying "new snapshot" for the successful-refresh case.
 * `withMutatedCell` (used elsewhere in this file) is deliberately NOT this:
 * it keeps the OLD digest to simulate corruption, which is the opposite of
 * what a successful refresh's positive control needs.
 *
 * @param {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot} baseEnvelope
 */
function buildRefreshedEnvelope(baseEnvelope) {
	const firstRegistrant = /** @type {Record<string, unknown>} */ (baseEnvelope.tables.Registrant?.[0]);
	const tables = {
		...baseEnvelope.tables,
		Registrant: [{ ...firstRegistrant, PrivateCid: 'cid-private-refreshed' }],
	};
	return buildSnapshot({ networkHash: baseEnvelope.networkHash, tables, generatedAt: baseEnvelope.generatedAt });
}

/** Bootstrap the fixture network successfully, returning the storage double,
 * the envelope and the table-name list `captureNetworkState` needs. */
async function bootstrapFixtureNetwork() {
	const envelope = buildFixtureEnvelope();
	await deleteNetworkDb(envelope.networkHash).catch(() => undefined);
	const storage = makeFakeStorage();
	const transport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: envelope } } });
	const result = await redeemAndBootstrap({ pastedCode: codeFor(envelope), transport, storage });
	assert.equal(result.outcome, 'ok');
	return { envelope, storage, tableNames: Object.keys(envelope.manifest) };
}

// ---------------------------------------------------------------------------
// createSingleFlightTransport
// ---------------------------------------------------------------------------

test('createSingleFlightTransport: forwards on the first call and replays a deeply-equal result on the second call, without a second inner call', async () => {
	const envelope = buildFixtureEnvelope();
	const inner = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: envelope } } });
	const singleFlight = createSingleFlightTransport(inner);

	const r1 = await singleFlight.transport.redeem(SECRET);
	const r2 = await singleFlight.transport.redeem(SECRET);

	assert.deepEqual(r1, r2);
	assert.equal(inner.calls.length, 1);
	assert.equal(singleFlight.innerCallCount, 1);
});

test('createSingleFlightTransport: a refused code is never cached -- two calls reach the inner transport twice, unchanged', async () => {
	const inner = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'used' } } });
	const singleFlight = createSingleFlightTransport(inner);

	const r1 = await singleFlight.transport.redeem(SECRET);
	const r2 = await singleFlight.transport.redeem(SECRET);

	assert.equal(r1.status, 'used');
	assert.equal(r2.status, 'used');
	assert.equal(inner.calls.length, 2);
});

test('createSingleFlightTransport: reset() clears the cache -- a third call after reset() reaches the inner transport again', async () => {
	const envelope = buildFixtureEnvelope();
	const inner = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: envelope } } });
	const singleFlight = createSingleFlightTransport(inner);

	await singleFlight.transport.redeem(SECRET);
	await singleFlight.transport.redeem(SECRET);
	assert.equal(inner.calls.length, 1);

	singleFlight.reset();
	await singleFlight.transport.redeem(SECRET);
	assert.equal(inner.calls.length, 2);
});

test('createSingleFlightTransport: takes no storage argument at all -- structurally cannot persist the cache', () => {
	assert.equal(createSingleFlightTransport.length, 1);
});

// ---------------------------------------------------------------------------
// refreshNetwork -- the byte-intact control, once per failing outcome
// ---------------------------------------------------------------------------

test('refreshNetwork: digest-mismatch leaves the network byte-intact', async () => {
	const { envelope, storage, tableNames } = await bootstrapFixtureNetwork();
	const before = await captureNetworkState(envelope.networkHash, storage, tableNames);

	const transport = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'ok', snapshot: envelope } } });
	const wrongDigestCode = `${SECRET_2}.${'z'.repeat(43)}`;
	const result = await refreshNetwork({ networkHash: envelope.networkHash, pastedCode: wrongDigestCode, transport, storage });

	assert.equal(result.outcome, 'verify-failed');
	assert.ok(result.outcome === 'verify-failed' && result.reason === 'digest-mismatch');
	const after = await captureNetworkState(envelope.networkHash, storage, tableNames);
	assert.doesNotThrow(() => assertNetworkStateUnchanged(before, after));
	await deleteNetworkDb(envelope.networkHash);
});

test('refreshNetwork: manifest-mismatch (dropped rows, untouched manifest) leaves the network byte-intact, and is NOT digest-mismatch', async () => {
	const { envelope, storage, tableNames } = await bootstrapFixtureNetwork();
	const before = await captureNetworkState(envelope.networkHash, storage, tableNames);

	const truncated = withDroppedRows(envelope, 'Registrant', 1);
	const transport = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'ok', snapshot: truncated } } });
	const result = await refreshNetwork({ networkHash: envelope.networkHash, pastedCode: codeFor(envelope, SECRET_2), transport, storage });

	assert.equal(result.outcome, 'verify-failed');
	assert.ok(result.outcome === 'verify-failed' && result.reason === 'manifest-mismatch');
	assert.notEqual(/** @type {any} */ (result).reason, 'digest-mismatch');
	const after = await captureNetworkState(envelope.networkHash, storage, tableNames);
	assert.doesNotThrow(() => assertNetworkStateUnchanged(before, after));
	await deleteNetworkDb(envelope.networkHash);
});

test('refreshNetwork: schema-hash-mismatch leaves the network byte-intact', async () => {
	const { envelope, storage, tableNames } = await bootstrapFixtureNetwork();
	const before = await captureNetworkState(envelope.networkHash, storage, tableNames);

	const foreign = withForeignSchemaHash(envelope);
	const transport = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'ok', snapshot: foreign } } });
	const result = await refreshNetwork({ networkHash: envelope.networkHash, pastedCode: codeFor(envelope, SECRET_2), transport, storage });

	assert.equal(result.outcome, 'verify-failed');
	assert.ok(result.outcome === 'verify-failed' && result.reason === 'schema-hash-mismatch');
	const after = await captureNetworkState(envelope.networkHash, storage, tableNames);
	assert.doesNotThrow(() => assertNetworkStateUnchanged(before, after));
	await deleteNetworkDb(envelope.networkHash);
});

test('refreshNetwork: code-refused leaves the network byte-intact', async () => {
	const { envelope, storage, tableNames } = await bootstrapFixtureNetwork();
	const before = await captureNetworkState(envelope.networkHash, storage, tableNames);

	const transport = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'expired' } } });
	const result = await refreshNetwork({ networkHash: envelope.networkHash, pastedCode: codeFor(envelope, SECRET_2), transport, storage });

	assert.equal(result.outcome, 'code-refused');
	assert.ok(result.outcome === 'code-refused' && result.status === 'expired');
	const after = await captureNetworkState(envelope.networkHash, storage, tableNames);
	assert.doesNotThrow(() => assertNetworkStateUnchanged(before, after));
	await deleteNetworkDb(envelope.networkHash);
});

test('refreshNetwork: transport-unreachable leaves the network byte-intact', async () => {
	const { envelope, storage, tableNames } = await bootstrapFixtureNetwork();
	const before = await captureNetworkState(envelope.networkHash, storage, tableNames);

	const transport = makeFakeTransport({ codeToResult: { [SECRET_2]: new Error('network is down') } });
	const result = await refreshNetwork({ networkHash: envelope.networkHash, pastedCode: codeFor(envelope, SECRET_2), transport, storage });

	assert.equal(result.outcome, 'transport-unreachable');
	const after = await captureNetworkState(envelope.networkHash, storage, tableNames);
	assert.doesNotThrow(() => assertNetworkStateUnchanged(before, after));
	await deleteNetworkDb(envelope.networkHash);
});

test('refreshNetwork: a verify-failed refusal writes the row-count key exactly zero times, counted directly from the storage adapter\'s own log -- not inferred from the byte-intact snapshot comparison', async () => {
	const { envelope, storage: baseStorage, tableNames } = await bootstrapFixtureNetwork();
	// Swap the fixture's plain fake storage for a sequence-tracking one, seeded
	// with the same underlying data, so this test measures storage TRAFFIC
	// directly rather than reusing the outcome-comparison instrument the other
	// byte-intact tests already use.
	const storage = makeSequenceTrackingStorage();
	for (const key of baseStorage._keys()) {
		storage.setItem(key, /** @type {string} */ (baseStorage.getItem(key)));
	}
	storage._reset();

	const rowCountsKey = rowCountsKeyFor(envelope.networkHash);
	const transport = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'ok', snapshot: envelope } } });
	const wrongDigestCode = `${SECRET_2}.${'z'.repeat(43)}`;
	const result = await refreshNetwork({ networkHash: envelope.networkHash, pastedCode: wrongDigestCode, transport, storage });

	assert.equal(result.outcome, 'verify-failed');
	const setOpsOnRowCountsKey = storage._log().filter((entry) => entry.op === 'set' && entry.key === rowCountsKey);
	assert.equal(setOpsOnRowCountsKey.length, 0, 'a refused refresh must write the row-count key zero times');

	await deleteNetworkDb(envelope.networkHash);
	void tableNames;
});

test('refreshNetwork: officer-indeterminate leaves the network byte-intact', async () => {
	const { envelope, storage, tableNames } = await bootstrapFixtureNetwork();
	const before = await captureNetworkState(envelope.networkHash, storage, tableNames);

	const twoUsers = withExtraUserRow(envelope);
	const transport = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'ok', snapshot: twoUsers } } });
	const result = await refreshNetwork({ networkHash: envelope.networkHash, pastedCode: codeFor(twoUsers, SECRET_2), transport, storage });

	assert.equal(result.outcome, 'officer-indeterminate');
	const after = await captureNetworkState(envelope.networkHash, storage, tableNames);
	assert.doesNotThrow(() => assertNetworkStateUnchanged(before, after));
	await deleteNetworkDb(envelope.networkHash);
});

// ---------------------------------------------------------------------------
// refreshNetwork -- the successful path rewrites the record AFTER the swap
// ---------------------------------------------------------------------------

test('refreshNetwork: on success, the row-count record is rewritten to the new manifest and bootstrappedAt advances', async () => {
	const { envelope, storage, tableNames } = await bootstrapFixtureNetwork();
	const preRefreshRecordKey = rowCountsKeyFor(envelope.networkHash);
	const preRefreshRecord = JSON.parse(/** @type {string} */ (storage.getItem(preRefreshRecordKey)));
	const preRefreshEntry = findNetwork(envelope.networkHash, storage);

	// A mutated cell (same row counts, new digest) is a legitimate "new
	// snapshot" for this test's purposes -- refreshNetwork does not care
	// WHY the content differs, only that it verifies.
	const newSnapshot = buildRefreshedEnvelope(envelope);
	const transport = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'ok', snapshot: newSnapshot } } });
	const result = await refreshNetwork({
		networkHash: envelope.networkHash,
		pastedCode: codeFor(newSnapshot, SECRET_2),
		transport,
		storage,
	});

	assert.equal(result.outcome, 'ok');

	const postRefreshRecord = JSON.parse(/** @type {string} */ (storage.getItem(preRefreshRecordKey)));
	assert.deepEqual(postRefreshRecord.counts, newSnapshot.manifest);
	assert.ok(postRefreshRecord.capturedAt >= preRefreshRecord.capturedAt);

	const postRefreshEntry = findNetwork(envelope.networkHash, storage);
	assert.ok(/** @type {string} */ (postRefreshEntry?.bootstrappedAt) >= /** @type {string} */ (preRefreshEntry?.bootstrappedAt));

	const db = await attachNetworkDb(envelope.networkHash, { storage, expectedCounts: {} });
	const liveCounts = await readRowCounts(db, tableNames);
	assert.deepEqual(liveCounts, newSnapshot.manifest);
	await closeNetworkDb(db);

	await deleteNetworkDb(envelope.networkHash);
});

test('refreshNetwork: RowCountRecordNotUpdatedError names the network when the post-swap record vanishes, paired with the unmodified positive control above', async () => {
	const envelope = buildFixtureEnvelope();
	await deleteNetworkDb(envelope.networkHash).catch(() => undefined);
	const key = rowCountsKeyFor(envelope.networkHash);
	const storage = makeVanishingRowCountsStorage(key);

	const bootstrapTransport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: envelope } } });
	const bootstrapResult = await redeemAndBootstrap({ pastedCode: codeFor(envelope), transport: bootstrapTransport, storage });
	assert.equal(bootstrapResult.outcome, 'ok');
	storage._vanish();

	const newSnapshot = buildRefreshedEnvelope(envelope);
	const refreshTransport = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'ok', snapshot: newSnapshot } } });

	await assert.rejects(
		() => refreshNetwork({ networkHash: envelope.networkHash, pastedCode: codeFor(newSnapshot, SECRET_2), transport: refreshTransport, storage }),
		(/** @type {any} */ err) => {
			assert.ok(err instanceof RowCountRecordNotUpdatedError);
			assert.equal(err.networkHash, envelope.networkHash);
			return true;
		},
	);

	// AND -- the anti-repair property this rejection exists to protect. The
	// old implementation derived its table set from a possibly-absent PRIOR
	// record, so an unreadable key produced `readRowCounts(db, [])` === `{}`,
	// and it then WROTE that `{}` over the correct manifest the swap had just
	// persisted. `assertRowCounts` iterates zero keys, so the network's
	// truncation check was silently disabled from then on. The stored record
	// must still be the real manifest, never an empty object.
	const persisted = JSON.parse(/** @type {string} */ (storage._raw(key)));
	assert.deepEqual(persisted.counts, newSnapshot.manifest);
	assert.notDeepEqual(persisted.counts, {});

	await deleteNetworkDb(envelope.networkHash);
});

test('refreshNetwork: a PRESENT record whose counts are already {} (not absent) also throws RowCountRecordNotUpdatedError -- the tableNames.length === 0 branch, distinct from the !record branch', async () => {
	const envelope = buildFixtureEnvelope();
	await deleteNetworkDb(envelope.networkHash).catch(() => undefined);
	const key = rowCountsKeyFor(envelope.networkHash);
	const storage = makeEmptyCountsRowCountsStorage(key);

	const bootstrapTransport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: envelope } } });
	const bootstrapResult = await redeemAndBootstrap({ pastedCode: codeFor(envelope), transport: bootstrapTransport, storage });
	assert.equal(bootstrapResult.outcome, 'ok');
	storage._empty();

	const newSnapshot = buildRefreshedEnvelope(envelope);
	const refreshTransport = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'ok', snapshot: newSnapshot } } });

	await assert.rejects(
		() => refreshNetwork({ networkHash: envelope.networkHash, pastedCode: codeFor(newSnapshot, SECRET_2), transport: refreshTransport, storage }),
		(/** @type {any} */ err) => {
			assert.ok(err instanceof RowCountRecordNotUpdatedError);
			assert.equal(err.networkHash, envelope.networkHash);
			return true;
		},
	);

	// The underlying (uncorrupted) stored value is still the full manifest --
	// redeemAndBootstrap's own step 9 wrote it during the swap, and
	// refreshNetwork itself never touched storage on this throwing path.
	const persisted = JSON.parse(/** @type {string} */ (storage._raw(key)));
	assert.deepEqual(persisted.counts, newSnapshot.manifest);

	await deleteNetworkDb(envelope.networkHash);
});

test('refreshNetwork: a genuine divergence between the post-swap record and live counts still throws, and never writes a repair value', async () => {
	const envelope = buildFixtureEnvelope();
	await deleteNetworkDb(envelope.networkHash).catch(() => undefined);
	const key = rowCountsKeyFor(envelope.networkHash);
	const storage = makeCorruptingRowCountsStorage(key);

	const bootstrapTransport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: envelope } } });
	const bootstrapResult = await redeemAndBootstrap({ pastedCode: codeFor(envelope), transport: bootstrapTransport, storage });
	assert.equal(bootstrapResult.outcome, 'ok');

	const newSnapshot = buildRefreshedEnvelope(envelope);
	const refreshTransport = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'ok', snapshot: newSnapshot } } });

	// Arm the corruption AFTER bootstrapping -- the swap's own step 9 write
	// (inside the refreshNetwork call below) still lands the CORRECT new
	// manifest in the real map; only refresh.js's OWN post-swap read of that
	// record is lied to, simulating a genuine divergence discovered after a
	// swap that otherwise landed cleanly.
	storage._corrupt();

	const beforeKeys = Object.keys(JSON.parse(/** @type {string} */ (storage._raw(key))).counts);

	await assert.rejects(
		() => refreshNetwork({ networkHash: envelope.networkHash, pastedCode: codeFor(newSnapshot, SECRET_2), transport: refreshTransport, storage }),
		(/** @type {any} */ err) => {
			assert.ok(err instanceof RowCountRecordNotUpdatedError);
			assert.equal(err.networkHash, envelope.networkHash);
			return true;
		},
	);

	// The stored record (bypassing the corruption lens) is left no weaker than
	// it was BEFORE this call -- same table set, because redeemAndBootstrap's
	// own step 9 write is the only write that happened, and it wrote the
	// correct new manifest, never an emptier "repair" value.
	const afterKeys = Object.keys(JSON.parse(/** @type {string} */ (storage._raw(key))).counts);
	assert.ok(afterKeys.length >= beforeKeys.length, 'the stored record must never shrink');
	assert.deepEqual(afterKeys.sort(), Object.keys(newSnapshot.manifest).sort());

	await deleteNetworkDb(envelope.networkHash);
});

test('refreshNetwork: throws the unheld-network programming error, naming the hash, without touching storage', async () => {
	const envelope = buildFixtureEnvelope();
	await deleteNetworkDb(envelope.networkHash).catch(() => undefined);
	const storage = makeFakeStorage();
	const transport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: envelope } } });

	await assert.rejects(
		() => refreshNetwork({ networkHash: envelope.networkHash, pastedCode: codeFor(envelope), transport, storage }),
		(/** @type {any} */ err) => {
			assert.ok(err instanceof Error);
			assert.ok(!(err instanceof RowCountRecordNotUpdatedError), 'expected the programming-error path, not the row-count path');
			assert.ok(err.message.includes(envelope.networkHash), 'expected the error to name the network hash');
			assert.ok(err.message.includes('bootstrap, not a refresh'));
			return true;
		},
	);

	// A refusal this early must not have touched storage at all.
	assert.deepEqual(storage._keys(), []);
});

test('refreshNetwork: on the happy path, the post-swap record read happens strictly AFTER redeemAndBootstrap\'s own write, and refreshNetwork performs no write of its own', async () => {
	const envelope = buildFixtureEnvelope();
	await deleteNetworkDb(envelope.networkHash).catch(() => undefined);
	const storage = makeSequenceTrackingStorage();
	const bootstrapTransport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: envelope } } });
	const bootstrapResult = await redeemAndBootstrap({ pastedCode: codeFor(envelope), transport: bootstrapTransport, storage });
	assert.equal(bootstrapResult.outcome, 'ok');

	const rowCountsKey = rowCountsKeyFor(envelope.networkHash);
	// Isolate the storage traffic of the refreshNetwork call under test --
	// the initial bootstrap's own reads/writes are not what this assertion is about.
	storage._reset();

	const newSnapshot = buildRefreshedEnvelope(envelope);
	const refreshTransport = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'ok', snapshot: newSnapshot } } });
	const result = await refreshNetwork({
		networkHash: envelope.networkHash,
		pastedCode: codeFor(newSnapshot, SECRET_2),
		transport: refreshTransport,
		storage,
	});
	assert.equal(result.outcome, 'ok');

	const log = storage._log();
	const setOps = log.filter((entry) => entry.op === 'set' && entry.key === rowCountsKey);
	// Exactly ONE write of the row-count key across the whole refreshNetwork
	// call -- redeemAndBootstrap's own step 9. refreshNetwork itself never
	// calls writeRowCounts (also grep-enforced: see the plan's acceptance
	// criteria), so a positive control that merely checked "the record is
	// correct afterwards" would be satisfiable by a function that wrote a
	// SECOND, redundant, correct value -- this counts the writes directly.
	assert.equal(setOps.length, 1, `expected exactly one write of the row-count key, saw ${setOps.length}`);

	const getOpsAfterSwapWrite = log.filter(
		(entry) => entry.op === 'get' && entry.key === rowCountsKey && entry.seq > setOps[0].seq,
	);
	assert.ok(
		getOpsAfterSwapWrite.length >= 1,
		'expected refreshNetwork to read the row-count record AFTER redeemAndBootstrap wrote it, not before',
	);

	await deleteNetworkDb(envelope.networkHash);
});

// ---------------------------------------------------------------------------
// performOfficerSwap -- one code, one network call; identity and data
// change together; storage carries nothing extra.
// ---------------------------------------------------------------------------

test('performOfficerSwap: completes the classify-then-replace sequence with exactly ONE inner redeem call', async () => {
	const baseline = await bootstrapFixtureNetwork();
	const swapEnvelope = buildSwapOfficerEnvelope(baseline.envelope);
	const inner = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'ok', snapshot: swapEnvelope } } });
	const singleFlight = createSingleFlightTransport(inner);

	// The classify pass -- the ONLY network round trip this whole sequence makes.
	const redemption = await redeemSignInCode(singleFlight.transport, SECRET_2);
	assert.equal(redemption.status, 'ok');
	const classification = classifyRedemption({
		envelope: /** @type {any} */ (redemption).snapshot,
		storage: baseline.storage,
	});
	assert.equal(classification.kind, 'officer-swap');

	const result = await performOfficerSwap({
		networkHash: baseline.envelope.networkHash,
		pastedCode: codeFor(swapEnvelope, SECRET_2),
		transport: singleFlight.transport,
		storage: baseline.storage,
	});

	assert.equal(result.outcome, 'ok');
	assert.equal(inner.calls.length, 1);
	assert.equal(singleFlight.innerCallCount, 1);

	// Identity AND data changed together, asserted in the same test.
	const entry = findNetwork(baseline.envelope.networkHash, baseline.storage);
	assert.equal(entry?.officerUserId, 'u2');
	const db = await attachNetworkDb(baseline.envelope.networkHash, { storage: baseline.storage, expectedCounts: {} });
	const liveCounts = await readRowCounts(db, baseline.tableNames);
	assert.deepEqual(liveCounts, swapEnvelope.manifest);
	await closeNetworkDb(db);

	// The storage double carries nothing beyond what redeemAndBootstrap
	// itself writes -- the two keys, no more.
	const keys = baseline.storage._keys().sort();
	assert.deepEqual(keys, [rowCountsKeyFor(baseline.envelope.networkHash), 'votetorrent.dashboard.networks'].sort());

	await deleteNetworkDb(baseline.envelope.networkHash);
});

test('a cancelled swap (classification computed, performOfficerSwap never called) leaves the prior database, record and registry entry all unchanged', async () => {
	const baseline = await bootstrapFixtureNetwork();
	const before = await captureNetworkState(baseline.envelope.networkHash, baseline.storage, baseline.tableNames);

	const swapEnvelope = buildSwapOfficerEnvelope(baseline.envelope);
	const classification = classifyRedemption({ envelope: swapEnvelope, storage: baseline.storage });
	assert.equal(classification.kind, 'officer-swap');
	// CANCELLED: performOfficerSwap is never called.

	const after = await captureNetworkState(baseline.envelope.networkHash, baseline.storage, baseline.tableNames);
	assert.doesNotThrow(() => assertNetworkStateUnchanged(before, after));

	await deleteNetworkDb(baseline.envelope.networkHash);
});

// ---------------------------------------------------------------------------
// WR-11 -- the handle no longer blocks the delete. `performOfficerSwap` ->
// `refreshNetwork` -> `redeemAndBootstrap({ replace: true })` deletes the
// network's database; `deleteNetworkDb` refuses to resolve on `onblocked`
// and rejects `DeleteBlockedError` after its timeout instead. A caller
// holding an open connection MUST hand it over via the `db` option, or the
// swap races its own delete and fails, burning the officer's single-use
// code (this is exactly what `DashboardShell.tsx`'s `handleConfirmSwap`
// used to do before 50-18).
//
// HONESTY NOTE, checked empirically before writing this suite (not assumed):
// `db-delete.test.mjs`'s own blocked-delete case proves `deleteNetworkDb`
// rejects `DeleteBlockedError` for a competing connection -- but ONLY for a
// RAW `indexedDB.open()` connection held open directly. A Quereus `Database`
// returned by `attachNetworkDb` (the shape `dbRef.current` actually is in
// `DashboardShell.tsx`) does NOT hold `fake-indexeddb`'s delete open the same
// way: a spike of `attachNetworkDb` + an un-forwarded `deleteNetworkDb` call
// resolved in ~2ms, never blocking, even with the Quereus handle's own
// `isOpen` reporting `true`. This matches this project's other recorded
// `fake-indexeddb` gaps (D-20's own rationale; 50-17's settle-race note) --
// connection-lifecycle edges are exactly what `fake-indexeddb` does not
// reproduce. The PRE-FIX `DeleteBlockedError` this plan's SUMMARY must record
// is therefore the one `db-delete.test.mjs` already observes for the
// underlying primitive (WR-11's OWN failure was witnessed in
// `test/browser/run-headless.mjs`'s real-Chrome `compose-swap` leg, Task 3 --
// that is the tier this specific regression is only reproducible at). What
// IS provable here, deterministically, at tier-1: the forwarded handle is
// actually closed, in the right place, as part of a swap that succeeds.
// ---------------------------------------------------------------------------

test('performOfficerSwap: a handed-over db handle is closed (via deleteNetworkDb) as part of a swap that succeeds', async () => {
	const baseline = await bootstrapFixtureNetwork();
	const swapEnvelope = buildSwapOfficerEnvelope(baseline.envelope);

	// The exact shape DashboardShell.tsx hands over: an attachNetworkDb
	// handle, still open, to the SAME network the swap is about to replace.
	const handoverHandle = await attachNetworkDb(baseline.envelope.networkHash, {
		storage: baseline.storage,
		expectedCounts: {},
	});
	let closeCallCount = 0;
	const originalClose = handoverHandle.close.bind(handoverHandle);
	handoverHandle.close = async (...args) => {
		closeCallCount += 1;
		return originalClose(...args);
	};

	const inner = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'ok', snapshot: swapEnvelope } } });
	const singleFlight = createSingleFlightTransport(inner);
	const result = await performOfficerSwap({
		networkHash: baseline.envelope.networkHash,
		pastedCode: codeFor(swapEnvelope, SECRET_2),
		transport: singleFlight.transport,
		storage: baseline.storage,
		db: handoverHandle,
	});

	assert.equal(result.outcome, 'ok');
	assert.equal(closeCallCount, 1, 'the handed-over handle must be closed exactly once, as part of the delete step');

	const entryAfterSwap = findNetwork(baseline.envelope.networkHash, baseline.storage);
	assert.equal(entryAfterSwap?.officerUserId, 'u2');

	await deleteNetworkDb(baseline.envelope.networkHash);
});

test('inertness control: without the db option, performOfficerSwap never closes a handle it was never handed', async () => {
	const baseline = await bootstrapFixtureNetwork();
	const swapEnvelope = buildSwapOfficerEnvelope(baseline.envelope);

	const untouchedHandle = await attachNetworkDb(baseline.envelope.networkHash, {
		storage: baseline.storage,
		expectedCounts: {},
	});
	let closeCallCount = 0;
	const originalClose = untouchedHandle.close.bind(untouchedHandle);
	untouchedHandle.close = async (...args) => {
		closeCallCount += 1;
		return originalClose(...args);
	};

	const inner = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'ok', snapshot: swapEnvelope } } });
	const singleFlight = createSingleFlightTransport(inner);
	// db intentionally omitted -- this handle is a bystander, not handed over.
	const result = await performOfficerSwap({
		networkHash: baseline.envelope.networkHash,
		pastedCode: codeFor(swapEnvelope, SECRET_2),
		transport: singleFlight.transport,
		storage: baseline.storage,
	});

	assert.equal(result.outcome, 'ok');
	assert.equal(closeCallCount, 0, "a handle that was never handed over must never be closed by someone else's swap");

	await closeNetworkDb(untouchedHandle);
	await deleteNetworkDb(baseline.envelope.networkHash);
});

test('the db option is forwarded at every hop: performOfficerSwap -> refreshNetwork -> redeemAndBootstrap -> deleteNetworkDb (source-level pin, paired with the behavioural proof above)', async () => {
	const OFFICER_SWAP_SRC = readFileSync(dashboardSrc('lifecycle', 'officer-swap.js'), 'utf8');
	const REFRESH_SRC = readFileSync(dashboardSrc('lifecycle', 'refresh.js'), 'utf8');
	const BOOTSTRAP_SRC = readFileSync(dashboardSrc('lifecycle', 'bootstrap.js'), 'utf8');

	// Hop 1: performOfficerSwap forwards its own `db` option to refreshNetwork.
	assert.match(OFFICER_SWAP_SRC, /refreshNetwork\(\{[\s\S]{0,200}?db: handoverDb\s*\}\)/);
	// Hop 2: refreshNetwork forwards ITS `db` option to redeemAndBootstrap.
	assert.match(REFRESH_SRC, /redeemAndBootstrap\(\{[\s\S]{0,200}?db: handoverDb,?\s*\}\)/);
	// Hop 3: redeemAndBootstrap forwards ITS `db` option to deleteNetworkDb,
	// on the replace path only.
	assert.match(BOOTSTRAP_SRC, /deleteNetworkDb\(envelope\.networkHash, \{ storage, db: handoverDb \}\)/);
});

test('inertness control: the per-hop forwarding matchers do not accept a hop that drops the option', () => {
	assert.doesNotMatch('await refreshNetwork({ networkHash, pastedCode, transport });', /refreshNetwork\(\{[\s\S]{0,200}?db: handoverDb\s*\}\)/);
	assert.doesNotMatch(
		'await redeemAndBootstrap({ pastedCode, transport, replace: true });',
		/redeemAndBootstrap\(\{[\s\S]{0,200}?db: handoverDb,?\s*\}\)/,
	);
	assert.doesNotMatch(
		'await deleteNetworkDb(envelope.networkHash, { storage });',
		/deleteNetworkDb\(envelope\.networkHash, \{ storage, db: handoverDb \}\)/,
	);
});

// ---------------------------------------------------------------------------
// WR-10 -- DashboardShell.tsx source-level wiring. `node --test` cannot
// import `.tsx`; the same idiom `shell-wiring.test.mjs` established. Every
// matcher here is paired with an inertness control.
// ---------------------------------------------------------------------------

const SHELL_TSX = readFileSync(dashboardSrc('screens', 'DashboardShell.tsx'), 'utf8');
const SHELL_CODE = stripComments(SHELL_TSX);

test('DashboardShell: accepts pendingSwapContext and onSwapContextConsumed, both optional', () => {
	assert.match(SHELL_CODE, /pendingSwapContext\?: AlreadyBootstrappedContext \| null;/);
	assert.match(SHELL_CODE, /onSwapContextConsumed\?: \(\) => void;/);
	assert.match(SHELL_CODE, /pendingSwapContext = null,/);
});

test('inertness control: the optional-prop matcher does not accept a required prop', () => {
	assert.doesNotMatch('pendingSwapContext: AlreadyBootstrappedContext | null;', /pendingSwapContext\?: AlreadyBootstrappedContext \| null;/);
});

test("DashboardShell: an 'officer-swap' classification populates pendingSwap (raises the existing dialog); a 'same-officer-refresh' classification calls performOfficerSwap directly, with no dialog", () => {
	const effectBody = SHELL_CODE.slice(
		SHELL_CODE.indexOf('if (!pendingSwapContext) return undefined;'),
		SHELL_CODE.indexOf('if (!activeNetwork) {'),
	);
	assert.ok(effectBody.length > 0, 'could not locate the swap-context classification effect');

	const officerSwapCase = effectBody.slice(effectBody.indexOf("case 'officer-swap':"), effectBody.indexOf("case 'same-officer-refresh':"));
	assert.match(officerSwapCase, /setPendingSwap\(\{/);
	assert.doesNotMatch(officerSwapCase, /await performOfficerSwap\(/, "officer-swap must raise the dialog, not swap directly");

	const sameOfficerCase = effectBody.slice(effectBody.indexOf("case 'same-officer-refresh':"), effectBody.indexOf("case 'officer-indeterminate':"));
	// The call is reached through withNetworkDbLifecycleLock (CR-04, 50-22),
	// so this matches performOfficerSwap( itself rather than an
	// immediately-preceding await.
	assert.match(sameOfficerCase, /performOfficerSwap\(\{/);
	assert.doesNotMatch(sameOfficerCase, /setPendingSwap\(/, 'same-officer-refresh must not raise the confirm dialog');
});

test('inertness control: the officer-swap-no-swap-call matcher hits a synthetic fixture that swaps directly', () => {
	const fixture = "case 'officer-swap':\n\tawait performOfficerSwap({ networkHash });\n\tbreak;";
	assert.match(fixture, /await performOfficerSwap\(/, 'matcher is inert');
});

test("DashboardShell: 'officer-indeterminate' and 'new-network' never call performOfficerSwap -- nothing is ever deleted on either path", () => {
	const effectBody = SHELL_CODE.slice(
		SHELL_CODE.indexOf('if (!pendingSwapContext) return undefined;'),
		SHELL_CODE.indexOf('if (!activeNetwork) {'),
	);
	const indeterminateCase = effectBody.slice(effectBody.indexOf("case 'officer-indeterminate':"), effectBody.indexOf("case 'new-network':"));
	const newNetworkCase = effectBody.slice(effectBody.indexOf("case 'new-network':"), effectBody.indexOf('default:'));
	assert.doesNotMatch(indeterminateCase, /performOfficerSwap/);
	assert.doesNotMatch(newNetworkCase, /performOfficerSwap/);
	assert.match(indeterminateCase, /OfficerIndeterminateError/);
});

test('inertness control: the no-swap-call matcher hits a synthetic fixture that DOES call performOfficerSwap', () => {
	assert.match("case 'officer-indeterminate':\n\tawait performOfficerSwap({});\n\tbreak;", /performOfficerSwap/, 'matcher is inert');
});

test('DashboardShell: the same-officer-refresh path hands its open handle over BEFORE calling performOfficerSwap, mirroring handleConfirmSwap', () => {
	const sameOfficerCase = SHELL_CODE.slice(SHELL_CODE.indexOf("case 'same-officer-refresh':"), SHELL_CODE.indexOf("case 'officer-indeterminate':"));
	const handoverAt = sameOfficerCase.indexOf('const handoverDb = dbRef.current');
	// performOfficerSwap( itself, not an immediately-preceding await -- the
	// call is now reached through withNetworkDbLifecycleLock (CR-04, 50-22).
	const swapCallAt = sameOfficerCase.indexOf('performOfficerSwap(');
	assert.ok(handoverAt >= 0 && swapCallAt >= 0, 'could not locate both the handover and the swap call in the same-officer-refresh case');
	assert.ok(handoverAt < swapCallAt, 'the handle must be taken BEFORE the swap call');
	assert.match(sameOfficerCase, /db: handoverDb,/);
});

test('inertness control: the handover-order matcher does not accept a close-after-swap fixture', () => {
	const fixture = [
		"case 'same-officer-refresh': {",
		'const result = await performOfficerSwap({ networkHash, pastedCode, transport });',
		'const handoverDb = dbRef.current;',
	].join('\n');
	const handoverAt = fixture.indexOf('const handoverDb = dbRef.current');
	const swapCallAt = fixture.indexOf('await performOfficerSwap(');
	assert.ok(!(handoverAt >= 0 && swapCallAt >= 0 && handoverAt < swapCallAt), 'matcher is inert');
});
