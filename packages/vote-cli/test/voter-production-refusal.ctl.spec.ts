// voter-production-refusal.ctl.spec.ts (67-29 Task 3, CLI-04): the voter-driven production-posture refusal
// 67-27 assigned to this plan. A PRODUCTION-posture officer (started WITHOUT the posture flag on a
// non-production party) founds, mints, creates an election and enables intake; a voter daemon joins,
// registers, is approved, stages its association and answers the challenge with a token attestation; the
// officer's `peer-sync` refuses it (`token-attestation-refused`) with no association, and the voter never
// reads `registered`. Gated by VT_HOST_TIER=1; two CadreNodes at most; run after the token-posture spec.

import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { assertFreshBuild } from '../src/engine.js'
import { hostTierEnabled } from './support/host-tier.js'
import { OFFICER_CALLS, startVoterRig, type CallResult, type OfficerSetup, type VoterRig } from './support/voter-rig.js'

const UUID_RE = /^[0-9a-f-]{36}$/

describe('voter production refusal over ctl', function () {
  this.timeout(2_400_000)
  let rig: VoterRig
  let net: OfficerSetup
  let failed = false
  let registrantId = ''
  let tag = ''
  let firstSyncBefore = -1

  const common = (): string[] => ['--network', net.networkHash]
  const voterOk = async (verb: string, flags: readonly string[]): Promise<Record<string, unknown>> => {
    const r: CallResult = await rig.call('voter', 'v1', verb, flags)
    expect(r.exit, `${verb}: ${r.error?.code ?? ''} ${r.err.slice(0, 300)}`).to.equal(0)
    return r.result
  }

  before(async function () {
    this.timeout(900_000)
    if (!hostTierEnabled()) this.skip()
    assertFreshBuild()
    rig = await startVoterRig({ party: 'vt29p-' + randomBytes(4).toString('hex'), officerPosture: 'production' })
  })

  afterEach(function () {
    if (this.currentTest?.state === 'failed') failed = true
  })

  after(async function () {
    this.timeout(300_000)
    if (rig === undefined) return
    if (failed) process.env.VT_KEEP_RUN ??= '1'
    console.log(`      peers high-water=${rig.peerHighWater}`)
    await rig.close()
  })

  it('setup: an officer in production posture founds, mints, creates an election and enables intake, and reports posture production', async () => {
    await rig.startOfficer()
    net = await rig.setupOfficer(['v1'])
    const regs = await rig.registrations()
    expect(regs.posture).to.equal('production')
    expect(regs.intake).to.equal('enabled')
  })

  it('the voter joins, registers and the officer approves', async () => {
    await rig.startVoter('v1')
    const joined = await voterOk('join', ['--code-file', net.codeFiles[0]!, '--expect-fingerprint-file', net.fingerprintFiles[0]!, '--token-file', rig.voterToken('v1')])
    expect(joined.joined).to.equal(true)
    const reg = await voterOk('register', [...common(), '--registrant-file', rig.registrantFile('v1'), '--token-file', rig.voterToken('v1')])
    expect(reg.milestone).to.equal('registration-staged')
    registrantId = String(reg.registrantId)
    tag = String(reg.deviceKeyTag)
    expect(registrantId).to.match(UUID_RE)
    const { body } = await rig.officerSyncUntil(async (sync, n) => {
      if (n === 1) firstSyncBefore = sync.associations.before
      const regs = await rig.registrations()
      return (regs.rows as Array<{ requestId: string, status: string }>).some((row) => row.requestId === registrantId && row.status === 'p')
    }, 300_000)
    expect(body.attestation.posture).to.equal('production')
    const C = OFFICER_CALLS.approve
    const r = await rig.call('officer', 'officer', C.verb, [C.authority, net.authorityId, C.network, net.networkHash, C.request, registrantId, C.checklist, 'id', C.token, rig.officerToken])
    expect(r.exit, `approve: ${r.error?.code ?? ''} ${r.err.slice(0, 300)}`).to.equal(0)
    expect(r.result.requestId).to.equal(registrantId)
  })

  it('the voter stages the association and the officer sync issues a challenge', async () => {
    const r = await voterOk('stage-association', [...common(), '--token-file', rig.voterToken('v1')])
    expect(r.milestone).to.equal('association-staged')
    expect(r.deviceKeyTag).to.equal(tag)
    const { body, rounds } = await rig.officerSyncUntil((sync) => sync.challenges >= 1, 300_000)
    expect(body.challenges, `rounds=${rounds}`).to.be.at.least(1)
    const d = await voterOk('read-decision', [...common(), '--wait-for', 'challenge', '--wait-ms', '300000'])
    expect(d.associationDecision).to.equal('c')
  })

  it('the voter answers with a token attestation and the officer sync reports token-attestation-refused with no association', async () => {
    const r = await voterOk('answer-challenge', [...common(), '--wait-ms', '300000', '--token-file', rig.voterToken('v1')])
    expect(r.outcome).to.equal('answered')
    expect(r.challengeStatus).to.equal('c')
    expect(r.deviceKeyTag).to.equal(tag)
    const { body, rounds } = await rig.officerSyncUntil((sync) => sync.refusals.includes('token-attestation-refused'), 600_000)
    expect(body.refusals, `rounds=${rounds}`).to.include('token-attestation-refused')
    expect(body.associations.after).to.equal(firstSyncBefore)
    expect(body.attestation.posture).to.equal('production')
    console.log(`      peer-sync rounds=${rounds} refusals=${body.refusals.join(',')} associations=${body.associations.before}->${body.associations.after}`)
  })

  it('read-decision never reports registered and the secret scan is clean', async () => {
    const r = await voterOk('read-decision', [...common(), '--wait-ms', '60000'])
    expect(r.attempt).to.equal('stored')
    expect(r.status).to.not.equal('registered')
    expect(r.associationDecision).to.not.equal('a')
    expect(r.deviceKeyTag).to.equal(tag)
    console.log(`      production read-decision: status=${String(r.status)} registrationDecision=${String(r.registrationDecision)} associationDecision=${String(r.associationDecision)}`)
    const scan = rig.scan()
    console.log(`      scan files=${scan.files} whole=${scan.whole} windows=${scan.windows}`)
    expect(scan.files).to.be.above(0)
    expect(scan.whole).to.equal(0)
    expect(scan.windows).to.equal(0)
    expect(rig.peerHighWater).to.be.at.most(2)
  })
})
