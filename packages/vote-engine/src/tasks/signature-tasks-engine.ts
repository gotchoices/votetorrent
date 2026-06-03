import { MisuseError, QuereusError } from '@quereus/quereus'
import { SigningEngine } from '../signing/signing-engine.js'
import type { EngineContext } from '../types.js'
import type {
  ISigningEngine,
  ISignatureTasksEngine,
  ISignatureTasksCompleteSignatureBuilder,
  NetworkReference,
  SignatureResult,
  SignatureTask
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
   * current user. The IEngine surface returns generic SignatureTask; we
   * fill in the minimum required fields (signatureType, userId, network).
   * Full task-extension materialisation (the proposal payload, the
   * authority, etc.) lives in Phase 6 / TEST-01.
   */
  async getRequestedSignatures (pending: boolean): Promise<SignatureTask[]> {
    if (!this.ctx) return []
    const userId = this.ctx.user?.id ?? null
    const out: SignatureTask[] = []
    try {
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
        out.push({
          type: 'signature',
          userId: row.UserId as string,
          network: this.networkRef,
          signatureType: row.SignatureType as SignatureTask['signatureType']
        })
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
    await this.signingEngine.sign(nonce, result.signature)

    // Mark the task complete.
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
