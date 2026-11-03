/**
 * dashboard-pairing.ts — an officer pairs THEIR OWN browser from their own phone (D-06, D-22, D-26).
 *
 * The flow, one attempt = one call to `requestPairingCode`:
 *  1. The network's join anchor arrives ONLY through the injected `readAnchor` port. The screen binds
 *     it to the networks engine's revision-tolerant join-anchor reader, which never refuses after an
 *     Admin revision, so pairing keeps working once a second officer has been promoted. No genesis
 *     reader is hand-rolled here and this file never reads founding rows itself.
 *  2. A non-owner phone finds the owner phones (`findOwnerTargets`); an owner phone uses the injected
 *     `localMint` and dials nobody.
 *  3. ONE biometric signature: the digest is `pairingStatementDigest(networkHash, userId, nonce,
 *     expiresAt, requesterPeerId)` (never built by hand) and the injected signer is called exactly
 *     once. The same signature goes into the mint request and into the code's statement.
 *     `requesterPeerId` is this phone's identity peerId, which cadre-core defines as the CONTROL
 *     node's peerId, and only the control node dials (the owner refuses a statement whose
 *     requesterPeerId is not the connection's remote peer).
 *  4. The request goes to one owner at a time and is NEVER resent after it went out
 *     (`requestSent: true`): the owner may already have minted, and a resend would spend a second
 *     single-use invitation. A refusal is final for that request. Retry is a NEW call with a fresh
 *     nonce, expiry and signature (the owner burns a nonce it has judged).
 *  5. The minted invitation must be single use and untargeted, for this cadre, and issued by an
 *     owner this phone knows. Its member list is trimmed to `PAIRING_INVITE_MAX_ADDRS` (relay
 *     addresses first) so the code fits one QR code, then `encodeNetworkJoinCode` +
 *     `encodePairingCode` build the `vtpair1.` code.
 *  6. The pairing is recorded on this phone (D-25, local metadata only) BEFORE the code is returned.
 *     Without that record this phone could not later remove the browser, so a failed write fails
 *     the attempt.
 *
 * Every failure resolves to a closed reason; no prompt is raised for a failure known before
 * signing (no control node, no anchor, no owner target, busy, aborted). The function rejects only
 * with a signer error that carries a string `code`, unchanged, so the screen's device-signing error
 * handler routes it.
 *
 * Bearer hygiene: the code, the encoded invitation and its private key are never logged, stored,
 * put in an error or returned anywhere but the `code` field of a successful result.
 *
 * The screen supplies `signer` (from `createDeviceSigner`), `readAnchor`, `db` and, on an owner
 * phone, `localMint` (the owner host's local handler).
 */
import type { CadreInvitation } from '@serfab/cadre-core';
import type { NetworkJoinAnchor } from '@votetorrent/vote-core';
import type {
	PairMintMintRequest,
	PairMintRefusalCode,
	PairMintReply,
	pairingStatementDigest as PairingStatementDigestFn,
	requestPairMint as RequestPairMintFn,
} from '@votetorrent/vote-engine/rn';
import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils.js';
import type { SignCallback } from './device-signer';
import { getDeviceUser } from './device-user';
import {
	createPairMintFailoverClient,
	findOwnerTargets,
	PairMintCancelledError,
	PairMintNoReplyError,
	PairMintUnreachableError,
	type DialTarget,
	type PairMintClientNode,
} from './pair-mint-client';
import { recordPairedBrowser, type PairedBrowserEntry } from './paired-browsers-store';
import { voterInviteCapability, type VoterInviteCapability, type VoterInviteNode } from './voter-invite';

/** At most this many member addresses ride in a pairing code (about 2620 B with 4: fits the QR budget). */
export const PAIRING_INVITE_MAX_ADDRS = 4;

/**
 * How long a signed statement is valid: the owner's mint window (15 min) less one minute, which
 * leaves room for an officer clock up to 3 min ahead of the owner's under the owner's skew bound.
 * Pinned to `PAIR_MINT_WINDOW_MS - 60_000` by the test (a literal here keeps vote-engine lazy).
 */
export const PAIRING_STATEMENT_LIFETIME_MS = 14 * 60_000;

export type PairingCapability = 'ready-owner' | 'ready-officer' | 'no-network' | 'not-officer' | 'no-signing-key';

export interface PairingCapabilityState {
	readonly hasNode: boolean;
	readonly networkHash: string | null;
	readonly inviteCapability: VoterInviteCapability;
	readonly isCurrentOfficer: boolean;
	readonly signingKey: { key: string; type: string } | null;
}

/** P-256 hardware device key (`UserKeyType.p256`). */
const P256_KEY_TYPE = 'P';

/**
 * What this phone can do about pairing a browser. Pure. `needs-owner-setup` reads as
 * `ready-officer`: the cadre has no owner yet, so the request ends `owner-unreachable`.
 */
export function pairingCapability(state: PairingCapabilityState): PairingCapability {
	if (!state.hasNode || state.networkHash === null || state.inviteCapability === 'unavailable') return 'no-network';
	if (!state.isCurrentOfficer) return 'not-officer';
	if (state.signingKey === null || state.signingKey.type !== P256_KEY_TYPE) return 'no-signing-key';
	if (state.inviteCapability === 'ready') return 'ready-owner';
	return 'ready-officer';
}

type VoteEngineRn = typeof import('@votetorrent/vote-engine/rn');
type PairingDb = Parameters<typeof PairingStatementDigestFn>[0];

/** Required lazily: screens import this module and several screen suites stub vote-core. */
function voteEngine(): VoteEngineRn {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	return require('@votetorrent/vote-engine/rn') as VoteEngineRn;
}

function canonical(ms: number): string {
	return new Date(ms).toISOString().slice(0, 19);
}

/**
 * Gather the capability inputs. Never throws: each read that throws counts as its failing value.
 * Read-only: the device user is only read, never created or provisioned (a key lookup must never
 * reach a provisioning path, which rotates the key on Android). A device user that is not `userId`
 * has no signing key for this officer.
 */
export async function loadPairingCapabilityState(args: {
	node: unknown;
	db: unknown | null;
	networkHash: string | null;
	userId: string | null;
	deps?: {
		voterInviteCapability?: (node: VoterInviteNode | null | undefined) => Promise<VoterInviteCapability>;
		getDeviceUser?: () => Promise<{ id: string; activeKeys?: ReadonlyArray<{ key: string; type?: string }> } | undefined>;
		isCurrentPairingOfficer?: (db: PairingDb, a: { userId: string; nowCanonical: string }) => Promise<boolean>;
		nowMs?: () => number;
	};
}): Promise<PairingCapabilityState> {
	const deps = args.deps ?? {};
	const hasNode = args.node !== null && args.node !== undefined;
	const networkHash = typeof args.networkHash === 'string' && args.networkHash.length > 0 ? args.networkHash : null;

	let inviteCapability: VoterInviteCapability = 'unavailable';
	try {
		inviteCapability = await (deps.voterInviteCapability ?? voterInviteCapability)(
			hasNode ? (args.node as VoterInviteNode) : null,
		);
	} catch {
		inviteCapability = 'unavailable';
	}

	let signingKey: { key: string; type: string } | null = null;
	try {
		const user = await (deps.getDeviceUser ?? getDeviceUser)();
		const first = user?.activeKeys?.[0];
		if (user && (args.userId === null || user.id === args.userId) && first && typeof first.key === 'string' && first.key.length > 0) {
			signingKey = { key: first.key, type: String(first.type ?? '') };
		}
	} catch {
		signingKey = null;
	}

	let isCurrentOfficer = false;
	if (args.db && typeof args.userId === 'string' && args.userId.length > 0) {
		try {
			const check = deps.isCurrentPairingOfficer ?? voteEngine().isCurrentPairingOfficer;
			isCurrentOfficer =
				(await check(args.db as PairingDb, {
					userId: args.userId,
					nowCanonical: canonical((deps.nowMs ?? Date.now)()),
				})) === true;
		} catch {
			isCurrentOfficer = false;
		}
	}

	return { hasNode, networkHash, inviteCapability, isCurrentOfficer, signingKey };
}

// ---------------------------------------------------------------------------------------------
// The anchor port

/** Why the anchor could not be read. The revision-tolerant reader never produces `admin-revised`. */
export type PairingAnchorFailure = 'admin-revised' | 'not-open' | 'unreadable';
export type PairingAnchorResult = { ok: true; anchor: NetworkJoinAnchor } | { ok: false; anchor: PairingAnchorFailure };
/** The screen binds this to the networks engine's join-anchor reader. A rejection reads as `unreadable`. */
export type ReadPairingAnchor = () => Promise<PairingAnchorResult>;

const ANCHOR_FAILURES: readonly PairingAnchorFailure[] = ['admin-revised', 'not-open', 'unreadable'];

// ---------------------------------------------------------------------------------------------
// Invitation trim

/**
 * Keep at most `max` member addresses, relay-circuit ones first (stable within each group). Every
 * other field is taken unchanged. `members` and `ownerKeys` are not covered by the issuer's `'add'`
 * signature (that covers key, peerId, expiresAt, totalUses and stampId only), so trimming keeps the
 * invitation valid. Measured: 4 addresses put a pairing code at about 2620 B against the 2953 B QR
 * budget, 6 go over it. The trim is done here, on the requesting phone, so the owner host mints
 * with cadre-core's own selection unchanged.
 */
export function trimInvitationMembers(invitation: CadreInvitation, max: number = PAIRING_INVITE_MAX_ADDRS): CadreInvitation {
	const members = Array.isArray(invitation.members) ? invitation.members : [];
	const circuit = members.filter((m) => typeof m === 'string' && m.includes('/p2p-circuit'));
	const direct = members.filter((m) => !(typeof m === 'string' && m.includes('/p2p-circuit')));
	return { ...invitation, members: [...circuit, ...direct].slice(0, Math.max(0, max)) };
}

// ---------------------------------------------------------------------------------------------
// requestPairingCode

export type PairingRequestFailureReason =
	| 'owner-unreachable'
	| 'switched-off'
	| 'not-allowed'
	| 'not-reachable'
	| 'build-failed'
	| 'cancelled';

export type PairingRequestResult =
	| { ok: true; code: string; nonce: string; expiresAt: string }
	| {
			ok: false;
			reason: PairingRequestFailureReason;
			refusal?: PairMintRefusalCode;
			requestSent?: boolean;
			anchor?: PairingAnchorFailure;
	  };

/** Every refusal the owner can send, mapped. Typed as a full record so a new code fails to compile. */
const REFUSAL_TO_REASON: Readonly<Record<PairMintRefusalCode, PairingRequestFailureReason>> = Object.freeze({
	'not-officer': 'not-allowed',
	'bad-signature': 'not-allowed',
	expired: 'not-allowed',
	'rate-limited': 'not-allowed',
	'switched-off': 'switched-off',
	'not-reachable': 'not-reachable',
	'not-owner': 'owner-unreachable',
	replayed: 'build-failed',
	'requester-mismatch': 'build-failed',
	malformed: 'build-failed',
	'unknown-pairing': 'build-failed',
});

/** The refusal mapping, for the screen and the tests. */
export function pairingRefusalReason(code: PairMintRefusalCode): PairingRequestFailureReason {
	return Object.prototype.hasOwnProperty.call(REFUSAL_TO_REASON, code) ? REFUSAL_TO_REASON[code] : 'build-failed';
}

/** The slice of a cadre-core `CadreNode` pairing needs. */
export interface PairingNode extends PairMintClientNode {
	readonly partyId?: string;
}

export interface InvitationCodec {
	decodeCadreInvitation(encoded: string): CadreInvitation;
	encodeCadreInvitation(invitation: CadreInvitation): string;
}

export interface RequestPairingCodeDeps {
	nowMs?: () => number;
	randomBytes?: (n: number) => Uint8Array;
	pairingStatementDigest?: (db: PairingDb, f: Parameters<typeof PairingStatementDigestFn>[1]) => Promise<Uint8Array>;
	invitationCodec?: InvitationCodec;
	findOwnerTargets?: (node: PairMintClientNode) => Promise<DialTarget[]>;
	request?: typeof RequestPairMintFn;
	targetTimeoutMs?: number;
	totalBudgetMs?: number;
	recordPairedBrowser?: (entry: PairedBrowserEntry) => Promise<void>;
}

const PEER_ID_RE = /^[A-Za-z0-9]{1,128}$/;
const KEY_PUB_RE = /^(?:[0-9a-fA-F]{66}|[0-9a-fA-F]{130})$/;
const SIG_RE = /^[0-9a-fA-F]+$/;

let pairingInFlight = false;

function fail(
	reason: PairingRequestFailureReason,
	extra?: { refusal?: PairMintRefusalCode; requestSent?: boolean; anchor?: PairingAnchorFailure },
): PairingRequestResult {
	return { ok: false, reason, ...(extra ?? {}) };
}

function base64urlUnpadded(bytes: Uint8Array): string {
	const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
	let out = '';
	let i = 0;
	for (; i + 2 < bytes.length; i += 3) {
		const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
		out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
	}
	const rest = bytes.length - i;
	if (rest === 1) {
		const n = bytes[i] << 16;
		out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
	} else if (rest === 2) {
		const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
		out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63];
	}
	return out;
}

/**
 * Build one pairing code for `userId`'s browser on `networkHash` (flow in the header). Rejects only
 * with a signer error carrying a string `code`, unchanged.
 */
export async function requestPairingCode(args: {
	node: PairingNode;
	db: PairingDb;
	signer: SignCallback;
	networkHash: string;
	userId: string;
	keyPub: string;
	readAnchor: ReadPairingAnchor;
	localMint?: (request: PairMintMintRequest) => Promise<PairMintReply>;
	label?: string | null;
	signal?: AbortSignal;
	deps?: RequestPairingCodeDeps;
}): Promise<PairingRequestResult> {
	// 1. One attempt at a time per phone: a concurrent call never raises a second prompt.
	if (pairingInFlight) return fail('cancelled');
	pairingInFlight = true;
	try {
		return await runPairingAttempt(args);
	} finally {
		pairingInFlight = false;
	}
}

async function runPairingAttempt(args: Parameters<typeof requestPairingCode>[0]): Promise<PairingRequestResult> {
	const deps = args.deps ?? {};
	const nowMs = deps.nowMs ?? Date.now;
	const { node, networkHash, userId, keyPub, signal } = args;

	// 2. Nothing to ask with: no prompt.
	if (signal?.aborted) return fail('cancelled');
	let control: unknown = null;
	let requesterPeerId: string | null = null;
	try {
		control = node.getControlNode();
		const id = node.peerId?.toString();
		requesterPeerId = typeof id === 'string' && id.length > 0 ? id : null;
	} catch {
		control = null;
	}
	if (!control || !requesterPeerId || !PEER_ID_RE.test(requesterPeerId)) return fail('build-failed');
	if (typeof networkHash !== 'string' || networkHash.length === 0) return fail('build-failed');
	if (typeof userId !== 'string' || userId.length === 0) return fail('build-failed');
	if (typeof keyPub !== 'string' || !KEY_PUB_RE.test(keyPub)) return fail('build-failed');

	// 3. The anchor, through the port only.
	let anchorResult: PairingAnchorResult;
	try {
		anchorResult = await args.readAnchor();
	} catch {
		return fail('build-failed', { anchor: 'unreadable' });
	}
	if (!anchorResult || anchorResult.ok !== true) {
		const failure = (anchorResult as { anchor?: unknown } | null)?.anchor;
		return fail('build-failed', {
			anchor: ANCHOR_FAILURES.includes(failure as PairingAnchorFailure) ? (failure as PairingAnchorFailure) : 'unreadable',
		});
	}
	const anchor = anchorResult.anchor;
	if (!anchor || anchor.networkHash !== networkHash) return fail('build-failed');
	if (signal?.aborted) return fail('cancelled');

	// 4. Whom to ask (a non-owner phone): nobody reachable means no prompt.
	let targets: DialTarget[] = [];
	if (!args.localMint) {
		targets = await (deps.findOwnerTargets ?? findOwnerTargets)(node);
		if (targets.length === 0) return fail('owner-unreachable');
		if (signal?.aborted) return fail('cancelled');
	}

	// 5. The statement and its digest (never built by hand).
	let nonce: string;
	let expiresAt: string;
	let digest: Uint8Array;
	try {
		nonce = base64urlUnpadded((deps.randomBytes ?? nobleRandomBytes)(16));
		expiresAt = canonical(nowMs() + PAIRING_STATEMENT_LIFETIME_MS);
		const digestOf = deps.pairingStatementDigest ?? voteEngine().pairingStatementDigest;
		digest = await digestOf(args.db, { networkHash, userId, nonce, expiresAt, requesterPeerId });
	} catch {
		return fail('build-failed');
	}
	if (signal?.aborted) return fail('cancelled');

	// 6. ONE signature for this attempt.
	let signature: Awaited<ReturnType<SignCallback>>;
	try {
		signature = await args.signer(digest);
	} catch (err) {
		if (typeof (err as { code?: unknown } | null)?.code === 'string') throw err;
		return fail('build-failed');
	}
	if (
		!signature ||
		signature.signerUserId !== userId ||
		signature.signerKey !== keyPub ||
		typeof signature.signature !== 'string' ||
		!SIG_RE.test(signature.signature) ||
		signature.signature.length < 16 ||
		signature.signature.length > 288 ||
		signature.signature.length % 2 !== 0
	) {
		return fail('build-failed');
	}
	const sig = signature.signature;

	// 7. One request, one owner answer at most; never sent twice.
	const request: PairMintMintRequest = {
		t: 'mint',
		v: 1,
		networkHash,
		userId,
		nonce,
		expiresAt,
		requesterPeerId,
		keyPub,
		sig,
	};
	let reply: PairMintReply;
	if (args.localMint) {
		try {
			reply = await args.localMint(request);
		} catch {
			return fail('build-failed');
		}
	} else {
		try {
			const client = createPairMintFailoverClient(control, targets, {
				...(deps.request ? { request: deps.request } : {}),
				...(deps.targetTimeoutMs !== undefined ? { targetTimeoutMs: deps.targetTimeoutMs } : {}),
				...(deps.totalBudgetMs !== undefined ? { totalBudgetMs: deps.totalBudgetMs } : {}),
				nowMs,
			});
			reply = await client.call(request, { signal });
		} catch (err) {
			if (err instanceof PairMintCancelledError) return fail('cancelled');
			if (err instanceof PairMintNoReplyError) return fail('owner-unreachable', { requestSent: true });
			if (err instanceof PairMintUnreachableError) return fail('owner-unreachable');
			return fail('build-failed');
		}
	}
	if (!reply || typeof reply !== 'object') return fail('build-failed');
	if (reply.t === 'refused') return fail(pairingRefusalReason(reply.code), { refusal: reply.code });
	if (reply.t !== 'minted') return fail('build-failed');

	// 8. The invitation must be single use, untargeted, for this cadre, from an owner this phone knows.
	let codec: InvitationCodec;
	let invitation: CadreInvitation;
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		codec = deps.invitationCodec ?? (require('@serfab/cadre-core') as InvitationCodec);
		invitation = codec.decodeCadreInvitation(reply.invitation);
	} catch {
		return fail('build-failed');
	}
	let ownerKeys: Set<string>;
	try {
		ownerKeys = new Set((await node.listOwnerKeys()).map((k) => k.key));
	} catch {
		return fail('build-failed');
	}
	const invite = invitation?.invite as (CadreInvitation['invite'] & { issuerKey?: unknown }) | undefined;
	const partyId = node.partyId;
	if (
		!invite ||
		invite.totalUses !== 1 ||
		invite.peerId !== null ||
		invite.key !== reply.inviteKey ||
		typeof partyId !== 'string' ||
		invitation.partyId !== partyId ||
		typeof invite.issuerKey !== 'string' ||
		!ownerKeys.has(invite.issuerKey) ||
		!Array.isArray(invitation.ownerKeys) ||
		invitation.ownerKeys.length === 0 ||
		!invitation.ownerKeys.every((k) => ownerKeys.has(k)) ||
		anchor.networkHash !== networkHash
	) {
		return fail('build-failed');
	}

	// 9. Trim, re-encode, assemble.
	const trimmed = trimInvitationMembers(invitation);
	if (trimmed.members.length === 0) return fail('not-reachable');
	let code: string;
	try {
		const ve = voteEngine();
		const joinCode = ve.encodeNetworkJoinCode({
			v: 2,
			invitation: codec.encodeCadreInvitation(trimmed),
			networkHash: anchor.networkHash,
			name: anchor.name,
			genesis: anchor.genesis,
			digest: anchor.digest,
		});
		code = ve.encodePairingCode({
			statement: { userId, requesterPeerId, nonce, expiresAt, keyPub, sig },
			joinCode,
		});
	} catch {
		return fail('build-failed');
	}

	// 10. Record on this phone first (D-25), then hand the code over.
	if (signal?.aborted) return fail('cancelled');
	try {
		await (deps.recordPairedBrowser ?? recordPairedBrowser)({
			nonce,
			userId,
			networkHash,
			inviteKey: reply.inviteKey,
			mintedAt: nowMs(),
			expiresAt,
			label: args.label ?? null,
		});
	} catch {
		return fail('build-failed');
	}
	return { ok: true, code, nonce, expiresAt };
}
