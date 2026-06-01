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

/**
 * Payload shape for authority invites (`InviteAction.invokes` when
 * `invite.type === 'au'`).
 *
 * D-01 (Phase 12.4): sibling fields under `invokes` carry the admin +
 * officers data required by Admin.MutationValid / Officer.InsertValid /
 * Authority.InsertValid to recompute the 7-arg Digest committed to
 * `InviteResult.Digest` at `respondToInvite` time.
 *
 * The `InviteAction<TInvokes>` generic itself stays unconstrained so
 * non-authority invite types (`'of'`, `'kh'`, `'rg'`, `'u'`) remain
 * compatible. The engine casts `invite.invokes as AuthorityInviteInvokes`
 * at runtime inside the `isAuthorityInvite && invite.isAccepted` branch.
 *
 * Pitfall 5 mitigation: engine defensively throws when `admin == null`
 * or `officers.length === 0` for an authority invite — silently committing
 * a wrong-shape Digest would land an invite that no downstream
 * createAuthority insert can satisfy.
 */
export interface AuthorityInviteInvokes {
  authority: {
    name: string
    domainName: string | null
    /**
     * WR-04 (12.4-REVIEW): renamed from `imageRef` to `imageUrl` and typed
     * as `string` to match `AuthorityInit.imageUrl` consumed by
     * `createAuthority`. Both sites now serialize the same scalar string
     * the same way (`JSON.stringify(url)` → quoted-JSON), so the
     * cryptographic Digest binding stays consistent across respondToInvite
     * and createAuthority. Object-shaped image references (a future v1.2
     * extension to a richer ImageRef-style shape with `{ url, cid }`)
     * must be added at both sites simultaneously.
     */
    imageUrl?: string | null
  }
  admin: {
    /** Canonical ISO 8601 datetime — single source of truth shared with downstream createAuthority */
    effectiveAt: string
    /** JSON-stringified array of `{ policy: string; threshold: number }` */
    thresholdPolicies: string
  }
  /**
   * Officers named on the invite. D-09: engine sorts by `userId` ASC and binds
   * only the first officer's columns into `InviteResult.Digest`. Officers 2..N
   * are present in the payload (and will be inserted into the Officer table
   * by createAuthority) but are not hash-bound to the invite — a documented
   * v1.2 follow-up gap.
   */
  officers: Array<{
    adminEffectiveAt: string
    userId: string
    title: string
    /** JSON-stringified array of scope codes */
    scopes: string
  }>
}

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
