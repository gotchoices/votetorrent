/**
 * pairing.js -- the browser half of pairing: a pasted or scanned pairing code becomes a verified,
 * admitted member device of the network's cadre, and every completed replication pass re-checks
 * that the pairing still stands.
 *
 * WHAT PAIRING IS (D-06, D-26). An officer's phone shows a single-use code. It carries two things:
 * an invitation that an OWNER of the network's cadre minted for this one pairing (single use, so
 * a copied code cannot admit a second browser), and a statement the OFFICER signed with their own
 * device key, naming the network, the officer, a nonce, an expiry and the phone that asked for
 * the code. The invitation admits the browser as a member DEVICE (D-01, D-04): it never holds an
 * officer key, and this file calls no signing API. The statement tells the browser which officer
 * it is working for; the browser verifies it against the network's own rows.
 *
 * THE ORDER, WHICH IS THE SECURITY PROPERTY. Decode; classify and verify against the held copy;
 * confirm; remove the old pairing; new device key PERSISTED; redeem; first sync; founding anchor;
 * statement; store; registry LAST. Nothing is deleted before the incoming officer verified against
 * the copy this browser already holds and the user confirmed a swap. The device key exists before
 * the single-use invitation is spent, so a lost reply is retried with the same identity rather than
 * burning the invitation on a second key.
 *
 * WHY THE ANCHOR PRECEDES THE STATEMENT. The statement is verified against Officer and UserKey rows
 * that arrived from strand peers. Those rows mean something only once the strand is proven to be
 * the network the code names: the founding rows must hash to the code's digest, derive the code's
 * network hash, name the code's authority as primary, and the code's Admin generation must be the
 * earliest one in the replica. Until that passes, a hostile peer could have served any rows.
 *
 * BEARER HYGIENE (R-9, R-10). The code, the invitation inside it and the statement are bearer
 * material. This file never logs, echoes or returns them, and never puts them in an error message.
 * Every log line is a fixed prefix and an error name; errors carry closed reasons only.
 *
 * THE PER-PASS CHECK (D-27). `checkPairingStillValid` runs after every completed replication pass.
 * It reads the revocation row for this pairing and re-verifies the statement's key and signature
 * (never its 15-minute expiry). The revocation row is trusted because the strand applied the
 * schema's CHECK when it was written; the row carries no signature the browser could re-verify.
 * Enforcement is cooperative, which is why owners also remove the browser's machine from the
 * cadre. Per R-B the check reads no Admin rows: an officer's removal from the administration does
 * not by itself unpair their browsers; revocation does.
 */

import {
	decodePairingCode,
	decodeNetworkJoinCode,
	computeContentDigest,
	readGenesisRows,
	FOUNDING_BUNDLE_TABLE_ORDER,
	deriveFoundingDescriptor,
	verifyPairingStatement,
	isPairingRevoked,
	toCanonicalDatetime,
	fromCanonicalDatetime,
	nowCanonicalDatetime,
} from '@votetorrent/vote-engine/browser';
import { decodeCadreInvitation } from '@serfab/cadre-core';
import {
	attachLiveDb,
	closeNetworkDb,
	deleteNetworkDb,
	dbNameFor,
	clearRowCounts,
	findNetwork,
	upsertNetwork,
	removeNetwork,
	isLegacyEntry,
	PAIRING_RELAY_ADDRS_MAX,
} from '@votetorrent/web-data/officer';
import { createIdbKeyStore, deleteDeviceKeys } from './idb-key-store.js';
import { createMemberNode, deleteMemberStorage } from './member-node.js';
import { classifyPairing } from '../lifecycle/officer-swap.js';

/** The fixed prefix of every log line this module writes. */
const LOG_PREFIX = 'peer/pairing:';

/**
 * Log a failure by its error name and nothing else.
 *
 * @param {unknown} err
 * @returns {void}
 */
function logFailure(err) {
	const name = err && typeof (/** @type {any} */ (err).name) === 'string' ? /** @type {any} */ (err).name : 'Error';
	console.error(LOG_PREFIX, name);
}

// ── Closed sets and constants ───────────────────────────────────────────────

/** Every way `pairBrowser` can fail, in contract order. */
export const PAIR_FAILURES = Object.freeze(
	/** @type {const} */ ([
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
	]),
);

/** The progress phases `pairBrowser` reports, each at most once and in this order. */
export const PAIR_PROGRESS_PHASES = Object.freeze(
	/** @type {const} */ (['verifying', 'connecting', 'joining', 'first-sync']),
);

/** The member node's join refusals mapped to pairing failures. */
export const JOIN_FAILURE_TO_PAIR_FAILURE = Object.freeze(
	/** @type {const} */ ({
		malformed: 'malformed',
		'not-invitation': 'malformed',
		'party-mismatch': 'malformed',
		invalid: 'malformed',
		'owner-key': 'malformed',
		spent: 'spent',
		removed: 'spent',
		unreachable: 'unreachable',
		cancelled: 'cancelled',
	}),
);

/** How many times one invitation is redeemed (the second only after an `unreachable`). */
export const PAIR_REDEEM_ATTEMPTS = 2;
/** The wait before the second redemption. */
export const PAIR_REDEEM_RETRY_DELAY_MS = 3_000;
/**
 * The deadline, from the pairing instant, for the strand to come up (`waitForStrand`), and for the
 * founding check and the statement once the strand database is open. The wait for that database is NOT
 * under it: the strand reader ends that wait on its own stall window or hard cap (`strand-read.js`), so a
 * slow first build that is still receiving data is not cut off here (gap G-3).
 */
export const PAIR_FIRST_SYNC_TIMEOUT_MS = 180_000;
/**
 * The least time the founding check and the statement get after the strand database opened. Only a
 * database that opened late (after the first minute) is affected: until then the 180 s deadline above is
 * the later one. Why 120 s: on the fast rig those two steps took about 10 s after the database appeared,
 * and the slow-phone diagnostic answered about 5x slower, so about 50 s; 120 s clears that by more than 2x.
 */
export const PAIR_AFTER_STRAND_DB_MS = 120_000;
/** The interval between reads while waiting for replicated rows. */
export const PAIR_SYNC_POLL_MS = 500;

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * The per-pass check could not read what it needs. NOT a signal to unpair: the caller keeps the
 * pairing and checks again on the next pass.
 */
export class PairingCheckUnavailableError extends Error {
	/** @param {'revocation' | 'statement'} subject */
	constructor(subject) {
		super('The pairing could not be checked right now.');
		this.name = 'PairingCheckUnavailableError';
		/** @type {'revocation' | 'statement'} */
		this.subject = subject;
	}
}

// ── Strand reader access ────────────────────────────────────────────────────

/**
 * The database a strand reader currently serves. `current()` re-resolves, waits for and prepares
 * the strand database (it can be rebuilt between reads), so it is awaited before every read and
 * never cached across reads.
 *
 * @param {{ current: () => Promise<any>, db?: any }} reader
 * @returns {Promise<any>}
 */
async function resolveStrandDb(reader) {
	const resolved = await reader.current();
	if (resolved !== undefined) return resolved;
	return reader.db;
}

/**
 * @param {unknown} db
 * @returns {db is { current: () => Promise<any> }}
 */
function isStrandReader(db) {
	return db !== null && typeof db === 'object' && typeof (/** @type {any} */ (db).current) === 'function';
}

// ── Per-pass check (D-27) ───────────────────────────────────────────────────

/**
 * @typedef {object} PairingCheckDeps
 * @property {typeof isPairingRevoked} [isPairingRevoked]
 * @property {typeof verifyPairingStatement} [verifyPairingStatement]
 * @property {() => string} [nowCanonical]
 */

/**
 * Is this browser's pairing for `networkHash` still valid?
 *
 * Callers wipe only on a resolved `{ ok: false }`. A rejection (`PairingCheckUnavailableError`)
 * means the check could not read its rows; the pairing stands until a later pass decides.
 *
 * `db` is the LOCAL store handle (call after a completed pass, which has just replicated the
 * pairing tables into it), or a strand reader (an object whose `current` is a function), whose
 * database is re-resolved before each read.
 *
 * @param {{ db: any, networkHash: string, entry: import('@votetorrent/web-data/officer').NetworkRegistryEntry, deps?: PairingCheckDeps }} options
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'revoked' | 'key-invalid' }>}
 */
export async function checkPairingStillValid({ db, networkHash, entry, deps = {} }) {
	if (db === null || db === undefined) {
		throw new TypeError('checkPairingStillValid: db is required');
	}
	if (typeof networkHash !== 'string' || networkHash.length === 0) {
		throw new TypeError('checkPairingStillValid: networkHash must be a non-empty string');
	}
	if (entry === null || typeof entry !== 'object' || isLegacyEntry(entry)) {
		throw new TypeError('checkPairingStillValid: entry must be a paired registry entry');
	}
	if (entry.networkHash !== networkHash) {
		throw new TypeError('checkPairingStillValid: entry belongs to a different network');
	}
	const pairing = /** @type {import('@votetorrent/web-data/officer').PairingRecord} */ (entry.pairing);
	const revoked = deps.isPairingRevoked ?? isPairingRevoked;
	const verify = deps.verifyPairingStatement ?? verifyPairingStatement;
	const nowCanonical = deps.nowCanonical ?? nowCanonicalDatetime;
	const reader = isStrandReader(db) ? db : null;

	let isRevoked;
	try {
		const handle = reader ? await resolveStrandDb(reader) : db;
		isRevoked = await revoked(handle, { userId: entry.officerUserId, nonce: pairing.nonce });
	} catch (err) {
		logFailure(err);
		throw new PairingCheckUnavailableError('revocation');
	}
	if (isRevoked === true) return { ok: false, reason: 'revoked' };

	const statement = {
		userId: entry.officerUserId,
		requesterPeerId: pairing.requesterPeerId,
		nonce: pairing.nonce,
		expiresAt: pairing.expiresAt,
		keyPub: pairing.keyPub,
		sig: pairing.sig,
	};
	let result;
	try {
		const handle = reader ? await resolveStrandDb(reader) : db;
		// C-3: a per-pass check never applies the statement's 15-minute expiry.
		result = await verify(handle, { networkHash, statement, nowCanonical: nowCanonical(), checkExpiry: false });
	} catch (err) {
		logFailure(err);
		throw new PairingCheckUnavailableError('statement');
	}
	if (result && result.ok === true) return { ok: true };
	return { ok: false, reason: 'key-invalid' };
}

// ── Relay addresses (D-18) ──────────────────────────────────────────────────

/** The longest relay address kept. */
const RELAY_ADDR_MAX_CHARS = 1024;

/**
 * The relay addresses this browser reserves on, taken from the invitation's member addresses: for
 * every `/p2p-circuit` member address, the relay prefix before it. Prefixes must name the relay
 * peer (`/p2p/`), carry no whitespace and stay within 1024 characters; they are de-duplicated in
 * first-seen order and capped at `PAIRING_RELAY_ADDRS_MAX`. A member address without a circuit is
 * ignored: the browser dials relays only.
 *
 * @param {unknown} members
 * @returns {string[]}
 */
export function deriveRelayAddrs(members) {
	if (!Array.isArray(members)) return [];
	/** @type {string[]} */
	const out = [];
	for (const member of members) {
		if (typeof member !== 'string') continue;
		const at = member.indexOf('/p2p-circuit');
		if (at <= 0) continue;
		const prefix = member.slice(0, at);
		if (!prefix.includes('/p2p/') || /\s/.test(prefix) || prefix.length > RELAY_ADDR_MAX_CHARS) continue;
		if (!out.includes(prefix)) out.push(prefix);
		if (out.length >= PAIRING_RELAY_ADDRS_MAX) break;
	}
	return out;
}

// ── Pairing: collaborators ──────────────────────────────────────────────────

/**
 * Every collaborator `pairBrowser` uses; each defaults to the real implementation except
 * `openStrandReader`, which the caller must pass (the real strand reader is wired by the pairing
 * screen and the boot path, never imported here).
 *
 * @typedef {object} PairDeps
 * @property {(options: { memberNode: any, strandId: string, signal?: AbortSignal }) => Promise<{ current: () => Promise<any>, db?: any, close?: () => Promise<void> | void }>} [openStrandReader]
 * @property {typeof decodePairingCode} [decodePairingCode]
 * @property {typeof decodeNetworkJoinCode} [decodeNetworkJoinCode]
 * @property {typeof decodeCadreInvitation} [decodeCadreInvitation]
 * @property {typeof computeContentDigest} [computeContentDigest]
 * @property {typeof readGenesisRows} [readGenesisRows]
 * @property {typeof deriveFoundingDescriptor} [deriveFoundingDescriptor]
 * @property {(db: any, authorityId: string) => Promise<unknown[]>} [adminGenerations]
 * @property {typeof verifyPairingStatement} [verifyPairingStatement]
 * @property {typeof isPairingRevoked} [isPairingRevoked]
 * @property {typeof toCanonicalDatetime} [toCanonicalDatetime]
 * @property {typeof fromCanonicalDatetime} [fromCanonicalDatetime]
 * @property {typeof attachLiveDb} [attachLiveDb]
 * @property {typeof closeNetworkDb} [closeNetworkDb]
 * @property {typeof deleteNetworkDb} [deleteNetworkDb]
 * @property {typeof dbNameFor} [dbNameFor]
 * @property {typeof clearRowCounts} [clearRowCounts]
 * @property {typeof findNetwork} [findNetwork]
 * @property {typeof upsertNetwork} [upsertNetwork]
 * @property {typeof removeNetwork} [removeNetwork]
 * @property {typeof isLegacyEntry} [isLegacyEntry]
 * @property {any} [storage] the registry's storage adapter; absent means the registry's own default
 * @property {typeof createIdbKeyStore} [createIdbKeyStore]
 * @property {typeof deleteDeviceKeys} [deleteDeviceKeys]
 * @property {typeof createMemberNode} [createMemberNode]
 * @property {typeof deleteMemberStorage} [deleteMemberStorage]
 * @property {typeof classifyPairing} [classifyPairing]
 * @property {{ databases?: () => Promise<Array<{ name?: string }>> } | undefined} [indexedDB]
 * @property {() => number} [now]
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} [sleep]
 */

/**
 * A timer promise that resolves after `ms`, or at once when `signal` aborts (the caller checks the
 * signal afterwards).
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function defaultSleep(ms, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener('abort', done, { once: true });
	});
}

/**
 * Every Admin generation of one authority in the replica: plain equality, no compound predicate.
 *
 * @param {any} db
 * @param {string} authorityId
 * @returns {Promise<unknown[]>}
 */
async function readAdminGenerations(db, authorityId) {
	/** @type {unknown[]} */
	const out = [];
	for await (const row of db.eval('select EffectiveAt from Admin where AuthorityId = :authorityId', { authorityId })) {
		out.push(/** @type {any} */ (row).EffectiveAt);
	}
	return out;
}

/** @param {PairDeps} deps */
function resolveDeps(deps) {
	return {
		decodePairingCode: deps.decodePairingCode ?? decodePairingCode,
		decodeNetworkJoinCode: deps.decodeNetworkJoinCode ?? decodeNetworkJoinCode,
		decodeCadreInvitation: deps.decodeCadreInvitation ?? decodeCadreInvitation,
		computeContentDigest: deps.computeContentDigest ?? computeContentDigest,
		readGenesisRows: deps.readGenesisRows ?? readGenesisRows,
		deriveFoundingDescriptor: deps.deriveFoundingDescriptor ?? deriveFoundingDescriptor,
		adminGenerations: deps.adminGenerations ?? readAdminGenerations,
		verifyPairingStatement: deps.verifyPairingStatement ?? verifyPairingStatement,
		isPairingRevoked: deps.isPairingRevoked ?? isPairingRevoked,
		toCanonicalDatetime: deps.toCanonicalDatetime ?? toCanonicalDatetime,
		fromCanonicalDatetime: deps.fromCanonicalDatetime ?? fromCanonicalDatetime,
		attachLiveDb: deps.attachLiveDb ?? attachLiveDb,
		closeNetworkDb: deps.closeNetworkDb ?? closeNetworkDb,
		deleteNetworkDb: deps.deleteNetworkDb ?? deleteNetworkDb,
		dbNameFor: deps.dbNameFor ?? dbNameFor,
		clearRowCounts: deps.clearRowCounts ?? clearRowCounts,
		findNetwork: deps.findNetwork ?? findNetwork,
		upsertNetwork: deps.upsertNetwork ?? upsertNetwork,
		removeNetwork: deps.removeNetwork ?? removeNetwork,
		isLegacyEntry: deps.isLegacyEntry ?? isLegacyEntry,
		storage: deps.storage,
		createIdbKeyStore: deps.createIdbKeyStore ?? createIdbKeyStore,
		deleteDeviceKeys: deps.deleteDeviceKeys ?? deleteDeviceKeys,
		createMemberNode: deps.createMemberNode ?? createMemberNode,
		deleteMemberStorage: deps.deleteMemberStorage ?? deleteMemberStorage,
		classifyPairing: deps.classifyPairing ?? classifyPairing,
		indexedDB: 'indexedDB' in deps ? deps.indexedDB : globalThis.indexedDB,
		now: deps.now ?? Date.now,
		sleep: deps.sleep ?? defaultSleep,
	};
}

// ── Pairing: internals ──────────────────────────────────────────────────────

/** A pairing stage failed for one closed reason. Internal; never leaves this module. */
class PairStageFailure extends Error {
	/** @param {(typeof PAIR_FAILURES)[number]} reason */
	constructor(reason) {
		super('pairing stage failed');
		this.name = 'PairStageFailure';
		this.reason = reason;
	}
}

/** The local store stayed listed after every settle round. */
function deleteBlockedError() {
	const err = new Error('The local store could not be removed.');
	err.name = 'DeleteBlockedError';
	return err;
}

/** How many delete-then-settle rounds run before the store counts as blocked. */
const DELETE_SETTLE_ROUNDS = 8;
/** The pause between settle rounds. */
const DELETE_SETTLE_PAUSE_MS = 25;

/** Decode refusals mapped to pairing failures. */
const PAIRING_CODE_FAILURES = Object.freeze({
	malformed: 'malformed',
	'not-pairing-code': 'malformed',
	'unsupported-version': 'unsupported',
	'old-style-code': 'old-style',
});
const JOIN_CODE_FAILURES = Object.freeze({
	malformed: 'malformed',
	'not-join-code': 'malformed',
	'unsupported-version': 'unsupported',
	'invitation-older-version': 'unsupported',
});

/** What the registry accepts as `officerName` (display text only). */
const OFFICER_NAME_MAX_CHARS = 200;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

/**
 * @param {unknown} name
 * @returns {string | null}
 */
function usableOfficerName(name) {
	if (typeof name !== 'string') return null;
	const trimmed = name.trim();
	if (trimmed.length === 0 || trimmed.length > OFFICER_NAME_MAX_CHARS || CONTROL_CHAR_RE.test(trimmed)) return null;
	return trimmed;
}

/**
 * A user's display name from a database handle, or null on a miss or any failure.
 *
 * @param {any} db
 * @param {string} userId
 * @returns {Promise<string | null>}
 */
async function readUserName(db, userId) {
	if (!db || typeof db.prepare !== 'function') return null;
	try {
		const row = await db.prepare('select Name from User where Id = :userId').get({ userId });
		const name = row ? /** @type {any} */ (row).Name : null;
		return typeof name === 'string' ? name : null;
	} catch (err) {
		logFailure(err);
		return null;
	}
}

/** Only one pairing runs per tab at a time. */
let pairingInFlight = false;

// ── Pairing (D-01, D-04, D-06, D-09, D-12, D-18, D-26) ──────────────────────

/**
 * @typedef {{ ok: true, networkHash: string, handoff: { memberNode: any, strandReader: any } } | { ok: false, reason: (typeof PAIR_FAILURES)[number] }} PairResult
 */

/**
 * @typedef {object} SwapConfirmation
 * @property {string} networkHash
 * @property {string} authorityName
 * @property {{ userId: string, name: string | null }} held
 * @property {{ userId: string, name: string | null }} incoming
 * @property {boolean} incomingVerified
 */

/**
 * Pair this browser from an officer's pairing code. Never throws.
 *
 * On success the caller owns `handoff.memberNode` and `handoff.strandReader`; the local store
 * exists, is initialized and is closed; the registry entry is written. Callers import this module
 * with a dynamic `import()`, stop any running boot for the network first, and pass
 * `deps.openStrandReader` (without it the result is `unsupported` and nothing is touched).
 *
 * @param {{ code: unknown, onProgress?: (phase: (typeof PAIR_PROGRESS_PHASES)[number]) => void, confirmSwap?: (details: SwapConfirmation) => boolean | Promise<boolean>, signal?: AbortSignal, deps?: PairDeps }} options
 * @returns {Promise<PairResult>}
 */
export async function pairBrowser(options) {
	const { code, onProgress, confirmSwap, signal, deps = {} } = options ?? /** @type {any} */ ({});
	if (pairingInFlight) return { ok: false, reason: 'cancelled' };
	if (typeof deps?.openStrandReader !== 'function') {
		logFailure(new TypeError('openStrandReader missing'));
		return { ok: false, reason: 'unsupported' };
	}
	pairingInFlight = true;
	try {
		return await runPairing({ code, onProgress, confirmSwap, signal, openStrandReader: deps.openStrandReader, d: resolveDeps(deps) });
	} catch (err) {
		logFailure(err);
		return { ok: false, reason: 'unreachable' };
	} finally {
		pairingInFlight = false;
	}
}

/**
 * @param {{ code: unknown, onProgress?: Function, confirmSwap?: Function, signal?: AbortSignal, openStrandReader: NonNullable<PairDeps['openStrandReader']>, d: ReturnType<typeof resolveDeps> }} ctx
 * @returns {Promise<PairResult>}
 */
async function runPairing({ code, onProgress, confirmSwap, signal, openStrandReader, d }) {
	/** @type {Set<string>} */
	const emitted = new Set();
	/** @param {(typeof PAIR_PROGRESS_PHASES)[number]} phase */
	const emit = (phase) => {
		if (emitted.has(phase)) return;
		emitted.add(phase);
		if (typeof onProgress !== 'function') return;
		try {
			onProgress(phase);
		} catch (err) {
			logFailure(err);
		}
	};

	/** @type {'none' | 'local' | 'full'} */
	let cleanupLevel = 'none';
	/** @type {any} */
	let localHandle = null;
	/** @type {any} */
	let memberNode = null;
	/** @type {any} */
	let strandReader = null;
	/** @type {any} */
	let heldEntry = null;
	let networkHash = '';

	const closeLocal = async () => {
		if (!localHandle) return;
		const handle = localHandle;
		localHandle = null;
		try {
			await d.closeNetworkDb(handle);
		} catch (err) {
			logFailure(err);
		}
	};

	/**
	 * Delete this network's local store and confirm it stays gone: the IndexedDB empty-shell
	 * resurrection (a delete reported successful, then the name listed again) is waited out for a
	 * bounded number of rounds. A fresh `attachLiveDb({ create: true })` on an empty shell is safe;
	 * on old rows it never is, which is why a persistent listing fails the pairing.
	 */
	const deleteStoreSettled = async () => {
		await d.deleteNetworkDb(networkHash, d.storage === undefined ? {} : { storage: d.storage });
		const databases = d.indexedDB?.databases?.bind(d.indexedDB);
		if (typeof databases !== 'function') return;
		const name = d.dbNameFor(networkHash);
		const listed = async () => (await databases()).some((info) => info?.name === name);
		for (let round = 0; round < DELETE_SETTLE_ROUNDS && (await listed()); round += 1) {
			await d.sleep(DELETE_SETTLE_PAUSE_MS);
			await d.deleteNetworkDb(networkHash, d.storage === undefined ? {} : { storage: d.storage });
		}
		if (await listed()) throw deleteBlockedError();
	};

	/** @param {() => Promise<unknown>} step */
	const quietly = async (step) => {
		try {
			await step();
		} catch (err) {
			logFailure(err);
		}
	};

	const fullCleanup = async () => {
		await closeLocal();
		if (memberNode) await quietly(() => memberNode.stop());
		if (strandReader && typeof strandReader.close === 'function') await quietly(async () => strandReader.close());
		await quietly(deleteStoreSettled);
		await quietly(() => d.deleteMemberStorage(networkHash));
		await quietly(() => d.deleteDeviceKeys(networkHash));
		if (heldEntry) await quietly(async () => d.removeNetwork(networkHash, d.storage));
	};

	/**
	 * @param {(typeof PAIR_FAILURES)[number]} reason
	 * @returns {Promise<PairResult>}
	 */
	const fail = async (reason) => {
		if (cleanupLevel === 'full') await fullCleanup();
		else await closeLocal();
		return { ok: false, reason };
	};

	const aborted = () => signal?.aborted === true;

	/**
	 * Run one stage; a throw is logged by name and becomes `reason` (or `cancelled` once aborted).
	 *
	 * @template T
	 * @param {(typeof PAIR_FAILURES)[number]} reason
	 * @param {() => Promise<T> | T} step
	 * @returns {Promise<T>}
	 */
	const stage = async (reason, step) => {
		if (aborted()) throw new PairStageFailure('cancelled');
		try {
			return await step();
		} catch (err) {
			if (err instanceof PairStageFailure) throw err;
			logFailure(err);
			throw new PairStageFailure(aborted() ? 'cancelled' : reason);
		}
	};

	try {
		if (aborted()) return { ok: false, reason: 'cancelled' };

		// 1. Decode. Nothing is touched until every decode passed.
		emit('verifying');
		if (typeof code !== 'string') return { ok: false, reason: 'malformed' };
		/** @type {any} */
		let decoded;
		try {
			decoded = d.decodePairingCode(code);
		} catch (err) {
			logFailure(err);
			const mapped = /** @type {Record<string, string>} */ (PAIRING_CODE_FAILURES)[/** @type {any} */ (err)?.reason];
			return { ok: false, reason: /** @type {any} */ (mapped ?? 'malformed') };
		}
		const statement = decoded.statement;
		/** @type {any} */
		let joined;
		try {
			joined = d.decodeNetworkJoinCode(decoded.joinCode);
		} catch (err) {
			logFailure(err);
			return { ok: false, reason: 'malformed' };
		}
		if (!joined || joined.ok !== true) {
			const mapped = /** @type {Record<string, string>} */ (JOIN_CODE_FAILURES)[joined?.reason];
			return { ok: false, reason: /** @type {any} */ (mapped ?? 'malformed') };
		}
		const joinCode = joined.code;
		/** @type {any} */
		let invitation;
		try {
			invitation = d.decodeCadreInvitation(joinCode.invitation);
		} catch (err) {
			logFailure(err);
			return { ok: false, reason: 'malformed' };
		}
		const relayAddrs = deriveRelayAddrs(invitation?.members);
		if (relayAddrs.length === 0) return { ok: false, reason: 'unreachable' };
		networkHash = joinCode.networkHash;
		const strandId = networkHash;
		const genesis = joinCode.genesis;

		const pairingInstantMs = d.now();
		const pairingInstant = d.toCanonicalDatetime(pairingInstantMs);
		let expiresAtMs;
		try {
			expiresAtMs = d.fromCanonicalDatetime(statement.expiresAt);
		} catch (err) {
			logFailure(err);
			return { ok: false, reason: 'malformed' };
		}
		if (!Number.isFinite(expiresAtMs)) return { ok: false, reason: 'malformed' };
		if (expiresAtMs <= pairingInstantMs) return { ok: false, reason: 'expired' };
		if (aborted()) return { ok: false, reason: 'cancelled' };

		// 2. Classify by the claimed officer, then verify the claim against the held copy.
		const kind = await stage('no-storage', () =>
			d.classifyPairing({
				networkHash,
				claimedUserId: statement.userId,
				registry: {
					findNetwork: (/** @type {string} */ hash) => d.findNetwork(hash, d.storage),
					isLegacyEntry: d.isLegacyEntry,
				},
			}),
		);
		heldEntry = kind === 'new-network' ? null : await stage('no-storage', () => d.findNetwork(networkHash, d.storage));
		cleanupLevel = 'local';

		if (heldEntry) {
			try {
				localHandle = await d.attachLiveDb(networkHash, { create: false });
			} catch (err) {
				if (/** @type {any} */ (err)?.name !== 'LiveStoreMissingError') {
					logFailure(err);
					return await fail(aborted() ? 'cancelled' : 'no-storage');
				}
				localHandle = null;
			}
		}
		const effectiveKind = (kind === 'same-officer' || kind === 'officer-swap') && !localHandle ? 'legacy-replace' : kind;
		const heldName = heldEntry && localHandle ? await readUserName(localHandle, heldEntry.officerUserId) : null;
		const incomingLocalName = localHandle ? await readUserName(localHandle, statement.userId) : null;
		const verifyArgs = { networkHash, statement, nowCanonical: pairingInstant, checkExpiry: true };

		let incomingVerified = false;
		if (effectiveKind === 'same-officer' || effectiveKind === 'officer-swap') {
			const local = await stage('no-storage', () => d.verifyPairingStatement(localHandle, verifyArgs));
			if (!local || local.ok !== true) return await fail(local?.reason === 'expired' ? 'expired' : 'officer-not-valid');
			incomingVerified = true;
		} else if (effectiveKind === 'legacy-replace' && localHandle) {
			try {
				const local = await d.verifyPairingStatement(localHandle, verifyArgs);
				incomingVerified = local?.ok === true;
			} catch (err) {
				logFailure(err);
			}
		}

		// 3. Confirm a change of officer, naming both. Nothing has been deleted yet.
		const needsConfirm =
			effectiveKind === 'officer-swap' ||
			(effectiveKind === 'legacy-replace' && heldEntry !== null && heldEntry.officerUserId !== statement.userId);
		if (needsConfirm) {
			let confirmed = false;
			if (typeof confirmSwap === 'function') {
				try {
					confirmed =
						(await confirmSwap({
							networkHash,
							authorityName: heldEntry.authorityName,
							held: { userId: heldEntry.officerUserId, name: heldName },
							incoming: { userId: statement.userId, name: incomingLocalName },
							incomingVerified,
						})) === true;
				} catch (err) {
					logFailure(err);
					confirmed = false;
				}
			}
			if (!confirmed) return await fail('swap-declined');
		}
		if (aborted()) return await fail('cancelled');

		// 4. Remove the old pairing. From here on every failure removes the half-made pairing.
		cleanupLevel = 'full';
		await closeLocal();
		if (effectiveKind === 'officer-swap' || effectiveKind === 'legacy-replace') {
			await stage('no-storage', deleteStoreSettled);
			if (effectiveKind === 'legacy-replace') await stage('no-storage', async () => d.clearRowCounts(networkHash, d.storage));
		} else if (effectiveKind === 'new-network') {
			const idb = d.indexedDB;
			const orphan = await stage('no-storage', async () =>
				idb && typeof idb.databases === 'function'
					? (await idb.databases()).some((info) => info?.name === d.dbNameFor(networkHash))
					: false,
			);
			if (orphan) await stage('no-storage', deleteStoreSettled);
		}
		await stage('no-storage', () => d.deleteMemberStorage(networkHash));
		await stage('no-storage', () => d.deleteDeviceKeys(networkHash));

		// 5. A fresh device identity, persisted before the invitation is spent.
		emit('connecting');
		memberNode = await stage('no-storage', async () => {
			const keyStore = d.createIdbKeyStore({ networkHash });
			return d.createMemberNode({ networkHash, keyStore, relayAddrs, strandId });
		});

		// 6. Redeem the single-use invitation; retry a lost reply with the SAME node and key.
		const joinProgress = (/** @type {any} */ progress) => {
			if (progress?.state === 'redeeming') emit('joining');
		};
		for (let attempt = 1; ; attempt += 1) {
			if (aborted()) return await fail('cancelled');
			try {
				await memberNode.joinCadre(joinCode.invitation, { signal, onProgress: joinProgress });
				break;
			} catch (err) {
				logFailure(err);
				if (aborted()) return await fail('cancelled');
				const reason = err && /** @type {any} */ (err).name === 'MemberNodeError' ? /** @type {any} */ (err).reason : 'unreachable';
				const mapped = /** @type {Record<string, any>} */ (JOIN_FAILURE_TO_PAIR_FAILURE)[reason] ?? 'unreachable';
				const retryable = reason === 'unreachable' && err && /** @type {any} */ (err).name === 'MemberNodeError';
				if (!retryable || attempt >= PAIR_REDEEM_ATTEMPTS) return await fail(mapped);
				await d.sleep(PAIR_REDEEM_RETRY_DELAY_MS, signal);
			}
		}
		emit('joining');

		// 7. First sync: the strand, under the first-sync deadline, then the reader the caller handed in,
		// whose wait for the strand database ends on its own stall window or hard cap rather than this
		// deadline: a first build over the relay can run for minutes while it is still receiving data.
		emit('first-sync');
		const strandDeadlineMs = pairingInstantMs + PAIR_FIRST_SYNC_TIMEOUT_MS;
		const syncAbort = new AbortController();
		const forwardAbort = () => syncAbort.abort();
		signal?.addEventListener('abort', forwardAbort, { once: true });
		const syncTimer = setTimeout(forwardAbort, Math.max(0, strandDeadlineMs - d.now()));
		try {
			await stage('unreachable', () => memberNode.waitForStrand(strandId, { signal: syncAbort.signal }));
		} finally {
			clearTimeout(syncTimer);
			signal?.removeEventListener('abort', forwardAbort);
		}
		const readerAbort = new AbortController();
		const forwardReaderAbort = () => readerAbort.abort();
		signal?.addEventListener('abort', forwardReaderAbort, { once: true });
		try {
			strandReader = await stage('unreachable', () => openStrandReader({ memberNode, strandId, signal: readerAbort.signal }));
		} finally {
			signal?.removeEventListener('abort', forwardReaderAbort);
		}
		const deadlineMs = Math.max(strandDeadlineMs, d.now() + PAIR_AFTER_STRAND_DB_MS);

		// 8. Founding anchor, before the statement.
		/** @type {any} */
		let rows = null;
		let loggedRead = false;
		for (;;) {
			if (aborted()) return await fail('cancelled');
			try {
				const read = await d.readGenesisRows(await resolveStrandDb(strandReader), genesis);
				if (FOUNDING_BUNDLE_TABLE_ORDER.every((table) => Array.isArray(read?.[table]) && read[table].length > 0)) {
					rows = read;
					break;
				}
			} catch (err) {
				if (!loggedRead) logFailure(err);
				loggedRead = true;
			}
			if (d.now() >= deadlineMs) return await fail('unreachable');
			await d.sleep(PAIR_SYNC_POLL_MS, signal);
		}
		if (d.computeContentDigest(rows) !== joinCode.digest) return await fail('digest-mismatch');
		/** @type {any} */
		let descriptor;
		try {
			descriptor = d.deriveFoundingDescriptor(rows);
		} catch (err) {
			logFailure(err);
			return await fail('digest-mismatch');
		}
		if (descriptor.networkHash !== networkHash) return await fail('digest-mismatch');
		if (genesis.authorityId !== descriptor.primaryAuthorityId) return await fail('digest-mismatch');
		// The code's Admin generation must be the authority's EARLIEST in the replica (the same rule
		// as the officer phone's join anchor). A later Admin row that has not replicated yet cannot
		// make a non-founding anchor pass: the founding rows of a later generation would not hash
		// to a digest minted from the earliest one.
		const generations = await stage('unreachable', async () =>
			d.adminGenerations(await resolveStrandDb(strandReader), genesis.authorityId),
		);
		let earliestMs = Number.POSITIVE_INFINITY;
		for (const value of Array.isArray(generations) ? generations : []) {
			try {
				const ms = typeof value === 'string' ? d.fromCanonicalDatetime(value) : Number.NaN;
				if (Number.isFinite(ms) && ms < earliestMs) earliestMs = ms;
			} catch (err) {
				logFailure(err);
			}
		}
		let codeGenerationMs = Number.NaN;
		try {
			codeGenerationMs = d.fromCanonicalDatetime(genesis.adminEffectiveAt);
		} catch (err) {
			logFailure(err);
		}
		if (!Number.isFinite(codeGenerationMs) || earliestMs !== codeGenerationMs) return await fail('digest-mismatch');

		// 9. The statement, against rows now proven to be this network's. The pairing instant is the
		// expiry reference, so a slow first sync never expires a code redeemed in time.
		/** @type {string | null} */
		let lastWaitReason = null;
		loggedRead = false;
		for (;;) {
			if (aborted()) return await fail('cancelled');
			try {
				const revoked = await d.isPairingRevoked(await resolveStrandDb(strandReader), {
					userId: statement.userId,
					nonce: statement.nonce,
				});
				if (revoked === true) return await fail('officer-not-valid');
				const result = await d.verifyPairingStatement(await resolveStrandDb(strandReader), verifyArgs);
				if (result?.ok === true) break;
				if (result?.reason === 'expired') return await fail('expired');
				if (result?.reason !== 'not-officer' && result?.reason !== 'key-not-current') return await fail('officer-not-valid');
				lastWaitReason = result.reason;
			} catch (err) {
				if (!loggedRead) logFailure(err);
				loggedRead = true;
			}
			if (d.now() >= deadlineMs) return await fail(lastWaitReason ? 'officer-not-valid' : 'unreachable');
			await d.sleep(PAIR_SYNC_POLL_MS, signal);
		}

		// 10. The local store, created (or, for the same officer, reopened) and closed again.
		await stage('no-storage', async () => {
			const handle = await d.attachLiveDb(networkHash, { create: true });
			await d.closeNetworkDb(handle);
		});

		// 11. Registry LAST, naming the verified officer (D-12).
		let strandName = null;
		try {
			strandName = await readUserName(await resolveStrandDb(strandReader), statement.userId);
		} catch (err) {
			logFailure(err);
		}
		const officerName = usableOfficerName(strandName) ?? usableOfficerName(incomingLocalName);
		const founding = /** @type {any} */ (rows).Authority[0];
		await stage('no-storage', async () =>
			d.upsertNetwork(
				{
					networkHash,
					authorityName: String(founding?.Name ?? ''),
					domain: descriptor.primaryAuthorityDomainName,
					officerUserId: statement.userId,
					...(officerName !== null ? { officerName } : {}),
					pairing: {
						v: 1,
						nonce: statement.nonce,
						expiresAt: statement.expiresAt,
						keyPub: statement.keyPub,
						sig: statement.sig,
						requesterPeerId: statement.requesterPeerId,
						pairedAt: d.toCanonicalDatetime(d.now()),
						relayAddrs,
						strandId,
					},
				},
				d.storage,
			),
		);
		return { ok: true, networkHash, handoff: { memberNode, strandReader } };
	} catch (err) {
		if (err instanceof PairStageFailure) return await fail(/** @type {any} */ (err.reason));
		logFailure(err);
		return await fail(aborted() ? 'cancelled' : 'unreachable');
	}
}
