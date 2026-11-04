/**
 * Tier-1 coverage of `redeemAndBootstrap` (`src/lifecycle/bootstrap.js`)
 * including the D-12 byte-intact control and the D-08 two-network case.
 *
 * HONESTY NOTE (mirrors Task 2's suite): `fake-indexeddb` proves the
 * ORDERING this module enforces, not persistence across a real page load --
 * that proof is the tier-2 two-page gate's, handed to 50-09.
 *
 * `import 'fake-indexeddb/auto'` first, then `node:test` + `node:assert/strict`,
 * the Task 2 fixture, and a Map-backed storage double. Sequential, one
 * network hash per test, `deleteNetworkDb` at the top of each.
 *
 * The source-wiring section that read the old sign-in screen and main.tsx was
 * removed when the pairing screen replaced it; a later cleanup deletes this file.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	deleteNetworkDb,
	closeNetworkDb,
	dbNameFor,
	readRowCounts,
	readRowCountsRecord,
	attachNetworkDb,
	findNetwork,
	listNetworks,
} from '@votetorrent/web-data/officer';
import { BOOTSTRAP_OUTCOME_CODES, redeemAndBootstrap, copyKeysForOutcome } from '../../src/lifecycle/bootstrap.js';
import { createSingleFlightTransport } from '../../src/lifecycle/officer-swap.js';
import { redeemSignInCode } from '../../src/transport/bootstrap-transport-client.js';
import {
	buildFixtureEnvelope,
	withDroppedRows,
	withMutatedCell,
	withForeignSchemaHash,
	withWrongFormatVersion,
	withExtraUserRow,
	withCaseCollidingRegistrant,
	makeFakeTransport,
} from '../fixtures/bootstrap-envelope.js';
import { t } from '@votetorrent/ui-web';
import { buildSnapshot } from '@votetorrent/vote-engine/bootstrap';

const SECRET = 'a'.repeat(40);

/** A tiny Map-backed localStorage-shaped fake -- Node 22 has no real `localStorage`. */
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
	};
}

/**
 * @param {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot} envelope
 * @returns {string}
 */
function codeFor(envelope) {
	return `${SECRET}.${envelope.digest}`;
}

/**
 * Bootstrap network H successfully, returning the storage double and a
 * snapshot of the resulting facts -- the baseline the byte-intact assertions
 * compare against.
 */
async function bootstrapFixtureNetwork() {
	const envelope = buildFixtureEnvelope();
	await deleteNetworkDb(envelope.networkHash).catch(() => {});
	const storage = makeFakeStorage();
	const transport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: envelope } } });

	const result = await redeemAndBootstrap({ pastedCode: codeFor(envelope), transport, storage });
	assert.equal(result.outcome, 'ok');

	const db = await attachNetworkDb(envelope.networkHash, { expectedCounts: envelope.manifest, storage });
	const rowCounts = await readRowCounts(db, Object.keys(envelope.manifest));
	await closeNetworkDb(db);
	return { envelope, storage, rowCounts };
}

/**
 * Assert that network H's persisted facts are IDENTICAL to `baseline` --
 * the D-12 byte-intact control.
 * @param {{ envelope: import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot, storage: ReturnType<typeof makeFakeStorage>, rowCounts: Record<string, number> }} baseline
 */
async function assertByteIntact(baseline) {
	const db = await attachNetworkDb(baseline.envelope.networkHash, {
		expectedCounts: baseline.rowCounts,
		storage: baseline.storage,
	});
	const live = await readRowCounts(db, Object.keys(baseline.envelope.manifest));
	assert.deepEqual(live, baseline.rowCounts, 'row counts must be byte-intact after a failing outcome');
	await closeNetworkDb(db);

	const record = await readRowCountsRecord(baseline.envelope.networkHash, baseline.storage);
	assert.deepEqual(record?.counts, baseline.envelope.manifest, 'row-count record must be unchanged');

	const entry = findNetwork(baseline.envelope.networkHash, baseline.storage);
	assert.ok(entry, 'registry entry must still exist');
}

// ---------------------------------------------------------------------------
// Positive control
// ---------------------------------------------------------------------------

test('redeemAndBootstrap: a well-formed code with an ok transport and a verifying envelope commits ok, one DB, one row-count record, one registry entry', async () => {
	const envelope = buildFixtureEnvelope();
	await deleteNetworkDb(envelope.networkHash).catch(() => {});
	const storage = makeFakeStorage();
	const transport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: envelope } } });

	const result = await redeemAndBootstrap({ pastedCode: codeFor(envelope), transport, storage });
	assert.equal(result.outcome, 'ok');
	assert.ok(result.outcome === 'ok' && result.network.networkHash === envelope.networkHash);

	const record = await readRowCountsRecord(envelope.networkHash, storage);
	assert.deepEqual(record?.counts, envelope.manifest);
	assert.equal(record?.capturedAt.length, 19);
	assert.ok(!record?.capturedAt.includes('Z'));

	const entry = findNetwork(envelope.networkHash, storage);
	assert.ok(entry);
	assert.equal(entry?.bootstrappedAt.length, 19);
	assert.ok(!entry?.bootstrappedAt.includes('Z'));
	assert.equal(entry?.officerUserId, 'u1');
	assert.equal(entry?.authorityName, 'Fixture County Elections');

	await deleteNetworkDb(envelope.networkHash);
});

// ---------------------------------------------------------------------------
// invalid-code
// ---------------------------------------------------------------------------

test('redeemAndBootstrap: a badly-shaped code produces invalid-code and the transport records zero redeem calls', async () => {
	const storage = makeFakeStorage();
	const transport = makeFakeTransport({ codeToResult: {} });
	const result = await redeemAndBootstrap({ pastedCode: 'not-a-real-code', transport, storage });
	assert.equal(result.outcome, 'invalid-code');
	assert.equal(transport.calls.length, 0);
});

// ---------------------------------------------------------------------------
// code-refused (expired / used / unknown) -- distinguishable + byte-intact
// ---------------------------------------------------------------------------

test('redeemAndBootstrap: expired, used and unknown transport statuses all produce code-refused, distinguishably, and leave an existing network byte-intact', async () => {
	const baseline = await bootstrapFixtureNetwork();

	for (const status of /** @type {const} */ (['expired', 'used', 'unknown'])) {
		const corrupted = withDroppedRows(baseline.envelope, 'Registrant', 1);
		const transport = makeFakeTransport({ codeToResult: { [SECRET]: { status } } });
		const result = await redeemAndBootstrap({
			pastedCode: codeFor(corrupted),
			transport,
			storage: baseline.storage,
			replace: true,
		});
		assert.equal(result.outcome, 'code-refused');
		assert.ok(result.outcome === 'code-refused' && result.status === status);
		await assertByteIntact(baseline);
	}

	await deleteNetworkDb(baseline.envelope.networkHash);
});

// ---------------------------------------------------------------------------
// transport-unreachable
// ---------------------------------------------------------------------------

test('redeemAndBootstrap: a thrown transport error produces transport-unreachable, distinct from code-refused, and leaves an existing network byte-intact', async () => {
	const baseline = await bootstrapFixtureNetwork();
	const transport = makeFakeTransport({ codeToResult: { [SECRET]: new Error('network is down') } });
	const result = await redeemAndBootstrap({
		pastedCode: codeFor(baseline.envelope),
		transport,
		storage: baseline.storage,
		replace: true,
	});
	assert.equal(result.outcome, 'transport-unreachable');
	await assertByteIntact(baseline);
	await deleteNetworkDb(baseline.envelope.networkHash);
});

// ---------------------------------------------------------------------------
// verify-failed: digest-mismatch, manifest-mismatch, schema-hash-mismatch
// ---------------------------------------------------------------------------

test('redeemAndBootstrap: a digest half that does not match the envelope produces verify-failed/digest-mismatch, byte-intact', async () => {
	const baseline = await bootstrapFixtureNetwork();
	// Internally consistent envelope (digest matches its own content) but the
	// CODE's digest half is wrong.
	const transport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: baseline.envelope } } });
	const wrongDigestCode = `${SECRET}.${'z'.repeat(43)}`;
	const result = await redeemAndBootstrap({ pastedCode: wrongDigestCode, transport, storage: baseline.storage, replace: true });
	assert.equal(result.outcome, 'verify-failed');
	assert.ok(result.outcome === 'verify-failed' && result.reason === 'digest-mismatch');
	await assertByteIntact(baseline);
	await deleteNetworkDb(baseline.envelope.networkHash);
});

test('redeemAndBootstrap: rows dropped with an untouched manifest produces manifest-mismatch, NOT digest-mismatch, byte-intact', async () => {
	const baseline = await bootstrapFixtureNetwork();
	const truncated = withDroppedRows(baseline.envelope, 'Registrant', 1);
	const transport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: truncated } } });
	const result = await redeemAndBootstrap({ pastedCode: codeFor(baseline.envelope), transport, storage: baseline.storage, replace: true });
	assert.equal(result.outcome, 'verify-failed');
	assert.ok(result.outcome === 'verify-failed' && result.reason === 'manifest-mismatch');
	assert.notEqual(/** @type {any} */ (result).reason, 'digest-mismatch');
	await assertByteIntact(baseline);
	await deleteNetworkDb(baseline.envelope.networkHash);
});

test('redeemAndBootstrap: a mutated cell with counts unchanged produces digest-mismatch, byte-intact', async () => {
	const baseline = await bootstrapFixtureNetwork();
	const mutated = withMutatedCell(baseline.envelope, 'Registrant', 'PrivateCid');
	const transport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: mutated } } });
	const result = await redeemAndBootstrap({ pastedCode: codeFor(baseline.envelope), transport, storage: baseline.storage, replace: true });
	assert.equal(result.outcome, 'verify-failed');
	assert.ok(result.outcome === 'verify-failed' && result.reason === 'digest-mismatch');
	await assertByteIntact(baseline);
	await deleteNetworkDb(baseline.envelope.networkHash);
});

test('redeemAndBootstrap: a foreign schema hash produces schema-hash-mismatch even when the payload is ALSO truncated (order honoured), byte-intact', async () => {
	const baseline = await bootstrapFixtureNetwork();
	const truncated = withDroppedRows(baseline.envelope, 'Registrant', 1);
	const foreignAndTruncated = withForeignSchemaHash(truncated);
	const transport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: foreignAndTruncated } } });
	const result = await redeemAndBootstrap({
		pastedCode: codeFor(baseline.envelope),
		transport,
		storage: baseline.storage,
		replace: true,
	});
	assert.equal(result.outcome, 'verify-failed');
	assert.ok(result.outcome === 'verify-failed' && result.reason === 'schema-hash-mismatch');
	await assertByteIntact(baseline);
	await deleteNetworkDb(baseline.envelope.networkHash);
});

test('redeemAndBootstrap: a wrong format version produces verify-failed/format-version-mismatch', async () => {
	const baseline = await bootstrapFixtureNetwork();
	const wrongVersion = withWrongFormatVersion(baseline.envelope);
	const transport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: wrongVersion } } });
	const result = await redeemAndBootstrap({ pastedCode: codeFor(baseline.envelope), transport, storage: baseline.storage, replace: true });
	assert.equal(result.outcome, 'verify-failed');
	assert.ok(result.outcome === 'verify-failed' && result.reason === 'format-version-mismatch');
	await assertByteIntact(baseline);
	await deleteNetworkDb(baseline.envelope.networkHash);
});

// ---------------------------------------------------------------------------
// officer-indeterminate -- byte-intact
// ---------------------------------------------------------------------------

test('redeemAndBootstrap: a snapshot whose User table does not hold exactly one row produces officer-indeterminate, byte-intact', async () => {
	const baseline = await bootstrapFixtureNetwork();
	const twoUsers = withExtraUserRow(baseline.envelope);
	const transport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: twoUsers } } });
	const result = await redeemAndBootstrap({ pastedCode: codeFor(twoUsers), transport, storage: baseline.storage, replace: true });
	assert.equal(result.outcome, 'officer-indeterminate');
	await assertByteIntact(baseline);
	await deleteNetworkDb(baseline.envelope.networkHash);
});

// ---------------------------------------------------------------------------
// restore-incomplete -- writes neither record, NOT required to be byte-intact
// ---------------------------------------------------------------------------

test('redeemAndBootstrap: a restore that lands short of the manifest produces restore-incomplete and writes neither the row-count record nor the registry entry', async () => {
	const envelope = buildFixtureEnvelope();
	await deleteNetworkDb(envelope.networkHash).catch(() => {});
	const storage = makeFakeStorage();
	const collided = withCaseCollidingRegistrant(envelope);
	const transport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: collided } } });

	const result = await redeemAndBootstrap({ pastedCode: codeFor(collided), transport, storage });
	assert.equal(result.outcome, 'restore-incomplete');

	const record = await readRowCountsRecord(envelope.networkHash, storage);
	assert.equal(record, undefined);
	const entry = findNetwork(envelope.networkHash, storage);
	assert.equal(entry, undefined);

	// AND -- no orphan database is left behind. A schema-initialized,
	// partly-populated database with no registry entry is unreachable by every
	// cleanup path this app has (forgetNetwork throws UnknownNetworkError for
	// an unlisted hash), so the officer would have no way to remove the
	// registrant rows a failed bootstrap put in their browser. It also wedges
	// retries, because upserts cannot reduce a row count.
	const listed = await indexedDB.databases();
	assert.equal(
		listed.some((db) => db.name === dbNameFor(envelope.networkHash)),
		false,
		'a failed restore left an orphan IndexedDB database behind',
	);

	await deleteNetworkDb(envelope.networkHash);
});

test('redeemAndBootstrap: an envelope whose networkHash disagrees with its own Network.Hash row is refused as network-hash-mismatch', async () => {
	// The digest covers `tables` only, so on a FIRST bootstrap (no
	// expectedNetworkHash) `envelope.networkHash` is unauthenticated -- yet it
	// becomes the database name, the row-count key and the registry primary
	// key. This envelope carries the AUTHENTIC table content under a different
	// declared identity and verifies clean on digest, manifest and schema hash;
	// only the cross-check catches it.
	const authentic = buildFixtureEnvelope();
	const relabelled = buildSnapshot({
		networkHash: 'an-identity-the-tables-never-claimed',
		tables: authentic.tables,
		generatedAt: authentic.generatedAt,
	});
	assert.equal(relabelled.digest, authentic.digest, 'the relabelled envelope must be digest-identical, or this test proves nothing');

	const storage = makeFakeStorage();
	const transport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: relabelled } } });
	const result = await redeemAndBootstrap({ pastedCode: codeFor(relabelled), transport, storage });

	assert.equal(result.outcome, 'verify-failed');
	assert.equal(result.reason, 'network-hash-mismatch');
	assert.equal(findNetwork(relabelled.networkHash, storage), undefined);
	const listed = await indexedDB.databases();
	assert.equal(listed.some((db) => db.name === dbNameFor(relabelled.networkHash)), false);
});

test('positive control: the SAME fixture with its own matching networkHash bootstraps cleanly', async () => {
	const envelope = buildFixtureEnvelope();
	await deleteNetworkDb(envelope.networkHash).catch(() => {});
	const storage = makeFakeStorage();
	const transport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: envelope } } });
	const result = await redeemAndBootstrap({ pastedCode: codeFor(envelope), transport, storage });
	assert.equal(result.outcome, 'ok');
	await deleteNetworkDb(envelope.networkHash);
});

// ---------------------------------------------------------------------------
// already-bootstrapped / D-08 two networks
// ---------------------------------------------------------------------------

test('redeemAndBootstrap: redeeming for a networkHash already in the registry without replace produces already-bootstrapped and touches nothing', async () => {
	const baseline = await bootstrapFixtureNetwork();
	const transport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: baseline.envelope } } });
	const result = await redeemAndBootstrap({ pastedCode: codeFor(baseline.envelope), transport, storage: baseline.storage });
	assert.equal(result.outcome, 'already-bootstrapped');
	// 50-18: the outcome now names the network -- Bootstrap.tsx's
	// `onAlreadyBootstrapped` seam hands this straight to its caller without a
	// redundant transport replay just to read it back off the envelope.
	assert.ok(result.outcome === 'already-bootstrapped' && result.networkHash === baseline.envelope.networkHash);
	await assertByteIntact(baseline);
	await deleteNetworkDb(baseline.envelope.networkHash);
});

// ---------------------------------------------------------------------------
// 50-20: makeFakeTransport is single-use by default, mirroring the real
// backend's `{ status: 'used' }` response for a second redemption of the
// same secret (dashboard-signin-code.ts:391). A refusal is never consumed.
// ---------------------------------------------------------------------------

test('makeFakeTransport: single-use by default -- a second redeem of the SAME secret returns used, and calls.length is 2', async () => {
	const envelope = buildFixtureEnvelope();
	const transport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: envelope } } });

	const first = await transport.redeem(SECRET);
	assert.equal(first.status, 'ok');

	const second = await transport.redeem(SECRET);
	assert.equal(second.status, 'used');
	assert.equal(transport.calls.length, 2);
});

test('makeFakeTransport: negative control -- singleUse: false restores the old replay-forever behaviour, proving the flag above is load-bearing', async () => {
	const envelope = buildFixtureEnvelope();
	const transport = makeFakeTransport({
		codeToResult: { [SECRET]: { status: 'ok', snapshot: envelope } },
		singleUse: false,
	});

	const first = await transport.redeem(SECRET);
	assert.equal(first.status, 'ok');

	const second = await transport.redeem(SECRET);
	assert.equal(second.status, 'ok', 'with singleUse: false the second call must still replay ok');
	assert.equal(transport.calls.length, 2);
});

test('makeFakeTransport: a refused secret is never consumed -- it returns the SAME refusal on the first and second call', async () => {
	const transport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'expired' } } });

	const first = await transport.redeem(SECRET);
	assert.equal(first.status, 'expired');

	const second = await transport.redeem(SECRET);
	assert.equal(second.status, 'expired', 'a refusal must not be consumed by singleUse tracking');
	assert.equal(transport.calls.length, 2);
});

// ---------------------------------------------------------------------------
// 50-18/50-20 D-14: the classify-then-confirm seam, exercised at the function
// level -- Bootstrap.tsx wraps every transport in createSingleFlightTransport
// and hands the SAME instance to onAlreadyBootstrapped, so the whole
// classify-then-confirm sequence (an `already-bootstrapped` redemption,
// followed by a caller replaying the cached envelope) spends the single-use
// code exactly once. The inner transport is SINGLE-USE (50-20's new
// default), so this pair of tests can distinguish "handed off, not reset" --
// which must succeed -- from "reset before replay" -- which must fail
// exactly as production did before the handoff guard existed.
// ---------------------------------------------------------------------------

test('D-14 handoff: a HANDED-OFF single-flight cache is replayed by a caller without a reset in between, so the single-use inner transport is spent exactly once', async () => {
	const baseline = await bootstrapFixtureNetwork();
	const inner = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: baseline.envelope } } });
	const singleFlight = createSingleFlightTransport(inner);

	// The classify pass, exactly as Bootstrap.tsx's handleSubmit performs it.
	const result = await redeemAndBootstrap({
		pastedCode: codeFor(baseline.envelope),
		transport: singleFlight.transport,
		storage: baseline.storage,
	});
	assert.equal(result.outcome, 'already-bootstrapped');
	assert.equal(singleFlight.innerCallCount, 1);

	// A caller (DashboardShell) replays the SAME transport to recover the
	// verified envelope for classification -- this must NOT reach the wire a
	// second time. NO reset() call happens here: this is the handoff, and
	// Bootstrap.tsx's handedOffRef guard is what keeps its unmount cleanup
	// from calling it.
	// Replayed through `redeemSignInCode`, not the raw transport: the raw
	// result carries a SEALED wrapper (D-06), and the envelope only exists
	// above that seam. This asserts strictly more than the old raw-result
	// deepEqual did -- the replay must UNSEAL correctly with the same code's
	// key AND must not reach the wire a second time to do it.
	const replay = await redeemSignInCode(singleFlight.transport, SECRET);
	assert.equal(replay.status, 'ok');
	assert.deepEqual(replay.snapshot, baseline.envelope);
	assert.equal(singleFlight.innerCallCount, 1, 'innerCallCount must still be exactly 1 after the replay');
	assert.equal(inner.calls.length, 1, 'the underlying transport must have been called exactly once');

	await deleteNetworkDb(baseline.envelope.networkHash);
});

test('D-14 regression witness: the OLD production sequence -- classify, reset, then replay -- reaches the single-use inner transport a second time and comes back used, spending the code for nothing', async () => {
	const baseline = await bootstrapFixtureNetwork();
	const inner = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: baseline.envelope } } });
	const singleFlight = createSingleFlightTransport(inner);

	const result = await redeemAndBootstrap({
		pastedCode: codeFor(baseline.envelope),
		transport: singleFlight.transport,
		storage: baseline.storage,
	});
	assert.equal(result.outcome, 'already-bootstrapped');
	assert.equal(singleFlight.innerCallCount, 1);

	// This is what Bootstrap.tsx's unconditional unmount cleanup did BEFORE
	// the handedOffRef guard existed -- reset() between the classify and the
	// caller's replay, nulling the single-flight cache.
	singleFlight.reset();

	const replay = await singleFlight.transport.redeem(SECRET);
	assert.equal(replay.status, 'used', 'a reset before replay must fall through to the single-use inner transport, which is now spent');
	assert.equal(singleFlight.innerCallCount, 2, 'the reset forces a genuine second call to the inner transport');
	assert.equal(inner.calls.length, 2);

	await deleteNetworkDb(baseline.envelope.networkHash);
});

test('redeemAndBootstrap: codes for two different networks produce two databases and two registry entries (D-08)', async () => {
	const envelopeA = buildFixtureEnvelope();
	const envelopeB = buildFixtureEnvelopeForSecondNetwork();
	await deleteNetworkDb(envelopeA.networkHash).catch(() => {});
	await deleteNetworkDb(envelopeB.networkHash).catch(() => {});
	const storage = makeFakeStorage();

	const secretB = 'b'.repeat(40);
	const transport = makeFakeTransport({
		codeToResult: {
			[SECRET]: { status: 'ok', snapshot: envelopeA },
			[secretB]: { status: 'ok', snapshot: envelopeB },
		},
	});

	const resultA = await redeemAndBootstrap({ pastedCode: `${SECRET}.${envelopeA.digest}`, transport, storage });
	const resultB = await redeemAndBootstrap({ pastedCode: `${secretB}.${envelopeB.digest}`, transport, storage });
	assert.equal(resultA.outcome, 'ok');
	assert.equal(resultB.outcome, 'ok');

	const all = listNetworks(storage);
	assert.equal(all.length, 2);
	assert.deepEqual(
		new Set(all.map((e) => e.networkHash)),
		new Set([envelopeA.networkHash, envelopeB.networkHash]),
	);

	await deleteNetworkDb(envelopeA.networkHash);
	await deleteNetworkDb(envelopeB.networkHash);
});

/** A second, independent fixture network -- distinct networkHash from `buildFixtureEnvelope`,
 * rebuilt through `buildSnapshot` so digest/manifest/schemaHash stay internally consistent. */
function buildFixtureEnvelopeForSecondNetwork() {
	const base = buildFixtureEnvelope();
	const secondHash = `${base.networkHash}-2`;
	const tables = {
		...base.tables,
		Network: (base.tables.Network ?? []).map((row) => ({ ...row, Hash: secondHash })),
	};
	return buildSnapshot({ networkHash: secondHash, tables, generatedAt: base.generatedAt });
}

// ---------------------------------------------------------------------------
// copyKeysForOutcome totality
// ---------------------------------------------------------------------------

/** The three non-`ok` members of the closed redemption-status vocabulary --
 * the statuses `copyKeysForOutcome`'s `'code-refused'` arm is total over. */
const ALL_REFUSAL_STATUSES = /** @type {const} */ (['unknown', 'used', 'expired']);

const ALL_VERIFY_REASONS = /** @type {const} */ ([
	'malformed-envelope',
	'format-version-mismatch',
	'non-canonical-generated-at',
	'network-hash-mismatch',
	'schema-hash-mismatch',
	'manifest-mismatch',
	'digest-mismatch',
]);

test('copyKeysForOutcome: total over every non-"ok" outcome and every verify-failed reason -- every key resolves through t()', () => {
	for (const outcome of BOOTSTRAP_OUTCOME_CODES) {
		if (outcome === 'ok') continue; // "ok" renders the success state directly, not error copy.
		if (outcome === 'verify-failed') {
			for (const reason of ALL_VERIFY_REASONS) {
				const keys = copyKeysForOutcome(outcome, reason);
				assert.doesNotThrow(() => t(keys.headingKey));
				assert.doesNotThrow(() => t(keys.bodyKey));
				assert.doesNotThrow(() => t(keys.ctaKey));
			}
			continue;
		}
		if (outcome === 'code-refused') {
			// D-25: this outcome is the only one that carries a redemption
			// status, and it now REQUIRES one -- calling it bare throws by
			// design (pinned in `copy.test.mjs`, where the refusal-family
			// distinctness and machine-identifier assertions also live; they
			// are deliberately not duplicated here). Totality for this arm
			// means every non-`ok` status resolves.
			for (const status of ALL_REFUSAL_STATUSES) {
				const keys = copyKeysForOutcome(outcome, undefined, status);
				assert.doesNotThrow(() => t(keys.headingKey), `code-refused/${status} heading`);
				assert.doesNotThrow(() => t(keys.bodyKey), `code-refused/${status} body`);
				assert.doesNotThrow(() => t(keys.ctaKey), `code-refused/${status} cta`);
			}
			continue;
		}
		const keys = copyKeysForOutcome(outcome);
		assert.doesNotThrow(() => t(keys.headingKey));
		assert.doesNotThrow(() => t(keys.bodyKey));
		assert.doesNotThrow(() => t(keys.ctaKey));
	}
});

test('copyKeysForOutcome: throws naming the outcome for an unmapped value', () => {
	assert.throws(() => copyKeysForOutcome('not-a-real-outcome'), /unmapped outcome/);
});
