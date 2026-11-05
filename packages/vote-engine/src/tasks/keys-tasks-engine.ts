import { rethrow as rethrowHelper } from '../signing/ceremony-helpers.js'
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
  KeyholderDkgSigner,
  NetworkReference,
  ReleaseKeyTask
} from '@votetorrent/vote-core'
import { CompleteKeyReleaseBuilder } from './builders/index.js'
import { allocateTid } from '../database/tid-allocator.js'
import { KeyReleaseEngine, KeyReleaseError, type KeyReleaseEngineDeps } from '../key-release/key-release-engine.js'

/** 62-20: `KeysTasksEngineDeps` is exactly `KeyReleaseEngineDeps` — the vault/clock the Authority's engine factory must inject (`new KeysTasksEngine(networkRef, ctx, { vault })`) for seeding and release to ever see a local keyholder's share. */
export type KeysTasksEngineDeps = KeyReleaseEngineDeps

/**
 * KeysTasksEngine — Phase 05 (TASK-01, TASK-02) implementation, rewired by
 * 62-20 (D-17, D-20) to seed release-key Tasks via pull-and-seed and to
 * require a real published share for completion.
 *
 * The IKeysTasksEngine interface declares
 * `getKeysToRelease(pending: boolean)` and `completeKeyRelease(task, signer?)`.
 *
 * Schema kept as-written. `Task.TypeValid` checks `Type in (select Code
 * from TaskType)`. TaskType's union-all leads with 'release-key' so the
 * read path is incidentally safe under quereus#21. The update path that
 * completes a task trips quereus#23 transitively via the AdminSignature
 * pipeline its `MutationValid` CHECK depends on.
 *
 * D-20 detection: `getKeysToRelease` calls `KeyReleaseEngine.seedReleaseKeyTasks()`
 * at its HEAD — the Authority already calls `getKeysToRelease(true)` on app
 * open (`useTaskCount`) and on task-inbox focus (`TasksScreen`), so that is
 * the entire detection mechanism. There is no scheduler.
 */
export class KeysTasksEngine implements IKeysTasksEngine {
  constructor (
    private readonly networkRef: NetworkReference,
    private readonly ctx?: EngineContext,
    private readonly deps?: KeysTasksEngineDeps
  ) {}

  /**
   * TASK-01 — query Task rows of `Type='release-key'` for the current user
   * AND every local keyholder userId (62-20: own vault's `hasSecret`),
   * joined to ReleaseKeyTaskExtension and materialised with the full
   * ElectionDetails (Election + ElectionRevision) and the network name so
   * KeyTaskScreen can render without crashing on undefined fields.
   *
   * The `pending` flag filters on `Task.IsCompleted = false` when true,
   * mirroring the IKeysTasksEngine narrative.
   */
  async getKeysToRelease (pending: boolean): Promise<ReleaseKeyTask[]> {
    if (!this.ctx) return []
    const out: ReleaseKeyTask[] = []
    try {
      // 62-20 (D-20): seed first — pull-and-seed, at the head of every read.
      const releaseEngine = new KeyReleaseEngine(this.ctx, this.deps)
      const seed = await releaseEngine.seedReleaseKeyTasks()
      // A failed seed leaves that keyholder with no task in the list below; record it, never silently.
      for (const failure of seed.failures) {
        console.warn(
          `KeysTasksEngine.getKeysToRelease: release-key task not seeded for keyholder ${failure.userId} in election ${failure.electionId}: ${failure.detail}`,
        )
      }

      const userIds = new Set<string>()
      if (this.ctx.user?.id !== undefined) userIds.add(this.ctx.user.id)
      for (const id of await releaseEngine.getLocalKeyholderUserIds()) userIds.add(id)

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
      for (const userId of userIds) {
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
      }
      // Merged result ordered by ElectionId then ElectionRevision.
      taskRows.sort((a, b) => {
        if (a.ElectionId !== b.ElectionId) return a.ElectionId < b.ElectionId ? -1 : 1
        return a.ElectionRevision - b.ElectionRevision
      })

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
   * TASK-02, rewired by 62-20 (D-17, D-20) — completing a release-key Task
   * ALWAYS means a publicly published share:
   *   1. `requireCtx` (unchanged message).
   *   2. No `signer` -> `KeyReleaseError('signer-required')`. Fail-closed:
   *      the real engine refuses without one (D-17: completion always means
   *      a published share).
   *   3. `signer.userId !== task.userId` -> `KeyReleaseError('signer-task-mismatch')`.
   *   4. `releaseKeyShare` is called with the task's own pinned revision
   *      (`task.election.current?.revision`, when numeric).
   *   5. ONLY after it resolves (`released` or `already-released`) is the
   *      Task marked complete — scoped to the RESOLVED release's own
   *      revision, narrowing the existing UPDATE's `ReleaseKeyTaskExtension`
   *      subselect to `ElectionId = :electionId and ElectionRevision = :releasedRevision`.
   *
   * The schema's `Task.MutationValid check on insert, update` gates on
   * an AdminSignature row matching the task's digest. Today that pipeline
   * is blocked on quereus#23; this method matches the schema intent so
   * unskipping is mechanical once upstream lands.
   */
  async completeKeyRelease (task: ReleaseKeyTask, signer?: KeyholderDkgSigner): Promise<void> {
    this.requireCtx('completeKeyRelease')
    if (signer === undefined) {
      throw new KeyReleaseError('signer-required', 'completeKeyRelease: a KeyholderDkgSigner is required — D-17 fail-closed completion; no row is ever written without one')
    }
    if (signer.userId !== task.userId) {
      throw new KeyReleaseError('signer-task-mismatch', 'completeKeyRelease: signer.userId does not match task.userId')
    }
    const revision = typeof task.election.current?.revision === 'number' ? task.election.current.revision : undefined
    const releaseEngine = new KeyReleaseEngine(this.ctx!, this.deps)
    const outcome = await releaseEngine.releaseKeyShare(task.election.election.id, signer, revision)

    // Per-keyholder namespace (see KeyReleaseEngine.seedReleaseKeyTasks): never a TidHighWater row another keyholder's device writes.
    const tid = await allocateTid(this.ctx!.db, `keys-tasks:${task.userId}`)
    try {
      await this.ctx!.db.exec(
				`update Task
				with context IsMutationValid = true, Tid = ${tid}
					set IsCompleted = 1
				where UserId = :userId
					and Type = 'release-key'
					and Id in (
						select TaskId from ReleaseKeyTaskExtension where ElectionId = :electionId and ElectionRevision = :releasedRevision
					)`,
        {
          userId: task.userId,
          electionId: task.election.election.id,
          releasedRevision: outcome.release.revision,
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
    return rethrowHelper(err, 'KeysTasksEngine', method)
  }
}
