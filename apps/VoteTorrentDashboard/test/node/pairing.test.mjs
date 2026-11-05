/**
 * Tier-1 coverage of `src/peer/pairing.js`: the per-pass pairing check (D-27) with a real-crypto
 * proof, the closed failure and phase sets, the module's hygiene scans, and `pairBrowser` end to
 * end over a fake world (real pairing, join and invitation codecs; injected node, reader, stores,
 * clock and sleep).
 *
 * Every collaborator is injected; no real timer, network or IndexedDB is involved except where a
 * case says so. No test title carries a value.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { Database } from '@quereus/quereus';
import { p256 } from '@noble/curves/nist.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { encodeCadreInvitation } from '@serfab/cadre-core';
import {
	registerDbPlugins,
	toCanonicalDatetime,
	fromCanonicalDatetime,
	computeContentDigest,
} from '@votetorrent/vote-engine/browser';
import { pairingStatementDigest, encodeNetworkJoinCode, encodePairingCode } from '@votetorrent/vote-engine';
import {
	findNetwork,
	upsertNetwork,
	removeNetwork,
	dbNameFor,
	LiveStoreMissingError,
	LiveStoreUnavailableError,
	PAIRING_RELAY_ADDRS_MAX,
} from '@votetorrent/web-data/officer';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';
import { MemberNodeError, MemberStorageBusyError } from '../../src/peer/member-node.js';
import { DeviceKeyCorruptError, DeviceKeyStorageUnavailableError } from '../../src/peer/device-key.js';
import {
	PAIR_FAILURES,
	PAIR_PROGRESS_PHASES,
	JOIN_FAILURE_TO_PAIR_FAILURE,
	PAIR_REDEEM_ATTEMPTS,
	PAIR_REDEEM_RETRY_DELAY_MS,
	PAIR_FIRST_SYNC_TIMEOUT_MS,
	PAIR_AFTER_STRAND_DB_MS,
	PAIR_SYNC_POLL_MS,
	PairingCheckUnavailableError,
	checkPairingStillValid,
	deriveRelayAddrs,
	pairBrowser,
} from '../../src/peer/pairing.js';

const PAIRING_PATH = fileURLToPath(new URL('../../src/peer/pairing.js', import.meta.url));

const NET = 'n'.repeat(64);
const OFFICER = 'officer-user-1';
const PEER = '12D3KooWRequesterPeerAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const NONCE = 'nonceABCDEFGHIJKLMNOPQ';
const NOW_CANONICAL = '2026-11-03T10:05:00';

/**
 * A paired registry entry for the per-pass check.
 *
 * @param {Record<string, unknown>} [overrides]
 * @returns {any}
 */
function pairedEntry(overrides = {}) {
	return {
		networkHash: NET,
		authorityName: 'Authority',
		domain: 'example.org',
		officerUserId: OFFICER,
		pairing: {
			v: 1,
			requesterPeerId: PEER,
			nonce: NONCE,
			expiresAt: '2026-11-03T10:15:00',
			keyPub: '02' + 'a'.repeat(64),
			sig: 'ab'.repeat(64),
			pairedAt: '2026-11-03T10:01:00',
			relayAddrs: ['/dns4/relay.example/tcp/443/wss/p2p/12D3KooWRelay'],
			strandId: NET,
		},
		...overrides,
	};
}

/**
 * Capture `console.error` / `console.warn` / `console.log` calls during `fn`.
 *
 * @param {() => Promise<unknown>} fn
 * @returns {Promise<{ lines: unknown[][], ok: boolean, v?: any, e?: any }>}
 */
async function captureConsole(fn) {
	/** @type {unknown[][]} */
	const lines = [];
	const saved = { error: console.error, warn: console.warn, log: console.log, info: console.info };
	console.error = (...args) => lines.push(args);
	console.warn = (...args) => lines.push(args);
	console.log = (...args) => lines.push(args);
	console.info = (...args) => lines.push(args);
	try {
		/** @type {{ ok: boolean, v?: any, e?: any }} */
		const value = await fn().then(
			(v) => ({ ok: true, v }),
			(e) => ({ ok: false, e }),
		);
		return { lines, ...value };
	} finally {
		Object.assign(console, saved);
	}
}

/**
 * Fakes that record calls.
 *
 * @param {{ revoked?: boolean, verifyResult?: unknown, revokedThrows?: Error, verifyThrows?: Error }} [options]
 */
function checkFakes({ revoked = false, verifyResult = { ok: true }, revokedThrows, verifyThrows } = {}) {
	/** @type {Array<{ name: string, args: any[] }>} */
	const calls = [];
	return {
		calls,
		/** @type {any} */
		deps: {
			isPairingRevoked: async (/** @type {any[]} */ ...args) => {
				calls.push({ name: 'isPairingRevoked', args });
				if (revokedThrows) throw revokedThrows;
				return revoked;
			},
			verifyPairingStatement: async (/** @type {any[]} */ ...args) => {
				calls.push({ name: 'verifyPairingStatement', args });
				if (verifyThrows) throw verifyThrows;
				return verifyResult;
			},
			nowCanonical: () => NOW_CANONICAL,
		},
	};
}

// ---------------------------------------------------------------------------
// checkPairingStillValid (D-27)
// ---------------------------------------------------------------------------

test('C1 not revoked and verified is ok, and the verifier gets the entry statement without expiry', async () => {
	const { calls, deps } = checkFakes();
	const db = { tag: 'local' };
	const entry = pairedEntry();
	const result = await checkPairingStillValid({ db, networkHash: NET, entry, deps });
	assert.deepEqual(result, { ok: true });
	assert.deepEqual(
		calls.map((c) => c.name),
		['isPairingRevoked', 'verifyPairingStatement'],
	);
	assert.equal(calls[0].args[0], db);
	assert.deepEqual(calls[0].args[1], { userId: OFFICER, nonce: NONCE });
	assert.equal(calls[1].args[0], db);
	assert.deepEqual(calls[1].args[1], {
		networkHash: NET,
		statement: {
			userId: OFFICER,
			requesterPeerId: PEER,
			nonce: NONCE,
			expiresAt: entry.pairing.expiresAt,
			keyPub: entry.pairing.keyPub,
			sig: entry.pairing.sig,
		},
		nowCanonical: NOW_CANONICAL,
		checkExpiry: false,
	});
});

test('C2 a revocation row reads revoked and the verifier is never called', async () => {
	const { calls, deps } = checkFakes({ revoked: true });
	const result = await checkPairingStillValid({ db: {}, networkHash: NET, entry: pairedEntry(), deps });
	assert.deepEqual(result, { ok: false, reason: 'revoked' });
	assert.deepEqual(
		calls.map((c) => c.name),
		['isPairingRevoked'],
	);
});

test('C3 every verifier failure reads key-invalid', async () => {
	for (const reason of ['not-officer', 'key-not-current', 'bad-signature', 'something-new']) {
		const { deps } = checkFakes({ verifyResult: { ok: false, reason } });
		const result = await checkPairingStillValid({ db: {}, networkHash: NET, entry: pairedEntry(), deps });
		assert.deepEqual(result, { ok: false, reason: 'key-invalid' });
	}
});

test('C4 a read failure rejects PairingCheckUnavailableError by subject and logs only the error name', async () => {
	const SENTINEL = 'SENTINEL-pairing-check-91c2';
	const boomRevoked = new RangeError(`revocation read ${SENTINEL}`);
	const first = await captureConsole(() =>
		checkPairingStillValid({ db: {}, networkHash: NET, entry: pairedEntry(), deps: checkFakes({ revokedThrows: boomRevoked }).deps }),
	);
	assert.equal(first.ok, false);
	assert.ok(first.e instanceof PairingCheckUnavailableError);
	assert.equal(first.e.name, 'PairingCheckUnavailableError');
	assert.equal(first.e.subject, 'revocation');
	assert.equal(first.e.message.includes(SENTINEL), false);
	assert.deepEqual(first.lines, [['peer/pairing:', 'RangeError']]);

	const boomVerify = new TypeError(`statement read ${SENTINEL}`);
	const second = await captureConsole(() =>
		checkPairingStillValid({ db: {}, networkHash: NET, entry: pairedEntry(), deps: checkFakes({ verifyThrows: boomVerify }).deps }),
	);
	assert.equal(second.ok, false);
	assert.ok(second.e instanceof PairingCheckUnavailableError);
	assert.equal(second.e.subject, 'statement');
	assert.equal(second.e.message.includes(SENTINEL), false);
	assert.deepEqual(second.lines, [['peer/pairing:', 'TypeError']]);
	assert.equal(JSON.stringify(second.lines).includes(SENTINEL), false);
});

test('C5 bad arguments throw TypeError with value-free messages', async () => {
	const SENTINEL = 'SENTINEL-pairing-args-44d0';
	const legacy = {
		networkHash: SENTINEL,
		authorityName: SENTINEL,
		domain: SENTINEL,
		officerUserId: SENTINEL,
		bootstrappedAt: '2026-10-01T10:00:00',
		pairing: null,
	};
	const cases = [
		{ db: undefined, networkHash: NET, entry: pairedEntry() },
		{ db: null, networkHash: NET, entry: pairedEntry() },
		{ db: {}, networkHash: SENTINEL, entry: { ...legacy } },
		{ db: {}, networkHash: SENTINEL, entry: pairedEntry() },
	];
	for (const args of cases) {
		await assert.rejects(
			() => checkPairingStillValid({ ...args, deps: checkFakes().deps }),
			(/** @type {unknown} */ err) => {
				assert.ok(err instanceof TypeError);
				assert.equal(err.message.includes(SENTINEL), false);
				return true;
			},
		);
	}
});

test('C9 a strand reader is re-resolved through current() before each read and its db getter is never touched', async () => {
	/** @type {string[]} */
	const log = [];
	const handle = { tag: 'strand-db' };
	let resolvedOnce = false;
	const reader = {
		get db() {
			log.push('db-getter');
			if (!resolvedOnce) throw Object.assign(new Error('not ready'), { name: 'StrandReadError' });
			return handle;
		},
		async current() {
			log.push('current');
			resolvedOnce = true;
			return handle;
		},
	};
	/** @type {any} */
	const deps = {
		isPairingRevoked: async (/** @type {any} */ db) => {
			log.push('isPairingRevoked');
			assert.equal(db, handle);
			return false;
		},
		verifyPairingStatement: async (/** @type {any} */ db) => {
			log.push('verifyPairingStatement');
			assert.equal(db, handle);
			return { ok: true };
		},
		nowCanonical: () => NOW_CANONICAL,
	};
	const result = await checkPairingStillValid({ db: reader, networkHash: NET, entry: pairedEntry(), deps });
	assert.deepEqual(result, { ok: true });
	assert.deepEqual(log, ['current', 'isPairingRevoked', 'current', 'verifyPairingStatement']);
});

// ---------------------------------------------------------------------------
// C6: real crypto, real verifier, real revocation lookup
// ---------------------------------------------------------------------------

/**
 * A Quereus database with vote-engine's SQL functions and plain tables carrying only the columns
 * `verifyPairingStatement` and `isPairingRevoked` read.
 */
/** @param {{ keyExpiresAt: string }} options */
async function realCheckDb({ keyExpiresAt }) {
	const db = new Database();
	await registerDbPlugins(db);
	await db.exec('create table User (Id text primary key, Name text null)');
	await db.exec('create table Officer (UserId text primary key)');
	await db.exec('create table UserKey (UserId text, Type text null, PubKey text, Expiration text, primary key (UserId, PubKey))');
	await db.exec('create table DashboardPairingRevocation (UserId text, Nonce text, primary key (UserId, Nonce))');

	const privBytes = p256.utils.randomSecretKey();
	const keyPub = bytesToHex(p256.getPublicKey(privBytes));
	await db.exec('insert into User (Id, Name) values (:uid, :uname)', { uid: OFFICER, uname: 'Officer One' });
	await db.exec('insert into Officer (UserId) values (:uid)', { uid: OFFICER });
	await db.exec('insert into UserKey (UserId, Type, PubKey, Expiration) values (:uid, :kt, :kp, :kx)', {
		uid: OFFICER,
		kt: 'P',
		kp: keyPub,
		kx: keyExpiresAt,
	});
	return { db, privBytes, keyPub };
}

/**
 * Sign a real statement and return the paired entry carrying it.
 *
 * @param {Database} db
 * @param {Uint8Array} privBytes
 * @param {string} keyPub
 * @param {{ expiresAt: string }} options
 */
async function signedEntry(db, privBytes, keyPub, { expiresAt }) {
	const digest = await pairingStatementDigest(db, {
		networkHash: NET,
		userId: OFFICER,
		nonce: NONCE,
		expiresAt,
		requesterPeerId: PEER,
	});
	const sig = bytesToHex(p256.sign(digest, privBytes));
	const base = pairedEntry();
	return { ...base, pairing: { ...base.pairing, expiresAt, keyPub, sig } };
}

const DAY_MS = 86_400_000;

test('C6 real crypto: a correctly signed statement is ok', async () => {
	const { db, privBytes, keyPub } = await realCheckDb({ keyExpiresAt: toCanonicalDatetime(Date.now() + DAY_MS) });
	const entry = await signedEntry(db, privBytes, keyPub, { expiresAt: toCanonicalDatetime(Date.now() + 10 * 60_000) });
	assert.deepEqual(await checkPairingStillValid({ db, networkHash: NET, entry }), { ok: true });
});

test('C6 real crypto: one changed requesterPeerId character is key-invalid (requester binding)', async () => {
	const { db, privBytes, keyPub } = await realCheckDb({ keyExpiresAt: toCanonicalDatetime(Date.now() + DAY_MS) });
	const entry = await signedEntry(db, privBytes, keyPub, { expiresAt: toCanonicalDatetime(Date.now() + 10 * 60_000) });
	const last = entry.pairing.requesterPeerId.slice(-1);
	const tampered = {
		...entry,
		pairing: { ...entry.pairing, requesterPeerId: entry.pairing.requesterPeerId.slice(0, -1) + (last === 'B' ? 'C' : 'B') },
	};
	assert.deepEqual(await checkPairingStillValid({ db, networkHash: NET, entry: tampered }), { ok: false, reason: 'key-invalid' });
});

test('C6 real crypto: a signing key whose Expiration has passed is key-invalid', async () => {
	const { db, privBytes, keyPub } = await realCheckDb({ keyExpiresAt: toCanonicalDatetime(Date.now() - DAY_MS) });
	const entry = await signedEntry(db, privBytes, keyPub, { expiresAt: toCanonicalDatetime(Date.now() + 10 * 60_000) });
	assert.deepEqual(await checkPairingStillValid({ db, networkHash: NET, entry }), { ok: false, reason: 'key-invalid' });
});

test('C6 real crypto: a revocation row for the nonce is revoked', async () => {
	const { db, privBytes, keyPub } = await realCheckDb({ keyExpiresAt: toCanonicalDatetime(Date.now() + DAY_MS) });
	const entry = await signedEntry(db, privBytes, keyPub, { expiresAt: toCanonicalDatetime(Date.now() + 10 * 60_000) });
	await db.exec('insert into DashboardPairingRevocation (UserId, Nonce) values (:uid, :nonceValue)', {
		uid: OFFICER,
		nonceValue: NONCE,
	});
	assert.deepEqual(await checkPairingStillValid({ db, networkHash: NET, entry }), { ok: false, reason: 'revoked' });
});

test('C6 real crypto: an expired statement alone stays ok (per-pass checks ignore statement expiry)', async () => {
	const { db, privBytes, keyPub } = await realCheckDb({ keyExpiresAt: toCanonicalDatetime(Date.now() + DAY_MS) });
	const entry = await signedEntry(db, privBytes, keyPub, { expiresAt: toCanonicalDatetime(Date.now() - 60 * 60_000) });
	assert.deepEqual(await checkPairingStillValid({ db, networkHash: NET, entry }), { ok: true });
});

// ---------------------------------------------------------------------------
// C7: closed sets
// ---------------------------------------------------------------------------

test('C7 PAIR_FAILURES, PAIR_PROGRESS_PHASES and JOIN_FAILURE_TO_PAIR_FAILURE are frozen closed sets', () => {
	assert.equal(Object.isFrozen(PAIR_FAILURES), true);
	assert.deepEqual(
		[...PAIR_FAILURES],
		[
			'malformed',
			'old-style',
			'expired',
			'spent',
			'unreachable',
			'digest-mismatch',
			'officer-not-valid',
			'no-storage',
			'unsupported',
			'cancelled',
			'swap-declined',
		],
	);
	assert.equal(Object.isFrozen(PAIR_PROGRESS_PHASES), true);
	assert.deepEqual([...PAIR_PROGRESS_PHASES], ['verifying', 'connecting', 'joining', 'first-sync']);
	assert.equal(Object.isFrozen(JOIN_FAILURE_TO_PAIR_FAILURE), true);
	assert.deepEqual(Object.keys(JOIN_FAILURE_TO_PAIR_FAILURE).sort(), [
		'cancelled',
		'invalid',
		'malformed',
		'not-invitation',
		'owner-key',
		'party-mismatch',
		'removed',
		'spent',
		'unreachable',
	]);
	for (const value of Object.values(JOIN_FAILURE_TO_PAIR_FAILURE)) {
		assert.equal(PAIR_FAILURES.includes(value), true);
	}
});

// ---------------------------------------------------------------------------
// C8: source scans on comment-stripped pairing.js, each with a positive control
// ---------------------------------------------------------------------------

const PAIRING_SOURCE = stripComments(readFileSync(PAIRING_PATH, 'utf8'));

const CONSOLE_RE = /\bconsole\./g;
/** @param {string} source */
function interpolatedThrowLines(source) {
	return source.split('\n').filter((line) => /(\bthrow\b|new\s+\w*Error\s*\()/.test(line) && line.includes('${'));
}
const BANNED_STORAGE_RE = /\b(localStorage|sessionStorage)\b|Date\.parse|toISOString/;
const PUBLIC_IMPORT_RE = /VoteTorrentPublic|StrandChangeHub/;
const SIGNING_RE = /\.sign\(|\bcreateDeviceSigner\b|\bp256\b|\bprivateKey\b/;
const SCOPE_RE = /preview|simulat|effectiveScopes/i;
// The specifier is assembled so this file never spells it either.
const READER_MODULE = 'strand' + '-read';
const READER_SPECIFIER_RE = new RegExp(READER_MODULE.replace('-', '\\-'));

test('C8 exactly one console call, inside logFailure', () => {
	assert.equal((PAIRING_SOURCE.match(CONSOLE_RE) ?? []).length, 1);
	const fnStart = PAIRING_SOURCE.indexOf('function logFailure(');
	const consoleAt = PAIRING_SOURCE.search(CONSOLE_RE);
	assert.ok(fnStart >= 0 && consoleAt > fnStart && consoleAt < PAIRING_SOURCE.indexOf('}', consoleAt) + 1);
	assert.equal(('console.warn(1); console.error(2);'.match(CONSOLE_RE) ?? []).length, 2, 'positive control');
});

test('C8 no interpolated template inside any thrown error', () => {
	assert.deepEqual(interpolatedThrowLines(PAIRING_SOURCE), []);
	assert.equal(interpolatedThrowLines('\t\tthrow new Error(`bad ${input}`);').length, 1, 'positive control');
});

test('C8 no browser storage, Date.parse or toISOString', () => {
	assert.doesNotMatch(PAIRING_SOURCE, BANNED_STORAGE_RE);
	assert.match('globalThis.localStorage.getItem(k)', BANNED_STORAGE_RE, 'positive control');
	assert.match('new Date(x).toISOString()', BANNED_STORAGE_RE, 'positive control');
});

test('C8 no Public import and no StrandChangeHub', () => {
	assert.doesNotMatch(PAIRING_SOURCE, PUBLIC_IMPORT_RE);
	assert.match("import { x } from '../../../VoteTorrentPublic/src/peer/edge-node.js';", PUBLIC_IMPORT_RE, 'positive control');
});

test('C8 no signing call, device signer, curve or private key (the browser holds no officer key)', () => {
	assert.doesNotMatch(PAIRING_SOURCE, SIGNING_RE);
	assert.match('const s = await signer.sign(digest);', SIGNING_RE, 'positive control');
	assert.match('const k = privateKey;', SIGNING_RE, 'positive control');
});

test('C8 no scope logic words', () => {
	assert.doesNotMatch(PAIRING_SOURCE, SCOPE_RE);
	assert.match('const s = effectiveScopes(state)', SCOPE_RE, 'positive control');
});

test('C8 no reference to the strand reader module, static or dynamic', () => {
	assert.doesNotMatch(PAIRING_SOURCE, READER_SPECIFIER_RE);
	assert.match(`const m = await import('./${READER_MODULE}.js');`, READER_SPECIFIER_RE, 'positive control');
});

// ===========================================================================
// pairBrowser (D-01, D-04, D-06, D-09, D-12, D-18, D-26) over a fake world
// ===========================================================================

const T0 = fromCanonicalDatetime('2026-11-03T10:00:00');
const PAIR_HASH = 'c'.repeat(64);
const AUTHORITY = 'authority-1';
const FOUNDER = 'founder-1';
const FOUNDER_KEY = '02' + 'f'.repeat(64);
const GEN_1 = '2026-01-01T00:00:00';
const GEN_2 = '2026-06-01T00:00:00';
const OFFICER_A = 'officer-a';
const OFFICER_B = 'officer-b';
const RELAY_1 = '/dns4/relay-one.example/tcp/443/wss/p2p/12D3KooWRelayOne';
const RELAY_2 = '/dns4/relay-two.example/tcp/443/wss/p2p/12D3KooWRelayTwo';
const AUTHORITY_NAME = 'Fixture County';
const AUTHORITY_DOMAIN = 'county.example';

function ed25519PublicB64() {
	return /** @type {string} */ (generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x);
}

/** The six founding rows of one Admin generation, as plain objects. */
function foundingRows(adminEffectiveAt = GEN_1, networkHash = PAIR_HASH) {
	return {
		User: [{ Id: FOUNDER, Name: 'Founder', ImageRef: null }],
		UserKey: [{ UserId: FOUNDER, Type: 'P', PubKey: FOUNDER_KEY, Expiration: '2027-11-03T00:00:00' }],
		Authority: [{ Id: AUTHORITY, Name: AUTHORITY_NAME, DomainName: AUTHORITY_DOMAIN, ImageRef: null }],
		Admin: [{ AuthorityId: AUTHORITY, EffectiveAt: adminEffectiveAt, ThresholdPolicies: '[]' }],
		Officer: [{ AuthorityId: AUTHORITY, AdminEffectiveAt: adminEffectiveAt, UserId: FOUNDER, Title: 'Founder', Scopes: '[]' }],
		Network: [
			{
				Id: 'network-id',
				Hash: networkHash,
				PrimaryAuthorityId: AUTHORITY,
				Name: 'Fixture Network',
				ImageRef: null,
				Relays: '[]',
				TimestampAuthorities: '[]',
				NumberRequiredTSAs: 0,
				ElectionType: 'o',
			},
		],
	};
}

/**
 * A REAL pairing code: a real cadre invitation inside a real v2 join code inside a real pairing
 * code. The statement's signature is not checked here (the verifier is injected).
 */
function buildPairing({
	userId = OFFICER_A,
	expiresAt = toCanonicalDatetime(T0 + 14 * 60_000),
	members = [`${RELAY_1}/p2p-circuit/p2p/12D3KooWMemberOne`, `${RELAY_2}/p2p-circuit/p2p/12D3KooWMemberTwo`, `${RELAY_1}/p2p-circuit/p2p/12D3KooWMemberThree`],
	adminEffectiveAt = GEN_1,
	rows = foundingRows(adminEffectiveAt),
	partyId = 'party-a',
	name = 'Fixture Network',
	nonce = 'nonceABCDEFGHIJKLMNOPQ',
} = {}) {
	const invitation = {
		v: 1,
		partyId,
		invitePrivateKey: ed25519PublicB64(),
		invite: {
			key: ed25519PublicB64(),
			peerId: null,
			expiresAt: null,
			totalUses: 1,
			stampId: 'stamp-1',
			issuerKey: ed25519PublicB64(),
			issuerSig: 'issuer-signature',
		},
		ownerKeys: [ed25519PublicB64()],
		members,
	};
	const invitationText = encodeCadreInvitation(/** @type {any} */ (invitation));
	const joinCode = encodeNetworkJoinCode({
		v: 2,
		invitation: invitationText,
		networkHash: PAIR_HASH,
		name,
		genesis: { userId: FOUNDER, signerKey: FOUNDER_KEY, authorityId: AUTHORITY, adminEffectiveAt },
		digest: computeContentDigest(rows),
	});
	const statement = {
		userId,
		requesterPeerId: '12D3KooWRequesterPeer',
		nonce,
		expiresAt,
		keyPub: '02' + 'a'.repeat(64),
		sig: 'ab'.repeat(64),
	};
	return { code: encodePairingCode({ statement, joinCode }), invitation, invitationText, statement, rows };
}

/** A `Map`-backed localStorage-shaped fake. */
function memoryStorage() {
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
		_blob: () => JSON.stringify([...map.entries()]),
	};
}

/**
 * A paired registry entry this browser already holds.
 *
 * @param {string} officerUserId
 */
function heldPairedEntry(officerUserId) {
	return {
		networkHash: PAIR_HASH,
		authorityName: AUTHORITY_NAME,
		domain: AUTHORITY_DOMAIN,
		officerUserId,
		pairing: {
			v: 1,
			requesterPeerId: '12D3KooWOlderRequester',
			nonce: 'olderNonceABCDEFGHIJKL',
			expiresAt: '2026-10-01T10:15:00',
			keyPub: '02' + 'd'.repeat(64),
			sig: 'cd'.repeat(64),
			pairedAt: '2026-10-01T10:01:00',
			relayAddrs: [RELAY_1],
			strandId: PAIR_HASH,
		},
	};
}

/**
 * A legacy (snapshot-era) entry.
 *
 * @param {string} officerUserId
 */
function heldLegacyEntry(officerUserId) {
	return {
		networkHash: PAIR_HASH,
		authorityName: AUTHORITY_NAME,
		domain: AUTHORITY_DOMAIN,
		officerUserId,
		bootstrappedAt: '2026-09-01T10:00:00',
		pairing: null,
	};
}

/**
 * A Quereus-shaped fake handle that answers the `User.Name` lookup.
 *
 * @param {string} tag
 * @param {Record<string, string>} names
 */
function nameDb(tag, names) {
	return {
		tag,
		prepare(/** @type {string} */ sql) {
			return {
				async get(/** @type {Record<string, unknown>} */ binds) {
					if (/from User where Id/.test(sql) && typeof binds.userId === 'string' && names[binds.userId]) {
						return { Name: names[binds.userId] };
					}
					return undefined;
				},
			};
		},
	};
}

/**
 * The fake world every pairBrowser case runs against. Every collaborator records its name in
 * `log`; `opts` scripts the outcomes.
 *
 * @param {any} [opts]
 */
function makeWorld(opts = {}) {
	/** @type {string[]} */
	const log = [];
	const storage = memoryStorage();
	if (opts.held) upsertNetwork(opts.held, storage);
	let clock = T0;
	/** @type {number[]} */
	const sleeps = [];
	/** @type {Set<string>} */
	const listed = new Set(opts.listed ?? []);
	const strandDb = nameDb('strand', opts.strandNames ?? { [OFFICER_A]: 'Officer A', [OFFICER_B]: 'Officer B' });
	const localDb = nameDb('local', opts.localNames ?? { [OFFICER_A]: 'Officer A (local)', [OFFICER_B]: 'Officer B (local)' });
	const joinScript = [...(opts.joinScript ?? ['joined'])];
	const verifyScript = [...(opts.verifyScript ?? [{ ok: true }])];
	const localVerifyScript = [...(opts.localVerifyScript ?? [{ ok: true }])];
	/** @type {any[]} */
	const verifyArgs = [];
	/** @type {any[]} */
	const confirmCalls = [];
	let dbGetterHits = 0;

	const keyStore = {
		async get() {
			return new Uint8Array([1]);
		},
		async set() {
			log.push('keyStore.set');
		},
		async delete() {},
		async list() {
			return [];
		},
	};
	/** @type {any} */
	const memberNode = {
		peerId: '12D3KooWBrowserIdentity',
		async joinCadre(/** @type {string} */ invitation, /** @type {any} */ options) {
			log.push('joinCadre');
			world.joinInvitations.push(invitation);
			options?.onProgress?.({ state: 'redeeming', pass: 1 });
			const next = joinScript.length > 1 ? joinScript.shift() : joinScript[0];
			if (typeof next === 'function') return next();
			if (next === 'joined' || next === 'already-member') return next;
			throw new MemberNodeError(next);
		},
		async waitForStrand(/** @type {string} */ _id, /** @type {any} */ options) {
			log.push('waitForStrand');
			world.waitForStrandSignal = options?.signal ?? null;
			if (opts.waitForStrandThrows) throw opts.waitForStrandThrows;
		},
		async stop() {
			log.push('memberNode.stop');
		},
	};
	const reader = {
		get db() {
			dbGetterHits += 1;
			log.push('reader.db');
			throw Object.assign(new Error('not ready'), { name: 'StrandReadError' });
		},
		async current() {
			log.push('current');
			return strandDb;
		},
		async close() {
			log.push('reader.close');
		},
	};

	const deps = {
		openStrandReader: async (/** @type {any} */ args) => {
			log.push('openStrandReader');
			world.readerArgs = args;
			if (opts.openStrandReaderThrows) throw opts.openStrandReaderThrows;
			// A first build that publishes the strand database late: the reader's own wait runs the clock on.
			if (opts.readerOpensAtMs !== undefined) clock = Math.max(clock, opts.readerOpensAtMs);
			if (typeof opts.onReaderOpen === 'function') opts.onReaderOpen(args);
			return reader;
		},
		readGenesisRows: async (/** @type {any} */ db, /** @type {any} */ keys) => {
			log.push('readGenesisRows');
			assert.equal(db, strandDb);
			world.genesisKeys = keys;
			if (opts.readGenesisRowsThrows) throw opts.readGenesisRowsThrows;
			if (opts.rowsReadyAtMs !== undefined && clock < opts.rowsReadyAtMs) {
				return { User: [], UserKey: [], Authority: [], Admin: [], Officer: [], Network: [] };
			}
			return opts.replicaRows;
		},
		adminGenerations: async (/** @type {any} */ db) => {
			log.push('adminGenerations');
			assert.equal(db, strandDb);
			if (opts.adminGenerationsThrows) throw opts.adminGenerationsThrows;
			return opts.generations ?? [GEN_1];
		},
		isPairingRevoked: async (/** @type {any} */ db) => {
			log.push('isPairingRevoked');
			assert.equal(db, strandDb);
			if (opts.revokedThrows) throw opts.revokedThrows;
			return opts.revoked === true;
		},
		verifyPairingStatement: async (/** @type {any} */ db, /** @type {any} */ args) => {
			if (db === localDb) {
				log.push('verifyLocal');
				return localVerifyScript.length > 1 ? localVerifyScript.shift() : localVerifyScript[0];
			}
			log.push('verifyPairingStatement');
			assert.equal(db, strandDb);
			verifyArgs.push(args);
			if (opts.verifyThrows) throw opts.verifyThrows;
			return verifyScript.length > 1 ? verifyScript.shift() : verifyScript[0];
		},
		attachLiveDb: async (/** @type {string} */ hash, /** @type {{ create: boolean }} */ options) => {
			log.push(`attachLiveDb(create:${options.create})`);
			if (!options.create) {
				if (opts.localMissing || !listed.has(dbNameFor(hash))) throw new LiveStoreMissingError(hash, 'absent');
				if (opts.attachLocalThrows) throw opts.attachLocalThrows;
				return localDb;
			}
			if (opts.attachCreateThrows) throw opts.attachCreateThrows;
			listed.add(dbNameFor(hash));
			return { tag: 'fresh-store' };
		},
		closeNetworkDb: async (/** @type {any} */ handle) => {
			log.push(handle === localDb ? 'closeNetworkDb(local)' : 'closeNetworkDb');
		},
		deleteNetworkDb: async (/** @type {string} */ hash) => {
			log.push('deleteNetworkDb');
			if (opts.deleteNetworkDbThrows) throw opts.deleteNetworkDbThrows;
			const name = dbNameFor(hash);
			listed.delete(name);
			if (opts.resurrect && opts.resurrect > 0) {
				opts.resurrect -= 1;
				world.resurrectPending = name;
			}
		},
		clearRowCounts: async () => {
			log.push('clearRowCounts');
		},
		findNetwork,
		upsertNetwork: (/** @type {any} */ entry, /** @type {any} */ s) => {
			log.push('upsertNetwork');
			if (opts.upsertThrows) throw opts.upsertThrows;
			return upsertNetwork(entry, s);
		},
		removeNetwork: (/** @type {string} */ hash, /** @type {any} */ s) => {
			log.push('removeNetwork');
			return removeNetwork(hash, s);
		},
		storage,
		createIdbKeyStore: () => keyStore,
		deleteDeviceKeys: async () => {
			log.push('deleteDeviceKeys');
			if (opts.deleteDeviceKeysThrows) throw opts.deleteDeviceKeysThrows;
		},
		createMemberNode: async (/** @type {any} */ args) => {
			log.push('createMemberNode');
			world.memberNodeArgs = args;
			if (opts.createMemberNodeThrows) throw opts.createMemberNodeThrows;
			await args.keyStore.set('identity', new Uint8Array([1]));
			if (opts.abortAfterCreate) opts.abortAfterCreate.abort();
			return memberNode;
		},
		deleteMemberStorage: async () => {
			log.push('deleteMemberStorage');
			if (opts.deleteMemberStorageThrows) throw opts.deleteMemberStorageThrows;
		},
		indexedDB: {
			async databases() {
				if (world.resurrectPending) {
					listed.add(world.resurrectPending);
					world.resurrectPending = null;
				}
				if (opts.stuckListed) listed.add(dbNameFor(PAIR_HASH));
				return [...listed].map((name) => ({ name }));
			},
		},
		now: () => clock,
		sleep: async (/** @type {number} */ ms) => {
			sleeps.push(ms);
			clock += ms;
		},
	};

	const world = {
		log,
		storage,
		sleeps,
		listed,
		strandDb,
		localDb,
		memberNode,
		reader,
		deps,
		verifyArgs,
		confirmCalls,
		/** @type {string[]} */
		joinInvitations: [],
		/** @type {any} */
		readerArgs: null,
		/** @type {AbortSignal | null} */
		waitForStrandSignal: null,
		/** @type {any} */
		memberNodeArgs: null,
		/** @type {any} */
		genesisKeys: null,
		/** @type {string | null} */
		resurrectPending: null,
		get dbGetterHits() {
			return dbGetterHits;
		},
		/** @param {boolean | ((details: any) => boolean | Promise<boolean>)} answer */
		confirmWith(answer) {
			return async (/** @type {any} */ details) => {
				log.push('confirmSwap');
				confirmCalls.push(details);
				return typeof answer === 'function' ? answer(details) : answer;
			};
		},
	};
	return world;
}

/**
 * Run pairBrowser in a world, capturing console output.
 *
 * @param {ReturnType<typeof makeWorld>} world
 * @param {{ code: unknown, onProgress?: any, confirmSwap?: any, signal?: AbortSignal, deps?: any }} options
 */
async function runPair(world, options) {
	const captured = await captureConsole(() => pairBrowser({ deps: world.deps, ...options }));
	assert.equal(captured.ok, true, 'pairBrowser must never throw');
	return { result: /** @type {any} */ (captured.v), lines: captured.lines };
}

const WRITES = ['deleteNetworkDb', 'deleteMemberStorage', 'deleteDeviceKeys', 'createMemberNode', 'keyStore.set', 'upsertNetwork', 'removeNetwork', 'clearRowCounts'];
/** @param {string[]} log */
const writesIn = (log) => log.filter((name) => WRITES.includes(name) || name === 'attachLiveDb(create:true)');

// ---------------------------------------------------------------------------
// P1 happy path
// ---------------------------------------------------------------------------

test('P1 happy path: phases in order, the recorded call order, the handoff and the registry entry', async () => {
	const pairing = buildPairing();
	const world = makeWorld({ replicaRows: pairing.rows });
	/** @type {string[]} */
	const phases = [];
	const { result } = await runPair(world, { code: pairing.code, onProgress: (/** @type {string} */ p) => phases.push(p) });
	assert.equal(result.ok, true);
	assert.equal(result.networkHash, PAIR_HASH);
	assert.equal(result.handoff.memberNode, world.memberNode);
	assert.equal(result.handoff.strandReader, world.reader);
	assert.deepEqual(phases, ['verifying', 'connecting', 'joining', 'first-sync']);
	const ORDER = [
		'deleteMemberStorage',
		'deleteDeviceKeys',
		'createMemberNode',
		'keyStore.set',
		'joinCadre',
		'waitForStrand',
		'openStrandReader',
		'readGenesisRows',
		'adminGenerations',
		'isPairingRevoked',
		'verifyPairingStatement',
		'attachLiveDb(create:true)',
		'closeNetworkDb',
		'upsertNetwork',
	];
	assert.deepEqual(
		world.log.filter((name) => ORDER.includes(name)),
		ORDER,
	);
	assert.equal(world.joinInvitations[0], pairing.invitationText);
	assert.deepEqual(world.memberNodeArgs.relayAddrs, [RELAY_1, RELAY_2]);
	assert.equal(world.memberNodeArgs.strandId, PAIR_HASH);
	assert.equal(world.memberNodeArgs.networkHash, PAIR_HASH);
	assert.deepEqual(world.genesisKeys, { userId: FOUNDER, signerKey: FOUNDER_KEY, authorityId: AUTHORITY, adminEffectiveAt: GEN_1 });
	assert.deepEqual(findNetwork(PAIR_HASH, world.storage), {
		networkHash: PAIR_HASH,
		authorityName: AUTHORITY_NAME,
		domain: AUTHORITY_DOMAIN,
		officerUserId: OFFICER_A,
		officerName: 'Officer A',
		pairing: {
			v: 1,
			requesterPeerId: pairing.statement.requesterPeerId,
			nonce: pairing.statement.nonce,
			expiresAt: pairing.statement.expiresAt,
			keyPub: pairing.statement.keyPub,
			sig: pairing.statement.sig,
			pairedAt: toCanonicalDatetime(T0),
			relayAddrs: [RELAY_1, RELAY_2],
			strandId: PAIR_HASH,
		},
	});
});

test('deriveRelayAddrs keeps only relay prefixes of circuit addresses, de-duplicated and capped', () => {
	assert.deepEqual(
		deriveRelayAddrs([
			`${RELAY_1}/p2p-circuit/p2p/12D3KooWM1`,
			'/dns4/direct.example/tcp/443/wss/p2p/12D3KooWDirect',
			`${RELAY_1}/p2p-circuit/p2p/12D3KooWM2`,
			'/dns4/no-peer.example/tcp/443/wss/p2p-circuit/p2p/12D3KooWM3',
			`/dns4/space example/tcp/443/wss/p2p/12D3KooWR/p2p-circuit/p2p/12D3KooWM4`,
			`${RELAY_2}/p2p-circuit/p2p/12D3KooWM5`,
			42,
		]),
		[RELAY_1, RELAY_2],
	);
	const many = Array.from({ length: 40 }, (_, i) => `/dns4/r${i}.example/tcp/443/wss/p2p/12D3KooWR${i}/p2p-circuit/p2p/12D3KooWM`);
	assert.equal(deriveRelayAddrs(many).length, PAIRING_RELAY_ADDRS_MAX);
	assert.deepEqual(deriveRelayAddrs(undefined), []);
});

// ---------------------------------------------------------------------------
// P2 / P3 decode and expiry: nothing touched
// ---------------------------------------------------------------------------

test('P2 every decode failure maps to its closed reason with nothing touched', async () => {
	const good = buildPairing();
	const [prefix, header, ...joinParts] = good.code.split('.');
	const join = joinParts.join('.');
	const reheader = (/** @type {Record<string, unknown>} */ patch) => {
		const obj = { v: 1, ...good.statement, ...patch };
		return `${prefix}.${Buffer.from(JSON.stringify(obj)).toString('base64url')}.${join}`;
	};
	const joinWith = (/** @type {string} */ joinText) => `${prefix}.${header}.${joinText}`;
	const v2Body = join.slice('vtjoin2.'.length);
	const v2Json = JSON.parse(Buffer.from(v2Body, 'base64url').toString('utf8'));
	const reJoin = (/** @type {any} */ obj) => 'vtjoin2.' + Buffer.from(JSON.stringify(obj)).toString('base64url');
	const cases = [
		{ code: 'vtpair1.%%%', reason: 'malformed' },
		{ code: 'hello there', reason: 'malformed' },
		{ code: `vtpair2.${header}.${join}`, reason: 'unsupported' },
		{ code: `${'a'.repeat(40)}.${'B'.repeat(43)}`, reason: 'old-style' },
		{ code: reheader({ v: 2 }), reason: 'unsupported' },
		{ code: joinWith(reJoin({ ...v2Json, extra: 1 })), reason: 'malformed' },
		{ code: joinWith(reJoin({ ...v2Json, invitation: { ...v2Json.invitation, invite: { ...v2Json.invitation.invite, grantsOwner: false } } })), reason: 'unsupported' },
		{ code: joinWith(reJoin({ ...v2Json, invitation: { ...v2Json.invitation, invitePrivateKey: 'not-a-key' } })), reason: 'malformed' },
		{ code: 42, reason: 'malformed' },
		{ code: buildPairing({ members: ['/dns4/direct.example/tcp/443/wss/p2p/12D3KooWDirect'] }).code, reason: 'unreachable' },
	];
	for (const { code, reason } of cases) {
		const world = makeWorld({ replicaRows: good.rows });
		const { result } = await runPair(world, { code });
		assert.deepEqual(result, { ok: false, reason });
		assert.deepEqual(writesIn(world.log), []);
		assert.equal(world.log.includes('createMemberNode'), false);
	}
});

test('P2 a join code of an unknown version inside a pairing code is unsupported', async () => {
	const good = buildPairing();
	const world = makeWorld({ replicaRows: good.rows });
	const { result } = await runPair(world, { code: good.code, deps: { ...world.deps, decodeNetworkJoinCode: () => ({ ok: false, reason: 'unsupported-version' }) } });
	assert.deepEqual(result, { ok: false, reason: 'unsupported' });
	const notJoin = await runPair(world, { code: good.code, deps: { ...world.deps, decodeNetworkJoinCode: () => ({ ok: false, reason: 'not-join-code' }) } });
	assert.deepEqual(notJoin.result, { ok: false, reason: 'malformed' });
	assert.deepEqual(writesIn(world.log), []);
});

test('P3 a statement expired at the pairing instant is expired with nothing touched', async () => {
	for (const expiresAt of [toCanonicalDatetime(T0), toCanonicalDatetime(T0 - 60_000)]) {
		const pairing = buildPairing({ expiresAt });
		const world = makeWorld({ replicaRows: pairing.rows });
		const { result } = await runPair(world, { code: pairing.code });
		assert.deepEqual(result, { ok: false, reason: 'expired' });
		assert.deepEqual(writesIn(world.log), []);
	}
});

// ---------------------------------------------------------------------------
// P4 / P5 redemption
// ---------------------------------------------------------------------------

test('P4 the key is persisted before redeeming and a lost reply is retried once on the same node', async () => {
	const pairing = buildPairing();
	const world = makeWorld({ replicaRows: pairing.rows, joinScript: ['unreachable', 'already-member'] });
	const { result } = await runPair(world, { code: pairing.code });
	assert.equal(result.ok, true);
	assert.equal(world.log.filter((n) => n === 'createMemberNode').length, 1);
	assert.equal(world.log.filter((n) => n === 'joinCadre').length, 2);
	assert.ok(world.log.indexOf('keyStore.set') < world.log.indexOf('joinCadre'));
	assert.deepEqual(world.sleeps.filter((ms) => ms === PAIR_REDEEM_RETRY_DELAY_MS), [PAIR_REDEEM_RETRY_DELAY_MS]);
});

test('P4 two unreachable redemptions are unreachable with no third attempt', async () => {
	const pairing = buildPairing();
	const world = makeWorld({ replicaRows: pairing.rows, joinScript: ['unreachable', 'unreachable', 'joined'] });
	const { result } = await runPair(world, { code: pairing.code });
	assert.deepEqual(result, { ok: false, reason: 'unreachable' });
	assert.equal(world.log.filter((n) => n === 'joinCadre').length, PAIR_REDEEM_ATTEMPTS);
	assert.ok(world.log.includes('memberNode.stop'));
});

test('P5 every terminal join refusal maps without retry, stops the node and wipes, registry untouched', async () => {
	for (const reason of ['malformed', 'not-invitation', 'party-mismatch', 'spent', 'invalid', 'cancelled', 'owner-key', 'removed']) {
		const pairing = buildPairing();
		const world = makeWorld({ replicaRows: pairing.rows, joinScript: [reason] });
		const { result } = await runPair(world, { code: pairing.code });
		assert.deepEqual(result, { ok: false, reason: /** @type {Record<string, string>} */ (JOIN_FAILURE_TO_PAIR_FAILURE)[reason] });
		assert.equal(world.log.filter((n) => n === 'joinCadre').length, 1);
		const afterJoin = world.log.slice(world.log.indexOf('joinCadre'));
		assert.ok(afterJoin.indexOf('memberNode.stop') >= 0);
		assert.ok(afterJoin.indexOf('memberNode.stop') < afterJoin.indexOf('deleteMemberStorage'));
		assert.ok(afterJoin.indexOf('deleteMemberStorage') < afterJoin.indexOf('deleteDeviceKeys'));
		assert.equal(world.log.includes('upsertNetwork'), false);
		assert.equal(world.log.includes('removeNetwork'), false);
		assert.equal(findNetwork(PAIR_HASH, world.storage), undefined);
	}
});

// ---------------------------------------------------------------------------
// P6 - P9 founding anchor
// ---------------------------------------------------------------------------

test('P6 founding digest mismatch is digest-mismatch, the verifier is never called, and the pairing is wiped', async () => {
	const pairing = buildPairing();
	const tampered = foundingRows();
	tampered.Authority = [{ ...tampered.Authority[0], Name: 'Someone Else' }];
	const world = makeWorld({ replicaRows: tampered });
	const { result } = await runPair(world, { code: pairing.code });
	assert.deepEqual(result, { ok: false, reason: 'digest-mismatch' });
	assert.equal(world.log.includes('verifyPairingStatement'), false);
	assert.equal(world.log.includes('isPairingRevoked'), false);
	const afterRead = world.log.slice(world.log.lastIndexOf('readGenesisRows'));
	for (const name of ['memberNode.stop', 'reader.close', 'deleteNetworkDb', 'deleteMemberStorage', 'deleteDeviceKeys']) {
		assert.ok(afterRead.includes(name), name);
	}
	assert.equal(world.log.includes('upsertNetwork'), false);
	assert.equal(findNetwork(PAIR_HASH, world.storage), undefined);
});

test('P7 founding rows that derive a different network hash are digest-mismatch', async () => {
	const otherRows = foundingRows(GEN_1, 'd'.repeat(64));
	const pairing = buildPairing({ rows: otherRows });
	const world = makeWorld({ replicaRows: otherRows });
	const { result } = await runPair(world, { code: pairing.code });
	assert.deepEqual(result, { ok: false, reason: 'digest-mismatch' });
	assert.equal(world.log.includes('verifyPairingStatement'), false);
});

test('P8 a code naming a later Admin generation is digest-mismatch; the earliest generation passes', async () => {
	const later = buildPairing({ adminEffectiveAt: GEN_2 });
	const laterWorld = makeWorld({ replicaRows: later.rows, generations: [GEN_2, GEN_1] });
	const laterRun = await runPair(laterWorld, { code: later.code });
	assert.deepEqual(laterRun.result, { ok: false, reason: 'digest-mismatch' });
	assert.equal(laterWorld.log.includes('verifyPairingStatement'), false);

	const earliest = buildPairing({ adminEffectiveAt: GEN_1 });
	const earliestWorld = makeWorld({ replicaRows: earliest.rows, generations: [GEN_2, GEN_1] });
	const earliestRun = await runPair(earliestWorld, { code: earliest.code });
	assert.equal(earliestRun.result.ok, true, 'positive control');
});

test('P8 a code whose authority is not the network primary authority is digest-mismatch', async () => {
	const rows = foundingRows();
	rows.Network = [{ ...rows.Network[0], PrimaryAuthorityId: 'another-authority' }];
	const pairing = buildPairing({ rows });
	const world = makeWorld({ replicaRows: rows });
	const { result } = await runPair(world, { code: pairing.code });
	assert.deepEqual(result, { ok: false, reason: 'digest-mismatch' });
	assert.equal(world.log.includes('verifyPairingStatement'), false);
});

test('P9 founding rows still incomplete at the first-sync deadline are unreachable, with a wipe', async () => {
	const pairing = buildPairing();
	const world = makeWorld({ replicaRows: pairing.rows, rowsReadyAtMs: T0 + PAIR_FIRST_SYNC_TIMEOUT_MS + 60_000 });
	const { result } = await runPair(world, { code: pairing.code });
	assert.deepEqual(result, { ok: false, reason: 'unreachable' });
	assert.ok(world.log.filter((n) => n === 'readGenesisRows').length > 1);
	assert.ok(world.sleeps.every((ms) => ms === PAIR_SYNC_POLL_MS));
	assert.ok(world.log.includes('deleteDeviceKeys'));
	assert.ok(world.log.lastIndexOf('memberNode.stop') > world.log.lastIndexOf('readGenesisRows'));
});

test('P9 founding rows that arrive before the deadline are waited for', async () => {
	const pairing = buildPairing();
	const world = makeWorld({ replicaRows: pairing.rows, rowsReadyAtMs: T0 + 5 * PAIR_SYNC_POLL_MS });
	const { result } = await runPair(world, { code: pairing.code });
	assert.equal(result.ok, true);
	assert.ok(world.log.filter((n) => n === 'readGenesisRows').length >= 5);
});

test('P9b (G-3) a strand database that opens after the first-sync deadline still pairs: the founding check gets its own window', async () => {
	// The reader's progress-aware wait opened the database at +400 s, well past the 180 s deadline; the
	// founding rows arrive 5 s later. With the deadline fixed at the pairing instant + 180 s (the code
	// before G-3) the first empty read is already past it and the pairing fails unreachable.
	const pairing = buildPairing();
	const opensAt = T0 + 400_000;
	const world = makeWorld({ replicaRows: pairing.rows, readerOpensAtMs: opensAt, rowsReadyAtMs: opensAt + 5_000 });
	const { result } = await runPair(world, { code: pairing.code });
	assert.equal(result.ok, true);
	assert.ok(world.log.filter((n) => n === 'readGenesisRows').length > 1, 'the late rows were not waited for');
	assert.equal(PAIR_AFTER_STRAND_DB_MS, 120_000);
});

test('P9c (G-3) the window after a late database is bounded: rows still missing PAIR_AFTER_STRAND_DB_MS later are unreachable', async () => {
	const pairing = buildPairing();
	const opensAt = T0 + 400_000;
	const world = makeWorld({ replicaRows: pairing.rows, readerOpensAtMs: opensAt, rowsReadyAtMs: opensAt + PAIR_AFTER_STRAND_DB_MS + 1_000 });
	const { result } = await runPair(world, { code: pairing.code });
	assert.deepEqual(result, { ok: false, reason: 'unreachable' });
	assert.ok(world.log.includes('deleteDeviceKeys'));
});

test('P9d (G-3) the reader is not under the strand deadline\'s signal, and a user stop still reaches it', async () => {
	const pairing = buildPairing();
	const controller = new AbortController();
	/** @type {boolean[]} */
	const seen = [];
	const world = makeWorld({
		replicaRows: pairing.rows,
		onReaderOpen: (/** @type {any} */ args) => {
			seen.push(args.signal.aborted);
			controller.abort();
			seen.push(args.signal.aborted);
		},
	});
	const { result } = await runPair(world, { code: pairing.code, signal: controller.signal });
	assert.deepEqual(result, { ok: false, reason: 'cancelled' });
	assert.ok(world.waitForStrandSignal instanceof AbortSignal);
	assert.ok(world.readerArgs.signal instanceof AbortSignal);
	assert.notEqual(world.readerArgs.signal, world.waitForStrandSignal, 'the reader shares the strand deadline signal');
	assert.deepEqual(seen, [false, true], 'a user stop did not reach the reader');
});

// ---------------------------------------------------------------------------
// P10 statement
// ---------------------------------------------------------------------------

test('P10 a bad signature is officer-not-valid with a wipe', async () => {
	const pairing = buildPairing();
	const world = makeWorld({ replicaRows: pairing.rows, verifyScript: [{ ok: false, reason: 'bad-signature' }] });
	const { result } = await runPair(world, { code: pairing.code });
	assert.deepEqual(result, { ok: false, reason: 'officer-not-valid' });
	assert.ok(world.log.lastIndexOf('deleteDeviceKeys') > world.log.indexOf('verifyPairingStatement'));
	assert.equal(world.log.includes('upsertNetwork'), false);
});

test('P10 not-officer while the rows replicate, then ok, pairs', async () => {
	const pairing = buildPairing();
	const world = makeWorld({ replicaRows: pairing.rows, verifyScript: [{ ok: false, reason: 'not-officer' }, { ok: true }] });
	const { result } = await runPair(world, { code: pairing.code });
	assert.equal(result.ok, true);
	assert.equal(world.verifyArgs.length, 2);
});

test('P10 not-officer until the deadline is officer-not-valid', async () => {
	const pairing = buildPairing();
	const world = makeWorld({ replicaRows: pairing.rows, verifyScript: [{ ok: false, reason: 'not-officer' }] });
	const { result } = await runPair(world, { code: pairing.code });
	assert.deepEqual(result, { ok: false, reason: 'officer-not-valid' });
	assert.ok(world.verifyArgs.length > 2);
});

test('P10 an expired verdict is expired, a present revocation row is officer-not-valid, and the verifier always gets the pairing instant with expiry on', async () => {
	const pairing = buildPairing();
	const expiredWorld = makeWorld({ replicaRows: pairing.rows, verifyScript: [{ ok: false, reason: 'expired' }] });
	assert.deepEqual((await runPair(expiredWorld, { code: pairing.code })).result, { ok: false, reason: 'expired' });

	const revokedWorld = makeWorld({ replicaRows: pairing.rows, revoked: true });
	assert.deepEqual((await runPair(revokedWorld, { code: pairing.code })).result, { ok: false, reason: 'officer-not-valid' });
	assert.equal(revokedWorld.log.includes('verifyPairingStatement'), false);

	const slowWorld = makeWorld({ replicaRows: pairing.rows, verifyScript: [{ ok: false, reason: 'key-not-current' }, { ok: false, reason: 'not-officer' }, { ok: true }] });
	assert.equal((await runPair(slowWorld, { code: pairing.code })).result.ok, true);
	for (const args of [...expiredWorld.verifyArgs, ...slowWorld.verifyArgs]) {
		assert.equal(args.checkExpiry, true);
		assert.equal(args.nowCanonical, toCanonicalDatetime(T0));
		assert.equal(args.networkHash, PAIR_HASH);
	}
});

// ---------------------------------------------------------------------------
// P11 - P15 D-09: one officer per browser per network
// ---------------------------------------------------------------------------

test('P11 officer swap declined: verified on the held copy first, both officers named, zero deletes before confirmation', async () => {
	const pairing = buildPairing({ userId: OFFICER_B });
	const held = heldPairedEntry(OFFICER_A);
	const world = makeWorld({ replicaRows: pairing.rows, held, listed: [dbNameFor(PAIR_HASH)] });
	const { result } = await runPair(world, { code: pairing.code, confirmSwap: world.confirmWith(false) });
	assert.deepEqual(result, { ok: false, reason: 'swap-declined' });
	assert.ok(world.log.indexOf('attachLiveDb(create:false)') < world.log.indexOf('verifyLocal'));
	assert.ok(world.log.indexOf('verifyLocal') < world.log.indexOf('confirmSwap'));
	assert.deepEqual(world.confirmCalls, [
		{
			networkHash: PAIR_HASH,
			authorityName: AUTHORITY_NAME,
			held: { userId: OFFICER_A, name: 'Officer A (local)' },
			incoming: { userId: OFFICER_B, name: 'Officer B (local)' },
			incomingVerified: true,
		},
	]);
	assert.deepEqual(writesIn(world.log), []);
	assert.ok(world.log.includes('closeNetworkDb(local)'));
	assert.deepEqual(findNetwork(PAIR_HASH, world.storage), held);

	const absent = makeWorld({ replicaRows: pairing.rows, held, listed: [dbNameFor(PAIR_HASH)] });
	assert.deepEqual((await runPair(absent, { code: pairing.code })).result, { ok: false, reason: 'swap-declined' });
	assert.deepEqual(writesIn(absent.log), []);
});

test('P11 an incoming officer that fails on the held copy is officer-not-valid before any confirmation or delete', async () => {
	const pairing = buildPairing({ userId: OFFICER_B });
	for (const reason of ['bad-signature', 'not-officer']) {
		const world = makeWorld({
			replicaRows: pairing.rows,
			held: heldPairedEntry(OFFICER_A),
			listed: [dbNameFor(PAIR_HASH)],
			localVerifyScript: [{ ok: false, reason }],
		});
		const { result } = await runPair(world, { code: pairing.code, confirmSwap: world.confirmWith(true) });
		assert.deepEqual(result, { ok: false, reason: 'officer-not-valid' });
		assert.equal(world.log.includes('confirmSwap'), false);
		assert.deepEqual(writesIn(world.log), []);
	}
});

test('P12 officer swap accepted: old store, member storage and key removed before the new node; the entry names the new officer', async () => {
	const pairing = buildPairing({ userId: OFFICER_B });
	const world = makeWorld({ replicaRows: pairing.rows, held: heldPairedEntry(OFFICER_A), listed: [dbNameFor(PAIR_HASH)] });
	const { result } = await runPair(world, { code: pairing.code, confirmSwap: world.confirmWith(true) });
	assert.equal(result.ok, true);
	const at = (/** @type {string} */ name) => world.log.indexOf(name);
	assert.ok(at('confirmSwap') < at('closeNetworkDb(local)'));
	assert.ok(at('closeNetworkDb(local)') < at('deleteNetworkDb'));
	assert.ok(at('deleteNetworkDb') < at('deleteMemberStorage'));
	assert.ok(at('deleteMemberStorage') < at('deleteDeviceKeys'));
	assert.ok(at('deleteDeviceKeys') < at('createMemberNode'));
	assert.ok(at('deleteNetworkDb') < at('attachLiveDb(create:true)'));
	assert.equal(findNetwork(PAIR_HASH, world.storage)?.officerUserId, OFFICER_B);
});

test('P12 a failure after an accepted swap also removes the old registry entry', async () => {
	const pairing = buildPairing({ userId: OFFICER_B });
	const tampered = foundingRows();
	tampered.User = [{ ...tampered.User[0], Name: 'Changed' }];
	const world = makeWorld({ replicaRows: tampered, held: heldPairedEntry(OFFICER_A), listed: [dbNameFor(PAIR_HASH)] });
	const { result } = await runPair(world, { code: pairing.code, confirmSwap: world.confirmWith(true) });
	assert.deepEqual(result, { ok: false, reason: 'digest-mismatch' });
	assert.ok(world.log.includes('removeNetwork'));
	assert.equal(findNetwork(PAIR_HASH, world.storage), undefined);
});

test('P13 legacy replace: the store is deleted and row counts cleared before the fresh store; confirmation only for a different officer', async () => {
	const pairing = buildPairing({ userId: OFFICER_A });
	const same = makeWorld({ replicaRows: pairing.rows, held: heldLegacyEntry(OFFICER_A), listed: [dbNameFor(PAIR_HASH)] });
	const sameRun = await runPair(same, { code: pairing.code, confirmSwap: same.confirmWith(true) });
	assert.equal(sameRun.result.ok, true);
	assert.equal(same.log.includes('confirmSwap'), false);
	assert.ok(same.log.indexOf('deleteNetworkDb') < same.log.indexOf('attachLiveDb(create:true)'));
	assert.ok(same.log.indexOf('clearRowCounts') < same.log.indexOf('attachLiveDb(create:true)'));

	const other = makeWorld({
		replicaRows: pairing.rows,
		held: heldLegacyEntry(OFFICER_B),
		listed: [dbNameFor(PAIR_HASH)],
		localVerifyScript: [{ ok: false, reason: 'not-officer' }],
	});
	const otherRun = await runPair(other, { code: pairing.code, confirmSwap: other.confirmWith(true) });
	assert.equal(otherRun.result.ok, true, 'a legacy copy that cannot verify does not gate');
	assert.equal(other.confirmCalls.length, 1);
	assert.equal(other.confirmCalls[0].incomingVerified, false);
	assert.deepEqual(other.confirmCalls[0].held, { userId: OFFICER_B, name: 'Officer B (local)' });
	assert.equal(findNetwork(PAIR_HASH, other.storage)?.pairing?.nonce, pairing.statement.nonce);
});

test('P14 same officer: verified on the held copy, store kept, fresh member storage and key, no confirmation', async () => {
	const pairing = buildPairing({ userId: OFFICER_A });
	const world = makeWorld({ replicaRows: pairing.rows, held: heldPairedEntry(OFFICER_A), listed: [dbNameFor(PAIR_HASH)] });
	const { result } = await runPair(world, { code: pairing.code, confirmSwap: world.confirmWith(true) });
	assert.equal(result.ok, true);
	assert.equal(world.log.includes('confirmSwap'), false);
	assert.equal(world.log.includes('deleteNetworkDb'), false);
	assert.ok(world.log.indexOf('verifyLocal') < world.log.indexOf('deleteMemberStorage'));
	assert.ok(world.log.indexOf('deleteDeviceKeys') < world.log.indexOf('createMemberNode'));

	const failing = makeWorld({
		replicaRows: pairing.rows,
		held: heldPairedEntry(OFFICER_A),
		listed: [dbNameFor(PAIR_HASH)],
		localVerifyScript: [{ ok: false, reason: 'key-not-current' }],
	});
	assert.deepEqual((await runPair(failing, { code: pairing.code })).result, { ok: false, reason: 'officer-not-valid' });
	assert.deepEqual(writesIn(failing.log), []);
});

test('P15 a paired entry with no local copy is replaced like a legacy one; an orphan store is deleted first', async () => {
	const pairing = buildPairing({ userId: OFFICER_B });
	const world = makeWorld({ replicaRows: pairing.rows, held: heldPairedEntry(OFFICER_A), localMissing: true });
	const { result } = await runPair(world, { code: pairing.code, confirmSwap: world.confirmWith(true) });
	assert.equal(result.ok, true);
	assert.deepEqual(world.confirmCalls, [
		{
			networkHash: PAIR_HASH,
			authorityName: AUTHORITY_NAME,
			held: { userId: OFFICER_A, name: null },
			incoming: { userId: OFFICER_B, name: null },
			incomingVerified: false,
		},
	]);

	const orphan = makeWorld({ replicaRows: pairing.rows, listed: [dbNameFor(PAIR_HASH)] });
	const orphanRun = await runPair(orphan, { code: pairing.code });
	assert.equal(orphanRun.result.ok, true);
	assert.ok(orphan.log.indexOf('deleteNetworkDb') >= 0);
	assert.ok(orphan.log.indexOf('deleteNetworkDb') < orphan.log.indexOf('attachLiveDb(create:true)'));
});

// ---------------------------------------------------------------------------
// P16 - P20 cancel, storage, bearer hygiene, never-throws, single flight
// ---------------------------------------------------------------------------

test('P16 cancelled before decode touches nothing; cancelled after the node exists stops it and wipes', async () => {
	const pairing = buildPairing();
	const early = makeWorld({ replicaRows: pairing.rows });
	const controller = new AbortController();
	controller.abort();
	assert.deepEqual((await runPair(early, { code: pairing.code, signal: controller.signal })).result, { ok: false, reason: 'cancelled' });
	assert.deepEqual(early.log, []);

	const late = new AbortController();
	const world = makeWorld({ replicaRows: pairing.rows, abortAfterCreate: late });
	const { result } = await runPair(world, { code: pairing.code, signal: late.signal });
	assert.deepEqual(result, { ok: false, reason: 'cancelled' });
	assert.equal(world.log.includes('joinCadre'), false);
	const afterCreate = world.log.slice(world.log.indexOf('createMemberNode') + 1);
	for (const name of ['memberNode.stop', 'deleteMemberStorage', 'deleteDeviceKeys']) assert.ok(afterCreate.includes(name), name);
});

test('P17 storage failures are no-storage', async () => {
	const pairing = buildPairing();
	const swap = buildPairing({ userId: OFFICER_B });
	const runs = [
		{ opts: { attachCreateThrows: new LiveStoreUnavailableError() }, code: pairing.code },
		{ opts: { createMemberNodeThrows: new DeviceKeyStorageUnavailableError('indexeddb') }, code: pairing.code },
		{ opts: { createMemberNodeThrows: new DeviceKeyCorruptError('record') }, code: pairing.code },
		{ opts: { deleteMemberStorageThrows: new MemberStorageBusyError() }, code: pairing.code },
		{
			opts: { held: heldPairedEntry(OFFICER_A), listed: [dbNameFor(PAIR_HASH)], deleteNetworkDbThrows: Object.assign(new Error('blocked'), { name: 'DeleteBlockedError' }) },
			code: swap.code,
			confirm: true,
		},
		{ opts: { held: heldPairedEntry(OFFICER_A), listed: [dbNameFor(PAIR_HASH)], stuckListed: true }, code: swap.code, confirm: true },
		{ opts: { held: heldPairedEntry(OFFICER_A), listed: [dbNameFor(PAIR_HASH)], attachLocalThrows: new LiveStoreUnavailableError() }, code: swap.code, confirm: true },
	];
	for (const run of runs) {
		const world = makeWorld({ replicaRows: pairing.rows, ...run.opts });
		const { result, lines } = await runPair(world, { code: run.code, confirmSwap: run.confirm ? world.confirmWith(true) : undefined });
		assert.deepEqual(result, { ok: false, reason: 'no-storage' });
		assert.ok(lines.length > 0);
		assert.ok(lines.every((line) => line[0] === 'peer/pairing:' && line.length === 2));
	}
});

test('P17 a store that reappears once after its delete and is gone after a second delete still pairs', async () => {
	const pairing = buildPairing({ userId: OFFICER_B });
	const world = makeWorld({ replicaRows: pairing.rows, held: heldPairedEntry(OFFICER_A), listed: [dbNameFor(PAIR_HASH)], resurrect: 1 });
	const { result } = await runPair(world, { code: pairing.code, confirmSwap: world.confirmWith(true) });
	assert.equal(result.ok, true);
	assert.equal(world.log.filter((n) => n === 'deleteNetworkDb').length, 2);
});

test('P18 bearer hygiene: no log line, resolved value or registry blob carries the code, the invitation or its key', async () => {
	const SENTINEL = 'SENTINELpairingR9x7k';
	const pairing = buildPairing({ partyId: `party-${SENTINEL}`, name: `Net ${SENTINEL}` });
	const banned = [SENTINEL, pairing.invitation.invitePrivateKey, pairing.invitationText, pairing.code];
	/** @type {Array<{ opts: any, code: string }>} */
	const paths = [
		{ opts: {}, code: pairing.code },
		{ opts: {}, code: pairing.code.slice(0, -3) + '!!!' },
		{ opts: { replicaRows: foundingRows(GEN_2) }, code: pairing.code },
		{ opts: { verifyScript: [{ ok: false, reason: 'bad-signature' }] }, code: pairing.code },
		{ opts: { createMemberNodeThrows: Object.assign(new Error(`${pairing.code} ${SENTINEL}`), { name: 'DeviceKeyStorageUnavailableError' }) }, code: pairing.code },
		{ opts: { joinScript: [() => Promise.reject(new Error(`refused ${pairing.invitationText}`))] }, code: pairing.code },
	];
	for (const path of paths) {
		const world = makeWorld({ replicaRows: pairing.rows, ...path.opts });
		const { result, lines } = await runPair(world, { code: path.code });
		const resolved = JSON.stringify({ ...result, handoff: undefined });
		const logged = JSON.stringify(lines);
		const blob = world.storage._blob();
		for (const value of banned) {
			assert.equal(resolved.includes(value), false);
			assert.equal(logged.includes(value), false);
			assert.equal(blob.includes(value), false);
		}
	}
});

test('P19 every collaborator throwing a plain Error resolves a closed failure and logs only its name', async () => {
	const pairing = buildPairing();
	const boom = () => new Error('plain failure');
	const runs = [
		[{ createMemberNodeThrows: boom() }, 'no-storage'],
		[{ deleteMemberStorageThrows: boom() }, 'no-storage'],
		[{ deleteDeviceKeysThrows: boom() }, 'no-storage'],
		[{ attachCreateThrows: boom() }, 'no-storage'],
		[{ upsertThrows: boom() }, 'no-storage'],
		[{ joinScript: [() => Promise.reject(boom())] }, 'unreachable'],
		[{ waitForStrandThrows: boom() }, 'unreachable'],
		[{ openStrandReaderThrows: boom() }, 'unreachable'],
		[{ readGenesisRowsThrows: boom() }, 'unreachable'],
		[{ adminGenerationsThrows: boom() }, 'unreachable'],
		[{ revokedThrows: boom() }, 'unreachable'],
		[{ verifyThrows: boom() }, 'unreachable'],
	];
	for (const [opts, reason] of runs) {
		const world = makeWorld({ replicaRows: pairing.rows, .../** @type {object} */ (opts) });
		const { result, lines } = await runPair(world, { code: pairing.code });
		assert.deepEqual(result, { ok: false, reason });
		assert.ok(lines.some((line) => line[0] === 'peer/pairing:' && line[1] === 'Error'));
		assert.ok(lines.every((line) => line[0] === 'peer/pairing:' && line.length === 2));
	}
});

test('P20 a second pairing while one is in flight is cancelled at once and touches nothing', async () => {
	const pairing = buildPairing();
	/** @type {() => void} */
	let release = () => {};
	const gate = new Promise((resolve) => {
		release = () => resolve(undefined);
	});
	const first = makeWorld({ replicaRows: pairing.rows, joinScript: [async () => (await gate, 'joined')] });
	const second = makeWorld({ replicaRows: pairing.rows });
	const firstRun = runPair(first, { code: pairing.code });
	await new Promise((resolve) => setImmediate(resolve));
	const secondRun = await runPair(second, { code: pairing.code });
	assert.deepEqual(secondRun.result, { ok: false, reason: 'cancelled' });
	assert.deepEqual(second.log, []);
	release();
	assert.equal((await firstRun).result.ok, true);
});

// ---------------------------------------------------------------------------
// P21 - P23 the strand reader and the officer name
// ---------------------------------------------------------------------------

test('P21 reader injection: no reader is unsupported with nothing touched; the reader gets its arguments and current() precedes every strand read', async () => {
	const pairing = buildPairing();
	const bare = makeWorld({ replicaRows: pairing.rows });
	const { openStrandReader: _omitted, ...withoutReader } = bare.deps;
	const unsupported = await captureConsole(() => pairBrowser({ code: pairing.code, deps: /** @type {any} */ (withoutReader) }));
	assert.deepEqual(unsupported.v, { ok: false, reason: 'unsupported' });
	assert.deepEqual(bare.log, []);

	const world = makeWorld({ replicaRows: pairing.rows, verifyScript: [{ ok: false, reason: 'not-officer' }, { ok: true }] });
	const { result } = await runPair(world, { code: pairing.code });
	assert.equal(result.ok, true);
	assert.equal(world.readerArgs.memberNode, world.memberNode);
	assert.equal(world.readerArgs.strandId, PAIR_HASH);
	assert.ok(world.readerArgs.signal instanceof AbortSignal);
	assert.ok(world.log.indexOf('waitForStrand') < world.log.indexOf('openStrandReader'));
	const READS = ['readGenesisRows', 'adminGenerations', 'isPairingRevoked', 'verifyPairingStatement'];
	world.log.forEach((name, i) => {
		if (READS.includes(name)) assert.equal(world.log[i - 1], 'current', name);
	});
	assert.equal(world.log.filter((n) => n === 'verifyPairingStatement').length, 2);
});

test('P22 the reader db getter throws while current() resolves, and pairing still completes', async () => {
	const pairing = buildPairing();
	const world = makeWorld({ replicaRows: pairing.rows });
	const { result } = await runPair(world, { code: pairing.code });
	assert.equal(result.ok, true);
	assert.equal(world.dbGetterHits, 0);
	assert.equal(world.log.includes('memberNode.stop'), false);
	assert.equal(world.log.includes('deleteNetworkDb'), false);
});

test('P23 officerName comes from the strand User.Name and is omitted when no name is known', async () => {
	const pairing = buildPairing({ userId: OFFICER_B });
	const named = makeWorld({ replicaRows: pairing.rows, strandNames: { [OFFICER_B]: '  Officer Bee  ' } });
	assert.equal((await runPair(named, { code: pairing.code })).result.ok, true);
	assert.equal(findNetwork(PAIR_HASH, named.storage)?.officerName, 'Officer Bee');

	const unnamed = makeWorld({ replicaRows: pairing.rows, strandNames: {} });
	assert.equal((await runPair(unnamed, { code: pairing.code })).result.ok, true);
	const entry = findNetwork(PAIR_HASH, unnamed.storage);
	assert.equal(Object.hasOwn(/** @type {object} */ (entry), 'officerName'), false);
});
