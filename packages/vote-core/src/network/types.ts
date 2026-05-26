import type { IAuthorityEngine } from '../authority/types.js'
import type {
  Authority,
  Cursor,
  NetworkSummary,
  NetworkDetails,
  NetworkRevision,
  AuthorityInit,
  AdminInit,
  Proposal,
  ElectionInit
} from '../index.js'
import type { InviteAction } from '../invite/models.js'
import type { IUserEngine } from '../user/types.js'

export interface INetworkEngine {
  createAuthority(authority: AuthorityInit, admin: AdminInit): Promise<void>
  getAuthoritiesByName(name: string | undefined): Promise<Cursor<Authority>>
  getCurrentUser(): Promise<IUserEngine | undefined>
  getDetails(): Promise<NetworkDetails>
  getNetworkSummary(): Promise<NetworkSummary>
  /**
   * Returns network-wide statistics (D-15 / NETUI-05). Mock implementations
   * return static values; real engines compute from live network telemetry.
   */
  getStatistics(): Promise<{ estimatedNodes: number; serverCount: number }>
  getPinnedAuthorities(): Promise<Authority[]>
  getProposedElections(): Promise<Array<Proposal<ElectionInit>>>
  getUser(userId: string): Promise<IUserEngine | undefined>
  nextAuthoritiesByName(
    cursor: Cursor<Authority>,
    forward: boolean
  ): Promise<Cursor<Authority>>
  openAuthority(
    authorityId: string,
    authority?: Authority
  ): Promise<IAuthorityEngine>
  pinAuthority(authority: Authority): Promise<void>
  proposeRevision(revision: NetworkRevision): Promise<void>
  respondToInvite<TInvokes>(
    invite: InviteAction<TInvokes>
  ): Promise<string>
  unpinAuthority(authorityId: string): Promise<void>
}
