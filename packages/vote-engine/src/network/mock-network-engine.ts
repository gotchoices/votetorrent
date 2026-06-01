import { MockAuthorityEngine } from '../authority/mock-authority-engine.js'
import {
  generateId,
  MOCK_AUTHORITIES,
  MOCK_NETWORKS,
  MOCK_UTAH_ADORNED_NETWORK_REFERENCE,
  MOCK_UTAH_NETWORK,
  MOCK_UTAH_NETWORK_DETAILS
} from '../mock-data.js'
import { MockUserEngine } from '../user/mock-user-engine.js'
import { NetworkCreateAuthorityBuilder } from './builders/network-create-authority-builder.js'
import { NetworkPinAuthorityBuilder } from './builders/network-pin-authority-builder.js'
import { NetworkUnpinAuthorityBuilder } from './builders/network-unpin-authority-builder.js'
import { NetworkProposeRevisionBuilder } from './builders/network-propose-revision-builder.js'
import { NetworkRespondToInviteBuilder } from './builders/network-respond-to-invite-builder.js'
import type {
  AdminInit,
  Authority,
  AuthorityInit,
  Cursor,
  ElectionInit,
  ElectionSummary,
  ElectionType,
  IAuthorityEngine,
  IElectionEngine,
  INetworkCreateAuthorityBuilder,
  INetworkEngine,
  INetworkPinAuthorityBuilder,
  INetworkProposeRevisionBuilder,
  INetworkRespondToInviteBuilder,
  INetworkUnpinAuthorityBuilder,
  InviteAction,
  IUserEngine,
  Network,
  NetworkDetails,
  NetworkReference,
  NetworkRevision,
  NetworkSummary,
  Proposal
} from '@votetorrent/vote-core'

export class MockNetworkEngine implements INetworkEngine {
  private readonly currentNetworkReference: NetworkReference
  private readonly mockNetworkDetails?: NetworkDetails
  private pinnedAuthorities: Authority[] = []

  constructor (init: NetworkReference) {
    const matchedNetwork = MOCK_NETWORKS.find((n) => n.hash === init.hash)

    if (matchedNetwork) {
      this.currentNetworkReference = matchedNetwork
      if (matchedNetwork.hash === MOCK_UTAH_ADORNED_NETWORK_REFERENCE.hash) {
        this.mockNetworkDetails = MOCK_UTAH_NETWORK_DETAILS
      } else {
        const basicNetwork: Network = {
          hash: matchedNetwork.hash,
          id: generateId('net'),
          primaryAuthorityId: generateId('auth'),
          name: matchedNetwork.name,
          relays: matchedNetwork.relays,
          policies: {
            numberRequiredTSAs: 0,
            timestampAuthorities: [],
            electionType: 'adhoc' as ElectionType
          }
        }
        const basicNetworkRevision: NetworkRevision = {
          name: matchedNetwork.name,
          relays: matchedNetwork.relays,
          policies: {
            numberRequiredTSAs: 0,
            timestampAuthorities: [],
            electionType: 'adhoc' as ElectionType
          }
        }
        const basicNetworkRevisionProposal: Proposal<NetworkRevision> = {
          proposed: basicNetworkRevision,
          timestamp: Date.now(),
          signers: []
        }
        this.mockNetworkDetails = {
          network: basicNetwork,
          proposed: basicNetworkRevisionProposal
        }
      }
    } else {
      this.currentNetworkReference = {
        hash: init.hash,
        imageUrl: init.imageUrl,
        relays: init.relays,
        name: 'Uncataloged Network',
        primaryAuthorityDomainName: 'unknown.network'
      }
      const basicNetwork: Network = {
        hash: this.currentNetworkReference.hash,
        id: generateId('net'),
        primaryAuthorityId: generateId('auth'),
        name: this.currentNetworkReference.name,
        relays: this.currentNetworkReference.relays,
        policies: {
          numberRequiredTSAs: 0,
          timestampAuthorities: [],
          electionType: 'adhoc' as ElectionType
        }
      }
      const basicNetworkRevision: NetworkRevision = {
        name: this.currentNetworkReference.name,
        relays: this.currentNetworkReference.relays,
        policies: {
          numberRequiredTSAs: 0,
          timestampAuthorities: [],
          electionType: 'adhoc' as ElectionType
        }
      }
      const basicNetworkRevisionProposal: Proposal<NetworkRevision> = {
        proposed: basicNetworkRevision,
        timestamp: Date.now(),
        signers: []
      }
      this.mockNetworkDetails = {
        network: basicNetwork,
        proposed: basicNetworkRevisionProposal
      }
      console.warn(
				`MockNetworkEngine: Initialized with hash '${init.hash}' not found in MOCK_NETWORKS. Providing minimal details.`
      )
    }

    this.pinnedAuthorities = MOCK_AUTHORITIES.slice(0, 3)
  }

  async createElection (election: ElectionInit): Promise<void> {
    throw new Error(
      'MockNetworkEngine: createElection is not implemented. Use MockElectionsEngine.'
    )
  }

  async createAuthority (authority: AuthorityInit, admin: AdminInit): Promise<void> {
    throw new Error('Method not implemented.')
  }

  async getAuthorityById (id: string): Promise<Authority | undefined> {
    throw new Error('Method not implemented.')
  }

  async respondToInvite<TInvokes>(
    invite: InviteAction<TInvokes>
  ): Promise<string> {
    throw new Error('Method not implemented.')
  }

  async getAuthoritiesByName (
    name: string | undefined
  ): Promise<Cursor<Authority>> {
    const filtered = name
      ? MOCK_AUTHORITIES.filter((a) =>
        a.name.toLowerCase().includes(name.toLowerCase())
			  )
      : MOCK_AUTHORITIES

    return {
      buffer: filtered,
      firstBOF: true,
      lastEOF: true,
      offset: 0
    }
  }

  async getCurrentUser (): Promise<IUserEngine | undefined> {
    return new MockUserEngine()
  }

  async getDetails (): Promise<NetworkDetails> {
    if (!this.mockNetworkDetails) {
      throw new Error('MockNetworkEngine: Network details are not available.')
    }
    return this.mockNetworkDetails
  }

  async getElectionHistory (): Promise<ElectionSummary[]> {
    throw new Error(
      'MockNetworkEngine: getElectionHistory is not implemented.'
    )
  }

  async getElections (): Promise<ElectionSummary[]> {
    throw new Error('MockNetworkEngine: getElections is not implemented.')
  }

  async getNetworkSummary (): Promise<NetworkSummary> {
    if (
      this.currentNetworkReference.hash ===
				MOCK_UTAH_ADORNED_NETWORK_REFERENCE.hash &&
			MOCK_UTAH_NETWORK
    ) {
      return {
        id: MOCK_UTAH_NETWORK.id,
        hash: this.currentNetworkReference.hash,
        name: this.currentNetworkReference.name,
        imageUrl: this.currentNetworkReference.imageUrl,
        primaryAuthorityDomainName:
					this.currentNetworkReference.primaryAuthorityDomainName
      }
    }
    return {
      id: generateId('netsum'),
      hash: this.currentNetworkReference.hash,
      name: this.currentNetworkReference.name,
      imageUrl: this.currentNetworkReference.imageUrl,
      primaryAuthorityDomainName:
				this.currentNetworkReference.primaryAuthorityDomainName
    }
  }

  async getPinnedAuthorities (): Promise<Authority[]> {
    return [...this.pinnedAuthorities]
  }

  async getProposedElections (): Promise<Array<Proposal<ElectionInit>>> {
    throw new Error(
      'MockNetworkEngine: getProposedElections is not implemented.'
    )
  }

  async getUser (userId: string): Promise<IUserEngine | undefined> {
    return new MockUserEngine()
  }

  async nextAuthoritiesByName (
    cursor: Cursor<Authority>,
    forward: boolean
  ): Promise<Cursor<Authority>> {
    return {
      buffer: MOCK_AUTHORITIES,
      firstBOF: true,
      lastEOF: true,
      offset: 0
    }
  }

  async openAuthority (authorityId: string): Promise<IAuthorityEngine> {
    const matchingAuthority = MOCK_AUTHORITIES.find(
      (a) => a.id === authorityId
    )
    if (!matchingAuthority) {
      throw new Error(
				`MockNetworkEngine: Authority ID '${authorityId}' not found.`
      )
    }
    return new MockAuthorityEngine(matchingAuthority)
  }

  async openElection (electionId: string): Promise<IElectionEngine> {
    throw new Error(
      'MockNetworkEngine: openElection is not implemented. Use MockElectionsEngine.'
    )
  }

  async pinAuthority (authority: Authority): Promise<void> {
    if (!this.pinnedAuthorities.find((a) => a.id === authority.id)) {
      this.pinnedAuthorities.push(authority)
    }
  }

  async proposeRevision (revision: NetworkRevision): Promise<void> {
    if (
      this.mockNetworkDetails &&
			this.currentNetworkReference.hash ===
				MOCK_UTAH_ADORNED_NETWORK_REFERENCE.hash
    ) {
      this.mockNetworkDetails.proposed = {
        proposed: revision,
        signers: []
        // timestamp: Date.now(),
      }
      console.log(
        'MockNetworkEngine: Revision proposed for Utah network.',
        revision
      )
    } else {
      console.warn(
        'MockNetworkEngine: Proposing revisions is only mocked for the Utah State Network.'
      )
      throw new Error(
        'Proposing revisions is only mocked for the Utah State Network in this engine.'
      )
    }
  }

  async respondToInvitation<TInvokes>(
    invitation: InviteAction<TInvokes>
  ): Promise<string> {
    console.log(
      'MockNetworkEngine: respondToInvitation called with:',
      invitation
    )
    return generateId('inv-resp')
  }

  async unpinAuthority (authorityId: string): Promise<void> {
    this.pinnedAuthorities = this.pinnedAuthorities.filter(
      (a) => a.id !== authorityId
    )
  }

  // ---- Builder factories (FACT-01 / FACT-04) ----

  buildCreateAuthority (): INetworkCreateAuthorityBuilder {
    return new NetworkCreateAuthorityBuilder(this)
  }

  buildPinAuthority (): INetworkPinAuthorityBuilder {
    return new NetworkPinAuthorityBuilder(this)
  }

  buildUnpinAuthority (): INetworkUnpinAuthorityBuilder {
    return new NetworkUnpinAuthorityBuilder(this)
  }

  buildProposeRevision (): INetworkProposeRevisionBuilder {
    return new NetworkProposeRevisionBuilder(this)
  }

  buildRespondToInvite<TInvokes> (): INetworkRespondToInviteBuilder<TInvokes> {
    return new NetworkRespondToInviteBuilder(this) as unknown as INetworkRespondToInviteBuilder<TInvokes>
  }
}
