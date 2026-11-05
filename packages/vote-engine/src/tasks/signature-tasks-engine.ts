import type { SqlValue, Database } from '@quereus/quereus'
import { SigningEngine } from '../signing/signing-engine.js'
import { seedSignedMutation } from '../signing/signed-mutation.js'
import { adminSigningKeyValidity } from '../signing/signer-validity.js'
import { readSessionThreshold } from '../signing/threshold.js'
import { fanOutSignatureTasks } from '../signing/fan-out.js'
import { findPendingAdminTaskRow, findPendingTaskNonce, findRegistrantSessionNonce } from './task-signing-status.js'
import { resolveSignedSubmittedAt } from '../signing/signed-submitted-at.js'
import { toIsoZDatetime, toDeferredCheckDatetime, restoreCanonicalDatetime, reZuluDatetime, rethrow as rethrowHelper } from '../signing/ceremony-helpers.js'
import { digestToBytes, formatPgRange, formatScoreRange, nowCanonicalDatetime, parseJsonOr } from '../utils.js'
import type { EngineContext } from '../types.js'
import { verificationCid, isChecklistGateMet, RegistrantAlreadyExistsError, AdminPromotionError, RegistrationDuplicateError, RegistrationContentAccessError, RequesterSignatureUnverifiableError } from '@votetorrent/vote-core'
import { openRegistrationPayload } from '../registration/sealed-registration-content.js'
import type {
  ISigningEngine,
  ISignatureTasksEngine,
  ISignatureTasksCompleteSignatureBuilder,
  NetworkReference,
  SignatureResult,
  SignatureTask,
  AdminSignatureTask,
  BallotSignatureTask,
  RegistrantSignatureTask,
  Authority,
  ThresholdPolicy,
  AdminInit,
  Proposal,
  Ballot,
  Question,
  RegisterInit,
  RegistrationRequestDecision,
  Signature,
  SignOutcome,
  SigningStatus,
} from '@votetorrent/vote-core'
import { BALLOT_HEADER_TID } from '../election/election-engine.js'
import { CompleteSignatureBuilder } from './builders/index.js'
import { allocateTid } from '../database/tid-allocator.js'
import { RegistrationEngine } from '../registration/registration-engine.js'
import { registrationRequestNotClosedSql, readDuplicateClosure } from '../registration/duplicate-closure.js'
import { resolveRecordValidity } from '../association/record-validity.js'
import { AuthorityEngine } from '../authority/authority-engine.js'

/**
 * CR-04 (T-48-33-02/03) — the identifier-free tally a registrant seed pass returns and the
 * engine keeps the most recent copy of on {@link SignatureTasksEngine.lastSeedOutcome}. Every
 * field is a `number` or a `boolean` — NEVER a request identifier: D-02 makes
 * `RegistrationRequest` intake unauthenticated, so a skip/abort signal derived from a pending row
 * must not leak requester-chosen values across that trust boundary (T-48-08-02).
 *
 * Field meanings:
 *  - `considered` — rows in the work set AFTER the CR-01 authority-scoping predicate (the ones
 *    this pass actually attempted).
 *  - `seeded` — rows whose envelope reached `COMMIT`.
 *  - `skipped` — rows that failed and were isolated, INCLUDING the one aborting row (its
 *    `ROLLBACK` failure counts as a skip too, on top of setting `aborted`).
 *  - `aborted` — a `ROLLBACK` failure stopped the pass before every considered row was attempted.
 *  - `handleInAutocommit` — `Database.getAutocommit()` probed at pass end.
 *
 * `considered > 0, seeded === 0` is what distinguishes a permanently un-seedable request from an
 * empty inbox — the exact signal CR-04 closes the gap on. This type is intentionally NOT added to
 * `ISignatureTasksEngine` in `vote-core`: it has no UI consumer this round (PARTIAL BY DESIGN —
 * only a developer or a test can see it; an officer still cannot).
 */
export type RegistrantSeedOutcome = {
  considered: number
  seeded: number
  skipped: number
  aborted: boolean
  handleInAutocommit: boolean
}

/**
 * CR-04 (T-48-33-01) — module-private sentinel distinguishing "this row's ROLLBACK could not be
 * recovered, stop the pass" from an ordinary per-row failure that simply retries on the next
 * pull. Carries NO request data — only a fixed, identifier-free message. Never exported: callers
 * outside this file have no legitimate reason to construct or catch it.
 */
class SeedPassAborted extends Error {
  constructor () {
    super('seedRegistrantSignatureTasks: rollback failed; seed pass aborted')
    this.name = 'SeedPassAborted'
  }
}

/**
 * CR-04 (T-48-33-04/05) — one registrant seed pass at a time per `Database` handle.
 * `useTaskCount.fetchCount` and `TasksScreen`'s focus effect both call
 * `getRequestedSignatures(true)` on the SAME `ctx.db`, and Quereus's transactions are flat and
 * handle-global (`signing-engine.ts`) — interleaved `BEGIN`/`COMMIT` pairs from two overlapping
 * passes corrupt each other (duplicate extension rows or a wedged handle). This copies the
 * proven D-10 promise-chain mutex shape from `tid-allocator.ts:88-115` verbatim, keyed by
 * `Database` handle instead of a namespace string: read the prior chain (`?? Promise.resolve()`),
 * `.then()` the pass onto it, and store `next.catch(() => {})` back into the map — the STORED
 * chain's `.catch` is the wedge guard, so a rejected pass can never poison the next caller.
 */
const seedPassLocks = new WeakMap<Database, Promise<unknown>>()

/**
 * SignatureTasksEngine — Phase 05 (TASK-03, TASK-04) implementation.
 *
 * The ISignatureTasksEngine interface declares
 * `getRequestedSignatures(pending: boolean)` and
 * `completeSignature(task, result)`.
 *
 * Schema kept as-written. `Task.SignatureTypeValid` checks SignatureType
 * against the SignatureType view ({admin, authority, network, election,
 * election-revision, ballot}). Under
 * [quereus#21](https://github.com/gotchoices/quereus/issues/21), only the
 * first row of the view ('admin') matches at CHECK eval; non-admin tasks
 * are silently rejected on INSERT.
 */
export class SignatureTasksEngine implements ISignatureTasksEngine {
  /**
   * CR-04 (T-48-33-02) — the most recent registrant seed pass's tally. Public so a test or a
   * future UI consumer can read it; NOT part of `ISignatureTasksEngine` (no interface change, no
   * UI consumer this round — see {@link RegistrantSeedOutcome}'s own doc comment).
   */
  lastSeedOutcome?: RegistrantSeedOutcome

  constructor (
    private readonly networkRef: NetworkReference,
    private readonly ctx?: EngineContext,
    private readonly signingEngine: ISigningEngine | undefined = ctx
      ? new SigningEngine(ctx)
      : undefined
  ) {}

  /**
   * TASK-03 — query pending Task rows of `Type='signature'` for the
   * current user. Materialises the authority, administration, and network
   * name for 'admin' signature tasks so TasksScreen and SignatureTaskScreen
   * can render without crashing on missing fields.
   *
   * For non-admin types the base SignatureTask shape is returned with the
   * network name resolved from the Network table; authority-specific fields
   * are absent but those screen branches do not access them.
   */
  async getRequestedSignatures (pending: boolean): Promise<SignatureTask[]> {
    if (!this.ctx) return []
    const userId = this.ctx.user?.id ?? null
    const out: SignatureTask[] = []
    try {
      // D-05 pull-and-seed point: for every pending RegistrationRequest lacking a task, seed one
      // under the currently signed-in officer BEFORE this same pull reads it back — so a
      // newly-arrived request is visible on the same call that seeded it. Consequence for
      // downstream: 'registrant' tasks now appear in this generic getRequestedSignatures(true)
      // result alongside the six existing types; this method does NOT filter them out — 48-18/48-19
      // decide whether the generic tasks list renders or filters them.
      await this.seedRegistrantSignatureTasks()

      // Resolve network name once — single Network row per DB.
      const networkRow = await this.ctx.db
        .prepare('select Name, Hash from Network limit 1')
        .get({})
      const networkRef: NetworkReference = {
        ...this.networkRef,
        name: (networkRow?.Name as string | undefined) ?? (this.networkRef as NetworkReference & { name?: string }).name ?? '',
        primaryAuthorityDomainName: (this.networkRef as NetworkReference & { primaryAuthorityDomainName?: string }).primaryAuthorityDomainName ?? '',
      }

      // Collect base task rows first (avoid interleaving eval + prepare on same handle).
      const taskRows: Array<{ Id: string; UserId: string; SignatureType: string; SigningNonce: string }> = []
      for await (const row of this.ctx.db.eval(
				`select Id, UserId, SignatureType, SigningNonce
					from Task
					where Type = 'signature'
						and UserId = :userId
						and (IsCompleted = 0 or IsCompleted = :includeAll)`,
        {
          userId,
          includeAll: pending ? 0 : 1
        }
      )) {
        taskRows.push({
          Id: row.Id as string,
          UserId: row.UserId as string,
          SignatureType: row.SignatureType as string,
          SigningNonce: row.SigningNonce as string,
        })
      }

      for (const row of taskRows) {
        const signatureType = row.SignatureType as SignatureTask['signatureType']
        const base: SignatureTask = {
          type: 'signature',
          userId: row.UserId,
          network: networkRef,
          signatureType,
        }

        if (signatureType === 'admin') {
          // Materialise AdminSignatureTask: join AdminSignatureTaskExtension →
          // Authority (for authority.name) and ProposedAdmin (for administration.proposed).
          const extRow = await this.ctx.db
            .prepare(
              `select E.AuthorityId, E.AdminEffectiveAt,
                      A.Name as AuthName, A.DomainName, A.ImageRef,
                      PA.ThresholdPolicies
                 from AdminSignatureTaskExtension E
                   join Authority A on A.Id = E.AuthorityId
                   left join ProposedAdmin PA on PA.AuthorityId = E.AuthorityId and PA.EffectiveAt = E.AdminEffectiveAt
                 where E.TaskId = :taskId`
            )
            .get({ taskId: row.Id })

          if (extRow) {
            const authority: Authority = {
              id: extRow.AuthorityId as string,
              name: (extRow.AuthName as string | undefined) ?? '',
              domainName: (extRow.DomainName as string | undefined) ?? '',
              imageRef: extRow.ImageRef
                ? parseJsonOr(extRow.ImageRef, undefined, 'Authority.ImageRef')
                : undefined,
            }
            const thresholdPolicies = parseJsonOr<ThresholdPolicy[]>(
              extRow.ThresholdPolicies,
              [],
              'ProposedAdmin.ThresholdPolicies'
            )
            const administration: Proposal<AdminInit> = {
              proposed: {
                officers: [],
                effectiveAt: extRow.AdminEffectiveAt as string,
                thresholdPolicies,
              },
              signers: [],
            }
            const adminTask: AdminSignatureTask = {
              ...base,
              signatureType: 'admin',
              authority,
              administration,
            }
            out.push(adminTask)
          } else {
            // Extension row missing — push base task with a defensive authority stub
            // so getAuthorityGroupKey falls back to network name rather than crashing.
            out.push(base)
          }
        } else if (signatureType === 'ballot') {
          // Materialise BallotSignatureTask: join BallotSignatureTaskExtension →
          // ProposedBallot to populate ballot.proposed (Pitfall 6, D-09).
          const bExtRow = await this.ctx.db
            .prepare(
              `select PB.Id, PB.ElectionId, PB.AuthorityId, PB.Description, PB.Districts, PB.Questions
                 from BallotSignatureTaskExtension E
                   join ProposedBallot PB on PB.Id = E.BallotId
                 where E.TaskId = :taskId`
            )
            .get({ taskId: row.Id })

          if (bExtRow) {
            const districts = parseJsonOr<string[]>(bExtRow.Districts, [], 'ProposedBallot.Districts')
            const questions = parseJsonOr<Question[]>(bExtRow.Questions, [], 'ProposedBallot.Questions')
            const proposedBallot: Ballot = {
              id: bExtRow.Id as string,
              electionId: bExtRow.ElectionId as string,
              authorityId: bExtRow.AuthorityId as string,
              description: bExtRow.Description as string,
              districts,
              questions,
            }
            const ballotTask: BallotSignatureTask = {
              ...base,
              signatureType: 'ballot',
              ballot: { proposed: proposedBallot, signers: [] },
            }
            out.push(ballotTask)
          } else {
            // Extension or ProposedBallot row missing — fall back to base task
            out.push(base)
          }
        } else if (signatureType === 'registrant') {
          // D-05: materialise the RegistrantSignatureTask. LEFT join RegistrationBridgeKey
          // deliberately — a registrant-issued row has a null BridgeId and must still
          // materialise. A missing bridgeLabel on a bridge row means the registry lookup found no
          // label; issuerType — NOT bridgeLabel — is the only authoritative issuer signal (D-03), a
          // consumer must never infer "registrant-submitted" from a missing label.
          const rExtRow = await this.ctx.db
            .prepare(
              `select E.RequestId, R.AuthorityId, R.IssuerType, R.BridgeId, R.Payload, R.PayloadCid, R.SubmittedAt,
                      B.Label as BridgeLabel
                 from RegistrantSignatureTaskExtension E
                   join RegistrationRequest R on R.Id = E.RequestId
                   left join RegistrationBridgeKey B on B.Id = R.BridgeId
                 where E.TaskId = :taskId`
            )
            .get({ taskId: row.Id })

          // D-49: open through the one seal/open module (the tier-2 PayloadCid recheck included).
          // Any access other than 'opened'/'unsealed' takes the EXISTING base-task fallback below —
          // the same discipline this branch already had for a missing extension row, a missing
          // joined request, or an unparseable payload.
          const payload = rExtRow
            ? (await openRegistrationPayload(this.ctx.db, this.ctx.intakeOpener, {
                requestId: rExtRow.RequestId as string,
                payloadCid: rExtRow.PayloadCid as string,
                stored: rExtRow.Payload
              })).payload
            : undefined

          if (rExtRow && payload) {
            const registrantTask: RegistrantSignatureTask = {
              ...base,
              signatureType: 'registrant',
              requestId: rExtRow.RequestId as string,
              payload,
              // WR-04: a plain `select` of a `datetime` column comes back WITHOUT the trailing 'Z'
              // (T-42-06), while RegistrantSignatureTask.submittedAt is documented as an ISO-Z
              // string (vote-core tasks/models.ts). Binding the raw read-back made every consumer
              // doing `new Date(task.submittedAt)` interpret the instant as HOST-LOCAL time — the
              // exact defect class reZuluDatetime exists to prevent. Every other Phase-48 read
              // surface already re-Zulus this column (registration-engine.ts's inbox row and
              // getRegistrationRequest); this one now agrees with them. reZuluDatetime, NOT
              // restoreCanonicalDatetime: this value is READ, never re-bound into an UPDATE, so
              // the byte-exact millisecond reconstruction the write paths need is not required —
              // and a third datetime shape on a read surface is precisely the drift WR-01/T-42-06
              // warns about.
              submittedAt: reZuluDatetime(rExtRow.SubmittedAt as string),
              issuerType: rExtRow.IssuerType as RegistrantSignatureTask['issuerType'],
              bridgeLabel: rExtRow.BridgeLabel == null ? undefined : (rExtRow.BridgeLabel as string),
            }
            out.push(registrantTask)
          } else {
            // Missing extension row, missing joined request, or an unparseable payload — fall back
            // to base rather than throwing, the 'admin'/'ballot' contract verbatim: the approval
            // screen renders from getRegistrationRequest, so a degraded task costs legibility, while
            // a throw here would take down the entire task inbox for every signature type.
            out.push(base)
          }
        } else {
          out.push(base)
        }
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getRequestedSignatures')
    }
  }

  /**
   * D-05 — pull-and-seed intake for the registrant approval ceremony, resolving
   * `48-RESEARCH.md` Open Question 1 in the form the research itself proposed: PULL-AND-SEED at
   * inbox mount rather than push-and-seed at submission time. `AdminSigning.UserIdValid` requires
   * a `UserId`, and an outside submitter categorically cannot supply one — a prospective
   * registrant has no `User` row at all (D-02). The task can therefore only be seeded on the
   * authority side, at read time, under the CURRENTLY SIGNED-IN OFFICER's own `ctx.user` — never
   * the requester's.
   *
   * WR-22: a `'vrg'`-scoped officer IS now required to seed — the predicate below tests
   * `json_each(O.Scopes)` for `'vrg'`, and `resolveAcceptableRegistrantApproval` re-tests it on the
   * mint path. This paragraph previously said the opposite, and that was accurate at the time: the
   * scope was enforced NOWHERE. `AdminSigning.UserIdValid` (`votetorrent.qsql`) reads `Officer`
   * membership and never `Officer.Scopes`; `AdminSigning.SignerKeyValid` and
   * `OfficerSignature.OfficerValid` are hardcoded `context.Is…Valid = true` stubs (Phase 999.1);
   * and `SigningEngine.sign` falls back to `Number(thresholdRes?.threshold) || 1`, so an authority
   * declaring no `'vrg'` policy silently gets threshold 1. Net effect before this change: ONE
   * officer holding any scope at all — `'rad'`-only, say — could single-handedly mint a Registrant.
   *
   * What this fix is and is not: it is ENGINE-side enforcement at both registrant-path gates, which
   * is the only layer that can carry it today — a schema-side CHECK would sit beside the two
   * hardcoded stubs above and could not be trusted to fire. It does NOT convert `'vrg'` into a
   * schema-enforced boundary, and no code or document may claim that it does; `48-SECURITY.md`'s
   * accepted risk R-02 narrows rather than closes. The threshold half of the finding
   * (`|| 1` when an authority declares no `'vrg'` ThresholdPolicy) is also NOT addressed here —
   * changing authority-creation default policies is a product decision, not a review fix.
   *
   * Best-effort, silent no-op: with no signed-in officer there is no legal `UserId` to seed under.
   *
   * CR-04 (T-48-33-04): this method now only decides WHETHER to run a pass and enforces the
   * per-`Database`-handle serialization lock (`seedPassLocks`) around it — the actual per-row work
   * lives in {@link runRegistrantSeedPass}. `useTaskCount.fetchCount` and `TasksScreen`'s focus
   * effect both call `getRequestedSignatures(true)` on the SAME `ctx.db`; without this lock their
   * per-row `BEGIN`/`COMMIT` pairs can interleave on Quereus's flat, handle-global transaction
   * model, producing duplicate `RegistrantSignatureTaskExtension` rows or a wedged handle. The
   * lock shape is `tid-allocator.ts`'s proven D-10 promise chain, copied verbatim.
   */
  private async seedRegistrantSignatureTasks (): Promise<void> {
    if (!this.ctx?.user?.id) {
      // No signed-in officer — no legal UserId to seed under (unchanged silent no-op). Still
      // record a tally so `lastSeedOutcome` is never left stale from a PRIOR ctx/user.
      this.lastSeedOutcome = {
        considered: 0,
        seeded: 0,
        skipped: 0,
        aborted: false,
        handleInAutocommit: this.ctx?.db ? this.ctx.db.getAutocommit() : true,
      }
      return
    }
    const ctx = this.ctx
    const db = ctx.db

    // CR-04 (T-48-33-04/05): chain onto any pass already in flight for this SAME Database handle
    // — copied verbatim from tid-allocator.ts:88-115's D-10 shape. The STORED chain's
    // `.catch(() => {})` is the wedge guard: a rejected pass must not poison the next caller.
    const prior = seedPassLocks.get(db) ?? Promise.resolve()
    const next = prior.then(async () => {
      this.lastSeedOutcome = await this.runRegistrantSeedPass(ctx)
    })
    seedPassLocks.set(db, next.catch(() => {}))
    await next
  }

  /**
   * CR-04 — the actual per-row seed pass, run under {@link seedRegistrantSignatureTasks}'s
   * per-handle serialization lock. Returns the identifier-free {@link RegistrantSeedOutcome}
   * tally rather than throwing, because `getRequestedSignatures`'s own `catch` rethrows anything
   * that escapes its `try` — a PER-ROW error escaping this method would re-brick the whole Tasks
   * inbox for every signature type, which is CR-01 verbatim (round 1's closed defect).
   *
   * Scope of that guarantee (WR-23): the guarantee is now METHOD-WIDE, and the doc comment can say
   * so honestly. Round 3 narrowed this paragraph to cover only the per-row loop, because the
   * work-set collection query below sat outside every try/catch — an error there propagated out of
   * this method, rejected the `seedPassLocks` chain's `next`, and was rethrown by
   * `getRequestedSignatures`'s outer `catch`: the CR-01 failure mode (a blank Tasks inbox for EVERY
   * signature type), for that one call. Narrower than CR-04 was — `seedPassLocks` stores
   * `next.catch(() => {})`, so the mutex was never poisoned and the NEXT caller started clean — but
   * real, and a reader who trusted the "never rejects" claim would not have expected it.
   *
   * The collection step is now inside the same `try` as the loop, and a failure there is reported
   * as `aborted: true` with a zeroed tally instead of escaping. Two things make that the right
   * trade rather than a silent swallow: the outcome is OBSERVABLE
   * (`SignatureTasksEngine.lastSeedOutcome` distinguishes `aborted: true` from an ordinary empty
   * pass, which is precisely the distinction CR-04 existed to restore), and the failure is not
   * hidden from the rest of the app — a handle so broken that this parameterized read fails will
   * fail the caller's own subsequent reads in `getRequestedSignatures`, loudly, on their own merits.
   * What must NOT happen is this one best-effort seeding step taking down the display of admin,
   * ballot, network and election tasks that have nothing to do with registration.
   */
  private async runRegistrantSeedPass (ctx: EngineContext): Promise<RegistrantSeedOutcome> {
    const userId = ctx.user!.id

    // Collect the work set FIRST, into an array, before any write — mirrors this file's own
    // "avoid interleaving eval + prepare on the same handle" discipline used for the base task-row
    // collection above. The `not exists` clause is what makes seeding idempotent: a request that
    // already has an extension row is never re-seeded, which is what makes it safe to run this step
    // on every inbox mount.
    const pendingRows: Array<{
      Id: string
      AuthorityId: string
      RequesterKey: string
      IssuerType: string
      BridgeId: string | null
      PayloadCid: string
      SubmittedAt: string
    }> = []
    // CR-01 (T-48-30-01): D-02 makes intake unauthenticated, so an outside submitter chooses
    // AuthorityId freely — including an authority the signed-in officer does not serve, where
    // this method's own AdminSigning('vrg') insert (below) would fail AdminSigning.UserIdValid.
    // Scope the work set to authorities the signed-in :userId actually serves BEFORE any write
    // is attempted, joining Officer to CurrentAdmin so a request is only considered when the
    // officer serves the authority's CURRENT administration.
    //
    // WR-23: this collection step is wrapped. An `eval` failure here used to propagate out of the
    // method and be rethrown by `getRequestedSignatures`'s outer catch — CR-01's blank-inbox
    // failure mode, for that one call. It is reported instead: `aborted: true` over a zeroed tally,
    // partially collected rows discarded (a partial work set would seed an arbitrary prefix and
    // report `considered` as if that prefix were the whole set — a worse lie than reporting
    // nothing). Nothing is logged: every bound value in the query below is fine, but the ROWS this
    // loop pushes carry request identifiers, and an error object can carry a row with it.
    try {
      for await (const row of ctx.db.eval(
        `select R.Id, R.AuthorityId, R.RequesterKey, R.IssuerType, R.BridgeId, R.PayloadCid, R.SubmittedAt
           from RegistrationRequest R
           where R.Status = 'p'
             and not exists (select 1 from RegistrantSignatureTaskExtension E where E.RequestId = R.Id)
             and exists (
               select 1 from Officer O
                 join CurrentAdmin CA on CA.AuthorityId = O.AuthorityId and CA.EffectiveAt = O.AdminEffectiveAt
                 where O.AuthorityId = R.AuthorityId and O.UserId = :userId
                   and exists (select 1 from json_each(O.Scopes) where value = 'vrg')
             )
             -- D-44 (62-19): a request closed or closing as a duplicate is undecidable, so it must
             -- never be seeded. The single shared definition — never a locally re-derived predicate.
             and ${registrationRequestNotClosedSql('R')}`,
        { userId }
      )) {
        pendingRows.push({
          Id: row.Id as string,
          AuthorityId: row.AuthorityId as string,
          RequesterKey: row.RequesterKey as string,
          IssuerType: row.IssuerType as string,
          BridgeId: row.BridgeId as string | null,
          PayloadCid: row.PayloadCid as string,
          SubmittedAt: row.SubmittedAt as string,
        })
      }
    } catch {
      return {
        considered: 0,
        seeded: 0,
        skipped: 0,
        aborted: true,
        handleInAutocommit: ctx.db.getAutocommit(),
      }
    }

    let seeded = 0
    let skipped = 0
    let aborted = false

    // T-48-30-02/T-48-11-10, rewritten for CR-04 (T-48-33-06): one malformed/unresolvable request
    // must never take down seeding for the others — but a row whose `ROLLBACK` cannot be closed is
    // a DIFFERENT failure than an ordinary row failure, and this loop now tells them apart. Three
    // outcomes, each named by its tally field:
    //   - seeded: the row's BEGIN/AdminSigning/Task/extension/COMMIT envelope succeeded outright.
    //   - skipped (transient): the row's body failed but its own ROLLBACK succeeded — the row
    //     stays 'p' and is retried on the NEXT pull, because nothing about the shared handle is
    //     broken. This is the ONLY case the next pull is proven to recover (registrant-seeding-
    //     scope.spec.ts's CR-04 Test 5, second pull).
    //   - aborted (NOT transient): the row's own ROLLBACK failed, and Quereus's transaction model
    //     is flat and handle-global — an unclosed transaction would poison every later BEGIN on
    //     this handle (this row's remaining siblings, the next inbox mount, an approval's
    //     register(), a rejection's ceremony) with an error itself swallowed wherever it lands.
    //     ONE bounded recovery attempt is made; whether or not it succeeds, the pass STOPS
    //     (`break`, never a rethrow — see this method's own doc comment for why a rethrow here
    //     would re-brick the inbox, CR-01 verbatim) rather than continuing onto a handle whose
    //     transaction state is unknown. If the bounded recovery ALSO failed, the handle is left
    //     mid-transaction and reported as `handleInAutocommit === false` — that state persists
    //     until something OUTSIDE this method issues a real ROLLBACK or the handle is replaced; NO
    //     subsequent pull is claimed to recover it (registrant-seeding-scope.spec.ts's CR-04
    //     Test 6 asserts the stuck state, not a recovery).
    // The catch below logs NOTHING in either case: the bound params above carry request
    // identifiers, and logging on this surface is a closed security gate (T-48-08-02, T-48-30-04).
    // The tally is the only signal, and it is identifier-free by construction (see
    // RegistrantSeedOutcome's doc comment).
    for (const row of pendingRows) {
      try {
        // A request addressed to an authority with no current administration cannot be seeded —
        // one case of the general per-row-isolation rule this try/catch implements.
        const adminRow = await ctx.db
          .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
          .get({ authorityId: row.AuthorityId })
        if (!adminRow) { skipped++; continue }
        const adminEffectiveAt = adminRow.EffectiveAt as string | number

        // One fresh Tid per request, from 48-07's shared 'registration-request' namespace — the
        // SAME value feeds BOTH the Digest(...) expression below AND the extension INSERT's
        // context.Tid; MutationValid re-derives DG-4 from the joined RegistrationRequest using
        // context.Tid, and a mismatch fails the CHECK with an error that reads like a signature
        // problem, not a Tid one (mirrors election-engine.ts:910-925's BALLOT_HEADER_TID
        // discipline).
        const tid = await allocateTid(ctx.db, 'registration-request')
        const nonce = (globalThis as { crypto: { randomUUID: () => string } }).crypto.randomUUID()
        const taskId = (globalThis as { crypto: { randomUUID: () => string } }).crypto.randomUUID()
        const signerKey = ctx.user?.activeKeys?.[0]?.key ?? '0'.repeat(66)
        const placeholderSig = '0'.repeat(128)
        // nowCanonicalDatetime() is correct here and must NOT be "fixed" to toIsoZDatetime — it
        // feeds AdminSigning's pre-existing `now` context param, not a new Z-checked column; this
        // step writes no Z-checked column at all (48-02's hygiene rule pushes the opposite way for
        // NEW columns only).
        const now = nowCanonicalDatetime()

        // WR-06 (T-48-30-05): the AdminSigning('vrg') insert now shares ONE envelope with the
        // Task/extension inserts below. Before this fix it ran OUTSIDE the BEGIN/COMMIT — and
        // AdminSigning is `InsertOnly check on update, delete (false)`, so a row that failed
        // inside the envelope AFTER a successful AdminSigning insert became a permanent orphan.
        // With try/continue retrying a failed row on every future mount, that one-off orphan would
        // otherwise become unbounded growth driven entirely by unauthenticated input. Do NOT call
        // sign() here — the officer's real crypto arrives later at completeSignature as a SEPARATE
        // OfficerSignature row, never as a mutation of this one (999.1 R-02/R-04).
        await ctx.db.exec('BEGIN')
        try {
          await ctx.db.exec(
            `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
             with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = true
             values (:nonce, :authorityId, :adminEffectiveAt, 'vrg',
                     Digest(:tid, :requestId, :authorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt),
                     :userId, :signerKey, :signature)`,
            {
              nonce,
              authorityId: row.AuthorityId,
              adminEffectiveAt,
              tid,
              requestId: row.Id,
              requesterKey: row.RequesterKey,
              issuerType: row.IssuerType,
              bridgeId: row.BridgeId,
              payloadCid: row.PayloadCid,
              submittedAt: row.SubmittedAt,
              userId,
              signerKey,
              signature: placeholderSig,
              now,
            }
          )
          // 62-11 (D-08, assumption A5): above the vrg threshold, the whole sibling set is
          // seeded HERE, inside this SAME per-request envelope — one open registrant Task per
          // CURRENT vrg holder, the seeding officer included (initiatorUserId null, A5), rather
          // than only the legacy single Task. readSessionThreshold reads the AdminSigning('vrg')
          // row just inserted above — visible on this SAME handle before COMMIT (62-07 PROBE-A11).
          const threshold = await readSessionThreshold(ctx.db, nonce, 'vrg')
          if (threshold <= 1) {
            // Threshold-1 path: byte-for-byte unchanged (the legacy single seeded Task).
            await ctx.db.exec(
              `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
               with context IsMutationValid = true, Tid = :tid
               values (:id, :userId, 'signature', 'registrant', :nonce, 0)`,
              { id: taskId, userId, nonce, tid }
            )
            await ctx.db.exec(
              `insert into RegistrantSignatureTaskExtension (TaskId, RequestId)
               with context Tid = :tid
               values (:taskId, :requestId)`,
              { taskId, requestId: row.Id, tid }
            )
          } else {
            // Threshold > 1 (D-08/D-12): fan out through the ONE shared helper. A FanOutError
            // (e.g. 'unreachable-at-birth') falls into the existing CR-04 catch below: ROLLBACK,
            // skipped++, nothing logged — the request stays 'p' and unseeded, retried on the
            // next pull. Do NOT change the `not exists` work-set predicate or the tally fields.
            await ctx.db.runDeferredRowConstraints()
            await fanOutSignatureTasks(
              ctx,
              {
                authorityId: row.AuthorityId,
                scope: 'vrg',
                nonce,
                initiatorUserId: null,
                signatureType: 'registrant',
                taskTid: tid,
                insertExtension: async (fanOutTaskId: string) => {
                  await ctx.db.exec(
                    `insert into RegistrantSignatureTaskExtension (TaskId, RequestId)
                     with context Tid = :tid
                     values (:taskId, :requestId)`,
                    { taskId: fanOutTaskId, requestId: row.Id, tid }
                  )
                },
              },
              { ownsTransaction: false }
            )
          }
          await ctx.db.exec('COMMIT')
          seeded++
        } catch (err) {
          // CR-04 (T-48-33-01): attempt the ordinary ROLLBACK first. On success, rethrow the
          // ORIGINAL error unchanged — the ordinary per-row-failure path, preserved verbatim.
          try {
            await ctx.db.exec('ROLLBACK')
          } catch {
            // The ROLLBACK itself failed. Exactly ONE bounded recovery attempt, itself wrapped so
            // a second failure cannot escape as a different error shape — Quereus's transaction
            // model is flat, so the handle's OWN autocommit state is the only reliable signal of
            // whether anything is left open to close.
            try {
              if (!ctx.db.getAutocommit()) {
                await ctx.db.exec('ROLLBACK')
              }
            } catch {
              // Swallowed — the handle may still be mid-transaction; handleInAutocommit (below)
              // reports this truthfully rather than pretending recovery succeeded.
            }
            throw new SeedPassAborted()
          }
          throw err
        }
      } catch (err) {
        skipped++
        if (err instanceof SeedPassAborted) {
          aborted = true
          break
        }
        continue
      }
    }

    return {
      considered: pendingRows.length,
      seeded,
      skipped,
      aborted,
      handleInAutocommit: ctx.db.getAutocommit(),
    }
  }

  /**
   * TASK-04 — apply a signature via SigningEngine.sign() then mark the
   * Task complete. The two operations are NOT wrapped in a SQL
   * transaction here because SigningEngine.sign() opens its own
   * BEGIN/COMMIT envelope (AUTH-08). The order matters: signing must
   * succeed before the Task is marked complete so a failed signing
   * does not leave a "complete" task without a backing signature.
   */
  async completeSignature (
    task: SignatureTask,
    result: SignatureResult
  ): Promise<void> {
    this.requireCtx('completeSignature')
    if (!this.signingEngine) {
      throw new Error(
        'SignatureTasksEngine.completeSignature: no SigningEngine bound — construct with (networkRef, ctx)'
      )
    }
    // Read the SigningNonce off the Task row that this completion refers
    // to. The caller could supply it directly, but the IEngine surface
    // (SignatureTask) does not expose it; we look it up by (UserId,
    // SignatureType, !IsCompleted).
    // D-05 / CR-01: For ballot tasks, scope the lookup by the ballot id
    // carried on the BallotSignatureTask so that with >=2 pending ballot
    // tasks the correct task row (and therefore the correct AdminSigning
    // digest) is resolved — not an arbitrary LIMIT-1 row.
    let taskRow: { Id: string; SigningNonce: string } | undefined
    if (task.signatureType === 'ballot') {
      const ballotId = (task as BallotSignatureTask).ballot.proposed.id
      taskRow = await this.ctx!.db
        .prepare(
          `select Task.Id, Task.SigningNonce from Task
            join BallotSignatureTaskExtension E on E.TaskId = Task.Id
            where Task.UserId = :userId
              and Task.Type = 'signature'
              and Task.SignatureType = :signatureType
              and Task.IsCompleted = 0
              and E.BallotId = :ballotId
            limit 1`
        )
        .get({
          userId: task.userId,
          signatureType: task.signatureType,
          ballotId,
        }) as { Id: string; SigningNonce: string } | undefined
      if (!taskRow) {
        throw new Error(
          `SignatureTasksEngine.completeSignature: no pending ballot task for user=${task.userId} ballotId=${ballotId}`
        )
      }
    } else if (task.signatureType === 'registrant') {
      // L-3 (48-11): an officer legitimately has several pending registration requests at once —
      // scope the lookup by requestId, copying the 'ballot' branch's disambiguation shape above,
      // rather than the plain UserId + SignatureType lookup that would resolve an arbitrary LIMIT-1
      // row (and therefore complete the WRONG request's task).
      const requestId = (task as RegistrantSignatureTask).requestId
      taskRow = await this.ctx!.db
        .prepare(
          `select Task.Id, Task.SigningNonce from Task
            join RegistrantSignatureTaskExtension E on E.TaskId = Task.Id
            where Task.UserId = :userId
              and Task.Type = 'signature'
              and Task.SignatureType = :signatureType
              and Task.IsCompleted = 0
              and E.RequestId = :requestId
            limit 1`
        )
        .get({
          userId: task.userId,
          signatureType: task.signatureType,
          requestId,
        }) as { Id: string; SigningNonce: string } | undefined
      if (!taskRow) {
        throw new Error(
          `SignatureTasksEngine.completeSignature: no pending registrant task for user=${task.userId} requestId=${requestId}`
        )
      }
    } else if (
      task.signatureType === 'admin' &&
      (task as AdminSignatureTask).authority?.id !== undefined &&
      (task as AdminSignatureTask).administration?.proposed?.effectiveAt !== undefined
    ) {
      // 62-13 (D-09, T-62-13-04): disambiguate by (AuthorityId, proposed AdminEffectiveAt) —
      // D-09 keeps every reached sibling open, so one officer can hold several pending admin
      // tasks for DIFFERENT proposals at once. An arbitrary LIMIT-1 row here would let an
      // officer sign the WRONG proposal. A join-miss base task (no `authority`) falls through
      // to the generic branch below, unchanged (WR-01).
      taskRow = await findPendingAdminTaskRow(this.ctx!.db, task as AdminSignatureTask)
      if (!taskRow) {
        throw new Error(
          `SignatureTasksEngine.completeSignature: no pending admin task for user=${task.userId} authorityId=${(task as AdminSignatureTask).authority?.id}`
        )
      }
    } else {
      taskRow = await this.ctx!.db
        .prepare(
          `select Id, SigningNonce from Task
            where UserId = :userId
              and Type = 'signature'
              and SignatureType = :signatureType
              and IsCompleted = 0
            limit 1`
        )
        .get({
          userId: task.userId,
          signatureType: task.signatureType,
        }) as { Id: string; SigningNonce: string } | undefined
      if (!taskRow) {
        throw new Error(
          `SignatureTasksEngine.completeSignature: no pending task for user=${task.userId} signatureType=${task.signatureType}`
        )
      }
    }
    const nonce = taskRow.SigningNonce as string

    // WR-19 (T-48-34-01/02/05): registrant pre-sign gate — runs BEFORE signingEngine.sign() below,
    // so a payload guaranteed to be refused (CR-02, CR-03) or a malformed accept (missing
    // result.sign, missing result.decision) never spends the officer's real header signature. This
    // is the FIRST of resolveAcceptableRegistrantApproval's two call sites; the SECOND is inside
    // finalizeRegistrantApproval itself, as defence in depth for any future caller that reaches it
    // directly — one gate, two call sites, zero duplicated SQL or message text, so the two cannot
    // drift apart (T-48-34-05). Because THIS call site runs first, a refused approval creates no
    // OfficerSignature/AdminSignature row (SigningEngine's own BEGIN/COMMIT, further down, never
    // opens) and the accept path stays retryable via a second accept attempt — the exact ordering
    // defect WR-19 closes.
    //
    // Both malformed-accept shapes are refused HERE too, moved up as one adjacent pair (never
    // duplicated, never split across the sign() call below) — each is independently
    // regression-tested (the malformed-accept case in registrant-approval.spec.ts covers missing
    // result.sign AND missing result.decision separately), so a later reader cannot assume one
    // covers the other.
    //
    // WR-05 (now CLOSED, elsewhere): this gate removes the requester-CHOOSABLE trigger, and it
    // was all this gate ever claimed. The residual it used to leave open — a finalize failure the
    // gate cannot foresee (a register() CHECK failure, a storage error) arising AFTER the gate
    // passes but before finalize completes, leaving the task un-retryable via accept — is closed
    // by making `SigningEngine.sign()` idempotent on (SigningNonce, UserId) (signing-engine.ts).
    // A retry now re-enters sign(), finds this officer's row already present, no-ops, and proceeds
    // to finalize instead of dying on `UNIQUE constraint failed: OfficerSignature PK`.
    if (result.isAccepted && task.signatureType === 'registrant') {
      // L-2 (48-11): the accept path REQUIRES the reusable per-digest callback — DG-2 is signed at
      // decision time, and there is no placeholder fallback on this path. An approval whose
      // checklist is covered by nothing is exactly the failure D-07 exists to prevent; do not
      // substitute a placeholder signature here.
      if (!result.sign) {
        throw new Error(
          'SignatureTasksEngine.completeSignature: registrant accept requires result.sign (a reusable per-digest signing callback) — none supplied'
        )
      }
      // The D-07 checklist is what VerificationCid is derived from — there is no legal approval
      // without one.
      if (!result.decision) {
        throw new Error(
          'SignatureTasksEngine.completeSignature: registrant accept requires result.decision (the D-07 verification checklist) — none supplied'
        )
      }
      // WR-02: the D-07 gate was previously enforced NOWHERE on a write path — only by the approval
      // screen's `disabled` prop, which any non-UI caller (or a `disabled`-bypassing press) skips.
      // Two distinct failures follow from an ungated checklist, and this one predicate closes both:
      //   1. the gate itself — `[]` ("I verified nothing, and I did not say so") and the
      //      `['none', <substantive>]` contradiction are exactly the states isChecklistGateMet
      //      exists to forbid, and D-07's whole claim is that an approval carries a declared
      //      verification basis;
      //   2. audit-trail recoverability — `verificationCid([])` is a perfectly valid CID, but
      //      `recoverVerificationChecklist` enumerates only GATE-VALID subsets
      //      (CHECKLIST_GATE_VALID_CANDIDATES, registration-engine.ts), so a non-gate-valid
      //      checklist writes a VerificationCid the read surface can never invert. The decided
      //      request then renders `verificationChecklist: undefined`, indistinguishable from
      //      "vocabulary widened" or "digest corrupted".
      // The imported vote-core predicate is used verbatim — never a local length/includes
      // re-derivation, which is how the gate and the digest drift apart.
      if (!isChecklistGateMet(result.decision.checklist)) {
        throw new Error(
          'SignatureTasksEngine.completeSignature: registrant decision checklist does not satisfy the D-07 gate (empty, or "none" combined with a substantive item)'
        )
      }

      // 62-11 (D-10): the late-signature path. When this session has ALREADY reached its
      // threshold AND the request is already decided ('a'), the pre-check below is skipped —
      // the crossing officer's accept already proved the payload acceptable, and no mint can
      // follow this accept because the finalize gate (further down) is off for this shape. Every
      // OTHER accept (including the FIRST, below-threshold ones, and any accept against a request
      // that is not yet 'a') still runs the FULL pre-check — WR-19, WR-22, CR-02, CR-03 and
      // WR-20 stay in force for every accept that could possibly mint.
      const preStatus = await this.signingEngine.getSigningStatus(nonce)
      const preRequestStatus = await this.readRegistrantRequestStatus(taskRow.Id as string)
      const isLateSignature = preStatus?.reached === true && preRequestStatus === 'a'
      if (!isLateSignature) {
        try {
          await this.resolveAcceptableRegistrantApproval(taskRow.Id as string)
        } catch (err) {
          // R2/D-04/D-05 (57-02), and D-44 (62-19): let RegistrantAlreadyExistsError and
          // RegistrationDuplicateError through undecorated — this.rethrow() below wraps any plain
          // Error into a fresh `new Error(...)` and would destroy the instanceof check each typed
          // error exists to provide.
          if (err instanceof RegistrantAlreadyExistsError || err instanceof RegistrationDuplicateError || err instanceof RegistrationContentAccessError || err instanceof RequesterSignatureUnverifiableError) {
            throw err
          }
          this.rethrow(err, 'completeSignature (registrant pre-check)')
        }
      }
    }

    // 57-08 (Trigger B pre-check), explanation updated 62-03/62-13: the admin accept path
    // REQUIRES the reusable per-digest callback — promotion (applyAdminProposal) mints its OWN
    // promotion digest (62-03's single full-roster promotion session), which a single
    // pre-computed Signature cannot cover. Checked BEFORE sign() below, alongside the
    // registrant guard above, so a refusable accept never spends the officer's header
    // signature.
    if (result.isAccepted && task.signatureType === 'admin' && !result.sign) {
      throw new Error(
        'SignatureTasksEngine.completeSignature: admin accept requires result.sign (a reusable per-digest signing callback) — promotion mints its own promotion digest, which a single pre-computed Signature cannot cover'
      )
    }

    // D-12: Branch on result.isAccepted.
    // Accept path only — call sign() to insert OfficerSignature and (at threshold=1)
    // auto-complete AdminSignature. Do NOT call sign() on reject: a rejection that
    // advances the signing session is a critical integrity hole (D-12 threat).
    let thresholdReached = false
    // 62-11 (D-10): the full {thresholdReached, crossedNow} outcome, needed by the ballot and
    // registrant finalize gates below. Only set on the non-admin path (the admin branch keeps
    // its own P7-composed sign() call, unchanged and untouched by this plan — 62-13 owns it).
    let signOutcome: SignOutcome | undefined
    if (result.isAccepted) {
      if (task.signatureType === 'admin') {
        // 57-08 (Trigger B, P7-composed transaction): sign() and the
        // promotion attempt share ONE explicit transaction. Task 1's P7
        // probe (57-08-SUMMARY.md) proved an uncommitted AdminSignature row
        // IS visible on the same handle before COMMIT, so this composition
        // closes the "threshold reached but administration not applied"
        // window rather than leaving it open — every OTHER signature type
        // keeps sign()'s unwrapped, self-owned-transaction shape byte-for-
        // byte (the `else` branch below is the exact prior call, unchanged).
        await this.ctx!.db.exec('BEGIN')
        try {
          const adminOutcome = await this.signingEngine.signWithOutcome(nonce, result.signature, { ownsTransaction: false })
          thresholdReached = adminOutcome.thresholdReached
          // 62-13 (D-10): promote once — on the call that CROSSED the threshold (crossedNow), or
          // on a LATER accept when the threshold is reached but the Admin row is still missing.
          // The resume case: a crossing whose promotion was refused with AdminPromotionError (or
          // whose composed transaction rolled back on a plain error, below) committed the
          // signature without an Admin row, so the next accept re-attempts. A late co-signature
          // after a COMPLETE promotion is recorded only — never re-invokes applyAdminProposal.
          // Mirrors 62-11's ceb/vrg gates (crossedNow, or thresholdReached with an incomplete
          // artifact) verbatim, per 62-11-SUMMARY.md's handoff.
          if (adminOutcome.crossedNow || (adminOutcome.thresholdReached && !(await this.isAdminPromotionComplete(taskRow.Id)))) {
            try {
              // WR-01: the task-listing path above deliberately pushes a BASE
              // SignatureTask — no `authority` — when the
              // AdminSignatureTaskExtension → Authority join misses, and that base
              // still carries signatureType 'admin'. Feeding that `undefined`
              // straight into AuthorityEngine made applyAdminProposal throw a bare
              // TypeError on `this.authority.id`; because a TypeError is not an
              // AdminPromotionError it fell to the `throw` below and rolled the
              // whole composed transaction back, DESTROYING the officer's real,
              // just-produced signature. Treat a join-miss exactly as T-57-08-06
              // treats a refused promotion: record it, never silently, never
              // thrown, so the signature still commits.
              const adminAuthority = (task as AdminSignatureTask).authority
              if (adminAuthority?.id === undefined) {
                console.warn(
                  `SignatureTasksEngine.completeSignature (finalize admin): promotion skipped for nonce ${nonce}: this task carries no authority, so the AdminSignatureTaskExtension → Authority join must have missed when the task was listed. The officer's signature itself was NOT affected.`,
                )
              } else {
                await new AuthorityEngine(adminAuthority, this.ctx!).applyAdminProposal(
                  nonce,
                  result.sign!,
                  { ownsTransaction: false }
                )
              }
            } catch (promotionErr) {
              if (promotionErr instanceof AdminPromotionError) {
                // 57-08 (Trigger B): mirrors Trigger A's (proposeAdmin) discipline
                // exactly (T-57-08-06) — a co-signer's real, valid signature must
                // not be destroyed by a promotion that legitimately cannot apply
                // (e.g. the D-03 .init-officer case). Recorded via console.warn,
                // never silent, never thrown; the officer's OfficerSignature and
                // (at threshold) AdminSignature rows still commit below.
                console.warn(
                  `SignatureTasksEngine.completeSignature (finalize admin): promotion refused for nonce ${nonce}: ${promotionErr.reason}. The officer's signature itself was NOT affected.`,
                )
              } else {
                throw promotionErr
              }
            }
          }
          await this.ctx!.db.exec('COMMIT')
        } catch (err) {
          await this.ctx!.db.exec('ROLLBACK')
          this.rethrow(err, 'completeSignature (finalize admin)')
        }
      } else {
        // 62-11 (D-10): signWithOutcome, not sign() — the ballot/registrant finalize gates
        // below need crossedNow, not just the boolean. sign()'s own Promise<boolean> contract
        // (thresholdReached) is preserved via signOutcome.thresholdReached below.
        signOutcome = await this.signingEngine.signWithOutcome(nonce, result.signature)
        thresholdReached = signOutcome.thresholdReached
      }
    }

    // Ballot finalize branch (D-01, D-08, 62-11 D-09/D-10/D-12): after sign() succeeds, INSERT
    // Ballot first then per-row signed Questions and Options.
    // This runs BEFORE the Task-complete update so options are promoted before the Task closes.
    //
    // Gate (D-10): finalize runs ONLY on `crossedNow` (THIS call inserted the AdminSignature —
    // the normal path, every threshold), OR on `thresholdReached` with the artifact still
    // incomplete (WR-05: a retry after a failed finalize returns crossedNow=false because the
    // AdminSignature already exists from the FIRST attempt — `isBallotFinalizeComplete` is what
    // keeps that retry retryable rather than silently skipped). A below-threshold accept
    // (`thresholdReached === false`) only records the vote and completes the Task below — this
    // is exactly the CONTEXT "Specific Ideas" defect this plan fixes: the first accept at
    // threshold 2 used to run finalize unconditionally and throw on Ballot.MutationValid.
    if (result.isAccepted && task.signatureType === 'ballot') {
      try {
        const ballotExtRow = await this.ctx!.db
          .prepare('select BallotId from BallotSignatureTaskExtension where TaskId = :taskId')
          .get({ taskId: taskRow.Id })
        const ballotId = ballotExtRow?.BallotId as string | undefined
        const shouldFinalize = ballotId !== undefined && (
          signOutcome?.crossedNow === true ||
          (signOutcome?.thresholdReached === true && !(await this.isBallotFinalizeComplete(ballotId)))
        )
        if (shouldFinalize) {
          // 39-03 (DEBT-11, D-06): thread the caller's optional reusable
          // per-digest signing callback into finalizeBallot so per-row
          // Question/Option AdminSigning rows can carry a REAL signature
          // instead of the legacy placeholder (see SignatureResult.sign doc).
          await this.finalizeBallot(taskRow.Id as string, nonce, result.sign)
        }
      } catch (err) {
        this.rethrow(err, 'completeSignature (finalize)')
      }
    }

    // Registrant finalize branch (D-05, D-07): after sign() succeeds (the officer's header
    // signature over DG-4), drive the D-07 decision ceremony and the byte-unchanged register()
    // BEFORE the Task-complete update — mirrors finalizeBallot's call-site placement immediately
    // above. Do NOT touch the reject path: result.isAccepted === false must continue to skip
    // sign(), skip this block entirely, and fall through to the unconditional task-complete update
    // — 48-12 owns the reject ceremony (RegistrationEngine.rejectRegistrationRequest), not this file.
    //
    // D-12 (48-12): a rejection that advances the signing session is a critical integrity hole —
    // the SAME sentence guarding sign() above, carried verbatim onto this branch, because the
    // registrant-specific consequence is sharper here than on any other signature type. If this
    // guard's `result.isAccepted &&` were ever dropped, the completed 'vrg' AdminSigning session
    // (from sign(), above) would drive finalizeRegistrantApproval -> the unchanged register(), so a
    // rejection that advanced the session would CREATE THE VERY Registrant THE OFFICER REFUSED —
    // silently, with the request row still reading Status = 'r'. That failure would be invisible
    // to anyone reading only RegistrationRequest.Status.
    //
    // result.sign/result.decision were already validated above, before sign() — do not re-check
    // them here.
    //
    // 62-11 (D-10): the SAME crossedNow-or-incomplete gate as the ballot branch above, and the
    // SAME WR-05 retry guarantee. A below-threshold accept (the CONTEXT "Specific Ideas" defect
    // for vrg) only records the vote and completes the Task below — it never reaches finalize.
    // Also 62-11 note: at threshold above 1, only the CROSSING officer's D-07 checklist is
    // digested into VerificationCid — earlier accepters' checklists are recorded as votes
    // (OfficerSignature rows) but are not themselves persisted into the decision record (open
    // question 2).
    if (result.isAccepted && task.signatureType === 'registrant') {
      const shouldFinalizeRegistrant = signOutcome?.crossedNow === true ||
        (signOutcome?.thresholdReached === true && (await this.readRegistrantRequestStatus(taskRow.Id as string)) !== 'a')
      // Below threshold, or an already-finalized late signature: nothing more to do here — the
      // unconditional Task-complete update below still runs either way.
      if (shouldFinalizeRegistrant) {
        try {
          await this.finalizeRegistrantApproval(taskRow.Id as string, result.decision!, result.sign!, nonce)
        } catch (err) {
          // R2/D-04/D-05 (57-02), and D-44 (62-19): see the matching note on the pre-check call
          // site above — finalizeRegistrantApproval's own defence-in-depth guard, and register()
          // itself, can both throw RegistrantAlreadyExistsError; resolveAcceptableRegistrantApproval
          // (called internally) can throw RegistrationDuplicateError. Neither may be re-wrapped.
          if (err instanceof RegistrantAlreadyExistsError || err instanceof RegistrationDuplicateError || err instanceof RegistrationContentAccessError || err instanceof RequesterSignatureUnverifiableError) {
            throw err
          }
          this.rethrow(err, 'completeSignature (finalize registrant)')
        }
      }
    }

    // Mark the task complete (unconditional — both accept and reject close the task).
    const tid = await allocateTid(this.ctx!.db, 'signature-tasks')
    try {
      await this.ctx!.db.exec(
				`update Task
				with context IsMutationValid = true, Tid = ${tid}
					set IsCompleted = 1
				where Id = :id`,
        {
          id: taskRow.Id as string,
        }
      )
    } catch (err) {
      this.rethrow(err, 'completeSignature')
    }
  }

  /**
   * D-01/D-08 — Finalize a ballot after the signing threshold is reached.
   *
   * Ordering (Ballot-first, D-08):
   *   1. Read ProposedBallot row.
   *   2. INSERT Ballot header (BALLOT_HEADER_TID for digest parity with submit — Pitfall 2).
   *   3. For each question: AdminSigning('ceb') + sign() + INSERT Question.
   *   4. For each option of each question: AdminSigning('ceb') + sign() + INSERT Option.
   *
   * D-04: ProposedBallot is NOT deleted.
   * Pitfall 3: Ballot.MutationValid gates on BallotDeadline > now (schema-enforced).
   */
  private async finalizeBallot (
    taskId: string,
    headerNonce: string,
    sign?: (digest: Uint8Array) => Promise<Signature>
  ): Promise<void> {
    // Resolve the BallotId by joining to BallotSignatureTaskExtension.
    const extRow = await this.ctx!.db
      .prepare('select BallotId from BallotSignatureTaskExtension where TaskId = :taskId')
      .get({ taskId })
    if (!extRow) {
      throw new Error(`SignatureTasksEngine.finalizeBallot: no BallotSignatureTaskExtension for taskId=${taskId}`)
    }
    const ballotId = extRow.BallotId as string

    // Step 1: read ProposedBallot
    const pbRow = await this.ctx!.db
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

    if (!pbRow) {
      throw new Error(`SignatureTasksEngine.finalizeBallot: ProposedBallot not found for id=${ballotId}`)
    }

    const now = nowCanonicalDatetime()

    // Step 2: INSERT Ballot row FIRST (Ballot-first, D-08).
    // Bind the SAME BALLOT_HEADER_TID constant used at submit so Ballot.MutationValid's
    // Digest(context.Tid, …) matches the AdminSigning.Digest baked in at submitBallotForConfirmation
    // (Pitfall 2). The same nonce (headerNonce) + same Description/Districts from ProposedBallot
    // reproduces the byte-identical digest tuple.
    //
    // 62-11 (D-10, resumable/idempotent second defence): skip the insert when the Ballot row
    // already exists — a retry after a failed finalize (WR-05), a second crosser racing the
    // first, or a direct re-invocation (C11) must never re-attempt an INSERT that would collide
    // on the primary key or re-spend AdminSigning/OfficerSignature rows this call does not own.
    const existingBallot = await this.ctx!.db
      .prepare('select 1 as x from Ballot where Id = :id')
      .get({ id: pbRow.Id })
    if (!existingBallot) {
      await this.ctx!.db.exec(
        `insert into Ballot (Id, ElectionId, AuthorityId, Description, Districts)
         with context SigningNonce = :nonce, Tid = :headerTid, now = :now
         values (:id, :electionId, :authorityId, :description, :districts)`,
        {
          nonce: headerNonce,
          headerTid: BALLOT_HEADER_TID,
          id: pbRow.Id,
          electionId: pbRow.ElectionId,
          authorityId: pbRow.AuthorityId,
          description: pbRow.Description,
          districts: pbRow.Districts,
          now,
        }
      )
    }

    // Resolve AdminEffectiveAt for per-question/option AdminSigning inserts.
    const adminRow = await this.ctx!.db
      .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
      .get({ authorityId: pbRow.AuthorityId })
    if (!adminRow) {
      throw new Error(`SignatureTasksEngine.finalizeBallot: CurrentAdmin not found for authorityId=${pbRow.AuthorityId}`)
    }
    const adminEffectiveAt = adminRow.EffectiveAt as string | number

    const questions = parseJsonOr<Question[]>(pbRow.Questions, [], 'ProposedBallot.Questions')

    // Step 3+4: per-question and per-option promotion (D-08 question + option path).
    for (const q of questions) {
      // Resolve defaults JS-side (mirrors seedQuestion's Pitfall 4 fix — avoids binding NULL into
      // default-valued columns, which trips the Quereus 3.3.0 NULL-bug):
      const dependsOn = q.dependsOn ? JSON.stringify(q.dependsOn) : null
      // Ranges are written in pg range notation via formatPgRange, never JSON (UAT gap 1):
      // getBallotDetails reads them with parsePgRange. The Digest and the INSERT bind
      // these same variables (Question.MutationValid recompute).
      const optionRange = q.optionRange ? formatPgRange(q.optionRange) : '{1, 1}'
      const scoreRange = q.scoreRange ? formatScoreRange(q.scoreRange) : null
      const grouping = q.group ?? null
      const sequence = q.sequence ?? null
      // Required is now `integer default 1` (37-04 / D-05b re-attach fix — was
      // `boolean default true`). Bind an integer 0/1 (not a JS boolean) into
      // BOTH the Digest call below and the Question INSERT so the recomputed
      // Question.MutationValid Digest matches the AdminSigning Digest — the
      // same single-source-of-truth pattern as the number-column Digest
      // coercion class (see schema-type-regression.spec.ts).
      const required = (q.required ?? true) ? 1 : 0
      // Select beachhead — only 'select' type supported (Pitfall 5 / quereus#21 deferral).
      const questionType = (q.type === 'select') ? 'select' : q.type

      // Step 3a: per-question AdminSigning('ceb') with 12-arg Question digest
      // (matches Question.MutationValid at qsql:725-734).
      //
      // 39-03 (DEBT-11, D-06 resolution 1): when the caller supplies a reusable
      // per-digest `sign` callback (mirrors seedElectionRevisionSigning's own
      // compute-Digest-via-SQL -> await sign(bytes) -> bind pattern), produce a
      // REAL secp256k1 signature over this row's own canonical Digest and bind
      // IsPlaceholderSignature = false so AdminSigning.SignatureValid (999.1-07)
      // actually verifies it. Only fall back to the legacy placeholder when no
      // callback is supplied (documented category-① path for callers that have
      // not yet threaded one — e.g. `debugSeedPendingTasks`).
      const qDigestArgs = {
        ballotId,
        code: q.code,
        title: q.title,
        instructions: q.instructions,
        dependsOn,
        type: questionType,
        optionRange,
        scoreRange,
        grouping,
        sequence,
        required,
      }

      // 62-11 (D-10, resumable/idempotent): skip the whole AdminSigning+signDerived+insert trio
      // when this Question row already exists — a retry (WR-05) or a direct re-invocation (C11)
      // must not re-spend a signature or collide on (BallotId, Code).
      const existingQuestion = await this.ctx!.db
        .prepare('select 1 as x from Question where BallotId = :ballotId and Code = :code')
        .get({ ballotId, code: q.code })
      if (!existingQuestion) {
        const {
          userId: qUserId,
          signerKey: qSignerKey,
          signature: qSignature,
          isPlaceholder: qIsPlaceholder,
        } = await this.resolveRowSignature(
          'select Digest(1, :ballotId, :code, :title, :instructions, :dependsOn, :type, :optionRange, :scoreRange, :grouping, :sequence, :required) as d',
          qDigestArgs,
          'Question',
          sign
        )
        const qNonce = (globalThis as { crypto: { randomUUID: () => string } }).crypto.randomUUID()
        const qIsSignerKeyValid = await adminSigningKeyValidity(this.ctx!.db, {
          userId: qUserId ?? '',
          signerKey: qSignerKey,
          now,
          isPlaceholderSignature: qIsPlaceholder,
        })
        await this.ctx!.db.exec(
          `insert into AdminSigning (
            Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature
          )
          with context now = :now, IsSignerKeyValid = :isSignerKeyValid, IsPlaceholderSignature = :isPlaceholderSignature
          values (
            :nonce, :authorityId, :adminEffectiveAt, 'ceb',
            Digest(1, :ballotId, :code, :title, :instructions, :dependsOn, :type, :optionRange, :scoreRange, :grouping, :sequence, :required),
            :userId, :signerKey, :signature
          )`,
          {
            nonce: qNonce,
            authorityId: pbRow.AuthorityId,
            adminEffectiveAt,
            ...qDigestArgs,
            userId: qUserId,
            signerKey: qSignerKey,
            signature: qSignature,
            isPlaceholderSignature: qIsPlaceholder,
            now,
            isSignerKeyValid: qIsSignerKeyValid,
          }
        )

        // Step 3b: signDerived to create AdminSignature (62-07 Finding 4.1 / 62-11 handoff (a)) —
        // this row inherits satisfaction from the ALREADY-reached header (headerNonce), rather
        // than recounting this derived session's own (typically threshold-1, non-holder) signer
        // set. 999.1 R-02/R-04 (DEBT-11): same real-vs-placeholder branch as above — the
        // OfficerSignature counter-signature verifies against this SAME AdminSigning Digest
        // (OfficerSignature.SignatureValid), so reuse the identical signature bytes when
        // real-signed.
        const qSig = {
          signerUserId: qUserId ?? '',
          signerKey: qSignerKey,
          signature: qSignature,
        }
        await this.signingEngine!.signDerived(qNonce, qSig, headerNonce, { isPlaceholderSignature: qIsPlaceholder })

        // Step 3c: INSERT Question row (Ballot must already exist — BallotIdValid constraint, D-08)
        await this.ctx!.db.exec(
          `insert into Question (
            BallotId, Code, Title, Instructions, DependsOn, Type,
            OptionRange, ScoreRange, Grouping, Sequence, Required
          )
          with context SigningNonce = :nonce, Tid = 1, now = :now
          values (
            :ballotId, :code, :title, :instructions, :dependsOn, :type,
            :optionRange, :scoreRange, :grouping, :sequence, :required
          )`,
          {
            nonce: qNonce,
            ballotId,
            code: q.code,
            title: q.title,
            instructions: q.instructions,
            dependsOn,
            type: questionType,
            optionRange,
            scoreRange,
            grouping,
            sequence,
            required,
            now,
          }
        )
      }

      // Step 4: per-option promotion — INSERT AFTER the parent Question (D-08, CLOSED).
      //
      // D-08 was previously deferred because Option.Sequence was declared `Sequence number`,
      // and Quereus 3.3.0 coerces any JS integer bound to a `number`-typed column to a blob
      // in vtab storage. The deferred MutationValid CHECK then read that blob and recomputed a
      // different Digest than the integer-valued Digest stored in AdminSigning at INSERT time,
      // failing the constraint. The schema fix (Option.Sequence → `integer null`, matching the
      // Question table and the table's own SequenceValid `typeof = 'integer'` check) makes an
      // integer round-trip as an integer, so the AdminSigning Digest and the deferred
      // MutationValid Digest now match. (The `number`→`integer null` change is a no-cost
      // correction — no Option rows were ever persisted before this fix.)
      //
      // Option.MutationValid digest: Digest(context.Tid, new.BallotId, new.QuestionCode,
      //   new.Code, new.Sequence, new.Title, new.Details, new.InfoURL, new.Image, new.Video).
      // Each Option INSERT is a separate db.exec call (parent Ballot/Question already committed).
      const qOptions = q.options ?? []
      for (let oi = 0; oi < qOptions.length; oi++) {
        const o = qOptions[oi]!
        const oSequence = oi
        const oDetails = o.details ?? null
        const oInfoURL = o.infoURL ?? null
        const oImage = o.image ? JSON.stringify(o.image) : null
        const oVideo = o.video ? JSON.stringify(o.video) : null

        // Step 4a: per-option AdminSigning('ceb') with the 10-arg Option digest
        //
        // 39-03 (DEBT-11, D-06 resolution 1): same real-vs-placeholder branch as the
        // Question path above — real-sign when the caller supplied a `sign` callback,
        // else fall back to the documented placeholder.
        const oDigestArgs = {
          ballotId,
          questionCode: q.code,
          code: o.code,
          sequence: oSequence,
          title: o.title,
          details: oDetails,
          infoURL: oInfoURL,
          image: oImage,
          video: oVideo,
        }

        // 62-11 (D-10, resumable/idempotent): skip the whole trio when this Option row already
        // exists — same reasoning as the Question skip above.
        const existingOption = await this.ctx!.db
          .prepare('select 1 as x from Option where BallotId = :ballotId and QuestionCode = :questionCode and Code = :code')
          .get({ ballotId, questionCode: q.code, code: o.code })
        if (existingOption) continue

        const {
          userId: oUserId,
          signerKey: oSignerKey,
          signature: oSignature,
          isPlaceholder: oIsPlaceholder,
        } = await this.resolveRowSignature(
          'select Digest(1, :ballotId, :questionCode, :code, :sequence, :title, :details, :infoURL, :image, :video) as d',
          oDigestArgs,
          'Option',
          sign
        )
        const oNonce = (globalThis as { crypto: { randomUUID: () => string } }).crypto.randomUUID()
        const oIsSignerKeyValid = await adminSigningKeyValidity(this.ctx!.db, {
          userId: oUserId ?? '',
          signerKey: oSignerKey,
          now,
          isPlaceholderSignature: oIsPlaceholder,
        })
        try {
          await this.ctx!.db.exec(
            `insert into AdminSigning (
              Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature
            )
            with context now = :now, IsSignerKeyValid = :isSignerKeyValid, IsPlaceholderSignature = :isPlaceholderSignature
            values (
              :nonce, :authorityId, :adminEffectiveAt, 'ceb',
              Digest(1, :ballotId, :questionCode, :code, :sequence, :title, :details, :infoURL, :image, :video),
              :userId, :signerKey, :signature
            )`,
            {
              nonce: oNonce,
              authorityId: pbRow.AuthorityId,
              adminEffectiveAt,
              ...oDigestArgs,
              userId: oUserId,
              signerKey: oSignerKey,
              signature: oSignature,
              isPlaceholderSignature: oIsPlaceholder,
              now,
              isSignerKeyValid: oIsSignerKeyValid,
            }
          )
        } catch (err) {
          this.rethrow(err, 'finalizeBallot (option AdminSigning)')
        }

        // Step 4b: signDerived to create AdminSignature (62-07 Finding 4.1 / 62-11 handoff (a)) —
        // same header-inheritance reasoning as the Question path above. 999.1 R-02/R-04
        // (DEBT-11): reuse the same real signature bytes as the AdminSigning row above
        // (OfficerSignature verifies against that same Digest).
        const oSig = {
          signerUserId: oUserId ?? '',
          signerKey: oSignerKey,
          signature: oSignature,
        }
        await this.signingEngine!.signDerived(oNonce, oSig, headerNonce, { isPlaceholderSignature: oIsPlaceholder })

        // Step 4c: INSERT Option row (Ballot + parent Question already exist — constraints satisfied)
        try {
          await this.ctx!.db.exec(
            `insert into Option (
              BallotId, QuestionCode, Code, Sequence, Title, Details, InfoURL, Image, Video
            )
            with context SigningNonce = :nonce, Tid = 1, now = :now
            values (
              :ballotId, :questionCode, :code, :sequence, :title, :details, :infoURL, :image, :video
            )`,
            {
              nonce: oNonce,
              ballotId,
              questionCode: q.code,
              code: o.code,
              sequence: oSequence,
              title: o.title,
              details: oDetails,
              infoURL: oInfoURL,
              image: oImage,
              video: oVideo,
              now,
            }
          )
        } catch (err) {
          this.rethrow(err, 'finalizeBallot (option)')
        }
      }
    }
    // D-04: ProposedBallot is NOT deleted — retained for history.
  }

  /**
   * 62-11 (D-10) — true only when `finalizeBallot`'s entire artifact already exists for
   * `ballotId`: the Ballot row, every ProposedBallot question code has a Question row, and every
   * one of that question's options has an Option row. Used by `completeSignature`'s finalize
   * gate so a `thresholdReached` (but not `crossedNow`) accept — the WR-05 retry shape — still
   * finalizes when the PRIOR attempt left the artifact incomplete, while a genuinely late
   * signature (artifact already complete) takes the recorded, non-finalizing path (D-10).
   */
  private async isBallotFinalizeComplete (ballotId: string): Promise<boolean> {
    const ballotRow = await this.ctx!.db.prepare('select 1 as x from Ballot where Id = :id').get({ id: ballotId })
    if (!ballotRow) return false

    const pbRow = await this.ctx!.db
      .prepare('select Questions from ProposedBallot where Id = :ballotId')
      .get({ ballotId }) as { Questions: string | null } | undefined
    const questions = parseJsonOr<Question[]>(pbRow?.Questions, [], 'ProposedBallot.Questions')

    for (const q of questions) {
      const questionCount = await this.ctx!.db
        .prepare('select count(*) as n from Question where BallotId = :ballotId and Code = :code')
        .get({ ballotId, code: q.code })
      if (Number(questionCount?.n ?? 0) === 0) return false

      const expectedOptions = q.options?.length ?? 0
      if (expectedOptions > 0) {
        const optionCount = await this.ctx!.db
          .prepare('select count(*) as n from Option where BallotId = :ballotId and QuestionCode = :code')
          .get({ ballotId, code: q.code })
        if (Number(optionCount?.n ?? 0) < expectedOptions) return false
      }
    }
    return true
  }

  /**
   * 62-13 (D-10) — true only when the admin promotion artifact already exists for `taskId`'s
   * proposal: both the `AdminSignatureTaskExtension` row (AuthorityId, AdminEffectiveAt) and a
   * live `Admin` row at that key. Mirrors `isBallotFinalizeComplete`'s shape exactly (a
   * `count(*)`/`select 1` probe against the artifact table, not a shared cross-scope helper).
   * Used by `completeSignature`'s admin gate so a `thresholdReached` (but not `crossedNow`)
   * accept — the resume shape, after a refused or failed promotion — still re-attempts
   * promotion, while a genuinely late signature (the Admin row already exists) takes the
   * recorded, non-promoting path (D-10). Returns `false` (never promoted) when either row is
   * missing.
   */
  private async isAdminPromotionComplete (taskId: string): Promise<boolean> {
    const extRow = await this.ctx!.db
      .prepare('select AuthorityId, AdminEffectiveAt from AdminSignatureTaskExtension where TaskId = :taskId')
      .get({ taskId }) as { AuthorityId: string; AdminEffectiveAt: string } | undefined
    if (!extRow) return false
    const adminRow = await this.ctx!.db
      .prepare('select 1 as x from Admin where AuthorityId = :authorityId and EffectiveAt = :adminEffectiveAt')
      .get({ authorityId: extRow.AuthorityId, adminEffectiveAt: extRow.AdminEffectiveAt })
    return !!adminRow
  }

  /**
   * WR-19 (T-48-34-01..-05) — the single payload-acceptability gate for a registrant approval.
   * Called from TWO sites: `completeSignature`, BEFORE `signingEngine.sign()` consumes the
   * officer's real header signature (the fix), and again from `finalizeRegistrantApproval` itself,
   * as defence in depth for any future caller that reaches finalize directly. One gate, two call
   * sites, zero duplicated SQL or message text — a grep gate (`registrant-approval.spec.ts`'s own
   * regression coverage plus this plan's acceptance criteria) keeps them from drifting apart.
   *
   * Resolves the request by joining the extension row — finalizeBallot's own opening shape.
   * SubmittedAt/ReceivedAt are read here too: the decision UPDATE further down (in
   * finalizeRegistrantApproval) must explicitly rebind them (a partial UPDATE that leaves them
   * unbound — or even self-referencing, `SubmittedAt = SubmittedAt` — makes Quereus re-validate the
   * unqualified SubmittedAtValid/ReceivedAtValid CHECKs against a Z-STRIPPED reconstruction of the
   * row, a real, empirically-confirmed defect class this phase discovered; T-42-06 documents the
   * same stripping for plain reads). restoreCanonicalDatetime (below) reconstructs the exact
   * fixed-3-digit-millisecond, Z-suffixed byte form every write in this codebase produces via
   * toIsoZDatetime, which SubmittedAt must match byte-for-byte — RegistrationRequest.SignatureValid
   * is UNQUALIFIED (re-evaluates on every update, not just insert) and recomputes
   * Digest(Id, AuthorityId, RequesterKey, IssuerType, BridgeId, PayloadCid, SubmittedAt) against
   * the REQUESTER's original signature, so a merely Z-suffixed-but-truncated SubmittedAt would
   * silently break that verification.
   *
   * Refuses:
   *  - a missing extension row, a non-pending RegistrationRequest, or an unparseable Payload;
   *  - CR-02 (T-48-31-01): init.registrant.authorityId is chosen by the UNAUTHENTICATED requester
   *    (D-02) and covered only by the requester's own signature. RegistrationEngine.register()'s
   *    only cross-authority guard compares the payload against an ELECTION's authority
   *    (register(), registration-engine.ts's electionAuthorityId check) and cannot see the
   *    authority THIS request was addressed to. The only authority this approval may mint a
   *    Registrant under is extRow.AuthorityId — the one whose officer is signing DG-2 in
   *    finalizeRegistrantApproval;
   *  - CR-03 (T-48-31-02): init.registrant.id is also requester-chosen. register() is unconditional
   *    (see finalizeRegistrantApproval's own comment for why the old convergence guard is gone
   *    rather than merely relocated) — refuse the id collision here, exactly like CR-02 above.
   *  - WR-20: `init.electionId` is the OTHER requester-chosen, authority-scoped payload field, and
   *    it decides whether `validateFieldPolicy` runs at all. See the inline comment at the check
   *    itself for what is closed (omission bypass; steering at a policy-free election of the same
   *    authority) and what is not (choosing among several policy-bearing elections);
   *  - WR-01: no signed-in officer. `RegistrationRequest.DecisionValid` accepts a null
   *    DecidingOfficerUserId and the DG-2 digest simply binds `null`, so an unattributable APPROVAL
   *    — the more consequential of the two decisions — would otherwise be writable while
   *    `rejectRegistrationRequest` (registration-engine.ts) already refuses the same column's null
   *    with "a rejection must be attributable". The asymmetry was backwards and D-06's
   *    attributability claim did not hold for approvals. Refused HERE rather than at the
   *    finalizeRegistrantApproval write site so it lands on the pre-sign side of WR-19's ordering:
   *    an anonymous accept never spends the officer's header signature either.
   *
   * WR-19 is closed by WHERE this gate is called from completeSignature (before sign()), not by
   * anything in this method's own body — this method's refusals are the same whether they run
   * before or after a signature was spent. WR-05 (a finalize failure AFTER this gate passes) is a
   * separate concern and is closed separately, by `SigningEngine.sign()`'s idempotency probe on
   * (SigningNonce, UserId) — see signing-engine.ts. Neither fix subsumes the other: this gate
   * stops a refusable payload from spending a signature at all, and that probe stops an
   * already-spent signature from making a retry impossible.
   */
  private async resolveAcceptableRegistrantApproval (taskId: string): Promise<{
    requestId: string
    authorityId: string
    init: RegisterInit
    submittedAt: string
    receivedAt: string
    decidingOfficerUserId: string
  }> {
    const ctx = this.ctx!

    // WR-01: mirror rejectRegistrationRequest's refusal verbatim in intent — an unattributable
    // approval is a permanent record no one can be held to, degrading D-06 to a bare status flag.
    const decidingOfficerUserId = ctx.user?.id ?? null
    if (!decidingOfficerUserId) {
      throw new Error(
        'SignatureTasksEngine.resolveAcceptableRegistrantApproval: no signed-in officer (ctx.user) — an approval must be attributable'
      )
    }
    const extRow = await ctx.db
      .prepare(
        `select E.RequestId, R.AuthorityId, R.Payload, R.PayloadCid, R.Status, R.SubmittedAt, R.ReceivedAt
           from RegistrantSignatureTaskExtension E
             join RegistrationRequest R on R.Id = E.RequestId
           where E.TaskId = :taskId`
      )
      .get({ taskId }) as {
        RequestId: string
        AuthorityId: string
        Payload: string
        PayloadCid: string
        Status: string
        SubmittedAt: string
        ReceivedAt: string
      } | undefined
    if (!extRow) {
      throw new Error(`SignatureTasksEngine.resolveAcceptableRegistrantApproval: no RegistrantSignatureTaskExtension for taskId=${taskId}`)
    }
    const requestId = extRow.RequestId
    // The exact spelling the requester signed (resolveSignedSubmittedAt); ReceivedAt is engine-written.
    const submittedAt = await resolveSignedSubmittedAt(this.ctx!.db, 'RegistrationRequest', requestId, extRow.SubmittedAt)
    const receivedAt = restoreCanonicalDatetime(extRow.ReceivedAt)

    // A decided request is not re-decidable — DecisionValid enforces this too; this engine-side
    // check exists only to produce an attributable error, not as the actual boundary.
    if (extRow.Status !== 'p') {
      throw new Error(
        `SignatureTasksEngine.resolveAcceptableRegistrantApproval: RegistrationRequest ${requestId} is not pending (Status=${extRow.Status})`
      )
    }

    // D-49 (62-31): open BEFORE every other gate below, including the D-44 closure check — an
    // officer who cannot read this request's payload must never be told anything MORE specific
    // about it (closed-as-duplicate, authority mismatch, ...) than "cannot be approved here".
    const payloadRead = await openRegistrationPayload(ctx.db, ctx.intakeOpener, { requestId, payloadCid: extRow.PayloadCid, stored: extRow.Payload })
    if (payloadRead.access !== 'opened' && payloadRead.access !== 'unsealed') {
      throw new RegistrationContentAccessError(payloadRead.access, requestId)
    }
    const init = payloadRead.payload

    // D-44 (62-19): a request closed or closing as a duplicate cannot be decided — checked BEFORE
    // sign() (this is called from completeSignature's pre-check, ahead of any signature spend).
    const duplicateClosure = await readDuplicateClosure(ctx.db, requestId, extRow.AuthorityId)
    if (duplicateClosure) {
      throw new RegistrationDuplicateError(
        'closed-as-duplicate',
        requestId,
        'This request was closed as a duplicate of another request and can no longer be decided.',
        duplicateClosure.closedByRequestId ?? undefined
      )
    }

    if (init.registrant?.authorityId !== extRow.AuthorityId) {
      throw new Error(
        `SignatureTasksEngine.resolveAcceptableRegistrantApproval: RegistrationRequest ${requestId} payload registers under authority ${String(init.registrant?.authorityId)}, not the addressed authority ${extRow.AuthorityId}`
      )
    }

    // WR-22: the officer driving this mint must hold `'vrg'` AT THE ADDRESSED AUTHORITY, in its
    // CURRENT administration. Nothing downstream supplies this: `AdminSigning.UserIdValid` tests
    // Officer membership and never reads `Officer.Scopes`, `AdminSigning.SignerKeyValid` and
    // `OfficerSignature.OfficerValid` are hardcoded stubs, and `SigningEngine.sign`'s threshold
    // falls back to 1 when the authority declares no `'vrg'` policy — so before this check any
    // officer of any scope could single-handedly mint a Registrant.
    //
    // Checked HERE as well as in the seed predicate, and the duplication is deliberate: the seed
    // predicate decides what appears in the inbox, while this decides what may be MINTED. A task
    // seeded before an officer's scopes were narrowed would otherwise still be completable, and
    // `finalizeRegistrantApproval` is reachable independently of a seed pass. `CurrentAdmin` is
    // joined for the same reason the seed predicate joins it: an officer of a SUPERSEDED
    // administration must not qualify.
    const vrgOfficer = await ctx.db
      .prepare(
        `select 1 as x from Officer O
           join CurrentAdmin CA on CA.AuthorityId = O.AuthorityId and CA.EffectiveAt = O.AdminEffectiveAt
           where O.AuthorityId = :authorityId and O.UserId = :userId
             and exists (select 1 from json_each(O.Scopes) where value = 'vrg')
           limit 1`
      )
      .get({ authorityId: extRow.AuthorityId, userId: decidingOfficerUserId })
    if (!vrgOfficer) {
      throw new Error(
        `SignatureTasksEngine.resolveAcceptableRegistrantApproval: user ${decidingOfficerUserId} does not hold the 'vrg' scope in authority ${extRow.AuthorityId}'s current administration — refusing to mint a Registrant`
      )
    }

    // WR-20: `registrant.authorityId` was not the only requester-chosen, authority-scoped field in
    // the payload. `electionId` is the other, and it is the switch that decides whether field
    // policy is enforced AT ALL: `RegistrationEngine.register` runs `validateFieldPolicy` only
    // `if (init.electionId)`, and D-09 records that there is NO schema CHECK backstop — so that
    // call is the entire enforcement. An unauthenticated submitter therefore chose both WHETHER a
    // policy applied (omit the field and none runs) and WHICH one did (name a laxer election of the
    // same authority), with the reviewing officer unable to see either choice: the approval screen
    // renders the payload, not the policy decision.
    //
    // What this gate decides authority-side, from data that already exists rather than an invented
    // "governing election" concept: the set of the ADDRESSED authority's elections that actually
    // declare a field policy (`ElectionRegistrationField` rows). If that set is empty there is no
    // policy at this authority and nothing to evade. If it is NOT empty, then a payload that names
    // no election, or that names an election of this authority carrying no policy, is refused —
    // closing both the omission bypass and the "steer at the policy-less sibling election" half of
    // the selection bypass.
    //
    // RESIDUAL, stated rather than glossed: when the authority has MORE THAN ONE policy-bearing
    // election, the requester still chooses which of them governs. Closing that needs a genuine
    // governing-election concept — a per-request column, or a defined "currently open for
    // registration" election — which is a schema and product decision, not a code-review fix. This
    // gate removes the two evasions that need no election-selection semantics at all; it does not
    // claim to close the class.
    //
    // Placed in this gate (not in `register()`) on purpose: it runs pre-`sign()` at the
    // `completeSignature` call site, so a payload that will be refused never spends the officer's
    // header signature (WR-19's ordering). `register()`'s own election-ownership check is
    // unchanged and still runs — this is an additional, narrower gate, not a replacement.
    const policyBearingElections = await ctx.db
      .prepare(
        `select count(*) as n from ElectionRegistrationField F
           join Election E on E.Id = F.ElectionId
           where E.AuthorityId = :authorityId`
      )
      .get({ authorityId: extRow.AuthorityId })
    if (Number(policyBearingElections?.n ?? 0) > 0) {
      if (!init.electionId) {
        throw new Error(
          `SignatureTasksEngine.resolveAcceptableRegistrantApproval: RegistrationRequest ${requestId} names no electionId, but authority ${extRow.AuthorityId} declares registration field policy — a payload may not opt out of the policy by omission`
        )
      }
      const governedElection = await ctx.db
        .prepare(
          `select 1 as x from ElectionRegistrationField F
             join Election E on E.Id = F.ElectionId
             where E.AuthorityId = :authorityId and F.ElectionId = :electionId
             limit 1`
        )
        .get({ authorityId: extRow.AuthorityId, electionId: init.electionId })
      if (!governedElection) {
        throw new Error(
          `SignatureTasksEngine.resolveAcceptableRegistrantApproval: RegistrationRequest ${requestId} names election ${String(init.electionId)}, which declares no registration field policy at authority ${extRow.AuthorityId} — refusing a payload that selects a policy-free election while the authority declares one`
        )
      }
    }

    // R2/D-04/D-05 (57-02): kept as defence-in-depth, NOT redundant — this call runs
    // BEFORE the header AdminSigning/officer signature is spent (completeSignature calls
    // this SAME gate ahead of signingEngine.sign(), T-48-34-01/02), so a colliding
    // registrantId is refused before the officer's signature is consumed. register()'s
    // OWN pre-BEGIN guard (registration-engine.ts) fires later — only once
    // finalizeRegistrantApproval actually calls register(), which is after the signature
    // has already been spent. Throws the SAME typed error register() throws so both
    // paths are instanceof-identical and there is exactly one message for this condition
    // (must_haves: "Only ONE error message exists for the already-registered condition").
    const existingRegistrant = await ctx.db
      .prepare('select 1 from Registrant where Id = :id')
      .get({ id: init.registrant.id })
    if (existingRegistrant) {
      throw new RegistrantAlreadyExistsError(init.registrant.id, requestId)
    }

    return { requestId, authorityId: extRow.AuthorityId, init, submittedAt, receivedAt, decidingOfficerUserId }
  }

  /**
   * 62-11 (D-10) — the RegistrationRequest.Status of the request a Task's
   * RegistrantSignatureTaskExtension points to, or `undefined` if the extension row is missing.
   * Used by `completeSignature`'s late-signature detection and finalize gate, and by
   * `finalizeRegistrantApproval`'s own idempotency guard below.
   */
  private async readRegistrantRequestStatus (taskId: string): Promise<string | undefined> {
    const row = await this.ctx!.db
      .prepare(
        `select R.Status from RegistrantSignatureTaskExtension E
           join RegistrationRequest R on R.Id = E.RequestId
           where E.TaskId = :taskId`
      )
      .get({ taskId })
    return row?.Status as string | undefined
  }

  /**
   * D-05/D-07 — the registrant accept ceremony. `RegistrationEngine.register()` is reused
   * UNCHANGED except for the optional `headerNonce` passthrough (derived-session inheritance,
   * research Finding 4.1) — it was always correct, and the defect this phase corrects was only
   * ever that the voter app supplied a founding-officer key it held. This method changes WHO
   * DRIVES `register()`, not what `register()` does. A second `register()`-shaped write path
   * (an inline `insert into Registrant`, a copy of `register()`'s body, etc.) must never be
   * created here.
   *
   * 62-11 (D-10) — idempotent: if the request is ALREADY decided ('a'), this is a no-op. Every
   * other status ('p', 'r') flows into the unchanged pre-check below, which still refuses a
   * rejected ('r') request and the CR-03 id collision.
   */
  private async finalizeRegistrantApproval (
    taskId: string,
    decision: RegistrationRequestDecision,
    sign: (digest: Uint8Array) => Promise<Signature>,
    headerNonce: string
  ): Promise<void> {
    const ctx = this.ctx!

    // 62-11 (D-10, second defence against concurrent crossers/retries): if the decision already
    // landed, there is nothing left to finalize.
    if ((await this.readRegistrantRequestStatus(taskId)) === 'a') {
      return
    }

    // T-48-34-05: defence in depth — completeSignature already calls this SAME gate BEFORE
    // signingEngine.sign() (T-48-34-01/02), so by the time execution reaches here the payload has
    // already been proven acceptable. This second call exists so a future caller that reaches
    // finalizeRegistrantApproval directly gets the SAME refusals from the SAME producer — never a
    // duplicated or drifted copy of the CR-02/CR-03 checks.
    const { requestId, authorityId, init, submittedAt, receivedAt, decidingOfficerUserId } = await this.resolveAcceptableRegistrantApproval(taskId)

    const tid = await allocateTid(ctx.db, 'registration-request')

    // D-07: derive VerificationCid through 48-06's injected-digest helper — never a hand-rolled JS
    // hash. The callback runs the SAME select cid(Digest(:canonical)) call shape
    // computeRegistrantPrivateCid uses.
    const cid = await verificationCid(decision.checklist, async (canonical: string) => {
      const row = await ctx.db.prepare('select cid(Digest(:canonical)) as c').get({ canonical })
      if (!row || row.c == null) {
        throw new Error('SignatureTasksEngine.finalizeRegistrantApproval: cid(Digest(...)) returned null — crypto plugin not registered?')
      }
      return row.c as string
    })

    // DecidedAt must carry a trailing 'Z' (DecidedAtValid's like('%Z', ...)) — toIsoZDatetime, NEVER
    // nowCanonicalDatetime() (48-02 hygiene item 3).
    const decidedAt = toIsoZDatetime(Date.now())
    // WR-01: `decidingOfficerUserId` is produced by resolveAcceptableRegistrantApproval (above),
    // which refuses a null one outright — it is a non-null string by the time it reaches the DG-2
    // digest and the decision UPDATE, and it is never re-derived from ctx.user here (one producer,
    // so the digested tuple and the stored row cannot disagree about who decided).

    // DG-2, field for field: Digest(context.Tid, new.Id, new.Status, new.VerificationCid,
    // new.DecidedAt, new.DecidingOfficerUserId, new.RejectionReason). rejectionReason binds null and
    // the UPDATE below leaves the column null, so the digested tuple and the stored row agree.
    // `decidingOfficerUserId` is a DELIBERATE defensive rename — bare `userId` is one of
    // seedSignedMutation's eight reserved bind names and would be silently overwritten by the
    // helper's own ceremony binds (the real Phase 42-03 bug; registration-engine.ts NOTE 1).
    //
    // T-42-03: RegistrationRequest.DecisionValid contains a subquery, so it is a DEFERRED CHECK —
    // Quereus re-derives `new.DecidedAt` from a Temporal.PlainDateTime-coerced snapshot (Z
    // stripped, fractional seconds at MINIMAL precision) when it re-evaluates at COMMIT. The
    // digest bound into AdminSigning.Digest (below, via seedSignedMutation) MUST use that SAME
    // coerced form or DecisionValid's re-derivation will never match the stored Digest — this is
    // the prior-attempt trap: it surfaces as "CHECK constraint failed: DecisionValid" and reads
    // like a signature bug, not a datetime-formatting one. The STORED DecidedAt column (the UPDATE
    // below) still uses the RAW toIsoZDatetime value — only the DIGEST argument is coerced.
    const decidedAtForDigest = toDeferredCheckDatetime(decidedAt)
    const digestExpr = 'select Digest(:tid, :requestId, :status, :verificationCid, :decidedAt, :decidingOfficerUserId, :rejectionReason) as d'
    const digestParams = {
      tid,
      requestId,
      status: 'a',
      verificationCid: cid,
      decidedAt: decidedAtForDigest,
      decidingOfficerUserId,
      rejectionReason: null,
    }

    // The reviewing officer's OWN reusable per-digest callback produces a real signature over
    // DG-2 — this is the D-07 weld: VerificationCid rides inside the SAME digest as Status/
    // DecidedAt/DecidingOfficerUserId/RejectionReason, so the officer's real signature
    // transitively covers the checklist. This runs under a 'vrg'-scoped AdminSigning ceremony —
    // AdminSigning.UserIdValid requires merely that the signer be some officer at that authority —
    // it does not require a 'vrg'-scoped officer specifically (Phase 999.1).
    const decisionNonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, sign, { headerNonce })

    // D-12 (51-09): the authority OWNS the validity of a record it signs — a submitter-proposed
    // expiration (e.g. `ConfirmationScreen.tsx:150`'s ten-year "dev posture" window) is IGNORED
    // here, never trusted. Read through the SAME `ElectionRecordValidityPolicy`-backed helper
    // `AssociationEngine.associate()` reads for the Association/AssociationPrivate expiration
    // (`../association/record-validity.js`) so both record-validity sites agree, then override
    // ALL THREE `RegisterInit` expiration fields BEFORE `register()` runs below — `register()`'s
    // own digests are computed from `init` at call time, so overriding here (rather than after)
    // keeps the digest and the stored row in agreement by construction; no separate re-signing
    // step is needed.
    const { registrantExpiration } = await resolveRecordValidity(ctx, init.electionId)
    init.registrant.expiration = registrantExpiration
    init.private.expiration = registrantExpiration
    if (init.selective) {
      init.selective.expiration = registrantExpiration
    }

    // register()-then-decide ordering: register() opens its own BEGIN/COMMIT envelope and cannot
    // share a transaction with the decision UPDATE below, so the two are ordered register()-then-
    // decide. register() is now UNCONDITIONAL — the CR-03 existence refusal in
    // resolveAcceptableRegistrantApproval already ruled out an id collision, so there is nothing
    // left to converge on here.
    //
    // T-48-11-11 (superseded, and superseded AGAIN by WR-19/T-48-34): the previous existence-gated
    // guard around this call was justified as making a RETRIED approval converge instead of
    // colliding on the Registrant primary key. That reasoning is still correct as far as it goes —
    // completeSignature calls sign() (this task's header signature) BEFORE
    // finalizeRegistrantApproval runs, and OfficerSignature's primary key is (SigningNonce, UserId)
    // with a fixed per-task SigningNonce, so a retried approval used to collide on that PK long
    // before it would ever reach this guard — but its conclusion no longer applies to a REFUSED
    // approval as of this plan: resolveAcceptableRegistrantApproval is now ALSO called from
    // completeSignature, before sign() ever runs, so a payload this method would refuse never
    // reaches that PK-collision ordering at all — the officer's signature is never spent, and a
    // retried accept raises the SAME refusal rather than a UNIQUE constraint error. Removing the
    // guard here therefore removes no behaviour that was reachable; it only stops an id collision
    // from being laundered into a silent no-op success.
    //
    // WR-05 UPDATE: the PK-collision premise above no longer holds either. `SigningEngine.sign()`
    // is now idempotent on (SigningNonce, UserId), so a retried accept re-enters this method
    // rather than dying at sign() — and it must, because that retryability is the entire point of
    // the WR-05 fix. The CR-03 refusal is what stops the retry from silently adopting a
    // pre-existing Registrant; it does not rely on sign() throwing.
    // RegistrationEngine.register() — reused with the reviewing officer's own device-signer
    // callback, unchanged except for the optional headerNonce passthrough (62-11, research
    // Finding 4.1). No wrapper, no reimplementation, no inline Registrant insert.
    await new RegistrationEngine(ctx).register(init, sign, { headerNonce })

    await ctx.db.exec(
      // SubmittedAt/ReceivedAt are explicitly rebound (restoreCanonicalDatetime, above) rather than
      // left untouched or self-referenced (`SubmittedAt = SubmittedAt`) — empirically, EITHER of
      // those leaves Quereus's unqualified SubmittedAtValid/ReceivedAtValid CHECKs evaluating a
      // Z-stripped reconstruction of the row on this UPDATE (a real, previously-undiscovered defect
      // class this plan surfaced; T-42-06 documents the same stripping for plain reads elsewhere).
      `update RegistrationRequest
       with context SigningNonce = :signingNonce, Tid = ${tid}
       set Status = 'a', VerificationCid = :verificationCid, DecidedAt = :decidedAt, DecidingOfficerUserId = :decidingOfficerUserId,
           SubmittedAt = :submittedAt, ReceivedAt = :receivedAt
       where Id = :requestId`,
      {
        signingNonce: decisionNonce,
        verificationCid: cid,
        decidedAt,
        decidingOfficerUserId,
        submittedAt,
        receivedAt,
        requestId,
      }
    )
  }

  /**
   * D-03 — Return the engine-authoritative `AdminSigning.Digest` bytes for the
   * pending task. The screen passes these bytes to the device-signer callback
   * and never recomputes any canonical form itself.
   *
   * Look-up mirrors the task-row query used by `completeSignature` (same
   * `(userId, signatureType, IsCompleted=0)` filter). Then reads
   * `AdminSigning.Digest` for that nonce and converts via `digestToBytes`
   * (the same helper used throughout the engine for the Digest → Uint8Array
   * conversion, WR-01 single source of truth).
   *
   * No key material enters this method — only bytes are returned (D-01/D-03).
   */
  async getSignatureDigest (task: SignatureTask): Promise<Uint8Array> {
    this.requireCtx('getSignatureDigest')
    // D-05 / CR-01: For ballot tasks, scope the lookup by the ballot id
    // carried on the BallotSignatureTask so that with >=2 pending ballot
    // tasks the correct AdminSigning.Digest is returned — not an arbitrary
    // LIMIT-1 row.
    let taskRow: { Id: string; SigningNonce: string } | undefined
    if (task.signatureType === 'ballot') {
      const ballotId = (task as BallotSignatureTask).ballot.proposed.id
      taskRow = await this.ctx!.db
        .prepare(
          `select Task.Id, Task.SigningNonce from Task
            join BallotSignatureTaskExtension E on E.TaskId = Task.Id
            where Task.UserId = :userId
              and Task.Type = 'signature'
              and Task.SignatureType = :signatureType
              and Task.IsCompleted = 0
              and E.BallotId = :ballotId
            limit 1`
        )
        .get({
          userId: task.userId,
          signatureType: task.signatureType,
          ballotId,
        }) as { Id: string; SigningNonce: string } | undefined
      if (!taskRow) {
        throw new Error(
          `SignatureTasksEngine.getSignatureDigest: no pending ballot task for user=${task.userId} ballotId=${ballotId}`
        )
      }
    } else if (task.signatureType === 'registrant') {
      // L-3 (48-11): the SHARPER of the two disambiguation defects — left unscoped, an officer
      // with two pending registration requests would be shown, and would SIGN, the digest
      // belonging to the WRONG request. Scope by requestId exactly like the 'ballot' branch above.
      const requestId = (task as RegistrantSignatureTask).requestId
      taskRow = await this.ctx!.db
        .prepare(
          `select Task.Id, Task.SigningNonce from Task
            join RegistrantSignatureTaskExtension E on E.TaskId = Task.Id
            where Task.UserId = :userId
              and Task.Type = 'signature'
              and Task.SignatureType = :signatureType
              and Task.IsCompleted = 0
              and E.RequestId = :requestId
            limit 1`
        )
        .get({
          userId: task.userId,
          signatureType: task.signatureType,
          requestId,
        }) as { Id: string; SigningNonce: string } | undefined
      if (!taskRow) {
        throw new Error(
          `SignatureTasksEngine.getSignatureDigest: no pending registrant task for user=${task.userId} requestId=${requestId}`
        )
      }
    } else if (
      task.signatureType === 'admin' &&
      (task as AdminSignatureTask).authority?.id !== undefined &&
      (task as AdminSignatureTask).administration?.proposed?.effectiveAt !== undefined
    ) {
      // 62-13 (D-09, T-62-13-04): the SAME disambiguated admin lookup completeSignature uses —
      // an officer with several open admin tasks must be shown, and must sign, the digest of
      // the EXACT proposal its task names.
      taskRow = await findPendingAdminTaskRow(this.ctx!.db, task as AdminSignatureTask)
      if (!taskRow) {
        throw new Error(
          `SignatureTasksEngine.getSignatureDigest: no pending admin task for user=${task.userId} authorityId=${(task as AdminSignatureTask).authority?.id}`
        )
      }
    } else {
      taskRow = await this.ctx!.db
        .prepare(
          `select Id, SigningNonce from Task
            where UserId = :userId
              and Type = 'signature'
              and SignatureType = :signatureType
              and IsCompleted = 0
            limit 1`
        )
        .get({
          userId: task.userId,
          signatureType: task.signatureType,
        }) as { Id: string; SigningNonce: string } | undefined
      if (!taskRow) {
        throw new Error(
          `SignatureTasksEngine.getSignatureDigest: no pending task for user=${task.userId} signatureType=${task.signatureType}`
        )
      }
    }
    const nonce = taskRow.SigningNonce as string
    const signingRow = await this.ctx!.db
      .prepare('select Digest from AdminSigning where Nonce = :nonce')
      .get({ nonce })
    if (!signingRow) {
      throw new Error(
        `SignatureTasksEngine.getSignatureDigest: no AdminSigning row for nonce=${nonce}`
      )
    }
    try {
      return digestToBytes(signingRow.Digest)
    } catch (err) {
      this.rethrow(err, 'getSignatureDigest')
    }
  }

  /**
   * 62-12 (Surface 5, D-09/D-10/D-11) — read-only co-signing status for the session behind the
   * caller's OWN PENDING task. The nonce lookup is `findPendingTaskNonce`, deliberately the SAME
   * lookup `getSignatureDigest` above uses, so the returned status always describes exactly the
   * session the officer would sign. Returns `null` (never throws) when there is no ctx, no
   * signing engine, no pending task row, or no `AdminSigning` session for the resolved nonce.
   * Writes nothing; display-only (never an authorization input — see the interface doc comment).
   */
  async getTaskSigningStatus (task: SignatureTask): Promise<SigningStatus | null> {
    if (!this.ctx || !this.signingEngine) return null
    const nonce = await findPendingTaskNonce(this.ctx.db, task)
    if (nonce === undefined) return null
    return this.signingEngine.getSigningStatus(nonce)
  }

  /**
   * 62-27 (D-11 vrg) — read-only status of the registrant vrg session behind `requestId`,
   * independent of the caller's own task (which `getTaskSigningStatus` cannot see once it is
   * completed). Null when there is no ctx/signing engine or the session nonce is missing or
   * ambiguous. Writes nothing; display-only.
   */
  async getRegistrantSigningStatus (requestId: string): Promise<SigningStatus | null> {
    if (!this.ctx || !this.signingEngine) return null
    const nonce = await findRegistrantSessionNonce(this.ctx.db, requestId)
    if (nonce === undefined) return null
    return this.signingEngine.getSigningStatus(nonce)
  }

  buildCompleteSignature (): ISignatureTasksCompleteSignatureBuilder {
    return new CompleteSignatureBuilder(this)
  }

  // ---------- helpers ----------

  /**
   * IN-01 (39-REVIEW): shared real-vs-placeholder signature resolution for
   * finalizeBallot's per-Question and per-Option AdminSigning rows. Extracted
   * from what was previously two near-identical inline `let`-block copies —
   * behavior-preserving: the digest SQL and arg map passed in by each call
   * site are unchanged from the original inline code, so the signed digest
   * bytes and persisted Digest remain byte-for-byte identical to before.
   *
   * When `sign` is supplied, computes the row's canonical Digest via SQL,
   * invokes the caller's per-digest signer, and returns a REAL signature with
   * `isPlaceholder: false`. Otherwise falls back to the legacy placeholder
   * (documented category-① path — e.g. `debugSeedPendingTasks`).
   */
  private async resolveRowSignature (
    digestSql: string,
    digestArgs: Record<string, SqlValue>,
    rowLabel: string,
    sign?: (digest: Uint8Array) => Promise<Signature>
  ): Promise<{ userId: string | null; signerKey: string; signature: string; isPlaceholder: boolean }> {
    let userId = this.ctx!.user?.id ?? null
    let signerKey = this.ctx!.user?.activeKeys?.[0]?.key ?? '0'.repeat(66)
    let signature = '0'.repeat(128)
    let isPlaceholder = true
    if (sign) {
      const digestRow = await this.ctx!.db.prepare(digestSql).get(digestArgs)
      if (!digestRow || digestRow.d == null) {
        throw new Error(`SignatureTasksEngine.finalizeBallot: ${rowLabel} Digest() returned null`)
      }
      const digestBytes = digestToBytes(digestRow.d)
      const realSig = await sign(digestBytes)
      userId = realSig.signerUserId
      signerKey = realSig.signerKey
      signature = realSig.signature
      isPlaceholder = false
    }
    return { userId, signerKey, signature, isPlaceholder }
  }

  private requireCtx (method: string): void {
    if (!this.ctx) {
      throw new Error(
				`SignatureTasksEngine.${method}: no EngineContext bound — construct with (networkRef, ctx) for DB-backed methods`
      )
    }
  }

  private rethrow (err: unknown, method: string): never {
    return rethrowHelper(err, 'SignatureTasksEngine', method)
  }
}
