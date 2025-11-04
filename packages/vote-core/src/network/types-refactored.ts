/**
 * Refactored Network Engine Interfaces
 *
 * This module applies the Interface Segregation Principle (ISP) to break down
 * the monolithic INetworkEngine interface into smaller, cohesive interfaces.
 * Each interface represents a distinct responsibility or client use case.
 *
 * Benefits:
 * - Clients depend only on methods they actually use
 * - Easier to mock specific functionality in tests
 * - Clear separation of concerns
 * - More flexible composition and implementation
 * - Better adherence to SOLID principles
 *
 * Migration Strategy:
 * 1. INetworkEngine extends all split interfaces (backward compatibility)
 * 2. New code uses specific interfaces (IAuthorityManager, etc.)
 * 3. Gradually migrate existing code to use specific interfaces
 * 4. Eventually deprecate the composite INetworkEngine interface
 */

import type { IAuthorityEngine } from '../authority/types.js';
import type { SID } from '../common/index.js';
import type {
	Authority,
	Cursor,
	NetworkSummary,
	NetworkDetails,
	NetworkInfrastructure,
	HostingProvider,
	NetworkRevisionInit,
} from '../index.js';
import type { InvitationAction } from '../invitation/models.js';
import type { IUserEngine } from '../user/types.js';

/**
 * Authority Management Interface
 *
 * Handles discovery, navigation, and management of authorities within the network.
 * Use this interface when you need to:
 * - Search and browse authorities
 * - Pin/unpin authorities for quick access
 * - Open authority engines for interaction
 */
export interface IAuthorityManager {
	/**
	 * Search authorities by name
	 * @param name - Authority name to search for (undefined returns all)
	 * @returns Cursor for paginating through results
	 */
	getAuthoritiesByName(name: string | undefined): Promise<Cursor<Authority>>;

	/**
	 * Navigate to next/previous page of authorities
	 * @param cursor - Current cursor position
	 * @param forward - True for next page, false for previous
	 * @returns New cursor with next/previous results
	 */
	nextAuthoritiesByName(
		cursor: Cursor<Authority>,
		forward: boolean
	): Promise<Cursor<Authority>>;

	/**
	 * Get list of pinned authorities
	 * @returns Array of pinned authorities
	 */
	getPinnedAuthorities(): Promise<Authority[]>;

	/**
	 * Pin an authority for quick access
	 * @param authority - Authority to pin
	 */
	pinAuthority(authority: Authority): Promise<void>;

	/**
	 * Unpin a previously pinned authority
	 * @param authoritySid - SID of authority to unpin
	 */
	unpinAuthority(authoritySid: SID): Promise<void>;

	/**
	 * Open an authority engine for interaction
	 * @param authoritySid - SID of authority to open
	 * @returns Authority engine instance
	 */
	openAuthority(authoritySid: SID): Promise<IAuthorityEngine>;
}

/**
 * User Access Interface
 *
 * Provides access to user engines within the network.
 * Use this interface when you need to:
 * - Get the current authenticated user
 * - Access other users in the network
 */
export interface IUserAccess {
	/**
	 * Get the current authenticated user's engine
	 * @returns Current user engine or undefined if not authenticated
	 */
	getCurrentUser(): Promise<IUserEngine | undefined>;

	/**
	 * Get a user engine by SID
	 * @param userSid - SID of user to retrieve
	 * @returns User engine or undefined if not found
	 */
	getUser(userSid: SID): Promise<IUserEngine | undefined>;
}

/**
 * Network Information Interface
 *
 * Provides read-only access to network metadata and configuration.
 * Use this interface when you need to:
 * - Display network details to users
 * - Get network infrastructure information
 * - List available hosting providers
 */
export interface INetworkInformation {
	/**
	 * Get detailed network information
	 * @returns Network details including name, description, etc.
	 */
	getDetails(): Promise<NetworkDetails>;

	/**
	 * Get summary statistics about the network
	 * @returns Network summary with counts, activity, etc.
	 */
	getNetworkSummary(): Promise<NetworkSummary>;

	/**
	 * Get network infrastructure details
	 * @returns Infrastructure configuration
	 */
	getInfrastructure(): Promise<NetworkInfrastructure>;

	/**
	 * Get available hosting providers
	 * @returns Async iterable of hosting providers
	 */
	getHostingProviders(): AsyncIterable<HostingProvider>;
}

/**
 * Network Operations Interface
 *
 * Handles write operations that modify network state.
 * Use this interface when you need to:
 * - Propose changes to network configuration
 * - Respond to invitations
 * - Perform administrative actions
 */
export interface INetworkOperations {
	/**
	 * Propose a revision to network configuration
	 * @param revision - Proposed network revision
	 */
	proposeRevision(revision: NetworkRevisionInit): Promise<void>;

	/**
	 * Respond to an invitation action
	 * @param invitation - Invitation to respond to
	 * @returns SID of the response
	 */
	respondToInvitation<TInvokes, TSlot>(
		invitation: InvitationAction<TInvokes, TSlot>
	): Promise<SID>;
}

/**
 * Composite Network Engine Interface (Backward Compatibility)
 *
 * This interface maintains backward compatibility by extending all
 * the segregated interfaces. Existing code can continue using this,
 * while new code should use the specific interfaces.
 *
 * @deprecated Use specific interfaces (IAuthorityManager, IUserAccess, etc.)
 * instead for better separation of concerns.
 */
export interface INetworkEngine
	extends IAuthorityManager,
		IUserAccess,
		INetworkInformation,
		INetworkOperations {}

/**
 * Helper type to check if an object implements a specific interface
 */
export type ImplementsInterface<T, I> = T extends I ? true : false;

/**
 * Network Engine Configuration
 *
 * Configuration options for creating network engine instances.
 * Can be used with dependency injection to configure different
 * implementations.
 */
export interface INetworkEngineConfig {
	/** Network SID */
	networkSid: SID;
	/** Enable caching for network information */
	enableCaching?: boolean;
	/** Cache TTL in milliseconds */
	cacheTtl?: number;
}

/**
 * Network Engine Factory Interface
 *
 * Factory for creating network engine instances with proper
 * dependency injection.
 */
export interface INetworkEngineFactory {
	/**
	 * Create a network engine instance
	 * @param config - Network engine configuration
	 * @returns Network engine instance
	 */
	createNetworkEngine(config: INetworkEngineConfig): Promise<INetworkEngine>;

	/**
	 * Create specific interface implementations
	 */
	createAuthorityManager(networkSid: SID): Promise<IAuthorityManager>;
	createUserAccess(networkSid: SID): Promise<IUserAccess>;
	createNetworkInformation(networkSid: SID): Promise<INetworkInformation>;
	createNetworkOperations(networkSid: SID): Promise<INetworkOperations>;
}
