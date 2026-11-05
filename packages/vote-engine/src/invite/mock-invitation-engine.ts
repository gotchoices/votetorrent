import type {
  AcceptedOfficerInvitee,
  IInvitationEngine,
  InviteSlotResolution,
  InviteStatus,
  SentOfficerInvite,
  SentAuthorityInvite,
  SentKeyholderInvite,
  InviteType,
  KeyholderAcceptProvisioning,
  KeyholderSlotSeat,
  OfficerAcceptProvisioning
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
  // 66.1 (D-12): officer accepts recorded by respondToInvite, listed by getAcceptedOfficerInvitees.
  private readonly acceptedOfficers: AcceptedOfficerInvitee[] = []

  // The mock seeds no slots, so every share is honestly not-found.
  async resolveInviteSlot (_inviteKey: string, _type: InviteType): Promise<InviteSlotResolution> {
    return { status: 'not-found' }
  }

  // The mock seeds no slots, so every share is honestly not-found.
  async resolveInviteSlotCid (_inviteKey: string, _type: InviteType): Promise<string | undefined> {
    return undefined
  }

  async getPendingOfficerInvites (): Promise<Array<InviteStatus<SentOfficerInvite>>> {
    return MOCK_PENDING_OFFICER_INVITES
  }

  async getAcceptedOfficerInvitees (): Promise<AcceptedOfficerInvitee[]> {
    return this.acceptedOfficers.map((entry) => ({ ...entry }))
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

  async getKeyholderInvite (_id: string): Promise<InviteStatus<SentKeyholderInvite> | undefined> {
    // Simplest mock — return a seeded keyholder invite regardless of id (compile-time parity).
    return { invite: { name: 'Some Keyholder' } }
  }

  async getKeyholderSlotSeat (_slotCid: string): Promise<KeyholderSlotSeat | undefined> {
    return undefined
  }

  async respondToInvite (
    invitationId: string,
    accept: boolean,
    invitePrivate: string,
    _digest?: string,
    _invokedId?: string,
    _keyholder?: KeyholderAcceptProvisioning,
    officer?: OfficerAcceptProvisioning
  ): Promise<void> {
    if (typeof invitePrivate !== 'string' || !/^[0-9a-fA-F]{64}$/.test(invitePrivate)) {
      throw Object.assign(new Error('An invitation key is required to answer an invitation'), { code: 'invite-key-required' })
    }
    // The mock seeds no slots, so it cannot know a slot's type and never raises
    // officer-provisioning-required; that refusal belongs to the real engine.
    if (accept && officer !== undefined && !this.acceptedOfficers.some((entry) => entry.slotCid === invitationId)) {
      this.acceptedOfficers.push({ slotCid: invitationId, name: officer.name, userId: officer.userId })
    }
    console.log(`MockInvitationEngine: ${accept ? 'accepted' : 'declined'} invitation ${invitationId}`)
  }
}
