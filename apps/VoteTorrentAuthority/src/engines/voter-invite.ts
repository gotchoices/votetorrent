/**
 * voter-invite.ts — the Authority side of "a voter joins this network" (spike 100).
 *
 * A voter joins with a JOIN CODE: an untargeted, multi-use cadre invitation (cadre-core
 * `createCadreInvitation`) plus the network's founding anchor (`NetworksEngine.getFoundingAnchor`),
 * encoded by vote-engine's `encodeNetworkJoinCode`. The voter's phone redeems the invitation,
 * opens the network's strand and accepts it only when its founding rows hash to the anchor's
 * digest; the fingerprint the officer publishes is derived from that digest.
 *
 * Only a cadre OWNER can mint an invitation. This phone is one when:
 *  - it founded its cadre and set up an owner key (`ready`);
 *  - it founded its cadre WITHOUT one — every Authority phone before this card — (`needs-owner-setup`):
 *    the owner key is set up after an explicit confirm, exactly as the drone and the spike harness
 *    do it (identity owner key → anchor it → genesis `OwnerKey` row → seed bootstrap). Proven AFTER
 *    the network and its strand already exist (spike 100 `product-join.ts` OWNER_LATE=1, 2/2);
 *  - otherwise the cadre has an owner that is not this phone (`not-owner`, e.g. a phone that joined
 *    a drone's cadre): the owner device must invite voters.
 *
 * A phone that joined a cadre BY INVITATION (its own CadrePeer row has no vouch signature but a vouch
 * usage) is never offered owner setup: it must not genesis-insert itself as an owner of someone else's
 * cadre (D-09: pins come only from an invitation or the operator; cadre-core makes the same point at
 * `cadre-node.js` ~l.7155). That predicate mirrors `self-voucher.ts` `isInvitationAdmitted`.
 *
 * Nothing here logs the invitation or the code: the invitation carries its private key, a bearer
 * credential for cadre membership.
 *
 * Browser pairing (D-26) uses the same mint for a different invitation: single use and 15 minutes at
 * most, minted only on a phone that ALREADY owns its cadre (`createPairingInvitation`), never by running
 * owner setup, because the request comes from another phone over the network. That invitation is never
 * logged either.
 */
import type { CadrePeerRow } from '@serfab/cadre-core';
import type { FoundingAnchor, INetworksEngine } from '@votetorrent/vote-core';

/** How many voters one code admits. A leaked code admits at most this many strangers as cadre members. */
export const VOTER_INVITE_USES = 1000;

/**
 * How long a code stays valid. cadre-core's default for a non-owner invitation is 24 h, far shorter
 * than a registration window; 30 days covers one, and the officer can mint a new code at any time.
 */
export const VOTER_INVITE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** The slice of a cadre-core `CadreNode` minting needs (the real class satisfies it). */
export interface VoterInviteNode {
	readonly peerId?: { toString(): string };
	/** This machine's own addresses; empty on a phone until a relay grants it a reservation. */
	getMultiaddrs(): string[];
	getIdentityOwnerKey(): { publicKeyB64: string; privateKeyB64: string };
	getControlDatabase(): {
		getOwnerKeys(): Promise<ReadonlySet<string>>;
		ensureOwnerKey(key: string): Promise<boolean>;
		queryCadrePeers(retry?: boolean): Promise<ReadonlyArray<Pick<CadrePeerRow, 'peerId' | 'vouchSig' | 'vouchUsage'>>>;
	} | null;
	getSeedBootstrapService(): { canAuthorize(): boolean } | null;
	trustOwnerKeys(keys: Iterable<string>, source: 'operator'): Promise<void>;
	initializeSeedBootstrap(ownerPrivateKey: string): Promise<void>;
	/** cadre-core 1.18: an invitation never grants ownership, so there is no `grantsOwner` option. */
	createCadreInvitation(options: {
		uses?: number;
		expiresInMs?: number;
	}): Promise<{ encoded: string; invitation: { invite: { expiresAt: string | null } } }>;
}

export type VoterInviteCapability = 'ready' | 'needs-owner-setup' | 'not-owner' | 'unavailable';

/**
 * Was this phone admitted to the cadre by an invitation? Its own row then has no vouch signature but a
 * vouch usage (the `self-voucher.ts` `isInvitationAdmitted` predicate). Throws when the peer id or the
 * rows cannot be read, so callers fail closed.
 */
async function selfAdmittedByInvitation(
	node: VoterInviteNode,
	db: NonNullable<ReturnType<VoterInviteNode['getControlDatabase']>>,
): Promise<boolean> {
	const self = node.peerId?.toString();
	if (!self) throw new Error('voter-invite: this device has no peer id yet');
	const rows = await db.queryCadrePeers();
	return rows.some((row) => row.peerId === self && row.vouchSig === null && row.vouchUsage != null);
}

/** Can this phone mint voter invitations, and if not, why. Never throws. */
export async function voterInviteCapability(node: VoterInviteNode | null | undefined): Promise<VoterInviteCapability> {
	if (!node) return 'unavailable';
	try {
		const self = node.getIdentityOwnerKey().publicKeyB64;
		const db = node.getControlDatabase();
		if (!db) return 'unavailable';
		const owners = await db.getOwnerKeys();
		if (owners.size === 0) return (await selfAdmittedByInvitation(node, db)) ? 'not-owner' : 'needs-owner-setup';
		return owners.has(self) ? 'ready' : 'not-owner';
	} catch {
		return 'unavailable';
	}
}

/**
 * Make this phone the cadre's owner (only when the cadre has NO owner yet), then wire the seed
 * bootstrap that signs invitations. Idempotent: an existing genesis row is kept (`ensureOwnerKey`
 * returns false).
 *
 * The seed bootstrap is wired only while it cannot authorize. The boot re-anchor
 * (`wireOwnKeyIfOwner`, CadreNodeProvider) already wires it on an owner phone, and a second
 * `initializeSeedBootstrap` re-registers `/sereus/seed/1.0.0`, which libp2p refuses with
 * `DuplicateProtocolHandlerError`. So the guard asks cadre-core instead of keeping per-launch state.
 * A phone admitted by invitation is refused before any write.
 */
export async function ensureVoterInviteOwner(node: VoterInviteNode): Promise<void> {
	const owner = node.getIdentityOwnerKey();
	const db = node.getControlDatabase();
	if (!db) throw new Error('voter-invite: control database unavailable');
	const owners = await db.getOwnerKeys();
	if (owners.size > 0 && !owners.has(owner.publicKeyB64)) {
		throw new Error('voter-invite: this device is not an owner of its cadre');
	}
	if (owners.size === 0) {
		if (await selfAdmittedByInvitation(node, db)) {
			throw new Error('voter-invite: this device joined its cadre by invitation and cannot become its owner');
		}
		await node.trustOwnerKeys([owner.publicKeyB64], 'operator');
		await db.ensureOwnerKey(owner.publicKeyB64);
	}
	if (!node.getSeedBootstrapService()?.canAuthorize()) {
		await node.initializeSeedBootstrap(owner.privateKeyB64);
	}
}

/**
 * Why a join code could not be made, as a closed set the card maps to its own sentence. The
 * engine's and cadre-core's error text is never shown or logged: it can carry ids.
 *  - `not-reachable`: cadre-core refused the mint and this phone has no address of its own (no relay
 *    reservation), so a voter's phone would have nothing to dial;
 *  - `not-founding-officer`: this phone's officer did not found the network, so it has no anchor;
 *  - `open-timeout`: the network did not open in time (raised by the card, which owns the open).
 */
export type VoterInviteFailureReason = 'not-reachable' | 'not-founding-officer' | 'open-timeout';

export class VoterInviteError extends Error {
	readonly reason: VoterInviteFailureReason;

	constructor(reason: VoterInviteFailureReason) {
		// A fixed message: callers read `reason`, never the text.
		super('voter-invite: refused');
		this.name = 'VoterInviteError';
		this.reason = reason;
	}
}

/** Does this phone have an address of its own? A read that throws counts as none. */
function hasOwnAddress(node: VoterInviteNode): boolean {
	try {
		return node.getMultiaddrs().length > 0;
	} catch {
		return false;
	}
}

export interface VoterJoinCodeResult {
	readonly code: string;
	readonly fingerprint: string;
	/** cadre-core's T-form UTC datetime (no zone suffix), or null if it never expires. */
	readonly expiresAt: string | null;
	readonly networkName: string;
}

/**
 * Mint an untargeted voter invitation and build the join code for `networkHash`. The network
 * must already be open in `networksEngine`; `founder` is this device's officer (its founding
 * rows select the anchor, exactly as the founding-bundle export does).
 *
 * Rejects with a {@link VoterInviteError} for the refusals the card can name; anything else is
 * rethrown unchanged.
 */
export async function createVoterJoinCode(args: {
	node: VoterInviteNode;
	networksEngine: Pick<INetworksEngine, 'getFoundingAnchor'>;
	networkHash: string;
	founder: { userId: string; signerKey: string };
}): Promise<VoterJoinCodeResult> {
	let anchor: FoundingAnchor;
	try {
		anchor = await args.networksEngine.getFoundingAnchor(args.networkHash, args.founder);
	} catch (err) {
		if ((err as { code?: unknown } | null)?.code === 'not-founding-officer') throw new VoterInviteError('not-founding-officer');
		throw err;
	}
	await ensureVoterInviteOwner(args.node);
	let minted: Awaited<ReturnType<VoterInviteNode['createCadreInvitation']>>;
	try {
		minted = await args.node.createCadreInvitation({
			uses: VOTER_INVITE_USES,
			expiresInMs: VOTER_INVITE_LIFETIME_MS,
		});
	} catch (err) {
		// Judged by this phone's own state, not by cadre-core's message text, which can change.
		if (!hasOwnAddress(args.node)) throw new VoterInviteError('not-reachable');
		throw err;
	}
	// Required lazily, like the other engine-only paths in this app: screens import this module, and
	// several screen suites stub vote-core to an empty module that vote-engine's barrel cannot load.
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { encodeNetworkJoinCode } = require('@votetorrent/vote-engine/rn') as typeof import('@votetorrent/vote-engine/rn');
	const code = encodeNetworkJoinCode({
		v: 2,
		invitation: minted.encoded,
		networkHash: anchor.networkHash,
		name: anchor.name,
		genesis: anchor.genesis,
		digest: anchor.digest,
	});
	return { code, fingerprint: anchor.fingerprint, expiresAt: minted.invitation.invite.expiresAt, networkName: anchor.name };
}

/** cadre-core's zone-less T-form datetime, read as UTC; null when absent or unreadable. */
export function inviteExpiryMs(expiresAt: string | null): number | null {
	if (!expiresAt) return null;
	const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(expiresAt) ? expiresAt : `${expiresAt}Z`);
	return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------------------------
// Browser pairing (D-26, D-22)
// ---------------------------------------------------------------------------------------------

/** A pairing invitation admits ONE machine (the officer's browser): a leaked code admits at most one. */
export const PAIR_INVITE_USES = 1;

/** A pairing invitation lives 15 minutes at most: it dies with the pairing statement it was minted for. */
export const PAIR_INVITE_LIFETIME_MS = 15 * 60_000;

/** The minting slice for pairing: the invitation row's `key` is the log's and the browser's handle on it. */
export interface PairingInviteNode extends VoterInviteNode {
	createCadreInvitation(options: {
		uses?: number;
		expiresInMs?: number;
	}): Promise<{ encoded: string; invitation: { invite: { key: string; expiresAt: string | null } } }>;
}

/**
 * Why a pairing invitation was refused. A separate set (and class) from {@link VoterInviteFailureReason},
 * whose every member the voter invite card maps to copy. The pair-mint service maps `not-owner` to its
 * `not-owner` refusal code.
 */
export type PairingInviteFailureReason = 'not-owner';

export class PairingInviteError extends Error {
	readonly reason: PairingInviteFailureReason;

	constructor(reason: PairingInviteFailureReason) {
		// A fixed message: callers read `reason`, never the text.
		super('pairing-invite: refused');
		this.name = 'PairingInviteError';
		this.reason = reason;
	}
}

/**
 * Mint one single-use pairing invitation of at most {@link PAIR_INVITE_LIFETIME_MS} (`options.expiresInMs`
 * shortens it, so the invitation dies with its statement). Only on a phone that already owns its cadre:
 * this is reached by a REMOTE request (an officer's phone over pair-mint), and a request from the network
 * must never make this phone an owner, so anything but capability `ready` is refused `not-owner` and owner
 * setup (`ensureVoterInviteOwner`) is never run here. Mint failures are judged by this phone's own state,
 * as for voter codes. The invitation is never logged and never put in an error.
 */
export async function createPairingInvitation(
	node: PairingInviteNode,
	options?: { expiresInMs?: number },
): Promise<{ encoded: string; inviteKey: string; expiresAt: string }> {
	const requested = options?.expiresInMs;
	if (requested !== undefined && !(Number.isFinite(requested) && requested > 0)) {
		throw new Error('pairing-invite: bad lifetime');
	}
	const lifetime = Math.min(requested ?? PAIR_INVITE_LIFETIME_MS, PAIR_INVITE_LIFETIME_MS);
	if ((await voterInviteCapability(node)) !== 'ready') throw new PairingInviteError('not-owner');
	let minted: Awaited<ReturnType<PairingInviteNode['createCadreInvitation']>>;
	try {
		minted = await node.createCadreInvitation({ uses: PAIR_INVITE_USES, expiresInMs: lifetime });
	} catch (err) {
		if (!hasOwnAddress(node)) throw new VoterInviteError('not-reachable');
		throw err;
	}
	const inviteKey = (minted?.invitation?.invite as { key?: unknown } | undefined)?.key;
	const expiresAt = minted?.invitation?.invite?.expiresAt;
	if (typeof inviteKey !== 'string' || inviteKey.length === 0 || typeof expiresAt !== 'string' || expiresAt.length === 0) {
		throw new Error('pairing-invite: mint result incomplete');
	}
	return { encoded: minted.encoded, inviteKey, expiresAt };
}
