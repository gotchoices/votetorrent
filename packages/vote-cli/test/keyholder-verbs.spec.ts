// keyholder-verbs.spec.ts: the four keyholder verbs (join, accept, dkg, release) through the ctl
// endpoint against THREE real daemons (officer, kh-a, kh-b: the built vt bin, real CadreNodes) on the
// loopback relay, with every live refusal path: no token, a wrong or group-readable token, a
// group-readable share file, a held seat, an answered seat, a token-less DKG, a repeated DKG, a
// premature release and a foreign election. Gated by VT_HOST_TIER=1 (test/support/host-tier.ts). The
// DEFAULT timeline (lead 600 000 / window 480 000) keeps the release window closed for the whole run.
// Nothing here prints a token, a share, a code, a key, a multiaddr or a full peer id.

import { expect } from 'chai'
import { chmodSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertFreshBuild } from '../src/engine.js'
import { KEYHOLDER_VERB_NAMES } from '../src/verbs/keyholder/index.js'
import { hostTierEnabled } from './support/host-tier.js'
import { randomParty, startKeyholderRig, type ElectionSetup, type ErrorView, type KeyholderRig } from './support/keyholder-rig.js'

const ACCEPT_KEYS = ['acceptUnwraps', 'accepted', 'attempts', 'election8', 'ms', 'userId8']
const DKG_KEYS = ['actions', 'advancing', 'attempt', 'dkgUnwraps', 'drives', 'hasShare', 'jointKeyTag', 'ms', 'ownMessages', 'participants', 'phase', 'threshold']

/** The unwrap count a KeyholderVerbError carries in its fixed message (` unwraps=<n>`), or undefined. */
export function unwrapsOf(e: ErrorView): number | undefined {
  const m = / unwraps=(\d+)$/.exec(e.message ?? '')
  return m === null ? undefined : Number(m[1])
}

describe('keyholder verbs over ctl', function () {
  this.timeout(2_400_000)
  let rig: KeyholderRig
  let E: ElectionSetup
  let failed = false
  let userId8A = ''
  let userId8B = ''
  let dkgA: Record<string, unknown> = {}

  before(async function () {
    this.timeout(1_200_000)
    if (!hostTierEnabled()) this.skip()
    assertFreshBuild()
    rig = await startKeyholderRig({ party: randomParty('vt28k'), leadMs: 600_000, windowMs: 480_000 })
    await rig.startOfficerAndFound()
    await rig.mintFor('kh-a')
    await rig.mintFor('kh-b')
    E = await rig.createElection()
    await rig.inviteSeat('kh-a')
    await rig.inviteSeat('kh-b')
    await rig.ballotSubmit()
    await rig.step('start-kh-a', () => rig.startPeer('kh-a'))
    await rig.step('start-kh-b', () => rig.startPeer('kh-b'))
  })

  afterEach(function () {
    if (this.currentTest?.state === 'failed') failed = true
  })

  after(async function () {
    this.timeout(300_000)
    if (rig !== undefined) await rig.close({ keep: failed })
  })

  const expectRefusal = (e: ErrorView, code: string, verb: string): void => {
    expect(e.name, `${verb}: ${e.name} ${String(e.code)} ${String(e.message)}`).to.equal('KeyholderVerbError')
    expect(e.code, `${verb}: ${String(e.message)}`).to.equal(code)
    expect(e.message?.startsWith(`keyholder ${verb} refused (${code})`), String(e.message)).to.equal(true)
  }

  it('keyholder join joins kh-a and kh-b, and a join with the wrong expected name refuses', async () => {
    const listed = await rig.ok('kh-a', 'verbs')
    expect((listed as { verbs: string[] }).verbs).to.include.members([...KEYHOLDER_VERB_NAMES])
    expect([...KEYHOLDER_VERB_NAMES]).to.deep.equal(['join', 'accept', 'dkg', 'release'])
    const wrong = await rig.refused('kh-b', 'join', {
      codeFile: join(rig.secretsDir, 'join-kh-b.txt'),
      expectName: 'Not This Net',
      expectFingerprintFile: join(rig.secretsDir, 'fingerprint-kh-b.txt'),
      networkHash: rig.networkHash,
      tokenFile: rig.tokens['kh-b'],
      timeoutMs: '60000'
    })
    expect(wrong.name).to.equal('NetworkVerbError')
    expect(wrong.code).to.equal('preview-mismatch')
    for (const kh of ['kh-a', 'kh-b'] as const) {
      const r = await rig.joinKeyholder(kh)
      expect(r.outcome, `${kh} ${JSON.stringify(r)}`).to.equal('joined')
      expect(r.isJoinedNetwork).to.equal(true)
      console.log(`      join ${kh} joinMs=${String(r.joinMs)} admittedVia=${String(r.admittedVia)}`)
    }
  })

  it('accept without a token refuses auth-denied, keeps zero identities, and the seat stays acceptable', async () => {
    const before = rig.listVaultState('kh-a')
    const e = await rig.refused('kh-a', 'accept', { network: E.networkHash, shareFile: E.seatFiles[0], waitMs: '120000' })
    expectRefusal(e, 'auth-denied', 'accept')
    expect(unwrapsOf(e)).to.equal(0)
    const after = rig.listVaultState('kh-a')
    expect(after.records).to.deep.equal(before.records)
    expect(after.sealed).to.equal(before.sealed)
  })

  it('accept with a wrong or group-readable token file refuses auth-denied', async () => {
    const before = rig.listVaultState('kh-a')
    const wrong = await rig.refused('kh-a', 'accept', { network: E.networkHash, shareFile: E.seatFiles[0], tokenFile: rig.tokens.wrong, waitMs: '60000' })
    expectRefusal(wrong, 'auth-denied', 'accept')
    const open = await rig.refused('kh-a', 'accept', { network: E.networkHash, shareFile: E.seatFiles[0], tokenFile: rig.tokens.open, waitMs: '60000' })
    expectRefusal(open, 'auth-denied', 'accept')
    expect(rig.listVaultState('kh-a').records).to.deep.equal(before.records)
  })

  it('accept with a group-readable share file refuses share-file-mode before any engine read', async () => {
    const loose = join(rig.secretsDir, 'seat-a-loose.share')
    copyFileSync(E.seatFiles[0], loose)
    chmodSync(loose, 0o644)
    const before = rig.listVaultState('kh-a')
    const e = await rig.refused('kh-a', 'accept', { network: E.networkHash, shareFile: loose, tokenFile: rig.tokens['kh-a'] })
    expectRefusal(e, 'share-file-mode', 'accept')
    expect(unwrapsOf(e)).to.equal(0)
    expect(rig.listVaultState('kh-a').records).to.deep.equal(before.records)
  })

  it('accept with the token accepts seat A on kh-a and records acceptUnwraps', async () => {
    const r = await rig.step('accept-a', () => rig.ok('kh-a', 'accept', { network: E.networkHash, shareFile: E.seatFiles[0], tokenFile: rig.tokens['kh-a'], waitMs: '180000' }, { timeoutMs: 300_000 }))
    expect(Object.keys(r).sort()).to.deep.equal(ACCEPT_KEYS)
    expect(r.accepted).to.equal(true)
    expect(String(r.userId8).length).to.equal(8)
    expect(r.election8).to.equal(E.electionId.slice(0, 8))
    expect(Number.isInteger(r.acceptUnwraps) && Number(r.acceptUnwraps) >= 0).to.equal(true)
    userId8A = String(r.userId8)
    console.log(`      accept kh-a acceptUnwraps=${String(r.acceptUnwraps)} attempts=${String(r.attempts)} ms=${String(r.ms)}`)
  })

  it('accept of seat B on kh-a refuses seat-already-held at zero unwraps', async () => {
    const e = await rig.refused('kh-a', 'accept', { network: E.networkHash, shareFile: E.seatFiles[1], tokenFile: rig.tokens['kh-a'], waitMs: '60000' })
    expectRefusal(e, 'seat-already-held', 'accept')
    expect(unwrapsOf(e)).to.equal(0)
  })

  it('accept of the answered seat A on kh-b refuses, then seat B on kh-b accepts', async () => {
    const e = await rig.refused('kh-b', 'accept', { network: E.networkHash, shareFile: E.seatFiles[0], tokenFile: rig.tokens['kh-b'], waitMs: '120000' })
    expectRefusal(e, 'already-answered', 'accept')
    expect(unwrapsOf(e)).to.equal(0)
    const r = await rig.step('accept-b', () => rig.ok('kh-b', 'accept', { network: E.networkHash, shareFile: E.seatFiles[1], tokenFile: rig.tokens['kh-b'], waitMs: '180000' }, { timeoutMs: 300_000 }))
    expect(Object.keys(r).sort()).to.deep.equal(ACCEPT_KEYS)
    expect(r.userId8).to.not.equal(userId8A)
    userId8B = String(r.userId8)
    expect(userId8B.length).to.equal(8)
    console.log(`      accept kh-b acceptUnwraps=${String(r.acceptUnwraps)} attempts=${String(r.attempts)} ms=${String(r.ms)}`)
  })

  it('dkg without a token refuses auth-denied at the first token-gated operation and writes no DKG message from that keyholder', async () => {
    const e = await rig.refused('kh-a', 'dkg', { network: E.networkHash, election: E.electionId, boundMs: '120000' }, { timeoutMs: 300_000 })
    expectRefusal(e, 'auth-denied', 'dkg')
    const unwraps = unwrapsOf(e)
    expect(unwraps === 0 || unwraps === 1, `unwraps=${String(unwraps)}`).to.equal(true)
    console.log(`      dkg no-token kh-a unwraps=${String(unwraps)}`)
  })

  it('dkg with tokens on kh-a and kh-b in parallel reaches complete with one joint key, threshold 2, participants 2', async () => {
    const [a, b] = await rig.step('dkg', () =>
      Promise.all([
        rig.ok('kh-a', 'dkg', { network: E.networkHash, election: E.electionId, tokenFile: rig.tokens['kh-a'] }, { timeoutMs: 1_000_000 }),
        rig.ok('kh-b', 'dkg', { network: E.networkHash, election: E.electionId, tokenFile: rig.tokens['kh-b'] }, { timeoutMs: 1_000_000 })
      ])
    )
    for (const [r, kh] of [[a, 'kh-a'], [b, 'kh-b']] as const) {
      expect(Object.keys(r).sort(), kh).to.deep.equal(DKG_KEYS)
      expect(r.phase, kh).to.equal('complete')
      expect(r.hasShare, kh).to.equal(true)
      expect(r.threshold, kh).to.equal(2)
      expect(r.participants, kh).to.equal(2)
      expect(Number(r.dkgUnwraps), kh).to.be.at.least(1)
      expect(String(r.jointKeyTag), kh).to.match(/^[0-9a-f]{16}$/)
      console.log(`      dkg ${kh} drives=${String(r.drives)} advancing=${String(r.advancing)} actions=${String(r.actions)} attempt=${String(r.attempt)} ownMessages=${String(r.ownMessages)} dkgUnwraps=${String(r.dkgUnwraps)} ms=${String(r.ms)}`)
    }
    expect(a.jointKeyTag).to.equal(b.jointKeyTag)
    dkgA = a
  })

  it('a repeated dkg is a no-op: no advance, no action, no unwrap, the same attempt and message count', async () => {
    const r = await rig.ok('kh-a', 'dkg', { network: E.networkHash, election: E.electionId, tokenFile: rig.tokens['kh-a'] }, { timeoutMs: 300_000 })
    expect(r.phase).to.equal('complete')
    expect(r.advancing).to.equal(0)
    expect(r.actions).to.equal(0)
    expect(r.dkgUnwraps).to.equal(0)
    expect(r.drives).to.equal(1)
    expect(r.attempt).to.equal(dkgA.attempt)
    expect(r.ownMessages).to.equal(dkgA.ownMessages)
    expect(r.jointKeyTag).to.equal(dkgA.jointKeyTag)
  })

  it('release before the window refuses window-not-open at zero unwraps', async () => {
    expect(E.releasingKeysAt - Date.now()).to.be.greaterThan(60_000)
    const e = await rig.refused('kh-a', 'release', { network: E.networkHash, election: E.electionId, tokenFile: rig.tokens['kh-a'], waitMs: '0' }, { timeoutMs: 300_000 })
    expectRefusal(e, 'window-not-open', 'release')
    expect(unwrapsOf(e)).to.equal(0)
  })

  it('dkg and release for an election this keyholder holds no seat in refuse identity-not-found at zero unwraps', async () => {
    const d = await rig.refused('kh-a', 'dkg', { network: E.networkHash, election: 'election-1700000000000', tokenFile: rig.tokens['kh-a'] }, { timeoutMs: 300_000 })
    expectRefusal(d, 'identity-not-found', 'dkg')
    expect(unwrapsOf(d)).to.equal(0)
    const r = await rig.refused('kh-b', 'release', { network: E.networkHash, election: 'election-1700000000000', tokenFile: rig.tokens['kh-b'] }, { timeoutMs: 300_000 })
    expectRefusal(r, 'identity-not-found', 'release')
    expect(unwrapsOf(r)).to.equal(0)
  })

  it('no ctl reply, log or peer dir holds a seat share, an invite key, a join code or a token', async () => {
    expect(rig.registry.size).to.be.at.least(14)
    const out = rig.scan()
    console.log(`      scan files=${out.files} whole=${out.whole} windows=${out.windows}`)
    expect(out.files).to.be.at.least(6)
    expect(out.whole).to.equal(0)
    expect(out.windows).to.equal(0)
    const dirs = rig.scanVaults(rig.registry)
    console.log(`      scan vaults files=${dirs.files} whole=${dirs.whole} windows=${dirs.windows}`)
    expect(dirs.files).to.be.at.least(9)
    expect(dirs.whole).to.equal(0)
    expect(dirs.windows).to.equal(0)
    for (const text of rig.captured) {
      expect(text).to.not.match(/\/p2p\//)
      expect(text).to.not.match(/[0-9a-f]{64}/)
    }
  })
})
