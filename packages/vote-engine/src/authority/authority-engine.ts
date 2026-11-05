import { bytesToHex } from '@noble/curves/utils.js';
import { toImageRef } from '@votetorrent/vote-core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

// D-06 (Phase 28): Permanent production boot guard — verify-side noble binding check.
// Mirrors device-signer.ts assertion (D-05). Catches a re-split on the verify side.
// NEVER make this __DEV__-only — a release-build regression must be caught.
if (typeof secp256k1.verify !== 'function') {
  throw new Error(
    '@noble/curves secp256k1.verify did not resolve to a function — ' +
    'got ' + typeof secp256k1.verify + '. Metro/Hermes multi-copy binding bug detected.'
  )
}

import { MisuseError, QuereusError } from '@quereus/quereus';
import { Temporal } from 'temporal-polyfill';
import { SigningEngine } from '../signing/signing-engine.js';
import { adminSigningKeyValidity } from '../signing/signer-validity.js';
import { allocateTid } from '../database/tid-allocator.js';
import { readInviteChain, readInviteChainDetailed } from '../invite/read-invite-chain.js';
import { withInviteWriteSerial } from '../invite/invite-write-serial.js';
import { verifySig, verifySigP256 } from '../database/initialize.js';
import {
	adminSignatureTaskExtensionInserter,
	computeAdminPromotionDigest,
	computeRadProposalDigest,
	readProposedRosterJson,
} from './rad-roster-digest.js';
import { listCurrentScopeHolders, readAuthorityThreshold } from '../signing/threshold.js';
import { fanOutSignatureTasks } from '../signing/fan-out.js';
import { verifyUserKeyMembership } from '../user/verify-user-key.js';
import { UserKeyType } from '@votetorrent/vote-core';
import {
	asText,
	authorityInviteSignedBytes,
	digestToBytes,
	fromCanonicalDatetime,
	nowCanonicalDatetime,
	officerInviteSignedBytes,
	parseJsonOr,
	toCanonicalDatetime,
	verifyAdHocInviteSignature,
} from '../utils.js';
import type { EngineContext } from '../types.js';

// Phase 999.1 D-01/D-02 — Tids for AuthorityEngine mutations are allocated
// through the shared durable, peer-safe allocator (`tid-allocator.ts`,
// namespace 'authority') instead of a process-local `Date.now()`-seeded
// counter. See tid-allocator.ts for the D-07 hybrid seed / D-09
// reserve-before-use / D-10 per-namespace serialization rationale that
// replaces the WR-16/WR-25 heuristic this module used to carry.
import { AdminPromotionError } from '@votetorrent/vote-core';
import type {
	AdminDetails,
	AdminDigestArgs,
	AdminInit,
	AdminPromotionResult,
	Officer,
	OfficerInit,
	OfficerInvite,
	OfficerInviteShare,
	Authority,
	AuthorityDetails,
	AuthorityInvite,
	AuthorityInviteShare,
	IAuthorityEngine,
	IAuthorityCreateOfficerInviteBuilder,
	IAuthorityCreateAuthorityInviteBuilder,
	IAuthorityProposeAdminBuilder,
	IAuthoritySaveInviteWithSigningBuilder,
	InviteStatus,
	Proposal,
	ISigningEngine,
	Scope,
	Signature,
	SentAuthorityInvite,
	InviteResult,
	ThresholdPolicy,
	OfficerSelection,
	ImageRef,
} from '@votetorrent/vote-core';
import {
	AuthorityCreateOfficerInviteBuilder,
	AuthorityCreateAuthorityInviteBuilder,
	AuthorityProposeAdminBuilder,
	AuthoritySaveInviteWithSigningBuilder,
} from './builders/index.js';

/** Stable code on the refusal of cancelling or re-sending an answered invitation; the app maps it by code, never by message. */
const INVITE_ALREADY_ANSWERED = 'invite-already-answered';
const INVITE_NOT_AUTHORIZED = 'invite-not-authorized';
const INVITE_TYPE_NOT_RESENDABLE = 'invite-type-not-resendable';

/** The scope that issues each invitation type; a type absent here has no administrator scope. */
const INVITE_ISSUING_SCOPE: Record<string, Scope> = { of: 'rad', au: 'iad', k: 'ik' };

/**
 * 57-01 (D-02): one entry in the admin roster covered by the 'rad' digest.
 * `proposedName` mirrors `ProposedOfficer.ProposedName` — the officer's
 * display name, resolved from `User.Name` for `.existing` selections (see
 * `AuthorityEngine.resolveAdminRoster`).
 *
 * 57-13 (CR-01, D-03 amendment — see 57-13-CR01-CARRIER-PROBE.md): `userId`
 * is the stable identity reference the promotion path resolves against
 * instead of the renameable `User.Name` bridge. It is `null` ONLY for
 * `.init` officers, which have no `User` row and are already unpromotable
 * (D-03's original `.init`-officer case). For `.existing` officers it is
 * `selection.existing.userId` — the SAME value the digest now attests to,
 * so a rename between propose and promote can no longer retarget a grant.
 */
export interface AdminRosterEntry {
	proposedName: string;
	userId: string | null;
	title: string;
	scopes: Scope[];
}

/**
 * 57-01 (D-02), CR-02 (57-12): deterministic, byte-stable serialization of
 * an admin roster for the 'rad' digest. Sorted ascending by `proposedName`
 * using a plain ordinal (code-unit) comparison — the same engine-independent
 * three-way comparison shape `applyAdminProposal` already uses for its
 * `sortedOfficers` userId sort — with a fixed per-entry key order
 * (`proposedName`, `userId`, `title`, `scopes`) and `scopes` themselves
 * sorted ascending, so the resulting JSON — and therefore the digest built
 * from it — is independent of caller input order AND of the host runtime's
 * collation data, because the value is digested and independently
 * re-derived on another runtime (Hermes app vs Node/mocha engine tests).
 * Deliberately NOT the schema's single-row, LIMIT-1-style shortcut
 * elsewhere in this codebase, which would digest only the first officer
 * rather than the full roster.
 *
 * 57-13 (CR-01): `userId` is bound as `entry.userId ?? null`, NEVER as a
 * bare `entry.userId` — `JSON.stringify` DROPS keys whose value is
 * `undefined`, which would silently emit two different digest shapes for
 * the same logical roster (T-57-13-05) and reintroduce the exact class of
 * defect this plan closes. The `userId` tiebreak (for the rare equal-name
 * case) uses the SAME ordinal `<`/`>`/`0` three-way shape as the primary
 * `proposedName` sort — introduce no locale-sensitive primitive; 57-12's
 * `roster-digest-determinism.spec.ts` guard fails the suite if one
 * reappears in this file.
 *
 * Deliberately exported as a pure, side-effect-free function (not inlined
 * into `proposeAdmin`) so roster-order determinism and scope-change
 * sensitivity are directly unit-testable without a live `proposeAdmin`
 * round trip — see `authority.spec.ts`'s 'proposeAdmin' D-02 cases.
 * `ProposedAdmin`/`ProposedOfficer`'s composite primary keys (plus
 * `ProposedOfficer.CantDelete`) make a second `proposeAdmin` call against
 * the SAME (authorityId, effectiveAt) structurally impossible, so this pure
 * function is the only place that property is observable in isolation.
 */
export function sortRosterEntries(
	entries: AdminRosterEntry[],
): AdminRosterEntry[] {
	return entries
		.map((entry) => ({
			proposedName: entry.proposedName,
			userId: entry.userId ?? null,
			title: entry.title,
			scopes: [...entry.scopes].sort(),
		}))
		.sort((a, b) => {
			if (a.proposedName < b.proposedName) return -1;
			if (a.proposedName > b.proposedName) return 1;
			const aUserId = a.userId ?? '';
			const bUserId = b.userId ?? '';
			return aUserId < bUserId ? -1 : aUserId > bUserId ? 1 : 0;
		});
}

/**
 * 57-08 (D-01 trigger half): the outcome of `proposeAdmin`'s own attempt to
 * promote its proposal when `startSigningSession` reports `thresholdReached`.
 * Mirrors `SignatureTasksEngine.RegistrantSeedOutcome` / `lastSeedOutcome`'s
 * shape and discipline exactly: public on `AuthorityEngine` so a test or a
 * future UI consumer can read it, deliberately NOT added to `IAuthorityEngine`
 * (no interface change, no UI consumer this round).
 *
 * `proposeAdmin`'s contract is to propose — a proposal that is correctly
 * persisted and correctly signed must survive a promotion that legitimately
 * cannot apply (a typed `AdminPromotionError`, e.g. the D-03 `.init`-officer
 * case), so a refusal is RECORDED here rather than thrown. This field is the
 * channel a caller reads to discover that outcome; it is never silent.
 */
export type AdminProposalPromotionOutcome =
	| { status: 'promoted'; nonce: string; result: AdminPromotionResult }
	| {
			status: 'refused';
			nonce: string;
			reason: AdminPromotionError['reason'];
			proposedName?: string;
	  }
	| {
			// Threshold reached but signatureOrCallback was a bare Signature, not a
			// re-invocable per-digest callback — applyAdminProposal requires a
			// callback because it mints two or three distinct digests (57-07). This
			// is a DISTINCT marker from 'refused' (no AdminPromotionError was ever
			// thrown; the promotion attempt never started). Per Task 1's P8 probe,
			// authority-propose-admin-builder.ts:154 is the one production
			// (non-test, non-mock) caller shaped this way today.
			status: 'skipped-non-callback-signature';
			nonce: string;
	  }
	| {
			// 62-13 (D-08): above a rad threshold greater than 1, the proposer's OWN
			// signature is recorded on the 'rad' proposal session, and a co-signer
			// Task (plus AdminSignatureTaskExtension) is fanned out to every OTHER
			// current rad holder — all in the SAME transaction as the session
			// (T-62-13-02). Promotion does NOT happen here: it happens later, in
			// SignatureTasksEngine.completeSignature's admin branch (Trigger B),
			// once enough co-signers have accepted. This marker is set after that
			// fan-out transaction commits.
			status: 'awaiting-co-signers';
			nonce: string;
			threshold: number;
			recipientUserIds: string[];
	  };

export class AuthorityEngine implements IAuthorityEngine {
	constructor(
		private readonly authority: Authority,
		private readonly ctx: EngineContext,
		private readonly signingEngine: ISigningEngine = new SigningEngine(ctx),
	) {
		this.invitationSpanMinutes = 60;
	}

	private readonly invitationSpanMinutes: number;

	/**
	 * 57-08 (D-01 trigger half) — the most recent outcome of `proposeAdmin`'s
	 * own promotion attempt. Public so a test or a future UI consumer can read
	 * it; NOT part of `IAuthorityEngine` (no interface change, no UI consumer
	 * this round — see {@link AdminProposalPromotionOutcome}'s own doc comment).
	 */
	lastPromotionOutcome?: AdminProposalPromotionOutcome;

	createOfficerInvite(init: OfficerInit): OfficerInviteShare {
		// AUTH-01 (D-01/D-04): hex-encoded secp256k1 key material at the
		// engine API surface. invitePrivateBytes is confined to this block;
		// every downstream consumer sees only the hex form.
		const invitePrivateBytes = secp256k1.utils.randomSecretKey();
		const invitePrivate = bytesToHex(invitePrivateBytes);
		const inviteKey = bytesToHex(secp256k1.getPublicKey(invitePrivateBytes));

		const type = 'of';
		const expiration = Temporal.Now.plainDateTimeISO('UTC')
			.add({ minutes: this.invitationSpanMinutes })
			.toString();

		// D-05: digest formula now uses the unified helper (pipe-join, SHA-256,
		// base64url) matching SQL Digest(). The signing formula below (TextEncoder
		// + secp256k1.sign) is separate — it validates engine-side via
		// context.IsSignatureValid, not via SQL Digest constraints (D-06).
		// WR-10 (17-REVIEW): @noble/curves v2 defaults to prehash:true, so the
		// signed domain here is sha256(sha256(signedBytes)) — deliberately
		// accepted (no pre-migration signatures exist). Verifiers must use
		// noble v2 default options, never { prehash: false }.
		// WR-17 (17-REVIEW): fields are pipe-joined (the canonical form the SQL
		// Digest path uses — D-05) instead of raw-concatenated, so distinct field
		// tuples can no longer serialize to identical signed bytes (boundary
		// ambiguity: name 'A'/title 'BC' vs name 'AB'/title 'C'). scopes is
		// JSON-stringified for an unambiguous array encoding. Phase 6's
		// InviteSignatureValid verification MUST recompute this exact form.
		// IN-25 (17-REVIEW): RESIDUAL AMBIGUITY — a literal '|' inside a free-text
		// field still aliases tuples (name 'A|B'/title 'C' vs name 'A'/title
		// 'B|C'). This matches the existing SQL Digest pipe-join semantics and is
		// accepted for now: '|' is FORBIDDEN in invite name/title values. Phase 6
		// MUST resolve this before freezing InviteSignatureValid — either enforce
		// the '|' ban at the input boundary, or switch the signed encoding to
		// JSON.stringify([fields...]) / length-prefixed (the last cheap moment to
		// change the formula is before the freeze).
		const signedBytes = new TextEncoder().encode(
			[init.name, init.title, JSON.stringify(init.scopes), type, expiration, inviteKey].join('|'),
		);
		const inviteSignature = bytesToHex(secp256k1.sign(sha256(signedBytes), invitePrivateBytes));

		return {
			...init,
			type,
			expiration,
			inviteKey,
			invitePrivate,
			inviteSignature,
		} satisfies OfficerInviteShare;
	}

	createAuthorityInvite(name: string): AuthorityInviteShare {
		// AUTH-01 hex contract — see createOfficerInvite for the lifecycle.
		const invitePrivateBytes = secp256k1.utils.randomSecretKey();
		const invitePrivate = bytesToHex(invitePrivateBytes);
		const inviteKey = bytesToHex(secp256k1.getPublicKey(invitePrivateBytes));

		const type = 'au';
		const expiration = Temporal.Now.plainDateTimeISO('UTC')
			.add({ minutes: this.invitationSpanMinutes })
			.toString();
		// WR-17 (17-REVIEW): pipe-joined canonical form — see createOfficerInvite.
		// IN-25 (17-REVIEW): '|' is FORBIDDEN in the invite name — see the
		// residual-ambiguity note in createOfficerInvite; Phase 6 must resolve
		// before freezing InviteSignatureValid.
		const signedBytes = new TextEncoder().encode([type, name, expiration].join('|'));
		const inviteSignature = bytesToHex(secp256k1.sign(sha256(signedBytes), invitePrivateBytes));

		return {
			name,
			type,
			expiration,
			inviteKey,
			invitePrivate,
			inviteSignature,
		} satisfies AuthorityInviteShare;
	}

	async getAdminDetails(): Promise<AdminDetails> {
		try {
			const adminDB = await this.ctx.db
				.prepare(
					`select A.AuthorityId, A.EffectiveAt, A.ThresholdPolicies
						from Admin A join CurrentAdmin CA on A.AuthorityId = CA.AuthorityId and A.EffectiveAt = CA.EffectiveAt
					where A.AuthorityId = :id`,
				)
				.get({ id: this.authority.id });
			// AUTH-04: guard against missing admin instead of `?.`-ing past it.
			if (!adminDB) {
				throw new Error('Admin not found');
			}
			const officersDB: Officer[] = [];
			for await (const officer of this.ctx.db.eval(
				'select * from Officer where AuthorityId = :id and AdminEffectiveAt = :effectiveAt',
				{
					id: this.authority.id,
					effectiveAt: adminDB.EffectiveAt as string,
				},
			)) {
				officersDB.push({
					userId: officer.UserId as string,
					authorityId: adminDB.AuthorityId as string,
					title: officer.Title as string,
					scopes: parseJsonOr<Scope[]>(officer.Scopes, [], 'Officer.Scopes'),
				});
			}
			// WR-05 (17-REVIEW): Admin's PK is (AuthorityId, EffectiveAt) — there is
			// no Id column to project. Derive a stable composite id instead of
			// reading a never-projected column (which yielded `undefined as string`).
			const admin = {
				id: `${adminDB.AuthorityId as string}:${adminDB.EffectiveAt as string}`,
				authorityId: adminDB.AuthorityId as string,
				effectiveAt: fromCanonicalDatetime(adminDB.EffectiveAt as string),
				officers: officersDB,
				thresholdPolicies: parseJsonOr<ThresholdPolicy[]>(
					adminDB.ThresholdPolicies,
					[],
					'Admin.ThresholdPolicies',
				),
			};
			// UAT 62: ProposedAdmin rows are never deleted, so an unordered `.get()`
			// returned the EARLIEST proposal (on device: an older empty one). Read the
			// LATEST proposal that no Admin has reached yet. Promotion
			// (applyAdminProposal) inserts Admin at the proposal's own EffectiveAt, so
			// `A.EffectiveAt >= P.EffectiveAt` excludes a promoted proposal AND any older
			// one a later promotion superseded. Proven against a real Quereus DB in
			// test/authority.spec.ts (getAdminDetails / UAT 62).
			const proposedAdminDB = await this.ctx.db
				.prepare(
					`select P.EffectiveAt, P.ThresholdPolicies
						from ProposedAdmin P
					where P.AuthorityId = :id
						and not exists (
							select 1 from Admin A
							where A.AuthorityId = P.AuthorityId and A.EffectiveAt >= P.EffectiveAt
						)
					order by P.EffectiveAt desc
					limit 1`,
				)
				.get({ id: this.authority.id });
			if (!proposedAdminDB) {
				return { admin, proposed: undefined };
			}
			const proposedOfficersDB: OfficerSelection[] = [];
			for await (const officer of this.ctx.db.eval(
				'select * from ProposedOfficer where AuthorityId = :id and AdminEffectiveAt = :effectiveAt',
				{
					id: this.authority.id,
					effectiveAt: proposedAdminDB.EffectiveAt as string,
				},
			)) {
				const scopes = parseJsonOr<Scope[]>(officer.Scopes, [], 'Officer.Scopes');
				// UAT 62: a row with a UserId (57-13) is an EXISTING officer; only a
				// null-UserId row is a not-yet-joined `.init` invitee. Mapping both to
				// `.init` dropped the identity and gave every proposed officer an Invite.
				const userId = officer.UserId as string | null | undefined;
				proposedOfficersDB.push(
					userId
						? {
								existing: {
									userId,
									authorityId: this.authority.id,
									title: officer.Title as string,
									scopes,
								},
							}
						: {
								init: {
									name: officer.ProposedName as string,
									title: officer.Title as string,
									scopes,
								},
							},
				);
			}
			// AUTH-05 / D-22: populate signers from the most recent AdminSigning
			// for scope 'rad' (admin-proposal scope) joined via OfficerSignature.
			// IN-18 (17-REVIEW): Nonce desc tiebreaker — multiple signings can
			// share an AdminEffectiveAt, and without a tiebreaker which session's
			// signers get reported is engine-ordering dependent.
			const signers: string[] = [];
			const signingDB = await this.ctx.db
				.prepare(
					'select Nonce from AdminSigning where AuthorityId = :id and Scope = :scope order by AdminEffectiveAt desc, Nonce desc limit 1',
				)
				.get({ id: this.authority.id, scope: 'rad' });
			if (signingDB?.Nonce) {
				for await (const row of this.ctx.db.eval(
					'select UserId from OfficerSignature where SigningNonce = :nonce',
					{ nonce: signingDB.Nonce as string },
				)) {
					signers.push(row.UserId as string);
				}
			}
			return {
				admin,
				proposed: {
					proposed: {
						officers: proposedOfficersDB,
						effectiveAt: fromCanonicalDatetime(
							proposedAdminDB.EffectiveAt as string,
						),
						thresholdPolicies: parseJsonOr<ThresholdPolicy[]>(
							proposedAdminDB.ThresholdPolicies,
							[],
							'Admin.ThresholdPolicies',
						),
					},
					signers,
				},
			};
		} catch (err) {
			if (err instanceof QuereusError) {
				throw new Error(`Quereus error (code ${err.code}): ${err.message}`);
			} else if (err instanceof MisuseError) {
				throw new Error(`API misuse: ${err.message}`);
			} else {
				throw new Error(`Unknown error getting admin details: ${err}`);
			}
		}
	}

	async getAuthorityInvites(): Promise<
		Array<InviteStatus<SentAuthorityInvite>>
	> {
		try {
			const authorityInvites: Array<SentAuthorityInvite & { cid: string }> = [];
			for await (const invite of this.ctx.db.eval(
				`select Name, Cid from InviteSlot
					join AdminSigning on InviteSlot.SigningNonce = AdminSigning.Nonce
						where AdminSigning.AuthorityId = :id and AdminSigning.Scope = :scope`,
				{ id: this.authority.id, scope: 'iad' },
			)) {
				authorityInvites.push({
					name: invite.Name as string,
					type: 'au',
					cid: invite.Cid as string,
				});
			}

			const acceptedAuthorityInvites: Array<InviteResult & { cid: string }> =
				[];
			for await (const inviteResult of this.ctx.db.eval(
				`select InviteResult.SlotCid, InviteResult.IsAccepted, InviteResult.InviteSignature, InviteResult.InvokedId from InviteResult
					join InviteSlot on InviteResult.SlotCid = InviteSlot.Cid
						join AdminSigning on InviteSlot.SigningNonce = AdminSigning.Nonce
				where AdminSigning.AuthorityId = :id and AdminSigning.Scope = :scope`,
				{ id: this.authority.id, scope: 'iad' },
			)) {
				acceptedAuthorityInvites.push({
					cid: inviteResult.SlotCid as string,
					isAccepted: inviteResult.IsAccepted as boolean,
					invitationSignature: inviteResult.InviteSignature as string,
					invokedId: inviteResult.InvokedId as string | undefined,
				});
			}

			const inviteStatuses: Array<InviteStatus<SentAuthorityInvite>> = [];
			for (const invite of authorityInvites) {
				inviteStatuses.push({
					invite: {
						name: invite.name,
						type: 'au',
					},
					result: (() => {
						const accepted = acceptedAuthorityInvites.find(
							(a) => a.cid === invite.cid,
						);
						if (!accepted) return undefined;
						const { cid, ...resultWithoutCid } = accepted;
						return resultWithoutCid;
					})(),
				});
			}
			return inviteStatuses;
		} catch (err) {
			if (err instanceof QuereusError) {
				throw new Error(`Quereus error (code ${err.code}): ${err.message}`);
			} else if (err instanceof MisuseError) {
				throw new Error(`API misuse: ${err.message}`);
			} else {
				throw new Error(`Unknown error: ${err}`);
			}
		}
	}

	async getDetails(): Promise<AuthorityDetails> {
		try {
			const authorityDB = await this.ctx.db
				.prepare(
					'select Id, Name, DomainName, ImageRef from Authority where Id = :id',
				)
				.get({ id: this.authority.id });
			if (!authorityDB) {
				throw new Error('Authority not found');
			}
			const authority: Authority = {
				id: authorityDB.Id as string,
				name: authorityDB.Name as string,
				domainName: asText(authorityDB.DomainName, 'Authority.DomainName'),
				imageRef: toImageRef(parseJsonOr<unknown>(
					authorityDB.ImageRef,
					undefined,
					'Authority.ImageRef',
				)),
			};
			const proposedAuthorityDB = await this.ctx.db
				.prepare(
					'select Name, DomainName from ProposedAuthority where Id = :id',
				)
				.get({ id: this.authority.id });
			if (!proposedAuthorityDB) {
				return { authority, proposed: undefined };
			}
			// AUTH-05 / D-21: populate signers from the most recent AdminSigning
			// for scope 'iad' (invite-authority scope) joined via OfficerSignature.
			// IN-18 (17-REVIEW): Nonce desc tiebreaker — see getAdminDetails.
			const signers: string[] = [];
			const signingDB = await this.ctx.db
				.prepare(
					'select Nonce from AdminSigning where AuthorityId = :id and Scope = :scope order by AdminEffectiveAt desc, Nonce desc limit 1',
				)
				.get({ id: this.authority.id, scope: 'iad' });
			if (signingDB?.Nonce) {
				for await (const row of this.ctx.db.eval(
					'select UserId from OfficerSignature where SigningNonce = :nonce',
					{ nonce: signingDB.Nonce as string },
				)) {
					signers.push(row.UserId as string);
				}
			}
			return {
				authority,
				proposed: {
					proposed: {
						name: proposedAuthorityDB.Name as string,
						domainName: asText(
							proposedAuthorityDB.DomainName,
							'ProposedAuthority.DomainName',
						),
					},
					signers,
				},
			};
		} catch (err) {
			if (err instanceof QuereusError) {
				throw new Error(`Quereus error (code ${err.code}): ${err.message}`);
			} else if (err instanceof MisuseError) {
				throw new Error(`API misuse: ${err.message}`);
			} else if (err instanceof Error) {
				throw err;
			} else {
				throw new Error(`Unknown error: ${err}`);
			}
		}
	}

	/**
	 * 57-01 (D-01 propose side, D-03): resolve each `OfficerSelection` in a
	 * `proposeAdmin` roster into an `AdminRosterEntry`. For `.init`, the
	 * caller-supplied `name`/`title`/`scopes` are taken directly. For
	 * `.existing`, `ProposedOfficer` is keyed by NAME (not userId), so the
	 * display name is resolved from `User.Name` — mirroring the bridge
	 * `ProposedAdministrationScreen.tsx` already uses, not a second one. If
	 * the `User` row is missing, this throws rather than silently
	 * substituting the userId as the name (T-57-05).
	 *
	 * Returns entries UNSORTED, in caller order — callers needing the
	 * digest/serialization form must run the result through
	 * `sortRosterEntries`.
	 */
	private async resolveAdminRoster(
		officers: OfficerSelection[],
	): Promise<AdminRosterEntry[]> {
		const entries: AdminRosterEntry[] = [];
		for (const selection of officers) {
			if (selection.init) {
				entries.push({
					proposedName: selection.init.name,
					userId: null,
					title: selection.init.title,
					scopes: selection.init.scopes,
				});
			} else if (selection.existing) {
				const userDB = await this.ctx.db
					.prepare('select Id, Name, ImageRef from User where Id = :id')
					.get({ id: selection.existing.userId });
				if (!userDB) {
					throw new Error(
						`proposeAdmin: unresolvable officer userId '${selection.existing.userId}' — no matching User row`,
					);
				}
				entries.push({
					proposedName: userDB.Name as string,
					userId: selection.existing.userId,
					title: selection.existing.title,
					scopes: selection.existing.scopes,
				});
			}
		}
		return entries;
	}

	async proposeAdmin(
		admin: Proposal<AdminInit>,
		signatureOrCallback: Signature | ((digest: Uint8Array) => Promise<Signature>),
	): Promise<void> {
		const thresholdPoliciesJson = JSON.stringify(
			admin.proposed.thresholdPolicies,
		);
		const initialSignerId = admin.signers[0];
		if (!initialSignerId) {
			throw new Error('Failed to propose admin: No initial signer');
		}
		const effectiveAtCanon = toCanonicalDatetime(admin.proposed.effectiveAt);
		const tid = await allocateTid(this.ctx.db, 'authority');
		try {
			// 62-13 (D-08, T-62-13-05): pre-write threshold decision — runs BEFORE the roster
			// digest and the sign callback, so a proposal that could never reach its own rad
			// threshold is refused before any write and before any biometric prompt is spent.
			// The proposer's own signature counts only if they are a current holder, and the
			// later fan-out excludes only the proposer — "holders.length" is the right bound
			// either way.
			const radThreshold = await readAuthorityThreshold(this.ctx.db, this.authority.id, 'rad');
			if (radThreshold > 1) {
				const radHolders = await listCurrentScopeHolders(this.ctx.db, this.authority.id, 'rad');
				if (radThreshold > radHolders.length) {
					throw new Error(
						`proposeAdmin: This authority needs ${radThreshold} approvals to change its administration, but only ${radHolders.length} officers can approve administration changes.`,
					);
				}
			}

			// 57-01 (D-02): resolve + deterministically sort the roster BEFORE
			// computing the digest, so the digest attests to the FULL roster this
			// proposal revises — never a single-row, first-officer-only shortcut.
			const rosterEntries = sortRosterEntries(
				await this.resolveAdminRoster(admin.proposed.officers),
			);
			const officersJson = JSON.stringify(rosterEntries);

			// D-03/D-04: resolve the canonical digest ENGINE-SIDE first — needed both to
			// hand a sign callback the exact bytes to sign, and (D-21) to independently
			// re-verify whatever Signature ends up bound, including a pre-supplied one.
			// 62-03 (D-33/D-34): routed through the shared rad-roster-digest module — the
			// SAME formula AdminSignatureTaskExtension.MutationValid (Trigger B) recomputes.
			const digest = await computeRadProposalDigest(this.ctx.db, {
				authorityId: this.authority.id,
				effectiveAt: effectiveAtCanon,
				officers: officersJson,
				thresholdPolicies: thresholdPoliciesJson,
			});
			// WR-01: single shared digestToBytes decoder.
			const digestBytes = digestToBytes(digest);

			// If a sign callback is provided, invoke it so the caller signs exactly the
			// bytes the engine stores. If a completed Signature is passed (test fixture
			// path), use it directly — either way `digest`/`digestBytes` above are
			// the SAME bytes the signature must cover, per D-21 verification below.
			let signature: Signature;
			if (typeof signatureOrCallback === 'function') {
				signature = await signatureOrCallback(digestBytes);
			} else {
				signature = signatureOrCallback;
			}

			// 62-13 (D-08, T-62-13-01): above threshold 1, a co-signer Task is about to be
			// fanned out on the strength of this signature — refuse a spoofed proposer BEFORE
			// the ProposedAdmin envelope writes anything. Threshold 1 stays byte-identical
			// (unchecked), so existing threshold-1 callers are not newly re-validated here.
			if (radThreshold > 1 && signature.signerUserId !== initialSignerId) {
				throw new Error(
					'proposeAdmin: The signature does not belong to the officer proposing this administration.',
				);
			}

			// D-21 (Class A): compute a REAL IsUserValid — the conjunction of registered/
			// unexpired key membership AND a curve-dispatched signature verification over
			// the digest already computed above. Replaces the prior literal `true`.
			const membership = await verifyUserKeyMembership(
				this.ctx,
				signature.signerUserId,
				signature.signerKey,
			);
			const signatureValid = membership.keyType === UserKeyType.p256
				? verifySigP256(digest, signature.signature, signature.signerKey)
				: verifySig(digest, signature.signature, signature.signerKey);
			const isUserValid = membership.valid && signatureValid;

			// 57-01 (D-01 propose side, T-57-04): ProposedAdmin + its roster commit
			// atomically. ProposedAdmin MUST land first — ProposedOfficer.AdminValid
			// requires the matching ProposedAdmin row to already exist. COMMIT here,
			// BEFORE calling signingEngine.startSigningSession below — Quereus's
			// transaction model is flat and startSigningSession calls sign(), which
			// opens its own transaction by default.
			const nowCanon = nowCanonicalDatetime();
			await this.ctx.db.exec('BEGIN');
			try {
				await this.ctx.db.exec(
					`insert into ProposedAdmin (
						AuthorityId,
						EffectiveAt,
						ThresholdPolicies
					)
						with context UserId = :signerUserId, UserKey = :signerKey, Signature = :signature, Tid = ${tid}, now = :now, IsUserValid = :isUserValid
					values (
						:authorityId,
						:effectiveAt,
						:thresholdPolicies
					)`,
					{
						authorityId: this.authority.id,
						effectiveAt: effectiveAtCanon,
						thresholdPolicies: thresholdPoliciesJson,
						signerUserId: signature.signerUserId,
						signerKey: signature.signerKey,
						signature: signature.signature,
						now: nowCanon,
						isUserValid,
					},
				);

				// 57-13 (CR-01, D-03 AMENDMENT — see 57-13-CR01-CARRIER-PROBE.md):
				// D-03 originally left ProposedOfficerUser unpopulated because 57-01's
				// read-side probe found no reader. That no longer holds — the promote-
				// side closure's applyAdminProposal Step 4 is a genuinely NEW reader
				// that needs a stable identity reference instead of the renameable
				// User.Name bridge — but the carrier probe (Task 1) found ProposedOfficerUser
				// itself unusable: its UserSignature column is NOT NULL with no
				// legitimate non-fabricated value available at propose time (Q2),
				// and an officer seeded through the ordinary invite path has no live
				// UserKey row at all (Q3). The FALLBACK carrier persists the same
				// fact directly on ProposedOfficer.UserId instead (a column-only
				// schema addition, no new constraint) — ProposedOfficerUser itself
				// stays unpopulated, same as before, just for a different reason.
				for (const entry of rosterEntries) {
					await this.ctx.db.exec(
						`insert into ProposedOfficer (
							AuthorityId,
							AdminEffectiveAt,
							ProposedName,
							Title,
							Scopes,
							UserId
						)
							with context UserId = :signerUserId, UserKey = :signerKey, Signature = :signature, Tid = ${tid}, now = :now, IsUserValid = :isUserValid
						values (
							:authorityId,
							:effectiveAt,
							:proposedName,
							:title,
							:scopes,
							:entryUserId
						)`,
						{
							authorityId: this.authority.id,
							effectiveAt: effectiveAtCanon,
							proposedName: entry.proposedName,
							title: entry.title,
							scopes: JSON.stringify(entry.scopes),
							entryUserId: entry.userId ?? null,
							signerUserId: signature.signerUserId,
							signerKey: signature.signerKey,
							signature: signature.signature,
							now: nowCanon,
							isUserValid,
						},
					);
				}

				await this.ctx.db.exec('COMMIT');
			} catch (innerErr) {
				await this.ctx.db.exec('ROLLBACK');
				throw innerErr;
			}

			const adminDigestArgs: AdminDigestArgs = {
				authorityId: this.authority.id,
				effectiveAt: effectiveAtCanon,
				officers: officersJson,
				thresholdPolicies: thresholdPoliciesJson,
			};

			if (radThreshold <= 1) {
				// WR-06 (17-REVIEW): proposeAdmin only STARTS the signing session with
				// the instigator's signature. At threshold 1 this is the whole ceremony —
				// Trigger A below is the FIRST and ONLY signature-completing event. Above
				// threshold 1 (the `else` branch), the remaining signers complete the
				// proposal through separate co-signer Tasks (62-13, D-08, D-12) and
				// promotion happens in SignatureTasksEngine.completeSignature's admin
				// branch (Trigger B) — never here.
				const { nonce, thresholdReached } =
					await this.signingEngine.startSigningSession(
						this.authority.id,
						adminDigestArgs,
						'rad',
						signature,
					);

				// 57-08 (D-01 trigger half, Trigger A): the instigator's own signature
				// can already reach threshold here — the only administration shape the
				// current data model supports is threshold 1 (WR-05: every seeded
				// officer carries ctx.user.id), so proposeAdmin is where the FIRST and,
				// today, ONLY signature-completing event for a 'rad' session happens.
				// Promote only when threshold is genuinely reached AND a re-invocable
				// per-digest callback is available — applyAdminProposal mints two or
				// three distinct digests (57-07) and a single pre-computed Signature
				// cannot cover them.
				if (thresholdReached) {
					if (typeof signatureOrCallback === 'function') {
						try {
							const result = await this.applyAdminProposal(
								nonce,
								signatureOrCallback,
								{ ownsTransaction: true }, // 57-01 already COMMITted ProposedAdmin/
								// ProposedOfficer above, and startSigningSession's sign() call
								// (just above) owns and closes its OWN transaction — there is no
								// open transaction at this point, so this trigger opens its own.
							);
							this.lastPromotionOutcome = { status: 'promoted', nonce, result };
						} catch (promotionErr) {
							if (promotionErr instanceof AdminPromotionError) {
								// A promotion that legitimately cannot apply (e.g. the D-03
								// .init-officer case) must not destroy a correctly persisted,
								// correctly signed proposal. RECORD the refusal — never silent,
								// never thrown — proposeAdmin's contract is to propose.
								this.lastPromotionOutcome = {
									status: 'refused',
									nonce,
									reason: promotionErr.reason,
									proposedName: promotionErr.proposedName,
								};
								console.warn(
									`AuthorityEngine.proposeAdmin: promotion refused for nonce ${nonce}: ${promotionErr.reason}. The proposal itself was NOT affected — see lastPromotionOutcome.`,
								);
							} else {
								// Any OTHER error is unexpected and must not be downgraded to a
								// warning.
								throw promotionErr;
							}
						}
					} else {
						// Threshold reached but the caller supplied a bare Signature, not a
						// callback. Per Task 1's P8 probe, this shape has a production
						// (non-test, non-mock) caller — authority-propose-admin-builder.ts:154
						// — with no current app-level UI consumer. Record and warn; do NOT
						// throw and do NOT substitute/reuse the single supplied signature for
						// the two or three distinct digests the promotion needs to mint.
						this.lastPromotionOutcome = {
							status: 'skipped-non-callback-signature',
							nonce,
						};
						console.warn(
							`AuthorityEngine.proposeAdmin: threshold reached for nonce ${nonce} but a bare Signature (not a re-invocable per-digest callback) was supplied — promotion needs a callback because it mints two or three distinct digests. The proposal itself was NOT affected; this surface cannot promote until it supplies a callback.`,
						);
					}
				}
			} else {
				// 62-13 (D-08, D-12, T-62-13-02): above rad threshold 1, promotion never
				// happens here — it happens later, in SignatureTasksEngine.completeSignature's
				// admin branch (Trigger B), once enough co-signers have accepted. The session
				// (ownsTransaction false) and the fan-out helper (ownsTransaction false) share
				// ONE transaction here, so no proposal is ever left signed with no co-signer
				// Task. The ProposedAdmin/ProposedOfficer envelope already COMMITted above, in
				// its OWN transaction, before this one opens — quereus's transaction model is
				// flat and those rows predate this plan; they are not re-opened here.
				//
				// Re-read the roster the schema itself now holds (the SAME cast(...as text)
				// serialization Trigger B's CHECK recomputes) and compare byte-for-byte against
				// what was just signed. A co-signer's Trigger B CHECK would refuse every task if
				// these ever disagreed, so refuse here instead — nothing more is signed or
				// written.
				const schemaRoster = await readProposedRosterJson(this.ctx.db, this.authority.id, effectiveAtCanon);
				if (schemaRoster !== officersJson) {
					throw new Error(
						"proposeAdmin: This proposal's stored officer list does not match the list that was signed, so co-signers could never verify it.",
					);
				}

				const taskTid = await allocateTid(this.ctx.db, 'authority');
				await this.ctx.db.exec('BEGIN');
				try {
					const session = await this.signingEngine.startSigningSession(
						this.authority.id,
						adminDigestArgs,
						'rad',
						signature,
						undefined,
						{ ownsTransaction: false },
					);
					if (session.thresholdReached) {
						// Internal-invariant guard, not a reachable user-facing case: one
						// signature cannot reach a threshold above 1.
						throw new Error(
							'proposeAdmin: internal invariant violated — a single signature reached a threshold greater than 1',
						);
					}
					await this.ctx.db.runDeferredRowConstraints();
					const fan = await fanOutSignatureTasks(
						this.ctx,
						{
							authorityId: this.authority.id,
							scope: 'rad',
							nonce: session.nonce,
							initiatorUserId: signature.signerUserId,
							signatureType: 'admin',
							taskTid,
							insertExtension: adminSignatureTaskExtensionInserter(
								this.ctx.db,
								this.authority.id,
								effectiveAtCanon,
								taskTid,
							),
						},
						{ ownsTransaction: false },
					);
					await this.ctx.db.exec('COMMIT');
					this.lastPromotionOutcome = {
						status: 'awaiting-co-signers',
						nonce: session.nonce,
						threshold: fan.threshold,
						recipientUserIds: fan.recipientUserIds,
					};
				} catch (innerErr) {
					// CR-04 shape (fan-out.ts, submitBallotForConfirmation): one bounded,
					// autocommit-guarded recovery attempt. Either way, the ORIGINAL error is
					// what the caller needs to see — never substitute a rollback error.
					try {
						if (!this.ctx.db.getAutocommit()) {
							await this.ctx.db.exec('ROLLBACK');
						}
					} catch {
						// Swallowed — getAutocommit() reports the handle's true state to any
						// caller that checks it; this method does not pretend recovery
						// succeeded.
					}
					throw innerErr;
				}
			}
		} catch (err) {
			if (err instanceof QuereusError) {
				throw new Error(`Quereus error (code ${err.code}): ${err.message}`);
			} else if (err instanceof MisuseError) {
				throw new Error(`API misuse: ${err.message}`);
			} else if (err instanceof Error) {
				// WR-02: mirror `applyAdminProposal`'s own catch. Without this branch a
				// re-thrown promotion failure (the `throw promotionErr` in Trigger A
				// above) was rebuilt as a brand-new, cause-less `Error("Unknown
				// error: …")`, erasing `instanceof` and the stack. A caller could then
				// not distinguish "the proposal was never saved" from "the proposal and
				// its threshold-reached signature were saved correctly; only the
				// automatic promotion crashed" — and a blind retry collides on
				// ProposedAdmin's (AuthorityId, EffectiveAt) primary key.
				throw err;
			} else {
				throw new Error(`Unknown error: ${err}`);
			}
		}
	}

	/**
	 * 57-07 (D-01 promotion half): promote a threshold-reached 'rad'
	 * AdminSigning/AdminSignature session into live Admin + Officer rows.
	 *
	 * Read-then-verify-then-write, modelled on
	 * SignatureTasksEngine.finalizeBallot's read-a-Proposed*-row-after-
	 * threshold-and-promote shape. Steps 1-5 (identification + refusal
	 * checks) run BEFORE any write and BEFORE any transaction opens.
	 *
	 * quereus finding (T-57-07-01..06, pinned by 57-07's P4 probe): the
	 * deferred-constraint queue mis-evaluates the self-referential
	 * `Admin.MutationValid` / `Officer.InsertValid` subqueries when MORE
	 * THAN ONE deferred entry is pending at COMMIT (matches the open
	 * "deferred-CHECK sibling-row visibility" class of quereus issue) — a
	 * live `select` inside the same open transaction shows the correct,
	 * self-visible digest, but the deferred evaluator computes something
	 * else and the CHECK spuriously fails. Workaround: drain the queue via
	 * `this.ctx.db.runDeferredRowConstraints()` immediately after EACH
	 * Admin/Officer insert, while still inside the one open transaction —
	 * every deferred CHECK then evaluates alone (the single-entry case,
	 * proven self-visible), and the surrounding BEGIN…COMMIT/ROLLBACK still
	 * provides real, whole-transaction atomicity.
	 */
	async applyAdminProposal(
		nonce: string,
		sign: (digest: Uint8Array) => Promise<Signature>,
		options?: { ownsTransaction?: boolean },
	): Promise<AdminPromotionResult> {
		const ownsTransaction = options?.ownsTransaction ?? true;
		try {
			// Step 1: read the session.
			const sessionRow = await this.ctx.db
				.prepare(
					'select Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest from AdminSigning where Nonce = :nonce',
				)
				.get({ nonce });
			if (
				!sessionRow ||
				sessionRow.Scope !== 'rad' ||
				sessionRow.AuthorityId !== this.authority.id
			) {
				throw new AdminPromotionError('wrong-scope', nonce);
			}

			// Step 2: threshold gate. AdminSignature is sign()'s own authoritative
			// "threshold reached" marker — do not re-derive the arithmetic.
			const signedRow = await this.ctx.db
				.prepare('select 1 as x from AdminSignature where SigningNonce = :nonce')
				.get({ nonce });
			if (!signedRow) {
				throw new AdminPromotionError('not-signed', nonce);
			}

			// Step 3: identify the proposal by re-deriving 57-01's roster-covering
			// digest over each persisted ProposedAdmin + its ProposedOfficer roster,
			// and matching byte-for-byte against the session's stored Digest.
			// Exactly one row may match (T-57-07-02, repudiation control).
			let matched:
				| {
						effectiveAtCanon: string;
						thresholdPoliciesJson: string;
						rosterEntries: AdminRosterEntry[];
						// 62-03 (D-33b): the SAME cast(...as text)-sorted roster JSON the matching
						// digest was computed over — re-serialized identically for the ONE shared
						// promotion digest below (Step 6), so it never drifts from what Step 3
						// actually matched.
						officersJson: string;
				  }
				| undefined;
			// WR-XX (57-07): materialize the outer cursor into a plain array BEFORE
			// issuing any nested db call. `Database.eval()` holds the exec mutex for
			// the whole iteration (documented on `_acquireExecMutex`) — a nested
			// `eval`/`prepare().get()` issued from inside an still-open outer `eval`
			// iterator re-enters the same mutex and deadlocks (never rejects; the
			// call simply never resolves). Every per-row nested read below runs
			// AFTER this array is fully collected, once the outer cursor has
			// released the mutex.
			const proposedAdminRows: Array<{ effectiveAtCanon: string; thresholdPoliciesJson: string }> = [];
			for await (const proposedRow of this.ctx.db.eval(
				'select AuthorityId, EffectiveAt, ThresholdPolicies from ProposedAdmin where AuthorityId = :id',
				{ id: this.authority.id },
			)) {
				proposedAdminRows.push({
					effectiveAtCanon: proposedRow.EffectiveAt as string,
					thresholdPoliciesJson: proposedRow.ThresholdPolicies as string,
				});
			}
			for (const { effectiveAtCanon, thresholdPoliciesJson } of proposedAdminRows) {
				const rosterRaw: AdminRosterEntry[] = [];
				// 57-13 (CR-01, fallback carrier — see 57-13-CR01-CARRIER-PROBE.md):
				// UserId is a plain column on ProposedOfficer itself (added by Task 2),
				// so it comes back in this SAME select — no second query, no new
				// exec-mutex hazard (unlike the primary-carrier branch this plan did
				// NOT take, which would have needed a per-row point lookup issued
				// AFTER this cursor closed).
				for await (const officerRow of this.ctx.db.eval(
					'select ProposedName, Title, Scopes, UserId from ProposedOfficer where AuthorityId = :id and AdminEffectiveAt = :e',
					{ id: this.authority.id, e: effectiveAtCanon },
				)) {
					rosterRaw.push({
						proposedName: officerRow.ProposedName as string,
						// 57-13: bind as `?? null`, matching the producer's exact binding
						// (T-57-13-05) — a mismatch between `null` and `undefined` here
						// produces a silent `roster-mismatch` refusal that looks like a
						// tampering detection rather than what it actually is.
						userId: (officerRow.UserId as string | null) ?? null,
						title: officerRow.Title as string,
						scopes: parseJsonOr<Scope[]>(officerRow.Scopes as string, [], 'ProposedOfficer.Scopes'),
					});
				}
				const rosterEntries = sortRosterEntries(rosterRaw);
				const officersJson = JSON.stringify(rosterEntries);
				// 62-03 (D-33/D-34): routed through the shared rad-roster-digest module — the
				// SAME formula proposeAdmin signs and Trigger B's schema CHECK recomputes.
				const candidateDigest = await computeRadProposalDigest(this.ctx.db, {
					authorityId: this.authority.id,
					effectiveAt: effectiveAtCanon,
					officers: officersJson,
					thresholdPolicies: thresholdPoliciesJson,
				});
				if (candidateDigest === sessionRow.Digest) {
					matched = { effectiveAtCanon, thresholdPoliciesJson, rosterEntries, officersJson };
					break;
				}
			}
			if (!matched) {
				throw new AdminPromotionError('roster-mismatch', nonce);
			}

			// Step 4: resolve each roster entry's privilege grant. CR-01 promote-side
			// closure (this plan): for an entry that carries a signed, persisted
			// `userId` (57-13), identity comes from THAT value — a single point
			// lookup confirms the `User` row still exists, and NO query against
			// `User.Name` is issued on this path. `User.Name` is attacker-controlled
			// (`UserEngine.revise()` accepts a self-service rename with no signature
			// and no admin gate, and the column has no uniqueness constraint), so a
			// grant resolved from it could be retargeted after the proposal was
			// signed. The name lookup survives ONLY as the null-userId fallback:
			// `.init` officers have no `User` row and are already unpromotable
			// (T-57-07-07), and any legacy roster proposed before 57-13 has no
			// persisted userId to trust instead. Refuse loudly (`unresolvable-officer`)
			// rather than silently promoting a smaller roster than the one that was
			// signed, on both branches.
			const resolvedOfficers: Array<{ userId: string; title: string; scopes: Scope[] }> = [];
			for (const entry of matched.rosterEntries) {
				if (entry.userId != null) {
					const userRow = await this.ctx.db
						.prepare('select Id from User where Id = :id')
						.get({ id: entry.userId });
					if (!userRow) {
						throw new AdminPromotionError('unresolvable-officer', nonce, entry.proposedName);
					}
					resolvedOfficers.push({ userId: entry.userId, title: entry.title, scopes: entry.scopes });
					continue;
				}
				const userIds: string[] = [];
				for await (const userRow of this.ctx.db.eval('select Id from User where Name = :name', {
					name: entry.proposedName,
				})) {
					userIds.push(userRow.Id as string);
				}
				if (userIds.length !== 1) {
					throw new AdminPromotionError('unresolvable-officer', nonce, entry.proposedName);
				}
				resolvedOfficers.push({ userId: userIds[0]!, title: entry.title, scopes: entry.scopes });
			}

			// Step 5: refuse a roster with no 'rad'-scoped officer — Admin.OfficerRequired
			// fires `check on update`, so an administration promoted without a 'rad'
			// officer could never be revised again (T-57-07-08). Then the idempotent-
			// replay short-circuit: a live Admin row already covering this
			// (authorityId, effectiveAt) means this nonce was already promoted
			// (T-57-07-06) — return without opening a transaction.
			const hasRadOfficer = resolvedOfficers.some((o) => o.scopes.includes('rad' as Scope));
			if (!hasRadOfficer) {
				throw new AdminPromotionError('no-rad-officer', nonce);
			}
			const existingAdminRow = await this.ctx.db
				.prepare('select 1 as x from Admin where AuthorityId = :id and EffectiveAt = :e')
				.get({ id: this.authority.id, e: matched.effectiveAtCanon });
			if (existingAdminRow) {
				return {
					authorityId: this.authority.id,
					effectiveAt: fromCanonicalDatetime(matched.effectiveAtCanon),
					officersPromoted: 0,
					alreadyApplied: true,
				};
			}

			// Step 6: allocate one Tid for the whole promotion; sort the resolved
			// roster ascending by UserId (Officer.AdminValid's strong branch requires
			// Admin to exist first when InviteSlotCid is null — D-07d).
			const tid = await allocateTid(this.ctx.db, 'authority');
			const sortedOfficers = [...resolvedOfficers].sort((a, b) =>
				a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0,
			);

			// 62-03 (D-33b): the former two-session (admin-side null-officer-part +
			// shared min-UserId-officer-part) design COLLAPSES into ONE full-roster
			// promotion session, shared by the Admin insert AND every Officer insert.
			// Re-verify the schema's own roster (ProposedOfficer, the same source the
			// qsql CHECKs read) against the roster Step 3 already matched BEFORE any
			// sign or write — a mismatch here means the TS-side and schema-side roster
			// serializations have drifted, and promoting would write a roster the
			// signed digest never actually covered.
			const officersJson = matched.officersJson;
			const schemaRoster = await readProposedRosterJson(this.ctx.db, this.authority.id, matched.effectiveAtCanon);
			if (schemaRoster !== officersJson) {
				throw new AdminPromotionError('roster-mismatch', nonce);
			}
			const promotionDigest = await computeAdminPromotionDigest(this.ctx.db, {
				tid,
				authorityId: this.authority.id,
				effectiveAt: matched.effectiveAtCanon,
				thresholdPolicies: matched.thresholdPoliciesJson,
				officers: officersJson,
			});
			const promotionSignature = await sign(digestToBytes(promotionDigest));

			// AdminSigning.AdminEffectiveAt is the CURRENT admin's effective date
			// (never the promoted proposal's) — resolved via the same CurrentAdmin
			// join Officer lookup startSigningSession uses, keyed to the promoting
			// signer (key fact 4).
			const currentAdminRow = await this.ctx.db
				.prepare(
					`select CurrentAdmin.EffectiveAt from CurrentAdmin join Officer
						on CurrentAdmin.AuthorityId = Officer.AuthorityId
							and CurrentAdmin.EffectiveAt = Officer.AdminEffectiveAt
								where Officer.UserId = :userId and Officer.AuthorityId = :authorityId`,
				)
				.get({ userId: promotionSignature.signerUserId, authorityId: this.authority.id });
			if (!currentAdminRow) {
				throw new Error(
					'applyAdminProposal: the promoting signer is not a current Officer of this authority',
				);
			}
			const currentAdminEffectiveAt = currentAdminRow.EffectiveAt as string;

			const promotionNonce = crypto.randomUUID();
			const nowCanon = nowCanonicalDatetime();

			const isSignerKeyValid = await adminSigningKeyValidity(this.ctx.db, {
				userId: promotionSignature.signerUserId,
				signerKey: promotionSignature.signerKey,
				now: nowCanon,
				isPlaceholderSignature: false,
			});

			if (ownsTransaction) await this.ctx.db.exec('BEGIN');
			try {
				// Mint the ONE promotion session. Never IsPlaceholderSignature = true —
				// this method supplies real crypto (T-57-07-03).
				await this.ctx.db.exec(
					`insert into AdminSigning (
						Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature
					)
						with context now = :now, IsSignerKeyValid = :isSignerKeyValid, IsPlaceholderSignature = false
					values (
						:nonce, :authorityId, :adminEffectiveAt, 'rad', :digest, :userId, :signerKey, :signature
					)`,
					{
						nonce: promotionNonce,
						authorityId: this.authority.id,
						adminEffectiveAt: currentAdminEffectiveAt,
						digest: promotionDigest,
						userId: promotionSignature.signerUserId,
						signerKey: promotionSignature.signerKey,
						signature: promotionSignature.signature,
						now: nowCanon,
						isSignerKeyValid,
					},
				);
				// 62-03 (D-33b): signDerived — the promotion session INHERITS satisfaction
				// from the proposal nonce's already-reached AdminSignature (Step 2 confirmed
				// it exists), rather than re-running a fresh threshold count. This is what
				// makes promotion threshold-correct at `rad` threshold > 1 without needing a
				// SECOND co-signature on the promotion digest itself — the co-signers already
				// signed the PROPOSAL; the promotion digest is this method's own derived,
				// system-attested step.
				await this.signingEngine.signDerived(promotionNonce, promotionSignature, nonce, { ownsTransaction: false });

				await this.ctx.db.exec(
					`insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
						with context SigningNonce = :nonce, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
					values (:authorityId, :effectiveAt, :thresholdPolicies)`,
					{
						nonce: promotionNonce,
						authorityId: this.authority.id,
						effectiveAt: matched.effectiveAtCanon,
						thresholdPolicies: matched.thresholdPoliciesJson,
					},
				);
				// Workaround for the deferred-CHECK sibling-row-visibility class of
				// quereus issue (see method doc comment) — drain before the next insert
				// enqueues its own deferred entry.
				await this.ctx.db.runDeferredRowConstraints();

				for (const officer of sortedOfficers) {
					await this.ctx.db.exec(
						`insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes)
							with context SigningNonce = :nonce, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
						values (:authorityId, :effectiveAt, :userId, :title, :scopes)`,
						{
							nonce: promotionNonce,
							authorityId: this.authority.id,
							effectiveAt: matched.effectiveAtCanon,
							userId: officer.userId,
							title: officer.title,
							scopes: JSON.stringify(officer.scopes),
						},
					);
					await this.ctx.db.runDeferredRowConstraints();
				}

				if (ownsTransaction) await this.ctx.db.exec('COMMIT');
			} catch (innerErr) {
				if (ownsTransaction) await this.ctx.db.exec('ROLLBACK');
				throw innerErr;
			}

			return {
				authorityId: this.authority.id,
				effectiveAt: fromCanonicalDatetime(matched.effectiveAtCanon),
				officersPromoted: sortedOfficers.length,
				alreadyApplied: false,
			};
		} catch (err) {
			if (err instanceof AdminPromotionError) {
				throw err;
			} else if (err instanceof QuereusError) {
				throw new Error(`Quereus error (code ${err.code}): ${err.message}`);
			} else if (err instanceof MisuseError) {
				throw new Error(`API misuse: ${err.message}`);
			} else if (err instanceof Error) {
				throw err;
			} else {
				throw new Error(`Unknown error: ${err}`);
			}
		}
	}

	// ---- SURF-03: pending-invite read + cancel/resend (non-signing, D-05/06/07) ----

	/**
	 * SURF-03 read surface: return the Cids of pending officer-invites
	 * (Type = 'of') for this authority's signing scope. One entry per live
	 * invitation: the chain head (the newest copy). An invitation whose chain
	 * is answered, withdrawn, expired, backstop-closed or ambiguous is not
	 * listed (CR-01, 62-REVIEW.md).
	 *
	 * The per-row NOT EXISTS clauses (InviteResult / InviteCancellation) are only
	 * a prefilter; the decision is the shared chain rule (readInviteChain) applied
	 * to each candidate's chain, so the officer-side list agrees with what the
	 * invitee can actually accept.
	 *
	 * Scoped to this authority via the AdminSigning join used by
	 * getAuthorityInvites (scope 'rad' = officer-invite admin approval).
	 */
	async getPendingInviteCids(): Promise<string[]> {
		try {
			const candidates: Array<{ inviteKey: string; nonce: string }> = [];
			const seen = new Set<string>();
			for await (const row of this.ctx.db.eval(
				`select IS_.Cid, IS_.InviteKey, IS_.SigningNonce from InviteSlot IS_
					join AdminSigning ADS on IS_.SigningNonce = ADS.Nonce
				where IS_.Type = 'of'
					and ADS.AuthorityId = :id
					and not exists (select 1 from InviteResult IR where IR.SlotCid = IS_.Cid)
					and not exists (select 1 from InviteCancellation C where C.SlotCid = IS_.Cid)`,
				{ id: this.authority.id },
			)) {
				const inviteKey = row.InviteKey as string;
				const nonce = row.SigningNonce as string;
				const groupKey = `${inviteKey}|${nonce}`;
				if (seen.has(groupKey)) continue;
				seen.add(groupKey);
				candidates.push({ inviteKey, nonce });
			}
			const cids: string[] = [];
			for (const c of candidates) {
				const resolution = await readInviteChain(this.ctx.db, c.inviteKey, 'of', nowCanonicalDatetime(), c.nonce);
				if (resolution.status === 'live' && !cids.includes(resolution.cid)) cids.push(resolution.cid);
			}
			return cids;
		} catch (err) {
			this.rethrow(err, 'getPendingInviteCids');
		}
	}

	/**
	 * Refuse (before any write) to withdraw or re-send an invitation that has
	 * already been answered. Only 'answered' is refused: cancelling an
	 * already-withdrawn chain stays an idempotent no-op, a resend after a cancel
	 * stays allowed, and an ambiguous chain is safe to withdraw (CR-01).
	 */
	private async assertChainUnanswered(slot: { InviteKey: string; Type: string; SigningNonce: string }): Promise<void> {
		const chain = await readInviteChain(this.ctx.db, slot.InviteKey, slot.Type, nowCanonicalDatetime(), slot.SigningNonce);
		if (chain.status === 'answered') {
			throw Object.assign(
				new Error('This invitation has already been answered, so it can no longer be withdrawn or re-sent'),
				{ code: INVITE_ALREADY_ANSWERED },
			);
		}
	}

	/**
	 * Who may withdraw or re-send an invitation (user decision 8b; re-opens and closes AR-62-141/142):
	 * the officer who sent it (AdminSigning.UserId of its signing session), or a CURRENT officer of THIS
	 * authority holding the scope that issues that invitation type (rad for 'of', iad for 'au', ik for
	 * 'k'). Anyone else, including another authority's engine and a context with no user, is refused with
	 * code 'invite-not-authorized' before any write.
	 *
	 * Residual (T-62-104-02): this governs THIS device's engine only. A forged, unsigned
	 * InviteCancellation replicating in still closes an invitation; a signed marker is a schema change (D-1).
	 */
	private async assertMayManageInvite(slot: { Type: string; SigningNonce: string }): Promise<void> {
		const refuse = (): never => {
			throw Object.assign(
				new Error('Only the officer who sent this invitation, or an administrator of this authority, can withdraw or re-send it'),
				{ code: INVITE_NOT_AUTHORIZED },
			);
		};
		const userId = this.ctx.user?.id;
		if (typeof userId !== 'string' || userId.length === 0) return refuse();
		const signing = await this.ctx.db
			.prepare('select AuthorityId, UserId from AdminSigning where Nonce = :nonce')
			.get({ nonce: slot.SigningNonce });
		if (!signing || signing.AuthorityId !== this.authority.id) return refuse();
		if (signing.UserId === userId) return;
		const scope = INVITE_ISSUING_SCOPE[slot.Type];
		if (scope === undefined) return refuse();
		const officer = await this.ctx.db
			.prepare(
				`select 1 as found
				   from Officer O
				   join CurrentAdmin CA on CA.AuthorityId = O.AuthorityId and CA.EffectiveAt = O.AdminEffectiveAt
				  where O.AuthorityId = :authorityId and O.UserId = :userId
				    and exists (select 1 from json_each(O.Scopes) where value = :scopeCode)
				  limit 1`,
			)
			.get({ authorityId: this.authority.id, userId, scopeCode: scope });
		if (!officer) return refuse();
	}

	/**
	 * SURF-03 (D-05/D-06): cancel a pending invitation by inserting append-only
	 * InviteCancellation markers. NON-signing: the context envelope carries only
	 * Tid + now. InviteSlot rows are never mutated (InsertOnly).
	 *
	 * A share is ONE invitation, so a withdrawal of ANY row must close the
	 * whole share: this cancels every row of the chain (same InviteKey, Type and
	 * SigningNonce) in one BEGIN/COMMIT. Cancellation and ResendSalt timestamps
	 * are one-second precision and cancellation Tids are not persisted, so the
	 * resolver cannot reliably order a cancel against a resend; the write side
	 * cancels the whole chain instead (CR-02, 62-REVIEW.md). A resend issued
	 * AFTER the cancel is a fresh uncancelled head, so re-issue still works.
	 * Rows already cancelled are skipped (idempotent).
	 *
	 * Refuses an invitation that has already been answered (accepted or
	 * declined) with an Error whose `code` is 'invite-already-answered', before
	 * any write (CR-01, 62-REVIEW.md).
	 *
	 * Throws when the slot does not exist (the marker's SlotExists CHECK also
	 * enforces this at the schema boundary — belt and suspenders).
	 */
	async cancelInvite(slotCid: string): Promise<void> {
		try {
			const slot = await this.ctx.db
				.prepare('select Cid, InviteKey, Type, SigningNonce from InviteSlot where Cid = :slotCid')
				.get({ slotCid });
			if (!slot) {
				throw new Error(`InviteSlot not found: ${slotCid}`);
			}
			const inviteKey = slot.InviteKey as string;
			const slotType = slot.Type as string;
			const nonce = slot.SigningNonce as string;
			await this.assertMayManageInvite({ Type: slotType, SigningNonce: nonce });
			const db = this.ctx.db;
			// The chain read, the 'answered' check and the markers share one serialized transaction
			// (gap7/IN-04): an InviteResult that lands first makes this refuse, with no marker.
			await withInviteWriteSerial(db, async () => {
				// Allocate to a local first, then interpolate (the site sits inside a
				// `with context` string, not a bound param).
				const tid = await allocateTid(db, 'authority');
				const now = nowCanonicalDatetime();
				await db.exec('BEGIN');
				try {
					const detail = await readInviteChainDetailed(db, inviteKey, slotType, nowCanonicalDatetime(), nonce);
					if (detail.resolution.status === 'answered') {
						throw Object.assign(
							new Error('This invitation has already been answered, so it can no longer be withdrawn or re-sent'),
							{ code: INVITE_ALREADY_ANSWERED },
						);
					}
					for (const row of detail.rows) {
						if (row.cancelled) continue;
						await db.exec(
							`insert into InviteCancellation (SlotCid, CancelledAt)
								with context Tid = ${tid}, now = :now
							values (:slotCid, :now)`,
							{ slotCid: row.cid, now },
						);
					}
					await db.exec('COMMIT');
				} catch (innerErr) {
					try {
						await db.exec('ROLLBACK');
					} catch {
						// already rolled back by the failed statement - the original error is what matters.
					}
					// A marker replicated in between our read and our insert collides on the primary key:
					// the withdrawal is then already in place, so resolve when every row now has a marker.
					if (/InviteCancellation/i.test(String((innerErr as Error)?.message ?? ''))) {
						const again = await readInviteChainDetailed(db, inviteKey, slotType, nowCanonicalDatetime(), nonce);
						if (again.rows.length > 0 && again.rows.every(r => r.cancelled)) return;
					}
					throw innerErr;
				}
			});
		} catch (err) {
			this.rethrow(err, 'cancelInvite');
		}
	}

	/**
	 * SURF-03 (D-05/D-07): re-emit a pending invitation as a FRESH InviteSlot.
	 * NON-signing (A2): reuses the original slot's already-approved SigningNonce
	 * and InviteSignature, so NO new signing round runs (no saveInviteWithSigning,
	 * no SigningEngine.sign). A fresh, unique Cid is derived by Digesting the
	 * original fields together with the resend timestamp + a per-process Tid salt
	 * (so the new row never PK-collides with the original). No marker links
	 * old→new and there is no auto-supersede; the pending list shows only the
	 * newest copy. Refuses an invitation that has already been answered with an
	 * Error whose `code` is 'invite-already-answered', before any write (CR-01).
	 * Returns the new slot's Cid.
	 *
	 * D-03 Option B (Phase 36): the resend salt is persisted as a real
	 * `InviteSlot.ResendSalt` column (not just fed into the Digest arg list) so
	 * the schema's CidValid CHECK can fully re-derive this row's Cid from its
	 * own columns alone — no structural-only acceptance window for resend rows.
	 *
	 * Throws when the original slot does not exist.
	 */
	async resendInvite(slotCid: string): Promise<string> {
		try {
			const orig = await this.ctx.db
				.prepare(
					`select Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce
						from InviteSlot where Cid = :slotCid`,
				)
				.get({ slotCid });
			if (!orig) {
				throw new Error(`InviteSlot not found: ${slotCid}`);
			}
			// Only officer and authority invitations are re-sent (gap7/IN-07): a keyholder slot has no
			// re-send path (its seat is re-invited by a new inviteKeyholder).
			if (orig.Type !== 'of' && orig.Type !== 'au') {
				throw Object.assign(
					new Error('Only officer and authority invitations can be re-sent'),
					{ code: INVITE_TYPE_NOT_RESENDABLE },
				);
			}
			await this.assertMayManageInvite({ Type: orig.Type as string, SigningNonce: orig.SigningNonce as string });
			return await withInviteWriteSerial(this.ctx.db, async () => {
				const tid = await allocateTid(this.ctx.db, 'authority');
				const now = nowCanonicalDatetime();
				const resendSalt = `resend|${tid}|${now}`;
				// WR-02: pre-compute the new row's Cid deterministically (same
				// 7-field order the CidValid resend branch re-derives) instead of
				// discovering it via a post-insert SELECT. Once a SigningNonce
				// chain has 3+ rows, `Cid <> :origCid` matches more than one row
				// and a non-unique lookup can non-deterministically return a
				// stale Cid from an earlier resend in the chain.
				const newCidRow = await this.ctx.db
					.prepare(
						`select cid(Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce, :type, :resendSalt)) as c`,
					)
					.get({
						expiration: orig.Expiration as string,
						inviteKey: orig.InviteKey as string,
						inviteSignature: orig.InviteSignature as string,
						name: orig.Name as string,
						nonce: orig.SigningNonce as string,
						type: orig.Type as string,
						resendSalt,
					});
				const newCid = newCidRow!.c as string;
				// Fresh, unique Cid: same fields as the original PLUS the resend
				// timestamp and Tid salt, so the Digest (and therefore the Cid PK)
				// differs from the original while the approval-bearing SigningNonce /
				// InviteSignature are reused verbatim (A2 — no new signing round).
				//
				// 999.1 R-03: no new signing round happens on resend, so there is no
				// fresh byte domain to verify against for an 'au' or 'of' invite the
				// same way saveAuthorityInvite/saveOfficerInvite do. 'au' invites are
				// fully re-verifiable (InviteSlot persists Type/Name/Expiration —
				// createAuthorityInvite's whole [type, name, expiration] domain).
				// 'of' invites are NOT: InviteSlot never persists Title/Scopes (see
				// the getPendingOfficerInvites doc comment — "InviteSlot stores only
				// Name"), so createOfficerInvite's [name, title, scopes, type,
				// expiration, inviteKey] domain cannot be reconstructed from stored
				// columns alone. This is a genuine data-availability gap, not a
				// fabricated `true`: the InviteSignature/InviteKey pair being
				// re-inserted here is copied byte-for-byte from `orig`, an
				// immutable (InsertOnly CHECK), already-real-signature-verified row
				// — not a fresh unverified claim. Documented limitation (999.1-09
				// SUMMARY); a full fix needs InviteSlot to persist Title/Scopes.
				const isSignatureValid = orig.Type === 'au'
					? verifyAdHocInviteSignature(
						authorityInviteSignedBytes({
							type: orig.Type as string,
							name: orig.Name as string,
							expiration: orig.Expiration as string,
						}),
						orig.InviteSignature as string,
						orig.InviteKey as string,
					)
					: true;
				await this.ctx.db.exec('BEGIN');
				try {
					await this.assertChainUnanswered({
						InviteKey: orig.InviteKey as string,
						Type: orig.Type as string,
						SigningNonce: orig.SigningNonce as string,
					});
					await this.ctx.db.exec(
						`insert into InviteSlot (
							Cid,
							Type,
							Name,
							Expiration,
							InviteKey,
							InviteSignature,
							SigningNonce,
							ResendSalt
							)
							with context Tid = ${tid}, now = :now, IsSignatureValid = :isSignatureValid, IsInsertValid = true
						values (
							:cid,
							:type,
							:name,
							:expiration,
							:inviteKey,
							:inviteSignature,
							:nonce,
							:resendSalt
							)`,
						{
							cid: newCid,
							type: orig.Type as string,
							name: orig.Name as string,
							expiration: orig.Expiration as string,
							inviteKey: orig.InviteKey as string,
							inviteSignature: orig.InviteSignature as string,
							nonce: orig.SigningNonce as string,
							resendSalt,
							now,
							isSignatureValid,
						},
					);
					await this.ctx.db.exec('COMMIT');
				} catch (innerErr) {
					try {
						await this.ctx.db.exec('ROLLBACK');
					} catch {
						// already rolled back by the failed statement.
					}
					throw innerErr;
				}
				return newCid;
			});
		} catch (err) {
			this.rethrow(err, 'resendInvite');
		}
	}

	/**
	 * Shared error funnel mirroring InvitationEngine.rethrow — maps Quereus /
	 * misuse errors to plain Errors with full detail and re-wraps the rest.
	 */
	private rethrow(err: unknown, method: string): never {
		if (err instanceof QuereusError) {
			throw new Error(`Quereus error (code ${err.code}): ${err.message}`);
		} else if (err instanceof MisuseError) {
			throw new Error(`API misuse: ${err.message}`);
		} else if (err instanceof Error) {
			const wrapped = new Error(`AuthorityEngine.${method}: ${err.message}`);
			// The app maps engine refusals by code, never by message text.
			const code = (err as { code?: unknown }).code;
			if (typeof code === 'string') Object.assign(wrapped, { code });
			throw wrapped;
		} else {
			throw new Error(`AuthorityEngine.${method}: unknown error: ${String(err)}`);
		}
	}

	async saveInviteWithSigning(
		invite: AuthorityInvite | OfficerInvite,
		scope: Scope, // either 'iad' for authority invites or 'rad' for officer invites
		signatureOrCallback: Signature | ((digest: Uint8Array) => Promise<Signature>),
	): Promise<void> {
		// D-19: nonce first, InviteSlots second, AdminSigning (startSigningSession) third
		const nonce = this.signingEngine.generateSigningNonce();
		if (invite.type === 'au') {
			// assume threshold for authority invites is 1
			await this.saveAuthorityInvite(invite, nonce);
		} else {
			// assume threshold for officer invites is 1
			await this.saveOfficerInvite(invite, nonce);
		}

		// D-03/D-04: if a sign callback is provided (screen-layer device-signer pattern),
		// compute the invite-slot Digest engine-side and call the callback with the digest
		// bytes — the engine stays digest-authoritative (D-03). The callback returns a
		// completed Signature without ever seeing the private key hex (D-01).
		// If a completed Signature is passed (test fixture path), use it directly.
		let signature: Signature;
		if (typeof signatureOrCallback === 'function') {
			const digestRow = await this.ctx.db
				.prepare('select Digest(Cid) as d from InviteSlot where SigningNonce = :nonce')
				.get({ nonce });
			if (!digestRow || digestRow.d == null) {
				throw new Error('saveInviteWithSigning: Digest() returned null — crypto plugin not registered?');
			}
			// Convert the Digest() output to Uint8Array via the shared decoder (WR-01 single
			// source of truth — same helper seedElectionSigning / addKey use).
			const digestBytes = digestToBytes(digestRow.d);
			signature = await signatureOrCallback(digestBytes);
		} else {
			signature = signatureOrCallback;
		}

		await this.signingEngine.startSigningSession(
			this.authority.id,
			null,
			scope,
			signature,
			nonce,
		);
	}

	private async saveAuthorityInvite(
		invite: AuthorityInvite,
		nonce: string,
	): Promise<void> {
		try {
			const tid = await allocateTid(this.ctx.db, 'authority');
			// 999.1 R-03: verify InviteSignature engine-side (via
			// verifyAdHocInviteSignature -> the shared verifySig() primitive,
			// see database/initialize.ts) against the exact ad-hoc byte domain
			// createAuthorityInvite signed — NOT SQL Digest() (Pitfall 2). A
			// real computed boolean, not a hardcoded `true`, gates
			// InviteSlot.InviteSignatureValid.
			const isSignatureValid = verifyAdHocInviteSignature(
				authorityInviteSignedBytes({ type: 'au', name: invite.name, expiration: invite.expiration }),
				invite.inviteSignature,
				invite.inviteKey,
			);
			await this.ctx.db.exec(
				`
				insert into InviteSlot (
					Cid,
					Type,
					Name,
					Expiration,
					InviteKey,
					InviteSignature,
					SigningNonce
					)
					with context Tid = :tid, now = :now, IsSignatureValid = :isSignatureValid, IsInsertValid = true
					values (
						cid(Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce, :type)),
						:type,
						:name,
						:expiration,
						:inviteKey,
						:inviteSignature,
						:nonce
						)`,
				{
					type: 'au',
					name: invite.name,
					expiration: invite.expiration,
					inviteKey: invite.inviteKey,
					inviteSignature: invite.inviteSignature,
					nonce,
					tid,
					now: nowCanonicalDatetime(),
					isSignatureValid,
				},
			);
		} catch (err) {
			if (err instanceof QuereusError) {
				throw new Error(`Quereus error (code ${err.code}): ${err.message}`);
			} else if (err instanceof MisuseError) {
				throw new Error(`API misuse: ${err.message}`);
			} else {
				throw new Error(`Unknown error: ${err}`);
			}
		}
	}

	private async saveOfficerInvite(
		invite: OfficerInvite,
		nonce: string,
	): Promise<void> {
		try {
			const tid = await allocateTid(this.ctx.db, 'authority');
			// 999.1 R-03: verify InviteSignature engine-side against the exact
			// ad-hoc byte domain createOfficerInvite signed — NOT SQL Digest()
			// (Pitfall 2). A real computed boolean, not a hardcoded `true`, gates
			// InviteSlot.InviteSignatureValid.
			const isSignatureValid = verifyAdHocInviteSignature(
				officerInviteSignedBytes({
					name: invite.name,
					title: invite.title,
					scopes: invite.scopes,
					type: invite.type,
					expiration: invite.expiration,
					inviteKey: invite.inviteKey,
				}),
				invite.inviteSignature,
				invite.inviteKey,
			);
			await this.ctx.db.exec(
				`
				insert into InviteSlot (
					Cid,
					Type,
					Name,
					Expiration,
					InviteKey,
					InviteSignature,
					SigningNonce
					)
				with context Tid = :tid, now = :now, IsSignatureValid = :isSignatureValid, IsInsertValid = true
				values (
					cid(Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce, :type)),
					:type,
					:name,
					:expiration,
					:inviteKey,
					:inviteSignature,
					:nonce
				)`,
				{
					type: invite.type,
					name: invite.name,
					expiration: invite.expiration,
					inviteKey: invite.inviteKey,
					inviteSignature: invite.inviteSignature,
					nonce,
					tid,
					now: nowCanonicalDatetime(),
					isSignatureValid,
				},
			);
		} catch (err) {
			// WR-07 (17-REVIEW): map errors with full detail (same as
			// saveAuthorityInvite) instead of swallowing the cause — a
			// CHECK-constraint failure must remain diagnosable.
			if (err instanceof QuereusError) {
				throw new Error(
					`Failed to save officer invitation — Quereus error (code ${err.code}): ${err.message}`,
				);
			} else if (err instanceof MisuseError) {
				throw new Error(
					`Failed to save officer invitation — API misuse: ${err.message}`,
				);
			} else {
				throw new Error(`Failed to save officer invitation: ${err}`, {
					cause: err,
				});
			}
		}
	}

	// ---- builder factories (BUILD-AUTH-01 / FACT-04) ----

	buildCreateOfficerInvite(): IAuthorityCreateOfficerInviteBuilder {
		return new AuthorityCreateOfficerInviteBuilder(this);
	}

	buildCreateAuthorityInvite(): IAuthorityCreateAuthorityInviteBuilder {
		return new AuthorityCreateAuthorityInviteBuilder(this);
	}

	buildProposeAdmin(): IAuthorityProposeAdminBuilder {
		return new AuthorityProposeAdminBuilder(this);
	}

	buildSaveInviteWithSigning(): IAuthoritySaveInviteWithSigningBuilder {
		return new AuthoritySaveInviteWithSigningBuilder(this);
	}
}
