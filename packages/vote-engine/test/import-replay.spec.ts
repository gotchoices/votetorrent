/**
 * import-replay.spec.ts — 62-02 Task 1 (D-38).
 *
 * Proves `UserKey.ExpirationFuture`'s import-mode replay hook:
 *   constraint ExpirationFuture check (
 *     coalesce(context.IsImportReplay, 0) = 1 or (context.now is not null and Expiration > context.now)
 *   )
 *
 * Security properties under test (see `votetorrent.qsql`'s D-38 comment above the constraint for
 * the full argument):
 *   - The flag admits ONLY rows whose Expiration is already in the past (every key-USE CHECK
 *     already treats an expired key as dead) — it is never a bypass of anything else.
 *   - It touches ONLY this bound. `InsertValid` (the bootstrap/subsequent-key shape) and
 *     `SignatureValid` are NOT relaxed: a subsequent key whose SIGNER key has itself expired still
 *     fails closed on `InsertValid` (case 8 below) and a tampered/wrong-signer signature still
 *     fails `SignatureValid` (cases 6-7).
 *   - `coalesce(..., 0) = 1` means bound `0`, bound `null`, and omitted are ALL non-admitting —
 *     never a silent bypass (cases 3-4).
 *   - The `context.now is not null` conjunct closes a real NULL-bypass: a bare
 *     `Expiration > context.now` with `now` bound to JS `null` evaluates NULL, which CHECK
 *     semantics treat as SATISFIED — case 10 proves the shipped text closes this even with no
 *     replay flag at all.
 *   - Zero non-test producers set `IsImportReplay` today (62-16 adds the one sanctioned producer,
 *     `NetworksEngine.importFoundingBundle` — see the grep gate in this plan's acceptance
 *     criteria).
 */

import { expect } from 'chai'
import { QuereusError } from '@quereus/quereus'
import { randomTestKeyPair } from './fixtures/keys.js'
import { digestToBytes, nowCanonicalDatetime, toCanonicalDatetime } from '../src/utils.js'
import { allocateTid } from '../src/database/tid-allocator.js'
import { createTestNetwork, addTestAuthority, signTestDigest } from './fixtures/test-context.js'
import type { EngineContext } from '../src/types.js'
import type { User } from '@votetorrent/vote-core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Raw-insert a bare InviteSlot (Type 'r', no ElectionId) purely as an anchor so a fresh,
 * genuinely keyless User can be minted through User.InsertValid's invite-bound branch — the SAME
 * technique `InvitationEngine.respondToInvite` uses for a real accept, just without the invite
 * ceremony overhead this spec does not need. `SigningNonce` is a fresh UUID with NO matching
 * `AdminSigning` row, so `InviteSlotSigningValid`'s inner-join assertion is vacuously satisfied.
 */
async function createAnchorInviteSlot (ctx: EngineContext): Promise<{ cid: string, inviteSignature: string }> {
  const tid = await allocateTid(ctx.db, 'user')
  const expiration = new Date(Date.now() + 3_600_000).toISOString()
  const inviteKey = 'a'.repeat(66)
  const inviteSignature = ''
  const name = `import-replay-anchor-${crypto.randomUUID()}`
  const nonce = crypto.randomUUID()
  const type = 'r'
  await ctx.db.exec(
    `insert into InviteSlot (Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce, ElectionId)
     with context Tid = ${tid}, now = :now, IsSignatureValid = true, IsInsertValid = true
     values (cid(Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce, :type)), :type, :name, :expiration, :inviteKey, :inviteSignature, :nonce, null)`,
    { expiration, inviteKey, inviteSignature, name, nonce, type, now: nowCanonicalDatetime() }
  )
  const row = await ctx.db.prepare('select Cid from InviteSlot where Name = :name').get({ name })
  if (!row) throw new Error('createAnchorInviteSlot: slot not found after insert')
  return { cid: row.Cid as string, inviteSignature }
}

/** Mint a genuinely fresh, keyless User bound to the given anchor slot. */
async function createKeylessUser (ctx: EngineContext, anchor: { cid: string, inviteSignature: string }): Promise<string> {
  const tid = await allocateTid(ctx.db, 'user')
  const userId = crypto.randomUUID()
  await ctx.db.exec(
    `insert into User (Id, Name, ImageRef)
     with context SigningNonce = null, InviteSlotCid = :slotCid, InviteSignature = :inviteSig, Tid = ${tid}
     values (:userId, :userName, null)`,
    { slotCid: anchor.cid, inviteSig: anchor.inviteSignature, userId, userName: 'Import Replay Test User' }
  )
  return userId
}

interface BootstrapKeyOpts {
  expiration: string
  isImportReplay?: 1 | 0 | null | 'omit'
  now?: string | null | 'omit'
}

/** Insert the bootstrap (genuinely-first-key) UserKey row for `userId`, with full control over the D-38 context knobs. */
async function insertBootstrapKey (ctx: EngineContext, userId: string, pubKey: string, opts: BootstrapKeyOpts): Promise<void> {
  const tid = await allocateTid(ctx.db, 'user')
  const params: Record<string, unknown> = { userId, pubKey, expiration: opts.expiration }
  const contextParts = [`UserKey = null`, `Signature = null`, `Tid = ${tid}`, `IsSignatureValid = true`]

  if (opts.now !== 'omit') {
    contextParts.push('now = :now')
    params.now = opts.now === undefined ? nowCanonicalDatetime() : opts.now
  }
  if (opts.isImportReplay !== undefined && opts.isImportReplay !== 'omit') {
    contextParts.push('IsImportReplay = :isImportReplay')
    params.isImportReplay = opts.isImportReplay
  }

  await ctx.db.exec(
    `insert into UserKey (UserId, Type, PubKey, Expiration)
     with context ${contextParts.join(', ')}
     values (:userId, 'M', :pubKey, :expiration)`,
    params
  )
}

function expectThrowsNamingCheck (err: unknown, checkName: string): void {
  expect(err, `must throw, naming ${checkName}`).to.not.equal(undefined)
  expect(err).to.be.instanceOf(Error)
  const message = err instanceof QuereusError ? err.message : (err as Error).message
  expect(message, `error message must name the ${checkName} CHECK`).to.include(checkName)
}

async function readKeyExpiration (ctx: EngineContext, userId: string, pubKey: string): Promise<string | undefined> {
  const row = await ctx.db.prepare('select Expiration from UserKey where UserId = :userId and PubKey = :pubKey').get({ userId, pubKey })
  return row?.Expiration as string | undefined
}

// ---------------------------------------------------------------------------
// Cases 1-4, 9-10: bootstrap (genuinely-first-key) path
// ---------------------------------------------------------------------------

describe('import-replay.spec.ts (D-38) — bootstrap-key cases', () => {
  async function setup (): Promise<{ ctx: EngineContext, userId: string }> {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const anchor = await createAnchorInviteSlot(auth.ctx)
    const userId = await createKeylessUser(auth.ctx, anchor)
    return { ctx: auth.ctx, userId }
  }

  it('(1) an already-expired bootstrap key with IsImportReplay = 1 INSERTS', async () => {
    const { ctx, userId } = await setup()
    const { publicHex } = randomTestKeyPair()
    const pastExpiration = toCanonicalDatetime(Date.now() - 86_400_000)
    let caught: unknown
    try {
      await insertBootstrapKey(ctx, userId, publicHex, { expiration: pastExpiration, isImportReplay: 1 })
    } catch (err) {
      caught = err
    }
    expect(caught, 'a replayed, already-expired bootstrap key with the flag must insert').to.equal(undefined)
    expect(await readKeyExpiration(ctx, userId, publicHex)).to.equal(pastExpiration)
  })

  it('(2) the SAME row with the flag OMITTED throws, naming ExpirationFuture', async () => {
    const { ctx, userId } = await setup()
    const { publicHex } = randomTestKeyPair()
    const pastExpiration = toCanonicalDatetime(Date.now() - 86_400_000)
    let caught: unknown
    try {
      await insertBootstrapKey(ctx, userId, publicHex, { expiration: pastExpiration, isImportReplay: 'omit' })
    } catch (err) {
      caught = err
    }
    expectThrowsNamingCheck(caught, 'ExpirationFuture')
  })

  it('(3) the SAME row with IsImportReplay = 0 throws', async () => {
    const { ctx, userId } = await setup()
    const { publicHex } = randomTestKeyPair()
    const pastExpiration = toCanonicalDatetime(Date.now() - 86_400_000)
    let caught: unknown
    try {
      await insertBootstrapKey(ctx, userId, publicHex, { expiration: pastExpiration, isImportReplay: 0 })
    } catch (err) {
      caught = err
    }
    expectThrowsNamingCheck(caught, 'ExpirationFuture')
  })

  it('(4) the SAME row with IsImportReplay = null throws', async () => {
    const { ctx, userId } = await setup()
    const { publicHex } = randomTestKeyPair()
    const pastExpiration = toCanonicalDatetime(Date.now() - 86_400_000)
    let caught: unknown
    try {
      await insertBootstrapKey(ctx, userId, publicHex, { expiration: pastExpiration, isImportReplay: null })
    } catch (err) {
      caught = err
    }
    expectThrowsNamingCheck(caught, 'ExpirationFuture')
  })

  it('(9) a FUTURE-dated bootstrap key with the flag omitted still inserts — existing producers unaffected', async () => {
    const { ctx, userId } = await setup()
    const { publicHex } = randomTestKeyPair()
    const futureExpiration = toCanonicalDatetime(Date.now() + 365 * 86_400_000)
    let caught: unknown
    try {
      await insertBootstrapKey(ctx, userId, publicHex, { expiration: futureExpiration, isImportReplay: 'omit' })
    } catch (err) {
      caught = err
    }
    expect(caught, 'the pre-existing honest producer shape (no flag, future expiration) must be completely unaffected').to.equal(undefined)
    expect(await readKeyExpiration(ctx, userId, publicHex)).to.equal(futureExpiration)
  })

  it('(10) "now" context SUPPLIED but bound to JS null, with NO replay flag, throws — the tightened NULL-bypass closure', async () => {
    const { ctx, userId } = await setup()
    const { publicHex } = randomTestKeyPair()
    const pastExpiration = toCanonicalDatetime(Date.now() - 86_400_000)
    let caught: unknown
    try {
      await insertBootstrapKey(ctx, userId, publicHex, { expiration: pastExpiration, isImportReplay: 'omit', now: null })
    } catch (err) {
      caught = err
    }
    expectThrowsNamingCheck(caught, 'ExpirationFuture')
  })
})

// ---------------------------------------------------------------------------
// Cases 5-8: subsequent-key (signed) path
// ---------------------------------------------------------------------------

describe('import-replay.spec.ts (D-38) — subsequent-key (signed) cases', () => {
  async function setup (): Promise<{ ctx: EngineContext, user: User }> {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    return { ctx: auth.ctx, user: auth.user }
  }

  /** Compute the UserEngine.addKey digest convention: Digest(userId, newPubKey, keyType, expirationCanonical). */
  async function computeAddKeyDigest (ctx: EngineContext, userId: string, newPubKey: string, keyType: string, expiration: string): Promise<string> {
    const row = await ctx.db
      .prepare('select Digest(:userId, :newPubKey, :keyType, :expiration) as d')
      .get({ userId, newPubKey, keyType, expiration })
    if (!row || row.d == null) throw new Error('computeAddKeyDigest: Digest() returned null')
    return row.d as string
  }

  async function insertSubsequentKey (
    ctx: EngineContext,
    opts: {
      userId: string
      signerPubKey: string
      signature: string
      newPubKey: string
      expiration: string
      isImportReplay?: 1 | 0 | null
    }
  ): Promise<void> {
    const tid = await allocateTid(ctx.db, 'user')
    const contextParts = ['UserKey = :signerKey', 'Signature = :signature', `Tid = ${tid}`, 'now = :now', 'IsSignatureValid = true']
    const params: Record<string, unknown> = {
      userId: opts.userId,
      pubKey: opts.newPubKey,
      expiration: opts.expiration,
      signerKey: opts.signerPubKey,
      signature: opts.signature,
      now: nowCanonicalDatetime()
    }
    if (opts.isImportReplay !== undefined) {
      contextParts.push('IsImportReplay = :isImportReplay')
      params.isImportReplay = opts.isImportReplay
    }
    await ctx.db.exec(
      `insert into UserKey (UserId, Type, PubKey, Expiration)
       with context ${contextParts.join(', ')}
       values (:userId, 'M', :pubKey, :expiration)`,
      params
    )
  }

  it('(5) a second key, Expiration in the past, signed by the CURRENTLY VALID first key, with the flag, INSERTS', async () => {
    const { ctx, user } = await setup()
    const { publicHex: newPubKey } = randomTestKeyPair()
    const pastExpiration = toCanonicalDatetime(Date.now() - 86_400_000)
    const signerPubKey = user.activeKeys[0]!.key
    const digest = await computeAddKeyDigest(ctx, user.id, newPubKey, 'M', pastExpiration)
    const sig = signTestDigest(user, digest)

    let caught: unknown
    try {
      await insertSubsequentKey(ctx, { userId: user.id, signerPubKey, signature: sig.signature, newPubKey, expiration: pastExpiration, isImportReplay: 1 })
    } catch (err) {
      caught = err
    }
    expect(caught, 'a genuinely-replayed, already-expired, correctly-signed second key must insert').to.equal(undefined)
    expect(await readKeyExpiration(ctx, user.id, newPubKey)).to.equal(pastExpiration)
  })

  it('(6) the SAME row, but the signature covers a DIFFERENT digest, with the flag, throws SignatureValid', async () => {
    const { ctx, user } = await setup()
    const { publicHex: newPubKey } = randomTestKeyPair()
    const pastExpiration = toCanonicalDatetime(Date.now() - 86_400_000)
    const signerPubKey = user.activeKeys[0]!.key
    // Sign a digest for a DIFFERENT (wrong) expiration than the one actually inserted.
    const wrongExpiration = toCanonicalDatetime(Date.now() - 2 * 86_400_000)
    const wrongDigest = await computeAddKeyDigest(ctx, user.id, newPubKey, 'M', wrongExpiration)
    const sig = signTestDigest(user, wrongDigest)

    let caught: unknown
    try {
      await insertSubsequentKey(ctx, { userId: user.id, signerPubKey, signature: sig.signature, newPubKey, expiration: pastExpiration, isImportReplay: 1 })
    } catch (err) {
      caught = err
    }
    expectThrowsNamingCheck(caught, 'SignatureValid')
  })

  it('(7) the SAME row, but SignerKey is NOT one of the user\'s own keys, with the flag, throws InsertValid', async () => {
    const { ctx, user } = await setup()
    const { publicHex: newPubKey } = randomTestKeyPair()
    const { privateHex: impostorPriv, publicHex: impostorPub } = randomTestKeyPair()
    const pastExpiration = toCanonicalDatetime(Date.now() - 86_400_000)
    const digest = await computeAddKeyDigest(ctx, user.id, newPubKey, 'M', pastExpiration)
    // Sign for real with a key that is NOT registered as one of this user's UserKey rows.
    const { secp256k1 } = await import('@noble/curves/secp256k1.js')
    const { bytesToHex, hexToBytes } = await import('@noble/curves/utils.js')
    const sig = bytesToHex(secp256k1.sign(digestToBytes(digest), hexToBytes(impostorPriv)))

    let caught: unknown
    try {
      await insertSubsequentKey(ctx, { userId: user.id, signerPubKey: impostorPub, signature: sig, newPubKey, expiration: pastExpiration, isImportReplay: 1 })
    } catch (err) {
      caught = err
    }
    expectThrowsNamingCheck(caught, 'InsertValid')
  })

  it('(8) a second key signed by a key whose OWN Expiration is past (real wall clock), with the flag, throws InsertValid (fail-closed residual)', async function () {
    this.timeout(15_000)
    const { ctx, user } = await setup()

    // Mint a second, fresh user with a bootstrap key expiring in ~2s, wait for it to genuinely
    // expire (real wall clock), then try to use IT as the signer of a THIRD key for that same
    // user, with the D-38 flag on the NEW row. The flag must not resurrect the signer's own
    // liveness — InsertValid's subsequent-key branch requires `K.Expiration > context.now` on
    // the SIGNER, evaluated against the real current time, never waived.
    const anchor = await createAnchorInviteSlot(ctx)
    const expiringSoonUserId = await createKeylessUser(ctx, anchor)
    const { privateHex: firstPriv, publicHex: firstPub } = randomTestKeyPair()
    const soonExpiration = toCanonicalDatetime(Date.now() + 2_000)
    await insertBootstrapKey(ctx, expiringSoonUserId, firstPub, { expiration: soonExpiration })

    await new Promise((resolve) => setTimeout(resolve, 2_300))

    const { publicHex: newPubKey } = randomTestKeyPair()
    const pastExpiration = toCanonicalDatetime(Date.now() - 86_400_000)
    const digest = await computeAddKeyDigest(ctx, expiringSoonUserId, newPubKey, 'M', pastExpiration)
    const { secp256k1 } = await import('@noble/curves/secp256k1.js')
    const { bytesToHex, hexToBytes } = await import('@noble/curves/utils.js')
    const sig = bytesToHex(secp256k1.sign(digestToBytes(digest), hexToBytes(firstPriv)))

    let caught: unknown
    try {
      await insertSubsequentKey(ctx, {
        userId: expiringSoonUserId,
        signerPubKey: firstPub,
        signature: sig,
        newPubKey,
        expiration: pastExpiration,
        isImportReplay: 1
      })
    } catch (err) {
      caught = err
    }
    expectThrowsNamingCheck(caught, 'InsertValid')
  })
})
