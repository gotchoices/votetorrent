import type {
	AdornedNetworkReference,
	Authority,
	Cursor,
	HostingProvider,
	IAuthorityEngine,
	INetworkEngine,
	InvitationAction,
	IUserEngine,
	Network,
	NetworkDetails,
	NetworkInfrastructure,
	NetworkReference,
	NetworkRevision,
	NetworkRevisionInit,
	NetworkSummary,
	Proposal,
	SID,
	ElectionType,
} from '@votetorrent/vote-core';
import {
	MOCK_AUTHORITIES,
	MOCK_HOSTING_PROVIDERS,
	MOCK_NETWORKS,
	MOCK_UTAH_NETWORK_DETAILS,
	MOCK_UTAH_ADORNED_NETWORK_REFERENCE,
	MOCK_UTAH_NETWORK,
	generateSid,
} from '../mock-data';
import { MockAuthorityEngine } from '../authority/mock-authority-engine';
import { MockUserEngine } from '../user/mock-user-engine';
import type {
	ElectionInit,
	ElectionSummary,
} from '@votetorrent/vote-core/dist/src/election/models';
import type { IElectionEngine } from '@votetorrent/vote-core/dist/src/election/types';

export class MockNetworkEngine implements INetworkEngine {
	private currentNetworkReference: AdornedNetworkReference;
	private mockNetworkDetails?: NetworkDetails;
	private pinnedAuthorities: Authority[] = [];

	constructor(init: NetworkReference) {
		const matchedNetwork = MOCK_NETWORKS.find((n) => n.hash === init.hash);

		if (matchedNetwork) {
			this.currentNetworkReference = matchedNetwork;
			if (matchedNetwork.hash === MOCK_UTAH_ADORNED_NETWORK_REFERENCE.hash) {
				this.mockNetworkDetails = MOCK_UTAH_NETWORK_DETAILS;
			} else {
				const basicNetwork: Network = {
					hash: matchedNetwork.hash,
					sid: generateSid('net'),
					signature: {
						signature: 'mock-signature-1',
						signerKey: 'mock-signer-key-1',
					},
				};
				const basicRevision: NetworkRevision = {
					networkSid: basicNetwork.sid,
					revision: 1,
					timestamp: Date.now(),
					name: matchedNetwork.name,
					imageRef: { url: matchedNetwork.imageUrl },
					relays: matchedNetwork.relays,
					policies: {
						numberRequiredTSAs: 0,
						timestampAuthorities: [],
						electionType: 'adhoc' as ElectionType,
					},
					signature: {
						signature: 'mock-signature-1',
						signerKey: 'mock-signer-key-1',
					},
				};
				this.mockNetworkDetails = {
					network: basicNetwork,
					current: basicRevision,
				};
			}
		} else {
			this.currentNetworkReference = {
				hash: init.hash,
				imageUrl: init.imageUrl,
				relays: init.relays,
				name: 'Uncataloged Network',
				primaryAuthorityDomainName: 'unknown.network',
			};
			const basicNetwork: Network = {
				hash: this.currentNetworkReference.hash,
				sid: generateSid('net'),
				signature: {
					signature: 'mock-signature-1',
					signerKey: 'mock-signer-key-1',
				},
			};
			const basicRevision: NetworkRevision = {
				networkSid: basicNetwork.sid,
				revision: 1,
				timestamp: Date.now(),
				name: this.currentNetworkReference.name,
				imageRef: { url: this.currentNetworkReference.imageUrl },
				relays: this.currentNetworkReference.relays,
				policies: {
					numberRequiredTSAs: 0,
					timestampAuthorities: [],
					electionType: 'adhoc' as ElectionType,
				},
				signature: {
					signature: 'mock-signature-1',
					signerKey: 'mock-signer-key-1',
				},
			};
			this.mockNetworkDetails = {
				network: basicNetwork,
				current: basicRevision,
			};
			console.warn(
				`MockNetworkEngine: Initialized with hash '${init.hash}' not found in MOCK_NETWORKS. Providing minimal details.`
			);
		}

		this.pinnedAuthorities = MOCK_AUTHORITIES.slice(0, 3);
	}

	createElection(election: ElectionInit): Promise<void> {
		throw new Error(
			'MockNetworkEngine: createElection is not implemented. Use MockElectionsEngine.'
		);
	}

	async getAuthoritiesByName(
		name: string | undefined
	): Promise<Cursor<Authority>> {
		const filtered = name
			? MOCK_AUTHORITIES.filter((a) =>
					a.name.toLowerCase().includes(name.toLowerCase())
			  )
			: MOCK_AUTHORITIES;

		return {
			buffer: filtered,
			firstBOF: true,
			lastEOF: true,
			offset: 0,
		};
	}

	async getCurrentUser(): Promise<IUserEngine | undefined> {
		return new MockUserEngine();
	}

	async getDetails(): Promise<NetworkDetails> {
		if (!this.mockNetworkDetails) {
			throw new Error('MockNetworkEngine: Network details are not available.');
		}
		return this.mockNetworkDetails;
	}

	async getElectionHistory(): Promise<ElectionSummary[]> {
		throw new Error(
			'MockNetworkEngine: getElectionHistory is not implemented.'
		);
	}

	async getElections(): Promise<ElectionSummary[]> {
		throw new Error('MockNetworkEngine: getElections is not implemented.');
	}

	async *getHostingProviders(): AsyncIterable<HostingProvider> {
		for (const provider of MOCK_HOSTING_PROVIDERS) {
			yield provider;
		}
	}

	async getInfrastructure(): Promise<NetworkInfrastructure> {
		return {
			configuration: this.currentNetworkReference,
			estimatedNodes: 100,
			estimatedServers: 10,
		};
	}

	async getNetworkSummary(): Promise<NetworkSummary> {
		if (
			this.currentNetworkReference.hash ===
				MOCK_UTAH_ADORNED_NETWORK_REFERENCE.hash &&
			MOCK_UTAH_NETWORK
		) {
			return {
				sid: MOCK_UTAH_NETWORK.sid,
				hash: this.currentNetworkReference.hash,
				name: this.currentNetworkReference.name,
				imageUrl: this.currentNetworkReference.imageUrl,
				primaryAuthorityDomainName:
					this.currentNetworkReference.primaryAuthorityDomainName,
			};
		}
		return {
			sid: generateSid('netsum'),
			hash: this.currentNetworkReference.hash,
			name: this.currentNetworkReference.name,
			imageUrl: this.currentNetworkReference.imageUrl,
			primaryAuthorityDomainName:
				this.currentNetworkReference.primaryAuthorityDomainName,
		};
	}

	async getPinnedAuthorities(): Promise<Authority[]> {
		return [...this.pinnedAuthorities];
	}

	async getProposedElections(): Promise<Proposal<ElectionInit>[]> {
		throw new Error(
			'MockNetworkEngine: getProposedElections is not implemented.'
		);
	}

	async getUser(userSid: SID): Promise<IUserEngine | undefined> {
		return new MockUserEngine();
	}

	async nextAuthoritiesByName(
		cursor: Cursor<Authority>,
		forward: boolean
	): Promise<Cursor<Authority>> {
		return {
			buffer: MOCK_AUTHORITIES,
			firstBOF: true,
			lastEOF: true,
			offset: 0,
		};
	}

	async openAuthority(authoritySid: SID): Promise<IAuthorityEngine> {
		const matchingAuthority = MOCK_AUTHORITIES.find(
			(a) => a.sid === authoritySid
		);
		if (!matchingAuthority) {
			throw new Error(
				`MockNetworkEngine: Authority SID '${authoritySid}' not found.`
			);
		}
		return new MockAuthorityEngine(matchingAuthority);
	}

	async openElection(electionSid: SID): Promise<IElectionEngine> {
		throw new Error(
			'MockNetworkEngine: openElection is not implemented. Use MockElectionsEngine.'
		);
	}

	async pinAuthority(authority: Authority): Promise<void> {
		if (!this.pinnedAuthorities.find((a) => a.sid === authority.sid)) {
			this.pinnedAuthorities.push(authority);
		}
	}

	async proposeRevision(revision: NetworkRevisionInit): Promise<void> {
		if (
			this.mockNetworkDetails &&
			this.currentNetworkReference.hash ===
				MOCK_UTAH_ADORNED_NETWORK_REFERENCE.hash
		) {
			this.mockNetworkDetails.proposed = {
				proposed: revision,
				signatures: [],
				timestamp: Date.now(),
			};
			console.log(
				'MockNetworkEngine: Revision proposed for Utah network.',
				revision
			);
		} else {
			console.warn(
				'MockNetworkEngine: Proposing revisions is only mocked for the Utah State Network.'
			);
			throw new Error(
				'Proposing revisions is only mocked for the Utah State Network in this engine.'
			);
		}
	}

	async respondToInvitation<TInvokes, TSlot>(
		invitation: InvitationAction<TInvokes, TSlot>
	): Promise<SID> {
		console.log(
			'MockNetworkEngine: respondToInvitation called with:',
			invitation
		);
		return generateSid('inv-resp') as SID;
	}

	async unpinAuthority(authoritySid: SID): Promise<void> {
		this.pinnedAuthorities = this.pinnedAuthorities.filter(
			(a) => a.sid !== authoritySid
		);
	}
}
