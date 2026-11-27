// `vt voter join`: join a network from an invite code read out of an absolute 0600 file (never argv), over
// the shared `runVoterNetworkJoin` (67-19) with the REQUIRED cadre functions and the daemon's voter
// join-bootstrap store. The decoded fingerprint is checked against the expected file BEFORE the node is
// touched (the Join Network screen's preview). A fresh voter provisions its identity under the call's token;
// a voter with an identity needs no token. The verb never reads a node property itself: it hands the node
// object to the shared join and nothing else (the recording-node unit case pins this).
//
// Order: arguments, the party gate, the timeouts, the code file, the decode, the preview, the lock, the
// identity (and token, only when there is none), the shared join raced against the bound, the joined store.

import { isAbsolute } from 'node:path'
import { decodeNetworkJoinCode } from '@votetorrent/vote-engine/rn'
import { runVoterNetworkJoin } from '@votetorrent/workflows/voter'
import { CALL_APPROVAL_ARG_KEYS } from '../../approval/call-approval.js'
import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import { readPrivateFile } from '../../vault/private-file.js'
import {
  assertVoterTestParty,
  bindVoterVerb,
  elapsedMs,
  pickVoterArgs,
  readVoterIdentity,
  startedNow,
  VoterVerbRefusal,
  withVoterApproval,
  withVoterVerbLock,
  type VoterDeps,
  type VoterIdentity
} from './voter-deps.js'

export const JOIN_TIMEOUT_MIN_MS = 10_000
export const JOIN_TIMEOUT_MAX_MS = 900_000
/** The rig's bound. */
export const JOIN_TIMEOUT_DEFAULT_MS = 420_000
export const ADMISSION_TIMEOUT_MIN_MS = 1_000
export const ADMISSION_TIMEOUT_MAX_MS = 120_000
/** The join code file cap (a pasted v1 code is about 1.8 KB). */
export const CODE_FILE_MAX_BYTES = 16_384

const JOIN_ARGS: readonly string[] = ['codeFile', 'expectFingerprintFile', 'timeoutMs', 'admissionTimeoutMs', ...CALL_APPROVAL_ARG_KEYS]
const REASON_RE = /^[a-z0-9-]{1,40}$/

function parseBoundedInt(v: string | boolean | undefined, min: number, max: number, fallback: number): number {
  if (v === undefined) return fallback
  if (typeof v !== 'string' || !/^\d{1,7}$/.test(v)) throw new VoterVerbRefusal('bad-arg')
  const n = Number(v)
  if (n < min || n > max) throw new VoterVerbRefusal('bad-arg')
  return n
}

/** Reads a 0600, owner-owned, regular file by absolute path; the refusal names the kind, never the path. */
export function readCodeFile(path: string | boolean | undefined): string {
  if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path)) throw new VoterVerbRefusal('code-file-required')
  let data: Buffer | null
  try {
    data = readPrivateFile(path, { maxBytes: CODE_FILE_MAX_BYTES })
  } catch (e) {
    const err = e as { name?: unknown, code?: unknown } | null | undefined
    if (err?.name === 'PrivateFileError') {
      if (err.code === 'mode') throw new VoterVerbRefusal('code-file-mode', { cause: e })
      if (err.code === 'owner') throw new VoterVerbRefusal('code-file-owner', { cause: e })
      if (err.code === 'not-file') throw new VoterVerbRefusal('code-file-not-file', { cause: e })
      if (err.code === 'too-large') throw new VoterVerbRefusal('code-file-size', { cause: e })
    }
    throw e
  }
  if (data === null) throw new VoterVerbRefusal('code-file-missing')
  try {
    return data.toString('utf8').trim()
  } finally {
    data.fill(0)
  }
}

export async function runJoin(deps: VoterDeps, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t0 = startedNow()
  const a = pickVoterArgs(args, JOIN_ARGS)
  assertVoterTestParty(deps.partyId)
  const timeoutMs = parseBoundedInt(a.timeoutMs, JOIN_TIMEOUT_MIN_MS, JOIN_TIMEOUT_MAX_MS, JOIN_TIMEOUT_DEFAULT_MS)
  const admissionTimeoutMs = a.admissionTimeoutMs === undefined ? undefined : parseBoundedInt(a.admissionTimeoutMs, ADMISSION_TIMEOUT_MIN_MS, ADMISSION_TIMEOUT_MAX_MS, 0)
  const text = deps.secrets.add(readCodeFile(a.codeFile), { windows: true })
  const decoded = decodeNetworkJoinCode(text)
  if (!decoded.ok) throw new VoterVerbRefusal('code-malformed')
  deps.secrets.add(decoded.code.invitation, { windows: true })
  let fingerprintMatch = false
  if (a.expectFingerprintFile !== undefined) {
    const expected = deps.secrets.add(readCodeFile(a.expectFingerprintFile), { windows: true })
    if (expected !== decoded.fingerprint) throw new VoterVerbRefusal('preview-mismatch')
    fingerprintMatch = true
  }
  return withVoterVerbLock(deps.lockKey, 'join', async () => {
    let identity: VoterIdentity | null = await readVoterIdentity(deps)
    if (identity === null) {
      identity = await withVoterApproval(deps, args, async (approved) => approved.identity, { provisionIdentity: true })
    }
    const user = identity.user
    const steps: string[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    let result
    try {
      result = await Promise.race([
        runVoterNetworkJoin({
          node: deps.node,
          networksEngine: deps.networksEngine,
          user,
          code: decoded.code,
          cadre: deps.cadre,
          joinBootstrapStore: deps.joinBootstrapStore,
          onStep: (step) => {
            steps.push(String(step))
          },
          ...(admissionTimeoutMs === undefined ? {} : { admissionTimeoutMs })
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new VoterVerbRefusal('join-timeout')), timeoutMs)
        })
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (!result.ok) {
      const reason = String(result.reason)
      throw new VoterVerbRefusal(REASON_RE.test(reason) ? `join-${reason}` : 'join-failed')
    }
    // The app remembers the joined network after a successful join (VoterAppProvider); without it a
    // restarted daemon would derive the strand as a founder.
    await deps.rememberJoinedNetwork(result.networkRef.hash)
    return {
      joined: true,
      networkHash: result.networkRef.hash,
      outcome: result.outcome,
      admittedVia: result.admittedVia,
      fingerprintMatch,
      steps: steps.length,
      ms: elapsedMs(t0)
    }
  })
}

export const joinVerb: VerbHandler<VerbContext> = bindVoterVerb(runJoin)

export default joinVerb
