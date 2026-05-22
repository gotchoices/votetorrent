import { MisuseError, QuereusError } from '@quereus/quereus'
import type { EngineContext } from '../types.js'
import type {
  ElectionDetails,
  IKeysTasksEngine,
  NetworkReference,
  ReleaseKeyTask
} from '@votetorrent/vote-core'

// Phase 05 TASK-01/02 — monotonic Tid counter for KeysTasksEngine batches.
let nextTid = 1

/**
 * KeysTasksEngine — Phase 05 (TASK-01, TASK-02) implementation.
 *
 * The IKeysTasksEngine interface declares
 * `getKeysToRelease(pending: boolean)` and `completeKeyRelease(task)`.
 *
 * Schema kept as-written. `Task.TypeValid` checks `Type in (select Code
 * from TaskType)`. TaskType's union-all leads with 'release-key' so the
 * read path is incidentally safe under quereus#21. The update path that
 * completes a task trips quereus#23 transitively via the AdminSignature
 * pipeline its `MutationValid` CHECK depends on.
 */
export class KeysTasksEngine implements IKeysTasksEngine {
  constructor (
    private readonly networkRef: NetworkReference,
    private readonly ctx?: EngineContext
  ) {}

  /**
   * TASK-01 — query Task rows of `Type='release-key'` for the current
   * user, joined to ReleaseKeyTaskExtension for the (electionId,
   * electionRevision) detail. Returns an empty list when no ctx is
   * bound (matches the mock contract).
   *
   * The `pending` flag filters on `Task.IsCompleted = false` when true,
   * mirroring the IKeysTasksEngine narrative.
   */
  async getKeysToRelease (pending: boolean): Promise<ReleaseKeyTask[]> {
    if (!this.ctx) return []
    const userId = this.ctx.user?.id ?? null
    const out: ReleaseKeyTask[] = []
    try {
      for await (const row of this.ctx.db.eval(
				`select T.UserId, R.ElectionId, R.ElectionRevision
					from Task T join ReleaseKeyTaskExtension R on R.TaskId = T.Id
					where T.Type = 'release-key'
						and T.UserId = :userId
						and (T.IsCompleted = :includeAll or T.IsCompleted = 0)`,
        {
          userId,
          // false when filtering pending-only; true when caller wants all
          includeAll: pending ? 0 : 1
        }
      )) {
        out.push({
          type: 'release-key',
          userId: row.UserId as string,
          network: this.networkRef,
          // ElectionDetails materialisation is deferred to Phase 6 / TEST-01;
          // for now, return a minimal shape with just the election id so the
          // task is identifiable. UI consumers should treat this as a
          // lookup key and call ElectionEngine.getElectionDetails(id) for
          // the full record.
          election: {
            election: {
              id: row.ElectionId as string,
              authorityId: ''
            } as ElectionDetails['election'],
            current: {} as ElectionDetails['current']
          }
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getKeysToRelease')
    }
  }

  /**
   * TASK-02 — mark a release-key Task as completed.
   *
   * The schema's `Task.MutationValid check on insert, update` gates on
   * an AdminSignature row matching the task's digest. Today that pipeline
   * is blocked on quereus#23; this method matches the schema intent so
   * unskipping is mechanical once upstream lands.
   */
  async completeKeyRelease (task: ReleaseKeyTask): Promise<void> {
    this.requireCtx('completeKeyRelease')
    const tid = nextTid++
    try {
      await this.ctx!.db.exec(
				`update Task
					set IsCompleted = 1
				with context SigningNonce = :signingNonce, Tid = ${tid}
				where UserId = :userId
					and Type = 'release-key'
					and Id in (
						select TaskId from ReleaseKeyTaskExtension where ElectionId = :electionId
					)`,
        {
          userId: task.userId,
          electionId: task.election.election.id,
          // The signing nonce is sourced from the AdminSignature row that
          // gates the update. Today we forward null; Phase 6 / TEST-01
          // tightens the API to accept it explicitly.
          signingNonce: null
        }
      )
    } catch (err) {
      this.rethrow(err, 'completeKeyRelease')
    }
  }

  // ---------- helpers ----------

  private requireCtx (method: string): void {
    if (!this.ctx) {
      throw new Error(
				`KeysTasksEngine.${method}: no EngineContext bound — construct with (networkRef, ctx) for DB-backed methods`
      )
    }
  }

  private rethrow (err: unknown, method: string): never {
    if (err instanceof QuereusError) {
      throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
    } else if (err instanceof MisuseError) {
      throw new Error(`API misuse: ${err.message}`)
    } else if (err instanceof Error) {
      throw new Error(`KeysTasksEngine.${method}: ${err.message}`)
    } else {
      throw new Error(`KeysTasksEngine.${method}: unknown error: ${String(err)}`)
    }
  }
}
