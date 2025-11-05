import type {
	AdminDetails,
	AdminInit,
	Officer,
	OfficerInit,
	OfficerInvite,
	Authority,
	AuthorityDetails,
	AuthorityInvite,
	IAuthorityEngine,
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
import { Temporal } from 'temporal-polyfill';
import { secp256k1 } from '@noble/curves/secp256k1';
import type { EngineContext } from '../types.js';
import { sha256 } from '@noble/hashes/sha2';
import { MisuseError, QuereusError } from '@quereus/quereus';
import { SigningEngine } from '../signing/signing-engine.js';
import { Digest } from '@optimystic/quereus-plugin-crypto';
import { asText, parseJsonOr } from '../utils.js';

export class AuthorityEngine implements IAuthorityEngine {
	constructor(
		private authority: Authority,
		private ctx: EngineContext,
		private signingEngine: ISigningEngine = new SigningEngine(ctx)
	) {
		this.invitationSpanMinutes = 60;
	}

	private invitationSpanMinutes: number;

	createOfficerInvite(init: OfficerInit): OfficerInvite {
		//create invitation key pair
		const invitePrivate = secp256k1.utils.randomSecretKey().toString();
		const inviteKey = secp256k1.getPublicKey(invitePrivate).toString();

		const type = 'of';
		const expiration = Temporal.Now.plainDateTimeISO('UTC')
			.add({ minutes: this.invitationSpanMinutes })
			.toString();

		const signedBytes = new TextEncoder().encode(
			init.name + init.title + init.scopes + type + expiration + inviteKey
		);
		const inviteSignature = secp256k1
			.sign(sha256(signedBytes), invitePrivate)
			.toString();

		return {
			...init,
			type,
			expiration,
			inviteKey,
			invitePrivate,
			inviteSignature,
			digest: Digest(
				init.name +
					init.title +
					init.scopes +
					type +
					expiration +
					inviteKey +
					inviteSignature
			).toString(),
		};
	}

	createAuthorityInvite(name: string): AuthorityInvite {
		//create invitation key pair
		const invitePrivate = secp256k1.utils.randomSecretKey().toString();
		const inviteKey = secp256k1.getPublicKey(invitePrivate).toString();

		const type = 'au';
		const expiration = Temporal.Now.plainDateTimeISO('UTC')
			.add({ minutes: this.invitationSpanMinutes })
			.toString();
		const signedBytes = new TextEncoder().encode(type + name + expiration);
		const inviteSignature = secp256k1
			.sign(sha256(signedBytes), invitePrivate)
			.toString();

		return {
			name,
			type,
			expiration,
			inviteKey,
			invitePrivate,
			inviteSignature,
			digest: Digest(
				type + name + expiration + inviteKey + inviteSignature
			).toString(),
		};
	}

	async getAdminDetails(): Promise<AdminDetails> {
		try {
			const adminDB = await this.ctx.db
				.prepare(
					`select Id, AuthorityId, EffectiveAt, ThresholdPolicies
						from Admin A join CurrentAdmin CA on A.AuthorityId = CA.AuthorityId and A.EffectiveAt = CA.EffectiveAt
					where A.AuthorityId = :id`
				)
				.get({ ':id': this.authority.id });
			const officersDB: Officer[] = [];
			for await (const officer of this.ctx.db.eval(
				`select * from Officer where AuthorityId = :id and AdminEffectiveAt = :effectiveAt`,
				{
					':id': this.authority.id,
					':effectiveAt': adminDB!['EffectiveAt'] as number,
				}
			)) {
				officersDB.push({
					userId: officer!['UserId'] as string,
					authorityId: adminDB!['AuthorityId'] as string,
					title: officer!['Title'] as string,
					scopes: parseJsonOr<Scope[]>(
						officer!['Scopes'],
						[],
						'Officer.Scopes'
					),
				});
			}
			const proposedAdminDB = await this.ctx.db
				.prepare(
					`select EffectiveAt from ProposedAdmin where AuthorityId = :id`
				)
				.get({ ':id': this.authority.id });
			const proposedOfficersDB: OfficerSelection[] = [];
			for await (const officer of this.ctx.db.eval(
				`select * from ProposedOfficer where AuthorityId = :id and AdminEffectiveAt = :effectiveAt`,
				{
					':id': this.authority.id,
					':effectiveAt': proposedAdminDB!['EffectiveAt'] as number,
				}
			)) {
				proposedOfficersDB.push({
					init: {
						name: officer!['ProposedName'] as string,
						title: officer!['Title'] as string,
						scopes: parseJsonOr<Scope[]>(
							officer!['Scopes'],
							[],
							'Officer.Scopes'
						),
					},
				});
			}
			return {
				admin: {
					id: adminDB!['Id'] as string,
					authorityId: adminDB!['AuthorityId'] as string,
					effectiveAt: adminDB!['EffectiveAt'] as number,
					officers: officersDB,
					thresholdPolicies: parseJsonOr<ThresholdPolicy[]>(
						adminDB!['ThresholdPolicies'],
						[],
						'Admin.ThresholdPolicies'
					),
				},
				proposed: {
					proposed: {
						officers: proposedOfficersDB,
						effectiveAt: proposedAdminDB!['EffectiveAt'] as number,
						thresholdPolicies: parseJsonOr<ThresholdPolicy[]>(
							proposedAdminDB!['ThresholdPolicies'],
							[],
							'Admin.ThresholdPolicies'
						),
					},
					signers: [] as string[], //TODO: fix this
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

	async getAuthorityInvites(): Promise<InviteStatus<SentAuthorityInvite>[]> {
		try {
			const authorityInvites: (SentAuthorityInvite & { cid: string })[] = [];
			for await (const invite of this.ctx.db.eval(
				`select Name, Cid from InviteSlot
					join AdminSigning on InviteSlot.SigningNonce = AdminSigning.Nonce
						where AdminSigning.AuthorityId = :id and AdminSigning.Scope = :scope`,
				{ ':id': this.authority.id, ':scope': 'iad' }
			)) {
				authorityInvites.push({
					name: invite!['Name'] as string,
					type: 'au',
					cid: invite!['Cid'] as string,
				});
			}

			const acceptedAuthorityInvites: (InviteResult & { cid: string })[] = [];
			for await (const inviteResult of this.ctx.db.eval(
				`select SlotCid, IsAccepted, InviteSignature, InvokedId from InviteResult
					join InviteSlot on InviteResult.SlotCid = InviteSlot.Cid
						join AdminSigning on InviteSlot.SigningNonce = AdminSigning.Nonce
				where AuthorityId = :id and Scope = :scope`,
				{ ':id': this.authority.id, ':scope': 'iad' }
			)) {
				acceptedAuthorityInvites.push({
					cid: inviteResult!['SlotCid'] as string,
					isAccepted: inviteResult!['IsAccepted'] as boolean,
					invitationSignature: inviteResult!['InviteSignature'] as string,
					invokedId: inviteResult!['InvokedId'] as string | undefined,
				});
			}

			const inviteStatuses: InviteStatus<SentAuthorityInvite>[] = [];
			for (const invite of authorityInvites) {
				inviteStatuses.push({
					invite: {
						name: invite.name,
						type: 'au',
					},
					result: (() => {
						const accepted = acceptedAuthorityInvites.find(
							(a) => a.cid === invite.cid
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
		const authorityDB = await this.ctx.db
			.prepare(
				`select Id, Name, DomainName, ImageRef from Authority where Id = :id`
			)
			.get({ ':id': this.authority.id });
		if (!authorityDB) {
			throw new Error('Authority not found');
		}
		const proposedAuthorityDB = await this.ctx.db
			.prepare(`select Name, DomainName from ProposedAuthority where Id = :id`)
			.get({ ':id': this.authority.id });
		if (!proposedAuthorityDB) {
			throw new Error('Proposed authority not found');
		}
		return {
			authority: {
				id: authorityDB!['Id'] as string,
				name: authorityDB!['Name'] as string,
				domainName: asText(authorityDB['DomainName'], 'Authority.DomainName'),
				imageRef: parseJsonOr<ImageRef | undefined>(
					authorityDB['ImageRef'],
					undefined,
					'Authority.ImageRef'
				),
			},
			proposed: {
				proposed: {
					name: proposedAuthorityDB!['Name'] as string,
					domainName: asText(
						proposedAuthorityDB!['DomainName'],
						'ProposedAuthority.DomainName'
					),
				},
				signers: [] as string[], //TODO: fix this
			},
		};
	}

	async proposeAdmin(admin: Proposal<AdminInit>): Promise<void> {
		const thresholdPoliciesJson = JSON.stringify(
			admin.proposed.thresholdPolicies
		);
		const initialSignerId = admin.signers[0];
		if (!initialSignerId) {
			throw new Error('Failed to propose admin: No initial signer');
		}
		const dummySignature: Signature = {
			signerUserId: initialSignerId,
			signature: 'dummy-signature',
			signerKey: 'dummy-signer-key',
		};
		try {
			await this.ctx.db.exec(
				`insert into ProposedAdmin (
					AuthorityId,
					EffectiveAt,
					ThresholdPolicies
				)
					with context :signerUserId, :signerKey, :signature, Tid
				values (
					:authorityId,
					:effectiveAt,
					:thresholdPolicies
				)`,
				{
					authorityId: this.authority.id,
					effectiveAt: admin.proposed.effectiveAt,
					thresholdPolicies: thresholdPoliciesJson,
					signerUserId: initialSignerId,
					signerKey: dummySignature.signerKey,
					signature: dummySignature.signature,
				}
			);

			let signingResult = await this.signingEngine.startSigningSession(
				this.authority.id,
				Digest(
					this.authority.id,
					admin.proposed.effectiveAt,
					thresholdPoliciesJson
				).toString(),
				'rad',
				dummySignature
			);

			// if the threshold is not reached, apply the remaining signatures
			// if (!signingResult.thresholdReached) {
			// 	for (const signerId of admin.signers.slice(1)) {
			// 		const isDone = await this.signingEngine.sign(
			// 			signingResult.nonce,
			// 			signature
			// 		);
			// 		if (isDone) {
			// 			break;
			// 		}
			// 	}
			// }
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
		signature: Signature
	): Promise<void> {
		const result = await this.signingEngine.startSigningSession(
			this.authority.id,
			invite.digest,
			scope,
			signature
		);
		if (invite.type === 'au') {
			// assume threshold for authority invites is 1
			await this.saveAuthorityInvite(invite, result.nonce);
		} else {
			// assume threshold for officer invites is 1
			await this.saveOfficerInvite(invite, result.nonce);
		}
	}

	private async saveAuthorityInvite(
		invite: AuthorityInvite,
		nonce: string
	): Promise<void> {
		try {
			await this.ctx.db.exec(
				`
				insert into InviteSlot (
					Cid,
					Name,
					Expiration,
					InviteKey,
					InviteSignature,
					SigningNonce
					)
					values (
						:cid,
						:name,
						:expiration,
						:inviteKey,
						:inviteSignature,
						:signingNonce
						)`,
				{
					cid: Digest(
						invite.name,
						invite.expiration,
						invite.inviteKey,
						invite.inviteSignature,
						nonce
					).toString(),
					name: invite.name,
					expiration: invite.expiration,
					inviteKey: invite.inviteKey,
					inviteSignature: invite.inviteSignature,
					signingNonce: nonce,
				}
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
		nonce: string
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
				values (
					:cid,
					:type,
					:name,
					:expiration,
					:inviteKey,
					:inviteSignature,
					:signingNonce
				)`,
				{
					cid: Digest(
						invite.type,
						invite.name,
						invite.expiration,
						invite.inviteKey,
						invite.inviteSignature,
						nonce
					).toString(),
					type: invite.type,
					name: invite.name,
					expiration: invite.expiration,
					inviteKey: invite.inviteKey,
					inviteSignature: invite.inviteSignature,
					signingNonce: nonce,
				}
			);
		} catch (error) {
			throw new Error('Failed to save officer invitation');
		}
	}
}
