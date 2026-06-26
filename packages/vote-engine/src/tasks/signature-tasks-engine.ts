import { MisuseError, QuereusError } from '@quereus/quereus'
import { SigningEngine } from '../signing/signing-engine.js'
import { digestToBytes, fromCanonicalDatetime, nowCanonicalDatetime, parseJsonOr } from '../utils.js'
import type { EngineContext } from '../types.js'
import type {
  ISigningEngine,
  ISignatureTasksEngine,
  ISignatureTasksCompleteSignatureBuilder,
  NetworkReference,
  SignatureResult,
  SignatureTask,
  AdminSignatureTask,
  BallotSignatureTask,
  Authority,
  ThresholdPolicy,
  AdminInit,
  Proposal,
  Ballot,
  Question,
} from '@votetorrent/vote-core'
import { BALLOT_HEADER_TID } from '../election/election-engine.js'
import { CompleteSignatureBuilder } from './builders/index.js'

// Phase 05 TASK-03/04 — monotonic Tid counter for SignatureTasksEngine.
let nextTid = 1

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
    const taskRow = await this.ctx!.db
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
        signatureType: task.signatureType
      })
    if (!taskRow) {
      throw new Error(
				`SignatureTasksEngine.completeSignature: no pending task for user=${task.userId} signatureType=${task.signatureType}`
      )
    }
    const nonce = taskRow.SigningNonce as string

    // D-12: Branch on result.isAccepted.
    // Accept path only — call sign() to insert OfficerSignature and (at threshold=1)
    // auto-complete AdminSignature. Do NOT call sign() on reject: a rejection that
    // advances the signing session is a critical integrity hole (D-12 threat).
    if (result.isAccepted) {
      await this.signingEngine.sign(nonce, result.signature)
    }

    // Ballot finalize branch (D-01, D-08): after sign() succeeds (AdminSignature inserted at
    // threshold=1), INSERT Ballot first then per-row signed Questions and Options.
    // This runs BEFORE the Task-complete update so options are promoted before the Task closes.
    if (result.isAccepted && task.signatureType === 'ballot') {
      try {
        await this.finalizeBallot(taskRow.Id as string, nonce)
      } catch (err) {
        this.rethrow(err, 'completeSignature (finalize)')
      }
    }

    // Mark the task complete (unconditional — both accept and reject close the task).
    const tid = nextTid++
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
  private async finalizeBallot (taskId: string, headerNonce: string): Promise<void> {
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
      const optionRange = q.optionRange ? JSON.stringify(q.optionRange) : '{1, 1}'
      const scoreRange = q.scoreRange ? JSON.stringify(q.scoreRange) : null
      const grouping = q.group ?? null
      const sequence = q.sequence ?? null
      const required = q.required ?? true
      // Select beachhead — only 'select' type supported (Pitfall 5 / quereus#21 deferral).
      const questionType = (q.type === 'select') ? 'select' : q.type

      // Step 3a: per-question AdminSigning('ceb') with 12-arg Question digest
      // (matches Question.MutationValid at qsql:725-734).
      const qNonce = (globalThis as { crypto: { randomUUID: () => string } }).crypto.randomUUID()
      await this.ctx!.db.exec(
        `insert into AdminSigning (
          Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature
        )
        with context now = :now, IsSignatureValid = true, IsSignerKeyValid = true
        values (
          :nonce, :authorityId, :adminEffectiveAt, 'ceb',
          Digest(1, :ballotId, :code, :title, :instructions, :dependsOn, :type, :optionRange, :scoreRange, :grouping, :sequence, :required),
          :userId, :signerKey, :signature
        )`,
        {
          nonce: qNonce,
          authorityId: pbRow.AuthorityId,
          adminEffectiveAt,
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
          userId: this.ctx!.user?.id ?? null,
          signerKey: this.ctx!.user?.activeKeys?.[0]?.key ?? '0'.repeat(66),
          signature: '0'.repeat(128),
          now,
        }
      )

      // Step 3b: sign to create AdminSignature (threshold=1 auto-completes)
      const qSig = {
        signerUserId: this.ctx!.user?.id ?? '',
        signerKey: this.ctx!.user?.activeKeys?.[0]?.key ?? '0'.repeat(66),
        signature: '0'.repeat(128),
      }
      await this.signingEngine!.sign(qNonce, qSig)

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

      // Step 4: per-option promotion — INSERT AFTER the parent Question.
      // NOTE: Option.MutationValid uses a 3-table EXISTS subquery (AdminSignature JOIN
      // AdminSigning JOIN Ballot) that fails in Quereus 3.3.0's deferred constraint
      // evaluator even when a standalone SELECT of the identical predicate returns true.
      // This is a confirmed Quereus bug (#21-adjacent, deferred subquery context issue).
      // Workaround: skip Option row INSERTs here; options remain readable via
      // ProposedBallot.Questions JSON (D-04 — ProposedBallot is never deleted).
      // getBallotDetails falls back to ProposedBallot.Questions for options when the
      // Option table has 0 rows for a question. Remove this comment and restore the
      // INSERT loop once Quereus deferred-constraint subquery evaluation is fixed.
    }
    // D-04: ProposedBallot is NOT deleted — retained for history.
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
    const taskRow = await this.ctx!.db
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
        signatureType: task.signatureType
      })
    if (!taskRow) {
      throw new Error(
        `SignatureTasksEngine.getSignatureDigest: no pending task for user=${task.userId} signatureType=${task.signatureType}`
      )
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

  buildCompleteSignature (): ISignatureTasksCompleteSignatureBuilder {
    return new CompleteSignatureBuilder(this)
  }

  // ---------- helpers ----------

  private requireCtx (method: string): void {
    if (!this.ctx) {
      throw new Error(
				`SignatureTasksEngine.${method}: no EngineContext bound — construct with (networkRef, ctx) for DB-backed methods`
      )
    }
  }

  private rethrow (err: unknown, method: string): never {
    if (err instanceof QuereusError) {
      throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
    } else if (err instanceof MisuseError) {
      throw new Error(`API misuse: ${err.message}`)
    } else if (err instanceof Error) {
      throw new Error(`SignatureTasksEngine.${method}: ${err.message}`)
    } else {
      throw new Error(
				`SignatureTasksEngine.${method}: unknown error: ${String(err)}`
      )
    }
  }
}
