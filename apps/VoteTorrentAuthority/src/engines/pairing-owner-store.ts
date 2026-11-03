/**
 * pairing-owner-store.ts — an owner phone's browser-pairing switch and mint log (D-28, contract C-14).
 *
 * D-28: the owner approves a member officer's pairing request automatically, with a visible log and an
 * off switch. The switch defaults ON (an absent key is on) and gates MINTS only; a remove request, the
 * safety action, is never gated by it. Both live in AsyncStorage on this phone: the pair-mint host reads
 * them outside React, like `owner-trust-setting.ts`.
 *
 * Retention: every APPROVED entry is kept for good, because a later remove (the wire `remove` op, and the
 * owner's own revocation sweep, ruling R-D) is authorized only through the approved entry of that nonce.
 * Only non-approved entries are capped (the newest {@link MINT_LOG_MAX_OTHER}). The owner screen shows the
 * newest 20 (`readMintLog()`), which is a view, not the retention rule.
 *
 * A corrupt stored log fails closed: every read rejects {@link PairingOwnerStoreError} (`unreadable`) and
 * an append never overwrites it (an overwrite would erase the approved entries remove authorization needs).
 * The owner log screen must show that rejection.
 *
 * The invitation (its encoded text and private key) is never stored: an append copies only the six log
 * fields, whatever object it is handed. Nothing in this file logs.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PairMintLogEntry, PairMintPorts } from '@votetorrent/vote-engine/rn';
import { inviteExpiryMs } from './voter-invite';

export const PAIRING_SWITCH_KEY = '@votetorrent/settings/allowBrowserPairing';
export const PAIRING_MINT_LOG_KEY = '@votetorrent/pairingMintLog';

/** Cap on NON-approved entries (refusals, unreachable). Approved entries are never pruned. */
export const MINT_LOG_MAX_OTHER = 500;

/** How many entries the owner screen shows. */
const UI_LOG_LIMIT = 20;

/**
 * vote-engine's eleven pair-mint refusal codes (`PAIR_MINT_REFUSAL_CODES`), copied so this module needs no
 * runtime vote-engine import; the store test pins the two lists equal.
 */
export const PAIRING_REFUSAL_CODES = Object.freeze([
	'not-officer',
	'bad-signature',
	'expired',
	'replayed',
	'rate-limited',
	'not-reachable',
	'not-owner',
	'switched-off',
	'unknown-pairing',
	'malformed',
	'requester-mismatch',
] as const);

/**
 * The outcomes the 66-03 service records BEFORE its replay check. Its mint branch runs: switch -> window ->
 * requester binding -> REPLAY CHECK -> current officer -> verify -> live limit -> mint. An entry recorded
 * before the replay check must not mark its nonce used (V-17), or a leaked statement sent from the wrong
 * peer (requester-mismatch), or a first attempt while switched off or outside the window, would block the
 * officer's own retry, also after an app restart. Every other outcome was recorded after the nonce passed
 * the replay check, so it marks the nonce used. (`refused:expired` can also come from the verifier after
 * the replay check, but only for a statement already past its expiry, which the window step refuses on any
 * retry anyway.)
 */
export const PRE_REPLAY_REFUSALS = Object.freeze(['refused:switched-off', 'refused:expired', 'refused:requester-mismatch'] as const);

/** What the owner's revocation sweep (R-D) did for an approved entry. Only `withdrawn` is not final. */
export const REVOCATION_RESULTS = Object.freeze(['removed', 'gone', 'not-owner', 'refused', 'withdrawn', 'expired'] as const);
export type RevocationResult = (typeof REVOCATION_RESULTS)[number];

/** A withdrawn code stays a candidate this long past its expiry: a redemption may have raced the withdrawal. */
export const REVOCATION_GRACE_MS = 10 * 60_000;

/** The stored entry: the service's six fields plus the sweep's mark (approved entries only). */
export type OwnerMintLogEntry = PairMintLogEntry & { revocation?: { result: RevocationResult; at: number } };

export class PairingOwnerStoreError extends Error {
	readonly reason: 'unreadable';

	constructor(reason: 'unreadable') {
		// A fixed message: the stored text is never repeated.
		super('pairing owner store unreadable');
		this.name = 'PairingOwnerStoreError';
		this.reason = reason;
	}
}

// ---------------------------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------------------------

/** Absent is ON (D-28). An unknown stored value rejects with fixed text; a read failure propagates. */
export async function readPairingSwitch(): Promise<boolean> {
	const raw = await AsyncStorage.getItem(PAIRING_SWITCH_KEY);
	if (raw === null) return true;
	if (raw === 'true') return true;
	if (raw === 'false') return false;
	throw new Error('browser-pairing switch unreadable');
}

export async function writePairingSwitch(on: boolean): Promise<void> {
	await AsyncStorage.setItem(PAIRING_SWITCH_KEY, on ? 'true' : 'false');
}

// ---------------------------------------------------------------------------------------------
// Shape checks
// ---------------------------------------------------------------------------------------------

const ENTRY_KEYS = ['nonce', 'userId', 'inviteKey', 'at', 'expiresAt', 'outcome'] as const;

function isNonEmptyString(v: unknown): v is string {
	return typeof v === 'string' && v.length > 0;
}

function isOutcome(v: unknown): v is PairMintLogEntry['outcome'] {
	if (v === 'approved' || v === 'unreachable') return true;
	if (typeof v !== 'string' || !v.startsWith('refused:')) return false;
	return (PAIRING_REFUSAL_CODES as readonly string[]).includes(v.slice('refused:'.length));
}

function isRevocationResult(v: unknown): v is RevocationResult {
	return typeof v === 'string' && (REVOCATION_RESULTS as readonly string[]).includes(v);
}

/** The six-field check shared by appends and the stored document. */
function entryFieldsValid(e: Record<string, unknown>): boolean {
	return (
		isNonEmptyString(e.nonce) &&
		isNonEmptyString(e.userId) &&
		(e.inviteKey === null || typeof e.inviteKey === 'string') &&
		typeof e.at === 'number' &&
		Number.isFinite(e.at) &&
		(e.expiresAt === null || typeof e.expiresAt === 'string') &&
		isOutcome(e.outcome)
	);
}

function storedEntryValid(v: unknown): v is OwnerMintLogEntry {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
	const e = v as Record<string, unknown>;
	for (const key of Object.keys(e)) {
		if (key !== 'revocation' && !(ENTRY_KEYS as readonly string[]).includes(key)) return false;
	}
	if (!entryFieldsValid(e)) return false;
	if (!('revocation' in e)) return true;
	const r = e.revocation as Record<string, unknown> | null;
	if (e.outcome !== 'approved' || typeof r !== 'object' || r === null || Array.isArray(r)) return false;
	if (Object.keys(r).length !== 2) return false;
	return isRevocationResult(r.result) && typeof r.at === 'number' && Number.isFinite(r.at);
}

// ---------------------------------------------------------------------------------------------
// Document I/O, serialized
// ---------------------------------------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();

/** Run `fn` after every earlier store call finished. A failed step never breaks the chain. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
	const run = chain.then(fn);
	chain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

async function readEntries(): Promise<OwnerMintLogEntry[]> {
	let raw: string | null;
	try {
		raw = await AsyncStorage.getItem(PAIRING_MINT_LOG_KEY);
	} catch {
		throw new PairingOwnerStoreError('unreadable');
	}
	if (raw === null) return [];
	let doc: unknown;
	try {
		doc = JSON.parse(raw);
	} catch {
		throw new PairingOwnerStoreError('unreadable');
	}
	if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new PairingOwnerStoreError('unreadable');
	const d = doc as { v?: unknown; entries?: unknown };
	if (d.v !== 1 || !Array.isArray(d.entries)) throw new PairingOwnerStoreError('unreadable');
	if (!d.entries.every(storedEntryValid)) throw new PairingOwnerStoreError('unreadable');
	return d.entries as OwnerMintLogEntry[];
}

async function writeEntries(entries: OwnerMintLogEntry[]): Promise<void> {
	await AsyncStorage.setItem(PAIRING_MINT_LOG_KEY, JSON.stringify({ v: 1, entries }));
}

/** Keep every approved entry and the newest MINT_LOG_MAX_OTHER others (by `at`, later position on ties). */
function prune(entries: OwnerMintLogEntry[]): OwnerMintLogEntry[] {
	const others = entries
		.map((e, i) => ({ e, i }))
		.filter(({ e }) => e.outcome !== 'approved')
		.sort((a, b) => b.e.at - a.e.at || b.i - a.i);
	if (others.length <= MINT_LOG_MAX_OTHER) return entries;
	const drop = new Set(others.slice(MINT_LOG_MAX_OTHER).map(({ i }) => i));
	return entries.filter((_, i) => !drop.has(i));
}

/** Newest first by `at`; a later position wins a tie. */
function newestFirst(entries: OwnerMintLogEntry[]): OwnerMintLogEntry[] {
	return entries
		.map((e, i) => ({ e, i }))
		.sort((a, b) => b.e.at - a.e.at || b.i - a.i)
		.map(({ e }) => e);
}

function copyEntry(e: OwnerMintLogEntry): OwnerMintLogEntry {
	const out: OwnerMintLogEntry = {
		nonce: e.nonce,
		userId: e.userId,
		inviteKey: e.inviteKey,
		at: e.at,
		expiresAt: e.expiresAt,
		outcome: e.outcome,
	};
	if (e.revocation) out.revocation = { result: e.revocation.result, at: e.revocation.at };
	return out;
}

// ---------------------------------------------------------------------------------------------
// Log API
// ---------------------------------------------------------------------------------------------

/**
 * Append one outcome. Only the six log fields are copied (an extra field, such as an invitation, can never
 * be persisted, and a `revocation` passed in is ignored: marks come only from {@link markMintRevocation}).
 * Rejects with a fixed message on a malformed entry; rejects `unreadable` on a corrupt log, which it never
 * overwrites.
 */
export function appendMintLog(entry: PairMintLogEntry): Promise<void> {
	if (typeof entry !== 'object' || entry === null || !entryFieldsValid(entry as unknown as Record<string, unknown>)) {
		return Promise.reject(new Error('pairing mint log entry invalid'));
	}
	const clean: OwnerMintLogEntry = {
		nonce: entry.nonce,
		userId: entry.userId,
		inviteKey: entry.inviteKey,
		at: entry.at,
		expiresAt: entry.expiresAt,
		outcome: entry.outcome,
	};
	return serialized(async () => {
		const entries = await readEntries();
		entries.push(clean);
		await writeEntries(prune(entries));
	});
}

/** The newest `limit` entries (the owner screen shows 20), newest first. */
export function readMintLog(limit: number = UI_LOG_LIMIT): Promise<OwnerMintLogEntry[]> {
	const n = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : UI_LOG_LIMIT;
	return serialized(async () => newestFirst(await readEntries()).slice(0, n).map(copyEntry));
}

/** True when some entry of `nonce` was recorded after the service's replay check (see PRE_REPLAY_REFUSALS). */
export function hasMintNonce(nonce: string): Promise<boolean> {
	return serialized(async () =>
		(await readEntries()).some((e) => e.nonce === nonce && !(PRE_REPLAY_REFUSALS as readonly string[]).includes(e.outcome)),
	);
}

/** The approved entry of `nonce` if there is one, else its newest entry, else null. */
export function findMintByNonce(nonce: string): Promise<OwnerMintLogEntry | null> {
	return serialized(async () => {
		const mine = newestFirst((await readEntries()).filter((e) => e.nonce === nonce));
		const hit = mine.find((e) => e.outcome === 'approved') ?? mine[0] ?? null;
		return hit ? copyEntry(hit) : null;
	});
}

/** Approved, unrevoked entries of `userId` whose invitation expires after `nowMs`. */
export function liveMintsFor(userId: string, nowMs: number): Promise<OwnerMintLogEntry[]> {
	return serialized(async () =>
		(await readEntries())
			.filter((e) => {
				if (e.outcome !== 'approved' || e.userId !== userId || e.revocation !== undefined) return false;
				const exp = inviteExpiryMs(e.expiresAt);
				return exp !== null && exp > nowMs;
			})
			.map(copyEntry),
	);
}

/** The 66-03 service's `mintLog` port over this store. */
export function createPairMintLog(): PairMintPorts['mintLog'] {
	return {
		hasNonce: hasMintNonce,
		record: appendMintLog,
		findByNonce: findMintByNonce,
		liveMintsFor,
	};
}

// ---------------------------------------------------------------------------------------------
// Revocation marks (R-D)
// ---------------------------------------------------------------------------------------------

/**
 * Record what the sweep did for the APPROVED entry of `nonce`. False when there is none, or when it already
 * carries a final mark (only `withdrawn` may be replaced, and not by `withdrawn` again).
 */
export function markMintRevocation(nonce: string, mark: { result: RevocationResult; at: number }): Promise<boolean> {
	if (typeof mark !== 'object' || mark === null || !isRevocationResult(mark.result) || typeof mark.at !== 'number' || !Number.isFinite(mark.at)) {
		return Promise.reject(new Error('pairing mint revocation mark invalid'));
	}
	const next = { result: mark.result, at: mark.at };
	return serialized(async () => {
		const entries = await readEntries();
		const target = newestFirst(entries.filter((e) => e.nonce === nonce && e.outcome === 'approved'))[0];
		if (!target) return false;
		if (target.revocation && (target.revocation.result !== 'withdrawn' || next.result === 'withdrawn')) return false;
		target.revocation = next;
		await writeEntries(entries);
		return true;
	});
}

/**
 * Approved entries the sweep still looks at, oldest first: every unmarked one with an invitation key, and
 * a `withdrawn` one until its expiry plus {@link REVOCATION_GRACE_MS}.
 */
export function listRevocationCandidates(nowMs: number): Promise<OwnerMintLogEntry[]> {
	return serialized(async () =>
		(await readEntries())
			.map((e, i) => ({ e, i }))
			.filter(({ e }) => {
				if (e.outcome !== 'approved' || !isNonEmptyString(e.inviteKey)) return false;
				if (e.revocation === undefined) return true;
				if (e.revocation.result !== 'withdrawn') return false;
				const exp = inviteExpiryMs(e.expiresAt);
				return exp !== null && exp + REVOCATION_GRACE_MS > nowMs;
			})
			.sort((a, b) => a.e.at - b.e.at || a.i - b.i)
			.map(({ e }) => copyEntry(e)),
	);
}
