import { bytesToHex } from '@noble/curves/utils.js';
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
import {
	asText,
	digestToBytes,
	fromCanonicalDatetime,
	nowCanonicalDatetime,
	parseJsonOr,
	toCanonicalDatetime,
} from '../utils.js';
import type { EngineContext } from '../types.js';

// WR-16 (17-REVIEW): seeded from the epoch-ms clock to reduce the chance that
// a relaunched process attached to a persisted store re-issues Tids consumed
// by a previous run (see the full rationale on the ElectionsEngine counter).
// WR-25 (17-REVIEW): this is a HEURISTIC, not a guarantee — allocation bursts
// faster than 1/ms (counter outruns the clock; a restart inside that window
// re-issues Tids) and device clock rollback both silently defeat it, and
// neither condition is detected. PERSIST-01 must replace this with
// store-reconciled allocation seeded from a persisted high-water mark.
let nextTid = Date.now();
import type {
	AdminDetails,
	AdminDigestArgs,
	AdminInit,
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

export class AuthorityEngine implements IAuthorityEngine {
	constructor(
		private readonly authority: Authority,
		private readonly ctx: EngineContext,
		private readonly signingEngine: ISigningEngine = new SigningEngine(ctx),
	) {
		this.invitationSpanMinutes = 60;
	}

	private readonly invitationSpanMinutes: number;

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
			const proposedAdminDB = await this.ctx.db
				.prepare(
					'select EffectiveAt, ThresholdPolicies from ProposedAdmin where AuthorityId = :id',
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
				proposedOfficersDB.push({
					init: {
						name: officer.ProposedName as string,
						title: officer.Title as string,
						scopes: parseJsonOr<Scope[]>(officer.Scopes, [], 'Officer.Scopes'),
					},
				});
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
				imageRef: parseJsonOr<ImageRef | undefined>(
					authorityDB.ImageRef,
					undefined,
					'Authority.ImageRef',
				),
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
		const tid = nextTid++;
		try {
			// D-03/D-04: resolve the concrete Signature.
			// If a sign callback is provided, compute the canonical digest engine-side
			// (same args as PATH A's inline Digest() in startSigningSession) and invoke
			// the callback so the caller signs exactly the bytes the engine stores.
			// If a completed Signature is passed (test fixture path), use it directly.
			let signature: Signature;
			if (typeof signatureOrCallback === 'function') {
				const digestRow = await this.ctx.db
					.prepare(
						'select Digest(:authorityId, :effectiveAt, :thresholdPolicies) as d',
					)
					.get({
						authorityId: this.authority.id,
						effectiveAt: effectiveAtCanon,
						thresholdPolicies: thresholdPoliciesJson,
					});
				if (!digestRow || digestRow.d == null) {
					throw new Error('proposeAdmin: Digest() returned null — crypto plugin not registered?');
				}
				// WR-01: single shared digestToBytes decoder.
				const digestBytes = digestToBytes(digestRow.d);
				signature = await signatureOrCallback(digestBytes);
			} else {
				signature = signatureOrCallback;
			}

			await this.ctx.db.exec(
				`insert into ProposedAdmin (
					AuthorityId,
					EffectiveAt,
					ThresholdPolicies
				)
					with context UserId = :signerUserId, UserKey = :signerKey, Signature = :signature, Tid = ${tid}, now = :now, IsUserValid = true
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
					now: nowCanonicalDatetime(),
				},
			);

			const adminDigestArgs: AdminDigestArgs = {
				authorityId: this.authority.id,
				effectiveAt: effectiveAtCanon,
				thresholdPolicies: thresholdPoliciesJson,
			};
			// WR-06 (17-REVIEW): proposeAdmin only STARTS the signing session with
			// the instigator's signature. For threshold policies > 1, the remaining
			// signers complete the proposal via separate per-signer calls to
			// `signingEngine.sign(nonce, signature)` — each signer must produce
			// their OWN signature, so completion cannot happen inside this method
			// (a previously commented-out loop here would have re-applied the
			// instigator's signature for every signer, which is wrong).
			await this.signingEngine.startSigningSession(
				this.authority.id,
				adminDigestArgs,
				'rad',
				signature,
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

	// ---- SURF-03: pending-invite read + cancel/resend (non-signing, D-05/06/07) ----

	/**
	 * SURF-03 read surface: return the Cids of pending officer-invite InviteSlots
	 * (Type = 'of') for this authority's signing scope, filtered to drop any slot
	 * that has been responded to (InviteResult) OR cancelled (InviteCancellation).
	 *
	 * The cancellation filter is the second `NOT EXISTS` clause appended to the
	 * existing `getPendingOfficerInvites` template (invitation-engine.ts:35-38):
	 * a slot with a matching InviteCancellation marker drops off the list while
	 * the append-only marker — and the slot itself — persist for audit (D-06).
	 *
	 * Scoped to this authority via the AdminSigning join used by
	 * getAuthorityInvites (scope 'rad' = officer-invite admin approval).
	 */
	async getPendingInviteCids(): Promise<string[]> {
		try {
			const cids: string[] = [];
			for await (const row of this.ctx.db.eval(
				`select IS_.Cid from InviteSlot IS_
					join AdminSigning ADS on IS_.SigningNonce = ADS.Nonce
				where IS_.Type = 'of'
					and ADS.AuthorityId = :id
					and not exists (select 1 from InviteResult IR where IR.SlotCid = IS_.Cid)
					and not exists (select 1 from InviteCancellation C where C.SlotCid = IS_.Cid)`,
				{ id: this.authority.id },
			)) {
				cids.push(row.Cid as string);
			}
			return cids;
		} catch (err) {
			this.rethrow(err, 'getPendingInviteCids');
		}
	}

	/**
	 * SURF-03 (D-05/D-06): cancel a pending invitation by inserting an append-only
	 * InviteCancellation marker keyed by the InviteSlot Cid. NON-signing: the
	 * context envelope carries only Tid + now. The InviteSlot is never mutated
	 * (InviteSlot is InsertOnly); the slot simply drops off getPendingInviteCids
	 * on the next read because of the InviteCancellation NOT EXISTS filter.
	 *
	 * Throws when the slot does not exist (the marker's SlotExists CHECK also
	 * enforces this at the schema boundary — belt and suspenders).
	 */
	async cancelInvite(slotCid: string): Promise<void> {
		try {
			const slot = await this.ctx.db
				.prepare('select Cid from InviteSlot where Cid = :slotCid')
				.get({ slotCid });
			if (!slot) {
				throw new Error(`InviteSlot not found: ${slotCid}`);
			}
			await this.ctx.db.exec(
				`insert into InviteCancellation (SlotCid, CancelledAt)
					with context Tid = ${nextTid++}, now = :now
				values (:slotCid, :now)`,
				{ slotCid, now: nowCanonicalDatetime() },
			);
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
	 * old→new and there is no auto-supersede — both old and new may legitimately
	 * appear in the pending list. Returns the new slot's Cid.
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
			const tid = nextTid++;
			const now = nowCanonicalDatetime();
			// Fresh, unique Cid: same fields as the original PLUS the resend
			// timestamp and Tid salt, so the Digest (and therefore the Cid PK)
			// differs from the original while the approval-bearing SigningNonce /
			// InviteSignature are reused verbatim (A2 — no new signing round).
			await this.ctx.db.exec(
				`insert into InviteSlot (
					Cid,
					Type,
					Name,
					Expiration,
					InviteKey,
					InviteSignature,
					SigningNonce
					)
					with context Tid = ${tid}, now = :now, IsSignatureValid = true, IsInsertValid = true, IsCidValid = true
				values (
					Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce, :type, :resendSalt),
					:type,
					:name,
					:expiration,
					:inviteKey,
					:inviteSignature,
					:nonce
					)`,
				{
					type: orig.Type as string,
					name: orig.Name as string,
					expiration: orig.Expiration as string,
					inviteKey: orig.InviteKey as string,
					inviteSignature: orig.InviteSignature as string,
					nonce: orig.SigningNonce as string,
					resendSalt: `resend|${tid}|${now}`,
					now,
				},
			);
			const newRow = await this.ctx.db
				.prepare(
					`select Cid from InviteSlot
						where SigningNonce = :nonce and InviteSignature = :inviteSignature and Cid <> :origCid`,
				)
				.get({
					nonce: orig.SigningNonce as string,
					inviteSignature: orig.InviteSignature as string,
					origCid: slotCid,
				});
			if (!newRow) {
				throw new Error('resendInvite: fresh InviteSlot not found after insert');
			}
			return newRow.Cid as string;
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
			throw new Error(`AuthorityEngine.${method}: ${err.message}`);
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
					with context Tid = :tid, now = :now, IsSignatureValid = true, IsInsertValid = true, IsCidValid = true
					values (
						Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce),
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
					tid: nextTid++,
					now: nowCanonicalDatetime(),
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
				with context Tid = :tid, now = :now, IsSignatureValid = true, IsInsertValid = true, IsCidValid = true
				values (
					Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce, :type),
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
					tid: nextTid++,
					now: nowCanonicalDatetime(),
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
