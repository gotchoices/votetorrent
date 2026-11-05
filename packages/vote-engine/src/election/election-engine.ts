import { rethrow as rethrowHelper } from '../signing/ceremony-helpers.js'
import type { SqlValue } from '@quereus/quereus'
import { findDuplicateKeyholderName, normalizeKeyholderName, KEYHOLDER_INVITE_MAX_LIFETIME_MS, KEYHOLDER_INVITE_EXPIRY_SKEW_MS } from './keyholder-names.js'
import { digestToBytes, formatPgRange, fromCanonicalDatetime, keyholderInviteSignedBytes, nowCanonicalDatetime, parseJsonOr, parseKeyholdersAsInviteStatus, parsePgRange, parseScoreRange, formatScoreRange, verifyAdHocInviteSignature } from '../utils.js'
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
  InviteSentState,
  InviteStatus,
  ISigningEngine,
  KeyholderInvite,
  Option,
  Question,
  SentKeyholderInvite,
  Signature,
  Timestamp
} from '@votetorrent/vote-core'
import { ElectionProposeBallotBuilder } from './builders/election-propose-ballot-builder.js'
import { ElectionProposeRevisionBuilder } from './builders/election-propose-revision-builder.js'
import { ElectionInviteKeyholderBuilder } from './builders/election-invite-keyholder-builder.js'
import { ElectionRevokeKeyholderBuilder } from './builders/election-revoke-keyholder-builder.js'
import { allocateTid } from '../database/tid-allocator.js'
import { readInviteChain } from '../invite/read-invite-chain.js'
import { verifyUserKeyMembership } from '../user/verify-user-key.js'
import { SigningEngine } from '../signing/signing-engine.js'
import { fanOutSignatureTasks } from '../signing/fan-out.js'
import { readAuthorityThreshold, listCurrentScopeHolders } from '../signing/threshold.js'

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

/**
 * 62-84 (CR-01, D-14, D-27): rank of a keyholder invitation chain's sent state. Every chain sent to one
 * keyholder name is ranked and the most useful one is reported first, so "send again" (a second chain under a
 * new InviteKey) reads Sent whichever InviteSlot Cid sorts first. answered and live are decided facts and win.
 * 'unknown' (an ambiguous chain, or an unreadable invitation table) outranks no-longer-valid on purpose: an
 * ambiguous chain may be live, and reporting it as dead would invite a duplicate resend. Ties break on the
 * latest expiration.
 * 62 CR-01: 'declined' (a signed no) ranks BELOW live, so "send again" after a decline reads Sent, and above
 * unknown / no-longer-valid, so a decline with no newer live chain reads Declined instead of being hidden by a
 * dead or ambiguous chain of the same name. 'answered' is an acceptance only and still wins over everything.
 * 62-139: 'accepted-earlier-revision' (an acceptance whose acceptor has Keyholder rows only in revisions before the
 * one being projected) is only read for the revision's own projection (never for a history revision that the
 * acceptance belongs to or precedes) and ranks with 'declined', below a new live invitation.
 */
const SENT_STATE_RANK: Record<InviteSentState['state'], number> = {
  answered: 5,
  live: 4,
  declined: 3,
  // 62-139: equal rank with declined, so compareSentStates' later expiration decides between the two latest
  // answers (a newer decline outranks an older earlier-revision acceptance and vice versa).
  'accepted-earlier-revision': 3,
  unknown: 2,
  'no-longer-valid': 1
}

/** Expiration as epoch ms for ranking; an empty or unparseable value sorts last (never throws). */
function sentExpirationMs (expiration: string): number {
  if (!expiration) return Number.NEGATIVE_INFINITY
  const ms = fromCanonicalDatetime(expiration)
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms
}

function compareSentStates (a: InviteSentState, b: InviteSentState): number {
  const byRank = SENT_STATE_RANK[b.state] - SENT_STATE_RANK[a.state]
  if (byRank !== 0) return byRank
  const am = sentExpirationMs(a.expiration)
  const bm = sentExpirationMs(b.expiration)
  if (am === bm) return 0
  return bm > am ? 1 : -1
}

const PEER_UNAVAILABLE_ERROR_NAMES = new Set(['BlockUnavailableError', 'BlockPossiblyStaleError'])
const PEER_UNAVAILABLE_MESSAGE = /\bBlock \S+ (is unavailable \(|may be stale:)/

/**
 * 62-84 (D-23, gap 7): structural match for an optimystic peer-read failure (the repo could not serve a block
 * while peered). vote-engine does not import the @optimystic/db-core classes, so this matches by error name
 * or by the two message shapes, on the error itself or up to five `cause` levels below it (the quereus vtab
 * may wrap it). Returns the matched error's name, or undefined for any other error.
 */
function isPeerReadUnavailable (err: unknown): string | undefined {
  let cur: unknown = err
  for (let depth = 0; depth <= 5 && cur !== null && typeof cur === 'object'; depth++) {
    const name = (cur as { name?: unknown }).name
    const message = (cur as { message?: unknown }).message
    if (typeof name === 'string' && PEER_UNAVAILABLE_ERROR_NAMES.has(name)) return name
    if (typeof message === 'string' && PEER_UNAVAILABLE_MESSAGE.test(message)) {
      return typeof name === 'string' && name ? name : 'Error'
    }
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}

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
    private readonly ctx: EngineContext,
    private readonly signingEngine: ISigningEngine = new SigningEngine(ctx)
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
            scoreRange: parseScoreRange(q.ScoreRange, 'Question.ScoreRange'),
            group: (q.Grouping as string | undefined) ?? undefined,
            sequence: (q.Sequence as number | undefined) ?? undefined,
            // Required is now `integer default 1` (37-04 / D-05b re-attach fix —
            // was `boolean default true`, which broke quereus-4.x re-attach
            // reconcile). Coerce the persisted 0/1 integer to boolean; null/
            // undefined preserves the historical default-true.
            required: q.Required == null ? true : !!Number(q.Required)
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
				`select Id, ElectionId, AuthorityId, Description from Ballot where ElectionId = :electionId`,
        { electionId: this.election.id }
      )) {
        const id = row.Id as string
        byId.set(id, {
          id,
          electionId: row.ElectionId as string,
          authorityId: row.AuthorityId as string,
          description: (row.Description as string) ?? ''
        })
      }
      // Add ProposedBallot rows only if Id is not already present (finalized preferred).
      for await (const row of this.ctx.db.eval(
				`select Id, ElectionId, AuthorityId, Description from ProposedBallot where ElectionId = :electionId`,
        { electionId: this.election.id }
      )) {
        const id = row.Id as string
        if (!byId.has(id)) {
          byId.set(id, {
            id,
            electionId: row.ElectionId as string,
            authorityId: row.AuthorityId as string,
            description: (row.Description as string) ?? ''
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
					`select ElectionId, Revision, RevisionTimestamp, Tags, Instructions, Timeline, KeyholderThreshold, Keyholders
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
      // D-27: keyholders are the persisted create-time invitee JSON joined
      // with the real Keyholder table, so accepted keyholders carry a result.
      const currentKeyholders = await this.readRevisionKeyholders(
        revRow.ElectionId as string,
        revRow.Revision as number,
        revRow.Keyholders,
        'ElectionRevision.Keyholders'
      )
      const current: ElectionRevision = {
        electionId: revRow.ElectionId as string,
        revision: revRow.Revision as number,
        revisionTimestamp: [fromCanonicalDatetime(revRow.RevisionTimestamp as string)],
        tags: parseJsonOr<string[]>(revRow.Tags, [], 'ElectionRevision.Tags'),
        instructions: revRow.Instructions as string,
        keyholders: currentKeyholders,
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
					`select ElectionId, Revision, RevisionTimestamp, Tags, Instructions, Timeline, KeyholderThreshold, Keyholders
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
          // 39-02 D-04 Gap 2: proposeRevision does not currently write this
          // column (out of this plan's Gap 1 scope) — falls back to [] via
          // the shared parser rather than a hardcoded literal.
          keyholders: parseJsonOr<KeyholderInvite[]>(proposedRow.Keyholders, [], 'ProposedElectionRevision.Keyholders'),
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
      // Collect all ElectionRevision rows first — do not run a nested
      // readRevisionKeyholders() query while this eval() cursor is still
      // open (a second concurrent cursor on the same DB handle deadlocks,
      // same pattern as getBallotDetails's Question/Option read above).
      type RawRevision = Record<string, unknown>
      const rawRows: RawRevision[] = []
      for await (const row of this.ctx.db.eval(
				`select ElectionId, Revision, RevisionTimestamp, Tags, Instructions, Timeline, KeyholderThreshold, Keyholders
					from ElectionRevision
					where ElectionId = :electionId
					order by Revision asc`,
        { electionId: this.election.id }
      )) {
        rawRows.push(row as RawRevision)
      }
      for (const row of rawRows) {
        // D-27: keyholders are the persisted invitee JSON joined with the
        // real Keyholder table, so accepted keyholders carry a result.
        const keyholders = await this.readRevisionKeyholders(
          row.ElectionId as string,
          row.Revision as number,
          row.Keyholders,
          'ElectionRevision.Keyholders'
        )
        out.push({
          electionId: row.ElectionId as string,
          revision: row.Revision as number,
          revisionTimestamp: [fromCanonicalDatetime(row.RevisionTimestamp as string)],
          tags: parseJsonOr<string[]>(row.Tags, [], 'ElectionRevision.Tags'),
          instructions: row.Instructions as string,
          keyholders,
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
   * UserValid CHECK is a dumb `context.IsUserValid` gate the engine computes
   * into. D-21 (Class B): this path carries no `Signature` argument
   * (`proposeRevision`'s own public signature has none), so `IsUserValid` is
   * bound to registered/unexpired UserKey membership only, via
   * `verifyUserKeyMembership` — not a signature verification. The caller
   * pre-signs through the AdminSigning/AdminSignature pipeline downstream.
   */
  async proposeRevision (revision: ElectionRevisionInit): Promise<void> {
    // 62-104 (IN-06): a keyholder slot binds to its invitee by name, so names are unique per election.
    // Refused before any Tid is reserved or row written.
    if (findDuplicateKeyholderName((revision.keyholders ?? []).map(k => k.name ?? '')) !== undefined) {
      throw Object.assign(new Error('Two keyholders on one election cannot share a name'), { code: 'duplicate-keyholder-name' })
    }
    const tid = await allocateTid(this.ctx.db, 'election')
    const userId = this.ctx.user?.id ?? null
    const signerKey = this.ctx.user?.activeKeys?.[0]?.key ?? null
    const membership = await verifyUserKeyMembership(this.ctx, userId, signerKey)
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
				with context UserId = :userId, UserKey = :userKey, Signature = :signature, Tid = ${tid}, now = :now, IsUserValid = :isUserValid
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
          userId,
          userKey: signerKey,
          signature: null,
          isUserValid: membership.valid,
          now: nowCanonicalDatetime()
        }
      )
    } catch (err) {
      this.rethrow(err, 'proposeRevision')
    }
  }

  /**
   * The ONE ballot lock read for proposeBallot, submitBallotForConfirmation and
   * getBallotConfirmationState (WR-04, 62-REVIEW.md). `open` = a ballot signature Task is still
   * open for this ballot; `confirmed` = a finalized Ballot row exists. A session that reached its
   * threshold but whose finalize failed keeps its Task open, so it is still `open` here and
   * therefore locked. Deliberately NO AdminSignature clause: an open sibling of a reached session
   * must also block an overwrite or a second submit.
   */
  private async readBallotLock (ballotId: string): Promise<{ open: boolean; confirmed: boolean }> {
    const openRow = await this.ctx.db
      .prepare(
        `select 1 as x from Task T join BallotSignatureTaskExtension B on B.TaskId = T.Id
         where B.BallotId = :ballotId and T.Type = 'signature' and T.SignatureType = 'ballot' and T.IsCompleted = 0`
      )
      .get({ ballotId })
    const confirmedRow = await this.ctx.db
      .prepare('select 1 as x from Ballot where Id = :ballotId')
      .get({ ballotId })
    return { open: openRow !== undefined, confirmed: confirmedRow !== undefined }
  }

  /**
   * ELEC-06 — INSERT a ProposedBallot row. The schema's UserValid CHECK is a
   * dumb `context.IsUserValid` gate the engine computes into. D-21 (Class B):
   * this path carries no `Signature` argument, so `IsUserValid` is bound to
   * registered/unexpired UserKey membership only, via
   * `verifyUserKeyMembership` — not a signature verification. The Ballot
   * insert itself (via AdminSignature pipeline) lives downstream once the
   * proposal is accepted.
   *
   * The engine, not only the UI, enforces the edit lock (CR-03, 62-REVIEW.md): a
   * ballot with an open signature session, or a finalized Ballot row, is refused
   * before any write. `insert or replace` remains the upsert for an unlocked ballot.
   */
  async proposeBallot (ballot: Ballot): Promise<void> {
    try {
      const lock = await this.readBallotLock(ballot.id)
      if (lock.confirmed) {
        throw new Error('This ballot is already confirmed and can no longer be edited.')
      }
      if (lock.open) {
        throw new Error('This ballot is out for confirmation and cannot be edited. Withdraw it first.')
      }
      const tid = await allocateTid(this.ctx.db, 'election')
      const userId = this.ctx.user?.id ?? null
      const signerKey = this.ctx.user?.activeKeys?.[0]?.key ?? null
      const membership = await verifyUserKeyMembership(this.ctx, userId, signerKey)
      await this.ctx.db.exec(
				`insert or replace into ProposedBallot (
					Id,
					ElectionId,
					AuthorityId,
					Description,
					Districts,
					Questions
				)
				with context UserId = :userId, UserKey = :userKey, Signature = :signature, Tid = ${tid}, now = :now, IsUserValid = :isUserValid
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
          userId,
          userKey: signerKey,
          signature: null,
          isUserValid: membership.valid,
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
    const tid = await allocateTid(this.ctx.db, 'election')
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
          // pg range notation via formatPgRange, not JSON (matches the OptionRange write above).
          scoreRange: question.scoreRange
            ? formatScoreRange(question.scoreRange)
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
    const tid = await allocateTid(this.ctx.db, 'election')
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
   * second-keyholder-invite-unique fix — INSERT a signed `InviteSlot`
   * (Type='k') for a keyholder invite and wire the admin-approval signing
   * ceremony (`SigningEngine.startSigningSession`), mirroring
   * `AuthorityEngine.saveOfficerInvite`/`saveAuthorityInvite` +
   * `saveInviteWithSigning`'s pipeline: nonce first, InviteSlot second,
   * AdminSigning/AdminSignature third.
   *
   * Fixes debug session `second-keyholder-invite-unique`: the prior
   * implementation inserted directly into `Keyholder` keyed by
   * `this.ctx.user?.id` (the INVITING admin's own id, constant across every
   * invite) with a hardcoded `revision: 0`, so a 2nd invite always collided
   * on `Keyholder`'s `(ElectionId, ElectionRevision, UserId)` primary key.
   * `Keyholder.UserIdValid` also requires an EXISTING `User` row, and
   * `User.InsertValid` requires a real `InviteSlot` + `InviteSignature` to
   * mint one — there is no schema-legal way to persist a name-only invitee
   * directly into `Keyholder`. The real `User` + `Keyholder` rows are now
   * minted at ACCEPT time (see `InvitationEngine.respondToInvite`'s
   * keyholder-invite branch), once a genuine `InviteSlot`/`InviteResult`
   * pair exists to satisfy those two CHECKs. This method only writes the
   * pending `InviteSlot` — it never touches `Keyholder` at send-time, and no
   * longer hardcodes `revision: 0` (the real current revision is instead
   * resolved FRESH at accept-time from `ElectionRevision`, keyed off the new
   * `InviteSlot.ElectionId` column this method now populates).
   *
   * Scope: 'ik' (Invite Keyholders) — a dedicated admin-approval scope,
   * mirroring 'iad'/'rad' for authority/officer invites.
   *
   * `signatureOrCallback` mirrors `AuthorityEngine.saveInviteWithSigning`:
   * either a completed `Signature` (test fixtures) or a device-signer
   * callback invoked with the engine-computed `Digest(Cid)` bytes (the
   * caller's private key never crosses into vote-engine).
   *
   * `keyholder.inviteSignature` (the invite's OWN ad-hoc signature, distinct
   * from `signatureOrCallback` above) is verified for real when non-empty;
   * an empty value is a documented, narrow carve-out (see
   * `keyholderInviteSignedBytes` doc comment / `KeyholderInvitationScreen.tsx`
   * WR-04) until a `createKeyholderInvite` factory exists to produce one
   * client-side, the same way `createOfficerInvite`/`createAuthorityInvite` do.
   */
  async inviteKeyholder (
    keyholder: KeyholderInvite,
    electionId: string,
    signatureOrCallback: Signature | ((digest: Uint8Array) => Promise<Signature>)
  ): Promise<void> {
    try {
      // O-11: a keyholder invitation must expire in the future and within 7 days (plus clock skew).
      // Refused before a nonce or Tid is taken and before any write.
      // Callers pass either the canonical form (no zone, UTC) or a full ISO string with Z.
      const expiresAtMs = Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(keyholder.expiration) ? keyholder.expiration : `${keyholder.expiration}Z`)
      const nowMs = Date.now()
      if (Number.isNaN(expiresAtMs) || expiresAtMs <= nowMs ||
          expiresAtMs > nowMs + KEYHOLDER_INVITE_MAX_LIFETIME_MS + KEYHOLDER_INVITE_EXPIRY_SKEW_MS) {
        throw Object.assign(
          new Error('A keyholder invitation must expire in the future and no more than 7 days from now'),
          { code: 'invite-expiration-out-of-range' }
        )
      }
      const nonce = this.signingEngine.generateSigningNonce()
      const tid = await allocateTid(this.ctx.db, 'election')

      const isSignatureValid = keyholder.inviteSignature
        ? verifyAdHocInviteSignature(
            keyholderInviteSignedBytes({
              type: keyholder.type,
              name: keyholder.name,
              expiration: keyholder.expiration
            }),
            keyholder.inviteSignature,
            keyholder.inviteKey
          )
        : true

      await this.ctx.db.exec(
        `insert into InviteSlot (
          Cid,
          Type,
          Name,
          Expiration,
          InviteKey,
          InviteSignature,
          SigningNonce,
          ElectionId
        )
        with context Tid = :tid, now = :now, IsSignatureValid = :isSignatureValid, IsInsertValid = true
        values (
          cid(Digest(:electionId, :expiration, :inviteKey, :inviteSignature, :name, :nonce, :type)),
          :type,
          :name,
          :expiration,
          :inviteKey,
          :inviteSignature,
          :nonce,
          :electionId
        )`,
        {
          type: 'k',
          name: keyholder.name,
          expiration: keyholder.expiration,
          inviteKey: keyholder.inviteKey,
          inviteSignature: keyholder.inviteSignature,
          nonce,
          tid,
          now: nowCanonicalDatetime(),
          isSignatureValid,
          electionId
        }
      )

      // D-03/D-04: resolve the concrete Signature exactly like
      // saveInviteWithSigning — compute the InviteSlot's digest engine-side
      // and hand the bytes to the callback (device-signer never sees a raw
      // key), or use the caller-supplied completed Signature directly.
      let signature: Signature
      if (typeof signatureOrCallback === 'function') {
        const digestRow = await this.ctx.db
          .prepare('select Digest(Cid) as d from InviteSlot where SigningNonce = :nonce')
          .get({ nonce })
        if (!digestRow || digestRow.d == null) {
          throw new Error('inviteKeyholder: Digest() returned null — crypto plugin not registered?')
        }
        const digestBytes = digestToBytes(digestRow.d)
        signature = await signatureOrCallback(digestBytes)
      } else {
        signature = signatureOrCallback
      }

      await this.signingEngine.startSigningSession(
        this.election.authorityId,
        null,
        'ik',
        signature,
        nonce
      )
    } catch (err) {
      this.rethrow(err, 'inviteKeyholder')
    }
  }

  /**
   * DELETE the Keyholder row of the TARGET keyholder named by `keyholder.name`
   * (D-27 / T-62-09-01 fix). The prior implementation deleted
   * `where UserId = this.ctx.user?.id` — the CALLER's own id, constant across
   * every revoke — so it never touched the invitee it claimed to revoke.
   *
   * Target resolution: `InviteSlot(Type='k', ElectionId, Name[, InviteKey])
   * -> InviteResult.InvokedId -> Keyholder.UserId`. Only ACCEPTED invites
   * (`InviteResult.IsAccepted`) with a live `Keyholder` row are candidates.
   * `keyholder.inviteKey` disambiguates when two accepted invitees share a
   * name; a non-empty value is ANDed into the resolution query. Zero matches
   * throws "no accepted keyholder…"; more than one (two same-named accepted
   * invitees, no inviteKey supplied) throws "ambiguous…" — in both cases
   * nothing is deleted. `this.ctx.user` never appears in this method.
   *
   * Tier note (T-62-09-02, accepted — not mitigated by this plan): `Keyholder`
   * has no `check on delete` constraint, so once a target is resolved the
   * DELETE itself carries no schema-level authorization. Any strand writer
   * could already issue the raw DELETE before this fix too; this method only
   * fixes WHICH row is targeted, not WHO is allowed to target it. Tier-1
   * delete authorization belongs to the Keyholder schema region (62-02).
   */
  async revokeKeyholder (
    keyholder: KeyholderInvite,
    electionId: string
  ): Promise<void> {
    try {
      const candidateParams: Record<string, SqlValue> = { electionId, name: keyholder.name }
      let inviteKeyFilter = ''
      if (typeof keyholder.inviteKey === 'string' && keyholder.inviteKey.length > 0) {
        inviteKeyFilter = ' and S.InviteKey = :inviteKey'
        candidateParams.inviteKey = keyholder.inviteKey
      }

      type CandidateRow = { UserId: string | null; IsAccepted: boolean | number | null }
      const candidates: CandidateRow[] = []
      for await (const row of this.ctx.db.eval(
        `select distinct IR.InvokedId as UserId, IR.IsAccepted as IsAccepted
          from InviteSlot S
          join InviteResult IR on IR.SlotCid = S.Cid
          join Keyholder K on K.UserId = IR.InvokedId and K.ElectionId = S.ElectionId
          where S.Type = 'k' and S.ElectionId = :electionId and S.Name = :name${inviteKeyFilter}`,
        candidateParams
      )) {
        candidates.push({ UserId: row.UserId as string | null, IsAccepted: row.IsAccepted as boolean | number | null })
      }

      // WR-02: Quereus/SQLite returns boolean columns as 0/1 on the on-device
      // path — normalize before filtering to accepted-only, then dedupe by UserId.
      const acceptedIds = new Set<string>()
      for (const c of candidates) {
        const isAccepted = c.IsAccepted === true || (c.IsAccepted as unknown) === 1
        if (isAccepted && c.UserId) acceptedIds.add(c.UserId)
      }

      if (acceptedIds.size === 0) {
        throw new Error(`no accepted keyholder named "${keyholder.name}" on election ${electionId}`)
      }
      if (acceptedIds.size > 1) {
        throw new Error(`ambiguous: ${acceptedIds.size} accepted keyholders named "${keyholder.name}" on election ${electionId}; pass the invite key to choose one`)
      }
      const userId: string = [...acceptedIds][0]!

      const tid = await allocateTid(this.ctx.db, 'election')
      await this.ctx.db.exec(
				`delete from Keyholder
					with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
					where ElectionId = :electionId and UserId = :userId`,
        {
          electionId,
          userId
        }
      )
    } catch (err) {
      this.rethrow(err, 'revokeKeyholder')
    }
  }

  // ---------- confirm-path methods (31-02 implementation) ----------

  /**
   * D-03/D-07/D-06/D-08 — Submit a ProposedBallot for authority confirmation.
   *
   * 0. Refuse an already-submitted or already-confirmed ballot before any write (WR-04; one
   *    session per submission, D-08/D-12).
   * 1. Read the ProposedBallot row.
   * 2. Re-validate ballot invariants (D-07): non-empty description, ≥1 question,
   *    ≥2 options for 'select'-type questions. Throw before any write on failure.
   * 3. Resolve AdminEffectiveAt from CurrentAdmin.
   * 3a. (62-11, D-08) Read the authority's `ceb` threshold (pre-session, via
   *     `readAuthorityThreshold`). AT THRESHOLD 1, the old note still applies verbatim: do NOT
   *     call sign() here — the AdminSigning must stay unsigned until completeSignature
   *     (Pitfall 1), and no `sign` callback is ever invoked (D-06 self-confirm, byte-identical to
   *     pre-62-11). ABOVE THRESHOLD 1, the proposer's REAL signature is collected and recorded as
   *     an OfficerSignature at submit time — before any BEGIN, so no transaction is held across a
   *     biometric prompt — and the unreachable-at-birth/missing-callback cases are refused before
   *     any write.
   * 4. Insert an UNSIGNED AdminSigning('ceb') with the canonical ballot-header digest, INSIDE the
   *    one write envelope (62-11 moved this inside BEGIN — WR-06 parity, no orphan on failure).
   *    Uses BALLOT_HEADER_TID (a fixed constant, not allocateTid()) so finalize can reproduce the
   *    identical digest without reading Tid from any persisted column (Pitfall 2). The
   *    AdminSigning row itself is STILL a never-updated placeholder at every threshold (999.1
   *    R-02/R-04) — the proposer's real crypto above threshold 1 is a SEPARATE OfficerSignature
   *    row, not a mutation of this one.
   * 5. At threshold 1: Task(signature/ballot) → BallotSignatureTaskExtension, byte-for-byte
   *    unchanged (D-06 self-confirm). Above threshold 1: `signWithOutcome` records the proposer's
   *    OfficerSignature, then `fanOutSignatureTasks` creates one open sibling Task for every OTHER
   *    current `ceb` holder (D-08, D-12 — the ONE shared fan-out helper).
   *    BallotSignatureTaskExtension.MutationValid recomputes Digest(BALLOT_HEADER_TID, …) from
   *    ProposedBallot and must match the AdminSigning.Digest inserted above.
   *
   * D-06: at threshold 1, no distinct-signer check — self-confirm is the intended
   * single-authority path, unchanged by this plan.
   */
  async submitBallotForConfirmation (ballotId: string, sign?: (digest: Uint8Array) => Promise<Signature>): Promise<void> {
    try {
      // Step 0 (WR-04, D-08/D-12: one session per submission): refuse a ballot that is already
      // confirmed or out for confirmation BEFORE any read-for-write, allocateTid, or the
      // proposer's sign callback. Confirmed first: a confirmed ballot with open D-09 siblings is
      // "already confirmed", not "out for confirmation".
      const lock = await this.readBallotLock(ballotId)
      if (lock.confirmed) {
        throw new Error('This ballot is already confirmed.')
      }
      if (lock.open) {
        throw new Error('This ballot is already submitted for confirmation.')
      }

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
      // Placeholder key/sig values — 999.1 R-02/R-04 (DEBT-11): this row is InsertOnly and
      // NEVER updated with a real Signature; the officer's real crypto arrives later at
      // completeSignature (31-03) as a SEPARATE OfficerSignature row, not a mutation of this
      // one. AdminSigning.SignatureValid must take the explicit IsPlaceholderSignature escape
      // hatch. The AdminSigning.Signature column is NOT NULL, so we need a non-null placeholder
      // — mirroring the pattern in elections-engine.ts's debugSeedPendingTasks.
      const signerKey = this.ctx.user?.activeKeys?.[0]?.key ?? '0'.repeat(66)
      const placeholderSig = '0'.repeat(128)
      const now = nowCanonicalDatetime()

      // Task + extension allocate through the shared durable allocator (D-01), but the
      // header digest is pinned to BALLOT_HEADER_TID (the fixed constant, D-04 — never
      // routed through the allocator).
      const taskTid = await allocateTid(this.ctx.db, 'election')
      const taskId = (globalThis as { crypto: { randomUUID: () => string } }).crypto.randomUUID()

      // Step 3a (62-11, D-08): pre-write threshold decisions — nothing written yet. At
      // threshold 1 this is a no-op (byte-identical to pre-62-11: no sign callback is ever
      // invoked, D-06 self-confirm). Above threshold 1, the proposer's REAL signature is
      // collected BEFORE any BEGIN, so no transaction is held open across a biometric prompt.
      const threshold = await readAuthorityThreshold(this.ctx.db, this.election.authorityId, 'ceb')
      let proposerSignature: Signature | undefined
      if (threshold > 1) {
        if (!sign) {
          throw new Error(
            `submitBallotForConfirmation: This authority needs ${threshold} approvals to confirm a ballot, so your signature is required when submitting it.`
          )
        }
        const holders = await listCurrentScopeHolders(this.ctx.db, this.election.authorityId, 'ceb')
        const proposerIsHolder = userId != null && holders.includes(userId)
        const possible = holders.filter((h) => h !== userId).length + (proposerIsHolder ? 1 : 0)
        if (threshold > possible) {
          throw new Error(
            `submitBallotForConfirmation: This authority needs ${threshold} approvals to confirm a ballot, but only ${holders.length} officers can approve ballots.`
          )
        }
        const headerDigestRow = await this.ctx.db
          .prepare('select Digest(:headerTid, :id, :electionId, :authorityId, :description, :districts) as d')
          .get({
            headerTid: BALLOT_HEADER_TID,
            id: ballotRow.Id,
            electionId: ballotRow.ElectionId,
            authorityId: this.election.authorityId,
            description: ballotRow.Description,
            districts: ballotRow.Districts,
          })
        if (!headerDigestRow || headerDigestRow.d == null) {
          throw new Error('submitBallotForConfirmation: Digest() returned null — crypto plugin not registered?')
        }
        proposerSignature = await sign(digestToBytes(headerDigestRow.d))
        if (proposerSignature.signerUserId !== userId) {
          throw new Error(
            'submitBallotForConfirmation: the submitted signature does not belong to the submitting officer'
          )
        }
      }

      // Step 4/5: one write envelope. The AdminSigning insert is now INSIDE the BEGIN (WR-06
      // parity, 62-11) so a failure anywhere in this envelope leaves no orphan placeholder row.
      await this.ctx.db.exec('BEGIN')
      try {
        // gap8/WR-02: re-run the lock as the FIRST statement of the write envelope. Step 0 spares
        // the officer a signature prompt in the common case, but the prompt is user-paced: another
        // officer's submit (or its confirmation) can replicate in while it is open, and Step 0's
        // answer is then stale. This check closes that window; the inner catch rolls back. A submit
        // that replicates in only AFTER this commit (two devices both passing before either
        // replicates) is the cross-device residual next to AR-62-145, not closable by an engine read.
        const lockInTx = await this.readBallotLock(ballotId)
        if (lockInTx.confirmed) {
          throw new Error('This ballot is already confirmed.')
        }
        if (lockInTx.open) {
          throw new Error('This ballot is already submitted for confirmation.')
        }

        // Step 4: insert UNSIGNED AdminSigning('ceb') — do NOT call sign() here (Pitfall 1); the
        // row is a never-updated placeholder at every threshold (999.1 R-02/R-04). Bind
        // Description and Districts from the ProposedBallot row so submit and finalize produce
        // byte-identical digests (Pitfall 2). Bind BALLOT_HEADER_TID as a JS number (never
        // String()) — TAG_INT vs TEXT (Pitfall 2).
        await this.ctx.db.exec(
          `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
           with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = true
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
        await this.ctx.db.runDeferredRowConstraints()

        if (threshold <= 1) {
          // Step 5 (threshold 1, D-06 self-confirm): the existing Task + extension inserts,
          // byte-for-byte unchanged.
          // BallotSignatureTaskExtension.MutationValid recomputes Digest(context.Tid, …) from
          // ProposedBallot and must match AdminSigning.Digest — pass BALLOT_HEADER_TID as context.Tid.
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
        } else {
          // Step 5 (threshold > 1, D-08/D-12): record the proposer's own signature as an
          // OfficerSignature (never the initiator — fanOutSignatureTasks excludes them), then fan
          // out one open sibling Task to every OTHER current ceb holder through the ONE shared
          // fan-out helper.
          const outcome = await this.signingEngine.signWithOutcome(nonce, proposerSignature!, { ownsTransaction: false })
          if (outcome.thresholdReached) {
            // Cannot happen: threshold > 1 and this is the FIRST (and only) signature recorded
            // for this nonce. An internal-invariant guard, not a reachable user-facing case.
            throw new Error('submitBallotForConfirmation: internal invariant violated — a single signature reached a threshold > 1')
          }
          await this.ctx.db.runDeferredRowConstraints()
          await fanOutSignatureTasks(
            this.ctx,
            {
              authorityId: this.election.authorityId,
              scope: 'ceb',
              nonce,
              initiatorUserId: userId,
              signatureType: 'ballot',
              taskTid,
              insertExtension: async (fanOutTaskId: string) => {
                await this.ctx.db.exec(
                  `insert into BallotSignatureTaskExtension (TaskId, BallotId)
                   with context Tid = :tid
                   values (:taskId, :ballotId)`,
                  { taskId: fanOutTaskId, ballotId, tid: BALLOT_HEADER_TID }
                )
              },
            },
            { ownsTransaction: false }
          )
        }

        await this.ctx.db.exec('COMMIT')
      } catch (err) {
        try {
          if (!this.ctx.db.getAutocommit()) {
            await this.ctx.db.exec('ROLLBACK')
          }
        } catch {
          // Swallowed — the handle's transaction state is reported truthfully by
          // db.getAutocommit() to any caller that checks it; this method does not pretend
          // recovery succeeded. The ORIGINAL error is what the caller needs to see.
        }
        throw err
      }
    } catch (err) {
      this.rethrow(err, 'submitBallotForConfirmation')
    }
  }

  /**
   * D-05/D-09 (62-11 rewrite) — Withdraw a pending ballot confirmation. At threshold 1 this
   * reduces to the pre-62-11 shape (one open Task, deleted by its only owner). Above threshold
   * 1 it deletes EVERY open sibling Task of an UNREACHED session (D-09, research problem 8) —
   * never the siblings of a session that has already reached its threshold, and only the
   * session's ORIGINAL INITIATOR (the proposer who opened the AdminSigning header) may do it.
   *
   * Delete order per row: Task first, then BallotSignatureTaskExtension.
   * `BallotSignatureTaskExtension.DeleteValid` passes when the Task does NOT exist OR the Task
   * is completed — so deleting the Task first satisfies the "not exists Task" condition, making
   * the extension delete pass.
   *
   * The orphaned UNSIGNED AdminSigning row, and the proposer's OfficerSignature (if any, above
   * threshold 1), are left in place — both tables are InsertOnly, and no AdminSignature will
   * ever reference an unreached header once every open Task is gone. Extension rows of
   * COMPLETED siblings are also left in place — they are history (D-07) and are never touched
   * by this method; only OPEN rows are ever collected or deleted.
   */
  async withdrawBallotConfirmation (ballotId: string): Promise<void> {
    try {
      // Collect every open sibling row for this ballot BEFORE any write — across every nonce
      // that still has an open Task (normally one, but this is nonce-scoped rather than
      // assuming exactly one header exists).
      const openRows: Array<{ Id: string; SigningNonce: string; InitiatorUserId: string | null }> = []
      for await (const row of this.ctx.db.eval(
        `select T.Id, T.SigningNonce, A.UserId as InitiatorUserId
           from Task T
             join BallotSignatureTaskExtension B on B.TaskId = T.Id
             join AdminSigning A on A.Nonce = T.SigningNonce
           where B.BallotId = :ballotId
             and T.Type = 'signature'
             and T.SignatureType = 'ballot'
             and T.IsCompleted = 0`,
        { ballotId }
      )) {
        openRows.push({
          Id: row.Id as string,
          SigningNonce: row.SigningNonce as string,
          InitiatorUserId: (row.InitiatorUserId as string | null | undefined) ?? null,
        })
      }

      if (openRows.length === 0) {
        // Nothing open to withdraw — a no-op is idempotent.
        return
      }

      // D-09: a session that has ALREADY reached its threshold never has its siblings deleted.
      const distinctNonces = [...new Set(openRows.map((r) => r.SigningNonce))]
      const reachedNonces = new Set<string>()
      for (const nonce of distinctNonces) {
        const reachedRow = await this.ctx.db
          .prepare('select 1 as x from AdminSignature where SigningNonce = :nonce')
          .get({ nonce })
        if (reachedRow) reachedNonces.add(nonce)
      }

      const unreachedRows = openRows.filter((r) => !reachedNonces.has(r.SigningNonce))
      if (unreachedRows.length === 0) {
        throw new Error('withdrawBallotConfirmation: This ballot is already confirmed and can no longer be withdrawn.')
      }

      // T-62-11-03: only the session's original initiator may withdraw — checked BEFORE any write.
      const userId = this.ctx.user?.id ?? null
      for (const row of unreachedRows) {
        if (row.InitiatorUserId !== userId) {
          throw new Error('withdrawBallotConfirmation: Only the officer who submitted this ballot can withdraw it.')
        }
      }

      await this.ctx.db.exec('BEGIN')
      try {
        for (const row of unreachedRows) {
          // Delete Task first (makes DeleteValid pass on the extension — "not exists Task")
          await this.ctx.db.exec('delete from Task where Id = :id', { id: row.Id })
          // Delete extension (now passes DeleteValid because the Task no longer exists)
          await this.ctx.db.exec('delete from BallotSignatureTaskExtension where TaskId = :id', { id: row.Id })
          await this.ctx.db.runDeferredRowConstraints()
        }
        await this.ctx.db.exec('COMMIT')
      } catch (err) {
        try {
          if (!this.ctx.db.getAutocommit()) {
            await this.ctx.db.exec('ROLLBACK')
          }
        } catch {
          // Swallowed — see submitBallotForConfirmation's matching comment.
        }
        throw err
      }
    } catch (err) {
      this.rethrow(err, 'withdrawBallotConfirmation')
    }
  }

  /**
   * D-05/D-09 — Report the lock and confirmed state of a ProposedBallot.
   *
   * `locked` = a ballot signature Task is open AND no finalized Ballot row exists (WR-04, the
   * shared readBallotLock predicate). A confirmed ballot whose D-09 siblings are still open
   * (62-11) reads unlocked because the Ballot row exists. A session that reached its threshold
   * but whose finalize failed (AdminSignature committed, Task open, no Ballot row) now reads
   * locked, matching proposeBallot and submitBallotForConfirmation, which refuse it.
   * `confirmed` = a finalized Ballot row exists for this id.
   * `canWithdraw` (gap8/WR-03) = locked, at least one open session has not reached its threshold,
   * and every such session was initiated by the calling officer (what withdrawBallotConfirmation
   * accepts). `ownTaskOpen` (gap6/WR-02) = locked and the caller has an open ballot Task here.
   */
  async getBallotConfirmationState (
    ballotId: string
  ): Promise<{ locked: boolean; confirmed: boolean; canWithdraw: boolean; ownTaskOpen: boolean }> {
    try {
      const { open, confirmed } = await this.readBallotLock(ballotId)
      const locked = open && !confirmed
      if (!locked) {
        return { locked, confirmed, canWithdraw: false, ownTaskOpen: false }
      }
      const userId = this.ctx.user?.id ?? null

      // gap8/WR-03: who may withdraw. Same join and same refusals as withdrawBallotConfirmation:
      // a session that already reached its threshold (AdminSignature row) can no longer be
      // withdrawn, and every unreached open session must have been initiated by the caller.
      // NOT EXISTS (not IN) per the Quereus AND+IN trap.
      const initiators = new Set<string | null>()
      for await (const row of this.ctx.db.eval(
        `select distinct A.UserId as InitiatorUserId
           from Task T
             join BallotSignatureTaskExtension B on B.TaskId = T.Id
             join AdminSigning A on A.Nonce = T.SigningNonce
           where B.BallotId = :ballotId
             and T.Type = 'signature'
             and T.SignatureType = 'ballot'
             and T.IsCompleted = 0
             and not exists (select 1 from AdminSignature S where S.SigningNonce = T.SigningNonce)`,
        { ballotId }
      )) {
        initiators.add((row.InitiatorUserId as string | null | undefined) ?? null)
      }
      const canWithdraw = userId !== null && initiators.size > 0 && [...initiators].every((i) => i === userId)

      // gap6/WR-02: does THIS officer have an open confirmation task for the ballot? At
      // threshold 1 the submitter owns one; above 1 the fan-out excludes the initiator.
      let ownTaskOpen = false
      if (userId !== null) {
        const own = await this.ctx.db
          .prepare(
            `select 1 as x from Task T join BallotSignatureTaskExtension B on B.TaskId = T.Id
             where B.BallotId = :ballotId and T.UserId = :userId
               and T.Type = 'signature' and T.SignatureType = 'ballot' and T.IsCompleted = 0`
          )
          .get({ ballotId, userId })
        ownTaskOpen = own !== undefined
      }
      return { locked, confirmed, canWithdraw, ownTaskOpen }
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

  /**
   * D-27 — build one `ElectionRevision.keyholders` projection by joining the
   * revision's persisted pending-invitee JSON with the real `Keyholder` table.
   *
   * Starts from `parseKeyholdersAsInviteStatus(keyholdersJson, field)` — the
   * create/propose-time invitee names, still unresolved. Separately reads
   * every `Keyholder` row for `(electionId, revision)` joined with `User`
   * (for the name) and left-joined with `InviteResult` (for the invite
   * signature) — a real `Keyholder` row IS the accepted fact, so `isAccepted`
   * is always `true` for a row this join produces, even if `InviteResult` is
   * somehow absent. Each invitee in JSON order consumes the first unconsumed
   * `Keyholder` row whose `Name` matches exactly; any `Keyholder` rows left
   * over (accepted keyholders never named in the original invitee JSON — see
   * D-27 read c) are appended at the end. A `Keyholder` row is never dropped
   * and never duplicated — residual: with two SAME-NAME invitees in the JSON,
   * the FIRST slot absorbs the acceptance (display-only; T-62-09-05). The
   * sent state follows the same per-name order: same-name invitees take the
   * name's ranked sent entries in turn (the first gets the best-ranked chain),
   * independently of which `Keyholder` row each absorbed.
   */
  private async readRevisionKeyholders (
    electionId: string,
    revision: number,
    keyholdersJson: unknown,
    field: string
  ): Promise<Array<InviteStatus<SentKeyholderInvite>>> {
    const invitees = parseKeyholdersAsInviteStatus(keyholdersJson, field)

    type KeyholderRow = { UserId: string, Name: string, InviteSignature: string | null }
    const rows: KeyholderRow[] = []
    const seenUserIds = new Set<string>()
    for await (const row of this.ctx.db.eval(
      `select K.UserId, U.Name, IR.InviteSignature, IR.IsAccepted
        from Keyholder K
        join User U on U.Id = K.UserId
        left join InviteResult IR on IR.InvokedId = K.UserId
        where K.ElectionId = :electionId and K.ElectionRevision = :revision
        order by U.Name, K.UserId`,
      { electionId, revision }
    )) {
      const userId = row.UserId as string
      if (seenUserIds.has(userId)) continue // dedupe by UserId in JS
      seenUserIds.add(userId)
      rows.push({
        UserId: userId,
        Name: row.Name as string,
        InviteSignature: (row.InviteSignature as string | null | undefined) ?? null
      })
    }

    const toResult = (row: KeyholderRow): NonNullable<InviteStatus<SentKeyholderInvite>['result']> => ({
      // The Keyholder row itself is the accepted fact — isAccepted is true
      // even when InviteResult is null (left join miss).
      isAccepted: true,
      invitationSignature: row.InviteSignature ?? '',
      invokedId: row.UserId
    })

    // 62-76: sent state. Read the election's keyholder slots (two equality terms only), collect them
    // before any further query (no nested cursor), then decide liveness once per distinct InviteKey with
    // the shared readInviteChain rule. 'not-found' yields no entry.
    // 62-84 (CR-01, WR-04): 'ambiguous' is carried as 'unknown' (never dropped, so the label cannot read
    // "Not sent" for an invitation that was sent). All of a name's chains go into one list sorted by
    // SENT_STATE_RANK (answered > live > declined > unknown > no-longer-valid), ties on the latest expiration, and
    // takeSent hands out the head - never InviteSlot row (Cid hash) order. Same-name invitees each take
    // their own entry; an extra chain is dropped only after every same-name invitee has one.
    // 62-84 (D-23, gap 7): sent state is auxiliary. When the network cannot serve the invitation tables
    // (a peer-read failure, see isPeerReadUnavailable), every keyholder reads 'unknown' instead of the
    // whole election read throwing. Any other error rethrows unchanged.
    const sentByName = new Map<string, InviteSentState[]>()
    let sentUnavailable = false
    try {
      type SlotRow = { Name: string, InviteKey: string, Cid: string, Expiration: string }
      const slotRows: SlotRow[] = []
      for await (const row of this.ctx.db.eval(
        'select Cid, Name, InviteKey, Expiration from InviteSlot where ElectionId = :electionId and Type = :slotType',
        { electionId, slotType: 'k' }
      )) {
        slotRows.push({
          Cid: row.Cid as string,
          Name: row.Name as string,
          InviteKey: row.InviteKey as string,
          Expiration: String(row.Expiration)
        })
      }
      const byKey = new Map<string, SlotRow[]>()
      for (const r of slotRows) {
        const list = byKey.get(r.InviteKey)
        if (list) list.push(r)
        else byKey.set(r.InviteKey, [r])
      }
      const now = nowCanonicalDatetime()
      const latestExpiration = (chainRows: SlotRow[]): string =>
        chainRows.map(r => r.Expiration).sort((a, b) => sentExpirationMs(a) - sentExpirationMs(b) || (a < b ? -1 : a > b ? 1 : 0)).pop() ?? ''
      for (const [inviteKey, chainRows] of byKey) {
        const chain = await readInviteChain(this.ctx.db, inviteKey, 'k', now)
        if (chain.status === 'not-found') continue
        let sent: InviteSentState
        if (chain.status === 'ambiguous') {
          sent = { state: 'unknown', expiration: latestExpiration(chainRows) }
        } else if (chain.status === 'answered') {
          // 62 CR-01: readInviteChain reports 'answered' for ANY InviteResult, but a decline
          // (IsAccepted false) writes no Keyholder row, so without its polarity a declined keyholder
          // would read "Sent" forever. Read the answer's polarity for the answered slot (one PK-keyed
          // row). A value that is neither accepted nor declined fails closed to 'unknown'.
          const answer = await this.ctx.db
            .prepare('SELECT IsAccepted, InvokedId FROM InviteResult WHERE SlotCid = :slotCid')
            .get({ slotCid: chain.cid })
          const isAccepted = answer?.IsAccepted as unknown
          let state: InviteSentState['state'] = isAccepted === true || isAccepted === 1
            ? 'answered'
            : isAccepted === false || isAccepted === 0 ? 'declined' : 'unknown'
          if (state === 'answered' && typeof answer?.InvokedId === 'string') {
            // 62-139 (keep RE-ACCEPT, user ruling 2026-10-07): keyholders accept each revision separately. Compare
            // the acceptor's Keyholder rows with the PROJECTED revision (this function's argument, a history
            // revision at the second call site), both through Number(...). A row at the projected revision, or a
            // later one, keeps 'answered'; rows only before it mean a new invitation is needed; no row at all
            // (deleted, or not yet replicated) stays 'answered'. Two equality terms; rows collected first.
            const revisionRows: number[] = []
            for await (const kr of this.ctx.db.eval(
              'select ElectionRevision from Keyholder where ElectionId = :electionId and UserId = :userId',
              { electionId, userId: answer.InvokedId }
            )) {
              revisionRows.push(Number(kr.ElectionRevision))
            }
            const projected = Number(revision)
            if (revisionRows.length > 0 && revisionRows.every((r) => r < projected)) state = 'accepted-earlier-revision'
          }
          const headRow = chainRows.find(r => r.Cid === chain.cid)
          sent = { state, expiration: headRow?.Expiration ?? latestExpiration(chainRows) }
        } else {
          const headRow = chain.status === 'no-longer-valid' ? undefined : chainRows.find(r => r.Cid === chain.cid)
          sent = { state: chain.status, expiration: headRow?.Expiration ?? latestExpiration(chainRows) }
        }
        const name = chainRows[0]!.Name
        const list = sentByName.get(name)
        if (list) list.push(sent)
        else sentByName.set(name, [sent])
      }
      for (const list of sentByName.values()) list.sort(compareSentStates)
    } catch (err) {
      const peerError = isPeerReadUnavailable(err)
      if (peerError === undefined) throw err
      console.warn('[keyholders] sent state unavailable:', peerError)
      sentUnavailable = true
    }
    // 62-104 (IN-06): legacy data only - new revisions cannot hold duplicate names. A name held by more than
    // one invitee cannot be told apart per invitee, so every such invitee reads 'unknown' and no chain is
    // handed out (a namesake must never see another invitee's declined or live chain).
    const nameCounts = new Map<string, number>()
    for (const invitee of invitees) {
      const key = normalizeKeyholderName(invitee.invite.name ?? '')
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1)
    }
    const takeSent = (name: string): InviteSentState | undefined => {
      if (sentUnavailable) return { state: 'unknown', expiration: '' }
      if ((nameCounts.get(normalizeKeyholderName(name)) ?? 0) > 1) return { state: 'unknown', expiration: '' }
      return sentByName.get(name)?.shift()
    }

    const consumed = new Set<number>()
    const out: Array<InviteStatus<SentKeyholderInvite>> = []
    for (const invitee of invitees) {
      const idx = rows.findIndex((r, i) => !consumed.has(i) && r.Name === invitee.invite.name)
      const sent = takeSent(invitee.invite.name)
      if (idx >= 0) {
        consumed.add(idx)
        out.push({ invite: invitee.invite, result: toResult(rows[idx]!), ...(sent ? { sent } : {}) })
      } else {
        out.push({ ...invitee, ...(sent ? { sent } : {}) })
      }
    }
    for (let i = 0; i < rows.length; i++) {
      if (!consumed.has(i)) {
        const sent = takeSent(rows[i]!.Name)
        out.push({ invite: { name: rows[i]!.Name }, result: toResult(rows[i]!), ...(sent ? { sent } : {}) })
      }
    }
    return out
  }

  private rethrow (err: unknown, method: string): never {
    return rethrowHelper(err, 'ElectionEngine', method)
  }
}
