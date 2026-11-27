/**
 * ios-hardware-attestation-paid-team.spec.ts — the COMMITTED App ID against REAL App Attest bytes.
 *
 * `ios-hardware-attestation.spec.ts` replays an attestation an iPhone produced under the free
 * personal team `94TY7UR2W5`. That recording stays as it is. But once `APPLE_APP_ID` moved to the
 * paid team `6849Q7KVP5` (2026-09-01), no gate in the repo could catch a wrong team id: the release
 * gate checks "not the personal value", the provisioned test checks shape, and the hardware spec
 * pins the OLD team by design. A well-formed typo would reject every genuine iPhone with
 * "attestation is for a different app" (todo 2026-09-01-ios-appattest-paid-team-device-proof).
 *
 * This file closes that. Its fixture is the verbatim output of the SHIPPING producer —
 * `createRealAttestationProducer().produce(challenge)` — run on an iPhone 13 on 2026-10-08, in a
 * Voter debug build signed by team `6849Q7KVP5` (development App Attest environment). The challenge
 * was minted on the device; `produceIos` consumes only `nonce` and `deviceKey`, so this is the same
 * input `issueAttestationChallenge` would give it (spike 085, leg 9).
 *
 * Two recordings under two teams are stronger together than either alone: each verifies under its
 * own App ID and is REFUSED under the other's, so the App ID binding is enforced, not incidental.
 */
import 'reflect-metadata'
import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cborDecode, type CborValue } from '@votetorrent/vote-core'
import { AppAttestVerifier } from '../src/association/app-attest-verifier.js'
import { APPLE_APP_ATTEST_ROOT_DER } from './fixtures/attestation/apple-app-attest-root.js'

const PAID_APP_ID = '6849Q7KVP5.org.votetorrent.voter'
const PERSONAL_APP_ID = '94TY7UR2W5.org.votetorrent.voter'

type HardwareFixture = {
  startedAt: string
  ok: boolean
  reprovisioned: boolean
  voteKeyProbe: string
  challenge: { nonce: string; deviceKey: string }
  attestation: {
    publicKey: string
    deviceId: string
    attestationTime: number
    attestationStatement: string
    certificateChain: string[]
    platformDetails: {
      type: string
      secureEnclavePublicKey: string
      appAttestKeyId: string
      assertion: string
      assertionCounter: number
      popSignature: string
      boundDigest: string
      environment: string
      deviceCheckToken?: string
    }
  }
}

const readFixture = (name: string): HardwareFixture =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/attestation/${name}`, import.meta.url)), 'utf8')) as HardwareFixture

const paid = readFixture('ios-hardware-2026-10-08-paid-team.json')
const personal = readFixture('ios-hardware-2026-08-25.json')

/** Verify at each recording's own capture time: development leaf certs live only a few days. */
const verifierFor = (appId: string, fixture: HardwareFixture, environment: 'development' | 'production' = 'development') =>
  new AppAttestVerifier([APPLE_APP_ATTEST_ROOT_DER], appId, environment, undefined, true, new Date(fixture.startedAt))

describe('iOS App Attest — REAL hardware bytes under the PAID team (iPhone 13, 2026-10-08)', () => {
  it('was captured from a successful run of the shipping producer on a fresh install', () => {
    expect(paid.ok).to.equal(true)
    // Fresh install: no Secure Enclave vote key existed, so none had to be replaced.
    expect(paid.voteKeyProbe).to.equal('no-existing-key')
    expect(paid.reprovisioned).to.equal(false)
    expect(paid.attestation.platformDetails.type).to.equal('iOS')
    expect(paid.attestation.platformDetails.secureEnclavePublicKey).to.equal(paid.challenge.deviceKey)
  })

  it('carries a development aaguid, derived from authData and not assumed', () => {
    const decoded = cborDecode(new Uint8Array(Buffer.from(paid.attestation.attestationStatement, 'base64'))) as Map<CborValue, CborValue>
    const authData = decoded.get('authData') as Uint8Array
    expect(Buffer.from(authData.subarray(37, 53)).toString('latin1')).to.equal('appattestdevelop')
    expect(paid.attestation.platformDetails.environment).to.equal('development')
  })

  it('verifies end to end under the paid-team App ID, anchored at Apple’s real root', async () => {
    const r = await verifierFor(PAID_APP_ID, paid).verify(paid.challenge, paid.attestation)
    expect(r.reason ?? '').to.equal('')
    expect(r.ok).to.equal(true)
  })

  it('the App ID it proves is the one the Authority ships (appattest-keys.generated.ts)', () => {
    // Read as text: vote-engine must not import from the Authority app. This is the drift guard the
    // 2026-09-01 todo asked for: change APPLE_APP_ID and this recording stops vouching for it.
    const generated = readFileSync(
      fileURLToPath(new URL('../../../apps/VoteTorrentAuthority/src/engines/appattest-keys.generated.ts', import.meta.url)),
      'utf8'
    )
    const committed = /export const APPLE_APP_ID = '([^']+)'/.exec(generated)?.[1]
    expect(committed).to.equal(PAID_APP_ID)
  })

  describe('negative controls', () => {
    it('rejects this paid-team attestation under the old personal-team App ID', async () => {
      const r = await verifierFor(PERSONAL_APP_ID, paid).verify(paid.challenge, paid.attestation)
      expect(r.ok).to.equal(false)
      expect(r.reason).to.match(/different app/)
    })

    it('rejects the 2026-08-25 personal-team attestation under the paid-team App ID', async () => {
      const r = await verifierFor(PAID_APP_ID, personal).verify(personal.challenge, personal.attestation)
      expect(r.ok).to.equal(false)
      expect(r.reason).to.match(/different app/)
    })

    it('a PRODUCTION authority (the committed APP_ATTEST_ENVIRONMENT) refuses this development attestation', async () => {
      const r = await verifierFor(PAID_APP_ID, paid, 'production').verify(paid.challenge, paid.attestation)
      expect(r.ok).to.equal(false)
      expect(r.reason).to.match(/development attestation is never accepted in production/)
    })

    it('rejects a different challenge nonce', async () => {
      const r = await verifierFor(PAID_APP_ID, paid).verify(
        { ...paid.challenge, nonce: '00000000-0000-4000-8000-000000000000' },
        paid.attestation
      )
      expect(r.ok).to.equal(false)
    })
  })
})
