import type {
	AdministrationDetails,
	AdministrationInit,
	AdministratorInvitation,
	AdministratorInvitationContent,
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
	constructor(private authority: Authority, private ctx: EngineContext) {}

	createAuthorityInvitation(
		name: string
	): InvitationEnvelope<AuthorityInvitationContent> {
		//create invitation key pair
		const invitePrivate = secp256k1.utils.randomSecretKey().toString();
		const inviteKey = secp256k1.getPublicKey(invitePrivate).toString();

		const type = 'au';
		const expiration = Temporal.Now.plainDateTimeISO('UTC')
			.add({ minutes: this.ctx.config.invitationSpanMinutes })
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

	async getAdministrationDetails(): Promise<AdministrationDetails> {
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

	async inviteAdministrator(
		name: Proposal<AdministratorInvitationContent>
	): Promise<AdministratorInvitation> {
		throw new Error('Not implemented');
	}

	async proposeAdministration(
		administration: Proposal<AdministrationInit>
	): Promise<void> {
		throw new Error('Not implemented');
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
