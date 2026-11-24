// officer-attestation-harness.spec.ts (67-27 Task 3, CLI-04 "a production-policy network refuses a token
// attestation"): ONE in-process officer context built the way the daemon builds it (67-23's
// bootInProcessPeer, a real CadreNode on the loopback relay) with a network founded through 67-24's
// `found` handler, so the composition below runs against a real strand-backed node. The production
// posture refuses a producer-made token attestation (`associate` rejects, no Association row, one failed
// verdict, delta `token-attestation-refused`); the token posture over the SAME node accepts one; the
// token posture still refuses a non-token attestation; and the token composition cannot be built on the
// production party. Gated by VT_HOST_TIER=1; one peer in this process.

import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttestationChallenge, DeviceAttestation, RegisterInit } from '@votetorrent/vote-core'
import type { AssociationEngine, RegistrationEngine } from '@votetorrent/vote-engine/rn'
import type { VoteSigningProducer } from '@votetorrent/workflows/platform'
import { createApprovalContext, generateApprovalToken, writeApprovalTokenFile } from '../src/approval/token.js'
import { classifyAttestationDelta } from '../src/attestation/policy.js'
import { createTokenAttestationProducer } from '../src/attestation/token-attestation-producer.js'
import type { BootedPeer } from '../src/daemon/boot-peer.js'
import { createAuthoritySigner } from '../src/network/authority-user.js'
import type { OfficerVerbContext } from '../src/network/network-verb-support.js'
import authorityIdVerb from '../src/verbs/officer/authority-id.js'
import found from '../src/verbs/officer/found.js'
import { runEnableIntake } from '../src/verbs/officer/enable-intake.js'
import { intakeDepsFor, type IntakeDeps } from '../src/verbs/officer/intake-deps.js'
import { openDeviceVault, type DeviceVault } from '../src/vault/device-vault.js'
import { bootInProcessPeer } from './support/daemon-fixture.js'
import { hostTierEnabled } from './support/host-tier.js'
import { startLoopbackRelay, type LoopbackRelay } from './support/loopback-relay.js'
import { assertNoLeak } from './support/vault-leak-check.js'

type Coded = { name?: unknown, code?: unknown, message?: unknown }
type Mutable = { [k: string]: any }

const STUB_MARKER = 'STUB_SAFETYNET_' + 'ATTESTATION_PLACEHOLDER_NOT_REAL'
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
const VERB_MS_DIR = join(process.env.TMPDIR ?? tmpdir(), '67-27')
const VERB_MS_FILE = join(VERB_MS_DIR, 'verb-ms.txt')
const isoNoMillis = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

describe('officer attestation harness', function () {
  this.timeout(1_800_000)
  let relay: LoopbackRelay
  let runRoot: string
  let party: string
  let booted: BootedPeer
  let ctx: OfficerVerbContext
  let args: Record<string, unknown>
  let sign: (digest: Uint8Array) => Promise<unknown>
  let registrantId: string
  let voterHome: string
  let voterVault: DeviceVault
  let producer: VoteSigningProducer
  let producer2: VoteSigningProducer
  let deviceKey = ''
  let deviceKey2 = ''
  let depsProduction: IntakeDeps
  let depsToken: IntakeDeps
  let failed = false
  const messages: string[] = []
  const msLines: string[] = []
  const secrets: Uint8Array[] = []

  const mark = (s: string): void => {
    messages.push(s)
  }
  const recordMs = (label: string, ms: number): void => {
    const line = `VERB-MS associate ${label} ${ms}`
    msLines.push(line)
    appendFileSync(VERB_MS_FILE, line + '\n', { mode: 0o600 })
    console.log(`      ${line}`)
  }
  const countAssociations = async (deps: IntakeDeps, key?: string): Promise<number> => {
    const { db } = await deps.open()
    const row = key === undefined
      ? await db.prepare('select count(*) as n from Association').get()
      : await db.prepare('select count(*) as n from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey').get({ registrantId, deviceKey: key })
    return Number((row as { n?: unknown } | undefined)?.n ?? 0)
  }
  const rejectedWith = async (p: Promise<unknown>): Promise<Coded> => {
    try {
      await p
    } catch (err) {
      mark(String((err as Coded).message))
      return err as Coded
    }
    throw new Error('expected a rejection')
  }

  before(async function () {
    this.timeout(900_000)
    if (!hostTierEnabled()) this.skip()
    mkdirSync(VERB_MS_DIR, { recursive: true, mode: 0o700 })
    runRoot = mkdtempSync(join(tmpdir(), 'vt-27h-'))
    chmodSync(runRoot, 0o700)
    party = 'vt27-h-' + randomBytes(4).toString('hex')
    const secretsDir = join(runRoot, 'secrets')
    mkdirSync(secretsDir, { mode: 0o700 })
    const officerToken = generateApprovalToken()
    secrets.push(Uint8Array.from(officerToken))
    const tokenFile = join(secretsDir, 'officer.token')
    writeApprovalTokenFile(tokenFile, officerToken)
    relay = await startLoopbackRelay()
    booted = await bootInProcessPeer({ role: 'officer', label: 'officer', party, runRoot, relayEnvPath: relay.relayEnvPath })
    ctx = booted.ctx
    expect(ctx.acceptTokenAttestations).to.equal(false)
    const t0 = Date.now()
    const net = await found(ctx, { name: 'H27 Net', tokenFile })
    console.log(`      found createMs=${String(net.createMs)} wallMs=${Date.now() - t0}`)
    const hash = String(net.networkHash)
    const aid = await authorityIdVerb(ctx, { networkHash: hash })
    args = { network: hash, authority: String(aid.authorityId8) }
    const approval = createApprovalContext({ file: tokenFile })
    sign = createAuthoritySigner(ctx, approval, ctx.user!)
    depsProduction = intakeDepsFor(ctx, { ...args })
    expect(depsProduction.posture.kind).to.equal('production')
    // the registrant payload is sealed to the intake recipients, so the officer enables encrypted intake first
    // (registrant-dev-seed.ts registers the officer encryption key before any registrant): this plan's own verb
    const enabled = await runEnableIntake(depsProduction, { ...args, tokenFile })
    expect(enabled.state).to.equal('enabled')
    console.log(`      enable-intake(in-process) ms=${String(enabled.ms)}`)
    // one registrant, officer-side, exactly as registrant-dev-seed.ts does (synthetic names, no real data)
    const reg = await depsProduction.getEngine<RegistrationEngine>('registration')
    registrantId = 'h27-registrant-' + randomBytes(6).toString('hex')
    const { authorityId } = await depsProduction.open()
    const expiration = isoNoMillis(Date.now() + 365 * 86_400_000)
    const init: RegisterInit = {
      registrant: { id: registrantId, authorityId, expiration },
      public: { firstName: 'Harness', lastName: 'Twentyseven', district: 'D1' },
      private: { expiration, details: [{ name: 'Note', value: 'synthetic' }] }
    }
    await reg.register(init, sign as never)
    const { db } = await depsProduction.open()
    const row = await db.prepare('select Status from Registrant where Id = :id').get({ id: registrantId })
    if (String((row as { Status?: unknown } | undefined)?.Status) !== 'a') await reg.changeStatus(registrantId, 'a', sign as never)
    // the voter device: its own home, its own token, the 67-20 producer
    voterHome = mkdtempSync(join(tmpdir(), 'vt-27hv-'))
    const voterToken = generateApprovalToken()
    secrets.push(Uint8Array.from(voterToken))
    const voterTokenFile = join(voterHome, 'secrets', 'voter.token')
    writeApprovalTokenFile(voterTokenFile, voterToken)
    voterVault = openDeviceVault({ home: voterHome })
    const deviceId = randomBytes(16).toString('hex')
    secrets.push(Buffer.from(deviceId, 'utf8'))
    const voterApproval = createApprovalContext({ file: voterTokenFile })
    producer = createTokenAttestationProducer({ vault: voterVault.vault, token: voterApproval, alias: 'vt.voter.device-key', deviceId })
    producer2 = createTokenAttestationProducer({ vault: voterVault.vault, token: voterApproval, alias: 'vt.voter.device-key-2', deviceId })
    deviceKey = (await producer.provisionDeviceKey()).publicKey
    deviceKey2 = (await producer2.provisionDeviceKey()).publicKey
    secrets.push(Buffer.from(deviceKey, 'utf8'), Buffer.from(deviceKey2, 'utf8'))
    // the token composition over the SAME node: a context view with the flag on
    const tokenCtx: OfficerVerbContext = { ...ctx, acceptTokenAttestations: true, posture: 'test' }
    depsToken = intakeDepsFor(tokenCtx, { ...args })
    expect(depsToken.posture.kind).to.equal('token')
  })

  afterEach(function () {
    if (this.currentTest?.state === 'failed') failed = true
  })

  after(async function () {
    this.timeout(300_000)
    if (booted !== undefined) await booted.close('test-done').catch(() => undefined)
    if (voterVault !== undefined) voterVault.close()
    if (relay !== undefined) await relay.stop()
    if (!failed) {
      if (runRoot !== undefined) rmSync(runRoot, { recursive: true, force: true })
      if (voterHome !== undefined) rmSync(voterHome, { recursive: true, force: true })
    }
    if (relay !== undefined) rmSync(relay.dir, { recursive: true, force: true })
  })

  it('H1 production posture refuses a token attestation: associate rejects, no Association row, one failed verdict, delta token-attestation-refused', async function () {
    this.timeout(600_000)
    const engine = await depsProduction.getEngine<AssociationEngine>('association')
    const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, sign as never)
    secrets.push(Buffer.from(challenge.nonce, 'utf8'))
    const attestation = await producer.produce(challenge)
    const before = depsProduction.attestationCounts()
    const t0 = Date.now()
    const err = await rejectedWith(engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation }, sign as never))
    recordMs('production', Date.now() - t0)
    expect(String(err.message)).to.include('attestation verification failed')
    expect(classifyAttestationDelta(before, depsProduction.attestationCounts())).to.deep.equal(['token-attestation-refused'])
    expect(depsProduction.attestationCounts().token.refused).to.equal(1)
    expect(await countAssociations(depsProduction, deviceKey)).to.equal(0)
    const verdicts = await engine.getAttestationVerdicts(registrantId, deviceKey)
    expect(verdicts).to.have.length(1)
    expect(verdicts[0]!.verdict).to.equal('fail')
    if (verdicts[0]!.reason !== undefined) mark(verdicts[0]!.reason)
  })

  it('H2 token posture over the same node accepts a token attestation and writes exactly one Association row', async function () {
    this.timeout(600_000)
    const engine = await depsToken.getEngine<AssociationEngine>('association')
    const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, sign as never)
    secrets.push(Buffer.from(challenge.nonce, 'utf8'))
    const attestation = await producer.produce(challenge)
    const before = depsToken.attestationCounts()
    const t0 = Date.now()
    await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation }, sign as never)
    recordMs('token', Date.now() - t0)
    const after = depsToken.attestationCounts()
    expect(after.token.accepted - before.token.accepted).to.equal(1)
    expect(classifyAttestationDelta(before, after)).to.deep.equal([])
    expect(await countAssociations(depsToken, deviceKey)).to.equal(1)
    expect(await countAssociations(depsToken)).to.equal(1)
  })

  it('H3 token posture still refuses a non-token attestation through the CLI platform verifier', async function () {
    this.timeout(600_000)
    const engine = await depsToken.getEngine<AssociationEngine>('association')
    const challenge: AttestationChallenge = await engine.issueAttestationChallenge(registrantId, deviceKey2, sign as never)
    secrets.push(Buffer.from(challenge.nonce, 'utf8'))
    const produced = await producer2.produce(challenge)
    const attestation = structuredClone(produced) as DeviceAttestation & Mutable
    const details = attestation.platformDetails as Mutable
    details.safetyNetAttestation = STUB_MARKER
    attestation.certificateChain = [b64(STUB_MARKER + ':throwaway')]
    details.deviceKeyCertificateChain = [b64(STUB_MARKER + ':voting-key')]
    const before = depsToken.attestationCounts()
    const err = await rejectedWith(engine.associate({ registrantId, deviceKey: deviceKey2, nonce: challenge.nonce, attestation }, sign as never))
    expect(String(err.message)).to.include('attestation verification failed')
    expect(classifyAttestationDelta(before, depsToken.attestationCounts())).to.deep.equal(['platform-attestation-refused'])
    expect(await countAssociations(depsToken, deviceKey2)).to.equal(0)
    expect(await countAssociations(depsToken)).to.equal(1)
  })

  it('H4 the token composition cannot be built on the production party: getEngine(association) throws production-party and constructs nothing', async function () {
    this.timeout(60_000)
    const prodCtx: OfficerVerbContext = { ...ctx, partyId: 'votetorrent', acceptTokenAttestations: true, posture: 'test' }
    const deps = intakeDepsFor(prodCtx, { ...args })
    const err = await rejectedWith(deps.getEngine('association'))
    expect(err.name).to.equal('TokenAttestationError')
    expect(err.code).to.equal('production-party')
    expect(deps.attestationCounts()).to.deep.equal({ token: { accepted: 0, refused: 0 }, platform: { accepted: 0, refused: 0 } })
    const again = await rejectedWith(deps.getEngine('registration'))
    expect(again.code).to.equal('production-party')
  })

  it('H5 no message or VERB-MS line carries a token, a nonce or a device key', function () {
    expect(messages.length).to.be.at.least(2)
    expect(msLines.length).to.equal(2)
    assertNoLeak(messages.join('\n') + '\n' + msLines.join('\n'), secrets)
  })
})
