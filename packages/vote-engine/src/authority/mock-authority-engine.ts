import type {
	AdminDetails,
	AdminInit,
	OfficerInvitation,
	OfficerInvitationContent,
	Admin,
	Authority,
	AuthorityDetails,
	AuthorityInvitation,
	AuthorityInvitationContent,
	InvitationStatus,
	Proposal,
	IAuthorityEngine,
	InvitationEnvelope,
	InvitationSigned,
	OfficerInit,
} from '@votetorrent/vote-core';
import {
	MOCK_SHARED_ADMINISTRATION_DETAILS, // Import shared details
	// MOCK_AUTHORITIES, // Keep if needed for other potential logic
	// MOCK_THRESHOLD_POLICIES_SLCO, // No longer needed, part of shared
	generateId, // Keep for generic cases if needed
	// generateHash, // Keep if needed
	// getUnixTimestamp // Keep if needed
} from '../mock-data.js';

// Local mock data definitions (MOCK_ADMINISTRATORS, MOCK_THRESHOLD_POLICIES, etc.) are removed.

export class MockAuthorityEngine implements IAuthorityEngine {
	private admin: Admin;
	private proposedAdmin?: Proposal<AdminInit>; // Can be undefined if not SLCO or no proposal made
	private proposedAuthority?: Proposal<Authority>; // Unused by current mock methods but part of interface/state
	// private isSlcoAuthority: boolean = false; // No longer needed

	constructor(private authority: Authority) {
		// Always initialize using the shared administration template
		const detailsCopy = JSON.parse(
			JSON.stringify(MOCK_SHARED_ADMINISTRATION_DETAILS)
		);

		this.admin = detailsCopy.admin;
		// **Important**: Set the correct authorityId for this specific instance
		this.admin.authorityId = this.authority.id;

		this.proposedAdmin = detailsCopy.proposed;
	}

	createAuthorityInvitation(
		name: string
	): InvitationEnvelope<AuthorityInvitationContent> {
		console.warn(
			'MockAuthorityEngine: createAuthorityInvitation is not implemented.'
		);
		throw new Error('Not implemented');
	}

	async getAdminDetails(): Promise<AdminDetails> {
		// Return the instance-specific administration details
		return {
			admin: this.admin,
			proposed: this.proposedAdmin,
		};
	}

	async getAuthorityInvitations(): Promise<
		InvitationStatus<AuthorityInvitation>[]
	> {
		console.warn(
			'MockAuthorityEngine: getAuthorityInvitations is not implemented.'
		);
		throw new Error('Not implemented');
	}

	async getDetails(): Promise<AuthorityDetails> {
		return {
			authority: this.authority,
			proposed: this.proposedAuthority, // This remains settable by proposeAuthority if implemented
		};
	}

	async inviteOfficer(
		invitationProposal: Proposal<OfficerInvitationContent>
	): Promise<OfficerInvitation> {
		console.warn('MockAuthorityEngine: inviteOfficer is not implemented.');
		// Mock: could add to this.administration.administrators if simple, or require proposal flow.
		throw new Error('Not implemented');
	}

	async saveAuthorityInvite(
		invitation: InvitationSigned<AuthorityInvitationContent>
	): Promise<void> {
		console.warn(
			'MockAuthorityEngine: saveAuthorityInvite is not implemented.'
		);
		throw new Error('Not implemented');
	}

	async proposeAdmin(adminProposal: Proposal<AdminInit>): Promise<void> {
		// Update the instance's proposed administration directly
		this.proposedAdmin = JSON.parse(JSON.stringify(adminProposal));
		console.log(
			`MockAuthorityEngine: Admin proposed for ${this.authority.name}.`
		);
	}

	async proposeAuthority(
		authorityUpdateProposal: Proposal<AuthorityInvitationContent> // Type might need adjustment
	): Promise<void> {
		console.warn('MockAuthorityEngine: proposeAuthority is not implemented.');
		throw new Error('Not implemented');
	}

	createOfficerInvitation(
		init: OfficerInit
	): InvitationEnvelope<OfficerInvitationContent> {
		console.warn(
			'MockAuthorityEngine: createOfficerInvitation is not implemented.'
		);
		throw new Error('Not implemented');
	}

	async saveAdminInvite(
		invitation: InvitationSigned<OfficerInvitationContent>
	): Promise<void> {
		console.warn('MockAuthorityEngine: saveAdminInvite is not implemented.');
		throw new Error('Not implemented');
	}
}
