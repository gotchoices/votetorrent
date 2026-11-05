// invite-keys.ts - real one-time invite keys and invitee contexts for specs and fixtures.
// A keyholder accept must carry the invite's real private key (gap7/WR-05) and run on a device that
// is not the inviting officer's (gap6/WR-09, D-21).
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import type { EngineContext } from '../../src/types.js'

const privateByPublic = new Map<string, string>()

export function mintInviteKeyPair (): { invitePrivate: string, inviteKey: string } {
  const sk = secp256k1.utils.randomSecretKey()
  const pair = { invitePrivate: bytesToHex(sk), inviteKey: bytesToHex(secp256k1.getPublicKey(sk)) }
  privateByPublic.set(pair.inviteKey, pair.invitePrivate)
  return pair
}

/**
 * A keyholder's own device context: same strand db, no officer identity. The keyholder who accepts is
 * never the inviting officer (gap6/WR-09, D-21); use this context for every 'k' accept.
 */
export function inviteeContext (ctx: EngineContext): EngineContext {
  return { db: ctx.db } as EngineContext
}

// Every minted pair is remembered by public key so a spec that created a slot with
// `mintInviteKeyPair().inviteKey` can recover the matching private key from the slot row alone.

/** The invite private key for a slot whose InviteKey came from mintInviteKeyPair(). */
export async function invitePrivateForSlot (ctx: EngineContext, slotCid: string): Promise<string> {
  const row = await ctx.db.prepare('select InviteKey from InviteSlot where Cid = :cid').get({ cid: slotCid })
  const pub = row?.InviteKey as string | undefined
  const priv = pub ? privateByPublic.get(pub) : undefined
  if (!priv) throw new Error(`invitePrivateForSlot: no minted invite key for slot ${slotCid}`)
  return priv
}
