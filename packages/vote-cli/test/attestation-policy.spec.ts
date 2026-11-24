// attestation-policy.spec.ts (67-27 Task 1): the officer posture, the counting composition over 67-20's
// composer, the AttestationRequired row read and guard, the delta classification, and the intake context
// adapter (engine map per context, argument gates, the per-call approval seam). Fakes only; token
// attestations come from the real 67-20 producer over a temp device vault; nothing here prints a token,
// a nonce or a key.

import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hexToBytes } from '@noble/curves/utils.js'
import type { AttestationChallenge, AttestationVerification, DeviceAttestation, IAttestationVerifier } from '@votetorrent/vote-core'
import type { VoteSigningProducer } from '@votetorrent/workflows/platform'
import { createApprovalContext, generateApprovalToken, writeApprovalTokenFile } from '../src/approval/token.js'
import { createTokenAttestationProducer } from '../src/attestation/token-attestation-producer.js'
import {
  ATTESTATION_REFUSAL_CODES,
  assertTokenPostureVerifies,
  buildOfficerAssociationVerifier,
  classifyAttestationDelta,
  createCliPlatformVerifier,
  officerAttestationPosture,
  readAttestationRows,
  type AttestationPolicyDb,
  type OfficerAttestationPosture
} from '../src/attestation/policy.js'
import { AUTHORITY_SIGNING_ALIAS, ensureAuthorityUser } from '../src/network/authority-user.js'
import {
  INTAKE_REFUSAL_CODES,
  assertIntakeTestParty,
  intakeDepsFor,
  pickIntakeArgs,
  withIntakeApproval
} from '../src/verbs/officer/intake-deps.js'
import { openDeviceVault, type DeviceVault } from '../src/vault/device-vault.js'
import { makeFakeOfficerCtx, type FakeOfficerCtx } from './support/fake-officer-ctx.js'
import { assertNoLeak } from './support/vault-leak-check.js'

type Coded = { name?: unknown, code?: unknown, message?: unknown }
type Pair = { challenge: AttestationChallenge, attestation: DeviceAttestation }

const PARTY = 'vt-27-a'
const STUB_MARKER = 'STUB_SAFETYNET_' + 'ATTESTATION_PLACEHOLDER_NOT_REAL'
const HASH = randomBytes(16).toString('hex')
const AID8 = randomBytes(4).toString('hex')

const messages: string[] = []
const secrets: Uint8Array[] = []

function thrown(fn: () => unknown): Coded {
  try {
    fn()
  } catch (err) {
    messages.push(String((err as Coded).message))
    return err as Coded
  }
  throw new Error('expected a throw')
}

async function rejected(p: Promise<unknown>): Promise<Coded> {
  try {
    await p
  } catch (err) {
    messages.push(String((err as Coded).message))
    return err as Coded
  }
  throw new Error('expected a rejection')
}

function spyVerifier(result: AttestationVerification): IAttestationVerifier & { calls: number } {
  const spy = {
    calls: 0,
    async verify(): Promise<AttestationVerification> {
      spy.calls++
      return result
    }
  }
  return spy
}

const production: OfficerAttestationPosture = Object.freeze({ kind: 'production', partyId: PARTY })
const token: OfficerAttestationPosture = Object.freeze({ kind: 'token', partyId: PARTY })

describe('attestation policy', function () {
  this.timeout(60_000)
  let home: string
  let dv: DeviceVault
  let producer: VoteSigningProducer
  let publicKey: string
  const homes: FakeOfficerCtx[] = []

  async function makePair(): Promise<Pair> {
    const nonce = randomBytes(16).toString('hex')
    const challenge: AttestationChallenge = { nonce, authorityId: 'authority-a', registrantId: randomBytes(8).toString('hex'), deviceKey: publicKey }
    const attestation = await producer.produce(challenge)
    secrets.push(Buffer.from(nonce, 'utf8'), Buffer.from(publicKey, 'utf8'))
    return { challenge, attestation }
  }

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'vt-27p-'))
    const tokenBytes = generateApprovalToken()
    secrets.push(Uint8Array.from(tokenBytes))
    const tokenPath = join(home, 'secrets', 'voter.token')
    writeApprovalTokenFile(tokenPath, tokenBytes)
    dv = openDeviceVault({ home })
    const deviceId = randomBytes(16).toString('hex')
    secrets.push(Buffer.from(deviceId, 'utf8'))
    producer = createTokenAttestationProducer({ vault: dv.vault, token: createApprovalContext({ file: tokenPath }), alias: 'vt.voter.device-key', deviceId })
    publicKey = (await producer.provisionDeviceKey()).publicKey
  })

  after(() => {
    dv.close()
    for (const h of homes) h.close()
    rmSync(home, { recursive: true, force: true })
  })

  it('P1 posture: strictly true on a test party is token; anything else is production; votetorrent and an empty party are refused', () => {
    expect(officerAttestationPosture({ acceptTokenAttestations: true, partyId: PARTY })).to.deep.equal({ kind: 'token', partyId: PARTY })
    expect(Object.isFrozen(officerAttestationPosture({ acceptTokenAttestations: true, partyId: PARTY }))).to.equal(true)
    for (const flag of [false, undefined, 'true']) {
      expect(officerAttestationPosture({ acceptTokenAttestations: flag, partyId: PARTY })).to.deep.equal({ kind: 'production', partyId: PARTY })
    }
    for (const party of ['votetorrent', ' VoteTorrent ']) {
      const err = thrown(() => officerAttestationPosture({ acceptTokenAttestations: true, partyId: party }))
      expect(err.name).to.equal('TokenAttestationError')
      expect(err.code).to.equal('production-party')
    }
    const missing = thrown(() => officerAttestationPosture({ acceptTokenAttestations: true, partyId: '' }))
    expect(missing.code).to.equal('party-missing')
    expect(officerAttestationPosture({ acceptTokenAttestations: false, partyId: 'votetorrent' }).kind).to.equal('production')
  })

  it('P2 the production composition refuses a producer-made token attestation and counts it', async () => {
    const built = buildOfficerAssociationVerifier({ posture: production })
    const p = await makePair()
    const before = built.counts()
    const out = await built.verifier.verify(p.challenge, p.attestation)
    expect(out.ok).to.equal(false)
    expect(built.counts().token.refused).to.equal(1)
    expect(built.counts().token.accepted).to.equal(0)
    expect(classifyAttestationDelta(before, built.counts())).to.deep.equal(['token-attestation-refused'])
    if (out.reason !== undefined) messages.push(out.reason)
  })

  it('P3 the token composition accepts the pair, and the CLI platform verifier refuses a non-token Android attestation', async () => {
    const built = buildOfficerAssociationVerifier({ posture: token })
    const p = await makePair()
    const out = await built.verifier.verify(p.challenge, p.attestation)
    expect(out.ok).to.equal(true)
    expect(built.counts().token.accepted).to.equal(1)
    const c = structuredClone(p)
    const details = c.attestation.platformDetails as { safetyNetAttestation?: string }
    details.safetyNetAttestation = STUB_MARKER
    const before = built.counts()
    const refusedOut = await built.verifier.verify(c.challenge, c.attestation)
    expect(refusedOut.ok).to.equal(false)
    expect(built.counts().platform.refused).to.equal(1)
    expect(classifyAttestationDelta(before, built.counts())).to.deep.equal(['platform-attestation-refused'])
    // the bare CLI platform verifier refuses the token pair too (keysProvisioned false, no iOS verifier)
    const bare = await createCliPlatformVerifier().verify(p.challenge, p.attestation)
    expect(bare.ok).to.equal(false)
    const ios = structuredClone(p)
    ;(ios.attestation.platformDetails as { type: string }).type = 'iOS'
    expect((await createCliPlatformVerifier().verify(ios.challenge, ios.attestation)).ok).to.equal(false)
    for (const r of [refusedOut.reason, bare.reason]) if (r !== undefined) messages.push(r)
  })

  it('P4 verbatim: the returned object is the spy platform verifier\'s own result', async () => {
    const result: AttestationVerification = { ok: true, reason: 'spy saw it' }
    const spy = spyVerifier(result)
    const built = buildOfficerAssociationVerifier({ posture: production, platformVerifier: spy })
    const p = await makePair()
    const out = await built.verifier.verify(p.challenge, p.attestation)
    expect(out).to.equal(result)
    expect(spy.calls).to.equal(1)
    expect(built.counts().token.accepted).to.equal(1)
  })

  it('P5 a rejecting inner verifier propagates and the counts stay zero', async () => {
    const boom = { async verify(): Promise<AttestationVerification> { throw Object.assign(new Error('inner boom'), { code: 'boom' }) } }
    const built = buildOfficerAssociationVerifier({ posture: production, platformVerifier: boom })
    const p = await makePair()
    const err = await rejected(built.verifier.verify(p.challenge, p.attestation))
    expect(err.code).to.equal('boom')
    expect(built.counts()).to.deep.equal({ token: { accepted: 0, refused: 0 }, platform: { accepted: 0, refused: 0 } })
  })

  it('P6 rows: 0, "0" and null count as skipping (the engine predicate, Number(x) === 0), and the bind params are exactly { authorityId }', async () => {
    const bound: unknown[] = []
    const sqls: string[] = []
    const db: AttestationPolicyDb = {
      prepare(sql: string) {
        sqls.push(sql)
        return {
          all(params?: Record<string, unknown>) {
            bound.push(params)
            return [{ electionId: 'e1', required: 1 }, { electionId: 'e2', required: 0 }, { electionId: 'e3', required: '0' }, { electionId: 'e4', required: 2 }, { electionId: 'e5', required: null }]
          }
        }
      }
    }
    const rows = await readAttestationRows(db, 'auth-full-id')
    // null reads as skipping because association-engine.ts skips the verifier when Number(AttestationRequired) !== 0 is false
    expect(rows).to.deep.equal({ elections: 5, skipping: 3 })
    expect(bound).to.deep.equal([{ authorityId: 'auth-full-id' }])
    expect(sqls).to.have.length(1)
    const binds = [...new Set(sqls[0]!.match(/:[a-zA-Z]+/g))]
    expect(binds).to.deep.equal([':authorityId'])
  })

  it('P7 guard: token posture with a skipping row refuses policy-skips-verification; production returns', () => {
    const err = thrown(() => assertTokenPostureVerifies(token, { elections: 1, skipping: 1 }))
    expect(err.name).to.equal('AttestationPolicyError')
    expect(err.code).to.equal('policy-skips-verification')
    expect(err.message).to.equal('attestation policy refused (policy-skips-verification)')
    expect(assertTokenPostureVerifies(production, { elections: 1, skipping: 1 })).to.equal(undefined)
    expect(assertTokenPostureVerifies(token, { elections: 3, skipping: 0 })).to.equal(undefined)
    expect([...ATTESTATION_REFUSAL_CODES]).to.deep.equal(['token-attestation-refused', 'platform-attestation-refused', 'policy-skips-verification'])
  })

  it('P8 counts are a frozen copy: mutating one does not change the next', async () => {
    const built = buildOfficerAssociationVerifier({ posture: token })
    const p = await makePair()
    await built.verifier.verify(p.challenge, p.attestation)
    const a = built.counts() as { token: { accepted: number } }
    expect(Object.isFrozen(a)).to.equal(true)
    expect(() => { a.token.accepted = 99 }).to.throw()
    expect(built.counts().token.accepted).to.equal(1)
    expect(built.counts()).to.not.equal(a)
  })

  it('P9 secrecy: no error message, refusal reason or counts JSON carries the token, the nonce or the device key', async () => {
    const built = buildOfficerAssociationVerifier({ posture: production })
    const p = await makePair()
    await built.verifier.verify(p.challenge, p.attestation)
    const text = messages.join('\n') + '\n' + JSON.stringify(built.counts())
    expect(messages.length).to.be.at.least(5)
    assertNoLeak(text, secrets)
  })

  it('P10 adapter: engine map per context, unknown-engine, bad-arg, the party gate and the per-call approval seam', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vt-27d-'))
    const ctxA = makeFakeOfficerCtx({ partyId: PARTY, home: join(root, 'a') })
    const ctxB = makeFakeOfficerCtx({ partyId: PARTY, home: join(root, 'b') })
    homes.push(ctxA, ctxB)
    const args = { network: HASH, authority: AID8 }
    const depsA1 = intakeDepsFor(ctxA, { ...args })
    const depsA2 = intakeDepsFor(ctxA, { ...args })
    const depsB = intakeDepsFor(ctxB, { ...args })
    expect(depsA1.getEngine).to.equal(depsA2.getEngine)
    expect(depsA1.getEngine).to.not.equal(depsB.getEngine)
    expect(depsA1.posture).to.deep.equal({ kind: 'production', partyId: PARTY })
    const unknown = await rejected(depsA1.getEngine('nope'))
    expect(unknown.name).to.equal('VerbRefusal')
    expect(unknown.code).to.equal('unknown-engine')
    expect(ctxA.touches()).to.equal(0)

    const bad = thrown(() => pickIntakeArgs({ authority: AID8, extra: '1' }, ['authority']))
    expect(bad.code).to.equal('bad-arg')
    expect(bad.message).to.equal('intake verb refused (bad-arg)')
    expect(pickIntakeArgs({ authority: AID8, peer: 'x', detail: true }, ['authority', 'detail'])).to.deep.equal({ authority: AID8, detail: true })
    for (const party of ['votetorrent', ' VoteTorrent ']) expect(thrown(() => assertIntakeTestParty(party)).code).to.equal('production-party')
    expect(thrown(() => assertIntakeTestParty('')).code).to.equal('party-missing')
    expect(assertIntakeTestParty(PARTY)).to.equal(undefined)
    expect(INTAKE_REFUSAL_CODES).to.include.members(['bad-arg', 'production-party', 'checklist-incomplete', 'blocked', 'policy-skips-verification', 'token-refused'])

    // the approval seam: provision the officer key under the right token (67-24's ensureAuthorityUser)
    const rightPath = join(ctxA.secretsDir, 'officer.token')
    const wrongPath = join(ctxA.secretsDir, 'wrong.token')
    const right = generateApprovalToken()
    const wrong = generateApprovalToken()
    secrets.push(Uint8Array.from(right), Uint8Array.from(wrong))
    writeApprovalTokenFile(rightPath, right)
    writeApprovalTokenFile(wrongPath, wrong)
    const user = await ensureAuthorityUser(ctxA, createApprovalContext({ file: rightPath }), { name: 'vt officer' })
    expect(await ctxA.device.vault.hasSecret(AUTHORITY_SIGNING_ALIAS)).to.equal(true)
    let runs = 0
    const fn = async (): Promise<string> => {
      runs++
      return 'ran'
    }
    const absent = await rejected(withIntakeApproval(depsA1, { ...args }, fn))
    expect(absent.name).to.equal('ApprovalRefusal')
    expect(absent.code).to.equal('token-absent')
    const refused = await rejected(withIntakeApproval(depsA1, { ...args, tokenFile: wrongPath }, fn))
    expect(refused.name).to.equal('VerbRefusal')
    expect(refused.code).to.equal('token-refused')
    expect(refused.message).to.equal('intake verb refused (token-refused)')
    expect(runs).to.equal(0)
    const digest = randomBytes(32)
    const sig = await withIntakeApproval(depsA1, { ...args, tokenFile: rightPath }, async ({ sign }) => sign(digest))
    expect(sig.signerUserId).to.equal(user.id)
    expect(sig.signerKey).to.equal(user.activeKeys[0]!.key)
    expect(secp256k1.verify(hexToBytes(sig.signature), digest, hexToBytes(sig.signerKey))).to.equal(true)
    expect(ctxA.touches()).to.equal(0)
    assertNoLeak(messages.join('\n') + JSON.stringify(depsA1.attestationCounts()), secrets)
    rmSync(root, { recursive: true, force: true })
  })
})
