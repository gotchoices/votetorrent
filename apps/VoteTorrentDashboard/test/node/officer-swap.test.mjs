/**
 * Tier-1 coverage of `src/lifecycle/officer-swap.js`'s pairing-era
 * classifier (`classifyPairing`, D-09) and the module's entry-chunk import
 * rule.
 *
 * `classifyPairing` is pure: the registry fakes below are plain objects, but
 * `isLegacyEntry` is the REAL web-data function, so the kinds follow the
 * registry's own entry shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';
import { isLegacyEntry } from '@votetorrent/web-data/officer';
import { PAIRING_KINDS, classifyPairing } from '../../src/lifecycle/officer-swap.js';

const OFFICER_SWAP_PATH = fileURLToPath(new URL('../../src/lifecycle/officer-swap.js', import.meta.url));

const HASH = 'networkhashabc';
const OFFICER_A = 'officer-a';
const OFFICER_B = 'officer-b';

/**
 * A paired (live) registry entry, shaped per the registry's C-8 record.
 *
 * @param {string} officerUserId
 */
function pairedEntry(officerUserId) {
	return {
		networkHash: HASH,
		authorityName: 'Authority',
		domain: 'example.org',
		officerUserId,
		pairing: {
			v: 1,
			requesterPeerId: '12D3KooWExamplePeerIdAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
			nonce: 'nonce1',
			expiresAt: '2026-11-03T10:15:00',
			keyPub: '02' + 'a'.repeat(64),
			sig: 'ab'.repeat(64),
			pairedAt: '2026-11-03T10:01:00',
			relayAddrs: ['/dns4/relay.example/tcp/443/wss/p2p/12D3KooWRelay'],
			strandId: HASH,
		},
	};
}

/**
 * A legacy (snapshot-era) registry entry: no pairing record.
 *
 * @param {string} officerUserId
 */
function legacyEntry(officerUserId) {
	return {
		networkHash: HASH,
		authorityName: 'Authority',
		domain: 'example.org',
		officerUserId,
		bootstrappedAt: '2026-10-01T10:00:00',
		pairing: null,
	};
}

/** @param {unknown} entry */
function registryHolding(entry) {
	return {
		findNetwork: (/** @type {string} */ hash) => (hash === HASH ? entry : undefined),
		isLegacyEntry,
	};
}

// ---------------------------------------------------------------------------
// classifyPairing (D-09)
// ---------------------------------------------------------------------------

test('classifyPairing S1: no registry entry is new-network', () => {
	assert.equal(classifyPairing({ networkHash: HASH, claimedUserId: OFFICER_A, registry: registryHolding(undefined) }), 'new-network');
	assert.equal(classifyPairing({ networkHash: HASH, claimedUserId: OFFICER_A, registry: registryHolding(null) }), 'new-network');
});

test('classifyPairing S2: a legacy entry is legacy-replace whether or not its officer matches', () => {
	assert.equal(
		classifyPairing({ networkHash: HASH, claimedUserId: OFFICER_A, registry: registryHolding(legacyEntry(OFFICER_A)) }),
		'legacy-replace',
	);
	assert.equal(
		classifyPairing({ networkHash: HASH, claimedUserId: OFFICER_B, registry: registryHolding(legacyEntry(OFFICER_A)) }),
		'legacy-replace',
	);
});

test('classifyPairing S3: a paired entry with the same officer is same-officer', () => {
	assert.equal(
		classifyPairing({ networkHash: HASH, claimedUserId: OFFICER_A, registry: registryHolding(pairedEntry(OFFICER_A)) }),
		'same-officer',
	);
});

test('classifyPairing S4: a paired entry with a different officer is officer-swap', () => {
	assert.equal(
		classifyPairing({ networkHash: HASH, claimedUserId: OFFICER_B, registry: registryHolding(pairedEntry(OFFICER_A)) }),
		'officer-swap',
	);
});

test('classifyPairing S5: bad arguments throw TypeError with value-free messages', () => {
	const SENTINEL = 'SENTINEL-officer-swap-7f3a';
	const registry = registryHolding(undefined);
	/** @type {Array<unknown>} */
	const badCalls = [
		{ networkHash: '', claimedUserId: SENTINEL, registry },
		{ networkHash: 42, claimedUserId: SENTINEL, registry },
		{ networkHash: SENTINEL, claimedUserId: '', registry },
		{ networkHash: SENTINEL, claimedUserId: { id: SENTINEL }, registry },
		{ networkHash: SENTINEL, claimedUserId: SENTINEL, registry: null },
		{ networkHash: SENTINEL, claimedUserId: SENTINEL, registry: { findNetwork: () => SENTINEL } },
		{ networkHash: SENTINEL, claimedUserId: SENTINEL, registry: { isLegacyEntry } },
		undefined,
	];
	for (const args of badCalls) {
		assert.throws(
			() => classifyPairing(/** @type {any} */ (args)),
			(/** @type {unknown} */ err) => {
				assert.ok(err instanceof TypeError);
				assert.equal(err.message.includes(SENTINEL), false);
				return true;
			},
		);
	}
});

test('classifyPairing S6: PAIRING_KINDS is frozen and lists the four kinds in table order', () => {
	assert.equal(Object.isFrozen(PAIRING_KINDS), true);
	assert.deepEqual([...PAIRING_KINDS], ['new-network', 'same-officer', 'officer-swap', 'legacy-replace']);
});

/** Import specifiers that would pull the peer stack into the entry chunk. */
const PEER_IMPORT_RE = /\bfrom\s*['"](\.\.\/peer\/|@serfab\/|@libp2p\/|@optimystic\/)|\bimport\s*\(\s*['"](\.\.\/peer\/|@serfab\/|@libp2p\/|@optimystic\/)|\bimport\s+['"](\.\.\/peer\/|@serfab\/|@libp2p\/|@optimystic\/)/;

test('classifyPairing S7: officer-swap.js imports nothing from the peer layer (comment-stripped)', () => {
	const source = stripComments(readFileSync(OFFICER_SWAP_PATH, 'utf8'));
	assert.equal(PEER_IMPORT_RE.test(source), false);
});

test('positive control: the peer-import matcher fires on synthetic peer imports', () => {
	assert.match("import { x } from '../peer/pairing.js';", PEER_IMPORT_RE);
	assert.match("const m = await import('@serfab/cadre-core');", PEER_IMPORT_RE);
	assert.match("import '@libp2p/websockets';", PEER_IMPORT_RE);
	assert.doesNotMatch("import { findNetwork } from '@votetorrent/web-data/officer';", PEER_IMPORT_RE);
});
