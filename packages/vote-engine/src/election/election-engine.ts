import { MisuseError, QuereusError } from '@quereus/quereus'
import { formatPgRange, fromCanonicalDatetime, nowCanonicalDatetime, parseJsonOr, parsePgRange } from '../utils.js'
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
  IElectionInviteKeyholderBuilder,
  IElectionProposeBallotBuilder,
  IElectionProposeRevisionBuilder,
  IElectionRevokeKeyholderBuilder,
  KeyholderInvite,
  Option,
  Question,
  Timestamp
} from '@votetorrent/vote-core'
import { ElectionProposeBallotBuilder } from './builders/election-propose-ballot-builder.js'
import { ElectionProposeRevisionBuilder } from './builders/election-propose-revision-builder.js'
import { ElectionInviteKeyholderBuilder } from './builders/election-invite-keyholder-builder.js'
import { ElectionRevokeKeyholderBuilder } from './builders/election-revoke-keyholder-builder.js'

// Phase 05 ELEC-03..08 — monotonic Tid counter for ElectionEngine batches.
// Same shape as NetworksEngine/UserEngine/ElectionsEngine. Re-evaluate at
// the v2 persistence milestone (PERSIST-01).
let nextTid = 1

/**
 * Fixed ballot-header Tid for the `AdminSigning` digest at submit time.
 *
 * There is NO persisted Tid/Sequence column on `Task` or `AdminSigning`
 * (Task's Tid is write-context only; AdminSigning persists only the computed
 * Digest). The Tid baked into the ballot-header digest therefore CANNOT be
 * read back at finalize.
 *
 * Mechanism: use a fixed JS-number constant — exactly the proven `seedBallot`
 * spine (`Digest(1, …)` at test-context.ts:726 / `Tid = 1` at :754).
 * 31-03 imports and reuses this same constant so submit and finalize produce
 * the same byte-identical digest. Bind as a JS NUMBER (never String()):
 * canonical Digest uses TAG_INT; String() would create a TEXT tag and the
 * digest would not match (Pitfall 2 / test-context.ts:227).
 */
export const BALLOT_HEADER_TID = 1

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
      // Try finalized Ballot first; fall back to ProposedBallot for proposed-only Ids.
      let ballotRow = await this.ctx.db
        .prepare(
					`select Id, ElectionId, AuthorityId, Description, Districts
						from Ballot where Id = :ballotId`
        )
        .get({ ballotId: id })
      if (!ballotRow) {
        ballotRow = await this.ctx.db
          .prepare(
						`select Id, ElectionId, AuthorityId, Description, Districts, Questions
							from ProposedBallot where Id = :ballotId`
          )
          .get({ ballotId: id })
      }
      if (!ballotRow) {
        throw new Error(`Ballot ${id} not found`)
      }

      // For a ProposedBallot row, questions are stored as a JSON blob in the
      // Questions column (the ProposedQuestion table's BallotIdValid constraint
      // references the finalized Ballot table, making per-row inserts unusable
      // during the proposed phase). For a finalized Ballot row the Questions
      // column is absent, so we fall through to the per-row Question table query.
      const isProposed = ballotRow.Questions !== undefined

      const questions: Question[] = []

      if (isProposed) {
        // Read questions from the JSON blob stored in ProposedBallot.Questions.
        const parsed = parseJsonOr<Question[]>(ballotRow.Questions, [], 'ProposedBallot.Questions')
        questions.push(...parsed)
      } else {
        // For finalized ballots, ProposedBallot is retained (D-04) and its Questions
        // JSON is the option fallback when Option table rows are absent. This handles
        // the Quereus 3.3.0 deferred-constraint bug that prevents Option INSERT
        // (Option.MutationValid's 3-table EXISTS subquery always returns false in the
        // deferred evaluator even when the identical standalone SELECT returns true).
        // Once the Quereus bug is fixed, Option INSERTs will be restored in
        // finalizeBallot and this fallback becomes a harmless no-op.
        const pbFallbackRow = await this.ctx.db
          .prepare(
            `select Questions from ProposedBallot where Id = :ballotId`
          )
          .get({ ballotId: id })
        const pbQuestions = pbFallbackRow
          ? parseJsonOr<Question[]>(pbFallbackRow.Questions, [], 'ProposedBallot.Questions')
          : []
        const pbQuestionsByCode = new Map(pbQuestions.map(pq => [pq.code, pq]))

        // Collect all Question rows first (avoids nested concurrent Quereus cursors
        // on the same DB connection — a second eval() opened inside a for-await loop
        // deadlocks in Quereus 3.3.0 when both cursors share the same DB handle).
        type RawQuestion = Record<string, unknown>
        const rawQuestions: RawQuestion[] = []
        for await (const q of this.ctx.db.eval(
				`select Code, Title, Instructions, DependsOn, Type, OptionRange, ScoreRange,
					Grouping, Sequence, Required
					from Question where BallotId = :ballotId`,
          { ballotId: id }
        )) {
          rawQuestions.push(q as RawQuestion)
        }

        // Now iterate raw rows sequentially — outer cursor is fully consumed so
        // Option cursor can open without Quereus concurrency issues.
        for (const q of rawQuestions) {
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
          // Fallback: if Option table has no rows (Quereus 3.3.0 deferred-constraint
          // bug prevents insertion), read options from ProposedBallot.Questions JSON.
          if (options.length === 0) {
            const pbQ = pbQuestionsByCode.get(q.Code as string)
            if (pbQ?.options) {
              for (const o of pbQ.options) {
                options.push({
                  code: o.code,
                  title: o.title,
                  details: o.details,
                  infoURL: o.infoURL,
                  image: o.image,
                  video: o.video,
                })
              }
            }
          }
          questions.push({
            code: q.Code as string,
            title: q.Title as string,
            instructions: q.Instructions as string,
            dependsOn: parseJsonOr(q.DependsOn, undefined, 'Question.DependsOn'),
            options,
            type: q.Type as Question['type'],
            // OptionRange and ScoreRange are stored in PostgreSQL range notation
            // `{min, max}`, NOT as JSON — use parsePgRange, not parseJsonOr.
            optionRange: parsePgRange(q.OptionRange, 'Question.OptionRange'),
            scoreRange: parsePgRange(q.ScoreRange, 'Question.ScoreRange') as { min: number; max: number; step: number } | undefined,
            group: (q.Grouping as string | undefined) ?? undefined,
            sequence: (q.Sequence as number | undefined) ?? undefined,
            required: (q.Required as boolean | undefined) ?? true
          })
        }
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
    // Build a Map keyed by Id — finalized Ballot rows take precedence over
    // ProposedBallot rows (schema note qsql:695: ProposedBallot.Id may equal
    // a finalized Ballot.Id, so de-dup is required).
    const byId = new Map<string, BallotSummary>()
    try {
      // Seed with finalized Ballot rows.
      for await (const row of this.ctx.db.eval(
				`select Id, ElectionId, AuthorityId from Ballot where ElectionId = :electionId`,
        { electionId: this.election.id }
      )) {
        const id = row.Id as string
        byId.set(id, {
          id,
          electionId: row.ElectionId as string,
          authorityId: row.AuthorityId as string
        })
      }
      // Add ProposedBallot rows only if Id is not already present (finalized preferred).
      for await (const row of this.ctx.db.eval(
				`select Id, ElectionId, AuthorityId from ProposedBallot where ElectionId = :electionId`,
        { electionId: this.election.id }
      )) {
        const id = row.Id as string
        if (!byId.has(id)) {
          byId.set(id, {
            id,
            electionId: row.ElectionId as string,
            authorityId: row.AuthorityId as string
          })
        }
      }
      return [...byId.values()]
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
        date: fromCanonicalDatetime(eRow.Date as string),
        revisionDeadline: fromCanonicalDatetime(eRow.RevisionDeadline as string),
        ballotDeadline: fromCanonicalDatetime(eRow.BallotDeadline as string),
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
        revisionTimestamp: [fromCanonicalDatetime(revRow.RevisionTimestamp as string)],
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
          revisionTimestamp: fromCanonicalDatetime(proposedRow.RevisionTimestamp as string),
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
          revisionTimestamp: [fromCanonicalDatetime(row.RevisionTimestamp as string)],
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
				with context UserId = :userId, UserKey = :userKey, Signature = :signature, Tid = ${tid}, now = :now, IsUserValid = true
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
          now: nowCanonicalDatetime()
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
				`insert or replace into ProposedBallot (
					Id,
					ElectionId,
					AuthorityId,
					Description,
					Districts,
					Questions
				)
				with context UserId = :userId, UserKey = :userKey, Signature = :signature, Tid = ${tid}, now = :now, IsUserValid = true
				values (
					:id,
					:electionId,
					:authorityId,
					:description,
					:districts,
					:questions
				)`,
        {
          id: ballot.id,
          electionId: ballot.electionId,
          authorityId: ballot.authorityId,
          description: ballot.description,
          districts: JSON.stringify(ballot.districts),
          questions: ballot.questions && ballot.questions.length > 0
            ? JSON.stringify(ballot.questions)
            : null,
          userId: this.ctx.user?.id ?? null,
          userKey: signerKey,
          signature: null,
          now: nowCanonicalDatetime()
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
   * QuestionType)`.
   *
   * D-04 (Phase 34-03): OptionRange and Required are conditionally omitted
   * from the INSERT column list when the caller supplies no value. Binding
   * explicit `null` to columns declared `default X` (without a `null`
   * keyword) triggers NOT NULL on quereus 4.x; omitting them lets the DB
   * default apply. ProposedQuestion has no Digest(...) CHECKs, so this
   * change is Digest-byte-safe.
   * See: https://github.com/gotchoices/quereus/issues/26
   */
  async addQuestion (
    ballotId: string,
    question: Question
  ): Promise<void> {
    const tid = nextTid++
    const signerKey = this.ctx.user?.activeKeys?.[0]?.key ?? null

    // Build column list and params for columns with DB defaults that must not
    // receive an explicit null bind (Rule: never bind null to a `default X`
    // column without a `null` keyword — omit the column so the DB default
    // applies). Each optional column is described by a single { col, ph, key,
    // val } descriptor so the column name, placeholder, and param key cannot
    // drift apart (WR-02).
    //
    // OptionRange is written in PostgreSQL range notation (`{min, max}`) via
    // formatPgRange, NOT JSON — the canonical read path (getBallotDetails →
    // parsePgRange) and the DB default `'{1, 1}'` both use range notation, so
    // a JSON encoding would be unreadable on the way back out (WR-01).
    const optional = ([
      question.optionRange != null && {
        col: 'OptionRange', ph: ':optionRange', key: 'optionRange', val: formatPgRange(question.optionRange)
      },
      question.required != null && {
        col: 'Required', ph: ':required', key: 'required', val: question.required
      }
    ].filter(Boolean) as Array<{ col: string; ph: string; key: string; val: unknown }>)

    const extraParams: Record<string, unknown> = {}
    for (const o of optional) extraParams[o.key] = o.val

    const baseCols = ['BallotId', 'Code', 'Title', 'Instructions', 'DependsOn', 'Type', 'ScoreRange', 'Grouping', 'Sequence']
    const baseVals = [':ballotId', ':code', ':title', ':instructions', ':dependsOn', ':type', ':scoreRange', ':grouping', ':sequence']
    const colList = [...baseCols, ...optional.map(o => o.col)].join(',\n\t\t\t\t\t')
    const valList = [...baseVals, ...optional.map(o => o.ph)].join(',\n\t\t\t\t\t')

    try {
      await this.ctx.db.exec(
				`insert into ProposedQuestion (
					${colList}
				)
				with context UserId = :userId, UserKey = :userKey, Signature = :signature, Tid = ${tid}, now = :now, IsMutationValid = true
				values (
					${valList}
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
          scoreRange: question.scoreRange
            ? JSON.stringify(question.scoreRange)
            : null,
          grouping: question.group ?? null,
          sequence: question.sequence ?? null,
          userId: this.ctx.user?.id ?? null,
          userKey: signerKey,
          signature: null,
          now: nowCanonicalDatetime(),
          ...extraParams
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
				with context UserId = :userId, UserKey = :userKey, Signature = :signature, Tid = ${tid}, now = :now, IsMutationValid = true
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
          now: nowCanonicalDatetime()
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

  // ---------- confirm-path methods (31-02 implementation) ----------

  /**
   * D-03/D-07/D-06 — Submit a ProposedBallot for authority confirmation.
   *
   * 1. Read the ProposedBallot row.
   * 2. Re-validate ballot invariants (D-07): non-empty description, ≥1 question,
   *    ≥2 options for 'select'-type questions. Throw before any write on failure.
   * 3. Resolve AdminEffectiveAt from CurrentAdmin.
   * 4. Insert an UNSIGNED AdminSigning('ceb') with the canonical ballot-header
   *    digest. Uses BALLOT_HEADER_TID (a fixed constant, not nextTid++) so
   *    31-03's finalize can reproduce the identical digest without reading Tid
   *    from any persisted column (Pitfall 2). Do NOT call sign() here — the
   *    AdminSigning must stay unsigned until completeSignature (Pitfall 1).
   * 5. Atomically BEGIN → Task(signature/ballot) → BallotSignatureTaskExtension → COMMIT.
   *    BallotSignatureTaskExtension.MutationValid recomputes Digest(BALLOT_HEADER_TID, …)
   *    from ProposedBallot and must match the AdminSigning.Digest inserted above.
   *
   * D-06: no distinct-signer check — self-confirm is the intended single-authority path.
   */
  async submitBallotForConfirmation (ballotId: string): Promise<void> {
    try {
      // Step 1: read the ProposedBallot row
      const ballotRow = await this.ctx.db
        .prepare(
          `select Id, ElectionId, AuthorityId, Description, Districts, Questions
           from ProposedBallot where Id = :ballotId`
        )
        .get({ ballotId }) as {
          Id: string
          ElectionId: string
          AuthorityId: string
          Description: string
          Districts: string
          Questions: string | null
        } | undefined

      if (!ballotRow) {
        throw new Error(`ProposedBallot not found: ${ballotId}`)
      }

      // Step 2: re-validate invariants (D-07)
      // 2a. Non-empty description
      if (typeof ballotRow.Description !== 'string' || ballotRow.Description.trim() === '') {
        throw new Error('submitBallotForConfirmation: ballot description must be non-empty (D-07)')
      }

      // 2b. Parse questions and check ≥1 question
      const questions: Question[] = parseJsonOr(ballotRow.Questions, [], 'Questions')
      if (!Array.isArray(questions) || questions.length === 0) {
        throw new Error('submitBallotForConfirmation: ballot must have at least one question (D-07)')
      }

      // 2c. ≥2 options for 'select'-type questions
      for (const q of questions) {
        if (q.type === 'select') {
          if (!Array.isArray(q.options) || q.options.length < 2) {
            throw new Error(
              `submitBallotForConfirmation: select question "${q.code}" must have at least 2 options (D-07)`
            )
          }
        }
      }

      // Step 3: resolve AdminEffectiveAt from CurrentAdmin
      const adminRow = await this.ctx.db
        .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
        .get({ authorityId: this.election.authorityId }) as { EffectiveAt: number | string } | undefined

      if (!adminRow) {
        throw new Error('submitBallotForConfirmation: CurrentAdmin not found for authority')
      }
      const adminEffectiveAt = adminRow.EffectiveAt

      // Prepare signing-session values
      const nonce = (globalThis as { crypto: { randomUUID: () => string } }).crypto.randomUUID()
      const userId = this.ctx.user?.id ?? null
      // Placeholder key/sig values — the AdminSigning schema gates on IsSignerKeyValid and
      // IsSignatureValid context flags (which we set to true); real crypto is provided at
      // completeSignature (31-03). The AdminSigning.Signature column is NOT NULL, so we
      // need a non-null placeholder — mirroring the pattern in elections-engine.ts:810-811.
      const signerKey = this.ctx.user?.activeKeys?.[0]?.key ?? '0'.repeat(66)
      const placeholderSig = '0'.repeat(128)
      const now = nowCanonicalDatetime()

      // Task + extension use nextTid++ (per-write in-memory counter, per this file's convention)
      // but the header digest is pinned to BALLOT_HEADER_TID (the fixed constant, not nextTid++)
      const taskTid = nextTid++
      const taskId = (globalThis as { crypto: { randomUUID: () => string } }).crypto.randomUUID()

      // Step 4: insert UNSIGNED AdminSigning('ceb') — do NOT call sign() (Pitfall 1)
      // Bind Description and Districts from the ProposedBallot row so submit and
      // finalize produce byte-identical digests (Pitfall 2).
      // Bind BALLOT_HEADER_TID as a JS number (never String()) — TAG_INT vs TEXT (Pitfall 2).
      await this.ctx.db.exec(
        `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
         with context now = :now, IsSignatureValid = true, IsSignerKeyValid = true
         values (:nonce, :authorityId, :adminEffectiveAt, 'ceb',
                 Digest(:headerTid, :id, :electionId, :authorityId, :description, :districts),
                 :userId, :signerKey, :signature)`,
        {
          nonce,
          authorityId: this.election.authorityId,
          adminEffectiveAt,
          headerTid: BALLOT_HEADER_TID,
          id: ballotRow.Id,
          electionId: ballotRow.ElectionId,
          description: ballotRow.Description,
          districts: ballotRow.Districts,
          userId,
          signerKey,
          signature: placeholderSig,
          now,
        }
      )

      // Step 5: atomically insert Task + BallotSignatureTaskExtension
      // BallotSignatureTaskExtension.MutationValid recomputes Digest(context.Tid, …) from
      // ProposedBallot and must match AdminSigning.Digest — pass BALLOT_HEADER_TID as context.Tid.
      await this.ctx.db.exec('BEGIN')
      try {
        await this.ctx.db.exec(
          `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
           with context IsMutationValid = true, Tid = :tid
           values (:id, :userId, 'signature', 'ballot', :nonce, 0)`,
          { id: taskId, userId, nonce, tid: taskTid }
        )
        await this.ctx.db.exec(
          `insert into BallotSignatureTaskExtension (TaskId, BallotId)
           with context Tid = :tid
           values (:taskId, :ballotId)`,
          { taskId, ballotId, tid: BALLOT_HEADER_TID }
        )
        await this.ctx.db.exec('COMMIT')
      } catch (err) {
        await this.ctx.db.exec('ROLLBACK')
        throw err
      }
    } catch (err) {
      this.rethrow(err, 'submitBallotForConfirmation')
    }
  }

  /**
   * D-05 — Withdraw a pending ballot confirmation, deleting the Task and
   * BallotSignatureTaskExtension so the ProposedBallot becomes editable again.
   *
   * Delete order: Task first, then BallotSignatureTaskExtension.
   * `BallotSignatureTaskExtension.DeleteValid` passes when the Task does NOT
   * exist OR the Task is completed — so deleting the Task first satisfies the
   * "not exists Task" condition, making the extension delete pass.
   *
   * The orphaned UNSIGNED AdminSigning row is left in place (harmless — no
   * AdminSignature will ever reference it once the Task is gone).
   */
  async withdrawBallotConfirmation (ballotId: string): Promise<void> {
    try {
      const userId = this.ctx.user?.id ?? null
      const tid = nextTid++

      await this.ctx.db.exec('BEGIN')
      try {
        // Delete Task first (makes DeleteValid pass on the extension — "not exists Task")
        await this.ctx.db.exec(
          `delete from Task
           where Id in (
             select T.Id from Task T
               join BallotSignatureTaskExtension B on B.TaskId = T.Id
               where B.BallotId = :ballotId
                 and T.UserId = :userId
                 and T.Type = 'signature'
                 and T.SignatureType = 'ballot'
                 and T.IsCompleted = 0
           )`,
          { ballotId, userId }
        )

        // Delete extension (now passes DeleteValid because Task no longer exists)
        await this.ctx.db.exec(
          `delete from BallotSignatureTaskExtension
           where BallotId = :ballotId`,
          { ballotId, tid }
        )

        await this.ctx.db.exec('COMMIT')
      } catch (err) {
        await this.ctx.db.exec('ROLLBACK')
        throw err
      }
    } catch (err) {
      this.rethrow(err, 'withdrawBallotConfirmation')
    }
  }

  /**
   * D-05/D-09 — Report the lock and confirmed state of a ProposedBallot.
   *
   * `locked` = a pending (IsCompleted=0) ballot Task exists.
   * `confirmed` = a finalized Ballot row exists for this id.
   */
  async getBallotConfirmationState (ballotId: string): Promise<{ locked: boolean; confirmed: boolean }> {
    try {
      const lockRow = await this.ctx.db
        .prepare(
          `select 1 as exists_ from Task T
             join BallotSignatureTaskExtension B on B.TaskId = T.Id
             where B.BallotId = :ballotId
               and T.Type = 'signature'
               and T.SignatureType = 'ballot'
               and T.IsCompleted = 0`
        )
        .get({ ballotId })

      const confirmedRow = await this.ctx.db
        .prepare('select 1 as exists_ from Ballot where Id = :ballotId')
        .get({ ballotId })

      return {
        locked: lockRow !== undefined,
        confirmed: confirmedRow !== undefined,
      }
    } catch (err) {
      this.rethrow(err, 'getBallotConfirmationState')
    }
  }

  // ---------- builder factories ----------

  buildProposeBallot (): IElectionProposeBallotBuilder {
    return new ElectionProposeBallotBuilder(this)
  }

  buildProposeRevision (): IElectionProposeRevisionBuilder {
    return new ElectionProposeRevisionBuilder(this)
  }

  buildInviteKeyholder (): IElectionInviteKeyholderBuilder {
    return new ElectionInviteKeyholderBuilder(this)
  }

  buildRevokeKeyholder (): IElectionRevokeKeyholderBuilder {
    return new ElectionRevokeKeyholderBuilder(this)
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
