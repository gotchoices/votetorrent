/**
 * Tier-1 reason-asserting coverage of the D-13 code split
 * (`src/transport/bootstrap-transport-client.js`) and the D-08/D-10 network
 * registry (`@votetorrent/web-data`'s `networks-registry.js`, moved out of
 * this workspace's own `src/db/` by 54-03a). Every negative is paired, in the
 * SAME test, with a positive control -- this project's rule, and the one
 * that was violated twice on 2026-08-25.
 *
 * `node:test` + `node:assert/strict`, one `test()` per behaviour (spike 076's
 * idiom). No `fake-indexeddb` import -- nothing in this task touches
 * IndexedDB, and importing it would imply a persistence claim this tier
 * cannot make.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	SIGNIN_CODE_PATTERN,
	InvalidSignInCodeError,
	BootstrapTransportUnreachableError,
	SealedPayloadUnreadableError,
	splitSignInCode,
	secretToKeySplit,
	createRestBootstrapTransport,
	redeemSignInCode,
} from '../../src/transport/bootstrap-transport-client.js';
import { sealPayload } from '@votetorrent/vote-engine/bootstrap';
import {
	NETWORKS_REGISTRY_KEY,
	InvalidNetworkRegistryError,
	listNetworks,
	findNetwork,
	upsertNetwork,
	removeNetwork,
} from '@votetorrent/web-data/officer';

const SECRET = 'a'.repeat(40);
const DIGEST = 'b'.repeat(43);
const VALID_CODE = `${SECRET}.${DIGEST}`;

const PII_CANARY = 'PII-CANARY-9f3a';

// Four DISTINCT 40-lowercase-hex secrets, plus two more for the negative
// cases. The shape is required, not cosmetic: `redeemSignInCode` derives the
// D-04 key split from the secret before it calls anything, so a placeholder
// like `'secret-ok'` can no longer reach a transport at all.
const SECRET_OK = 'a1'.repeat(20);
const SECRET_EXPIRED = 'b2'.repeat(20);
const SECRET_USED = 'c3'.repeat(20);
const SECRET_UNKNOWN = 'd4'.repeat(20);
const SECRET_BOOM = 'e5'.repeat(20);
const SECRET_OTHER = 'f6'.repeat(20);

/** A structurally valid envelope, carrying the PII canary in a table row so a
 * leak of decrypted content into an error message would be visible. */
const CANARY_ENVELOPE = {
	formatVersion: 1,
	networkHash: 'n1',
	schemaHash: 'fake-schema-hash',
	generatedAt: '2026-01-01T00:00:00',
	manifest: { Registrant: 1 },
	digest: 'fake-digest',
	tables: { Registrant: [{ Id: 'r1', Name: PII_CANARY }] },
};

/**
 * Build an `ok` transport result whose payload is sealed under `sealingSecret`
 * -- which is normally the same secret the consumer will redeem with, and
 * deliberately a DIFFERENT one in the wrong-key case below. Seals through the
 * production `secretToKeySplit`, so the two sides cannot drift.
 * @param {string} sealingSecret
 * @param {Record<string, unknown>} envelope
 * @returns {{ status: 'ok', sealed: import('@votetorrent/vote-engine/bootstrap').SealedPayload }}
 */
function sealedOk(sealingSecret, envelope = CANARY_ENVELOPE) {
	return {
		status: 'ok',
		sealed: sealPayload(JSON.stringify(envelope), secretToKeySplit(sealingSecret)),
	};
}

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
 * An in-memory `IBootstrapTransport`-shaped double. `redeem` returns the
 * caller-supplied result for a matching secret, or throws when the result is
 * an `Error` instance -- covering both the refusal path and the thrown
 * transport-failure path with one shape.
 *
 * The results it is handed are ALREADY SEALED (see `sealedOk`), because under
 * D-06 that is what a courier carries: the double is a courier and never
 * holds plaintext, exactly like the two real bindings.
 * @param {Record<string, import('@votetorrent/vote-engine/bootstrap').BootstrapRedemptionResult | Error>} codeToResult
 * @returns {import('@votetorrent/vote-engine/bootstrap').IBootstrapTransport & { calls: string[] }}
 */
function makeFakeTransport(codeToResult) {
	/** @type {string[]} */
	const calls = [];
	return {
		calls,
		/** @param {string} code */
		async redeem(code) {
			calls.push(code);
			const result = codeToResult[code];
			if (result instanceof Error) throw result;
			return result ?? { status: 'unknown' };
		},
	};
}

// ---------------------------------------------------------------------------
// splitSignInCode
// ---------------------------------------------------------------------------

test('SIGNIN_CODE_PATTERN: matches a well-formed code and rejects a malformed one', () => {
	assert.equal(SIGNIN_CODE_PATTERN.test(VALID_CODE), true);
	assert.equal(SIGNIN_CODE_PATTERN.test('not-a-code'), false);
});

test('splitSignInCode: a well-formed code splits into the correct, non-transposed halves', () => {
	const { secret, expectedDigest } = splitSignInCode(VALID_CODE);
	assert.equal(secret, SECRET);
	assert.equal(expectedDigest, DIGEST);
	assert.match(secret, /^[0-9a-f]{40}$/);
	assert.match(expectedDigest, /^[A-Za-z0-9_-]{43}$/);
});

test('splitSignInCode: trims surrounding whitespace but keeps the halves correct (positive control for internal-whitespace rejection)', () => {
	const { secret, expectedDigest } = splitSignInCode(`  ${VALID_CODE}  `);
	assert.equal(secret, SECRET);
	assert.equal(expectedDigest, DIGEST);
});

test('splitSignInCode: rejects internal whitespace, naming the rule -- paired with the trimmed positive control above', () => {
	assert.throws(
		() => splitSignInCode(`${SECRET} .${DIGEST}`),
		(err) => {
			assert.ok(err instanceof InvalidSignInCodeError);
			assert.equal(err.name, 'InvalidSignInCodeError');
			assert.match(err.message, /internal whitespace/);
			return true;
		},
	);
});

test('splitSignInCode: rejects an empty or whitespace-only string', () => {
	for (const bad of ['', '   ']) {
		assert.throws(
			() => splitSignInCode(bad),
			(err) => {
				assert.ok(err instanceof InvalidSignInCodeError);
				assert.match(err.message, /empty/);
				return true;
			},
		);
	}
});

test('splitSignInCode: no dot -- rejected naming the separator rule, paired with the valid code succeeding', () => {
	assert.throws(
		() => splitSignInCode(SECRET + DIGEST),
		(err) => {
			assert.ok(err instanceof InvalidSignInCodeError);
			assert.match(err.message, /exactly one "\." separator/);
			assert.match(err.message, /found 0/);
			return true;
		},
	);
	assert.deepEqual(splitSignInCode(VALID_CODE), { secret: SECRET, expectedDigest: DIGEST });
});

test('splitSignInCode: two or more dots -- rejected naming the separator rule', () => {
	assert.throws(
		() => splitSignInCode(`${SECRET}.${DIGEST}.extra`),
		(err) => {
			assert.ok(err instanceof InvalidSignInCodeError);
			assert.match(err.message, /exactly one "\." separator/);
			assert.match(err.message, /found 2/);
			return true;
		},
	);
});

test('splitSignInCode: short/non-hex secret half -- rejected naming the SECRET half and its rule, paired with a well-formed code', () => {
	for (const badSecret of ['a'.repeat(39), 'g'.repeat(40), 'A'.repeat(40)]) {
		assert.throws(
			() => splitSignInCode(`${badSecret}.${DIGEST}`),
			(err) => {
				assert.ok(err instanceof InvalidSignInCodeError);
				assert.match(err.message, /secret half/);
				assert.match(err.message, /40 lowercase hex/);
				return true;
			},
		);
	}
	assert.deepEqual(splitSignInCode(VALID_CODE), { secret: SECRET, expectedDigest: DIGEST });
});

test('splitSignInCode: wrong-length or non-base64url digest half -- rejected naming the DIGEST half and its rule', () => {
	for (const badDigest of ['b'.repeat(42), 'b'.repeat(44), '#'.repeat(43)]) {
		assert.throws(
			() => splitSignInCode(`${SECRET}.${badDigest}`),
			(err) => {
				assert.ok(err instanceof InvalidSignInCodeError);
				assert.match(err.message, /digest half/);
				assert.match(err.message, /43 base64url/);
				return true;
			},
		);
	}
});

test('splitSignInCode: PII hygiene -- forcing every rejection path with a canary-laden code never leaks the canary', () => {
	const canaryCases = [
		`${PII_CANARY}`,
		`${PII_CANARY}.${DIGEST}`,
		`${SECRET}.${PII_CANARY}`,
		`${SECRET} ${PII_CANARY}.${DIGEST}`,
	];
	for (const code of canaryCases) {
		assert.throws(
			() => splitSignInCode(code),
			/** @param {any} err */
			(err) => {
				assert.ok(!String(err.message).includes(PII_CANARY));
				return true;
			},
		);
	}
});

// ---------------------------------------------------------------------------
// createRestBootstrapTransport / redeemSignInCode
// ---------------------------------------------------------------------------

test('createRestBootstrapTransport: requires an explicit non-empty baseUrl', () => {
	assert.throws(() => createRestBootstrapTransport({ baseUrl: '' }), TypeError);
	const transport = createRestBootstrapTransport({ baseUrl: 'https://bootstrap.example.org' });
	assert.equal(typeof transport.redeem, 'function');
});

test('redeemSignInCode: returns every one of the four transport statuses distinctly (no collapsing), unsealing the ok payload', async () => {
	const transport = makeFakeTransport({
		[SECRET_OK]: sealedOk(SECRET_OK),
		[SECRET_EXPIRED]: { status: 'expired' },
		[SECRET_USED]: { status: 'used' },
		[SECRET_UNKNOWN]: { status: 'unknown' },
	});
	const ok = await redeemSignInCode(transport, SECRET_OK);
	assert.equal(ok.status, 'ok');
	// The sealed wrapper became a plaintext envelope ABOVE the seam -- this is
	// the D-06 consumer step, and it is the only place in the dashboard that
	// performs it.
	assert.equal(ok.snapshot?.networkHash, 'n1');
	assert.equal((await redeemSignInCode(transport, SECRET_EXPIRED)).status, 'expired');
	assert.equal((await redeemSignInCode(transport, SECRET_USED)).status, 'used');
	assert.equal((await redeemSignInCode(transport, SECRET_UNKNOWN)).status, 'unknown');
});

test('redeemSignInCode: a malformed secret is refused BEFORE the transport is reached -- the double records no call', async () => {
	// Positive control: the four-status test above proves a well-formed secret
	// DOES reach this same double.
	const transport = makeFakeTransport({ [SECRET_OK]: sealedOk(SECRET_OK) });
	for (const bad of ['not-40-hex', 'A1'.repeat(20), 'a1'.repeat(19), PII_CANARY]) {
		await assert.rejects(
			() => redeemSignInCode(transport, bad),
			(err) => {
				assert.ok(err instanceof InvalidSignInCodeError);
				assert.equal(err.name, 'InvalidSignInCodeError');
				assert.ok(!err.message.includes(bad), 'the refusal must not echo the rejected secret');
				assert.ok(!err.message.includes(PII_CANARY));
				return true;
			},
		);
	}
	assert.equal(transport.calls.length, 0, 'a malformed secret must never reach the transport');
});

test('redeemSignInCode: a payload sealed under a DIFFERENT secret raises SealedPayloadUnreadableError, leaking neither secret, no ciphertext run, and no PII', async () => {
	const wrongKeyed = sealedOk(SECRET_OTHER);
	const transport = makeFakeTransport({
		[SECRET_OK]: wrongKeyed,
		// Positive control in the same double: correctly sealed under its own
		// secret, this opens.
		[SECRET_USED]: sealedOk(SECRET_USED),
	});

	const control = await redeemSignInCode(transport, SECRET_USED);
	assert.equal(control.status, 'ok');
	assert.equal(control.snapshot?.networkHash, 'n1');

	await assert.rejects(
		() => redeemSignInCode(transport, SECRET_OK),
		(err) => {
			assert.ok(err instanceof SealedPayloadUnreadableError);
			assert.equal(err.name, 'SealedPayloadUnreadableError');
			// It is distinguishable from BOTH neighbours by class.
			assert.ok(!(err instanceof BootstrapTransportUnreachableError));
			assert.ok(!(err instanceof InvalidSignInCodeError));
			// Neither secret.
			assert.ok(!err.message.includes(SECRET_OK));
			assert.ok(!err.message.includes(SECRET_OTHER));
			// No base64url run from the wrapper -- neither nonce nor ciphertext.
			assert.ok(!err.message.includes(wrongKeyed.sealed.nonce));
			assert.ok(!err.message.includes(wrongKeyed.sealed.ciphertext.slice(0, 12)));
			// No registrant content.
			assert.ok(!err.message.includes(PII_CANARY));
			// It DOES name the structural reason -- the whole point of the class.
			assert.match(err.message, /authentication-failed/);
			return true;
		},
	);
});

test('redeemSignInCode: a thrown transport error becomes BootstrapTransportUnreachableError, naming neither the secret nor any payload', async () => {
	const transport = makeFakeTransport({
		[SECRET_BOOM]: new Error(`upstream failure containing ${PII_CANARY} and the secret ${SECRET_BOOM}`),
	});
	await assert.rejects(
		() => redeemSignInCode(transport, SECRET_BOOM),
		(err) => {
			assert.ok(err instanceof BootstrapTransportUnreachableError);
			assert.equal(err.name, 'BootstrapTransportUnreachableError');
			assert.ok(!err.message.includes(SECRET_BOOM));
			assert.ok(!err.message.includes(PII_CANARY));
			return true;
		},
	);
});

// ---------------------------------------------------------------------------
// networks-registry.js
// ---------------------------------------------------------------------------

const ENTRY_A = {
	networkHash: 'net-a',
	authorityName: 'County A',
	domain: 'a.example',
	officerUserId: 'u-a',
	bootstrappedAt: '2026-01-01T00:00:00',
};
const ENTRY_B = {
	networkHash: 'net-b',
	authorityName: 'County B',
	domain: 'b.example',
	officerUserId: 'u-b',
	bootstrappedAt: '2026-01-02T00:00:00',
};

test('listNetworks: absent, empty-string and non-array storage content all return [] without throwing', () => {
	const storage = makeFakeStorage();
	assert.deepEqual(listNetworks(storage), []);

	storage.setItem(NETWORKS_REGISTRY_KEY, '');
	assert.deepEqual(listNetworks(storage), []);

	storage.setItem(NETWORKS_REGISTRY_KEY, JSON.stringify({ not: 'an array' }));
	assert.deepEqual(listNetworks(storage), []);
});

test('listNetworks: a syntactically valid array with a structurally wrong entry throws, naming the field -- paired with a valid entry succeeding', () => {
	const storage = makeFakeStorage();
	storage.setItem(NETWORKS_REGISTRY_KEY, JSON.stringify([{ networkHash: 'x' }]));
	assert.throws(
		() => listNetworks(storage),
		(err) => {
			assert.ok(err instanceof InvalidNetworkRegistryError);
			assert.equal(err.name, 'InvalidNetworkRegistryError');
			return true;
		},
	);

	const goodStorage = makeFakeStorage();
	goodStorage.setItem(NETWORKS_REGISTRY_KEY, JSON.stringify([ENTRY_A]));
	// Legacy entries read back as not paired (C-8).
	assert.deepEqual(listNetworks(goodStorage), [{ ...ENTRY_A, pairing: null }]);
});

test('upsertNetwork: appends a new networkHash and two different hashes coexist (D-08)', () => {
	const storage = makeFakeStorage();
	upsertNetwork(ENTRY_A, storage);
	upsertNetwork(ENTRY_B, storage);
	const all = listNetworks(storage);
	assert.equal(all.length, 2);
	assert.deepEqual(new Set(all.map((e) => e.networkHash)), new Set(['net-a', 'net-b']));
});

test('upsertNetwork: replaces an existing networkHash IN PLACE, preserving sibling order', () => {
	const storage = makeFakeStorage();
	upsertNetwork(ENTRY_A, storage);
	upsertNetwork(ENTRY_B, storage);
	const replacedA = { ...ENTRY_A, authorityName: 'County A Renamed' };
	upsertNetwork(replacedA, storage);
	const all = listNetworks(storage);
	assert.equal(all.length, 2);
	assert.equal(all[0].networkHash, 'net-a');
	assert.equal(all[0].authorityName, 'County A Renamed');
	assert.equal(all[1].networkHash, 'net-b');
});

test('upsertNetwork: rejects a bootstrappedAt that is not 19 characters or that contains a Z, naming the field -- paired with a canonical value', () => {
	const storage = makeFakeStorage();
	// Exactly 19 characters, but carries a "Z" -- isolates the Z-rejection
	// rule from the length rule (below), which a 20-character Z-suffixed
	// value would trip first.
	assert.throws(
		() => upsertNetwork({ ...ENTRY_A, bootstrappedAt: '2026-01-01T00:00:0Z' }, storage),
		(err) => {
			assert.ok(err instanceof InvalidNetworkRegistryError);
			assert.equal(err.field, 'bootstrappedAt');
			assert.match(err.message, /"Z"/);
			return true;
		},
	);
	assert.throws(
		() => upsertNetwork({ ...ENTRY_A, bootstrappedAt: '2026-01-01' }, storage),
		(err) => {
			assert.ok(err instanceof InvalidNetworkRegistryError);
			assert.equal(err.field, 'bootstrappedAt');
			assert.match(err.message, /19 characters/);
			return true;
		},
	);
	// Positive control: a nowCanonicalDatetime()-shaped value is accepted.
	const accepted = upsertNetwork(ENTRY_A, storage);
	assert.equal(accepted.bootstrappedAt, ENTRY_A.bootstrappedAt);
});

test('findNetwork: resolves an existing entry and returns undefined for an unknown hash', () => {
	const storage = makeFakeStorage();
	upsertNetwork(ENTRY_A, storage);
	// Legacy entries read back as not paired (C-8).
	assert.deepEqual(findNetwork('net-a', storage), { ...ENTRY_A, pairing: null });
	assert.equal(findNetwork('net-nonexistent', storage), undefined);
});

test('removeNetwork: removes the named entry and leaves the others untouched; a no-op on an unknown hash', () => {
	const storage = makeFakeStorage();
	upsertNetwork(ENTRY_A, storage);
	upsertNetwork(ENTRY_B, storage);

	removeNetwork('net-nonexistent', storage);
	assert.equal(listNetworks(storage).length, 2);

	removeNetwork('net-a', storage);
	const remaining = listNetworks(storage);
	assert.equal(remaining.length, 1);
	assert.equal(remaining[0].networkHash, 'net-b');
});

test('PII hygiene: registry validation errors never leak canary-laden field values', () => {
	const storage = makeFakeStorage();
	assert.throws(
		() =>
			upsertNetwork(
				{ ...ENTRY_A, authorityName: PII_CANARY, bootstrappedAt: `${PII_CANARY}ZZZZZZZZZZZZZZZZZZ` },
				storage,
			),
		/** @param {any} err */
		(err) => {
			assert.ok(!String(err.message).includes(PII_CANARY));
			return true;
		},
	);
	storage.setItem(NETWORKS_REGISTRY_KEY, JSON.stringify([{ ...ENTRY_A, domain: PII_CANARY, extraField: PII_CANARY }]));
	assert.throws(
		() => listNetworks(storage),
		/** @param {any} err */
		(err) => {
			assert.ok(!String(err.message).includes(PII_CANARY));
			return true;
		},
	);
});
