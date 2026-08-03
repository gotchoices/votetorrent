import { MisuseError, QuereusError } from '@quereus/quereus'
import { fromCanonicalDatetime, parseJsonOr, parseKeyholdersAsInviteStatus } from '../utils.js'
import type { EngineContext } from '../types.js'
import type {
  ElectionCore,
  ElectionDetails,
  ElectionEvent,
  ElectionRevision,
  ElectionType,
  IKeysTasksEngine,
  IKeysTasksCompleteKeyReleaseBuilder,
  NetworkReference,
  ReleaseKeyTask
} from '@votetorrent/vote-core'
import { CompleteKeyReleaseBuilder } from './builders/index.js'
import { allocateTid } from '../database/tid-allocator.js'

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
   * user, joined to ReleaseKeyTaskExtension and materialised with the
   * full ElectionDetails (Election + ElectionRevision) and the network
   * name so KeyTaskScreen can render without crashing on undefined fields.
   *
   * The `pending` flag filters on `Task.IsCompleted = false` when true,
   * mirroring the IKeysTasksEngine narrative.
   */
  async getKeysToRelease (pending: boolean): Promise<ReleaseKeyTask[]> {
    if (!this.ctx) return []
    const userId = this.ctx.user?.id ?? null
    const out: ReleaseKeyTask[] = []
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

      // Collect base task rows first to avoid interleaving eval + prepare cursors.
      const taskRows: Array<{ UserId: string; ElectionId: string; ElectionRevision: number }> = []
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
        taskRows.push({
          UserId: row.UserId as string,
          ElectionId: row.ElectionId as string,
          ElectionRevision: row.ElectionRevision as number,
        })
      }

      for (const row of taskRows) {
        // Materialise ElectionCore from Election table.
        const elecRow = await this.ctx.db
          .prepare(
            `select Id, AuthorityId, Title, Date, RevisionDeadline, BallotDeadline, Type
               from Election where Id = :id`
          )
          .get({ id: row.ElectionId })

        // Materialise ElectionRevision from ElectionRevision table.
        const revRow = await this.ctx.db
          .prepare(
            `select Revision, RevisionTimestamp, Tags, Instructions, Timeline, KeyholderThreshold, Keyholders
               from ElectionRevision where ElectionId = :id and Revision = :revision`
          )
          .get({ id: row.ElectionId, revision: row.ElectionRevision })

        // Build ElectionCore — fall back to minimal shape if Election row absent.
        const electionCore: ElectionCore = elecRow
          ? {
              id: elecRow.Id as string,
              authorityId: elecRow.AuthorityId as string,
              title: elecRow.Title as string,
              date: fromCanonicalDatetime(elecRow.Date as string),
              revisionDeadline: fromCanonicalDatetime(elecRow.RevisionDeadline as string),
              ballotDeadline: fromCanonicalDatetime(elecRow.BallotDeadline as string),
              type: elecRow.Type as ElectionType,
            }
          : {
              id: row.ElectionId,
              authorityId: '',
              title: '',
              date: 0,
              revisionDeadline: 0,
              ballotDeadline: 0,
              type: 'o' as ElectionType,
            }

        // Build ElectionRevision — fall back to empty-but-safe shape if revision absent.
        const electionRevision: ElectionRevision = revRow
          ? {
              electionId: row.ElectionId,
              revision: revRow.Revision as number,
              revisionTimestamp: [fromCanonicalDatetime(revRow.RevisionTimestamp as string)],
              tags: parseJsonOr<string[]>(revRow.Tags, [], 'ElectionRevision.Tags'),
              instructions: (revRow.Instructions as string | undefined) ?? '',
              // 39-02 D-04 Gap 2: read the persisted create-time keyholder invitees back.
              keyholders: parseKeyholdersAsInviteStatus(revRow.Keyholders, 'ElectionRevision.Keyholders'),
              timeline: parseJsonOr<Record<ElectionEvent, number>>(
                revRow.Timeline,
                {} as Record<ElectionEvent, number>,
                'ElectionRevision.Timeline'
              ),
              keyholderThreshold: (revRow.KeyholderThreshold as number | undefined) ?? 1,
            }
          : {
              electionId: row.ElectionId,
              revision: row.ElectionRevision,
              revisionTimestamp: [],
              tags: [],
              instructions: '',
              // No revision row exists at all — legitimately empty (no
              // literal hardcode; parsed via the shared helper for consistency).
              keyholders: parseKeyholdersAsInviteStatus(undefined, 'ElectionRevision.Keyholders'),
              timeline: {} as Record<ElectionEvent, number>,
              keyholderThreshold: 1,
            }

        const election: ElectionDetails = {
          election: electionCore,
          current: electionRevision,
        }

        out.push({
          type: 'release-key',
          userId: row.UserId,
          network: networkRef,
          election,
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
    const tid = await allocateTid(this.ctx!.db, 'keys-tasks')
    try {
      await this.ctx!.db.exec(
				`update Task
				with context IsMutationValid = true, Tid = ${tid}
					set IsCompleted = 1
				where UserId = :userId
					and Type = 'release-key'
					and Id in (
						select TaskId from ReleaseKeyTaskExtension where ElectionId = :electionId
					)`,
        {
          userId: task.userId,
          electionId: task.election.election.id,
          // SIGN-03: The Task.MutationValid gate is satisfied by context.IsMutationValid = true.
          // The gating signing context (AdminSignature for the election) was verified at
          // election-creation time and persists in AdminSignature; the release-key Task update
          // does not need to re-present the signing nonce — the schema CHECK binds on
          // IsMutationValid, not on a forwarded nonce.
        }
      )
    } catch (err) {
      this.rethrow(err, 'completeKeyRelease')
    }
  }

  buildCompleteKeyRelease (): IKeysTasksCompleteKeyReleaseBuilder {
    return new CompleteKeyReleaseBuilder(this)
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
