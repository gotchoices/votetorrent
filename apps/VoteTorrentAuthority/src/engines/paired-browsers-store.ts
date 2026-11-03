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
 * The pairing code, the encoded invitation and its private key are NEVER stored (bearer hygiene):
 * an entry is always built field by field from a fresh object, so no extra field of the input can
 * ever be persisted.
 *
 * Same discipline as `joined-networks.ts`: a read REJECTS `PairedBrowsersUnreadableError` on an I/O
 * failure, corrupt JSON or a non-array value, and a write never goes over a list it could not read.
 * Malformed items are dropped on read. The list is capped at `PAIRED_BROWSERS_MAX_ENTRIES`, the
 * oldest `mintedAt` going first. A later plan extends the entry shape (revocation and removal
 * state). Never logs.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const PAIRED_BROWSERS_KEY = '@votetorrent/pairedBrowsers';
export const PAIRED_BROWSERS_MAX_ENTRIES = 200;

export interface PairedBrowserEntry {
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

export class PairedBrowsersUnreadableError extends Error {
	constructor() {
		super('paired browsers: the local list is unreadable');
		this.name = 'PairedBrowsersUnreadableError';
	}
}

const CANONICAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

function nonEmpty(v: unknown): v is string {
	return typeof v === 'string' && v.length > 0;
}

/** A fresh object with exactly the 7 fields, or null when any field is malformed. */
function toEntry(v: unknown): PairedBrowserEntry | null {
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
 * writes over a list it could not read. TypeError on a malformed entry.
 */
export async function recordPairedBrowser(entry: PairedBrowserEntry): Promise<void> {
	const fresh = toEntry(entry);
	if (!fresh) throw new TypeError('recordPairedBrowser needs a well-formed entry');
	const all = await readAll();
	if (all.some((e) => e.nonce === fresh.nonce)) return;
	let next = newestFirst([...all, fresh]);
	if (next.length > PAIRED_BROWSERS_MAX_ENTRIES) next = next.slice(0, PAIRED_BROWSERS_MAX_ENTRIES);
	await AsyncStorage.setItem(PAIRED_BROWSERS_KEY, JSON.stringify(next));
}
