import { QuereusError, MisuseError } from '@quereus/quereus'
import { AuthorityEngine } from '../authority/authority-engine.js'
import { UserEngine } from '../user/user-engine.js'
import { asText, parseJsonOr } from '../utils.js'
import type { EngineContext } from '../types.js'
import type {
  Authority,
  Cursor,
  IAuthorityEngine,
  ImageRef,
  INetworkEngine,
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
  IElectionEngine,
  AdminInit,
  AuthorityInit,
  InviteAction,
  ElectionType,
  ElectionCoreInit,
  ElectionRevisionInit,
  UserKey,
  Timestamp,
  UserKeyType,
  User
} from '@votetorrent/vote-core'

export class NetworkEngine implements INetworkEngine {
  constructor (
    public readonly init: NetworkReference,
    private readonly localStorage: ILocalStorage,
    private readonly ctx: EngineContext
  ) {}

  /** This is used for a new authority when responding to an invite, not when made as part of a network creation */
  async createAuthority (
    authority: AuthorityInit,
    admin: AdminInit
  ): Promise<void> {
    const id = crypto.randomUUID()
    const imageRefJson = authority.imageUrl
      ? JSON.stringify(authority.imageUrl)
      : null
    const thresholdPoliciesJson = JSON.stringify(admin.thresholdPolicies)

    const firstOfficer = admin.officers?.[0]
    if (!firstOfficer?.init) {
      throw new Error('Failed to create authority: Officer init is required')
    }
    const officerInit = firstOfficer.init

    try {
      await this.ctx.db.exec(
				`insert into Authority (
					Id,
					Name,
					DomainName,
					ImageRef
				)
				with context ( Tid, InviteSlotCid, InviteSignature)
				values (:id, :name, :domainName, :imageRef)

				insert into Admin (
					AuthorityId,
					EffectiveAt,
					ThresholdPolicies
				)
				with context ( Tid, InviteSlotCid, InviteSignature)
				values (:authorityId, :adminEffectiveAt, :thresholdPolicies)

				insert into Officer (
					AuthorityId,
					AdminEffectiveAt,
					UserId,
					Title,
					Scopes
				)
				with context ( Tid, InviteSlotCid, InviteSignature)
				values (:authorityId, :adminEffectiveAt, :userId, :title, :scopes)
				`,
				{
				  id,
				  name: authority.name,
				  domainName: authority.domainName,
				  imageRef: imageRefJson,
				  authorityId: id,
				  adminEffectiveAt: admin.effectiveAt,
				  thresholdPolicies: thresholdPoliciesJson

				  // TODO: add context values
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

  async createElection (election: ElectionInit): Promise<void> {
    throw new Error('Not implemented')
  }

  /** Returns all authorities that match the name */
  async getAuthoritiesByName (
    name: string | undefined
  ): Promise<Cursor<Authority>> {
    throw new Error('Not implemented')
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
        imageRef: parseJsonOr<ImageRef | undefined>(
          nRow.ImageRef,
          undefined,
          'Network.ImageRef'
        ),
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
							Name, ImageRef, Relays, TimestampAuthorities, NumberRequiredTSAs, ElectionType
						from ProposedNetwork
						where Name = :name
					`
        )
        .get({ name: network.name })
      let proposedNetwork: NetworkRevision | undefined
      if (pnRow) {
        proposedNetwork = {
          name: pnRow.Name as string,
          imageRef: parseJsonOr<ImageRef | undefined>(
            pnRow.ImageRef,
            undefined,
            'ProposedNetwork.ImageRef'
          ),
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
        imageRef: parseJsonOr<ImageRef | undefined>(
          aRow.ImageRef,
          undefined,
          'Authority.ImageRef'
        )
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
          : undefined
      }
    } catch (error) {
      throw new Error('Network not found')
    }
  }

  async getElectionHistory (): Promise<ElectionSummary[]> {
    const elections: ElectionSummary[] = []
    try {
      for await (const election of this.ctx.db.eval(
				`
					select
						Id, Title, AuthorityName, Date, Type
					from Election
					where Date < :date
				`,
				{ date: Date.now() }
      )) {
        elections.push({
          id: election.Id as string,
          title: election.Title as string,
          authorityName: election.AuthorityName as string,
          date: new Date(election.Date as number).getTime(),
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
					select
						Id, Title, AuthorityName, Date, Type
					from Election
					where Date > :date`,
				{ date: Date.now() }
      )) {
        elections.push({
          id: election.Id as string,
          title: election.Title as string,
          authorityName: election.AuthorityName as string,
          date: new Date(election.Date as number).getTime(),
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
        imageUrl: parseJsonOr<ImageRef | undefined>(
          aRow.ImageRef,
          undefined,
          'Authority.ImageRef'
        )?.url,
        primaryAuthorityDomainName: asText(
          aRow.DomainName,
          'Authority.DomainName'
        )
      }
    } catch (error) {
      throw new Error('Network not found')
    }
  }

  async getPinnedAuthorities (): Promise<Authority[]> {
    return (
      (await this.localStorage.getItem<Authority[]>('pinnedAuthorities')) ?? []
    )
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
				{ date: Date.now() }
      )) {
        proposedElections.push({
          id: proposal.Id as string,
          authorityId: proposal.AuthorityId as string,
          title: proposal.Title as string,
          date: new Date(proposal.Date as number).getTime(),
          revisionDeadline: new Date(
            proposal.RevisionDeadline as number
          ).getTime(),
          ballotDeadline: new Date(proposal.BallotDeadline as number).getTime(),
          type: proposal.Type as ElectionType
        })
      }
      for await (const election of proposedElections) {
        const revRow = await this.ctx.db
          .prepare(
						`
						select
							ElectionId, Revision, RevisionTimestamp, Tags, Instructions, Timeline, KeyholderThreshold
						from ElectionRevision
						where ElectionId = :id
					`
          )
          .get({ id: election.id })
        if (revRow) {
          proposedElectionRevisions.push({
            electionId: revRow.ElectionId as string,
            revision: revRow.Revision as number,
            revisionTimestamp: revRow.RevisionTimestamp as Timestamp,
            tags: parseJsonOr<string[]>(
              revRow.Tags,
              [],
              'ElectionRevision.Tags'
            ),
            instructions: revRow.Instructions as string,
            keyholders: [], // fix this
            timeline: parseJsonOr<Record<ElectionEvent, number>>(
              revRow.Timeline,
              {
                registrationEnds: 0,
                ballotsFinal: 0,
                votingStarts: 0,
                tallyingStarts: 0,
                validation: 0,
                certificationStarts: 0,
                closed: 0
              },
              'ElectionRevision.Timeline'
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
        { id: userId, date: Date.now() }
      )) {
        activeKeys.push({
          key: key.PubKey as string,
          type: key.Type as UserKeyType,
          expiration: key.Expiration as Timestamp
        })
      }
      const user: User = {
        id: userDB.Id as string,
        name: userDB.Name as string,
        imageRef: parseJsonOr<ImageRef | undefined>(
          userDB.ImageRef,
          undefined,
          'User.ImageRef'
        ),
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
    throw new Error('Not implemented')
  }

  async openAuthority (
    authorityId: string,
    authority?: Authority
  ): Promise<IAuthorityEngine> {
    if (authority) {
      return new AuthorityEngine(authority, this.ctx)
    }
    try {
      const authorityDB = await this.ctx.db
        .prepare(
          'select Id, Name, DomainName, ImageRef from Authority where Id = :id'
        )
        .get({ id: authorityId })
      if (!authorityDB) throw new Error('Authority not found')
      const authority: Authority = {
        id: authorityDB.Id as string,
        name: authorityDB.Name as string,
        domainName: asText(authorityDB.DomainName, 'Authority.DomainName'),
        imageRef: parseJsonOr<ImageRef | undefined>(
          authorityDB.ImageRef,
          undefined,
          'Authority.ImageRef'
        )
      }
      return new AuthorityEngine(authority, this.ctx)
    } catch (err) {
      if (err instanceof QuereusError) {
        throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
      } else if (err instanceof MisuseError) {
        throw new Error(`API misuse: ${err.message}`)
      } else {
        throw new Error(`Unknown error opening authority: ${err}`)
      }
    }
  }

  async openElection (electionId: string): Promise<IElectionEngine> {
    throw new Error('Not implemented')
  }

  async pinAuthority (authority: Authority): Promise<void> {
    const pinnedAuthorities = await this.getPinnedAuthorities()
    const unique = Object.fromEntries(
      pinnedAuthorities.map((authority) => [authority.id, authority])
    )
    const appended = { ...unique, [authority.id]: authority }
    await this.localStorage.setItem(
      'pinnedAuthorities',
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
      await this.ctx.db.exec(
				`insert into ProposedNetwork
					(Name, ImageRef, Relays, TimestampAuthorities, NumberRequiredTSAs, ElectionType)
				values
					(:name, :imageRef, :relays, :timestampAuthorities, :numberRequiredTSAs, :electionType)`,
				{
				  name: revision.name,
				  imageRef: imageRefJson,
				  relays: relaysJson,
				  timestampAuthorities: timestampAuthoritiesJson,
				  numberRequiredTSAs: revision.policies.numberRequiredTSAs,
				  electionType: revision.policies.electionType
				}
      )
    } catch (error) {
      throw new Error('Failed to propose revision: ' + error)
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
    // over the digest. This method is the engine boundary; the caller
    // supplies the already-computed signature in the InviteAction.
    const slotCid = invite.invite.digest
    const invokedId =
      invite.userId ?? (invite.userInit ? crypto.randomUUID() : null)
    const resultDigest = invite.isAccepted
      ? JSON.stringify(invite.invokes)
      : null
    try {
      await this.ctx.db.exec(
				`insert into InviteResult (
					SlotCid,
					IsAccepted,
					Digest,
					InviteSignature,
					InvokedId
				)
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
          inviteSignature: invite.inviteSignature,
          invokedId
        }
      )
    } catch (err) {
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

  async unpinAuthority (authorityId: string): Promise<void> {
    const pinnedAuthorities = await this.getPinnedAuthorities()
    const filtered = pinnedAuthorities.filter(
      (authority) => authority.id !== authorityId
    )
    await this.localStorage.setItem('pinnedAuthorities', filtered)
  }
}
