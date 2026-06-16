import { MisuseError, QuereusError } from '@quereus/quereus'
import { SigningEngine } from '../signing/signing-engine.js'
import { digestToBytes, fromCanonicalDatetime, parseJsonOr } from '../utils.js'
import type { EngineContext } from '../types.js'
import type {
  ISigningEngine,
  ISignatureTasksEngine,
  ISignatureTasksCompleteSignatureBuilder,
  NetworkReference,
  SignatureResult,
  SignatureTask,
  AdminSignatureTask,
  Authority,
  ThresholdPolicy,
  AdminInit,
  Proposal,
} from '@votetorrent/vote-core'
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
