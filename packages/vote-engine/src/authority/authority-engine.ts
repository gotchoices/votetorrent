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
import {
	SafeStringSchema,
	HexStringSchema,
	TimestampSchema,
} from '@votetorrent/vote-core';
import { Temporal } from 'temporal-polyfill';
import type { EngineContext } from '../types';
import {
	generatePrivateKey,
	getPublicKey,
	signMessage,
	hashMessage,
} from '../common/crypto-utils.js';

export class AuthorityEngine implements IAuthorityEngine {
	constructor(private authority: Authority, private ctx: EngineContext) {}

	createAuthorityInvitation(
		name: string
	): InvitationEnvelope<AuthorityInvitationContent> {
		// Validate input to prevent injection attacks
		const validatedName = SafeStringSchema.min(1).max(200).parse(name);

		// Create invitation key pair using secure crypto utilities
		const invitePrivate = generatePrivateKey();
		const inviteKey = getPublicKey(invitePrivate);

		const type = 'au';
		const expiration = Temporal.Now.plainDateTimeISO('UTC')
			.add({ minutes: this.ctx.config.invitationSpanMinutes })
			.toString();

		// Sign the invitation metadata
		const messageToSign = type + validatedName + expiration;
		const inviteSignature = signMessage(messageToSign, invitePrivate);

		// Create digest of the complete invitation content
		const digestMessage = type + validatedName + expiration + inviteKey + inviteSignature;
		const digest = hashMessage(digestMessage);

		return {
			envelope: {
				content: {
					name: validatedName,
					type,
					expiration,
					inviteKey,
					invitePrivate,
					inviteSignature,
					digest,
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
		// Validate all user inputs before database insertion
		const validatedName = SafeStringSchema.min(1).max(200).parse(invitation.signed.content.name);
		const validatedInviteKey = HexStringSchema.parse(invitation.signed.content.inviteKey);
		const validatedInviteSignature = HexStringSchema.parse(invitation.signed.content.inviteSignature);
		const validatedInviterKey = HexStringSchema.parse(invitation.signed.signature.signerKey);
		const validatedInviterSignature = HexStringSchema.parse(invitation.signed.signature.signature);

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
					name: validatedName,
					expiration: invitation.signed.content.expiration,
					inviteKey: validatedInviteKey,
					inviteSignature: validatedInviteSignature,
					inviterKey: validatedInviterKey,
					inviterSignature: validatedInviterSignature,
				}
			);
		} catch (error) {
			throw new Error('Failed to save authority invitation');
		}
	}
}
