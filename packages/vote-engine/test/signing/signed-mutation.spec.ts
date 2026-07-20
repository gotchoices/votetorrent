import { expect } from 'chai'
import type { Signature } from '@votetorrent/vote-core'
import { seedSignedMutation } from '../../src/signing/signed-mutation.js'
import { peekNextElectionTid } from '../../src/elections/elections-engine.js'
import { toCanonicalDatetime } from '../../src/utils.js'
import {
  addTestAuthority,
  createTestNetwork,
  makeElectionInit,
  makeTestSignature,
  seedElectionSigning,
} from '../fixtures/test-context.js'

// The Election digest expression, byte-for-byte the same shape
// seedElectionSigning / Election.InsertValid use — reused here so the spec
// proves seedSignedMutation's generalization is faithful without depending
// on the (wave-3) registration tables.
const ELECTION_DIGEST_EXPR =
  'select Digest(:tid, :id, :authorityId, :title, :date, :revisionDeadline, :ballotDeadline, :type) as d'

describe('signed-mutation', () => {
  it('produces a Digest byte-identical to seedElectionSigning for the same inputs (generalization fidelity)', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const init = makeElectionInit({ authorityId: auth.authority.id })
    const e = init.election
    const tid = await peekNextElectionTid(auth.ctx.db)

    const digestParams = {
      tid,
      id: e.id,
      authorityId: e.authorityId,
      title: e.title,
      date: toCanonicalDatetime(e.date),
      revisionDeadline: toCanonicalDatetime(e.revisionDeadline),
      ballotDeadline: toCanonicalDatetime(e.ballotDeadline),
      type: e.type,
    }

    // Reference path — the existing seedElectionSigning fixture.
    const { nonce: refNonce } = await seedElectionSigning(auth.ctx, auth.authority.id, init, auth.user, tid)

    // Generalized helper path — same inputs, same scope.
    let receivedDigest: Uint8Array | undefined
    const sign = async (digest: Uint8Array): Promise<Signature> => {
      receivedDigest = digest
      return makeTestSignature(auth.user)
    }
    const helperNonce = await seedSignedMutation(
      auth.ctx,
      auth.authority.id,
      'mel',
      tid,
      ELECTION_DIGEST_EXPR,
      digestParams,
      sign
    )

    expect(helperNonce).to.be.a('string').and.not.equal(refNonce)
    expect(receivedDigest).to.be.instanceOf(Uint8Array)

    const refRow = await auth.ctx.db
      .prepare('select Scope, Digest from AdminSigning where Nonce = :nonce')
      .get({ nonce: refNonce })
    const helperRow = await auth.ctx.db
      .prepare('select Scope, Digest from AdminSigning where Nonce = :nonce')
      .get({ nonce: helperNonce })

    expect(helperRow).to.exist
    expect(helperRow?.Scope).to.equal('mel')
    expect(helperRow?.Digest).to.equal(refRow?.Digest)

    const sigRow = await auth.ctx.db
      .prepare('select count(*) as n from AdminSignature where SigningNonce = :nonce')
      .get({ nonce: helperNonce })
    expect(Number(sigRow?.n)).to.equal(1)
  })

  it('throws a descriptive error when CurrentAdmin is missing for the authority', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const tid = await peekNextElectionTid(auth.ctx.db)

    let threw = false
    try {
      await seedSignedMutation(
        auth.ctx,
        'nonexistent-authority-id',
        'mel',
        tid,
        'select Digest(:tid, :x) as d',
        { tid, x: 'y' },
        async () => makeTestSignature(auth.user)
      )
    } catch (err) {
      threw = true
      expect((err as Error).message).to.match(/CurrentAdmin/)
    }
    expect(threw).to.equal(true)
  })
})
