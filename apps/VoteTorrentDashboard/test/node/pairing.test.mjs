/**
 * Tier-1 coverage of `src/peer/pairing.js`: the per-pass pairing check (D-27) with a real-crypto
 * proof, the closed failure and phase sets, and the module's hygiene scans.
 *
 * Every collaborator is injected; no real timer, network or IndexedDB is involved except where a
 * case says so. No test title carries a value.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Database } from '@quereus/quereus';
import { p256 } from '@noble/curves/nist.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { registerDbPlugins, toCanonicalDatetime } from '@votetorrent/vote-engine/browser';
import { pairingStatementDigest } from '@votetorrent/vote-engine';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';
import {
	PAIR_FAILURES,
	PAIR_PROGRESS_PHASES,
	JOIN_FAILURE_TO_PAIR_FAILURE,
	PairingCheckUnavailableError,
	checkPairingStillValid,
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
