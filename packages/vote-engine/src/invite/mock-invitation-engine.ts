import type {
  IInvitationEngine,
  InviteStatus,
  SentOfficerInvite,
  SentAuthorityInvite
} from '@votetorrent/vote-core'

/**
 * Seed data for the mock invitation engine (D-10).
 *
 * Provides ≥2 pending officer invites and ≥1 pending authority invite so the
 * AdministratorInvitationScreen and AuthorityInvitationScreen accept-mode views
 * render with realistic content in v1.1 mocks-only mode.
 */
const MOCK_PENDING_OFFICER_INVITES: Array<InviteStatus<SentOfficerInvite>> = [
  {
    invite: {
      name: 'Jane Doe',
      title: 'Treasurer',
      scopes: ['rad', 'mel'],
      type: 'of'
    }
  },
  {
    invite: {
      name: 'John Smith',
      title: 'Secretary',
      scopes: ['ceb'],
      type: 'of'
    }
  }
]

const MOCK_PENDING_AUTHORITY_INVITES: Array<InviteStatus<SentAuthorityInvite>> = [
  {
    invite: {
      name: 'Salt Lake County Clerk',
      type: 'au'
    }
  }
]

export class MockInvitationEngine implements IInvitationEngine {
  async getPendingOfficerInvites (): Promise<Array<InviteStatus<SentOfficerInvite>>> {
    return MOCK_PENDING_OFFICER_INVITES
  }

  async getPendingAuthorityInvites (): Promise<Array<InviteStatus<SentAuthorityInvite>>> {
    return MOCK_PENDING_AUTHORITY_INVITES
  }

  async getOfficerInvite (_id: string): Promise<InviteStatus<SentOfficerInvite> | undefined> {
    // Simplest mock — return first seeded invite regardless of id (v1.1 mocks-only).
    return MOCK_PENDING_OFFICER_INVITES[0]
  }

  async getAuthorityInvite (_id: string): Promise<InviteStatus<SentAuthorityInvite> | undefined> {
    // Simplest mock — return first seeded invite regardless of id (v1.1 mocks-only).
    return MOCK_PENDING_AUTHORITY_INVITES[0]
  }

  async respondToInvite (invitationId: string, accept: boolean): Promise<void> {
    console.log(`MockInvitationEngine: ${accept ? 'accepted' : 'declined'} invitation ${invitationId}`)
  }
}
