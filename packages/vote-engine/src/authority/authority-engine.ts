import { bytesToHex } from '@noble/curves/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2';
import { MisuseError, QuereusError } from '@quereus/quereus';
import { Temporal } from 'temporal-polyfill';
import { SigningEngine } from '../signing/signing-engine.js';
import {
	asText,
	fromCanonicalDatetime,
	nowCanonicalDatetime,
	parseJsonOr,
	toCanonicalDatetime,
} from '../utils.js';
import type { EngineContext } from '../types.js';

// WR-16 (17-REVIEW): seeded from the epoch-ms clock so a relaunched process
// attached to a persisted store cannot re-issue Tids consumed by a previous
// run (see the full rationale on the ElectionsEngine counter). Replace with
// store-reconciled allocation at PERSIST-01.
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
			const signers: string[] = [];
			const signingDB = await this.ctx.db
				.prepare(
					'select Nonce from AdminSigning where AuthorityId = :id and Scope = :scope order by AdminEffectiveAt desc limit 1',
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
			const signers: string[] = [];
			const signingDB = await this.ctx.db
				.prepare(
					'select Nonce from AdminSigning where AuthorityId = :id and Scope = :scope order by AdminEffectiveAt desc limit 1',
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
		signature: Signature,
	): Promise<void> {
		const thresholdPoliciesJson = JSON.stringify(
			admin.proposed.thresholdPolicies,
		);
		const initialSignerId = admin.signers[0];
		if (!initialSignerId) {
			throw new Error('Failed to propose admin: No initial signer');
		}
		const tid = nextTid++;
		try {
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
					effectiveAt: toCanonicalDatetime(admin.proposed.effectiveAt),
					thresholdPolicies: thresholdPoliciesJson,
					signerUserId: signature.signerUserId,
					signerKey: signature.signerKey,
					signature: signature.signature,
					now: nowCanonicalDatetime(),
				},
			);

			const adminDigestArgs: AdminDigestArgs = {
				authorityId: this.authority.id,
				effectiveAt: toCanonicalDatetime(admin.proposed.effectiveAt),
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

	async saveInviteWithSigning(
		invite: AuthorityInvite | OfficerInvite,
		scope: Scope, // either 'iad' for authority invites or 'rad' for officer invites
		signature: Signature,
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
