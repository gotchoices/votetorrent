// `vt keyholder accept`: accept a keyholder SEAT invitation whose share text sits in a 0600 file
// (CONTEXT "Workflow coverage": accept invitation (seat share)), through the shared
// `acceptKeyholderInvitation` (@votetorrent/workflows/authority) with the daemon's file vault view
// and its sealed identity store. Port of tools/lean-rig/lean/host-kh.ts 121-142 (the seat file wait,
// the accept retry on a not-yet-replicated slot) and lean-part2.ts legAccept 847-880 (the
// `acceptUnwraps` delta), with the share text and its private key registered in the daemon's
// redactor BEFORE the driver sees them. Approval-class: the token comes only from this call.
//
// Order: args, lock, the share file, the registry, approval view, engines, the driver (retried on
// `not-found` / `lookup-timeout` while `waitMs` allows; those cost zero unwraps because they happen
// before provisioning), the election id from the slot. Reply: ids cut to 8 characters, counts, ms.

import { acceptKeyholderInvitation, parseInviteShare } from '@votetorrent/workflows/authority'
import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import { KeyholderVerbError, keyholderErrorCode, parseKeyholderArgs, readSeatShareFile, withKeyholderApproval } from './keyholder-args.js'
import { measureUnwraps, openKeyholderEngines, sleep, withKeyholderVerbLock } from './keyholder-engines.js'

const SPEC = {
  network: { kind: 'network', required: true },
  shareFile: { kind: 'abs-path', required: true },
  tokenFile: { kind: 'abs-path' },
  waitMs: { kind: 'int', min: 0, max: 600_000 }
} as const

export const ACCEPT_WAIT_DEFAULT_MS = 180_000
export const ACCEPT_RETRY_MS = 5_000
export const ACCEPT_READ_TIMEOUT_MS = 30_000
const RETRY_CODES: ReadonlySet<string> = new Set(['not-found', 'lookup-timeout'])

const accept: VerbHandler<VerbContext> = async (ctx, args) => {
  const t0 = Date.now()
  const a = parseKeyholderArgs('accept', args, SPEC)
  const waitMs = a.waitMs ?? ACCEPT_WAIT_DEFAULT_MS
  return withKeyholderVerbLock(ctx, 'accept', () =>
    measureUnwraps(ctx.device.vault, async () => {
      let text: string | undefined = ctx.secrets.add(readSeatShareFile('accept', a.shareFile!), { windows: true })
      const parsed = parseInviteShare(text)
      if (parsed !== undefined) ctx.secrets.add(parsed.invitePrivate, { windows: true })
      return withKeyholderApproval('accept', args, async (approval) => {
        const view = ctx.device.vault.withApproval(approval)
        const engines = await openKeyholderEngines(ctx, a.network!, view, 'accept')
        let attempts = 0
        let accepted: { userId: string, slotCid: string } | undefined
        while (accepted === undefined) {
          attempts++
          try {
            accepted = await acceptKeyholderInvitation(
              {
                invitationEngine: engines.invitations,
                vault: view,
                storage: ctx.device.storage,
                readKeyholderSeatFacts: (eid) => engines.readKeyholderSeatFacts(eid),
                readTimeoutMs: ACCEPT_READ_TIMEOUT_MS
              },
              text!
            )
          } catch (err) {
            const code = keyholderErrorCode(err)
            if (RETRY_CODES.has(code) && Date.now() - t0 + ACCEPT_RETRY_MS <= waitMs) {
              await sleep(ACCEPT_RETRY_MS)
              continue
            }
            throw new KeyholderVerbError('accept', code)
          }
        }
        text = undefined
        const seat = await engines.invitations.getKeyholderSlotSeat(accepted.slotCid)
        return {
          accepted: true,
          userId8: accepted.userId.slice(0, 8),
          election8: String(seat?.electionId ?? '').slice(0, 8),
          attempts,
          ms: Date.now() - t0
        }
      })
    }).then(({ value, unwraps }) => ({
      accepted: value.accepted,
      userId8: value.userId8,
      election8: value.election8,
      acceptUnwraps: unwraps,
      attempts: value.attempts,
      ms: value.ms
    }))
  )
}

export default accept
