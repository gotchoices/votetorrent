import type {
	Authority,
	Cursor,
	HostingProvider,
	IAuthorityEngine,
	INetworkEngine,
	IUserEngine,
	LocalStorage as ILocalStorage,
	NetworkDetails,
	NetworkInfrastructure,
	NetworkReference,
	NetworkSummary,
	InvitationAction,
	SID,
	Proposal,
	NetworkInit,
	Network,
} from '@votetorrent/vote-core';
import type {
	ElectionInit,
	ElectionSummary,
} from '@votetorrent/vote-core/dist/src/election/models';
import type { IElectionEngine } from '@votetorrent/vote-core/dist/src/election/types';
import { EngineContext } from '../types';

export class NetworkEngine implements INetworkEngine {
	constructor(
		public readonly init: NetworkReference,
		private readonly localStorage: ILocalStorage,
		private readonly ctx: EngineContext
	) {}

	createElection(election: ElectionInit): Promise<void> {
		throw new Error('Not implemented');
	}

	/** Returns all authorities that match the name */
	async getAuthoritiesByName(
		name: string | undefined
	): Promise<Cursor<Authority>> {
		throw new Error('Not implemented');
	}

	getCurrentUser(): Promise<IUserEngine | undefined> {
		throw new Error('Not implemented');
	}

	getDetails(): Promise<NetworkDetails> {
		throw new Error('Not implemented');
	}

	getElectionHistory(): Promise<ElectionSummary[]> {
		throw new Error('Not implemented');
	}

	getElections(): Promise<ElectionSummary[]> {
		throw new Error('Not implemented');
	}

	getHostingProviders(): AsyncIterable<HostingProvider> {
		throw new Error('Not implemented');
	}

	getInfrastructure(): Promise<NetworkInfrastructure> {
		throw new Error('Not implemented');
	}

	async getNetworkSummary(): Promise<NetworkSummary> {
		try {
			const network = await this.ctx.db.prepare(`select 1 from Network`).get()[
				'result'
			];
			const primaryAuthority = await this.ctx.db
				.prepare(`select 1 from Authority where Sid = :sid`)
				.get([network.primaryAuthoritySid])['result'];
			return {
				sid: network.sid,
				hash: network.hash,
				name: network.name,
				imageUrl: network.imageRef?.url,
				primaryAuthorityDomainName: primaryAuthority.domainName,
			};
		} catch (error) {
			throw new Error('Network not found');
		}
	}

	async getPinnedAuthorities(): Promise<Authority[]> {
		return (
			(await this.localStorage.getItem<Authority[]>('pinnedAuthorities')) ?? []
		);
	}

	getProposedElections(): Promise<Proposal<ElectionInit>[]> {
		throw new Error('Not implemented');
	}

	getUser(userSid: SID): Promise<IUserEngine | undefined> {
		throw new Error('Not implemented');
	}

	async nextAuthoritiesByName(
		cursor: Cursor<Authority>,
		forward: boolean
	): Promise<Cursor<Authority>> {
		throw new Error('Not implemented');
	}

	openAuthority(authoritySid: SID): Promise<IAuthorityEngine> {
		throw new Error('Not implemented');
	}

	openElection(electionSid: SID): Promise<IElectionEngine> {
		throw new Error('Not implemented');
	}

	async pinAuthority(authority: Authority): Promise<void> {
		const pinnedAuthorities = await this.getPinnedAuthorities();
		const unique = Object.fromEntries(
			pinnedAuthorities.map((authority) => [authority.sid, authority])
		);
		const appended = { ...unique, [authority.sid]: authority };
		await this.localStorage.setItem(
			'pinnedAuthorities',
			Object.values(appended)
		);
	}

	proposeRevision(revision: NetworkInit): Promise<void> {
		throw new Error('Not implemented');
	}

	async respondToInvitation<TInvokes, TSlot>(
		invitation: InvitationAction<TInvokes, TSlot>
	): Promise<SID> {
		throw new Error('Not implemented');
	}

	async unpinAuthority(authoritySid: SID): Promise<void> {
		const pinnedAuthorities = await this.getPinnedAuthorities();
		const filtered = pinnedAuthorities.filter(
			(authority) => authority.sid !== authoritySid
		);
		await this.localStorage.setItem('pinnedAuthorities', filtered);
	}
}
