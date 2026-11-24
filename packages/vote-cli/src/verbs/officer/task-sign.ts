// `vt officer task-sign`: find the ballot's signature task and sign (or reject) it through the shared
// `findBallotSignatureTask` / `signTask` / `rejectTask` (@votetorrent/workflows/authority, the
// Authority's SignatureTaskScreen body), then read the ballot's confirmation back. Replaces
// tools/lean-rig/lean/lean-part2.ts 802-815 and tools/vote-cli/src/workflows/authority.mjs 420-440.
// Approval-class unless `--reject`: a rejection never reads the token (SignatureTaskScreen D-12, kept
// in the shared rejectTask, which has no signer parameter), so `--reject` with any token key is
// `bad-arg`.
//
// `completeSignature` is the approval the profile measured at ~190 sequential relay reads, so the two
// engine calls the shared signTask makes are timed separately (`digestMs`, `completeMs`) through a
// forwarding object; the verb never calls them itself.

import { setTimeout as sleep } from 'node:timers/promises'
import type { SignatureTask } from '@votetorrent/vote-core'
import { findBallotSignatureTask, readBallotConfirmation, rejectTask, signTask } from '@votetorrent/workflows/authority'
import { CALL_APPROVAL_ARG_KEYS, hasCallApproval, withCallApproval } from '../../approval/call-approval.js'
import type { ApprovalContext } from '../../approval/token.js'
import type { OfficerVerbContext } from '../../network/network-verb-support.js'
import {
  assertTestParty,
  elapsedMs,
  officerElectionDeps,
  officerSignerFactory,
  pickArgs,
  refuse,
  serializeOfficerWrite,
  startedNow,
  type OfficerElectionDeps,
  type TasksEngineSlice
} from './election-deps.js'

const ALLOWED = ['network', 'election', 'ballot', 'waitMs', 'reject', ...CALL_APPROVAL_ARG_KEYS]
const BALLOT_ID_RE = /^[A-Za-z0-9._-]{1,80}$/
const WAIT_RE = /^\d{1,6}$/
const MAX_WAIT_MS = 600000
const POLL_MS = 1000

interface Timed {
  engine: Pick<TasksEngineSlice, 'getSignatureDigest' | 'completeSignature'>
  digestMs: number | null
  completeMs: number | null
}

/** Forwards the two engine calls the shared signTask/rejectTask make and records their durations. */
function timedTasksEngine(tasks: TasksEngineSlice): Timed {
  const timed: Timed = { digestMs: null, completeMs: null, engine: undefined as unknown as Timed['engine'] }
  timed.engine = {
    async getSignatureDigest(t) {
      const s = startedNow()
      try {
        return await tasks.getSignatureDigest(t)
      } finally {
        timed.digestMs = elapsedMs(s)
      }
    },
    async completeSignature(t, result) {
      const s = startedNow()
      try {
        return await tasks.completeSignature(t, result)
      } finally {
        timed.completeMs = elapsedMs(s)
      }
    }
  }
  return timed
}

async function awaitBallotTask(tasks: TasksEngineSlice, ballotId: string, waitMs: number): Promise<{ task: SignatureTask, waited: number }> {
  const started = Date.now()
  for (;;) {
    const task = findBallotSignatureTask(await tasks.getRequestedSignatures(true), ballotId)
    const waited = Date.now() - started
    if (task !== undefined) return { task, waited }
    if (waited >= waitMs) refuse('no-task')
    await sleep(Math.min(POLL_MS, waitMs - waited))
  }
}

export async function runTaskSign(deps: OfficerElectionDeps, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t0 = startedNow()
  const a = pickArgs(args, ALLOWED)
  assertTestParty(deps.partyId)
  if (a.network === undefined) refuse('network-required')
  if (a.election === undefined) refuse('election-required')
  const ballot = a.ballot
  if (typeof ballot !== 'string' || !BALLOT_ID_RE.test(ballot)) refuse('ballot-required')
  const waitText = a.waitMs === undefined ? '0' : a.waitMs
  if (typeof waitText !== 'string' || !WAIT_RE.test(waitText) || Number(waitText) > MAX_WAIT_MS) refuse('wait-invalid')
  const waitMs = Number(waitText)
  if (a.reject !== undefined && a.reject !== true) refuse('bad-arg')
  const reject = a.reject === true
  if (reject && hasCallApproval(args)) refuse('bad-arg')
  const electionId = a.election

  const body = async (approval: ApprovalContext | undefined): Promise<Record<string, unknown>> => {
    const network = await deps.openNetwork(a.network)
    const electionEngine = await network.openElection(electionId)
    const { task, waited } = await awaitBallotTask(network.tasksEngine, ballot, waitMs)
    const timed = timedTasksEngine(network.tasksEngine)
    if (approval === undefined) {
      await rejectTask({ tasksEngine: timed.engine, task })
      const view = await readBallotConfirmation({ electionEngine, ballotId: ballot })
      return { electionId, ballotId: ballot, accepted: false, confirmed: view.confirmed, signatures: 0, waitMs: waited, digestMs: timed.digestMs, completeMs: timed.completeMs, ms: elapsedMs(t0) }
    }
    const signer = officerSignerFactory(deps, approval)
    await signer.preflight()
    await signTask({ tasksEngine: timed.engine, task, createSigner: () => signer.createSigner() })
    const view = await readBallotConfirmation({ electionEngine, ballotId: ballot })
    if (view.confirmed !== true) refuse('ballot-not-confirmed')
    return {
      electionId,
      ballotId: ballot,
      accepted: true,
      confirmed: true,
      signatures: signer.signatures(),
      waitMs: waited,
      digestMs: timed.digestMs,
      completeMs: timed.completeMs,
      ms: elapsedMs(t0)
    }
  }

  if (reject) return serializeOfficerWrite(deps.writeKey, () => body(undefined))
  return withCallApproval(args, (approval) => serializeOfficerWrite(deps.writeKey, () => body(approval)))
}

export default async function taskSign(ctx: OfficerVerbContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return runTaskSign(officerElectionDeps(ctx), args)
}
