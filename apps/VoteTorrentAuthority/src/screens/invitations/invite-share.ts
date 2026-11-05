/**
 * invite-share.ts - parse a pasted invitation share and resolve its InviteSlot.
 *
 * Why the slot Cid must be RESOLVED: the share carries {invitePrivate, inviteKey, expiration, type,
 * name}, but the slot Cid digests ElectionId, InviteSignature and SigningNonce, which the share does
 * not carry. The invitee therefore cannot recompute it; it is looked up engine-side by
 * (InviteKey, Type) via `IInvitationEngine.resolveInviteSlot`, which resolves a resent share to the
 * live head of its resend chain (62-REVIEW.md CR-01) and reports a withdrawn or expired share as
 * `no-longer-valid` instead of handing back a stale slot (CR-02).
 *
 * Cross-device precondition: the lookup only finds a slot whose InviteSlot row is present in this
 * device's database. Replication of that row to the invitee's strand is a separate (P2P) concern.
 *
 * Expiration spelling: the engine stores/signs a designator-less UTC datetime (e.g.
 * '2026-10-06T08:49:05.107'). That spelling is an input to the InviteSlot Cid digest and the invite
 * signature, so it is intentionally NOT rewritten; readers use parseInviteExpirationMs instead.
 *
 * No-raw-text rule: error messages are FIXED strings per code. They never include the key, the Cid,
 * or the name, and nothing in this module logs share content.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import type { IInvitationEngine, InviteType } from '@votetorrent/vote-core';

export type InviteShareErrorCode = 'malformed' | 'wrong-type' | 'not-found' | 'already-answered' | 'no-longer-valid';

const MESSAGES: Record<InviteShareErrorCode, string> = {
	malformed: 'Invitation text is malformed',
	'wrong-type': 'Invitation is for a different role',
	'not-found': 'Invitation not found on this device',
	'already-answered': 'Invitation has already been answered',
	'no-longer-valid': 'Invitation was withdrawn or has expired',
};

export class InviteShareError extends Error {
	readonly code: InviteShareErrorCode;
	constructor(code: InviteShareErrorCode) {
		super(MESSAGES[code]);
		this.name = 'InviteShareError';
		this.code = code;
	}
}

export interface ParsedInviteShare {
	invitePrivate: string;
	inviteKey: string;
	type?: InviteType;
	name?: string;
	expiration?: string;
}

const HEX64 = /^[0-9a-f]{64}$/i;
const TYPES: readonly string[] = ['au', 'of', 'k', 'r'];

function deriveInviteKey(invitePrivate: string): string | undefined {
	if (!HEX64.test(invitePrivate)) return undefined;
	try {
		return bytesToHex(secp256k1.getPublicKey(hexToBytes(invitePrivate)));
	} catch {
		return undefined;
	}
}

export function parseInviteShare(text: string): ParsedInviteShare | undefined {
	const trimmed = (text ?? '').trim();
	if (!trimmed) return undefined;

	if (HEX64.test(trimmed)) {
		const inviteKey = deriveInviteKey(trimmed);
		return inviteKey ? { invitePrivate: trimmed, inviteKey } : undefined;
	}

	let obj: unknown;
	try {
		obj = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (typeof obj !== 'object' || obj === null) return undefined;
	const rec = obj as Record<string, unknown>;
	if (typeof rec.invitePrivate !== 'string') return undefined;
	const derived = deriveInviteKey(rec.invitePrivate);
	if (!derived) return undefined;
	if (rec.inviteKey !== undefined && (typeof rec.inviteKey !== 'string' || rec.inviteKey.toLowerCase() !== derived.toLowerCase())) {
		return undefined;
	}
	const parsed: ParsedInviteShare = { invitePrivate: rec.invitePrivate, inviteKey: derived };
	if (typeof rec.type === 'string' && TYPES.includes(rec.type)) parsed.type = rec.type as InviteType;
	if (typeof rec.name === 'string') parsed.name = rec.name;
	if (typeof rec.expiration === 'string') parsed.expiration = rec.expiration;
	return parsed;
}

const HAS_DESIGNATOR = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Epoch ms of an invite expiration. A value with no zone designator (no trailing Z and no +hh:mm /
 * -hh:mm offset) is UTC, the same rule as vote-engine's fromCanonicalDatetime (utils.ts); Date.parse
 * would otherwise read it as local time. Unparseable -> undefined.
 */
export function parseInviteExpirationMs(value: string): number | undefined {
	const v = (value ?? '').trim();
	if (!v) return undefined;
	const ms = Date.parse(HAS_DESIGNATOR.test(v) ? v : `${v}Z`);
	return Number.isNaN(ms) ? undefined : ms;
}

/** True only when the share's expiration parses and is at or before now; unknown -> false (engine decides). */
export function isShareExpired(share: ParsedInviteShare, nowMs: number): boolean {
	if (share.expiration === undefined) return false;
	const ms = parseInviteExpirationMs(share.expiration);
	return ms !== undefined && ms <= nowMs;
}

/** The invite status the resolver already read (undefined only for a type with no status getter). */
type InviteStatusLike = Awaited<ReturnType<IInvitationEngine['getKeyholderInvite']>> | undefined;

export async function resolveInviteFromShare(
	engine: Pick<IInvitationEngine, 'resolveInviteSlot' | 'getKeyholderInvite' | 'getOfficerInvite' | 'getAuthorityInvite'>,
	text: string,
	expectedType: InviteType
): Promise<{ slotCid: string; invitePrivate: string; share: ParsedInviteShare; status: InviteStatusLike }> {
	const share = parseInviteShare(text);
	if (!share) throw new InviteShareError('malformed');
	if (share.type !== undefined && share.type !== expectedType) throw new InviteShareError('wrong-type');
	const resolution = await engine.resolveInviteSlot(share.inviteKey, expectedType);
	let slotCid: string;
	switch (resolution.status) {
		case 'live':
			slotCid = resolution.cid;
			break;
		case 'answered':
			throw new InviteShareError('already-answered');
		case 'no-longer-valid':
			throw new InviteShareError('no-longer-valid');
		case 'not-found':
		case 'ambiguous':
			throw new InviteShareError('not-found');
		default: {
			// A future status must never fall through to success.
			const _exhaustive: never = resolution;
			void _exhaustive;
			throw new InviteShareError('not-found');
		}
	}
	// Refuse an already-answered slot (accepted OR declined) BEFORE any caller provisions keys or
	// signs. The engine refuses it too (invite-already-answered), but this check spares the
	// provisioning prompts. The status read here is returned so callers need no second read.
	const status =
		expectedType === 'k'
			? await engine.getKeyholderInvite(slotCid)
			: expectedType === 'of'
				? await engine.getOfficerInvite(slotCid)
				: expectedType === 'au'
					? await engine.getAuthorityInvite(slotCid)
					: undefined;
	if (status?.result !== undefined) throw new InviteShareError('already-answered');
	return { slotCid, invitePrivate: share.invitePrivate, share, status };
}

export function inviteShareErrorKey(err: unknown): string | undefined {
	if (!(err instanceof InviteShareError)) return undefined;
	switch (err.code) {
		case 'malformed':
			return 'invitationAcceptMalformed';
		case 'wrong-type':
			return 'invitationAcceptWrongType';
		case 'not-found':
			return 'invitationAcceptNotFound';
		case 'already-answered':
			return 'invitationAcceptAlreadyAnswered';
		case 'no-longer-valid':
			return 'invitationAcceptNoLongerValid';
	}
}

const ENGINE_CODE_KEYS: Record<string, string> = {
	'invite-already-answered': 'invitationAcceptAlreadyAnswered',
	'invite-no-longer-valid': 'invitationAcceptNoLongerValid',
	'invite-superseded': 'invitationAcceptSuperseded',
	'invite-unverifiable': 'invitationAcceptNotFound',
	'self-invite': 'keyholderAcceptSelfInvite',
	'seat-already-held': 'keyholderAcceptSeatHeld',
};

/** Copy key for a share error or a coded engine/app refusal; undefined for anything else. */
export function inviteAcceptErrorKey(err: unknown): string | undefined {
	const shareKey = inviteShareErrorKey(err);
	if (shareKey) return shareKey;
	const code = (err as { code?: unknown } | null | undefined)?.code;
	return typeof code === 'string' && Object.prototype.hasOwnProperty.call(ENGINE_CODE_KEYS, code) ? ENGINE_CODE_KEYS[code] : undefined;
}

/**
 * Copy key for a failure to LOAD an invitation (the resolve effect): the specific share / coded
 * refusal copy when there is one, "select a network first" for the no-network state, otherwise the
 * load-failure copy (never the "could not respond" copy). Structural no-network check, as in
 * engine-factory's isNoNetworkEstablishedError, so it survives Metro module duplication.
 */
export function inviteLoadErrorKey(err: unknown): string {
	const specific = inviteAcceptErrorKey(err);
	if (specific) return specific;
	if ((err as { noNetworkEstablished?: unknown } | null | undefined)?.noNetworkEstablished === true) return 'invitationNeedsNetwork';
	return 'invitationLoadFailed';
}
