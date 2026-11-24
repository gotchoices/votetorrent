// voter-verbs.ctl.spec.ts (67-29 Task 3): the five voter verbs through a REAL voter daemon's ctl endpoint
// against a TOKEN-posture officer daemon on the loopback relay, plus 67-27's two voter-driven legs owned here:
// the officer approves the voter's request through its ctl, and refuses a second voter's (who then reads
// `registration-closed`). A clean voter restart mid-ceremony keeps the same K_vote. Gated by VT_HOST_TIER=1;
// at most TWO CadreNodes are alive at once (the officer plus one voter). Nothing here prints a token, a code,
// a fingerprint, a registrant value, a reason, a multiaddr or a full peer id.

import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { assertFreshBuild } from '../src/engine.js'
import { hostTierEnabled } from './support/host-tier.js'
import { OFFICER_CALLS, startVoterRig, VERB_MS_FILE, type CallResult, type OfficerSetup, type VoterRig } from './support/voter-rig.js'

const HASH_RE = /^[0-9a-f]{32}$/
const UUID_RE = /^[0-9a-f-]{36}$/
const TAG_RE = /^[0-9a-f]{16}$/
const READ_DECISION_KEYS = ['associationDecision', 'associationRequestId', 'attempt', 'deviceKeyTag', 'ms', 'polls', 'registrantId', 'registrationDecision', 'status']

describe('voter verbs over ctl', function () {
  this.timeout(2_400_000)
  let rig: VoterRig
  let net: OfficerSetup
  let failed = false
  let v1RegistrantId = ''
  let v1Tag = ''
  let v1PeerId8 = ''
  let firstSyncBefore = -1
  const wall: Array<[string, number]> = []

  const common = (): string[] => ['--network', net.networkHash]
  const voter = (label: string, verb: string, flags: readonly string[]): Promise<CallResult> => rig.call('voter', label, verb, flags)
  const voterOk = async (label: string, verb: string, flags: readonly string[]): Promise<Record<string, unknown>> => {
    const r = await voter(label, verb, flags)
    expect(r.exit, `${verb}: ${r.error?.code ?? ''} ${r.err.slice(0, 300)}`).to.equal(0)
    return r.result
  }
  const voterRefused = async (label: string, verb: string, flags: readonly string[], code: string): Promise<CallResult> => {
    const r = await voter(label, verb, flags)
    expect(r.exit, `${verb}: expected a refusal, got ${r.out.slice(0, 300)}`).to.equal(1)
    expect(r.error?.code, `${verb}: ${r.err.slice(0, 300)}`).to.equal(code)
    expect(String(r.error?.message ?? '').length).to.be.at.most(200)
    return r
  }
  const readback = async (label: string): Promise<Record<string, unknown>> => {
    const r = await rig.call('voter', label, OFFICER_CALLS.readback.verb, [])
    expect(r.exit).to.equal(0)
    return r.result
  }
  const timed = async <T>(title: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now()
    try {
      return await fn()
    } finally {
      wall.push([title, Date.now() - t0])
    }
  }

  before(async function () {
    this.timeout(900_000)
    if (!hostTierEnabled()) this.skip()
    assertFreshBuild()
    rig = await startVoterRig({ party: 'vt29-' + randomBytes(4).toString('hex'), officerPosture: 'token' })
  })

  afterEach(function () {
    if (this.currentTest?.state === 'failed') failed = true
  })

  after(async function () {
    this.timeout(300_000)
    if (rig === undefined) return
    if (failed) process.env.VT_KEEP_RUN ??= '1'
    for (const [title, ms] of wall) console.log(`      WALL ${title} ${ms}`)
    console.log(`      peers high-water=${rig.peerHighWater}`)
    await rig.close()
  })

  it('setup: an officer in token posture founds, sets up the owner, mints two voter codes, creates an election and enables intake', async () => {
    await timed('setup', async () => {
      await rig.startOfficer()
      net = await rig.setupOfficer(['v1', 'v2'])
      expect(net.networkHash).to.match(HASH_RE)
      expect(net.codeFiles).to.have.length(2)
      const regs = await rig.registrations()
      expect(regs.posture).to.equal('token')
      expect(regs.intake).to.equal('enabled')
      const rb = await rig.call('officer', 'officer', OFFICER_CALLS.readback.verb, [])
      console.log(`      RSS officer-after-setup=${String(rb.result.rssMb)}MB`)
    })
  })

  it('voter join refuses a wrong expected fingerprint, then joins with the code and reports circuitReady', async () => {
    await timed('join', async () => {
      await rig.startVoter('v1')
      const before = await readback('v1')
      expect(before.role).to.equal('voter')
      expect(before.recentCount).to.equal(0)
      v1PeerId8 = String(before.peerId8)
      // every code of one network shares the founding fingerprint, so the rig's wrong one is a different value
      await voterRefused('v1', 'join', ['--code-file', net.codeFiles[0]!, '--expect-fingerprint-file', rig.wrongFingerprintFile, '--token-file', rig.voterToken('v1')], 'preview-mismatch')
      expect(readFileSync(net.fingerprintFiles[0]!, 'utf8')).to.equal(readFileSync(net.fingerprintFiles[1]!, 'utf8'))
      expect((await readback('v1')).recentCount).to.equal(0)
      await voterRefused('v1', 'join', ['--code-file', net.codeFiles[0]!, '--expect-fingerprint-file', net.fingerprintFiles[0]!], 'token-absent')
      const joined = await voterOk('v1', 'join', ['--code-file', net.codeFiles[0]!, '--expect-fingerprint-file', net.fingerprintFiles[0]!, '--token-file', rig.voterToken('v1')])
      expect(joined.joined).to.equal(true)
      expect(joined.fingerprintMatch).to.equal(true)
      expect(joined.networkHash).to.equal(net.networkHash)
      expect(['joined', 'already-joined']).to.include(joined.outcome)
      console.log(`      join ms=${String(joined.ms)} outcome=${String(joined.outcome)} admittedVia=${String(joined.admittedVia)} steps=${String(joined.steps)}`)
      const after = await readback('v1')
      expect(after.role).to.equal('voter')
      expect(after.circuitReady).to.equal(true)
      expect(after.ownerTrust).to.equal(null)
      expect(after.recentCount).to.equal(1)
      console.log(`      RSS v1-after-join=${String(after.rssMb)}MB`)
    })
  })

  it('register refuses without a token and with a wrong token, then stages the registration', async () => {
    await timed('register', async () => {
      const flags = [...common(), '--registrant-file', rig.registrantFile('v1')]
      await voterRefused('v1', 'register', flags, 'token-absent')
      await voterRefused('v1', 'register', [...flags, '--token-file', rig.wrongToken], 'token-refused')
      const r = await voterOk('v1', 'register', [...flags, '--token-file', rig.voterToken('v1')])
      expect(r.milestone).to.equal('registration-staged')
      expect(r.electionId).to.equal(net.electionId)
      expect(r.registrantId).to.match(UUID_RE)
      expect(r.deviceKeyTag).to.match(TAG_RE)
      v1RegistrantId = String(r.registrantId)
      v1Tag = String(r.deviceKeyTag)
      console.log(`      register ms=${String(r.ms)} steps=${String(r.steps)}`)
    })
  })

  it('the officer imports the request and approves it through its ctl', async () => {
    await timed('approve', async () => {
      const { body, rounds } = await rig.officerSyncUntil(async (sync, n) => {
        if (n === 1) firstSyncBefore = sync.associations.before
        if (sync.imported >= 1) return true
        const regs = await rig.registrations()
        return (regs.rows as Array<{ requestId: string }>).some((row) => row.requestId === v1RegistrantId)
      }, 300_000)
      expect(body.errors).to.equal(0)
      expect(body.refusals).to.deep.equal([])
      console.log(`      peer-sync rounds=${rounds} imported=${body.imported}`)
      const regs = await rig.registrations()
      const rows = regs.rows as Array<{ requestId: string, status: string }>
      const mine = rows.filter((row) => row.requestId === v1RegistrantId)
      expect(mine).to.have.length(1)
      expect(mine[0]!.status).to.equal('p')
      const C = OFFICER_CALLS.approve
      const r = await rig.call('officer', 'officer', C.verb, [C.authority, net.authorityId, C.network, net.networkHash, C.request, v1RegistrantId, C.checklist, 'id', C.token, rig.officerToken])
      expect(r.exit, `approve: ${r.error?.code ?? ''} ${r.err.slice(0, 300)}`).to.equal(0)
      expect(r.result.requestId).to.equal(v1RegistrantId)
      expect(r.result.published).to.be.a('string')
      console.log(`      approve ms=${String(r.result.ms)} published=${String(r.result.published)}`)
    })
  })

  it('after a clean voter restart, stage-association resumes the stored attempt with the same K_vote', async () => {
    await timed('restart+stage-association', async () => {
      await rig.restartVoter('v1')
      const rb = await readback('v1')
      expect(rb.peerId8).to.equal(v1PeerId8)
      expect(rb.recentCount).to.equal(1)
      const r = await voterOk('v1', 'stage-association', [...common(), '--token-file', rig.voterToken('v1')])
      expect(r.milestone).to.equal('association-staged')
      expect(r.registrantId).to.equal(v1RegistrantId)
      expect(r.deviceKeyTag).to.equal(v1Tag)
      expect(r.associationRequestId).to.match(UUID_RE)
      console.log(`      stage-association ms=${String(r.ms)} steps=${String(r.steps)}`)
    })
  })

  it('the officer sync issues a challenge and read-decision reports it', async () => {
    await timed('challenge', async () => {
      const { body, rounds } = await rig.officerSyncUntil((sync) => sync.challenges >= 1, 300_000)
      expect(body.challenges, `rounds=${rounds}`).to.be.at.least(1)
      expect(body.refusals).to.deep.equal([])
      const r = await voterOk('v1', 'read-decision', [...common(), '--wait-for', 'challenge', '--wait-ms', '300000'])
      expect(r.attempt).to.equal('stored')
      expect(r.associationDecision).to.equal('c')
      expect(r.registrationDecision).to.equal('a')
      expect(r.registrantId).to.equal(v1RegistrantId)
      expect(r.deviceKeyTag).to.equal(v1Tag)
      console.log(`      read-decision(challenge) ms=${String(r.ms)} polls=${String(r.polls)} status=${String(r.status)}`)
    })
  })

  it('answer-challenge answers with the token attestation', async () => {
    await timed('answer-challenge', async () => {
      const r = await voterOk('v1', 'answer-challenge', [...common(), '--wait-ms', '300000', '--token-file', rig.voterToken('v1')])
      expect(r.outcome).to.equal('answered')
      expect(r.challengeStatus).to.equal('c')
      expect(r.deviceKeyTag).to.equal(v1Tag)
      expect(r.registrantId).to.equal(v1RegistrantId)
      console.log(`      answer-challenge ms=${String(r.ms)} steps=${String(r.steps)}`)
    })
  })

  it('the officer sync verifies the token attestation and read-decision reports registered', async () => {
    await timed('associate', async () => {
      expect(firstSyncBefore).to.be.at.least(0)
      const { body, rounds } = await rig.officerSyncUntil((sync) => sync.associations.after > firstSyncBefore, 600_000)
      expect(body.associations.after, `rounds=${rounds}`).to.be.above(firstSyncBefore)
      expect(body.refusals).to.deep.equal([])
      expect(body.attestation.posture).to.equal('token')
      console.log(`      peer-sync rounds=${rounds} associations=${body.associations.before}->${body.associations.after}`)
      const r = await voterOk('v1', 'read-decision', [...common(), '--wait-for', 'registered', '--wait-ms', '600000'])
      expect(Object.keys(r).sort()).to.deep.equal(READ_DECISION_KEYS)
      expect(r.status).to.equal('registered')
      expect(r.associationDecision).to.equal('a')
      expect(r.registrationDecision).to.equal('a')
      expect(r.deviceKeyTag).to.equal(v1Tag)
      console.log(`      read-decision(registered) ms=${String(r.ms)} polls=${String(r.polls)}`)
      const rb = await readback('v1')
      console.log(`      RSS v1-after-registered=${String(rb.rssMb)}MB`)
    })
  })

  it('a second voter is refused through the officer ctl and reads registration-closed', async () => {
    await timed('refuse', async () => {
      expect(await rig.stopVoter('v1')).to.equal(0)
      await rig.startVoter('v2')
      const joined = await voterOk('v2', 'join', ['--code-file', net.codeFiles[1]!, '--expect-fingerprint-file', net.fingerprintFiles[1]!, '--token-file', rig.voterToken('v2')])
      expect(joined.joined).to.equal(true)
      const reg = await voterOk('v2', 'register', [...common(), '--registrant-file', rig.registrantFile('v2'), '--token-file', rig.voterToken('v2')])
      const v2RegistrantId = String(reg.registrantId)
      expect(v2RegistrantId).to.match(UUID_RE)
      expect(reg.deviceKeyTag).to.not.equal(v1Tag)
      await rig.officerSyncUntil(async () => {
        const regs = await rig.registrations()
        return (regs.rows as Array<{ requestId: string, status: string }>).some((row) => row.requestId === v2RegistrantId && row.status === 'p')
      }, 300_000)
      const C = OFFICER_CALLS.refuse
      const r = await rig.call('officer', 'officer', C.verb, [C.authority, net.authorityId, C.network, net.networkHash, C.request, v2RegistrantId, C.checklist, 'id', C.reasonFile, rig.reasonFile, C.token, rig.officerToken])
      expect(r.exit, `refuse: ${r.error?.code ?? ''} ${r.err.slice(0, 300)}`).to.equal(0)
      expect(r.result.requestId).to.equal(v2RegistrantId)
      console.log(`      refuse ms=${String(r.result.ms)} published=${String(r.result.published)} taskClose=${String(r.result.taskClose)}`)
      const closed = await voterOk('v2', 'read-decision', [...common(), '--wait-for', 'closed', '--wait-ms', '300000'])
      expect(closed.registrationDecision).to.equal('r')
      await voterRefused('v2', 'stage-association', [...common(), '--token-file', rig.voterToken('v2')], 'registration-closed')
      const after = await voterOk('v2', 'read-decision', common())
      expect(after.status).to.not.equal('registered')
      console.log(`      v2 after refusal: status=${String(after.status)} registrationDecision=${String(after.registrationDecision)} associationDecision=${String(after.associationDecision)}`)
      expect(rig.peerHighWater).to.be.at.most(2)
    })
  })

  it('VERB-MS lines exist for every voter verb and the voter-driven officer verbs', () => {
    const lines = readFileSync(VERB_MS_FILE, 'utf8')
    for (const v of ['join', 'register', 'stage-association', 'answer-challenge', 'read-decision', 'approve', 'refuse', 'peer-sync']) {
      expect(lines, v).to.match(new RegExp(`^VERB-MS ${v} \\d+ \\d+$`, 'm'))
    }
    expect(/[0-9a-f]{32,}/.test(lines)).to.equal(false)
  })

  it('no ctl reply, log or peer dir holds a token, a join code, registrant data or a reason', () => {
    const scan = rig.scan()
    console.log(`      scan files=${scan.files} whole=${scan.whole} windows=${scan.windows}`)
    expect(scan.files).to.be.above(0)
    expect(scan.whole).to.equal(0)
    expect(scan.windows).to.equal(0)
    const text = rig.captured.join('\n') + '\n' + readFileSync(`${rig.logsDir}/ctl-replies.jsonl`, 'utf8')
    expect(text).to.not.include('/p2p/')
    expect(text).to.not.include('RELAY_MULTIADDR=')
    expect(/[0-9a-f]{64}/.test(text)).to.equal(false)
    expect(text).to.not.include('challengeNonce')
    expect(text).to.not.include('registrationCode')
    expect(text).to.not.include('"firstName"')
  })
})
