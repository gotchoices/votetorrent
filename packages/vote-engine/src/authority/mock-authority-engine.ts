import type {
	AdministrationDetails,
	AdministrationInit,
	Administrator,
	AdministratorInvitation,
	AdministratorInvitationContent,
	Administration,
	Authority,
	AuthorityDetails,
	AuthorityInvitation,
	AuthorityInvitationContent,
	InvitationStatus,
	Proposal,
	Scope,
	ThresholdPolicy,
	IAuthorityEngine,
} from '@votetorrent/vote-core';
import {
	MOCK_SHARED_ADMINISTRATION_DETAILS, // Import shared details
	// MOCK_AUTHORITIES, // Keep if needed for other potential logic
	// MOCK_THRESHOLD_POLICIES_SLCO, // No longer needed, part of shared
	generateSid, // Keep for generic cases if needed
	// generateHash, // Keep if needed
	// getUnixTimestamp // Keep if needed
} from '../mock-data';

// Local mock data definitions (MOCK_ADMINISTRATORS, MOCK_THRESHOLD_POLICIES, etc.) are removed.

export class MockAuthorityEngine implements IAuthorityEngine {
	private administration: Administration;
	private proposedAdministration?: Proposal<AdministrationInit>; // Can be undefined if not SLCO or no proposal made
	private proposedAuthority?: Proposal<Authority>; // Unused by current mock methods but part of interface/state
	// private isSlcoAuthority: boolean = false; // No longer needed

	constructor(private authority: Authority) {
		// Always initialize using the shared administration template
		const detailsCopy = JSON.parse(
			JSON.stringify(MOCK_SHARED_ADMINISTRATION_DETAILS)
		);

		this.administration = detailsCopy.administration;
		// **Important**: Set the correct authoritySid for this specific instance
		this.administration.authoritySid = this.authority.sid;

		this.proposedAdministration = detailsCopy.proposed;
	}

	async getAdministrationDetails(): Promise<AdministrationDetails> {
		// Return the instance-specific administration details
		return {
			administration: this.administration,
			proposed: this.proposedAdministration,
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

	async inviteAdministrator(
		invitationProposal: Proposal<AdministratorInvitationContent>
	): Promise<AdministratorInvitation> {
		console.warn(
			'MockAuthorityEngine: inviteAdministrator is not implemented.'
		);
		// Mock: could add to this.administration.administrators if simple, or require proposal flow.
		throw new Error('Not implemented');
	}

	async inviteAuthority(
		invitationProposal: Proposal<AuthorityInvitationContent>
	): Promise<AuthorityInvitation> {
		console.warn('MockAuthorityEngine: inviteAuthority is not implemented.');
		throw new Error('Not implemented');
	}

	async proposeAdministration(
		administrationProposal: Proposal<AdministrationInit>
	): Promise<void> {
		// Update the instance's proposed administration directly
		this.proposedAdministration = JSON.parse(
			JSON.stringify(administrationProposal)
		);
		console.log(
			`MockAuthorityEngine: Administration proposed for ${this.authority.name}.`
		);
	}

	async proposeAuthority(
		authorityUpdateProposal: Proposal<AuthorityInvitationContent> // Type might need adjustment
	): Promise<void> {
		console.warn('MockAuthorityEngine: proposeAuthority is not implemented.');
		throw new Error('Not implemented');
	}
}
