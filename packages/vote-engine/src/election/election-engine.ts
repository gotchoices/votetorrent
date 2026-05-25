import { MisuseError, QuereusError } from '@quereus/quereus'
import { parseJsonOr } from '../utils.js'
import type { EngineContext } from '../types.js'
import type {
  Ballot,
  BallotDetails,
  BallotSummary,
  ElectionCore,
  ElectionDetails,
  ElectionEvent,
  ElectionRevision,
  ElectionRevisionInit,
  ElectionType,
  IElectionEngine,
  KeyholderInvite,
  Option,
  Question,
  Timestamp
} from '@votetorrent/vote-core'

// Phase 05 ELEC-03..08 — monotonic Tid counter for ElectionEngine batches.
// Same shape as NetworksEngine/UserEngine/ElectionsEngine. Re-evaluate at
// the v2 persistence milestone (PERSIST-01).
let nextTid = 1

/** Minimal Election identifier the engine is constructed against. */
export interface ElectionSubject {
  id: string
  authorityId: string
}

/**
 * ElectionEngine — Phase 05 (ELEC-03..ELEC-08) implementation.
 *
 * Constructed against a specific {@link ElectionSubject} (id + authorityId)
 * and the shared {@link EngineContext}. The IElectionEngine interface
 * declares `getElectionDetails`, `proposeRevision`, `proposeBallot`,
 * `inviteKeyholder`, `revokeKeyholder`, `getBallots`, `getBallotDetails`.
 *
 * The ROADMAP's narrative method names `addQuestion()` and `addOption()`
 * (ELEC-07 / ELEC-08) are not declared on `IElectionEngine` — Question
 * and Option rows live inside `Ballot.questions[].options[]` at the
 * domain-model layer. We expose `addQuestion()` and `addOption()` as
 * class-only methods so the requirements have a concrete entry point.
 *
 * Schema kept as-written. INSERT paths trip
 * [quereus#23](https://github.com/gotchoices/quereus/issues/23); QuestionType
 * enum membership trips [quereus#21](https://github.com/gotchoices/quereus/issues/21)
 * for any value other than the first row of the view ('select').
 */
export class ElectionEngine implements IElectionEngine {
  constructor (
    private readonly election: ElectionSubject,
    private readonly ctx: EngineContext
  ) {}

  /**
   * Read a Ballot row + assemble its full details. The schema stores
   * Question and Option rows in separate tables keyed by (BallotId, Code)
   * and (BallotId, QuestionCode, Code) respectively.
   */
  async getBallotDetails (id: string): Promise<BallotDetails> {
    try {
      const ballotRow = await this.ctx.db
        .prepare(
					`select Id, ElectionId, AuthorityId, Description, Districts
						from Ballot where Id = :ballotId`
        )
        .get({ ballotId: id })
      if (!ballotRow) {
        throw new Error(`Ballot ${id} not found`)
      }
      const questions: Question[] = []
      for await (const q of this.ctx.db.eval(
				`select Code, Title, Instructions, DependsOn, Type, OptionRange, ScoreRange,
					Grouping, Sequence, Required
					from Question where BallotId = :ballotId`,
        { ballotId: id }
      )) {
        const options: Option[] = []
        for await (const o of this.ctx.db.eval(
					`select Code, Sequence, Title, Details, InfoURL, Image, Video
						from Option where BallotId = :ballotId and QuestionCode = :code`,
          { ballotId: id, code: q.Code as string }
        )) {
          options.push({
            code: o.Code as string,
            title: o.Title as string,
            details: (o.Details as string | undefined) ?? undefined,
            infoURL: (o.InfoURL as string | undefined) ?? undefined,
            image: parseJsonOr(o.Image, undefined, 'Option.Image'),
            video: parseJsonOr(o.Video, undefined, 'Option.Video')
          })
        }
        questions.push({
          code: q.Code as string,
          title: q.Title as string,
          instructions: q.Instructions as string,
          dependsOn: parseJsonOr(q.DependsOn, undefined, 'Question.DependsOn'),
          options,
          type: q.Type as Question['type'],
          optionRange: parseJsonOr(
            q.OptionRange,
            undefined,
            'Question.OptionRange'
          ),
          scoreRange: parseJsonOr(
            q.ScoreRange,
            undefined,
            'Question.ScoreRange'
          ),
          group: (q.Grouping as string | undefined) ?? undefined,
          sequence: (q.Sequence as number | undefined) ?? undefined,
          required: (q.Required as boolean | undefined) ?? true
        })
      }
      const ballot: Ballot = {
        id: ballotRow.Id as string,
        electionId: ballotRow.ElectionId as string,
        authorityId: ballotRow.AuthorityId as string,
        description: ballotRow.Description as string,
        districts: parseJsonOr<string[]>(
          ballotRow.Districts,
          [],
          'Ballot.Districts'
        ),
        questions
      }
      return { ballot, proposed: undefined }
    } catch (err) {
      this.rethrow(err, 'getBallotDetails')
    }
  }

  async getBallots (): Promise<BallotSummary[]> {
    const out: BallotSummary[] = []
    try {
      for await (const row of this.ctx.db.eval(
				`select Id, ElectionId, AuthorityId from Ballot where ElectionId = :electionId`,
        { electionId: this.election.id }
      )) {
        out.push({
          id: row.Id as string,
          electionId: row.ElectionId as string,
          authorityId: row.AuthorityId as string
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getBallots')
    }
  }

  /**
   * ELEC-03 — JOIN Election with its current ElectionRevision. Falls back
   * to throwing if the Election row is missing. The current revision is
   * defined as the highest-Revision row in ElectionRevision for the
   * election; "proposed" is the ProposedElectionRevision row if one exists.
   */
  async getElectionDetails (): Promise<ElectionDetails> {
    try {
      const eRow = await this.ctx.db
        .prepare(
					`select Id, AuthorityId, Title, Date, RevisionDeadline, BallotDeadline, Type
						from Election where Id = :electionId`
        )
        .get({ electionId: this.election.id })
      if (!eRow) {
        throw new Error(`Election ${this.election.id} not found`)
      }
      const election: ElectionCore = {
        id: eRow.Id as string,
        authorityId: eRow.AuthorityId as string,
        title: eRow.Title as string,
        date: eRow.Date as number,
        revisionDeadline: eRow.RevisionDeadline as number,
        ballotDeadline: eRow.BallotDeadline as number,
        type: eRow.Type as ElectionType
      }

      // Current revision: highest Revision number.
      const revRow = await this.ctx.db
        .prepare(
					`select ElectionId, Revision, RevisionTimestamp, Tags, Instructions, Timeline, KeyholderThreshold
						from ElectionRevision
						where ElectionId = :electionId
						order by Revision desc
						limit 1`
        )
        .get({ electionId: this.election.id })
      if (!revRow) {
        throw new Error(
					`Election ${this.election.id} has no current revision`
        )
      }
      const current: ElectionRevision = {
        electionId: revRow.ElectionId as string,
        revision: revRow.Revision as number,
        revisionTimestamp: [revRow.RevisionTimestamp as Timestamp],
        tags: parseJsonOr<string[]>(revRow.Tags, [], 'ElectionRevision.Tags'),
        instructions: revRow.Instructions as string,
        keyholders: [], // Populated by the Keyholder/InviteSlot join in TEST-01.
        timeline: parseJsonOr<Record<ElectionEvent, number>>(
          revRow.Timeline,
          {} as Record<ElectionEvent, number>,
          'ElectionRevision.Timeline'
        ),
        keyholderThreshold: revRow.KeyholderThreshold as number
      }

      // Proposed revision (if any).
      const proposedRow = await this.ctx.db
        .prepare(
					`select ElectionId, Revision, RevisionTimestamp, Tags, Instructions, Timeline, KeyholderThreshold
						from ProposedElectionRevision
						where ElectionId = :electionId`
        )
        .get({ electionId: this.election.id })
      let proposed: ElectionDetails['proposed']
      if (proposedRow) {
        const proposedInit: ElectionRevisionInit = {
          electionId: proposedRow.ElectionId as string,
          revision: proposedRow.Revision as number,
          revisionTimestamp: proposedRow.RevisionTimestamp as Timestamp,
          tags: parseJsonOr<string[]>(
            proposedRow.Tags,
            [],
            'ProposedElectionRevision.Tags'
          ),
          instructions: proposedRow.Instructions as string,
          keyholders: [],
          timeline: parseJsonOr<Record<ElectionEvent, number>>(
            proposedRow.Timeline,
            {} as Record<ElectionEvent, number>,
            'ProposedElectionRevision.Timeline'
          ),
          keyholderThreshold: proposedRow.KeyholderThreshold as number
        }
        proposed = { proposed: proposedInit, signers: [] }
      }

      return { election, current, proposed }
    } catch (err) {
      this.rethrow(err, 'getElectionDetails')
    }
  }

  /**
   * ELEC-04 (helper, not on IElectionEngine) — return all
   * ElectionRevision rows for this election ordered by revision ascending.
   */
  async getRevisions (): Promise<ElectionRevision[]> {
    const out: ElectionRevision[] = []
    try {
      for await (const row of this.ctx.db.eval(
				`select ElectionId, Revision, RevisionTimestamp, Tags, Instructions, Timeline, KeyholderThreshold
					from ElectionRevision
					where ElectionId = :electionId
					order by Revision asc`,
        { electionId: this.election.id }
      )) {
        out.push({
          electionId: row.ElectionId as string,
          revision: row.Revision as number,
          revisionTimestamp: [row.RevisionTimestamp as Timestamp],
          tags: parseJsonOr<string[]>(row.Tags, [], 'ElectionRevision.Tags'),
          instructions: row.Instructions as string,
          keyholders: [],
          timeline: parseJsonOr<Record<ElectionEvent, number>>(
            row.Timeline,
            {} as Record<ElectionEvent, number>,
            'ElectionRevision.Timeline'
          ),
          keyholderThreshold: row.KeyholderThreshold as number
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getRevisions')
    }
  }

  /**
   * ELEC-05 — INSERT a ProposedElectionRevision row. The schema's
   * UserValid CHECK gates on an Officer with scope 'mel' + a non-expired
   * UserKey matching `context.UserKey` + SignatureValid.
   */
  async proposeRevision (revision: ElectionRevisionInit): Promise<void> {
    const tid = nextTid++
    const signerKey = this.ctx.user?.activeKeys?.[0]?.key ?? null
    try {
      await this.ctx.db.exec(
				`insert into ProposedElectionRevision (
					ElectionId,
					Revision,
					RevisionTimestamp,
					Tags,
					Instructions,
					Timeline,
					KeyholderThreshold
				)
				with context UserId = :userId, UserKey = :userKey, Signature = :signature, Tid = ${tid}, now = :now
				values (
					:electionId,
					:revision,
					:revisionTimestamp,
					:tags,
					:instructions,
					:timeline,
					:keyholderThreshold
				)`,
        {
          electionId: revision.electionId,
          revision: revision.revision,
          revisionTimestamp: revision.revisionTimestamp,
          tags: JSON.stringify(revision.tags),
          instructions: revision.instructions,
          timeline: JSON.stringify(revision.timeline),
          keyholderThreshold: revision.keyholderThreshold,
          userId: this.ctx.user?.id ?? null,
          userKey: signerKey,
          signature: null,
          now: Date.now()
        }
      )
    } catch (err) {
      this.rethrow(err, 'proposeRevision')
    }
  }

  /**
   * ELEC-06 — INSERT a ProposedBallot row. The schema's UserValid CHECK
   * gates on Officer scope 'ceb' + non-expired UserKey + SignatureValid.
   * The Ballot insert itself (via AdminSignature pipeline) lives downstream
   * once the proposal is accepted.
   */
  async proposeBallot (ballot: Ballot): Promise<void> {
    const tid = nextTid++
    const signerKey = this.ctx.user?.activeKeys?.[0]?.key ?? null
    try {
      await this.ctx.db.exec(
				`insert into ProposedBallot (
					Id,
					ElectionId,
					AuthorityId,
					Description,
					Districts
				)
				with context UserId = :userId, UserKey = :userKey, Signature = :signature, Tid = ${tid}, now = :now
				values (
					:id,
					:electionId,
					:authorityId,
					:description,
					:districts
				)`,
        {
          id: ballot.id,
          electionId: ballot.electionId,
          authorityId: ballot.authorityId,
          description: ballot.description,
          districts: JSON.stringify(ballot.districts),
          userId: this.ctx.user?.id ?? null,
          userKey: signerKey,
          signature: null,
          now: Date.now()
        }
      )
    } catch (err) {
      this.rethrow(err, 'proposeBallot')
    }
  }

  /**
   * ELEC-07 (class-only — not on IElectionEngine) — INSERT a
   * ProposedQuestion row. The QuestionType view ({select, rank, score,
   * text}) is checked at insert via `Type in (select Code from
   * QuestionType)`. Under [quereus#21](https://github.com/gotchoices/quereus/issues/21)
   * (VIEW union-all returns only the first row), any value other than
   * 'select' silently fails the CHECK.
   */
  async addQuestion (
    ballotId: string,
    question: Question
  ): Promise<void> {
    const tid = nextTid++
    const signerKey = this.ctx.user?.activeKeys?.[0]?.key ?? null
    try {
      await this.ctx.db.exec(
				`insert into ProposedQuestion (
					BallotId,
					Code,
					Title,
					Instructions,
					DependsOn,
					Type,
					OptionRange,
					ScoreRange,
					Grouping,
					Sequence,
					Required
				)
				with context UserId = :userId, UserKey = :userKey, Signature = :signature, Tid = ${tid}, now = :now
				values (
					:ballotId,
					:code,
					:title,
					:instructions,
					:dependsOn,
					:type,
					:optionRange,
					:scoreRange,
					:grouping,
					:sequence,
					:required
				)`,
        {
          ballotId,
          code: question.code,
          title: question.title,
          instructions: question.instructions,
          dependsOn: question.dependsOn
            ? JSON.stringify(question.dependsOn)
            : null,
          type: question.type,
          optionRange: question.optionRange
            ? JSON.stringify(question.optionRange)
            : null,
          scoreRange: question.scoreRange
            ? JSON.stringify(question.scoreRange)
            : null,
          grouping: question.group ?? null,
          sequence: question.sequence ?? null,
          required: question.required ?? true,
          userId: this.ctx.user?.id ?? null,
          userKey: signerKey,
          signature: null,
          now: Date.now()
        }
      )
    } catch (err) {
      this.rethrow(err, 'addQuestion')
    }
  }

  /**
   * ELEC-08 (class-only — not on IElectionEngine) — INSERT a
   * ProposedOption row.
   */
  async addOption (
    ballotId: string,
    questionCode: string,
    option: Option,
    sequence: number
  ): Promise<void> {
    const tid = nextTid++
    const signerKey = this.ctx.user?.activeKeys?.[0]?.key ?? null
    try {
      await this.ctx.db.exec(
				`insert into ProposedOption (
					BallotId,
					QuestionCode,
					Code,
					Sequence,
					Title,
					Details,
					InfoURL,
					Image,
					Video
				)
				with context UserId = :userId, UserKey = :userKey, Signature = :signature, Tid = ${tid}, now = :now
				values (
					:ballotId,
					:questionCode,
					:code,
					:sequence,
					:title,
					:details,
					:infoURL,
					:image,
					:video
				)`,
        {
          ballotId,
          questionCode,
          code: option.code,
          sequence,
          title: option.title,
          details: option.details ?? null,
          infoURL: option.infoURL ?? null,
          image: option.image ? JSON.stringify(option.image) : null,
          video: option.video ? JSON.stringify(option.video) : null,
          userId: this.ctx.user?.id ?? null,
          userKey: signerKey,
          signature: null,
          now: Date.now()
        }
      )
    } catch (err) {
      this.rethrow(err, 'addOption')
    }
  }

  /**
   * ELEC-06b — INSERT a Keyholder row tied to (ElectionId, ElectionRevision,
   * UserId). The schema's Keyholder.InsertValid requires the per-row
   * Signing context fields to be null (Keyholder rows are inserted
   * post-signing, not as part of the AdminSignature pipeline).
   */
  async inviteKeyholder (
    keyholder: KeyholderInvite,
    electionId: string
  ): Promise<void> {
    const tid = nextTid++
    // The KeyholderInvite carries the invite details; the Keyholder row
    // itself is bound to the invited user once they accept. For Phase 5
    // this method inserts a placeholder Keyholder row pinned to the
    // election + the inviting user; the full flow with InviteSlot +
    // InviteResult joining happens in Phase 6 / TEST-01.
    const userId =
      this.ctx.user?.id ?? `pending-${keyholder.inviteKey.slice(0, 8)}`
    try {
      await this.ctx.db.exec(
				`insert into Keyholder (
					ElectionId,
					ElectionRevision,
					UserId
				)
				with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
				values (:electionId, :revision, :userId)`,
        {
          electionId,
          revision: 0,
          userId
        }
      )
    } catch (err) {
      this.rethrow(err, 'inviteKeyholder')
    }
  }

  /**
   * DELETE a Keyholder row. Schema's `check on delete` constraints on
   * downstream-related tables trip quereus#23 today.
   */
  async revokeKeyholder (
    keyholder: KeyholderInvite,
    electionId: string
  ): Promise<void> {
    const tid = nextTid++
    try {
      await this.ctx.db.exec(
				`delete from Keyholder
					with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
					where ElectionId = :electionId and UserId = :userId`,
        {
          electionId,
          userId: this.ctx.user?.id ?? ''
        }
      )
    } catch (err) {
      this.rethrow(err, 'revokeKeyholder')
    }
  }

  // ---------- helpers ----------

  private rethrow (err: unknown, method: string): never {
    if (err instanceof QuereusError) {
      throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
    } else if (err instanceof MisuseError) {
      throw new Error(`API misuse: ${err.message}`)
    } else if (err instanceof Error) {
      throw new Error(`ElectionEngine.${method}: ${err.message}`)
    } else {
      throw new Error(`ElectionEngine.${method}: unknown error: ${String(err)}`)
    }
  }
}
