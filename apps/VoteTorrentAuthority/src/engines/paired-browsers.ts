/**
 * paired-browsers.ts — the browsers this officer's phone paired: list them, remove one (D-07, D-08,
 * D-25, D-27).
 *
 * Data sources (D-25):
 *  - the LOCAL store (`paired-browsers-store.ts`): nonce, label, paired-at, the invitation's public
 *    key, and what this phone did about removing it. None of it is ever a strand row;
 *  - the replicated CONTROL database: `CadreInviteUsage` maps the stored invitation key to the
 *    IDENTITY peer id of the machine that redeemed it, and `listMachines()` lists the live cadre
 *    machines with `lastPublishedAt`. Only identity peer ids are used here, never a strand node's
 *    own transport peer id.
 * "Last seen" is the browser machine's self-record stamp (`lastPublishedAt`), which a running
 * machine re-publishes about every 7.5 minutes; it is null until the machine first publishes.
 *
 * States: `waiting` (code not redeemed yet), `paired` (a live cadre machine nobody revoked),
 * `removal-pending` (revoked here, machine still in the cadre), `removed` (the machine left the
 * cadre, or the unused code can no longer admit anyone). A pairing leaves `paired` only through a
 * revocation or an owner removing the machine from the network, never by age (D-07). The list never
 * infers a state from a partial read: if the usage or machine read fails, it rejects
 * `PairedBrowsersNetworkUnavailableError` instead of guessing.
 *
 * Remove (ruling R-D) is ONE signed insert and ONE biometric prompt: the officer-signed
 * `DashboardPairingRevocation (UserId, Nonce)` row, through `revokeDashboardPairing`. The row comes
 * first because the browser watches for its own nonce and unpairs itself on it, even when no owner
 * is online. The row stores only `(UserId, Nonce)`: its signature is checked by every applying peer
 * at write time against a current key of that officer, but it is NOT kept in the row. The row is
 * enforced by VoteTorrent's dashboard code; network access is taken by the MINTING OWNER's phone,
 * which watches the replicated revocation rows and calls `removeMachine` for the matching machine.
 * So `removal-pending` becomes `removed` once that owner's phone is next online with the app open;
 * this phone sends no request of any kind and re-derives the state on every read (there is no retry
 * loop). Limitation: only the minting owner finishes a removal; if that phone is gone for good, the
 * browser still unpairs itself through the row, but its machine entry stays until another owner
 * removes it from the cadre machine list. A code that is still unredeemed cannot be withdrawn from
 * here: it reads `removal-pending` until it expires (plus a grace) or the browser redeems it, reads
 * the row and unpairs.
 *
 * Removing a browser takes away its network access; it cannot erase data the browser already
 * received (D-25), and nothing here claims otherwise.
 *
 * No console calls. Errors carry a closed `reason` and a fixed message, never a peer id, nonce,
 * invitation key, row value or database text. The signer is injected by the caller: nothing here
 * creates, rotates or looks up a key.
 */
import type { PairingRevocationSigner } from '@votetorrent/vote-engine/rn';
import {
	markPairedBrowserRemovalDone,
	markPairedBrowserRevoked,
	pairedBrowserRemoval,
	readPairedBrowsers,
	type PairedBrowserEntry,
} from './paired-browsers-store';

/** Replication-lag allowance after an unused code's expiry, before it stops being listed. */
export const PAIRED_BROWSER_UNUSED_GRACE_MS = 10 * 60_000;

export type PairedBrowserState = 'waiting' | 'paired' | 'removal-pending' | 'removed';

export interface PairedBrowserRow {
	nonce: string;
	label: string | null;
	mintedAt: number;
	state: PairedBrowserState;
	lastSeenAt: number | null;
}

/** The slice of a `CadreNode` this module reads (the real node satisfies it). */
export interface PairedBrowsersNode {
	getControlDatabase(): {
		queryCadreInviteUsages(retry?: boolean): Promise<ReadonlyArray<{ inviteKey: string; peerId: string }>>;
	} | null;
	listMachines(): Promise<ReadonlyArray<{ peerId: string; lastPublishedAt: number | null; isSelf?: boolean }>>;
}

export interface PairedBrowsersStorePort {
	read(filter?: { networkHash?: string; userId?: string }): Promise<PairedBrowserEntry[]>;
	markDone?(nonce: string): Promise<unknown>;
}

const DEFAULT_STORE: PairedBrowsersStorePort = { read: readPairedBrowsers, markDone: markPairedBrowserRemovalDone };

export class PairedBrowsersNetworkUnavailableError extends Error {
	constructor() {
		super('paired browsers: the network membership could not be read');
		this.name = 'PairedBrowsersNetworkUnavailableError';
	}
}

export type PairedBrowserRemoveReason =
	| 'signer-mismatch'
	| 'key-not-current'
	| 'refused'
	| 'not-saved'
	| 'unknown-entry'
	| 'wrong-network';

const REMOVE_MESSAGES: Record<PairedBrowserRemoveReason, string> = {
	'signer-mismatch': 'paired browsers: the signer is not the officer who paired this browser',
	'key-not-current': 'paired browsers: the signing key is not a current key of the officer',
	refused: 'paired browsers: the network refused the revocation',
	'not-saved': 'paired browsers: the revocation could not be saved',
	'unknown-entry': 'paired browsers: no such pairing on this phone',
	'wrong-network': 'paired browsers: the pairing belongs to another network',
};

export class PairedBrowserRemoveError extends Error {
	readonly reason: PairedBrowserRemoveReason;
	constructor(reason: PairedBrowserRemoveReason) {
		super(REMOVE_MESSAGES[reason]);
		this.name = 'PairedBrowserRemoveError';
		this.reason = reason;
	}
}

/** Epoch ms of the statement's 19-char canonical (UTC) expiry; NaN when unparseable. */
function expiryMs(expiresAt: string): number {
	return Date.parse(expiresAt + 'Z');
}

/**
 * The state of one stored pairing, or null for "do not list" (an unrevoked code that expired
 * unused more than the grace ago; the stored entry is kept, so a late usage row brings it back).
 * `usagePeerId` is the identity peer id that redeemed the code (null when none yet); `machine` is
 * that peer's live cadre machine (null when it is not a live machine). Pure.
 */
export function derivePairedBrowserState(
	entry: PairedBrowserEntry,
	usagePeerId: string | null,
	machine: { lastPublishedAt: number | null } | null,
	nowMs: number,
): PairedBrowserState | null {
	const removal = pairedBrowserRemoval(entry);
	if (removal === 'done') return 'removed';
	const exp = expiryMs(entry.expiresAt);
	const unusedOver = Number.isFinite(exp) && nowMs > exp + PAIRED_BROWSER_UNUSED_GRACE_MS;
	if (removal === 'pending') {
		// The minting owner acted on the row, or the single-use code can no longer admit anyone.
		if (usagePeerId !== null && machine === null) return 'removed';
		if (usagePeerId === null && unusedOver) return 'removed';
		return 'removal-pending';
	}
	if (usagePeerId !== null) return machine !== null ? 'paired' : 'removed';
	return unusedOver ? null : 'waiting';
}

interface Membership {
	usage: Map<string, string>;
	machines: Map<string, { lastPublishedAt: number | null }>;
}

/** Usage (inviteKey -> identity peer id) and live machines (peer id -> machine); rejects on any failure. */
async function readMembership(node: PairedBrowsersNode): Promise<Membership> {
	let control: ReturnType<PairedBrowsersNode['getControlDatabase']>;
	try {
		control = node.getControlDatabase();
	} catch {
		throw new PairedBrowsersNetworkUnavailableError();
	}
	if (!control) throw new PairedBrowsersNetworkUnavailableError();
	let usages: ReadonlyArray<{ inviteKey: string; peerId: string }>;
	let live: ReadonlyArray<{ peerId: string; lastPublishedAt: number | null; isSelf?: boolean }>;
	try {
		[usages, live] = await Promise.all([control.queryCadreInviteUsages(), node.listMachines()]);
	} catch {
		throw new PairedBrowsersNetworkUnavailableError();
	}
	if (!Array.isArray(usages) || !Array.isArray(live)) throw new PairedBrowsersNetworkUnavailableError();
	const usage = new Map<string, string>();
	for (const u of usages) {
		if (u && typeof u.inviteKey === 'string' && typeof u.peerId === 'string' && !usage.has(u.inviteKey)) {
			usage.set(u.inviteKey, u.peerId);
		}
	}
	const machines = new Map<string, { lastPublishedAt: number | null }>();
	for (const m of live) {
		if (!m || m.isSelf === true || typeof m.peerId !== 'string') continue;
		const at = typeof m.lastPublishedAt === 'number' && Number.isFinite(m.lastPublishedAt) ? m.lastPublishedAt : null;
		machines.set(m.peerId, { lastPublishedAt: at });
	}
	return { usage, machines };
}

function resolve(entry: PairedBrowserEntry, membership: Membership, nowMs: number) {
	const usagePeerId = membership.usage.get(entry.inviteKey) ?? null;
	const machine = usagePeerId !== null ? membership.machines.get(usagePeerId) ?? null : null;
	return { state: derivePairedBrowserState(entry, usagePeerId, machine, nowMs), machine };
}

/**
 * The pairings this phone made, newest first, filtered by officer and network when given. Rejects
 * `PairedBrowsersUnreadableError` (local store) or `PairedBrowsersNetworkUnavailableError` (no
 * control database, or the usage or machine read failed). An entry stored as removal-pending that
 * now derives `removed` is marked done in the store, best effort (a failure never fails the list;
 * the next read derives the same state).
 */
export async function listPairedBrowsers(
	node: PairedBrowsersNode,
	store: PairedBrowsersStorePort = DEFAULT_STORE,
	filter: { userId?: string; networkHash?: string; nowMs?: number } = {},
): Promise<PairedBrowserRow[]> {
	const entries = await store.read({ userId: filter.userId, networkHash: filter.networkHash });
	const membership = await readMembership(node);
	const nowMs = filter.nowMs ?? Date.now();
	const rows: PairedBrowserRow[] = [];
	const finished: string[] = [];
	for (const entry of entries) {
		if (filter.userId !== undefined && entry.userId !== filter.userId) continue;
		if (filter.networkHash !== undefined && entry.networkHash !== filter.networkHash) continue;
		const { state, machine } = resolve(entry, membership, nowMs);
		if (state === null) continue;
		if (state === 'removed' && pairedBrowserRemoval(entry) === 'pending') finished.push(entry.nonce);
		rows.push({
			nonce: entry.nonce,
			label: entry.label,
			mintedAt: entry.mintedAt,
			state,
			lastSeenAt: machine ? machine.lastPublishedAt : null,
		});
	}
	if (store.markDone) {
		for (const nonce of finished) {
			try {
				await store.markDone(nonce);
			} catch {
				// Best effort: the next read derives the same state.
			}
		}
	}
	return rows.sort((a, b) => b.mintedAt - a.mintedAt);
}

type VoteEngineRn = typeof import('@votetorrent/vote-engine/rn');
type RevokeFn = VoteEngineRn['revokeDashboardPairing'];
type RevokeContext = Parameters<RevokeFn>[0];

/** Required lazily: screens import this module and several screen suites stub vote-core. */
function voteEngine(): VoteEngineRn {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	return require('@votetorrent/vote-engine/rn') as VoteEngineRn;
}

export interface RemovePairedBrowserStore {
	read(filter?: { networkHash?: string; userId?: string }): Promise<PairedBrowserEntry[]>;
	markRevoked(nonce: string, revokedAt: number): Promise<unknown>;
	markDone(nonce: string): Promise<unknown>;
}

export interface RemovePairedBrowserDeps {
	revoke?: (ctx: { db: unknown }, args: { userId: string; nonce: string; signer: PairingRevocationSigner }) => Promise<void>;
	nowMs?: () => number;
	store?: RemovePairedBrowserStore;
}

const DEFAULT_REMOVE_STORE: RemovePairedBrowserStore = {
	read: (filter) => readPairedBrowsers(filter),
	markRevoked: (nonce, revokedAt) => markPairedBrowserRevoked(nonce, revokedAt),
	markDone: (nonce) => markPairedBrowserRemovalDone(nonce),
};

/** The real revocation insert: vote-engine's `revokeDashboardPairing` with `{ db }` as the engine context. */
async function revokeWithVoteEngine(
	ctx: { db: unknown },
	args: { userId: string; nonce: string; signer: PairingRevocationSigner },
): Promise<void> {
	await voteEngine().revokeDashboardPairing(ctx as RevokeContext, args);
}

const REVOCATION_REASONS = new Set<PairedBrowserRemoveReason>(['signer-mismatch', 'key-not-current', 'refused']);

// In-flight removals by nonce (memory only, never logged).
const inFlight = new Map<string, Promise<'removed' | 'removal-pending'>>();

/** Test-only: forget in-flight removals. Never called from app code. */
export function __resetPairedBrowsersStateForTests(): void {
	inFlight.clear();
}

function mapRevokeError(err: unknown): unknown {
	const e = err as { name?: unknown; reason?: unknown; code?: unknown } | null;
	if (e && e.name === 'PairingRevocationError') {
		const reason = e.reason as PairedBrowserRemoveReason;
		return new PairedBrowserRemoveError(REVOCATION_REASONS.has(reason) ? reason : 'not-saved');
	}
	// A signer error (cancel, lockout, no key, prompt busy, invalidated key) reaches the screen's handler unchanged.
	if (e && typeof e.code === 'string') return err;
	return new PairedBrowserRemoveError('not-saved');
}

async function removeOnce(args: {
	node: PairedBrowsersNode;
	db: unknown;
	signer: PairingRevocationSigner;
	nonce: string;
	networkHash?: string;
	deps: RemovePairedBrowserDeps;
}): Promise<'removed' | 'removal-pending'> {
	const store = args.deps.store ?? DEFAULT_REMOVE_STORE;
	const nowMs = args.deps.nowMs ?? Date.now;

	// Checks before any prompt; the store is the source of truth.
	const entry = (await store.read()).find((e) => e.nonce === args.nonce);
	if (!entry) throw new PairedBrowserRemoveError('unknown-entry');
	if (args.networkHash !== undefined && args.networkHash !== entry.networkHash) {
		throw new PairedBrowserRemoveError('wrong-network');
	}
	if (args.signer.userId !== entry.userId) throw new PairedBrowserRemoveError('signer-mismatch');
	if (pairedBrowserRemoval(entry) === 'done') return 'removed';

	// The only signing step. An existing row returns without signing, so a re-run raises no prompt.
	const revoke = args.deps.revoke ?? revokeWithVoteEngine;
	try {
		await revoke({ db: args.db }, { userId: entry.userId, nonce: entry.nonce, signer: args.signer });
	} catch (err) {
		throw mapRevokeError(err);
	}

	// The row stands; a store failure here propagates, and a re-run will not prompt for it again.
	await store.markRevoked(entry.nonce, nowMs());

	// Quick finish check, never failing: the machine may already be gone.
	try {
		const membership = await readMembership(args.node);
		const usagePeerId = membership.usage.get(entry.inviteKey);
		if (usagePeerId !== undefined && !membership.machines.has(usagePeerId)) {
			try {
				await store.markDone(entry.nonce);
			} catch {
				// The next list read derives `removed` and marks it again.
			}
			return 'removed';
		}
	} catch {
		// Unknown for now: the row stands, the list re-derives later.
	}
	return 'removal-pending';
}

/**
 * Remove one paired browser: ONE signed revocation insert (one biometric prompt on a first Remove,
 * none on a re-run), then the local entry is marked revoked with removal pending. Resolves
 * `'removed'` when the browser's machine is already gone from the cadre, else `'removal-pending'`.
 * Rejects only before or during the revocation insert (`PairedBrowserRemoveError`, or a signer
 * error carrying a string `code`, passed through unchanged) or with `PairedBrowsersUnreadableError`
 * from the local store. Concurrent calls for one nonce share one execution. Sends nothing over the
 * wire.
 */
export function removePairedBrowser(args: {
	node: PairedBrowsersNode;
	db: unknown;
	signer: PairingRevocationSigner;
	entry: Pick<PairedBrowserEntry, 'nonce'>;
	networkHash?: string;
	deps?: RemovePairedBrowserDeps;
}): Promise<'removed' | 'removal-pending'> {
	const nonce = args.entry.nonce;
	const existing = inFlight.get(nonce);
	if (existing) return existing;
	const run = removeOnce({
		node: args.node,
		db: args.db,
		signer: args.signer,
		nonce,
		networkHash: args.networkHash,
		deps: args.deps ?? {},
	}).finally(() => {
		inFlight.delete(nonce);
	});
	inFlight.set(nonce, run);
	return run;
}
