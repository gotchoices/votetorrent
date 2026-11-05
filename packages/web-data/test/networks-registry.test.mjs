/**
 * networks-registry.test.mjs -- tier-1 suite for the C-8 registry entry shape
 * in `src/networks-registry.js`: legacy entries read as not paired, the
 * pairing record round-trips and admits nothing bearer, `officerName` and
 * `lastPassAt` are validated, and `recordLastPassAt` never re-creates a
 * forgotten network.
 *
 * Every invalid-value case plants a random sentinel as the bad value where
 * the type allows and asserts the sentinel is absent from the error message:
 * errors name the field, never the value.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	NETWORKS_REGISTRY_KEY,
	InvalidNetworkRegistryError,
	PAIRING_RELAY_ADDRS_MAX,
	listNetworks,
	findNetwork,
	upsertNetwork,
	removeNetwork,
	isLegacyEntry,
	recordLastPassAt,
} from '../src/networks-registry.js';

/** A Map-backed storage fake that counts `setItem` calls. */
function makeStorage() {
	/** @type {Map<string, string>} */
	const map = new Map();
	const calls = { setItem: 0 };
	return {
		calls,
		getItem: (/** @type {string} */ key) => (map.has(key) ? /** @type {string} */ (map.get(key)) : null),
		setItem: (/** @type {string} */ key, /** @type {string} */ value) => {
			calls.setItem += 1;
			map.set(key, value);
		},
		removeItem: (/** @type {string} */ key) => {
			map.delete(key);
		},
	};
}

function sentinel() {
	return 'SENTINEL-' + Math.random().toString(36).slice(2, 12);
}

const LEGACY = Object.freeze({
	networkHash: 'net-legacy',
	authorityName: 'County L',
	domain: 'l.example',
	officerUserId: 'u-legacy',
	bootstrappedAt: '2026-01-01T00:00:00',
});

/** A base58btc-shaped 52-char identity peer id. */
const PEER_ID = '12D3KooW' + 'A1b2C3d4E5f6G7h8J9k1L2m3N4p5Q6r7S8t9U1v2W3x4'.slice(0, 44);

function pairing() {
	return {
		v: 1,
		requesterPeerId: PEER_ID,
		nonce: 'n0nce_-AbC123',
		expiresAt: '2026-11-03T10:15:00',
		keyPub: '02' + 'Ab'.repeat(32),
		sig: 'ab'.repeat(64),
		pairedAt: '2026-11-03T10:01:00',
		relayAddrs: ['/dns4/relay.example/tcp/443/wss/p2p/12D3KooWRelay', '/ip4/203.0.113.5/tcp/4001/p2p/12D3KooWRelay'],
		strandId: 'strand-abc123',
	};
}

function paired(overrides = {}) {
	return {
		networkHash: 'net-paired',
		authorityName: 'County P',
		domain: 'p.example',
		officerUserId: 'u-paired',
		pairing: pairing(),
		lastPassAt: 1_762_000_000_000,
		...overrides,
	};
}

/**
 * Assert `fn` throws InvalidNetworkRegistryError naming `field`, and that the
 * message carries no `secret`.
 * @param {() => unknown} fn
 * @param {string} field
 * @param {string} [secret]
 */
function assertRejects(fn, field, secret) {
	assert.throws(fn, (err) => {
		assert.ok(err instanceof InvalidNetworkRegistryError);
		assert.equal(/** @type {any} */ (err).field, field);
		if (secret) assert.equal(String(/** @type {any} */ (err).message).includes(secret), false);
		return true;
	});
}

test('R1: a stored legacy five-field entry reads back with pairing null and is legacy', () => {
	assert.equal(PEER_ID.length, 52);
	const storage = makeStorage();
	storage.setItem(NETWORKS_REGISTRY_KEY, JSON.stringify([LEGACY]));
	assert.deepEqual(listNetworks(storage), [{ ...LEGACY, pairing: null }]);
	const found = findNetwork('net-legacy', storage);
	assert.deepEqual(found, { ...LEGACY, pairing: null });
	assert.equal(isLegacyEntry(found), true);
	assert.equal(isLegacyEntry(undefined), false);
	assert.equal(isLegacyEntry(null), false);
	assert.equal(isLegacyEntry({ ...LEGACY }), true);
	assert.equal('lastPassAt' in /** @type {object} */ (found), false);
	assert.equal('officerName' in /** @type {object} */ (found), false);
	// A legacy entry written back with its explicit `pairing: null` is accepted.
	upsertNetwork(found, storage);
	assert.deepEqual(findNetwork('net-legacy', storage), { ...LEGACY, pairing: null });
});

test('R2: a paired entry round-trips exactly, with a fresh relay list and the peer id byte for byte', () => {
	const storage = makeStorage();
	const entry = paired();
	const returned = upsertNetwork(entry, storage);
	assert.deepEqual(returned, entry);
	const found = findNetwork('net-paired', storage);
	assert.deepEqual(found, entry);
	assert.equal(found?.pairing?.requesterPeerId, PEER_ID);
	assert.equal('bootstrappedAt' in /** @type {object} */ (found), false);
	assert.equal(isLegacyEntry(found), false);

	found?.pairing?.relayAddrs.push('/mutated');
	returned.pairing?.relayAddrs.push('/mutated');
	assert.notEqual(returned.pairing?.relayAddrs, entry.pairing.relayAddrs);
	assert.equal(findNetwork('net-paired', storage)?.pairing?.relayAddrs.length, 2);
	assert.equal(entry.pairing.relayAddrs.length, 2);
	assert.equal(PAIRING_RELAY_ADDRS_MAX, 16);
});

test('R3: an unknown top-level key or pairing key is rejected naming the key path, never the value', () => {
	const storage = makeStorage();
	const s1 = sentinel();
	assertRejects(() => upsertNetwork({ ...paired(), invitation: s1 }, storage), 'invitation', s1);
	const s2 = sentinel();
	assertRejects(() => upsertNetwork(paired({ pairing: { ...pairing(), invitation: s2 } }), storage), 'pairing.invitation', s2);
	const s3 = sentinel();
	assertRejects(() => upsertNetwork(paired({ pairing: { ...pairing(), joinCode: s3 } }), storage), 'pairing.joinCode', s3);
	// A stored blob with a smuggled key fails the same way on read.
	const s4 = sentinel();
	storage.setItem(NETWORKS_REGISTRY_KEY, JSON.stringify([{ ...paired(), joinCode: s4 }]));
	assertRejects(() => listNetworks(storage), 'joinCode', s4);
	assert.equal(storage.calls.setItem, 1);
});

test('R4: each malformed pairing field is rejected naming pairing.<field>, never the value', () => {
	const storage = makeStorage();
	/** @param {string} field @param {unknown} value @param {string} [secret] */
	const bad = (field, value, secret) =>
		assertRejects(
			() => upsertNetwork(paired({ pairing: { ...pairing(), [field]: value } }), storage),
			'pairing.' + field,
			secret,
		);
	/** @param {string} field */
	const missing = (field) => {
		const p = /** @type {Record<string, unknown>} */ (pairing());
		delete p[field];
		assertRejects(() => upsertNetwork(paired({ pairing: p }), storage), 'pairing.' + field);
	};

	bad('v', 2);
	bad('v', '1');
	missing('v');

	let s = sentinel();
	bad('nonce', '', undefined);
	bad('nonce', 'a'.repeat(65));
	bad('nonce', s + '!', s);
	missing('nonce');

	for (const field of ['expiresAt', 'pairedAt']) {
		s = sentinel();
		// One character past the canonical length (a bare sentinel is 19 characters).
		bad(field, s + 'x', s);
		bad(field, '2026-11-03T10:15:0Z');
		bad(field, 20260101);
		missing(field);
	}

	s = sentinel();
	bad('keyPub', s, s);
	bad('keyPub', '02' + 'ab'.repeat(31));
	bad('keyPub', 'zz' + 'ab'.repeat(32));
	missing('keyPub');

	s = sentinel();
	bad('sig', s, s);
	bad('sig', 'abc');
	bad('sig', '');
	bad('sig', 'ab'.repeat(81));
	missing('sig');

	s = sentinel();
	bad('relayAddrs', s, s);
	bad('relayAddrs', []);
	bad('relayAddrs', Array.from({ length: PAIRING_RELAY_ADDRS_MAX + 1 }, (_, i) => '/ip4/10.0.0.' + i));
	bad('relayAddrs', [s], s);
	bad('relayAddrs', [42]);
	bad('relayAddrs', ['/' + 'a'.repeat(1024)]);
	missing('relayAddrs');

	s = sentinel();
	bad('strandId', '');
	bad('strandId', 'a'.repeat(257));
	bad('strandId', 'strand ' + s, s);
	bad('strandId', 'strand\u0001x');
	missing('strandId');

	s = sentinel();
	missing('requesterPeerId');
	bad('requesterPeerId', 12345);
	bad('requesterPeerId', '');
	bad('requesterPeerId', 'P'.repeat(129));
	bad('requesterPeerId', '12D3 ' + s, s);
	bad('requesterPeerId', '12D3\u0007' + s, s);
	bad('requesterPeerId', '12D3é' + s, s);

	// Positive controls at the edges: these are accepted.
	upsertNetwork(paired({ pairing: { ...pairing(), keyPub: '04' + 'AB'.repeat(64) } }), storage);
	upsertNetwork(paired({ pairing: { ...pairing(), sig: 'ab'.repeat(72) } }), storage);
	upsertNetwork(paired({ pairing: { ...pairing(), requesterPeerId: '~'.repeat(128) } }), storage);
	upsertNetwork(paired({ pairing: { ...pairing(), relayAddrs: Array.from({ length: 16 }, (_, i) => '/ip4/10.0.0.' + i) } }), storage);
	assert.equal(findNetwork('net-paired', storage)?.pairing?.relayAddrs.length, 16);
});

test('R5: pairing null without bootstrappedAt is rejected, and the existing bootstrappedAt messages hold', () => {
	const storage = makeStorage();
	const { bootstrappedAt: _drop, ...noStamp } = LEGACY;
	assertRejects(() => upsertNetwork(noStamp, storage), 'bootstrappedAt');
	assertRejects(() => upsertNetwork({ ...noStamp, pairing: null }, storage), 'bootstrappedAt');
	assert.throws(
		() => upsertNetwork({ ...LEGACY, bootstrappedAt: '2026-01-01' }, storage),
		(err) => /19 characters/.test(/** @type {any} */ (err).message) && /** @type {any} */ (err).field === 'bootstrappedAt',
	);
	assert.throws(
		() => upsertNetwork({ ...LEGACY, bootstrappedAt: '2026-01-01T00:00:0Z' }, storage),
		(err) => /"Z"/.test(/** @type {any} */ (err).message) && /** @type {any} */ (err).field === 'bootstrappedAt',
	);
	// A paired entry may still carry a valid bootstrappedAt.
	const both = upsertNetwork(paired({ bootstrappedAt: '2026-01-01T00:00:00' }), storage);
	assert.equal(both.bootstrappedAt, '2026-01-01T00:00:00');
});

test('R6: lastPassAt accepts a non-negative safe integer and rejects anything else', () => {
	const storage = makeStorage();
	assert.equal(upsertNetwork(paired({ lastPassAt: 0 }), storage).lastPassAt, 0);
	assert.equal(upsertNetwork(paired({ lastPassAt: Number.MAX_SAFE_INTEGER }), storage).lastPassAt, Number.MAX_SAFE_INTEGER);
	for (const value of [-1, 1.5, '1762000000000', Number.MAX_SAFE_INTEGER + 2, Number.NaN, null]) {
		assertRejects(() => upsertNetwork(paired({ lastPassAt: value }), storage), 'lastPassAt');
	}
	const s = sentinel();
	assertRejects(() => upsertNetwork(paired({ lastPassAt: s }), storage), 'lastPassAt', s);
	upsertNetwork(LEGACY, storage);
	assert.equal('lastPassAt' in /** @type {object} */ (findNetwork('net-legacy', storage)), false);
});

test('R6b: officerName is trimmed, bounded, free of control characters, and absent stays absent', () => {
	const storage = makeStorage();
	assert.equal(upsertNetwork(paired({ officerName: '  Ana Pérez  ' }), storage).officerName, 'Ana Pérez');
	assert.equal(findNetwork('net-paired', storage)?.officerName, 'Ana Pérez');
	assert.equal(upsertNetwork(paired({ officerName: 'x'.repeat(200) }), storage).officerName?.length, 200);

	upsertNetwork(paired({ networkHash: 'net-noname' }), storage);
	assert.equal('officerName' in /** @type {object} */ (findNetwork('net-noname', storage)), false);
	upsertNetwork(LEGACY, storage);
	assert.equal('officerName' in /** @type {object} */ (findNetwork('net-legacy', storage)), false);

	assertRejects(() => upsertNetwork(paired({ officerName: 42 }), storage), 'officerName');
	assertRejects(() => upsertNetwork(paired({ officerName: '   ' }), storage), 'officerName');
	let s = sentinel();
	assertRejects(() => upsertNetwork(paired({ officerName: ' ' + s + 'y'.repeat(201 - s.length) + ' ' }), storage), 'officerName', s);
	s = sentinel();
	assertRejects(() => upsertNetwork(paired({ officerName: s + '\u0007' }), storage), 'officerName', s);
	s = sentinel();
	assertRejects(() => upsertNetwork(paired({ officerName: s + '\u007f' }), storage), 'officerName', s);

	upsertNetwork(paired({ officerName: 'Ana Pérez', lastPassAt: 10 }), storage);
	assert.equal(recordLastPassAt('net-paired', 20, storage)?.officerName, 'Ana Pérez');
});

test('R7: recordLastPassAt moves forward on a paired entry only, and never writes for an absent or legacy entry', () => {
	const storage = makeStorage();
	upsertNetwork(paired({ networkHash: 'net-first', lastPassAt: 100 }), storage);
	upsertNetwork(paired({ lastPassAt: 100 }), storage);
	upsertNetwork(paired({ networkHash: 'net-last', lastPassAt: undefined }), storage);
	upsertNetwork(LEGACY, storage);
	const before = storage.calls.setItem;

	const updated = recordLastPassAt('net-paired', 200, storage);
	assert.equal(updated?.lastPassAt, 200);
	assert.deepEqual(updated?.pairing, pairing());
	assert.equal(storage.calls.setItem, before + 1);
	assert.deepEqual(
		listNetworks(storage).map((e) => e.networkHash),
		['net-first', 'net-paired', 'net-last', 'net-legacy'],
	);

	const unchanged = recordLastPassAt('net-paired', 150, storage);
	assert.equal(unchanged?.lastPassAt, 200);
	assert.equal(recordLastPassAt('net-paired', 200, storage)?.lastPassAt, 200);
	assert.equal(storage.calls.setItem, before + 1);

	// An entry with no lastPassAt yet takes the first value.
	assert.equal(recordLastPassAt('net-last', 5, storage)?.lastPassAt, 5);
	assert.equal(storage.calls.setItem, before + 2);

	assert.equal(recordLastPassAt('net-forgotten', 300, storage), undefined);
	assert.equal(recordLastPassAt('net-legacy', 300, storage), undefined);
	assert.equal(storage.calls.setItem, before + 2);
	assert.equal(findNetwork('net-forgotten', storage), undefined);
	assert.equal('lastPassAt' in /** @type {object} */ (findNetwork('net-legacy', storage)), false);

	removeNetwork('net-paired', storage);
	const afterRemove = storage.calls.setItem;
	assert.equal(recordLastPassAt('net-paired', 400, storage), undefined);
	assert.equal(storage.calls.setItem, afterRemove);
	assert.equal(findNetwork('net-paired', storage), undefined);

	assertRejects(() => recordLastPassAt('net-last', -1, storage), 'lastPassAt');
	assertRejects(() => recordLastPassAt('net-last', /** @type {any} */ ('7'), storage), 'lastPassAt');
});

test('R8: a paired upsert over a legacy entry replaces it in place, and two networks coexist', () => {
	const storage = makeStorage();
	upsertNetwork({ ...LEGACY, networkHash: 'net-a', officerUserId: 'u-old' }, storage);
	upsertNetwork({ ...LEGACY, networkHash: 'net-b' }, storage);
	assert.equal(isLegacyEntry(findNetwork('net-a', storage)), true);

	upsertNetwork(paired({ networkHash: 'net-a', officerUserId: 'u-new' }), storage);
	const all = listNetworks(storage);
	assert.deepEqual(all.map((e) => e.networkHash), ['net-a', 'net-b']);
	assert.equal(all.filter((e) => e.networkHash === 'net-a').length, 1);
	assert.equal(all[0].officerUserId, 'u-new');
	assert.equal(isLegacyEntry(all[0]), false);
	assert.equal(isLegacyEntry(all[1]), true);
	assert.equal('bootstrappedAt' in all[0], false);
});
