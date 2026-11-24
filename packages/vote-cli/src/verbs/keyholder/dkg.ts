// `vt keyholder dkg`: drive this keyholder's half of the DKG (CONTEXT "Workflow coverage": drive DKG)
// through the shared `driveKeyholderDkg` (@votetorrent/workflows/authority), which does ONE
// `advanceDkg` per call; the loop, its pauses and its bounds live here, the daemon's side. Port of
// tools/lean-rig/lean/host-kh.ts 145-158 and lean-part2.ts legDkg 884-927 (the 2026-11-13 rule: an
// action-less advancing drive must still pause, or the bound burns in a second). The identity is never
// an argument: it is resolved from the sealed store by the election its seat belongs to. Approval-
// class: the token comes only from this call; a token-less drive refuses `auth-denied` at the vault's
// first token-gated operation and posts no DKG message.
//
// A call when the phase is already complete returns at once with `advancing 0`, `actions 0` and
// `dkgUnwraps 0`: the driver's own gate prompts zero times when nothing is due (so a restart neither
// replays nor duplicates a round; the KeyholderDkgMessage primary key refuses a duplicate anyway).

import type { KeyholderDkgStatus } from '@votetorrent/vote-core'
import { driveKeyholderDkg, listKeyholderIdentities } from '@votetorrent/workflows/authority'
import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import { KeyholderVerbError, parseKeyholderArgs, withKeyholderApproval } from './keyholder-args.js'
import {
  countOwnDkgMessages,
  jointKeyTag,
  measureUnwraps,
  openKeyholderEngines,
  resolveIdentityForElection,
  sleep,
  withKeyholderVerbLock
} from './keyholder-engines.js'

const SPEC = {
  network: { kind: 'network', required: true },
  election: { kind: 'election', required: true },
  tokenFile: { kind: 'abs-path' },
  boundMs: { kind: 'int', min: 1_000, max: 3_600_000 },
  maxDrives: { kind: 'int', min: 1, max: 2_000 }
} as const

export const DKG_BOUND_DEFAULT_MS = 900_000
export const DKG_MAX_DRIVES_DEFAULT = 400
/** After a drive that posted an action or reported progress (even action-less): the peer's round must replicate. */
export const DKG_PAUSE_AFTER_PROGRESS_MS = 1_500
/** After a drive that did nothing, or a cohort-unreachable read. */
export const DKG_PAUSE_IDLE_MS = 4_000
/**
 * Consecutive drive errors other than `auth-denied` tolerated before the verb refuses with the code:
 * two daemons posting rounds to one strand at the same time can lose a commit (a code-less engine
 * error the driver reports as `unknown`), and the next drive re-reads and continues, as the lean rig's
 * host-kh loop does. `auth-denied` is never retried.
 */
export const DKG_MAX_CONSECUTIVE_ERRORS = 3

const dkg: VerbHandler<VerbContext> = async (ctx, args) => {
  const t0 = Date.now()
  const a = parseKeyholderArgs('dkg', args, SPEC)
  const boundMs = a.boundMs ?? DKG_BOUND_DEFAULT_MS
  const maxDrives = a.maxDrives ?? DKG_MAX_DRIVES_DEFAULT
  const electionId = a.election!
  return withKeyholderVerbLock(ctx, 'dkg', () =>
    measureUnwraps(ctx.device.vault, async () => {
      // An empty store refuses before the network is opened (no identity can match).
      if ((await listKeyholderIdentities(ctx.device.storage)).length === 0) throw new KeyholderVerbError('dkg', 'identity-not-found')
      return withKeyholderApproval('dkg', args, async (approval) => {
        const view = ctx.device.vault.withApproval(approval)
        const engines = await openKeyholderEngines(ctx, a.network!, view, 'dkg')
        const identity = await resolveIdentityForElection(ctx.device.storage, engines.invitations, electionId, 'dkg')
        if (identity === undefined) throw new KeyholderVerbError('dkg', 'identity-not-found')
        const deps = { getEngine: engines.getEngine, vault: view, storage: ctx.device.storage }
        let drives = 0
        let advancing = 0
        let actions = 0
        let status: KeyholderDkgStatus | null = null
        let electionKey: KeyholderDkgStatus['electionKey'] = null
        let consecutiveErrors = 0
        for (;;) {
          if (drives >= maxDrives || Date.now() - t0 >= boundMs) throw new KeyholderVerbError('dkg', 'dkg-timeout')
          drives++
          const out = await driveKeyholderDkg(deps, electionId, identity.userId)
          if (out.advanced) advancing++
          actions += out.actions.length
          if (out.status !== null) status = out.status
          if (out.error !== undefined) {
            if (out.error.code === 'auth-denied') throw new KeyholderVerbError('dkg', 'auth-denied')
            if (out.error.code !== 'peer-unavailable' && ++consecutiveErrors >= DKG_MAX_CONSECUTIVE_ERRORS) throw new KeyholderVerbError('dkg', out.error.code)
            await sleep(DKG_PAUSE_IDLE_MS)
            continue
          }
          consecutiveErrors = 0
          const phase = out.status?.phase
          if (phase === 'failed') throw new KeyholderVerbError('dkg', 'dkg-failed')
          if (phase === 'complete') {
            const ks = await engines.keyRelease.getKeyReleaseStatus(electionId).catch(() => null)
            electionKey = ks?.electionKey ?? out.status?.electionKey ?? null
            if (electionKey !== null) break
          }
          await sleep(out.actions.length > 0 || out.advanced ? DKG_PAUSE_AFTER_PROGRESS_MS : DKG_PAUSE_IDLE_MS)
        }
        const ownMessages = await countOwnDkgMessages(engines.est, electionId, identity.userId)
        return {
          phase: status?.phase ?? null,
          attempt: status?.currentAttempt ?? null,
          drives,
          advancing,
          actions,
          hasShare: status?.self?.hasShare === true,
          threshold: electionKey?.threshold ?? status?.threshold ?? null,
          participants: electionKey?.participants ?? null,
          jointKeyTag: electionKey === null ? null : jointKeyTag(electionKey.jointPublicKey),
          ownMessages
        }
      })
    }).then(({ value, unwraps }) => ({ ...value, dkgUnwraps: unwraps, ms: Date.now() - t0 }))
  )
}

export default dkg
