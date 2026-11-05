import { QuereusError, MisuseError } from '@quereus/quereus'
import type { SqlValue } from '@quereus/quereus'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { FeatureNotAvailableError, toImageRef } from '@votetorrent/vote-core'
import { AuthorityEngine } from '../authority/authority-engine.js'
import { readInviteChain } from '../invite/read-invite-chain.js'
import { withInviteWriteSerial } from '../invite/invite-write-serial.js'
import { UserEngine } from '../user/user-engine.js'
import {
  asText,
  fromCanonicalDatetime,
  inviteResultSignedBytes,
  nowCanonicalDatetime,
  parseJsonOr,
  toCanonicalDatetime,
  verifyAdHocInviteSignature,
} from '../utils.js'
import type { EngineContext } from '../types.js'
import type {
  Authority,
  Cursor,
  IAuthorityEngine,
  ImageRef,
  INetworkCreateAuthorityBuilder,
  INetworkEngine,
  INetworkPinAuthorityBuilder,
  INetworkProposeRevisionBuilder,
  INetworkRespondToInviteBuilder,
  INetworkUnpinAuthorityBuilder,
  IUserEngine,
  LocalStorage as ILocalStorage,
  Network,
  NetworkDetails,
  NetworkReference,
  NetworkSummary,
  Proposal,
  NetworkRevision,
  ElectionEvent,
  ElectionInit,
  ElectionSummary,
  AdminInit,
  AuthorityInit,
  AuthorityInviteInvokes,
  InviteAction,
  ElectionType,
  ElectionCoreInit,
  ElectionRevisionInit,
  KeyholderInvite,
  UserKey,
  Timestamp,
  UserKeyType,
  User,
  Signature
} from '@votetorrent/vote-core'
import { verifyUserKeyMembership } from '../user/verify-user-key.js'
import { allocateTid } from '../database/tid-allocator.js'
import { seedSignedMutation } from '../signing/signed-mutation.js'
import { listCurrentScopeHolders, readAuthorityThreshold } from '../signing/threshold.js'
import { NetworkCreateAuthorityBuilder } from './builders/network-create-authority-builder.js'
import { NetworkPinAuthorityBuilder } from './builders/network-pin-authority-builder.js'
import { NetworkUnpinAuthorityBuilder } from './builders/network-unpin-authority-builder.js'
import { NetworkProposeRevisionBuilder } from './builders/network-propose-revision-builder.js'
import { NetworkRespondToInviteBuilder } from './builders/network-respond-to-invite-builder.js'

/** A fixed-message error carrying a string `code` the app maps to copy (62-102). */
function invitationError (code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string }
  err.code = code
  return err
}

export class NetworkEngine implements INetworkEngine {
  constructor (
    public readonly init: NetworkReference,
    private readonly localStorage: ILocalStorage,
    private readonly ctx: EngineContext,
    /** ENG-05: optional live peer-count callback injected from the app layer (D-03: no @serfab/@optimystic import enters packages/vote-engine). */
    private readonly getPeerCount?: () => number
  ) {}

  /** This is used for a new authority when responding to an invite, not when made as part of a network creation */
  async createAuthority (
    authority: AuthorityInit,
    admin: AdminInit,
    options?: { inviteSlotCid?: string; inviteSignature?: string }
  ): Promise<void> {
    // Group B (Phase 12.3-01): when responding to an invite, the authority Id
    // was already generated and committed in InviteResult.InvokedId by
    // respondToInvite() (so its Digest(Tid, Id, Name, DomainName, ImageRef)
    // matches Authority.InsertValid). Reuse that Id here; otherwise fall
    // back to a fresh uuid for the first-authority shoe-in path (no invite).
    let id: string = crypto.randomUUID()
    if (options?.inviteSlotCid) {
      const invokedRow = await this.ctx.db
        .prepare('select InvokedId from InviteResult where SlotCid = :slotCid')
        .get({ slotCid: options.inviteSlotCid })
      const reservedId = invokedRow?.InvokedId
      if (typeof reservedId === 'string' && reservedId.length > 0) {
        id = reservedId
      }
    }
    const imageRefJson = authority.imageUrl
      ? JSON.stringify(authority.imageUrl)
      : null
    const thresholdPoliciesJson = JSON.stringify(admin.thresholdPolicies)

    if (!admin.officers || admin.officers.length === 0 || !admin.officers[0]?.init) {
      throw new Error('Failed to create authority: Officer init is required')
    }

    const adminEffectiveAtCanonical = toCanonicalDatetime(admin.effectiveAt)
    // WR-05 (12.4-REVIEW): fail fast when an invite-bound createAuthority is
    // invoked without an authenticated current user. Officer.UserIdValid
    // (qsql:170) requires `exists (select 1 from User U where U.Id = new.UserId)`
    // — a null UserId binding cannot satisfy that existence CHECK, producing
    // a non-actionable schema error instead of a clear "no current user" one.
    // Same class as WR-04 (silent encoding mismatch between the two sites
    // that must agree byte-for-byte for D-09 binding) but on the userId
    // channel.
    //
    // v1.2 follow-up: AdminInit.OfficerInit does not currently carry a per-
    // officer `userId` field, so the engine binds `ctx.user.id` for every
    // officer row. Once OfficerInit gains a `userId` channel, this guard
    // should also verify the caller-supplied first-officer userId matches
    // what respondToInvite bound into InviteResult.Digest.
    if (options?.inviteSlotCid && !this.ctx.user?.id) {
      throw new Error('createAuthority: invite-bound flow requires an authenticated current user')
    }
    const callerUserId = this.ctx.user?.id ?? null

    // D-09 / Decision 2 (Phase 12.4): sort officers by UserId ASC so the first
    // officer inserted is the one whose Digest was bound into InviteResult by
    // respondToInvite. All officers insert (D-07c relaxes Officer.InsertValid
    // Branch 2 to existence-only) but only officer[0] is hash-bound to the
    // invite. Use the caller's user id as a per-officer fallback when init
    // omits a userId (mirrors the pre-Phase-12.4 single-officer behavior).
    const officerRows = admin.officers
      .filter((o): o is { init: NonNullable<typeof o.init> } => o?.init != null)
      .map(o => ({
        userId: callerUserId,
        title: o.init.title,
        scopes: JSON.stringify(o.init.scopes),
      }))
      .sort((a, b) => {
        // D-09 (WR-01): use codepoint comparison (`<` / `>` on strings) to
        // match quereus' TEXT `order by UserId asc` binary ordering. JS
        // `localeCompare` is locale-sensitive and host-ICU-dependent — for
        // non-ASCII userIds it would diverge from the schema's recompute and
        // silently break the Admin.MutationValid CHECK.
        const ua = a.userId ?? ''
        const ub = b.userId ?? ''
        return ua < ub ? -1 : ua > ub ? 1 : 0
      })

    // Phase 12.2: invite context params (inviteSlotCid, inviteSignature)
    // are passed through for second-authority creation per D-06/TEST-03.
    // For the first authority these default to null (backward-compat).
    const authorityParams = {
      id,
      name: authority.name,
      // Coerce undefined → null so quereus's strict TEXT-or-NULL binding
      // accepts the missing-domainName case (Rule 2 — safety; the test
      // 'should set Authority.DomainName to the provided value or null'
      // constructs an AuthorityInit without domainName via `as never`).
      domainName: authority.domainName ?? null,
      imageRef: imageRefJson,
      inviteSlotCid: options?.inviteSlotCid ?? null,
      inviteSignature: options?.inviteSignature ?? null,
      tid: 1
    }

    try {
      // D-07a (Phase 12.4): insert order is Authority → Officer (sorted by
      // UserId ASC) → Admin. Three separate db.exec calls because the
      // D-07g probe (12.4-00-SUMMARY) shows quereus 3.3.0 fires CHECKs
      // per-statement inside a single batch — collapsing into one db.exec
      // in this order would trip Officer.AdminValid before Admin exists
      // (the conditional short-circuit in D-07d handles the invite-bound
      // path, but the non-invite first-authority path still requires
      // Admin-first ordering, which createAuthority's first-authority
      // shoe-in case relies on through the very-first-authority shoe-in
      // branch where InviteSlotCid is null). Three-batch shape works for
      // both paths.

      // TX1 — Authority insert (Authority.InsertValid fires; Branch 2
      // existence-only under D-07b for invite-bound; Branch 1 shoe-in
      // for very-first-authority).
      await this.ctx.db.exec(
				`insert into Authority (
					Id,
					Name,
					DomainName,
					ImageRef
				)
				with context SigningNonce = null, InviteSlotCid = :inviteSlotCid, InviteSignature = :inviteSignature, Tid = :tid
				values (:id, :name, :domainName, :imageRef);
				`,
				authorityParams
      )

      // TX2 — Officer inserts (one per officer, sorted by UserId ASC).
      // Officer.AdminValid is conditionally short-circuited for the
      // invite-bound path (D-07d). Officer.InsertValid Branch 2 is
      // existence-only under D-07c.
      for (const officer of officerRows) {
        await this.ctx.db.exec(
					`insert into Officer (
						AuthorityId,
						AdminEffectiveAt,
						UserId,
						Title,
						Scopes
					)
					with context SigningNonce = null, InviteSlotCid = :inviteSlotCid, InviteSignature = :inviteSignature, Tid = :tid
					values (:authorityId, :adminEffectiveAt, :userId, :title, :scopes);
					`,
          {
            authorityId: id,
            adminEffectiveAt: adminEffectiveAtCanonical,
            userId: officer.userId,
            title: officer.title,
            scopes: officer.scopes,
            inviteSlotCid: options?.inviteSlotCid ?? null,
            inviteSignature: options?.inviteSignature ?? null,
            tid: 1,
          }
        )
      }

      // TX3 — Admin insert last. Admin.MutationValid fires here with
      // full 7-arg binding (both sub-Admin and sub-Officer subqueries
      // populated under D-09 ORDER BY UserId LIMIT 1). This is the
      // authoritative cryptographic gate (D-07e).
      await this.ctx.db.exec(
				`insert into Admin (
					AuthorityId,
					EffectiveAt,
					ThresholdPolicies
				)
				with context SigningNonce = null, InviteSlotCid = :inviteSlotCid, InviteSignature = :inviteSignature, Tid = :tid
				values (:authorityId, :adminEffectiveAt, :thresholdPolicies);
				`,
        {
          authorityId: id,
          adminEffectiveAt: adminEffectiveAtCanonical,
          thresholdPolicies: thresholdPoliciesJson,
          inviteSlotCid: options?.inviteSlotCid ?? null,
          inviteSignature: options?.inviteSignature ?? null,
          tid: 1,
        }
      )
    } catch (err) {
      if (err instanceof QuereusError) {
        throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
      } else if (err instanceof MisuseError) {
        throw new Error(`API misuse: ${err.message}`)
      } else {
        throw new Error(`Unknown error creating authority: ${err}`)
      }
    }
  }

  /** Returns all authorities that match the name (ENG-01/D-11).
   *
   * Security note: `name` is wrapped into the pattern ('%' + name + '%')
   * and bound as :pattern via the params object — never concatenated into
   * the SQL string (T-18-04 mitigated). PAGE_SIZE is a compile-time constant
   * inlined into the SQL (Quereus does not support bound parameters for LIMIT).
   *
   * WR-01: a caller-supplied name containing LIKE metacharacters (`%`, `_`)
   * would otherwise be interpreted as a wildcard — `a_b` would match `aXb`, and
   * `%` would match every authority. Quereus' LIKE has NO ESCAPE clause and no
   * escape character (see @quereus util/patterns.ts `simpleLike`), so escaping
   * cannot be expressed in SQL. Instead the LIKE stays as a (case-sensitive)
   * index-friendly prefilter and the results are post-filtered in JS to require
   * the literal substring, so `%`/`_` are matched literally. This is a
   * correctness/robustness fix, not injection — the value was already bound as
   * :pattern. NOTE: the LIMIT is applied in SQL before the JS post-filter, so a
   * page can under-fill when wildcard-only matches are dropped; this mirrors the
   * pre-existing single-page pagination contract. */
  async getAuthoritiesByName (
    name: string | undefined
  ): Promise<Cursor<Authority>> {
    const PAGE_SIZE = 20
    const pattern = name ? '%' + name + '%' : '%'
    const buffer: Authority[] = []
    try {
      for await (const row of this.ctx.db.eval(
        `SELECT Id, Name, DomainName, ImageRef FROM Authority WHERE Name LIKE :pattern ORDER BY Name ASC LIMIT ${PAGE_SIZE} OFFSET 0`,
        { pattern }
      )) {
        const rowName = row.Name as string
        // WR-01: drop rows that matched only because `%`/`_` in `name` acted as
        // wildcards. A literal substring check makes the search faithful to the
        // caller's input. Case-sensitive to match Quereus' (non-`i`) LIKE.
        if (name && !rowName.includes(name)) continue
        buffer.push({
          id: row.Id as string,
          name: rowName,
          domainName: asText(row.DomainName, 'Authority.DomainName'),
          imageRef: toImageRef(parseJsonOr<unknown>(row.ImageRef, undefined, 'Authority.ImageRef'))
        })
      }
      return { buffer, firstBOF: true, lastEOF: buffer.length < PAGE_SIZE, offset: 0 }
    } catch (err) {
      if (err instanceof QuereusError) {
        throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
      } else if (err instanceof MisuseError) {
        throw new Error(`API misuse: ${err.message}`)
      } else {
        throw new Error(`Unknown error getting authorities: ${err}`)
      }
    }
  }

  async getCurrentUser (): Promise<IUserEngine | undefined> {
    // USER-01: resolve the current user from the engine context (set by
    // NetworksEngine.open(...)). Delegates the row-level read to
    // NetworkEngine.getUser(id) so the User+UserKey join logic lives in
    // one place.
    if (!this.ctx.user) return undefined
    return await this.getUser(this.ctx.user.id)
  }

  async getDetails (): Promise<NetworkDetails> {
    try {
      const nRow = await this.ctx.db
        .prepare(
					`
						select
							Id, Hash, PrimaryAuthorityId, Name, ImageRef, Relays,
							TimestampAuthorities, NumberRequiredTSAs, ElectionType
						from Network
						where Hash = :hash
						limit 1
					`
        )
        .get({ hash: this.init.hash })

      if (!nRow) throw new Error('Network not found')

      const network: Network = {
        id: nRow.Id as string,
        hash: nRow.Hash as string,
        primaryAuthorityId: nRow.PrimaryAuthorityId as string,
        name: nRow.Name as string,
        imageRef: toImageRef(parseJsonOr<unknown>(
          nRow.ImageRef,
          undefined,
          'Network.ImageRef'
        )),
        relays: parseJsonOr<string[]>(nRow.Relays, [], 'Network.Relays'),
        policies: {
          numberRequiredTSAs: nRow.NumberRequiredTSAs as number,
          timestampAuthorities: parseJsonOr(
            nRow.TimestampAuthorities,
            [],
            'Network.TimestampAuthorities'
          ),
          electionType: nRow.ElectionType as ElectionType
        }
      }

      const pnRow = await this.ctx.db
        .prepare(
					`
						select
							Name, Revision, ImageRef, Relays, TimestampAuthorities, NumberRequiredTSAs, ElectionType
						from ProposedNetwork P
						where Name = :name
							and not exists (
								select 1 from RevisionCancellation C
								where C.Name = P.Name and C.Revision = P.Revision
							)
						order by Revision desc
						limit 1
					`
        )
        .get({ name: network.name })
      let proposedNetwork: NetworkRevision | undefined
      const proposedRevision = pnRow ? Number(pnRow.Revision) : undefined
      if (pnRow) {
        proposedNetwork = {
          name: pnRow.Name as string,
          imageRef: toImageRef(parseJsonOr<unknown>(
            pnRow.ImageRef,
            undefined,
            'ProposedNetwork.ImageRef'
          )),
          relays: parseJsonOr<string[]>(
            pnRow.Relays,
            [],
            'ProposedNetwork.Relays'
          ),
          policies: {
            numberRequiredTSAs: pnRow.NumberRequiredTSAs as number,
            timestampAuthorities: parseJsonOr(
              pnRow.TimestampAuthorities,
              [],
              'ProposedNetwork.TimestampAuthorities'
            ),
            electionType: pnRow.ElectionType as ElectionType
          }
        }
      }

      const aRow = await this.ctx.db
        .prepare(
					`
						select
							Id, Name, DomainName, ImageRef
						from Authority
						where Id = :id
					`
        )
        .get({ id: network.primaryAuthorityId })
      if (!aRow) {
        throw new Error('Primary authority not found')
      }
      const primaryAuthority: Authority = {
        id: aRow.Id as string,
        name: aRow.Name as string,
        domainName: asText(aRow.DomainName, 'Authority.DomainName'),
        imageRef: toImageRef(parseJsonOr<unknown>(
          aRow.ImageRef,
          undefined,
          'Authority.ImageRef'
        ))
      }

      return {
        network: {
          id: network.id,
          hash: network.hash,
          primaryAuthorityId: primaryAuthority.id,
          name: network.name,
          imageRef: network.imageRef,
          relays: network.relays,
          policies: {
            numberRequiredTSAs: network.policies.numberRequiredTSAs,
            timestampAuthorities: network.policies.timestampAuthorities,
            electionType: network.policies.electionType
          }
        },
        proposed: proposedNetwork
          ? { proposed: proposedNetwork, signers: [] }
          : undefined,
        ...(proposedRevision !== undefined ? { proposedRevision } : {})
      }
    } catch (error) {
      // WR-05: preserve the genuine missing-row signal but stop masking every
      // other failure (bad ImageRef JSON, asText null, Quereus errors, a missing
      // primary authority) as a benign "Network not found". Only the explicit
      // not-found throw keeps that message; everything else surfaces with context.
      if (error instanceof Error && error.message === 'Network not found') throw error
      throw new Error(`Failed to load network details: ${String(error)}`)
    }
  }

  async getElectionHistory (): Promise<ElectionSummary[]> {
    const elections: ElectionSummary[] = []
    try {
      for await (const election of this.ctx.db.eval(
				`
					select E.Id, E.Title, A.Name as AuthorityName, E.Date, E.Type
					from Election E
					join Authority A on A.Id = E.AuthorityId
					where E.Date < :date
				`,
				{ date: nowCanonicalDatetime() }
      )) {
        elections.push({
          id: election.Id as string,
          title: election.Title as string,
          authorityName: election.AuthorityName as string,
          date: fromCanonicalDatetime(election.Date as string),
          type: election.Type as ElectionType
        })
      }
      return elections
    } catch (err) {
      if (err instanceof QuereusError) {
        throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
      } else if (err instanceof MisuseError) {
        throw new Error(`API misuse: ${err.message}`)
      } else {
        throw new Error(`Unknown error: ${err}`)
      }
    }
  }

  async getElections (): Promise<ElectionSummary[]> {
    const elections: ElectionSummary[] = []
    try {
      for await (const election of this.ctx.db.eval(
				`
					select E.Id, E.Title, A.Name as AuthorityName, E.Date, E.Type
					from Election E
					join Authority A on A.Id = E.AuthorityId
					where E.Date > :date`,
				{ date: nowCanonicalDatetime() }
      )) {
        elections.push({
          id: election.Id as string,
          title: election.Title as string,
          authorityName: election.AuthorityName as string,
          date: fromCanonicalDatetime(election.Date as string),
          type: election.Type as ElectionType
        })
      }
      return elections
    } catch (err) {
      if (err instanceof QuereusError) {
        throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
      } else if (err instanceof MisuseError) {
        throw new Error(`API misuse: ${err.message}`)
      } else {
        throw new Error(`Unknown error: ${err}`)
      }
    }
  }

  async getNetworkSummary (): Promise<NetworkSummary> {
    try {
      const nRow = await this.ctx.db
        .prepare(
					`
						select
							Id, Hash, PrimaryAuthorityId, Name, ImageRef, Relays,
							TimestampAuthorities, NumberRequiredTSAs, ElectionType
						from Network
						where Hash = :hash
						limit 1
					`
        )
        .get({ hash: this.init.hash })

      if (!nRow) throw new Error('Network not found')

      const aRow = await this.ctx.db
        .prepare(
					`
						select
							Id, Name, DomainName, ImageRef
						from Authority
						where Id = :id
					`
        )
        .get({
          id: asText(nRow.PrimaryAuthorityId, 'Network.PrimaryAuthorityId')
        })
      if (!aRow) {
        throw new Error('Primary authority not found')
      }

      return {
        id: nRow.Id as string,
        hash: nRow.Hash as string,
        name: nRow.Name as string,
        imageUrl: toImageRef(parseJsonOr<unknown>(
          aRow.ImageRef,
          undefined,
          'Authority.ImageRef'
        ))?.url,
        primaryAuthorityDomainName: asText(
          aRow.DomainName,
          'Authority.DomainName'
        )
      }
    } catch (error) {
      // WR-05: preserve the genuine missing-row signal but stop masking every
      // other failure (bad ImageRef JSON, asText null, Quereus errors, a missing
      // primary authority) as a benign "Network not found".
      if (error instanceof Error && error.message === 'Network not found') throw error
      throw new Error(`Failed to load network summary: ${String(error)}`)
    }
  }

  /** Legacy device-wide pin key (before pins were per network). Read only to migrate. */
  private static readonly LEGACY_PINS_KEY = 'pinnedAuthorities'

  private get pinsKey (): string {
    return `pinnedAuthorities:${this.init.hash}`
  }

  /** Map an Authority row exactly as openAuthority does, so the two cannot drift. */
  private static mapAuthorityRow (row: Record<string, unknown>): Authority {
    return {
      id: row.Id as string,
      name: row.Name as string,
      domainName: asText(row.DomainName, 'Authority.DomainName'),
      imageRef: toImageRef(parseJsonOr<unknown>(row.ImageRef, undefined, 'Authority.ImageRef'))
    }
  }

  /** Point lookup of one authority in THIS network; undefined when the row is absent. */
  private async lookupAuthority (id: string): Promise<Authority | undefined> {
    const row = await this.ctx.db
      .prepare('select Id, Name, DomainName, ImageRef from Authority where Id = :id')
      .get({ id })
    return row ? NetworkEngine.mapAuthorityRow(row as Record<string, unknown>) : undefined
  }

  /**
   * Existence-only point lookup for the legacy pin migration (WR-R1-06). It reads no column, so a
   * row that `mapAuthorityRow` cannot map (a null `DomainName`, which the schema allows) is still
   * claimed by the network that holds it instead of failing the migration on every read.
   */
  private async authorityExists (id: string): Promise<boolean> {
    const row = await this.ctx.db
      .prepare('select 1 as x from Authority where Id = :id')
      .get({ id })
    return row !== undefined && row !== null
  }

  /**
   * The raw stored pin list for this network, after claiming any legacy device-wide
   * entries whose authority exists in this network. A lookup error is per entry
   * (WR-R1-06): that entry stays on the legacy key for a later read, and the rest still
   * migrate. Scoped key is written first, then the shrunken legacy list, so a crash
   * between the two can only duplicate a pin, never lose one.
   */
  private async readScopedPins (): Promise<Authority[]> {
    const scoped = (await this.localStorage.getItem<Authority[]>(this.pinsKey)) ?? []
    const legacy = (await this.localStorage.getItem<Authority[]>(NetworkEngine.LEGACY_PINS_KEY)) ?? []
    if (legacy.length === 0) return scoped
    const claimed: Authority[] = []
    const remaining: Authority[] = []
    for (const entry of legacy) {
      let exists: boolean
      try {
        exists = await this.authorityExists(entry.id)
      } catch {
        remaining.push(entry) // unknown: keep it legacy, retried on a later read
        continue
      }
      if (exists) claimed.push(entry)
      else remaining.push(entry)
    }
    if (claimed.length === 0) return scoped
    const byId = new Map(scoped.map((a) => [a.id, a]))
    for (const entry of claimed) if (!byId.has(entry.id)) byId.set(entry.id, entry)
    const merged = Array.from(byId.values())
    await this.localStorage.setItem(this.pinsKey, merged)
    if (remaining.length === 0) await this.localStorage.removeItem(NetworkEngine.LEGACY_PINS_KEY)
    else await this.localStorage.setItem(NetworkEngine.LEGACY_PINS_KEY, remaining)
    return merged
  }

  /**
   * Pinned authorities of THIS network. Pins are stored per network (key
   * `pinnedAuthorities:<hash>`); entries saved under the old device-wide key are
   * claimed on first read by the network whose Authority table holds them. Each pin
   * is resolved against the Authority table: a present authority is returned with its
   * CURRENT name/domain/image, an absent one is omitted (not deleted: a getter must
   * not destroy data), and a lookup error returns the stored snapshot (UAT 62 test
   * 19: a pin made on one network was listed on another and opened as "Authority
   * not found"). Never throws because of a lookup.
   */
  async getPinnedAuthorities (): Promise<Authority[]> {
    const stored = await this.readScopedPins()
    const resolved = await Promise.all(
      stored.map(async (pin): Promise<Authority | undefined> => {
        try {
          return await this.lookupAuthority(pin.id)
        } catch {
          return pin
        }
      })
    )
    return resolved.filter((a): a is Authority => a !== undefined)
  }

  async getProposedElections (): Promise<Array<Proposal<ElectionInit>>> {
    const proposedElections: ElectionCoreInit[] = []
    const proposedElectionRevisions: ElectionRevisionInit[] = []
    try {
      for await (const proposal of this.ctx.db.eval(
				`
					select
						Id, AuthorityId, Title, Date, RevisionDeadline, BallotDeadline, Type
					from ProposedElection
					where Date > :date
				`,
				{ date: nowCanonicalDatetime() }
      )) {
        proposedElections.push({
          id: proposal.Id as string,
          authorityId: proposal.AuthorityId as string,
          title: proposal.Title as string,
          date: fromCanonicalDatetime(proposal.Date as string),
          revisionDeadline: fromCanonicalDatetime(
            proposal.RevisionDeadline as string
          ),
          ballotDeadline: fromCanonicalDatetime(proposal.BallotDeadline as string),
          type: proposal.Type as ElectionType
        })
      }
      for await (const election of proposedElections) {
        const revRow = await this.ctx.db
          .prepare(
						`
						select
							ElectionId, Revision, RevisionTimestamp, Tags, Instructions, Timeline, KeyholderThreshold, Keyholders
						from ProposedElectionRevision
						where ElectionId = :id
					`
          )
          .get({ id: election.id })
        if (revRow) {
          proposedElectionRevisions.push({
            electionId: revRow.ElectionId as string,
            revision: revRow.Revision as number,
            revisionTimestamp: fromCanonicalDatetime(revRow.RevisionTimestamp as string),
            tags: parseJsonOr<string[]>(
              revRow.Tags,
              [],
              'ProposedElectionRevision.Tags'
            ),
            instructions: revRow.Instructions as string,
            // 39-02 D-04 Gap 2: read the persisted create-time keyholder invitees back.
            keyholders: parseJsonOr<KeyholderInvite[]>(revRow.Keyholders, [], 'ProposedElectionRevision.Keyholders'),
            timeline: parseJsonOr<Record<ElectionEvent, number>>(
              revRow.Timeline,
              {
                registrationEnds: 0,
                ballotsFinal: 0,
                votingStarts: 0,
                accruingVotes: 0,
                hashingVotes: 0,
                releasingKeys: 0,
                tallyingStarts: 0,
                validation: 0,
                certificationStarts: 0,
                closed: 0
              },
              'ProposedElectionRevision.Timeline'
            ),
            keyholderThreshold: revRow.KeyholderThreshold as number
          })
        }
      }
      const proposals: Array<Proposal<ElectionInit>> = proposedElections
        .map((election) => {
          const revision = proposedElectionRevisions.find(
            (rev) => rev.electionId === election.id
          )
          if (!revision) return undefined
          return {
            proposed: { election, revision },
            signers: [] as string[]
          } satisfies Proposal<ElectionInit>
        })
        .filter((p): p is Proposal<ElectionInit> => p !== undefined)
      return proposals
    } catch (err) {
      if (err instanceof QuereusError) {
        throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
      } else if (err instanceof MisuseError) {
        throw new Error(`API misuse: ${err.message}`)
      } else {
        throw new Error(`Unknown error: ${err}`)
      }
    }
  }

  async getUser (userId: string): Promise<IUserEngine | undefined> {
    try {
      const userDB = await this.ctx.db
        .prepare('select Id, Name, ImageRef from User where Id = :id')
        .get({ id: userId })
      if (!userDB) throw new Error('User not found')
      const activeKeys: UserKey[] = []
      for await (const key of this.ctx.db.eval(
        'select PubKey, Type, Expiration from UserKey where UserId = :id and Expiration > :date',
        { id: userId, date: nowCanonicalDatetime() }
      )) {
        activeKeys.push({
          key: key.PubKey as string,
          type: key.Type as UserKeyType,
          expiration: fromCanonicalDatetime(key.Expiration as string)
        })
      }
      const user: User = {
        id: userDB.Id as string,
        name: userDB.Name as string,
        imageRef: toImageRef(parseJsonOr<unknown>(
          userDB.ImageRef,
          undefined,
          'User.ImageRef'
        )),
        activeKeys
      }
      if (user) {
        return new UserEngine(user, this.ctx)
      }
      return undefined
    } catch (err) {
      if (err instanceof QuereusError) {
        throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
      } else if (err instanceof MisuseError) {
        throw new Error(`API misuse: ${err.message}`)
      } else {
        throw new Error(`Unknown error getting user: ${err}`)
      }
    }
  }

  async nextAuthoritiesByName (
    cursor: Cursor<Authority>,
    forward: boolean
  ): Promise<Cursor<Authority>> {
    // NOTE: The Cursor shape carries no `name` field — the name filter used
    // in getAuthoritiesByName cannot be recovered from the cursor. Per
    // RESEARCH Pattern 2 / Open Question 1, nextAuthoritiesByName pages the
    // full Authority set (LIKE '%') rather than re-applying the original
    // search filter. This is an intentional decision for this phase; a future
    // phase can extend the Cursor shape or the interface if per-name paging
    // is required.
    const PAGE_SIZE = 20
    const newOffset = forward ? cursor.offset + PAGE_SIZE : Math.max(0, cursor.offset - PAGE_SIZE)
    const buffer: Authority[] = []
    try {
      for await (const row of this.ctx.db.eval(
        // PAGE_SIZE and offset are inlined: Quereus does not support bound parameters
        // for LIMIT/OFFSET integer expressions — only string/value params are supported.
        `SELECT Id, Name, DomainName, ImageRef FROM Authority ORDER BY Name ASC LIMIT ${PAGE_SIZE} OFFSET ${newOffset}`
      )) {
        buffer.push({
          id: row.Id as string,
          name: row.Name as string,
          domainName: asText(row.DomainName, 'Authority.DomainName'),
          imageRef: toImageRef(parseJsonOr<unknown>(row.ImageRef, undefined, 'Authority.ImageRef'))
        })
      }
      return { buffer, firstBOF: newOffset === 0, lastEOF: buffer.length < PAGE_SIZE, offset: newOffset }
    } catch (err) {
      if (err instanceof QuereusError) {
        throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
      } else if (err instanceof MisuseError) {
        throw new Error(`API misuse: ${err.message}`)
      } else {
        throw new Error(`Unknown error in nextAuthoritiesByName: ${err}`)
      }
    }
  }

  async openAuthority (
    authorityId: string,
    authority?: Authority
  ): Promise<IAuthorityEngine> {
    if (authority) {
      return new AuthorityEngine(authority, this.ctx)
    }
    try {
      const found = await this.lookupAuthority(authorityId)
      if (!found) {
        throw Object.assign(new Error('Authority not found'), { code: 'authority-not-found' })
      }
      const authority: Authority = found
      return new AuthorityEngine(authority, this.ctx)
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'authority-not-found') throw err
      if (err instanceof QuereusError) {
        throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
      } else if (err instanceof MisuseError) {
        throw new Error(`API misuse: ${err.message}`)
      } else {
        throw new Error(`Unknown error opening authority: ${err}`)
      }
    }
  }

  async pinAuthority (authority: Authority): Promise<void> {
    const pinnedAuthorities = await this.readScopedPins()
    const unique = Object.fromEntries(
      pinnedAuthorities.map((authority) => [authority.id, authority])
    )
    const appended = { ...unique, [authority.id]: authority }
    await this.localStorage.setItem(
      this.pinsKey,
      Object.values(appended)
    )
  }

  async proposeRevision (revision: NetworkRevision): Promise<void> {
    try {
      const imageRefJson = revision.imageRef
        ? JSON.stringify(revision.imageRef)
        : null
      const relaysJson = JSON.stringify(revision.relays)
      const timestampAuthoritiesJson = JSON.stringify(
        revision.policies.timestampAuthorities
      )
      const userId = this.ctx.user?.id ?? null
      const userKey = this.ctx.user?.activeKeys?.[0]?.key ?? null
      // D-21 (Class B): no Signature is available on this path — proposeRevision's
      // own public signature carries no signature argument — so registered/unexpired
      // UserKey membership is the WHOLE of "real IsUserValid" here, not one conjunct.
      const membership = await verifyUserKeyMembership(this.ctx, userId, userKey)
      await this.ctx.db.exec(
				`insert into ProposedNetwork
					(Name, Revision, ImageRef, Relays, TimestampAuthorities, NumberRequiredTSAs, ElectionType)
				with context UserId = :userId, UserKey = :userKey, Signature = null, Tid = 0, now = :now, IsUserValid = :isUserValid
				values
					(:name, coalesce((select max(Revision) from ProposedNetwork where Name = :name), -1) + 1, :imageRef, :relays, :timestampAuthorities, :numberRequiredTSAs, :electionType)`,
				{
				  name: revision.name,
				  imageRef: imageRefJson,
				  relays: relaysJson,
				  timestampAuthorities: timestampAuthoritiesJson,
				  numberRequiredTSAs: revision.policies.numberRequiredTSAs,
				  electionType: revision.policies.electionType,
				  userId,
				  userKey,
				  isUserValid: membership.valid,
				  now: nowCanonicalDatetime()
				}
      )
    } catch (error) {
      throw new Error('Failed to propose revision: ' + error)
    }
  }

  /**
   * SURF-04 (D-09, NON-signing): withdraw a proposed network revision by
   * inserting an append-only RevisionCancellation marker keyed by (Name,
   * Revision). The ProposedNetwork row is never mutated/deleted — the marker
   * is justified by append-only audit consistency (NOT a CantDelete on
   * ProposedNetwork; it has none). `revision` is bound as a NUMBER so the
   * (Name, Revision) PK join is exact (OpenQ 3 / T-19-12). The marker's
   * ProposalExists CHECK (Plan 19-01) rejects a marker for a non-existent
   * proposal; we additionally guard in TS for a clearer error message.
   */
  async cancelRevision (name: string, revision: number): Promise<void> {
    try {
      const existing = await this.ctx.db
        .prepare(
					`select 1 from ProposedNetwork where Name = :name and Revision = :revision`
        )
        .get({ name, revision })
      if (!existing) {
        throw new Error(
					`No proposed revision found for (${name}, ${revision})`
        )
      }
      await this.ctx.db.exec(
				`insert into RevisionCancellation (Name, Revision, CancelledAt)
					with context Tid = 0, now = :now
					values (:name, :revision, :now)`,
				{
				  name,
				  revision,
				  now: nowCanonicalDatetime()
				}
      )
    } catch (error) {
      throw new Error('Failed to cancel revision: ' + error)
    }
  }

  /**
   * SURF-04 (D-09, NON-signing): re-emit a proposed network revision as a
   * FRESH ProposedNetwork row at coalesce(max(Revision), -1) + 1 for Name
   * (no auto-supersede — old/cancelled proposals are untouched). Reuses the
   * original (Name, Revision) row's fields. Returns the new Revision number.
   * `revision` is bound as a NUMBER for an exact PK lookup of the source row.
   */
  async resendRevision (name: string, revision: number): Promise<number> {
    try {
      const source = await this.ctx.db
        .prepare(
					`select
							ImageRef, Relays, TimestampAuthorities, NumberRequiredTSAs, ElectionType
						from ProposedNetwork where Name = :name and Revision = :revision`
        )
        .get({ name, revision })
      if (!source) {
        throw new Error(
					`No proposed revision found for (${name}, ${revision})`
        )
      }
      const userId = this.ctx.user?.id ?? null
      const userKey = this.ctx.user?.activeKeys?.[0]?.key ?? null
      // D-21 (Class B): no Signature is available on this path — same rationale
      // as proposeRevision above.
      const membership = await verifyUserKeyMembership(this.ctx, userId, userKey)
      await this.ctx.db.exec(
				`insert into ProposedNetwork
					(Name, Revision, ImageRef, Relays, TimestampAuthorities, NumberRequiredTSAs, ElectionType)
				with context UserId = :userId, UserKey = :userKey, Signature = null, Tid = 0, now = :now, IsUserValid = :isUserValid
				values
					(:name, coalesce((select max(Revision) from ProposedNetwork where Name = :name), -1) + 1, :imageRef, :relays, :timestampAuthorities, :numberRequiredTSAs, :electionType)`,
				{
				  name,
				  imageRef: source.ImageRef as string | null,
				  relays: source.Relays as string,
				  timestampAuthorities: source.TimestampAuthorities as string,
				  numberRequiredTSAs: source.NumberRequiredTSAs as number,
				  electionType: source.ElectionType as string,
				  userId,
				  userKey,
				  isUserValid: membership.valid,
				  now: nowCanonicalDatetime()
				}
      )
      const newRow = await this.ctx.db
        .prepare(
					`select max(Revision) as MaxRevision from ProposedNetwork where Name = :name`
        )
        .get({ name })
      return Number(newRow?.MaxRevision)
    } catch (error) {
      throw new Error('Failed to resend revision: ' + error)
    }
  }

  /**
   * Apply a proposed network revision (servers/relays, name, image, TSA policy) to the live
   * `Network` row. The schema's `Network.UpdateNetworkValid` admits the UPDATE only under a
   * completed `rn`-scoped AdminSignature whose Digest covers the new row —
   * `Digest(Tid, Id, Name, ImageRef, Relays, TimestampAuthorities, NumberRequiredTSAs, ElectionType)` —
   * so this method mints exactly that signing session (the officer's `sign` callback signs the
   * digest app-side), then updates the row under it, all in ONE transaction: a refused signature
   * leaves neither a session nor a half-applied network.
   *
   * The applied proposal is then marked resolved with the existing RevisionCancellation marker, so
   * it drops off the proposed list (the network row now carries its values).
   *
   * Single-approver only: when the authority's `rn` threshold is above 1 this refuses BEFORE
   * writing anything. Co-signing needs a 'network' signature Task, and the schema's
   * `NetworkSignatureTaskExtension.MutationValid` binds a 7-field digest without `Id` that can never
   * equal `UpdateNetworkValid`'s 8-field digest — a schema amendment, not engine work.
   */
  async applyRevision (
    name: string,
    revision: number,
    sign: (digest: Uint8Array) => Promise<Signature>
  ): Promise<void> {
    const proposal = await this.ctx.db
      .prepare(
        `select ImageRef, Relays, TimestampAuthorities, NumberRequiredTSAs, ElectionType
          from ProposedNetwork P
          where Name = :name and Revision = :revision
            and not exists (
              select 1 from RevisionCancellation C where C.Name = P.Name and C.Revision = P.Revision
            )`
      )
      .get({ name, revision })
    if (!proposal) {
      throw new Error(`No open proposed revision found for (${name}, ${revision})`)
    }
    const network = await this.ctx.db
      .prepare('select Id, PrimaryAuthorityId from Network where Hash = :hash limit 1')
      .get({ hash: this.init.hash })
    if (!network) throw new Error('Network not found')
    const networkId = network.Id as string
    const authorityId = network.PrimaryAuthorityId as string

    const userId = this.ctx.user?.id
    if (!userId || !(await listCurrentScopeHolders(this.ctx.db, authorityId, 'rn')).includes(userId)) {
      throw new Error('Only a current officer of the primary authority holding the "Revise Network" scope can apply a network revision')
    }
    if ((await readAuthorityThreshold(this.ctx.db, authorityId, 'rn')) > 1) {
      throw new FeatureNotAvailableError(
        'Applying a network revision that needs more than one officer\'s approval is not supported yet'
      )
    }

    // Values bound IDENTICALLY into the digest and the UPDATE, so UpdateNetworkValid recomputes
    // the same bytes the officer signed.
    const row = {
      id: networkId,
      name,
      imageRef: (proposal.ImageRef as string | null) ?? null,
      relays: proposal.Relays as string,
      timestampAuthorities: proposal.TimestampAuthorities as string,
      numberRequiredTSAs: Number(proposal.NumberRequiredTSAs),
      electionType: proposal.ElectionType as string
    }
    const tid = await allocateTid(this.ctx.db, 'network')

    await this.ctx.db.exec('BEGIN')
    try {
      const signingNonce = await seedSignedMutation(
        this.ctx,
        authorityId,
        'rn',
        tid,
        'select Digest(:tid, :id, :name, :imageRef, :relays, :timestampAuthorities, :numberRequiredTSAs, :electionType) as d',
        { tid, ...row },
        sign,
        { ownsTransaction: false }
      )
      await this.ctx.db.exec(
        `update Network
          with context SigningNonce = :signingNonce, Tid = ${tid}
          set Name = :name,
            ImageRef = :imageRef,
            Relays = :relays,
            TimestampAuthorities = :timestampAuthorities,
            NumberRequiredTSAs = :numberRequiredTSAs,
            ElectionType = :electionType
          where Id = :id`,
        { ...row, signingNonce }
      )
      await this.ctx.db.exec(
        `insert into RevisionCancellation (Name, Revision, CancelledAt)
          with context Tid = 0, now = :now
          values (:name, :revision, :now)`,
        { name, revision, now: nowCanonicalDatetime() }
      )
      await this.ctx.db.exec('COMMIT')
    } catch (error) {
      await this.ctx.db.exec('ROLLBACK')
      throw new Error('Failed to apply revision: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  async respondToInvite<TInvokes>(
    invite: InviteAction<TInvokes>
  ): Promise<string> {
    // USER-07: insert a row into InviteResult. The InviteSlot row must
    // already exist (seeded via AuthorityEngine.saveInviteWithSigning).
    //
    // Schema (vote-core/schema/votetorrent.qsql:511 InviteResult):
    //   SlotCid       text primary key       — the InviteSlot CID
    //   IsAccepted    boolean                 — if false, Digest must be null
    //   Digest        text null               — digest of whatever the invited
    //                                          party intends to create
    //   InviteSignature text                  — H(SlotCid, Digest, IsAccepted)
    //                                          signed by InviteSlot.InviteKey
    //   InvokedId     text null               — id of the object the invite
    //                                          will invoke (Authority / User)
    //
    // The CHECK constraints (SigningValid + SignatureValid) require an
    // existing AdminSignature row for the slot and a valid signature
    // over the digest.
    //
    // 62-102 (gap7/IN-03): this method SIGNS the InviteResult itself with the
    // invite's one-time private key (`invite.invitePrivate`, REQUIRED) and
    // verifies it against the slot's InviteKey on BOTH branches, so no
    // accepted result is ever written that the invite key did not sign. The
    // caller's `inviteSignature` is ignored. The slot is the live head of the
    // invite chain (cancelled, answered, expired and ambiguous chains refuse
    // with a coded error), exactly as the app path (InvitationEngine) does.
    const invitePrivateHex = invite.invitePrivate
    if (typeof invitePrivateHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(invitePrivateHex)) {
      throw invitationError('invite-key-required', 'respondToInvite: the invite private key is required')
    }
    const resolution = await readInviteChain(
      this.ctx.db,
      invite.invite.inviteKey,
      invite.invite.type,
      nowCanonicalDatetime()
    )
    if (resolution.status === 'not-found') throw invitationError('invite-not-found', 'respondToInvite: invite not found')
    if (resolution.status === 'answered') throw invitationError('invite-already-answered', 'respondToInvite: invite already answered')
    if (resolution.status === 'no-longer-valid') throw invitationError('invite-no-longer-valid', 'respondToInvite: invite is no longer valid')
    if (resolution.status === 'ambiguous') throw invitationError('invite-unverifiable', 'respondToInvite: invite chain is ambiguous')
    const slotCid = resolution.cid
    const signInviteResult = (digestToken: string): { signature: string; valid: boolean } => {
      const signedBytes = inviteResultSignedBytes({ slotCid, digestToken, accept: invite.isAccepted })
      const signature = bytesToHex(secp256k1.sign(sha256(signedBytes), hexToBytes(invitePrivateHex)))
      return { signature, valid: verifyAdHocInviteSignature(signedBytes, signature, invite.invite.inviteKey) }
    }
    // Group B (Phase 12.3-01): for authority invites, generate the authority
    // Id at invite-response time so the SQL-side Digest() committed to
    // InviteResult.Digest matches what Authority.InsertValid recomputes when
    // the downstream createAuthority() insert fires:
    //   Digest(context.Tid, new.Id, new.Name, new.DomainName, new.ImageRef)
    // The generated id is stored in InviteResult.InvokedId; createAuthority
    // looks it up via inviteSlotCid and reuses it as the new Authority.Id.
    const isAuthorityInvite = invite.invite.type === 'au'
    const invokesAuthority =
      isAuthorityInvite && invite.isAccepted
        ? ((invite.invokes as unknown as {
            authority?: {
              name?: string
              domainName?: string | null
              imageUrl?: string | null
            }
          }).authority ?? {})
        : null
    const generatedAuthorityId =
      isAuthorityInvite && invite.isAccepted ? crypto.randomUUID() : null
    const invokedId =
      invite.userId
      ?? generatedAuthorityId
      ?? (invite.userInit ? crypto.randomUUID() : null)
    // Tid binding (1) matches createAuthority's hard-coded Tid = 1 so
    // Digest(context.Tid, ...) on the Authority insert side reproduces the
    // exact value committed here. If Tid ever becomes non-static, both sites
    // must read from a shared source.
    //
    // WR-04 (12.4-REVIEW): use the same field name (`imageUrl`) and same
    // serialization (`JSON.stringify(stringValue)` → quoted-JSON) as
    // createAuthority above. Previously this site read `invokes.imageRef`
    // (typed `unknown`) while createAuthority read `authority.imageUrl`
    // — an object-shaped value (e.g. `{ url: ... }`) would silently
    // produce a different JSON encoding at the two sites and trip
    // Admin.MutationValid TX3 with a non-actionable CHECK error.
    const authorityImageRefJson = invokesAuthority?.imageUrl != null
      ? JSON.stringify(invokesAuthority.imageUrl)
      : null
    // WR-R1-09 (mirrors InvitationEngine gap7/IN-04): the chain read above happens before the
    // signing work, so a cancellation (or another answer) can land in between. The InviteResult is
    // therefore written inside ONE transaction, serialized per database with every other invite
    // write (cancelInvite included), whose first statement re-reads the chain and requires this
    // slot to still be its live head.
    const writeResultIfLive = async (sql: string, params: Record<string, SqlValue>): Promise<void> => {
      await withInviteWriteSerial(this.ctx.db, async () => {
        await this.ctx.db.exec('BEGIN')
        try {
          const live = await readInviteChain(this.ctx.db, invite.invite.inviteKey, invite.invite.type, nowCanonicalDatetime())
          if (live.status !== 'live' || live.cid !== slotCid) {
            if (live.status === 'answered') throw invitationError('invite-already-answered', 'respondToInvite: invite already answered')
            if (live.status === 'no-longer-valid') throw invitationError('invite-no-longer-valid', 'respondToInvite: invite is no longer valid')
            if (live.status === 'live') throw invitationError('invite-superseded', 'respondToInvite: invite was replaced by a newer copy')
            throw invitationError('invite-unverifiable', 'respondToInvite: invite chain cannot be verified')
          }
          await this.ctx.db.exec(sql, params)
          await this.ctx.db.exec('COMMIT')
        } catch (innerErr) {
          try {
            await this.ctx.db.exec('ROLLBACK')
          } catch {
            // already rolled back by the failed statement; the original error is what matters.
          }
          throw innerErr
        }
      })
    }
    try {
      if (isAuthorityInvite && invite.isAccepted) {
        // D-06 / D-09 (Phase 12.4): the engine commits a 7-arg Digest to
        // InviteResult.Digest so that Admin.MutationValid (which fires last
        // under D-07a insert order Authority → Officer → Admin) can recompute
        // the same 7-arg Digest and validate the entire invite bundle.
        //
        // Schema's nested Officer subquery is `(select Digest(AdminEffectiveAt,
        // UserId, Title, Scopes) from (select * from Officer ... order by
        // UserId asc limit 1))` — a single-row scalar. We mirror that by
        // computing `Digest(...)` as an inline scalar over the first
        // (lex-smallest UserId) officer's columns.
        const invokesAdmin = (invite.invokes as unknown as AuthorityInviteInvokes).admin
        const invokesOfficers = (invite.invokes as unknown as AuthorityInviteInvokes).officers
        // Pitfall 5 / T-12.4-01-03 mitigation: silently committing a wrong-shape
        // Digest here would land an invite that no downstream createAuthority
        // insert can satisfy.
        if (invokesAdmin == null || !Array.isArray(invokesOfficers) || invokesOfficers.length === 0) {
          throw new Error('respondToInvite: authority invite requires invokes.admin and non-empty invokes.officers[]')
        }
        // D-09: sort by userId ASC and bind only the first officer's columns
        // into InviteResult.Digest. Officers 2..N are not hash-bound — this is
        // the documented v1.2 follow-up limitation.
        // D-09 (WR-01): codepoint comparison to mirror SQL `order by UserId asc`.
        // localeCompare is locale-sensitive; binary `<`/`>` matches quereus TEXT
        // ordering and keeps the bound first-officer identity consistent across
        // engine and schema.
        // WR-06: coalesce null/undefined userId to '' BEFORE comparing, identical
        // to createAuthority's sort (lines ~122-124). Bare `a.userId < b.userId`
        // against a null yields false/false and produces an unstable ordering that
        // can select a different first officer than createAuthority — the two sites
        // would then bind divergent InviteResult.Digest values and trip
        // Admin.MutationValid. Keeping the coalescing identical preserves the D-09
        // byte-for-byte agreement.
        const sortedOfficers = [...invokesOfficers].sort((a, b) => {
          const ua = a.userId ?? ''
          const ub = b.userId ?? ''
          return ua < ub ? -1 : ua > ub ? 1 : 0
        })
        const firstOfficer = sortedOfficers[0]!
        // 62-102 (gap7/IN-03): compute the 7-argument Digest first (the exact
        // arguments the INSERT used), sign over that very value with the
        // invite key, verify against the slot's InviteKey and refuse on
        // failure. The previous hard-coded true signature flag accepted
        // an unsigned claim.
        const digestParams = {
          tid: 1,
          authorityId: generatedAuthorityId,
          authorityName: invokesAuthority?.name ?? null,
          authorityDomainName: invokesAuthority?.domainName ?? null,
          authorityImageRef: authorityImageRefJson,
          adminEffectiveAt: invokesAdmin.effectiveAt,
          adminThresholdPolicies: invokesAdmin.thresholdPolicies,
          officerAdminEffectiveAt: firstOfficer.adminEffectiveAt,
          officerUserId: firstOfficer.userId,
          officerTitle: firstOfficer.title,
          officerScopes: firstOfficer.scopes,
        }
        const digestRow = await this.ctx.db
          .prepare(
            `select Digest(:tid, :authorityId, :authorityName, :authorityDomainName, :authorityImageRef,
              Digest(:adminEffectiveAt, :adminThresholdPolicies),
              Digest(:officerAdminEffectiveAt, :officerUserId, :officerTitle, :officerScopes)
            ) as d`
          )
          .get(digestParams)
        const digestValue = digestRow?.d
        if (typeof digestValue !== 'string') {
          throw new Error('respondToInvite: could not compute the authority invite digest')
        }
        const signed = signInviteResult(digestValue)
        if (!signed.valid) {
          throw invitationError('invite-signature-invalid', 'respondToInvite: invite signature does not verify')
        }
        await writeResultIfLive(
					`insert into InviteResult (
						SlotCid,
						IsAccepted,
						Digest,
						InviteSignature,
						InvokedId
					)
					with context IsSigningValid = true, IsSignatureValid = :isSignatureValid
					values (
						:slotCid,
						:isAccepted,
						:digest,
						:inviteSignature,
						:invokedId
					)`,
          {
            slotCid,
            isAccepted: invite.isAccepted,
            digest: digestValue,
            inviteSignature: signed.signature,
            invokedId,
            isSignatureValid: signed.valid,
          }
        )
      } else {
        // Non-authority accepted invites and rejections: Digest column is
        // either null (rejection) or an opaque JSON blob (legacy semantics
        // for user / officer / keyholder / registrant invites). User
        // invite chain validation lives in Plan 12.3-07; this branch
        // preserves existing behavior.
        const resultDigest = invite.isAccepted
          ? JSON.stringify(invite.invokes)
          : null
        // 999.1 R-03: same A1 LOCKED domain as the authority-accepted branch
        // above, with digestToken = the plain resultDigest (or 'null' for a
        // decline — inviteResultSignedBytes applies that coalesce).
        // 62-102: signed engine-side with the invite key, never taken from the caller.
        const signedResult = signInviteResult(resultDigest ?? 'null')
        if (!signedResult.valid) {
          throw invitationError('invite-signature-invalid', 'respondToInvite: invite signature does not verify')
        }
        const isSignatureValid = signedResult.valid
        await writeResultIfLive(
					`insert into InviteResult (
						SlotCid,
						IsAccepted,
						Digest,
						InviteSignature,
						InvokedId
					)
					with context IsSigningValid = true, IsSignatureValid = :isSignatureValid
					values (
						:slotCid,
						:isAccepted,
						:digest,
						:inviteSignature,
						:invokedId
					)`,
          {
            slotCid,
            isAccepted: invite.isAccepted,
            digest: resultDigest,
            inviteSignature: signedResult.signature,
            invokedId,
            isSignatureValid,
          }
        )
      }
    } catch (err) {
      // 62-102: a string `code` on the error (invite-signature-invalid, ...) survives the rewrap.
      const code = (err as { code?: unknown } | null)?.code
      if (typeof code === 'string' && !(err instanceof QuereusError)) throw err
      if (err instanceof QuereusError) {
        throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
      } else if (err instanceof MisuseError) {
        throw new Error(`API misuse: ${err.message}`)
      } else {
        throw new Error(`Failed to respond to invite: ${String(err)}`)
      }
    }
    return invokedId ?? ''
  }

  async getStatistics (): Promise<{ estimatedNodes: number; serverCount: number }> {
    try {
      const nRow = await this.ctx.db
        .prepare('SELECT Relays FROM Network WHERE Hash = :hash LIMIT 1')
        .get({ hash: this.init.hash })
      if (!nRow) throw new Error('Network not found')
      const relays = parseJsonOr<string[]>(nRow.Relays, [], 'Network.Relays')
      const serverCount = relays.length
      // ENG-05: use live peer count from injected callback when available.
      // D-03: getPeerCount is a plain (() => number) callback — no @serfab/@optimystic import enters vote-engine.
      // Fallback: relay-count heuristic (honest lower-bound floor per WR-07 / D-07).
      // When callback is absent or returns 0, estimatedNodes = serverCount (the pre-Phase-22 floor).
      const connectedPeers = this.getPeerCount?.() ?? 0
      return { serverCount, estimatedNodes: Math.max(serverCount, connectedPeers) }
    } catch (err) {
      if (err instanceof QuereusError) {
        throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
      } else if (err instanceof MisuseError) {
        throw new Error(`API misuse: ${err.message}`)
      } else {
        throw new Error(`Unknown error in getStatistics: ${err}`)
      }
    }
  }

  async unpinAuthority (authorityId: string): Promise<void> {
    const pinnedAuthorities = await this.readScopedPins()
    const filtered = pinnedAuthorities.filter(
      (authority) => authority.id !== authorityId
    )
    await this.localStorage.setItem(this.pinsKey, filtered)
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
