import type {
	AdminDetails,
	AdminInit,
	OfficerInit,
	OfficerInvitationContent,
	Authority,
	AuthorityDetails,
	AuthorityInvitation,
	AuthorityInvitationContent,
	IAuthorityEngine,
	InvitationStatus,
	Proposal,
	InvitationEnvelope,
	InvitationSigned,
} from '@votetorrent/vote-core';
import { Temporal } from 'temporal-polyfill';
import { secp256k1 } from '@noble/curves/secp256k1';
import type { EngineContext } from '../types';
import { sha256 } from '@noble/hashes/sha2';

export class AuthorityEngine implements IAuthorityEngine {
	constructor(private authority: Authority, private ctx: EngineContext) {
		this.invitationSpanMinutes = 60;
	}

	private invitationSpanMinutes: number;

	createOfficerInvitation(
		init: OfficerInit
	): InvitationEnvelope<OfficerInvitationContent> {
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
			envelope: {
				content: {
					...init,
					type,
					expiration,
					inviteKey,
					invitePrivate,
					inviteSignature,
					digest: sha256(
						new TextEncoder().encode(
							init.name +
								init.title +
								init.scopes +
								type +
								expiration +
								inviteKey +
								inviteSignature
						)
					).toString(),
				},
				potentialKeys: this.ctx.user.activeKeys,
			},
			privateKey: invitePrivate,
		};
	}

	createAuthorityInvitation(
		name: string
	): InvitationEnvelope<AuthorityInvitationContent> {
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
			envelope: {
				content: {
					name,
					type,
					expiration,
					inviteKey,
					invitePrivate,
					inviteSignature,
					digest: sha256(
						new TextEncoder().encode(
							type + name + expiration + inviteKey + inviteSignature
						)
					).toString(),
				},
				potentialKeys: this.ctx.user.activeKeys,
			},
			privateKey: invitePrivate,
		};
	}

	async getAdminDetails(): Promise<AdminDetails> {
		// try {
		// 	const admin = await this.ctx.db.prepare(`select 1 from Admin where AuthoritySid = :sid`).get([this.authority.sid])['result'];
		// 	return admin as AdminDetails;
		// } catch (error) {
		// 	throw new Error('Failed to get admin details');
		// }
		throw new Error('Not implemented');
	}

	async getAuthorityInvitations(): Promise<
		InvitationStatus<AuthorityInvitation>[]
	> {
		return [];
	}

	async getDetails(): Promise<AuthorityDetails> {
		throw new Error('Not implemented');
	}

	async proposeAdmin(admin: Proposal<AdminInit>): Promise<void> {
		throw new Error('Not implemented');
	}

	async saveAdminInvite(
		invitation: InvitationSigned<OfficerInvitationContent>
	): Promise<void> {
		try {
			await this.ctx.db.exec(
				`
				insert into InvitationSlot (
					Cid,
					Type,
					Name,
					Expiration,
					InviteKey,
					InviteSignature,
					InviterKey,
					InviterSignature
					)
				values (
					:cid,
					:type,
					:name,
					:expiration,
					:inviteKey,
					:inviteSignature,
					:inviterKey,
					:inviterSignature
				)`,
				{
					cid: invitation.cid,
					type: invitation.signed.content.type,
					name: invitation.signed.content.name,
					expiration: invitation.signed.content.expiration,
					inviteKey: invitation.signed.content.inviteKey,
					inviteSignature: invitation.signed.content.inviteSignature,
					inviterKey: invitation.signed.signature.signerKey,
					inviterSignature: invitation.signed.signature.signature,
				}
			);
		} catch (error) {
			throw new Error('Failed to save officer invitation');
		}
	}

	async saveAuthorityInvite(
		invitation: InvitationSigned<AuthorityInvitationContent>
	): Promise<void> {
		try {
			await this.ctx.db.exec(
				`
				insert into InvitationSlot (
					Cid,
					Type,
					Name,
					Expiration,
					InviteKey,
					InviteSignature,
					InviterKey,
					InviterSignature
					)
				values (
					:cid,
					:type,
					:name,
					:expiration,
					:inviteKey,
					:inviteSignature,
					:inviterKey,
					:inviterSignature
				)`,
				{
					cid: invitation.cid,
					type: invitation.signed.content.type,
					name: invitation.signed.content.name,
					expiration: invitation.signed.content.expiration,
					inviteKey: invitation.signed.content.inviteKey,
					inviteSignature: invitation.signed.content.inviteSignature,
					inviterKey: invitation.signed.signature.signerKey,
					inviterSignature: invitation.signed.signature.signature,
				}
			);
		} catch (error) {
			throw new Error('Failed to save authority invitation');
		}
	}
}
