import { MisuseError, QuereusError } from '@quereus/quereus'
import type { EngineContext } from '../types.js'
import type { IOnboardingTasksEngine } from '@votetorrent/vote-core'

// Phase 05 TASK-05/06 — monotonic Tid counter for OnboardingTasksEngine.
let nextTid = 1

/**
 * OnboardingTasksEngine — Phase 05 (TASK-05, TASK-06) implementation.
 *
 * The IOnboardingTasksEngine interface declares
 * `getCompletedOnboardingTasks(): Promise<string[]>` and
 * `setOnboardingTaskCompleted(taskId: string): Promise<void>`.
 *
 * Schema kept as-written. The query joins Task with
 * OnboardingTaskExtension; the update path trips quereus#23 transitively
 * through Task.MutationValid's AdminSignature dependency.
 */
export class OnboardingTasksEngine implements IOnboardingTasksEngine {
  constructor (private readonly ctx?: EngineContext) {}

  /**
   * TASK-05 — return the IDs of completed onboarding tasks for the
   * current user. The IEngine surface returns only the completed IDs;
   * pending tasks are derived by the caller from the Onboarding table
   * minus this set.
   */
  async getCompletedOnboardingTasks (): Promise<string[]> {
    if (!this.ctx) return []
    const userId = this.ctx.user?.id ?? null
    const out: string[] = []
    try {
      for await (const row of this.ctx.db.eval(
				`select T.Id
					from Task T join OnboardingTaskExtension O on O.TaskId = T.Id
					where T.Type = 'onboarding'
						and T.UserId = :userId
						and T.IsCompleted = 1`,
        { userId }
      )) {
        out.push(row.Id as string)
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getCompletedOnboardingTasks')
    }
  }

  /**
   * TASK-06 — mark an onboarding Task complete.
   */
  async setOnboardingTaskCompleted (taskId: string): Promise<void> {
    this.requireCtx('setOnboardingTaskCompleted')
    const tid = nextTid++
    try {
      await this.ctx!.db.exec(
				`update Task
					set IsCompleted = 1
				with context SigningNonce = :signingNonce, Tid = ${tid}
				where Id = :id and Type = 'onboarding'`,
        {
          id: taskId,
          signingNonce: null
        }
      )
    } catch (err) {
      this.rethrow(err, 'setOnboardingTaskCompleted')
    }
  }

  // ---------- helpers ----------

  private requireCtx (method: string): void {
    if (!this.ctx) {
      throw new Error(
				`OnboardingTasksEngine.${method}: no EngineContext bound — construct with (ctx) for DB-backed methods`
      )
    }
  }

  private rethrow (err: unknown, method: string): never {
    if (err instanceof QuereusError) {
      throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
    } else if (err instanceof MisuseError) {
      throw new Error(`API misuse: ${err.message}`)
    } else if (err instanceof Error) {
      throw new Error(`OnboardingTasksEngine.${method}: ${err.message}`)
    } else {
      throw new Error(
				`OnboardingTasksEngine.${method}: unknown error: ${String(err)}`
      )
    }
  }
}
