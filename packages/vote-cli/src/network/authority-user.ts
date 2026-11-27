// The officer/keyholder device user of a vt daemon: a secp256k1 signing key provisioned ONCE in the
// 67-13 device vault under the approval token (67-20 `provisionTokenSigningKey`), and the public User
// record (id, name, one key) stored through the daemon's own `saveUser` at `node/user.json` (0600),
// which is the record the daemon's `ctx.user` and `ctx.openNetwork` read. Every later presence-class
// call proves the token against the held key (`assertTokenSigningKeyHeld`); a wrong, missing or
// loose token refuses `token-refused` with no write. The private key never leaves the vault: signing
// goes through `createAuthoritySigner`, the 67-20 token signer.

import { randomUUID } from 'node:crypto'
import type { User } from '@votetorrent/vote-core'
import type { SignCallback } from '@votetorrent/workflows/platform'
import { assertTokenSigningKeyHeld, createTokenSigner, provisionTokenSigningKey, readTokenSigningPublicKey } from '../approval/signer.js'
import type { ApprovalContext } from '../approval/token.js'
import { PEER_FILES } from '../node/peer-layout.js'
import { buildAuthorityUser, isAuthorityUserShape } from './network-init.js'
import { NetworkVerbError, type OfficerVerbContext } from './network-verb-support.js'

/** The vault alias of the officer/keyholder signing key (secp256k1; its public half is `<alias>.pub`). */
export const AUTHORITY_SIGNING_ALIAS = 'vt.authority.signing'

/** The public user record, relative to the peer dir: the daemon's own `node/user.json` (67-23 `PEER_FILES.user`). */
export const AUTHORITY_USER_FILE = `${PEER_FILES.node}/${PEER_FILES.user}`

const CURVE = 'secp256k1' as const

type UserCtx = Pick<OfficerVerbContext, 'user' | 'saveUser' | 'device'>

/**
 * The stored user, validated with the `buildAuthorityUser` rules (`identity-corrupt` otherwise), or
 * null before provisioning. Never reads the token and never touches the vault.
 */
export async function loadAuthorityUser(ctx: Pick<OfficerVerbContext, 'user'>): Promise<User | null> {
  const user = ctx.user
  if (user === null || user === undefined) return null
  if (!isAuthorityUserShape(user)) throw new NetworkVerbError('identity-corrupt')
  return user
}

/**
 * Provision on first use, prove the token on every later call.
 *  - With a user record: the vault's public key must equal the record's key (`identity-mismatch`),
 *    then the token is proven against the held private key. Returns the record.
 *  - Without one: a key already in the vault is proven and reused, otherwise one is provisioned under
 *    the token (the FIRST auth-required put binds the device's `token.check` to that token). The public
 *    record is then written through `ctx.saveUser` (atomic, 0600): public fields only.
 * A `TokenSignerError` (`token-refused`, ...) propagates unchanged and nothing is written.
 */
export async function ensureAuthorityUser(ctx: UserCtx, approval: ApprovalContext, opts: { name: string }): Promise<User> {
  const vault = ctx.device.vault
  const existing = await loadAuthorityUser(ctx)
  const held = await readTokenSigningPublicKey({ vault, alias: AUTHORITY_SIGNING_ALIAS })
  if (existing !== null) {
    const key = existing.activeKeys[0]!.key
    if (held === null || held !== key) throw new NetworkVerbError('identity-mismatch')
    await assertTokenSigningKeyHeld({ vault, token: approval, curve: CURVE, alias: AUTHORITY_SIGNING_ALIAS, signerKey: key })
    return existing
  }
  let publicKey: string
  if (held !== null) {
    await assertTokenSigningKeyHeld({ vault, token: approval, curve: CURVE, alias: AUTHORITY_SIGNING_ALIAS, signerKey: held })
    publicKey = held
  } else {
    publicKey = (await provisionTokenSigningKey({ vault, token: approval, curve: CURVE, alias: AUTHORITY_SIGNING_ALIAS })).publicKey
  }
  const user = buildAuthorityUser({ id: randomUUID(), name: opts.name, publicKeyHex: publicKey, nowMs: Date.now() })
  await ctx.saveUser(user)
  return user
}

/** The 67-20 token signer over the officer key: every signature unwraps under `approval` and attributes to `user`. */
export function createAuthoritySigner(ctx: Pick<OfficerVerbContext, 'device'>, approval: ApprovalContext, user: User): SignCallback {
  return createTokenSigner({
    vault: ctx.device.vault,
    token: approval,
    curve: CURVE,
    alias: AUTHORITY_SIGNING_ALIAS,
    signerUserId: user.id,
    signerKey: user.activeKeys[0]!.key
  })
}
