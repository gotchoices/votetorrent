import { expect } from 'aegir/chai';
import type {
	IAuthorityManager,
	IUserAccess,
	INetworkInformation,
	INetworkOperations,
	INetworkEngine,
} from '../src/network/types-refactored.js';
import type { SID } from '../src/common/types.js';
import type {
	Authority,
	Cursor,
	NetworkDetails,
	NetworkSummary,
	NetworkInfrastructure,
} from '../src/index.js';
import type { IAuthorityEngine } from '../src/authority/types.js';
import type { IUserEngine } from '../src/user/types.js';

/**
 * Test: Interface Segregation Principle for Network Engines
 *
 * This test suite demonstrates the benefits of splitting the fat INetworkEngine
 * interface into smaller, cohesive interfaces. Each test shows how specific
 * clients can depend only on the methods they need.
 */

describe('Network Interface Segregation', () => {
	describe('Interface Composition', () => {
		it('should allow INetworkEngine to extend all segregated interfaces', () => {
			// This test verifies type compatibility - it compiles if correct
			const mockEngine: INetworkEngine = {
				// IAuthorityManager methods
				getAuthoritiesByName: async () => ({} as Cursor<Authority>),
				nextAuthoritiesByName: async () => ({} as Cursor<Authority>),
				getPinnedAuthorities: async () => [],
				pinAuthority: async () => {},
				unpinAuthority: async () => {},
				openAuthority: async () => ({} as IAuthorityEngine),

				// IUserAccess methods
				getCurrentUser: async () => undefined,
				getUser: async () => undefined,

				// INetworkInformation methods
				getDetails: async () => ({} as NetworkDetails),
				getNetworkSummary: async () => ({} as NetworkSummary),
				getInfrastructure: async () => ({} as NetworkInfrastructure),
				getHostingProviders: async function* () {},

				// INetworkOperations methods
				proposeRevision: async () => {},
				respondToInvitation: async () => '' as SID,
			};

			// Verify it implements all interfaces
			const asAuthorityManager: IAuthorityManager = mockEngine;
			const asUserAccess: IUserAccess = mockEngine;
			const asNetworkInfo: INetworkInformation = mockEngine;
			const asNetworkOps: INetworkOperations = mockEngine;

			expect(asAuthorityManager).to.exist;
			expect(asUserAccess).to.exist;
			expect(asNetworkInfo).to.exist;
			expect(asNetworkOps).to.exist;
		});
	});

	describe('IAuthorityManager - Authority Management', () => {
		it('should define authority search methods', () => {
			const manager: IAuthorityManager = {
				getAuthoritiesByName: async () => ({} as Cursor<Authority>),
				nextAuthoritiesByName: async () => ({} as Cursor<Authority>),
				getPinnedAuthorities: async () => [],
				pinAuthority: async () => {},
				unpinAuthority: async () => {},
				openAuthority: async () => ({} as IAuthorityEngine),
			};

			expect(manager.getAuthoritiesByName).to.be.a('function');
			expect(manager.nextAuthoritiesByName).to.be.a('function');
			expect(manager.getPinnedAuthorities).to.be.a('function');
		});

		it('should define authority pinning methods', () => {
			const manager: IAuthorityManager = {
				getAuthoritiesByName: async () => ({} as Cursor<Authority>),
				nextAuthoritiesByName: async () => ({} as Cursor<Authority>),
				getPinnedAuthorities: async () => [],
				pinAuthority: async () => {},
				unpinAuthority: async () => {},
				openAuthority: async () => ({} as IAuthorityEngine),
			};

			expect(manager.pinAuthority).to.be.a('function');
			expect(manager.unpinAuthority).to.be.a('function');
		});

		it('should define authority opening method', () => {
			const manager: IAuthorityManager = {
				getAuthoritiesByName: async () => ({} as Cursor<Authority>),
				nextAuthoritiesByName: async () => ({} as Cursor<Authority>),
				getPinnedAuthorities: async () => [],
				pinAuthority: async () => {},
				unpinAuthority: async () => {},
				openAuthority: async () => ({} as IAuthorityEngine),
			};

			expect(manager.openAuthority).to.be.a('function');
		});
	});

	describe('IUserAccess - User Access', () => {
		it('should define user access methods', () => {
			const userAccess: IUserAccess = {
				getCurrentUser: async () => undefined,
				getUser: async () => undefined,
			};

			expect(userAccess.getCurrentUser).to.be.a('function');
			expect(userAccess.getUser).to.be.a('function');
		});

		it('should be implementable independently', () => {
			// A client that only needs user access doesn't need to implement
			// authority management, network info, or operations
			const minimalUserAccess: IUserAccess = {
				getCurrentUser: async () => ({} as IUserEngine),
				getUser: async (sid: SID) => ({} as IUserEngine),
			};

			expect(minimalUserAccess).to.exist;
			expect(minimalUserAccess.getCurrentUser).to.be.a('function');
		});
	});

	describe('INetworkInformation - Network Information', () => {
		it('should define read-only network info methods', () => {
			const networkInfo: INetworkInformation = {
				getDetails: async () => ({} as NetworkDetails),
				getNetworkSummary: async () => ({} as NetworkSummary),
				getInfrastructure: async () => ({} as NetworkInfrastructure),
				getHostingProviders: async function* () {},
			};

			expect(networkInfo.getDetails).to.be.a('function');
			expect(networkInfo.getNetworkSummary).to.be.a('function');
			expect(networkInfo.getInfrastructure).to.be.a('function');
			expect(networkInfo.getHostingProviders).to.be.a('function');
		});

		it('should support async iteration for hosting providers', async () => {
			const networkInfo: INetworkInformation = {
				getDetails: async () => ({} as NetworkDetails),
				getNetworkSummary: async () => ({} as NetworkSummary),
				getInfrastructure: async () => ({} as NetworkInfrastructure),
				async *getHostingProviders() {
					yield { name: 'Provider1', url: 'http://provider1.com' } as any;
					yield { name: 'Provider2', url: 'http://provider2.com' } as any;
				},
			};

			const providers = [];
			for await (const provider of networkInfo.getHostingProviders()) {
				providers.push(provider);
			}

			expect(providers).to.have.length(2);
		});
	});

	describe('INetworkOperations - Network Operations', () => {
		it('should define write operation methods', () => {
			const operations: INetworkOperations = {
				proposeRevision: async () => {},
				respondToInvitation: async () => '' as SID,
			};

			expect(operations.proposeRevision).to.be.a('function');
			expect(operations.respondToInvitation).to.be.a('function');
		});

		it('should be implementable independently', () => {
			// A client that only needs to respond to invitations doesn't need
			// to implement authority management, user access, or network info
			const minimalOps: INetworkOperations = {
				proposeRevision: async () => {
					throw new Error('Not implemented');
				},
				respondToInvitation: async () => 'response-sid' as SID,
			};

			expect(minimalOps).to.exist;
			expect(minimalOps.respondToInvitation).to.be.a('function');
		});
	});

	describe('Interface Segregation Benefits', () => {
		it('should allow mocking only needed interfaces', () => {
			// Example: A component that only displays network info
			// can mock just INetworkInformation instead of entire INetworkEngine
			const mockNetworkInfo: INetworkInformation = {
				getDetails: async () => ({} as NetworkDetails),
				getNetworkSummary: async () => ({} as NetworkSummary),
				getInfrastructure: async () => ({} as NetworkInfrastructure),
				async *getHostingProviders() {},
			};

			expect(mockNetworkInfo).to.exist;
			// No need to implement 10+ other methods!
		});

		it('should support composition for different use cases', () => {
			// A read-only client can implement only read interfaces
			class ReadOnlyNetworkClient
				implements INetworkInformation, IUserAccess, IAuthorityManager
			{
				async getDetails() {
					return {} as NetworkDetails;
				}
				async getNetworkSummary() {
					return {} as NetworkSummary;
				}
				async getInfrastructure() {
					return {} as NetworkInfrastructure;
				}
				async *getHostingProviders() {}
				async getCurrentUser() {
					return {} as IUserEngine;
				}
				async getUser() {
					return {} as IUserEngine;
				}
				async getAuthoritiesByName() {
					return {} as Cursor<Authority>;
				}
				async nextAuthoritiesByName() {
					return {} as Cursor<Authority>;
				}
				async getPinnedAuthorities() {
					return [];
				}
				async pinAuthority() {}
				async unpinAuthority() {}
				async openAuthority() {
					return {} as IAuthorityEngine;
				}
			}

			const client = new ReadOnlyNetworkClient();
			expect(client).to.exist;
			// This client doesn't implement INetworkOperations (write methods)
		});

		it('should enable clear dependency declarations', async () => {
			// A function that only needs to search authorities
			// can declare dependency on IAuthorityManager, not entire engine
			async function searchAuthorities(
				manager: IAuthorityManager,
				name: string
			): Promise<Cursor<Authority>> {
				return await manager.getAuthoritiesByName(name);
			}

			const mockManager: IAuthorityManager = {
				getAuthoritiesByName: async (name) => ({} as Cursor<Authority>),
				nextAuthoritiesByName: async () => ({} as Cursor<Authority>),
				getPinnedAuthorities: async () => [],
				pinAuthority: async () => {},
				unpinAuthority: async () => {},
				openAuthority: async () => ({} as IAuthorityEngine),
			};

			// Clear what this function depends on
			const result = await searchAuthorities(mockManager, 'test');
			expect(result).to.exist;
		});

		it('should support flexible implementation strategies', () => {
			// Different implementations can be swapped for different interfaces
			class CachedNetworkInfo implements INetworkInformation {
				private cache = new Map<string, any>();

				async getDetails() {
					if (!this.cache.has('details')) {
						this.cache.set('details', {} as NetworkDetails);
					}
					return this.cache.get('details');
				}

				async getNetworkSummary() {
					return {} as NetworkSummary;
				}

				async getInfrastructure() {
					return {} as NetworkInfrastructure;
				}

				async *getHostingProviders() {}
			}

			class DirectNetworkOps implements INetworkOperations {
				async proposeRevision() {
					// Direct network call
				}

				async respondToInvitation() {
					// Direct network call
					return '' as SID;
				}
			}

			// Mix and match implementations
			const cachedInfo = new CachedNetworkInfo();
			const directOps = new DirectNetworkOps();

			expect(cachedInfo).to.exist;
			expect(directOps).to.exist;
		});
	});

	describe('Migration Path', () => {
		it('should support gradual migration from INetworkEngine', () => {
			// Old code using INetworkEngine
			function oldFunction(engine: INetworkEngine) {
				return engine.getDetails();
			}

			// New code using specific interfaces
			function newFunction(info: INetworkInformation) {
				return info.getDetails();
			}

			const fullEngine: INetworkEngine = {
				getAuthoritiesByName: async () => ({} as Cursor<Authority>),
				nextAuthoritiesByName: async () => ({} as Cursor<Authority>),
				getPinnedAuthorities: async () => [],
				pinAuthority: async () => {},
				unpinAuthority: async () => {},
				openAuthority: async () => ({} as IAuthorityEngine),
				getCurrentUser: async () => undefined,
				getUser: async () => undefined,
				getDetails: async () => ({} as NetworkDetails),
				getNetworkSummary: async () => ({} as NetworkSummary),
				getInfrastructure: async () => ({} as NetworkInfrastructure),
				getHostingProviders: async function* () {},
				proposeRevision: async () => {},
				respondToInvitation: async () => '' as SID,
			};

			// Both work with the same engine
			expect(oldFunction(fullEngine)).to.eventually.exist;
			expect(newFunction(fullEngine)).to.eventually.exist;
		});
	});
});
