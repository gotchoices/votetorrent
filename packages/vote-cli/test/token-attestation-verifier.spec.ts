// TokenAttestationVerifier: posture refusals, every shape refusal (with the StubAttestationVerifier
// contrast where the delegate alone would accept), the production-verifier refusal in three postures,
// the composer's routing, and the by-construction proof that no app or workflows source names the
// CLI package. Mutations are applied to structuredClone copies of a producer-made pair.

import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { p256 } from '@noble/curves/nist.js'
import { bytesToHex } from '@noble/curves/utils.js'
import {
  LocalConfigKeyProvider,
  PlatformDispatchingAttestationVerifier,
  PlayIntegrityVerifier,
  StubAttestationVerifier
} from '@votetorrent/vote-engine/rn'
import type { AttestationChallenge, AttestationVerification, DeviceAttestation, IAttestationVerifier } from '@votetorrent/vote-core'
import type { VoteSigningProducer } from '@votetorrent/workflows/platform'
import { createApprovalContext, generateApprovalToken, writeApprovalTokenFile } from '../src/approval/token.js'
import { TOKEN_ATTESTATION_MARKER, tokenAttestationChainEntry } from '../src/attestation/marker.js'
import { createTokenAttestationProducer } from '../src/attestation/token-attestation-producer.js'
import {
  TokenAttestationVerifier,
  TokenOrPlatformAttestationVerifier,
  composeOfficerAttestationVerifier
} from '../src/attestation/token-attestation-verifier.js'
import { openDeviceVault, type DeviceVault } from '../src/vault/device-vault.js'
import { assertNoLeak } from './support/vault-leak-check.js'

type Coded = { name?: unknown, code?: unknown, message?: unknown }
type Pair = { challenge: AttestationChallenge, attestation: DeviceAttestation }
type Mutable = { [k: string]: any }

const PARTY = 'vt-run-a'
const STUB_MARKER = 'STUB_SAFETYNET_' + 'ATTESTATION_PLACEHOLDER_NOT_REAL'
const HOST_VOTER_MARKER = 'vt64-host-voter-' + 'synthetic-not-hardware'
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const reasons: string[] = []
const pairSecrets: Uint8Array[] = []
let home: string
let dv: DeviceVault
let producer: VoteSigningProducer
let publicKey: string
let deviceId: string
let verifier: TokenAttestationVerifier

function thrown(fn: () => unknown): Coded {
  try {
    fn()
  } catch (err) {
    return err as Coded
  }
  throw new Error('expected a throw')
}

function expectCoded(err: Coded, name: string, code: string): void {
  expect(err.name).to.equal(name)
  expect(err.code).to.equal(code)
}

async function makePair(): Promise<Pair> {
  const nonce = randomBytes(16).toString('hex')
  const challenge: AttestationChallenge = { nonce, authorityId: 'authority-a', registrantId: randomBytes(8).toString('hex'), deviceKey: publicKey }
  const attestation = await producer.produce(challenge)
  pairSecrets.push(Buffer.from(nonce, 'utf8'), Buffer.from(publicKey, 'utf8'), Buffer.from(deviceId, 'utf8'))
  return { challenge, attestation }
}

function copy(p: Pair): Pair & { att: Mutable, details: Mutable } {
  const c = structuredClone(p)
  const att = c.attestation as Mutable
  return { ...c, att, details: att.platformDetails as Mutable }
}

async function refused(v: IAttestationVerifier, challenge: AttestationChallenge, attestation: DeviceAttestation): Promise<AttestationVerification> {
  const out = await v.verify(challenge, attestation)
  expect(out.ok).to.equal(false)
  expect(typeof out.reason).to.equal('string')
  if (out.reason !== undefined) reasons.push(out.reason)
  return out
}

function otherP256Key(): string {
  return bytesToHex(p256.getPublicKey(p256.utils.randomSecretKey(), true))
}

function productionDispatcher(keysProvisioned: boolean, options: { skipPlayIntegrityHalf?: boolean }): IAttestationVerifier {
  const keys = new LocalConfigKeyProvider({ decryptionKeyBase64: '', verificationKeyBase64: '' })
  const identity = { packageName: 'test.package', certificateSha256Digests: [] as string[] }
  return new PlatformDispatchingAttestationVerifier(new PlayIntegrityVerifier(keys, [], identity, new Set<string>(), keysProvisioned, options))
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

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) walk(path, out)
    else if (/\.(ts|tsx|js)$/.test(name)) out.push(path)
  }
}

describe('token attestation verifier', function () {
  this.timeout(60_000)

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'vt-20-'))
    const token = generateApprovalToken()
    const tokenPath = join(home, 'secrets', 'approval.token')
    writeApprovalTokenFile(tokenPath, token)
    dv = openDeviceVault({ home })
    deviceId = randomBytes(16).toString('hex')
    producer = createTokenAttestationProducer({ vault: dv.vault, token: createApprovalContext({ file: tokenPath }), alias: 'vt.voter.device-key', deviceId })
    publicKey = (await producer.provisionDeviceKey()).publicKey
    verifier = new TokenAttestationVerifier({ acceptTokenAttestations: true, partyId: PARTY })
  })

  after(() => {
    dv.close()
    rmSync(home, { recursive: true, force: true })
  })

  it('1 construction refuses a disabled posture, the production party and a missing party', () => {
    expectCoded(thrown(() => new TokenAttestationVerifier({ acceptTokenAttestations: false, partyId: PARTY })), 'TokenAttestationError', 'not-enabled')
    expectCoded(thrown(() => new TokenAttestationVerifier({ acceptTokenAttestations: undefined as unknown as boolean, partyId: PARTY })), 'TokenAttestationError', 'not-enabled')
    expectCoded(thrown(() => new TokenAttestationVerifier({ acceptTokenAttestations: 'true' as unknown as boolean, partyId: PARTY })), 'TokenAttestationError', 'not-enabled')
    expectCoded(thrown(() => new TokenAttestationVerifier({ acceptTokenAttestations: true, partyId: 'votetorrent' })), 'TokenAttestationError', 'production-party')
    expectCoded(thrown(() => new TokenAttestationVerifier({ acceptTokenAttestations: true, partyId: ' VoteTorrent ' })), 'TokenAttestationError', 'production-party')
    expectCoded(thrown(() => new TokenAttestationVerifier({ acceptTokenAttestations: true, partyId: '' })), 'TokenAttestationError', 'party-missing')
  })

  it('2 a producer-made pair verifies ok', async () => {
    const p = await makePair()
    expect(await verifier.verify(p.challenge, p.attestation)).to.deep.equal({ ok: true })
  })

  it('3 a nonce mismatch is refused', async () => {
    const p = await makePair()
    const other = { ...p.challenge, nonce: randomBytes(16).toString('hex') }
    pairSecrets.push(Buffer.from(other.nonce, 'utf8'))
    await refused(verifier, other, p.attestation)
    const c = copy(p)
    c.details.nonce = c.details.nonce.slice(1) + '0'
    await refused(verifier, p.challenge, c.attestation)
  })

  it('4 an absent platform nonce is refused here but accepted by StubAttestationVerifier alone', async () => {
    const c = copy(await makePair())
    delete c.details.nonce
    await refused(verifier, c.challenge, c.attestation)
    expect(await new StubAttestationVerifier().verify(c.challenge, c.attestation)).to.deep.equal({ ok: true })
    c.details.nonce = ''
    await refused(verifier, c.challenge, c.attestation)
  })

  it('5 the stub placeholder marker is refused here but accepted by StubAttestationVerifier alone', async () => {
    const c = copy(await makePair())
    c.details.safetyNetAttestation = STUB_MARKER
    c.att.certificateChain = [b64(STUB_MARKER + ':throwaway')]
    c.details.deviceKeyCertificateChain = [b64(STUB_MARKER + ':voting-key')]
    const out = await refused(verifier, c.challenge, c.attestation)
    expect(out.reason).to.equal('not a token attestation (marker)')
    expect(await new StubAttestationVerifier().verify(c.challenge, c.attestation)).to.deep.equal({ ok: true })
  })

  it('6 the host-voter marker is refused', async () => {
    const c = copy(await makePair())
    c.details.safetyNetAttestation = HOST_VOTER_MARKER
    c.att.certificateChain = [b64(HOST_VOTER_MARKER + ':throwaway')]
    c.details.deviceKeyCertificateChain = [b64(HOST_VOTER_MARKER + ':voting-key')]
    await refused(verifier, c.challenge, c.attestation)
  })

  it('7 an iOS-typed and an absent platformDetails are refused', async () => {
    const ios = copy(await makePair())
    ios.details.type = 'iOS'
    const out = await refused(verifier, ios.challenge, ios.attestation)
    expect(out.reason).to.equal('not a token attestation (platform)')
    const none = copy(await makePair())
    delete none.att.platformDetails
    await refused(verifier, none.challenge, none.attestation)
  })

  it('8 chain mutations are refused: an extra entry, a wrong suffix, a missing voting-key chain, swapped entries', async () => {
    const extra = copy(await makePair())
    extra.att.certificateChain.push(tokenAttestationChainEntry('fresh'))
    expect((await refused(verifier, extra.challenge, extra.attestation)).reason).to.equal('token attestation chain malformed')
    const suffix = copy(await makePair())
    suffix.details.deviceKeyCertificateChain = [b64(TOKEN_ATTESTATION_MARKER + ':other')]
    await refused(verifier, suffix.challenge, suffix.attestation)
    const missing = copy(await makePair())
    delete missing.details.deviceKeyCertificateChain
    await refused(verifier, missing.challenge, missing.attestation)
    const swapped = copy(await makePair())
    swapped.att.certificateChain = [tokenAttestationChainEntry('deviceKey')]
    swapped.details.deviceKeyCertificateChain = [tokenAttestationChainEntry('fresh')]
    await refused(verifier, swapped.challenge, swapped.attestation)
  })

  it('9 key mutations are refused: swapped publicKey, swapped keystorePublicKey, undecodable challenge key', async () => {
    const pub = copy(await makePair())
    pub.att.publicKey = otherP256Key()
    expect((await refused(verifier, pub.challenge, pub.attestation)).reason).to.equal('attestation key does not match the challenged device key')
    const ks = copy(await makePair())
    ks.details.keystorePublicKey = otherP256Key()
    await refused(verifier, ks.challenge, ks.attestation)
    const p = await makePair()
    await refused(verifier, { ...p.challenge, deviceKey: 'not a key' }, p.attestation)
  })

  it('10 an empty and an absent deviceId are refused', async () => {
    const empty = copy(await makePair())
    empty.att.deviceId = ''
    expect((await refused(verifier, empty.challenge, empty.attestation)).reason).to.equal('attestation carries no device id')
    const absent = copy(await makePair())
    delete absent.att.deviceId
    await refused(verifier, absent.challenge, absent.attestation)
  })

  it('11 never throws: an empty attestation and a throwing platformDetails getter both return ok false', async () => {
    const p = await makePair()
    await refused(verifier, p.challenge, {} as unknown as DeviceAttestation)
    const trap = {
      get platformDetails(): never {
        throw new Error('getter trap')
      }
    } as unknown as DeviceAttestation
    expect((await refused(verifier, p.challenge, trap)).reason).to.equal('token attestation rejected')
    await refused(verifier, { ...p.challenge, nonce: '' }, p.attestation)
    await refused(verifier, undefined as unknown as AttestationChallenge, p.attestation)
  })

  it('12 no refusal reason carries a nonce, a device key or a device id', () => {
    expect(reasons.length).to.be.greaterThan(15)
    for (const reason of reasons) assertNoLeak(reason, pairSecrets)
  })

  it('13 a production-composed platform verifier refuses a valid token pair in three postures', async () => {
    const p = await makePair()
    expect(productionDispatcher(false, {})).to.be.instanceOf(PlatformDispatchingAttestationVerifier)
    const a = await refused(productionDispatcher(false, {}), p.challenge, p.attestation)
    const b = await refused(productionDispatcher(true, {}), p.challenge, p.attestation)
    const c = await refused(productionDispatcher(true, { skipPlayIntegrityHalf: true }), p.challenge, p.attestation)
    expect(a.reason).to.match(/not provisioned/)
    expect(b.reason).to.not.equal(a.reason)
    expect(c.reason).to.match(/chain/)
  })

  it('14 composer disabled returns the platform verifier itself, which refuses a token pair', async () => {
    const platform = productionDispatcher(false, {})
    const composed = composeOfficerAttestationVerifier({ acceptTokenAttestations: false, partyId: 'votetorrent', platformVerifier: platform })
    expect(composed).to.equal(platform)
    const p = await makePair()
    await refused(composed, p.challenge, p.attestation)
    expect(composeOfficerAttestationVerifier({ acceptTokenAttestations: 'true' as unknown as boolean, partyId: PARTY, platformVerifier: platform })).to.equal(platform)
  })

  it('15 composer enabled routes token pairs to the token verifier and everything else to the platform verifier verbatim', async () => {
    const spy = spyVerifier({ ok: true, reason: 'spy saw it' })
    const composed = composeOfficerAttestationVerifier({ acceptTokenAttestations: true, partyId: PARTY, platformVerifier: spy })
    expect(composed).to.be.instanceOf(TokenOrPlatformAttestationVerifier)
    const p = await makePair()
    expect(await composed.verify(p.challenge, p.attestation)).to.deep.equal({ ok: true })
    expect(spy.calls).to.equal(0)
    const c = copy(p)
    c.details.safetyNetAttestation = STUB_MARKER
    expect(await composed.verify(c.challenge, c.attestation)).to.deep.equal({ ok: true, reason: 'spy saw it' })
    expect(spy.calls).to.equal(1)
    const ios = copy(p)
    ios.details.type = 'iOS'
    await composed.verify(ios.challenge, ios.attestation)
    expect(spy.calls).to.equal(2)
  })

  it('16 composer enabled on the production party throws production-party', () => {
    const platform = spyVerifier({ ok: false, reason: 'unused' })
    expectCoded(thrown(() => composeOfficerAttestationVerifier({ acceptTokenAttestations: true, partyId: 'votetorrent', platformVerifier: platform })), 'TokenAttestationError', 'production-party')
    expectCoded(thrown(() => composeOfficerAttestationVerifier({ acceptTokenAttestations: true, partyId: '', platformVerifier: platform })), 'TokenAttestationError', 'party-missing')
    expect(platform.calls).to.equal(0)
  })

  it('17 fail-closed by construction: no app or workflows source names the CLI package', () => {
    const roots = ['apps/VoteTorrentAuthority/src', 'apps/VoteTorrentVoter/src', 'packages/workflows/src'].map((r) => join(REPO_ROOT, r))
    const files: string[] = []
    for (const root of roots) walk(root, files)
    expect(files.length).to.be.greaterThan(100)
    const offenders = files.filter((f) => /@votetorrent\/vote-cli|packages\/vote-cli\//.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => f.slice(REPO_ROOT.length))).to.deep.equal([])
  })
})
