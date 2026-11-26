// `vt keyholder release`: publish this keyholder's share once the election's `releasingKeys` window is
// open (CONTEXT "Workflow coverage": release share), through the shared `releaseKeyholderShare`
// (@votetorrent/workflows/authority) over the release-key task the keys-tasks engine seeds at the
// head of `getKeysToRelease` (D-20 pull-and-seed; nothing here schedules). Port of
// the retired lean rig's keyholder driver 161-184 and main driver legRelease 1245-1295. Approval-class and
// idempotent: a repeat on an already-released task is still passed to the ceremony (the engine
// answers `already-released` with zero vault reads) and reports `alreadyReleased: true`.
//
// Order: args, lock, identity (an empty store refuses before the network), approval view, engines,
// the timeline (`no-release-time`; `window-not-open` when more than `waitMs` remains, with no vault
// access), the task (retried every 10 s for up to 60 s: `no-release-task`), the ceremony, then an
// optional wait for `awaitCount` accepted releases. The share, the task and the timeline are never
// returned.

import type { ReleaseKeyTask } from '@votetorrent/vote-core'
import { releasingKeysAt } from '@votetorrent/vote-engine/rn'
import { listKeyholderIdentities, releaseKeyholderShare } from '@votetorrent/workflows/authority'
import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import { KeyholderVerbError, parseKeyholderArgs, withKeyholderApproval } from './keyholder-args.js'
import {
  measureUnwraps,
  openKeyholderEngines,
  readElectionTimeline,
  resolveIdentityForElection,
  sleep,
  withKeyholderVerbLock
} from './keyholder-engines.js'

const SPEC = {
  network: { kind: 'network', required: true },
  election: { kind: 'election', required: true },
  tokenFile: { kind: 'abs-path' },
  waitMs: { kind: 'int', min: 0, max: 900_000 },
  awaitCount: { kind: 'int', min: 0, max: 16 }
} as const

export const RELEASE_TASK_RETRY_MS = 10_000
export const RELEASE_TASK_WAIT_MS = 60_000
export const RELEASE_AWAIT_POLL_MS = 2_000
export const RELEASE_AWAIT_MAX_MS = 180_000

const release: VerbHandler<VerbContext> = async (ctx, args) => {
  const t0 = Date.now()
  const a = parseKeyholderArgs('release', args, SPEC)
  const waitMs = a.waitMs ?? 0
  const awaitCount = a.awaitCount ?? 0
  const electionId = a.election!
  return withKeyholderVerbLock(ctx, 'release', () =>
    measureUnwraps(ctx.device.vault, async () => {
      if ((await listKeyholderIdentities(ctx.device.storage)).length === 0) throw new KeyholderVerbError('release', 'identity-not-found')
      return withKeyholderApproval('release', args, async (approval) => {
        const view = ctx.device.vault.withApproval(approval)
        const engines = await openKeyholderEngines(ctx, a.network!, view, 'release')
        const identity = await resolveIdentityForElection(ctx.device.storage, engines.invitations, electionId, 'release')
        if (identity === undefined) throw new KeyholderVerbError('release', 'identity-not-found')
        const releaseAt = releasingKeysAt(await readElectionTimeline(engines.est, electionId))
        if (releaseAt === null) throw new KeyholderVerbError('release', 'no-release-time')
        const remaining = releaseAt - Date.now()
        if (remaining > 0) {
          if (remaining > waitMs) throw new KeyholderVerbError('release', 'window-not-open')
          await sleep(remaining)
        }
        const keysTasks = engines.keysTasks()
        const mine = (tasks: ReleaseKeyTask[]): ReleaseKeyTask | undefined => tasks.find((t) => t.userId === identity.userId)
        let task: ReleaseKeyTask | undefined
        let alreadyReleased = false
        const taskDeadline = Date.now() + RELEASE_TASK_WAIT_MS
        for (;;) {
          task = mine(await keysTasks.getKeysToRelease(true))
          if (task !== undefined) break
          task = mine(await keysTasks.getKeysToRelease(false))
          if (task !== undefined) {
            alreadyReleased = true
            break
          }
          if (Date.now() + RELEASE_TASK_RETRY_MS > taskDeadline) throw new KeyholderVerbError('release', 'no-release-task')
          await sleep(RELEASE_TASK_RETRY_MS)
        }
        const outcome = await releaseKeyholderShare({ getEngine: engines.getEngine, vault: view, storage: ctx.device.storage }, task)
        if (outcome.kind === 'failed') throw new KeyholderVerbError('release', outcome.code)
        let releasedCount = 0
        let rejected = 0
        const awaitDeadline = Date.now() + RELEASE_AWAIT_MAX_MS
        for (;;) {
          const ks = await engines.keyRelease.getKeyReleaseStatus(electionId).catch(() => null)
          releasedCount = ks?.releasedCount ?? 0
          rejected = ks?.rejectedReleases.length ?? 0
          if (awaitCount === 0 || releasedCount >= awaitCount || Date.now() + RELEASE_AWAIT_POLL_MS > awaitDeadline) break
          await sleep(RELEASE_AWAIT_POLL_MS)
        }
        return { alreadyReleased, releasedCount, rejected }
      })
    }).then(({ value, unwraps }) => ({
      released: true,
      alreadyReleased: value.alreadyReleased,
      releaseUnwraps: unwraps,
      releasedCount: value.releasedCount,
      rejected: value.rejected,
      ms: Date.now() - t0
    }))
  )
}

export default release
