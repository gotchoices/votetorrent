/**
 * paired-browsers-store.ts — the local record of the browsers this phone paired (D-25).
 *
 * Each successful pairing is recorded here before its code is handed to the screen:
 * `{ nonce, userId, networkHash, inviteKey, mintedAt, expiresAt, label }`. Labels and times are
 * LOCAL metadata of this phone; nothing here is written to any strand row.
 *
 *  - `nonce` is the pairing statement's one-time nonce (the record key; recording is idempotent by it);
 *  - `inviteKey` is the single-use cadre invitation's PUBLIC key (`CadreInvite.Key`), which the
 *    list later matches against `CadreInviteUsage`. It is not a bearer secret;
 *  - `mintedAt` is epoch ms on this phone's clock; `expiresAt` the statement's 19-char canonical
 *    datetime; `label` the officer's name for the browser, or null (the screen shows a default).
 *
 * Two optional fields record what this phone did about a pairing later:
 *  - `revokedAt` (epoch ms, this phone's clock): when this phone's revocation row landed. Written
 *    once; an earlier value always wins;
 *  - `removal`: `'pending'` once revoked, `'done'` once the browser's machine has left the cadre.
 *    It only moves forward (none < pending < done). An entry without it is `'none'`; a `'none'` is
 *    never written, so an entry recorded at pairing keeps exactly its 7 fields until something
 *    happens to it.
 * Labels, paired-at, revokedAt and the removal state live ONLY on this phone (D-25): no other
 * device sees them, and none of them is ever a strand row. A local rename changes only `label`.
 *
 * The pairing code, the encoded invitation and its private key are NEVER stored (bearer hygiene):
 * an entry is always built field by field from a fresh object, so no extra field of the input can
 * ever be persisted, and no field here is ever an invitation or a code.
 *
 * Same discipline as `joined-networks.ts`: a read REJECTS `PairedBrowsersUnreadableError` on an I/O
 * failure, corrupt JSON or a non-array value, and a write never goes over a list it could not read.
 * Malformed items are dropped on read. Every writer (record, the two marks, rename) runs through one
 * module-level chain and re-reads the list before it writes, so concurrent calls never lose an
 * update. The list is capped at `PAIRED_BROWSERS_MAX_ENTRIES`: the oldest `mintedAt` among the
 * entries that are NOT removal-pending goes first (a pending entry is the only record of a removal
 * still in progress, so it is never evicted; the list may exceed the cap when only pending entries
 * are left over). Never logs.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const PAIRED_BROWSERS_KEY = '@votetorrent/pairedBrowsers';
export const PAIRED_BROWSERS_MAX_ENTRIES = 200;
/** A local label is cut to this many characters. */
export const PAIRED_BROWSER_LABEL_MAX_CHARS = 64;

/** What this phone has done about removing a pairing; it only moves forward. */
export type PairedBrowserRemoval = 'none' | 'pending' | 'done';

/** The 7 fields recorded at pairing time. */
export interface PairedBrowserRecord {
	readonly nonce: string;
	readonly userId: string;
	readonly networkHash: string;
	/** The invitation's public key, not a secret. */
	readonly inviteKey: string;
	/** Epoch ms, this phone's clock. */
	readonly mintedAt: number;
	/** The statement's 19-char canonical datetime. */
	readonly expiresAt: string;
	/** null = not named; the list screen renders its default label. */
	readonly label: string | null;
}

/**
 * A stored pairing. `removal` is absent for an entry nothing has happened to (read it with
 * `pairedBrowserRemoval`, which gives `'none'`); `revokedAt` is present once revoked.
 */
export interface PairedBrowserEntry extends PairedBrowserRecord {
	/** Epoch ms, this phone's clock; written once. */
	readonly revokedAt?: number;
	/** Absent means `'none'`. */
	readonly removal?: PairedBrowserRemoval;
}

export class PairedBrowsersUnreadableError extends Error {
	constructor() {
		super('paired browsers: the local list is unreadable');
		this.name = 'PairedBrowsersUnreadableError';
	}
}

/** The removal state of an entry; an entry without the field is `'none'`. */
export function pairedBrowserRemoval(entry: Pick<PairedBrowserEntry, 'removal'>): PairedBrowserRemoval {
	return entry.removal ?? 'none';
}

const CANONICAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const REMOVAL_ORDER: Record<PairedBrowserRemoval, number> = { none: 0, pending: 1, done: 2 };

function nonEmpty(v: unknown): v is string {
	return typeof v === 'string' && v.length > 0;
}

function isRemoval(v: unknown): v is PairedBrowserRemoval {
	return v === 'none' || v === 'pending' || v === 'done';
}

/** A fresh object with exactly the 7 record fields, or null when any of them is malformed. */
function toRecord(v: unknown): PairedBrowserRecord | null {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
	const o = v as Record<string, unknown>;
	if (!nonEmpty(o.nonce) || !nonEmpty(o.userId) || !nonEmpty(o.networkHash) || !nonEmpty(o.inviteKey)) return null;
	if (typeof o.mintedAt !== 'number' || !Number.isFinite(o.mintedAt)) return null;
	if (typeof o.expiresAt !== 'string' || !CANONICAL_RE.test(o.expiresAt)) return null;
	if (!(o.label === null || typeof o.label === 'string')) return null;
	return {
		nonce: o.nonce,
		userId: o.userId,
		networkHash: o.networkHash,
		inviteKey: o.inviteKey,
		mintedAt: o.mintedAt,
		expiresAt: o.expiresAt,
		label: o.label,
	};
}

/** A fresh entry from validated parts; a `'none'` removal and an absent `revokedAt` are not written. */
function build(
	record: PairedBrowserRecord,
	label: string | null,
	revokedAt: number | undefined,
	removal: PairedBrowserRemoval,
): PairedBrowserEntry {
	const base: PairedBrowserRecord = {
		nonce: record.nonce,
		userId: record.userId,
		networkHash: record.networkHash,
		inviteKey: record.inviteKey,
		mintedAt: record.mintedAt,
		expiresAt: record.expiresAt,
		label,
	};
	if (revokedAt === undefined && removal === 'none') return base;
	if (revokedAt === undefined) return { ...base, removal };
	if (removal === 'none') return { ...base, revokedAt };
	return { ...base, revokedAt, removal };
}

/** A fresh entry, or null when any field is malformed (a bad optional field drops the item too). */
function toEntry(v: unknown): PairedBrowserEntry | null {
	const record = toRecord(v);
	if (!record) return null;
	const o = v as Record<string, unknown>;
	let removal: PairedBrowserRemoval = 'none';
	if (o.removal !== undefined) {
		if (!isRemoval(o.removal)) return null;
		removal = o.removal;
	}
	let revokedAt: number | undefined;
	if (o.revokedAt !== undefined) {
		if (typeof o.revokedAt !== 'number' || !Number.isFinite(o.revokedAt)) return null;
		revokedAt = o.revokedAt;
	}
	return build(record, record.label, revokedAt, removal);
}

/** Every well-formed entry in stored order; rejects `PairedBrowsersUnreadableError`. */
async function readAll(): Promise<PairedBrowserEntry[]> {
	let raw: string | null;
	try {
		raw = await AsyncStorage.getItem(PAIRED_BROWSERS_KEY);
	} catch {
		throw new PairedBrowsersUnreadableError();
	}
	if (raw === null || raw === undefined) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new PairedBrowsersUnreadableError();
	}
	if (!Array.isArray(parsed)) throw new PairedBrowsersUnreadableError();
	const out: PairedBrowserEntry[] = [];
	for (const item of parsed) {
		const entry = toEntry(item);
		if (entry) out.push(entry);
	}
	return out;
}

function newestFirst(entries: PairedBrowserEntry[]): PairedBrowserEntry[] {
	return [...entries].sort((a, b) => b.mintedAt - a.mintedAt);
}

/** Drop the oldest non-pending entries until the cap holds (or only pending entries are over it). */
function capped(newest: PairedBrowserEntry[]): PairedBrowserEntry[] {
	const out = [...newest];
	for (let i = out.length - 1; i >= 0 && out.length > PAIRED_BROWSERS_MAX_ENTRIES; i--) {
		if (pairedBrowserRemoval(out[i]) !== 'pending') out.splice(i, 1);
	}
	return out;
}

async function writeAll(entries: PairedBrowserEntry[]): Promise<void> {
	await AsyncStorage.setItem(PAIRED_BROWSERS_KEY, JSON.stringify(entries));
}

// One chain for every writer, so a read-modify-write never interleaves with another one. The chain
// itself never rejects, so one failed write never blocks the next.
let writeChain: Promise<void> = Promise.resolve();

function serialized<T>(op: () => Promise<T>): Promise<T> {
	const run = writeChain.then(op);
	writeChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/**
 * The recorded pairings, newest first; [] when none. Rejects `PairedBrowsersUnreadableError` when
 * the list cannot be read, is corrupt or is not an array.
 */
export async function readPairedBrowsers(filter?: { networkHash?: string; userId?: string }): Promise<PairedBrowserEntry[]> {
	const all = await readAll();
	const kept = all.filter(
		(e) =>
			(filter?.networkHash === undefined || e.networkHash === filter.networkHash) &&
			(filter?.userId === undefined || e.userId === filter.userId),
	);
	return newestFirst(kept);
}

/**
 * Record one pairing. Idempotent by `nonce` (an existing entry is kept, never overwritten). Never
 * writes over a list it could not read. TypeError on a malformed entry. Only the 7 record fields are
 * written: a `removal` or `revokedAt` on the input is ignored.
 */
export async function recordPairedBrowser(entry: PairedBrowserRecord): Promise<void> {
	const fresh = toRecord(entry);
	if (!fresh) throw new TypeError('recordPairedBrowser needs a well-formed entry');
	return serialized(async () => {
		const all = await readAll();
		if (all.some((e) => e.nonce === fresh.nonce)) return;
		await writeAll(capped(newestFirst([...all, fresh])));
	});
}

/** Apply `change` to the entry with `nonce`; null (and no write) for an unknown nonce. */
function mutate(nonce: string, change: (e: PairedBrowserEntry) => PairedBrowserEntry): Promise<PairedBrowserEntry | null> {
	return serialized(async () => {
		const all = await readAll();
		const at = all.findIndex((e) => e.nonce === nonce);
		if (at < 0) return null;
		const next = change(all[at]);
		if (JSON.stringify(next) !== JSON.stringify(all[at])) {
			const copy = [...all];
			copy[at] = next;
			await writeAll(newestFirst(copy));
		}
		return next;
	});
}

function forward(current: PairedBrowserRemoval, to: PairedBrowserRemoval): PairedBrowserRemoval {
	return REMOVAL_ORDER[to] > REMOVAL_ORDER[current] ? to : current;
}

/**
 * This phone's revocation for `nonce` landed at `revokedAt`: the first `revokedAt` is kept, and
 * `removal` moves from `'none'` to `'pending'` (a `'done'` entry stays done). Null and no write for
 * an unknown nonce; rejects `PairedBrowsersUnreadableError` on an unreadable list.
 */
export async function markPairedBrowserRevoked(nonce: string, revokedAt: number): Promise<PairedBrowserEntry | null> {
	if (!Number.isFinite(revokedAt)) throw new TypeError('markPairedBrowserRevoked needs a finite time');
	return mutate(nonce, (e) => build(e, e.label, e.revokedAt ?? revokedAt, forward(pairedBrowserRemoval(e), 'pending')));
}

/**
 * The browser's machine has left the cadre: `removal` becomes `'done'` (final). Null and no write for
 * an unknown nonce; rejects `PairedBrowsersUnreadableError` on an unreadable list.
 */
export async function markPairedBrowserRemovalDone(nonce: string): Promise<PairedBrowserEntry | null> {
	return mutate(nonce, (e) => build(e, e.label, e.revokedAt, 'done'));
}

/**
 * Rename a pairing on this phone only (D-25). The label is trimmed; empty gives null (the screen's
 * default label); longer than `PAIRED_BROWSER_LABEL_MAX_CHARS` is cut. Null and no write for an
 * unknown nonce; rejects `PairedBrowsersUnreadableError` on an unreadable list.
 */
export async function renamePairedBrowser(nonce: string, label: string | null): Promise<PairedBrowserEntry | null> {
	let next: string | null = null;
	if (typeof label === 'string') {
		const cut = label.trim().slice(0, PAIRED_BROWSER_LABEL_MAX_CHARS).trim();
		next = cut.length > 0 ? cut : null;
	}
	return mutate(nonce, (e) => build(e, next, e.revokedAt, pairedBrowserRemoval(e)));
}
