// The token-attested association producer: shape, nonce echo, token refusals, key continuity and
// K_vote signature validity under the schema's SQL verifier, plus the marker identity and the officer
// posture rule. Nonces, registrant ids and device ids are random per case; no secret literal appears.

import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { p256 } from '@noble/curves/nist.js'
import { bytesToHex } from '@noble/curves/utils.js'
import { StubAttestationVerifier, p256KeyToCompressedHex, verifySigP256 } from '@votetorrent/vote-engine/rn'
import type { AttestationChallenge, DeviceAttestation } from '@votetorrent/vote-core'
import type { VoteSigningProducer } from '@votetorrent/workflows/platform'
import { NO_APPROVAL, createApprovalContext, generateApprovalToken, writeApprovalTokenFile, type ApprovalContext } from '../src/approval/token.js'
import { provisionTokenSigningKey } from '../src/approval/signer.js'
import {
  PRODUCTION_PARTY_ID,
  TOKEN_ATTESTATION_CHAIN_SUFFIX,
  TOKEN_ATTESTATION_MARKER,
  assertTokenAttestationPosture,
  isTokenAttestation,
  tokenAttestationChainEntry
} from '../src/attestation/marker.js'
import { createTokenAttestationProducer } from '../src/attestation/token-attestation-producer.js'
import { openDeviceVault, type DeviceVault } from '../src/vault/device-vault.js'
import { digestText, schemaSignatureValid } from './support/schema-signature.js'
import { assertNoLeak } from './support/vault-leak-check.js'

type Coded = { name?: unknown, code?: unknown, message?: unknown }

interface CountingContext extends ApprovalContext {
  readonly calls: number
}

function counting(inner: ApprovalContext): CountingContext {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    token() {
      calls++
      return inner.token()
    }
  }
}

async function rejection(p: Promise<unknown>): Promise<Coded> {
  try {
    await p
  } catch (err) {
    caught.push(err)
    return err as Coded
  }
  throw new Error('expected a rejection')
}

function thrown(fn: () => unknown): Coded {
  try {
    fn()
  } catch (err) {
    caught.push(err)
    return err as Coded
  }
  throw new Error('expected a throw')
}

function expectCoded(err: Coded, name: string, code: string): void {
  expect(err.name).to.equal(name)
  expect(err.code).to.equal(code)
}

function hexId(bytes = 16): string {
  const id = randomBytes(bytes).toString('hex')
  sensitive.push(Buffer.from(id, 'utf8'))
  return id
}

function challengeFor(deviceKey: string, nonce = hexId()): AttestationChallenge {
  return { nonce, authorityId: `authority-${hexId(4)}`, registrantId: hexId(), deviceKey }
}

function otherP256Key(): string {
  return bytesToHex(p256.getPublicKey(p256.utils.randomSecretKey(), true))
}

const ALIAS = 'vt.voter.device-key'
const RESULT_KEYS = ['publicKey', 'deviceId', 'attestationTime', 'certificateChain', 'platformDetails']
const DETAIL_KEYS = ['type', 'safetyNetAttestation', 'keystorePublicKey', 'nonce', 'deviceKeyCertificateChain']

const caught: unknown[] = []
const sensitive: Uint8Array[] = []
const attestations: DeviceAttestation[] = []

let home: string
let dv: DeviceVault
let goodToken: Uint8Array
let wrongToken: Uint8Array
let good: CountingContext
let wrong: CountingContext
let deviceId: string

describe('token attestation producer', function () {
  this.timeout(30_000)

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'vt-20-'))
    goodToken = generateApprovalToken()
    wrongToken = generateApprovalToken()
    sensitive.push(goodToken, wrongToken)
    const goodPath = join(home, 'secrets', 'approval.token')
    const wrongPath = join(home, 'secrets', 'wrong.token')
    writeApprovalTokenFile(goodPath, goodToken)
    writeApprovalTokenFile(wrongPath, wrongToken)
    good = counting(createApprovalContext({ file: goodPath }))
    wrong = counting(createApprovalContext({ file: wrongPath }))
    deviceId = hexId()
    dv = openDeviceVault({ home })
  })

  afterEach(() => {
    dv.close()
    rmSync(home, { recursive: true, force: true })
  })

  function producer(token: ApprovalContext, extra: { now?: () => number, alias?: string } = {}): VoteSigningProducer {
    return createTokenAttestationProducer({ vault: dv.vault, token, alias: extra.alias ?? ALIAS, deviceId, now: extra.now })
  }

  it('1 provisionDeviceKey returns a canonical compressed P-256 key and a second call returns it with no token read', async () => {
    const p = producer(good)
    const { publicKey } = await p.provisionDeviceKey()
    expect(publicKey.length).to.equal(66)
    expect(p256KeyToCompressedHex(publicKey)).to.equal(publicKey)
    const calls = good.calls
    const prompts = dv.vault.authPromptCount
    const again = await p.provisionDeviceKey()
    expect(again.publicKey).to.equal(publicKey)
    expect(good.calls).to.equal(calls)
    expect(dv.vault.authPromptCount).to.equal(prompts)
  })

  it('2 on a fresh home NO_APPROVAL provisioning rejects token-refused and the device key stays absent', async () => {
    const p = producer(NO_APPROVAL)
    expectCoded(await rejection(p.provisionDeviceKey()), 'TokenSignerError', 'token-refused')
    expectCoded(await rejection(p.getCurrentDeviceKey()), 'TokenAttestationError', 'DEVICE_KEY_ABSENT')
  })

  it('3 once the vault is bound to the good token, a producer with the wrong token cannot provision', async () => {
    await provisionTokenSigningKey({ vault: dv.vault, token: good, curve: 'secp256k1', alias: 'vt.voter.identity' })
    const p = producer(wrong)
    expectCoded(await rejection(p.provisionDeviceKey()), 'TokenSignerError', 'token-refused')
    expect(wrong.calls).to.equal(1)
    expectCoded(await rejection(p.getCurrentDeviceKey()), 'TokenAttestationError', 'DEVICE_KEY_ABSENT')
  })

  it('4 getCurrentDeviceKey reads no token and moves no counter', async () => {
    const { publicKey } = await producer(good).provisionDeviceKey()
    const calls = good.calls
    const prompts = dv.vault.authPromptCount
    const current = await producer(NO_APPROVAL).getCurrentDeviceKey()
    expect(current.publicKey).to.equal(publicKey)
    expect(good.calls).to.equal(calls)
    expect(dv.vault.authPromptCount).to.equal(prompts)
  })

  it('5 a missing private half reads DEVICE_KEY_INVALIDATED and a following provision mints a different key', async () => {
    const p = producer(good)
    const { publicKey } = await p.provisionDeviceKey()
    expect(await dv.vault.deleteSecret(ALIAS)).to.equal(true)
    expectCoded(await rejection(p.getCurrentDeviceKey()), 'TokenAttestationError', 'DEVICE_KEY_INVALIDATED')
    const fresh = await p.provisionDeviceKey()
    expect(fresh.publicKey).to.match(/^(02|03)[0-9a-f]{64}$/)
    expect(fresh.publicKey).to.not.equal(publicKey)
    expect((await p.getCurrentDeviceKey()).publicKey).to.equal(fresh.publicKey)
  })

  it('6 produce returns exactly the host-voter Android shape with the echoed nonce and the marker', async () => {
    const fixedNow = 1_700_000_000_000
    const p = producer(good, { now: () => fixedNow })
    const { publicKey } = await p.provisionDeviceKey()
    const challenge = challengeFor(publicKey)
    const att = await p.produce(challenge)
    attestations.push(att)
    expect(Object.keys(att)).to.deep.equal(RESULT_KEYS)
    expect(att.publicKey).to.equal(challenge.deviceKey)
    expect(att.deviceId).to.equal(deviceId)
    expect(att.attestationTime).to.equal(fixedNow)
    expect(att.certificateChain).to.deep.equal([tokenAttestationChainEntry('fresh')])
    const details = att.platformDetails
    expect(details?.type).to.equal('Android')
    if (details?.type !== 'Android') return
    expect(Object.keys(details)).to.deep.equal(DETAIL_KEYS)
    expect(details.safetyNetAttestation).to.equal(TOKEN_ATTESTATION_MARKER)
    expect(details.keystorePublicKey).to.equal(publicKey)
    expect(details.nonce).to.equal(challenge.nonce)
    expect(details.deviceKeyCertificateChain).to.deep.equal([tokenAttestationChainEntry('deviceKey')])
  })

  it('7 a produced attestation passes StubAttestationVerifier for its challenge', async () => {
    const p = producer(good)
    const { publicKey } = await p.provisionDeviceKey()
    const challenge = challengeFor(publicKey)
    const att = await p.produce(challenge)
    attestations.push(att)
    expect(await new StubAttestationVerifier().verify(challenge, att)).to.deep.equal({ ok: true })
    expect(await new StubAttestationVerifier().verify(challengeFor(publicKey), att)).to.have.property('ok', false)
  })

  it('8 produce under NO_APPROVAL and under the wrong token rejects token-refused', async () => {
    const { publicKey } = await producer(good).provisionDeviceKey()
    expectCoded(await rejection(producer(NO_APPROVAL).produce(challengeFor(publicKey))), 'TokenSignerError', 'token-refused')
    expectCoded(await rejection(producer(wrong).produce(challengeFor(publicKey))), 'TokenSignerError', 'token-refused')
  })

  it('9 produce refuses a challenge for another key, an undecodable key and an empty nonce, with no token read', async () => {
    const p = producer(good)
    await p.provisionDeviceKey()
    const calls = good.calls
    expectCoded(await rejection(p.produce(challengeFor(otherP256Key()))), 'TokenAttestationError', 'device-key-mismatch')
    expectCoded(await rejection(p.produce(challengeFor('not a key'))), 'TokenAttestationError', 'device-key-mismatch')
    const { publicKey } = await p.getCurrentDeviceKey()
    expectCoded(await rejection(p.produce(challengeFor(publicKey, ''))), 'TokenAttestationError', 'invalid-challenge')
    expect(good.calls).to.equal(calls)
  })

  it('10 signDeviceKeyDigest signs under the current key and verifies under SQL SignatureValidP256', async () => {
    const p = producer(good)
    const { publicKey } = await p.provisionDeviceKey()
    const d = Uint8Array.from(randomBytes(32))
    sensitive.push(d)
    const out = await p.signDeviceKeyDigest(d)
    expect(out.signerUserId).to.equal('')
    expect(out.signerKey).to.equal(publicKey)
    expect(await schemaSignatureValid('p256', d, out.signature, publicKey)).to.equal(true)
    expect(verifySigP256(digestText(d), out.signature, publicKey)).to.equal(true)
  })

  it('11 an already-aborted signal rejects AbortError/ABORTED before any token read', async () => {
    const p = producer(good)
    await p.provisionDeviceKey()
    const calls = good.calls
    const ac = new AbortController()
    ac.abort()
    const err = await rejection(p.signDeviceKeyDigest(Uint8Array.from(randomBytes(32)), { signal: ac.signal }))
    expect(err.name).to.equal('AbortError')
    expect(err.code).to.equal('ABORTED')
    expect(good.calls).to.equal(calls)
  })

  it('12 signDeviceKeyDigest under NO_APPROVAL and under the wrong token rejects token-refused', async () => {
    await producer(good).provisionDeviceKey()
    const d = Uint8Array.from(randomBytes(32))
    sensitive.push(d)
    expectCoded(await rejection(producer(NO_APPROVAL).signDeviceKeyDigest(d)), 'TokenSignerError', 'token-refused')
    expectCoded(await rejection(producer(wrong).signDeviceKeyDigest(d)), 'TokenSignerError', 'token-refused')
  })

  it('13 the producer is a VoteSigningProducer at compile time', () => {
    const p: VoteSigningProducer = createTokenAttestationProducer({ vault: dv.vault, token: good, alias: ALIAS, deviceId })
    expect(typeof p.signDeviceKeyDigest).to.equal('function')
    expect(typeof p.getCurrentDeviceKey).to.equal('function')
  })

  it('14 the marker is its two fragments, distinct from the stub and host-voter markers, and the chain entries decode to it', () => {
    expect(TOKEN_ATTESTATION_MARKER).to.equal('vt-cli-token-' + 'attestation-v1')
    expect(TOKEN_ATTESTATION_MARKER).to.not.equal('STUB_SAFETYNET_' + 'ATTESTATION_PLACEHOLDER_NOT_REAL')
    expect(TOKEN_ATTESTATION_MARKER).to.not.equal('vt64-host-voter-' + 'synthetic-not-hardware')
    expect(TOKEN_ATTESTATION_CHAIN_SUFFIX).to.deep.equal({ fresh: ':throwaway', deviceKey: ':voting-key' })
    expect(Buffer.from(tokenAttestationChainEntry('fresh'), 'base64').toString('utf8')).to.equal(`${TOKEN_ATTESTATION_MARKER}:throwaway`)
    expect(Buffer.from(tokenAttestationChainEntry('deviceKey'), 'base64').toString('utf8')).to.equal(`${TOKEN_ATTESTATION_MARKER}:voting-key`)
    expect(PRODUCTION_PARTY_ID).to.equal('votetorrent')
  })

  it('15 assertTokenAttestationPosture refuses unless strictly enabled, with a party, off the production party', () => {
    const party = 'vt-run-a'
    expectCoded(thrown(() => assertTokenAttestationPosture({ acceptTokenAttestations: false, partyId: party })), 'TokenAttestationError', 'not-enabled')
    expectCoded(thrown(() => assertTokenAttestationPosture({ acceptTokenAttestations: undefined as unknown as boolean, partyId: party })), 'TokenAttestationError', 'not-enabled')
    expectCoded(thrown(() => assertTokenAttestationPosture({ acceptTokenAttestations: 'true' as unknown as boolean, partyId: party })), 'TokenAttestationError', 'not-enabled')
    expectCoded(thrown(() => assertTokenAttestationPosture({ acceptTokenAttestations: true, partyId: '' })), 'TokenAttestationError', 'party-missing')
    expectCoded(thrown(() => assertTokenAttestationPosture({ acceptTokenAttestations: true, partyId: 'votetorrent' })), 'TokenAttestationError', 'production-party')
    expectCoded(thrown(() => assertTokenAttestationPosture({ acceptTokenAttestations: true, partyId: ' VoteTorrent ' })), 'TokenAttestationError', 'production-party')
    expect(assertTokenAttestationPosture({ acceptTokenAttestations: true, partyId: party })).to.equal(undefined)
  })

  it('16 isTokenAttestation routes on the marker only and never throws', async () => {
    const p = producer(good)
    const { publicKey } = await p.provisionDeviceKey()
    const att = await p.produce(challengeFor(publicKey))
    attestations.push(att)
    expect(isTokenAttestation(att)).to.equal(true)
    expect(isTokenAttestation({})).to.equal(false)
    expect(isTokenAttestation(undefined)).to.equal(false)
    expect(isTokenAttestation(null)).to.equal(false)
    expect(isTokenAttestation({ platformDetails: { type: 'iOS', safetyNetAttestation: TOKEN_ATTESTATION_MARKER } })).to.equal(false)
    expect(isTokenAttestation({ platformDetails: { type: 'Android', safetyNetAttestation: 'STUB_SAFETYNET_' + 'ATTESTATION_PLACEHOLDER_NOT_REAL' } })).to.equal(false)
    const throwing = {
      get platformDetails(): never {
        throw new Error('getter trap')
      }
    }
    expect(isTokenAttestation(throwing)).to.equal(false)
  })

  it('17 construction refuses an empty and an over-long deviceId', () => {
    const base = { vault: dv.vault, token: good, alias: ALIAS }
    expectCoded(thrown(() => createTokenAttestationProducer({ ...base, deviceId: '' })), 'TokenAttestationError', 'invalid-device-id')
    expectCoded(thrown(() => createTokenAttestationProducer({ ...base, deviceId: 'd'.repeat(129) })), 'TokenAttestationError', 'invalid-device-id')
    expect(() => createTokenAttestationProducer({ ...base, deviceId: 'd'.repeat(128) })).to.not.throw()
    expectCoded(thrown(() => createTokenAttestationProducer({ ...base, alias: 'bad alias', deviceId })), 'TokenSignerError', 'invalid-alias')
  })

  it('18 attestations carry no token and no caught error carries a token, nonce, digest or device id', () => {
    expect(attestations.length).to.be.greaterThan(2)
    for (const att of attestations) assertNoLeak(JSON.stringify(att), [goodToken, wrongToken])
    expect(caught.length).to.be.greaterThan(10)
    for (const err of caught) {
      const e = err as Coded
      assertNoLeak(`${String(e.name)} ${String(e.message)} ${JSON.stringify(err)}`, sensitive)
      if (e.name === 'TokenAttestationError') expect(String(e.message)).to.match(/^token attestation refused \([A-Za-z_-]+\)$/)
    }
  })
})
