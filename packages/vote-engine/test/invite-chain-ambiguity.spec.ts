/**
 * invite-chain-ambiguity.spec.ts - every fail-closed (`ambiguous`) branch of readInviteChain (WR-08).
 * Each real-database case first proves the share resolves live (positive control on the same fixture),
 * then inserts the malformed row(s) so ONLY its own branch can catch it. A stub-database tier covers
 * shapes the real schema may refuse to store.
 */
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import { readInviteChain } from '../src/invite/read-invite-chain.js'
import type { EngineContext } from '../src/types.js'
import { nowCanonicalDatetime } from '../src/utils.js'
import { makeChainFixture, sendInvite, insertRawChainRow, writeRawMarker, resultRows } from './fixtures/invite-chain.js'
import type { ChainFixture, SentShare } from './fixtures/invite-chain.js'

async function expectLive (fx: ChainFixture, s: SentShare): Promise<void> {
  expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).to.deep.equal({ status: 'live', cid: s.cid })
}

async function expectAmbiguous (fx: ChainFixture, s: SentShare): Promise<void> {
  expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).to.deep.equal({ status: 'ambiguous' })
  expect(await fx.invitation.resolveInviteSlotCid(s.inviteKey, 'of')).to.equal(undefined)
}

describe('readInviteChain fail-closed branches (WR-08)', () => {
  it('A1: two signing nonces under one InviteKey and Type resolve ambiguous', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    await expectLive(fx, s)
    await insertRawChainRow(fx, s, {
      resendSalt: `resend|999999001|${nowCanonicalDatetime()}`,
      nonce: bytesToHex(secp256k1.utils.randomSecretKey()),
    })
    await expectAmbiguous(fx, s)
  })

  it('A2: two originals sharing a nonce resolve ambiguous', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    await expectLive(fx, s)
    await insertRawChainRow(fx, s, { resendSalt: null, name: 'Second original' })
    await expectAmbiguous(fx, s)
  })

  it('A3: a ResendSalt that is not resend|tid|time resolves ambiguous', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    await expectLive(fx, s)
    await insertRawChainRow(fx, s, { resendSalt: 'bogus' })
    await expectAmbiguous(fx, s)
  })

  it('A3: a ResendSalt with a non-integer tid resolves ambiguous', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    await expectLive(fx, s)
    await insertRawChainRow(fx, s, { resendSalt: `resend|abc|${nowCanonicalDatetime()}` })
    await expectAmbiguous(fx, s)
  })

  it('A4: a ResendSalt with an unparseable time resolves ambiguous', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    await expectLive(fx, s)
    await insertRawChainRow(fx, s, { resendSalt: 'resend|999999002|not-a-time' })
    await expectAmbiguous(fx, s)
  })

  it('A5: two resend rows with identical order keys resolve ambiguous', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    await expectLive(fx, s)
    const salt = `resend|999999003|${nowCanonicalDatetime()}`
    await insertRawChainRow(fx, s, { resendSalt: salt, name: 'Twin one' })
    await insertRawChainRow(fx, s, { resendSalt: salt, name: 'Twin two' })
    await expectAmbiguous(fx, s)
  })

  it('A6: the real schema refuses to store an unparseable CancelledAt, so the branch is covered by the stub tier', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    await fx.authority.resendInvite(s.cid)
    let caught: unknown
    try { await writeRawMarker(fx, s.cid, 'not-a-time') } catch (err) { caught = err }
    expect(caught).to.be.instanceOf(Error)
    expect((caught as Error).message).to.match(/Cannot convert 'not-a-time' to DATETIME/)
  })

  it('R1: accepting a row of an ambiguous chain is refused and writes nothing', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    await expectLive(fx, s)
    const salt = `resend|999999004|${nowCanonicalDatetime()}`
    const a = await insertRawChainRow(fx, s, { resendSalt: salt, name: 'Twin one' })
    const b = await insertRawChainRow(fx, s, { resendSalt: salt, name: 'Twin two' })
    let caught: unknown
    try { await fx.invitation.respondToInvite(a, true, s.invitePrivate) } catch (err) { caught = err }
    expect(caught).to.be.instanceOf(Error)
    expect((caught as Error).message).to.match(/cannot be verified on this device/)
    expect(await resultRows(fx, [s.cid, a, b])).to.equal(0)
  })
})

describe('unscoped chain read reports ambiguity before answers (WR-06)', () => {
  it('W6: a planted answered copy under another nonce cannot make the share read answered', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    await expectLive(fx, s)
    const planted = await insertRawChainRow(fx, s, {
      resendSalt: null,
      name: 'Planted copy',
      nonce: bytesToHex(secp256k1.utils.randomSecretKey()),
    })
    // The planted copy is answered (its own nonce-scoped chain is live, so the answer is accepted).
    await fx.invitation.respondToInvite(planted, true, s.invitePrivate)
    expect(await resultRows(fx, [planted])).to.equal(1)
    await expectAmbiguous(fx, s)
    // The victim's own slot is NOT refused as answered: its nonce-scoped chain is live.
    await fx.invitation.respondToInvite(s.cid, true, s.invitePrivate)
    expect(await resultRows(fx, [s.cid])).to.equal(1)
  })
})

interface StubRow { Cid: string, SigningNonce: string, ResendSalt: string | null }

/** Implements only the two db calls readInviteChain makes; replaces the db ARGUMENT, no production seam. */
function stubDb (rows: StubRow[], opts: { cancelled?: Record<string, string>, answered?: string[], unexpired?: boolean } = {}): EngineContext['db'] {
  const db = {
    async * eval (_sql: string, _params: Record<string, unknown>) { for (const r of rows) yield r },
    prepare (sql: string) {
      return {
        async get (params: Record<string, unknown>) {
          const cid = params.slotCid as string
          if (sql.includes('InviteResult')) return (opts.answered ?? []).includes(cid) ? { x: 1 } : undefined
          if (sql.includes('InviteCancellation')) {
            const at = opts.cancelled?.[cid]
            return at === undefined ? undefined : { CancelledAt: at }
          }
          if (sql.includes('InviteSlot')) return opts.unexpired === false ? undefined : { x: 1 }
          throw new Error(`stub: unexpected sql ${sql}`)
        },
      }
    },
  }
  return db as unknown as EngineContext['db']
}

const NOW = '2030-01-01T00:00:00'

describe('readInviteChain over a stub database (WR-08)', () => {
  const original: StubRow = { Cid: 'c-orig', SigningNonce: 'n', ResendSalt: null }

  it('a well-formed two-row chain resolves live on the resend row (positive control)', async () => {
    const rows = [original, { Cid: 'c-head', SigningNonce: 'n', ResendSalt: 'resend|5|2030-01-01T00:00:00' }]
    expect(await readInviteChain(stubDb(rows), 'k', 'of', NOW)).to.deep.equal({ status: 'live', cid: 'c-head' })
  })

  it('A4: an unparseable resend time is ambiguous', async () => {
    const rows = [original, { Cid: 'c-head', SigningNonce: 'n', ResendSalt: 'resend|5|not-a-time' }]
    expect(await readInviteChain(stubDb(rows), 'k', 'of', NOW)).to.deep.equal({ status: 'ambiguous' })
  })

  it('A5: equal order keys are ambiguous', async () => {
    const salt = 'resend|5|2030-01-01T00:00:00'
    const rows = [original, { Cid: 'c-a', SigningNonce: 'n', ResendSalt: salt }, { Cid: 'c-b', SigningNonce: 'n', ResendSalt: salt }]
    expect(await readInviteChain(stubDb(rows), 'k', 'of', NOW)).to.deep.equal({ status: 'ambiguous' })
  })

  it('A6: an unparseable non-head CancelledAt is ambiguous', async () => {
    const rows = [original, { Cid: 'c-head', SigningNonce: 'n', ResendSalt: 'resend|5|2030-01-01T00:00:00' }]
    const db = stubDb(rows, { cancelled: { 'c-orig': 'not-a-time' } })
    expect(await readInviteChain(db, 'k', 'of', NOW)).to.deep.equal({ status: 'ambiguous' })
  })
})
