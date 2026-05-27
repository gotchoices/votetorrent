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
import type { IBuilder } from '../common/builder.js'

export interface INetworkEngine {
  createAuthority(authority: AuthorityInit, admin: AdminInit, options?: { inviteSlotCid?: string; inviteSignature?: string }): Promise<void>
  getAuthoritiesByName(name: string | undefined): Promise<Cursor<Authority>>
  getCurrentUser(): Promise<IUserEngine | undefined>
  getDetails(): Promise<NetworkDetails>
  getNetworkSummary(): Promise<NetworkSummary>
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
  buildCreateAuthority(): INetworkCreateAuthorityBuilder
  buildPinAuthority(): INetworkPinAuthorityBuilder
  buildUnpinAuthority(): INetworkUnpinAuthorityBuilder
  buildProposeRevision(): INetworkProposeRevisionBuilder
  buildRespondToInvite<TInvokes>(): INetworkRespondToInviteBuilder<TInvokes>
}

export interface INetworkCreateAuthorityBuilder extends IBuilder<{ authority: AuthorityInit; admin: AdminInit }, void> {
  fromPayload(payload: { authority: AuthorityInit; admin: AdminInit }): this
}

export interface INetworkPinAuthorityBuilder extends IBuilder<Authority, void> {
  fromPayload(payload: Authority): this
}

export interface INetworkUnpinAuthorityBuilder extends IBuilder<string, void> {
  fromPayload(payload: string): this
}

export interface INetworkProposeRevisionBuilder extends IBuilder<NetworkRevision, void> {
  fromPayload(payload: NetworkRevision): this
}

export interface INetworkRespondToInviteBuilder<TInvokes> extends IBuilder<InviteAction<TInvokes>, string> {
  fromPayload(payload: InviteAction<TInvokes>): this
}
