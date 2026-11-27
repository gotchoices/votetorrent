/**
 * association-removal.spec.ts — 62-18 Task 2 (D-41).
 *
 * Proves `removeAssociation` against the real schema, the D-41 compound write
 * (`prepareAssociation`/`commitPreparedAssociation`, reached here via a type-narrowing cast —
 * they are intentionally engine-internal, not on `IAssociationEngine`), the write-mode probe that
 * decided `REASSOCIATION_WRITE_MODE`, and the `processPendingAssociationRequests` D-41 guards
 * (sentinel/not-yet-replicated skip, leg-1 conflict rejection, leg-2 race rejection, the
 * interrupted-synthetic-rejection sweep).
 *
 * File-local helpers are copied from `association-reads.spec.ts` / `association-request-processing.spec.ts`
 * (neither exports them) with `assoc-rm-` id prefixes, so seeded ids cannot collide with either
 * sibling spec's rows inside the same mocha process.
 */

import 'reflect-metadata'
import { expect } from 'chai'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import {
  REASSOCIATION_UNRESOLVED_REGISTRANT_ID,
  REGISTRANT_HAS_ACTIVE_DEVICE_REASON
} from '@votetorrent/vote-core'
import type {
  AssociateInit,
  AssociationAttestationAnswer,
  AssociationRequestInit,
  AttestationVerification,
  DeviceAttestation,
  IAttestationVerifier,
  Signature
} from '@votetorrent/vote-core'
import { createTestNetwork, addTestAuthority, makeTestSignCallback, testKeyPairFor } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { TestKeyPair } from './fixtures/keys.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'
import { AssociationEngine } from '../src/association/association-engine.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { FilesystemAssociationTransport } from '../src/association/transport/filesystem-association-transport.js'
import { VOTETORRENT_SCHEMA_SQL } from '../src/database/schema-sql.js'
import { REASSOCIATION_WRITE_MODE } from '../src/association/reassociation/write-mode.js'
import type { ReassociationWriteMode } from '../src/association/reassociation/write-mode.js'
import { digestToBytes } from '../src/utils.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import type { EngineContext } from '../src/types.js'

// ---------------------------------------------------------------------------
// Engine-internal surface (prepareAssociation/commitPreparedAssociation) — deliberately not on
// IAssociationEngine (62-18 Task 2's own interfaces note). Narrowed here, mirroring the
// project's established `as unknown as {...}` convention for reaching engine-private state in a
// spec (e.g. `threshold-authority.ts`'s `lastPromotionOutcome` cast).
// ---------------------------------------------------------------------------
interface PreparedAssociationInternal {
  registrantId: string
  deviceKey: string
  nonce: string
}
interface AssociationEngineInternal {
  prepareAssociation (
    init: AssociateInit,
    options?: { registrantIdForChallenge?: string }
  ): Promise<PreparedAssociationInternal>
  commitPreparedAssociation (
    prepared: PreparedAssociationInternal,
    signatureOrCallback: (digest: Uint8Array) => Promise<Signature>,
    revoke?: { registrantId: string; deviceKeys: readonly string[] }
  ): Promise<void>
}
function internal (engine: AssociationEngine): AssociationEngineInternal {
  return engine as unknown as AssociationEngineInternal
}

// ---------------------------------------------------------------------------
// Helpers (assoc-rm- prefixed)
// ---------------------------------------------------------------------------

const tempDirs: string[] = []
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

function makeRealSigner (userId: string): { sign: (digest: Uint8Array) => Promise<Signature>; publicHex: string; privateHex: string } {
  const { privateHex, publicHex } = testKeyPairFor(userId)
  const privBytes = hexToBytes(privateHex)
  const sign = async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signerUserId: userId, signerKey: publicHex, signature: bytesToHex(sig) }
  }
  return { sign, publicHex, privateHex }
}

function makeCallbackSigner (keyPair: TestKeyPair): (digest: Uint8Array) => Promise<Signature> {
  const privBytes = hexToBytes(keyPair.privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signature: bytesToHex(sig), signerKey: keyPair.publicHex, signerUserId: '' }
  }
}

function sha256Hex (input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)))
}

let registrantSeq = 0
function nextRegistrantId (): string {
  registrantSeq += 1
  return `assoc-rm-registrant-${Date.now()}-${registrantSeq}`
}

let deviceSeq = 0
function nextDeviceKey (): string {
  deviceSeq += 1
  return `assoc-rm-device-key-${Date.now()}-${deviceSeq}`
}

const FUTURE_REGISTRANT_EXPIRATION = Date.now() + 365 * 86_400_000

function makeDeviceAttestation (overrides?: Partial<DeviceAttestation>): DeviceAttestation {
  deviceSeq += 1
  return {
    publicKey: `assoc-rm-device-pubkey-${deviceSeq}`,
    deviceId: `assoc-rm-device-id-${Date.now()}-${deviceSeq}`,
    attestationTime: Date.now(),
    certificateChain: ['cert-a', 'cert-b'],
    ...overrides
  }
}

interface AssocRmSetup {
  auth: TestAuthorityContext
  registrantId: string
  engine: AssociationEngine
  sign: (digest: Uint8Array) => Promise<Signature>
}

/** Seed an active Registrant (Status='a') for the compound-write and removal surfaces. */
async function setupAssociationTest (): Promise<AssocRmSetup> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const { sign } = makeRealSigner(auth.user.id)
  const registrationEngine = new RegistrationEngine(auth.ctx)
  const registrantId = nextRegistrantId()
  await registrationEngine.createRegistrant(
    { id: registrantId, authorityId: auth.authority.id, privateCid: 'assoc-rm-test-private-cid-placeholder', expiration: FUTURE_REGISTRANT_EXPIRATION },
    sign
  )
  const engine = new AssociationEngine(auth.ctx)
  return { auth, registrantId, engine, sign }
}

/** Issue a challenge + associate a device for a registrant, against a GIVEN engine instance (so
 * the write-mode probe can associate device A through the default engine and then prepare/commit
 * device B through a write-mode-overridden one, on the SAME underlying ctx/db). */
async function associateDevice (
  engine: AssociationEngine,
  registrantId: string,
  sign: (digest: Uint8Array) => Promise<Signature>,
  overrides?: { deviceKey?: string; deviceHash?: string; attestation?: DeviceAttestation }
): Promise<{ deviceKey: string; attestation: DeviceAttestation }> {
  const deviceKey = overrides?.deviceKey ?? nextDeviceKey()
  const attestation = overrides?.attestation ?? makeDeviceAttestation()
  const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, sign)
  await engine.associate({ registrantId, deviceKey, deviceHash: overrides?.deviceHash, nonce: challenge.nonce, attestation }, sign)
  return { deviceKey, attestation }
}

/** Prepares + commits a compound (revoke old, insert new) association for `deviceKey`, via the
 * engine-internal surface, against `engine` (which may have an explicit write-mode override). */
async function prepareAndCommitCompound (
  engine: AssociationEngine,
  registrantId: string,
  sign: (digest: Uint8Array) => Promise<Signature>,
  oldDeviceKeys: readonly string[],
  overrides?: { deviceKey?: string; attestation?: DeviceAttestation }
): Promise<{ deviceKey: string }> {
  const deviceKey = overrides?.deviceKey ?? nextDeviceKey()
  const attestation = overrides?.attestation ?? makeDeviceAttestation()
  const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, sign)
  const prepared = await internal(engine).prepareAssociation({ registrantId, deviceKey, nonce: challenge.nonce, attestation })
  await internal(engine).commitPreparedAssociation(prepared, sign, { registrantId, deviceKeys: oldDeviceKeys })
  return { deviceKey }
}

async function countRows (ctx: EngineContext, sql: string, params: Record<string, unknown> = {}): Promise<number> {
  const row = await ctx.db.prepare(sql).get(params as Record<string, unknown>)
  return Number(row?.n ?? 0)
}

// ---------------------------------------------------------------------------
// processPendingAssociationRequests driver helpers (mirrors association-request-processing.spec.ts)
// ---------------------------------------------------------------------------

interface DriverSetup {
  auth: TestAuthorityContext
  engine: AssociationEngine
  transport: FilesystemAssociationTransport
  officerSign: (digest: Uint8Array) => Promise<Signature>
}

async function setupDriver (): Promise<DriverSetup> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const officerSign = makeTestSignCallback(auth.user)
  const engine = new AssociationEngine(auth.ctx)
  const rootDir = await mkdtemp(join(tmpdir(), 'association-removal-driver-'))
  tempDirs.push(rootDir)
  const transport = new FilesystemAssociationTransport({ rootDir })
  return { auth, engine, transport, officerSign }
}

async function seedActiveRegistrant (auth: TestAuthorityContext, sign: (digest: Uint8Array) => Promise<Signature>): Promise<string> {
  const registrationEngine = new RegistrationEngine(auth.ctx)
  const registrantId = nextRegistrantId()
  await registrationEngine.createRegistrant(
    { id: registrantId, authorityId: auth.authority.id, privateCid: 'assoc-rm-driver-private-cid', expiration: FUTURE_REGISTRANT_EXPIRATION },
    sign
  )
  return registrantId
}

async function submitDeviceRequest (
  d: DriverSetup,
  registrantId: string,
  deviceKeyPair: TestKeyPair,
  overrides?: Partial<AssociationRequestInit>
): Promise<string> {
  const init: AssociationRequestInit = {
    id: crypto.randomUUID(),
    authorityId: d.auth.authority.id,
    registrantId,
    deviceKey: deviceKeyPair.publicHex,
    submittedAt: toIsoZDatetime(Date.now()),
    ...overrides
  }
  return d.engine.submitAssociationRequest(init, deviceKeyPair.publicHex, makeCallbackSigner(deviceKeyPair))
}

async function readChallengeNonce (d: DriverSetup, requestId: string): Promise<string> {
  const row = await d.auth.ctx.db.prepare('select ChallengeNonce from AssociationRequest where Id = :id').get({ id: requestId })
  const nonce = row?.ChallengeNonce as string | undefined
  if (!nonce) throw new Error(`readChallengeNonce: no ChallengeNonce for requestId=${requestId} — did leg 1 run?`)
  return nonce
}

async function answerDigest (ctx: EngineContext, answer: AssociationAttestationAnswer): Promise<Uint8Array> {
  const attestationJson = JSON.stringify(answer.attestation)
  const digestRow = await ctx.db
    .prepare('select Digest(:requestId, :nonce, :attestationJson, :deviceHash) as d')
    .get({ requestId: answer.requestId, nonce: answer.nonce, attestationJson, deviceHash: answer.deviceHash ?? null })
  if (!digestRow || digestRow.d == null) throw new Error('answerDigest: Digest() returned null')
  return digestToBytes(digestRow.d as string)
}

async function stageAnswer (d: DriverSetup, requestId: string, deviceKeyPair: TestKeyPair, attestation: DeviceAttestation): Promise<void> {
  const nonce = await readChallengeNonce(d, requestId)
  const answer: AssociationAttestationAnswer = { requestId, nonce, attestation }
  const digestBytes = await answerDigest(d.auth.ctx, answer)
  const signature: Signature = {
    signature: bytesToHex(secp256k1.sign(digestBytes, hexToBytes(deviceKeyPair.privateHex))),
    signerKey: deviceKeyPair.publicHex,
    signerUserId: ''
  }
  await d.transport.submitAttestation(answer, deviceKeyPair.publicHex, signature)
}

async function driveOnce (d: DriverSetup): ReturnType<AssociationEngine['processPendingAssociationRequests']> {
  return d.engine.processPendingAssociationRequests(d.auth.authority.id, d.officerSign, d.transport)
}

// ===========================================================================

describe('association-removal / D-41 compound write (62-18 Task 2)', function () {
  this.timeout(20000)

  describe('removeAssociation (real schema)', () => {
    it('leaves zero Association rows and writes an AdminSigning(vrg) delete-digest row', async () => {
      const { auth, registrantId, engine, sign } = await setupAssociationTest()
      const { deviceKey } = await associateDevice(engine, registrantId, sign)

      const adminSigningBefore = await countRows(auth.ctx, "select count(*) as n from AdminSigning where Scope = 'vrg'")

      await engine.removeAssociation(registrantId, deviceKey, sign)

      const associationCount = await countRows(
        auth.ctx,
        'select count(*) as n from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey',
        { registrantId, deviceKey }
      )
      expect(associationCount, 'zero Association rows for the pair after removal').to.equal(0)

      const adminSigningAfter = await countRows(auth.ctx, "select count(*) as n from AdminSigning where Scope = 'vrg'")
      expect(adminSigningAfter, 'a new vrg AdminSigning row was written').to.equal(adminSigningBefore + 1)
    })

    it('throws for a missing (registrantId, deviceKey) pair, and the message names the registrant', async () => {
      const { registrantId, engine, sign } = await setupAssociationTest()
      let caught: Error | undefined
      try {
        await engine.removeAssociation(registrantId, nextDeviceKey(), sign)
      } catch (err) {
        caught = err as Error
      }
      expect(caught, 'expected removeAssociation to throw for a missing pair').to.be.instanceOf(Error)
      expect(caught!.message).to.include(registrantId)
    })

    it('throws when the signer is not a vrg officer of the registrant authority, and the row survives', async () => {
      const { auth, registrantId, engine, sign } = await setupAssociationTest()
      const { deviceKey } = await associateDevice(engine, registrantId, sign)
      // The outsider is not a fixture user, so it has no registered key: sign with a
      // throwaway key. NOTE: this is refused by SignerKeyValid as well as the officer check,
      // so the officer check is not isolated here.
      const outsiderKeys = randomTestKeyPair()
      const outsiderSign = async (digest: Uint8Array): Promise<Signature> => ({
        signerUserId: 'assoc-rm-outsider-not-an-officer',
        signerKey: outsiderKeys.publicHex,
        signature: bytesToHex(secp256k1.sign(digest, hexToBytes(outsiderKeys.privateHex)))
      })

      let threw = false
      try {
        await engine.removeAssociation(registrantId, deviceKey, outsiderSign)
      } catch {
        threw = true
      }
      expect(threw, 'expected removeAssociation to throw for a non-officer signer').to.equal(true)

      const associationCount = await countRows(
        auth.ctx,
        'select count(*) as n from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey',
        { registrantId, deviceKey }
      )
      expect(associationCount, 'the row survives the refused removal').to.equal(1)
    })
  })

  describe('tier assertion (D-41, 62-01 Probe 2 verdict)', () => {
    it('SingleActiveAssociation ships (tier 1, a second device throws) XOR is absent (tier 2, the documented residual) — exactly one branch runs', async () => {
      const tier1Shipped = VOTETORRENT_SCHEMA_SQL.includes('constraint SingleActiveAssociation')
      const { auth, registrantId, engine, sign } = await setupAssociationTest()
      await associateDevice(engine, registrantId, sign)

      let secondThrew = false
      try {
        await associateDevice(engine, registrantId, sign)
      } catch {
        secondThrew = true
      }

      if (tier1Shipped) {
        expect(secondThrew, 'tier 1: a plain associate() of a second device for a registrant that already has one must throw').to.equal(true)
      } else {
        expect(secondThrew, 'tier 2 (documented residual, association-reads.spec.ts relies on it): a plain associate() of a second device must succeed').to.equal(false)
        const count = await countRows(auth.ctx, 'select count(*) as n from Association where RegistrantId = :registrantId', { registrantId })
        expect(count, 'tier 2: both devices are present after two plain associate() calls').to.equal(2)
      }
    })
  })

  describe('write-mode probe (D-41)', () => {
    it("records SINGLE_TRANSACTION_VERDICT by exercising the compound write under an engine built with { reassociationWriteMode: 'single-transaction' }", async () => {
      const { auth, registrantId, sign } = await setupAssociationTest()
      const probeEngine = new AssociationEngine(auth.ctx, undefined, { reassociationWriteMode: 'single-transaction' })
      const { deviceKey: deviceA } = await associateDevice(probeEngine, registrantId, sign)

      let verdict: 'PASS' | 'FAIL'
      let deviceB: string | undefined
      try {
        const result = await prepareAndCommitCompound(probeEngine, registrantId, sign, [deviceA])
        deviceB = result.deviceKey
        verdict = 'PASS'
      } catch {
        verdict = 'FAIL'
      }

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const SINGLE_TRANSACTION_VERDICT: 'PASS' | 'FAIL' = verdict
      expect(SINGLE_TRANSACTION_VERDICT === 'PASS' || SINGLE_TRANSACTION_VERDICT === 'FAIL', 'the probe always resolves to one of the two recorded verdicts').to.equal(true)

      if (SINGLE_TRANSACTION_VERDICT === 'PASS') {
        const rows = await countRows(auth.ctx, 'select count(*) as n from Association where RegistrantId = :registrantId', { registrantId })
        expect(rows, 'PASS: exactly one Association row (the new device) after the single-transaction compound commit').to.equal(1)
        const newRow = await auth.ctx.db
          .prepare('select DeviceKey from Association where RegistrantId = :registrantId')
          .get({ registrantId })
        expect(newRow?.DeviceKey).to.equal(deviceB)
      }
    })

    it('REASSOCIATION_WRITE_MODE (the shipped default) is derived FROM the probe verdict, not independently guessed', async () => {
      const { auth, registrantId, sign } = await setupAssociationTest()
      const probeEngine = new AssociationEngine(auth.ctx, undefined, { reassociationWriteMode: 'single-transaction' })
      const { deviceKey: deviceA } = await associateDevice(probeEngine, registrantId, sign)

      let verdict: 'PASS' | 'FAIL'
      try {
        await prepareAndCommitCompound(probeEngine, registrantId, sign, [deviceA])
        verdict = 'PASS'
      } catch {
        verdict = 'FAIL'
      }

      const expectedMode: ReassociationWriteMode = verdict === 'PASS' ? 'single-transaction' : 'delete-then-insert'
      expect(REASSOCIATION_WRITE_MODE, 'a verdict flip must fail this assertion loudly, not silently').to.equal(expectedMode)
    })
  })

  describe('shipped-mode compound write (the default engine, no override)', () => {
    it('leaves exactly one Association for the registrant (the new device), the old row revoked', async () => {
      const { auth, registrantId, engine, sign } = await setupAssociationTest()
      const { deviceKey: deviceA } = await associateDevice(engine, registrantId, sign)

      const { deviceKey: deviceB } = await prepareAndCommitCompound(engine, registrantId, sign, [deviceA])

      const associations = await auth.ctx.db
        .prepare('select DeviceKey from Association where RegistrantId = :registrantId')
        .get({ registrantId })
      const rows = await countRows(auth.ctx, 'select count(*) as n from Association where RegistrantId = :registrantId', { registrantId })
      expect(rows).to.equal(1)
      expect(associations?.DeviceKey).to.equal(deviceB)

      const getAssociationsResult = await engine.getAssociations(registrantId)
      expect(getAssociationsResult).to.have.lengthOf(1)
      expect(getAssociationsResult[0]!.deviceKey).to.equal(deviceB)
    })

    it('writes AssociationPrivate for the new device and a vrg delete-digest AdminSigning row for the old device', async () => {
      const { auth, registrantId, engine, sign } = await setupAssociationTest()
      const { deviceKey: deviceA } = await associateDevice(engine, registrantId, sign)
      const adminSigningBefore = await countRows(auth.ctx, "select count(*) as n from AdminSigning where Scope = 'vrg'")

      const { deviceKey: deviceB } = await prepareAndCommitCompound(engine, registrantId, sign, [deviceA])

      const privateCount = await countRows(
        auth.ctx,
        'select count(*) as n from AssociationPrivate where RegistrantId = :registrantId and DeviceKey = :deviceKey',
        { registrantId, deviceKey: deviceB }
      )
      expect(privateCount, 'AssociationPrivate for the new device').to.equal(1)

      // Two 'vrg' ceremonies land per compound: the old-key delete + the new Association insert
      // (AssociationPrivate's insert is a THIRD, same-scope ceremony) — at least one MORE than
      // baseline either way; assert the delete specifically via Association absence for deviceA.
      const adminSigningAfter = await countRows(auth.ctx, "select count(*) as n from AdminSigning where Scope = 'vrg'")
      expect(adminSigningAfter > adminSigningBefore, 'at least one new vrg AdminSigning row (the delete ceremony, among others)').to.equal(true)

      const oldStillPresent = await countRows(
        auth.ctx,
        'select count(*) as n from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey',
        { registrantId, deviceKey: deviceA }
      )
      expect(oldStillPresent, 'the old device row is gone').to.equal(0)
    })
  })

  describe('verify-before-revoke', () => {
    it('a failing attestation on the new device leaves the old device untouched and writes no delete row for it', async () => {
      const { auth, registrantId, engine, sign } = await setupAssociationTest()
      const { deviceKey: deviceA } = await associateDevice(engine, registrantId, sign)

      const rejectingVerifier: IAttestationVerifier = {
        async verify (): Promise<AttestationVerification> {
          return { ok: false, reason: 'simulated 62-18 verify-before-revoke rejection' }
        }
      }
      const rejectingEngine = new AssociationEngine(auth.ctx, rejectingVerifier)
      const deviceB = nextDeviceKey()
      const attestation = makeDeviceAttestation()
      const challenge = await rejectingEngine.issueAttestationChallenge(registrantId, deviceB, sign)

      let threw = false
      try {
        await internal(rejectingEngine).prepareAssociation({ registrantId, deviceKey: deviceB, nonce: challenge.nonce, attestation })
      } catch {
        threw = true
      }
      expect(threw, 'prepareAssociation must throw on a failing attestation, before any write').to.equal(true)

      const oldStillPresent = await countRows(
        auth.ctx,
        'select count(*) as n from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey',
        { registrantId, deviceKey: deviceA }
      )
      expect(oldStillPresent, 'device A is untouched — verification happens before any delete').to.equal(1)
    })
  })

  describe('D-41 driver guards (processPendingAssociationRequests)', () => {
    it('a sentinel-registrant p row never makes the batch throw, and a normal row still reaches c', async () => {
      const d = await setupDriver()
      const normalRegistrantId = await seedActiveRegistrant(d.auth, d.officerSign)
      const normalDeviceKeyPair = randomTestKeyPair()
      await submitDeviceRequest(d, normalRegistrantId, normalDeviceKeyPair)

      const sentinelDeviceKeyPair = randomTestKeyPair()
      await submitDeviceRequest(d, REASSOCIATION_UNRESOLVED_REGISTRANT_ID, sentinelDeviceKeyPair)

      const result = await driveOnce(d)
      expect(result.challengesIssued, 'the normal row reaches c; the sentinel row is skipped').to.equal(1)

      const normalRow = await d.auth.ctx.db
        .prepare('select Status from AssociationRequest where DeviceKey = :deviceKey')
        .get({ deviceKey: normalDeviceKeyPair.publicHex })
      expect(normalRow?.Status).to.equal('c')

      const sentinelRow = await d.auth.ctx.db
        .prepare('select Status from AssociationRequest where DeviceKey = :deviceKey')
        .get({ deviceKey: sentinelDeviceKeyPair.publicHex })
      expect(sentinelRow?.Status, 'the sentinel row stays p — Task 3 owns it').to.equal('p')
    })

    it('a p row naming a registrant that does not exist stays p and the batch continues', async () => {
      const d = await setupDriver()
      const ghostRegistrantId = `assoc-rm-ghost-registrant-${Date.now()}`
      const ghostDeviceKeyPair = randomTestKeyPair()
      const ghostRequestId = await submitDeviceRequest(d, ghostRegistrantId, ghostDeviceKeyPair)

      const normalRegistrantId = await seedActiveRegistrant(d.auth, d.officerSign)
      const normalDeviceKeyPair = randomTestKeyPair()
      const normalRequestId = await submitDeviceRequest(d, normalRegistrantId, normalDeviceKeyPair)

      const result = await driveOnce(d)
      expect(result.challengesIssued, 'only the normal row reaches c; the ghost-registrant row is skipped').to.equal(1)

      const ghostRow = await d.auth.ctx.db.prepare('select Status from AssociationRequest where Id = :id').get({ id: ghostRequestId })
      expect(ghostRow?.Status, 'stays p — never batch-fatal').to.equal('p')

      const normalRow = await d.auth.ctx.db.prepare('select Status from AssociationRequest where Id = :id').get({ id: normalRequestId })
      expect(normalRow?.Status).to.equal('c')
    })

    it('leg-1 conflict: a p row naming a registrant that already has a different-device Association ends r with REGISTRANT_HAS_ACTIVE_DEVICE_REASON', async () => {
      const d = await setupDriver()
      const registrantId = await seedActiveRegistrant(d.auth, d.officerSign)

      // First device: full round trip to 'a'.
      const deviceAKeyPair = randomTestKeyPair()
      const requestAId = await submitDeviceRequest(d, registrantId, deviceAKeyPair)
      await driveOnce(d)
      await stageAnswer(d, requestAId, deviceAKeyPair, makeDeviceAttestation())
      const firstRun = await driveOnce(d)
      expect(firstRun.associated).to.equal(1)

      // Second device for the SAME registrant: leg-1 conflict.
      const deviceBKeyPair = randomTestKeyPair()
      const requestBId = await submitDeviceRequest(d, registrantId, deviceBKeyPair)
      const secondRun = await driveOnce(d)
      expect(secondRun.rejected, 'the conflicting p row is rejected at leg 1').to.equal(1)
      expect(secondRun.challengesIssued, 'no challenge is issued for the conflicting row').to.equal(0)

      const requestBRow = await d.auth.ctx.db
        .prepare('select Status, RejectionReason from AssociationRequest where Id = :id')
        .get({ id: requestBId })
      expect(requestBRow?.Status).to.equal('r')
      expect(requestBRow?.RejectionReason).to.equal(REGISTRANT_HAS_ACTIVE_DEVICE_REASON)

      const challengeForB = await countRows(d.auth.ctx, 'select count(*) as n from AttestationChallenge where DeviceKey = :deviceKey', { deviceKey: deviceBKeyPair.publicHex })
      expect(challengeForB, 'no AttestationChallenge row was ever minted for the rejected row').to.equal(0)

      const stillOnlyA = await countRows(d.auth.ctx, 'select count(*) as n from Association where RegistrantId = :registrantId', { registrantId })
      expect(stillOnlyA, "the registrant's existing device is untouched").to.equal(1)
    })

    it('leg-2 race: two first-association requests for one registrant both reach c; once the first is associated, the second is decided r with REGISTRANT_HAS_ACTIVE_DEVICE_REASON', async () => {
      const d = await setupDriver()
      const registrantId = await seedActiveRegistrant(d.auth, d.officerSign)

      const deviceAKeyPair = randomTestKeyPair()
      const deviceBKeyPair = randomTestKeyPair()
      const requestAId = await submitDeviceRequest(d, registrantId, deviceAKeyPair)
      const requestBId = await submitDeviceRequest(d, registrantId, deviceBKeyPair)

      const challengeRun = await driveOnce(d)
      expect(challengeRun.challengesIssued, 'both requests reach c in the same run').to.equal(2)

      await stageAnswer(d, requestAId, deviceAKeyPair, makeDeviceAttestation())
      await stageAnswer(d, requestBId, deviceBKeyPair, makeDeviceAttestation())

      const decideRun = await driveOnce(d)
      expect(decideRun.associated).to.equal(1)
      expect(decideRun.rejected).to.equal(1)

      const rowA = await d.auth.ctx.db.prepare('select Status, RejectionReason from AssociationRequest where Id = :id').get({ id: requestAId })
      const rowB = await d.auth.ctx.db.prepare('select Status, RejectionReason from AssociationRequest where Id = :id').get({ id: requestBId })
      const statuses = [rowA?.Status, rowB?.Status].sort()
      expect(statuses, 'exactly one associated and one rejected').to.deep.equal(['a', 'r'])
      const rejectedRow = rowA?.Status === 'r' ? rowA : rowB
      expect(rejectedRow?.RejectionReason).to.equal(REGISTRANT_HAS_ACTIVE_DEVICE_REASON)

      const registrantAssociationCount = await countRows(d.auth.ctx, 'select count(*) as n from Association where RegistrantId = :registrantId', { registrantId })
      expect(registrantAssociationCount, 'exactly one Association for the registrant after the race').to.equal(1)
    })

    it('an interrupted synthetic rejection (a c row with the reassociation-rejected nonce prefix) is completed to r idempotently on the next run', async () => {
      const d = await setupDriver()
      const registrantId = await seedActiveRegistrant(d.auth, d.officerSign)
      const deviceKeyPair = randomTestKeyPair()
      const requestId = await submitDeviceRequest(d, registrantId, deviceKeyPair)

      // Simulate "stopped after the first transition": call the engine's own writeChallengeTransition
      // half (via the per-row reject path) but never the second half — reached here through the
      // internal cast, mirroring how `rejectPendingRequest` itself would leave the row if a crash
      // landed between its two transitions.
      const syntheticNonce = `reassociation-rejected:${REGISTRANT_HAS_ACTIVE_DEVICE_REASON}:${crypto.randomUUID()}`
      const internalAny = d.engine as unknown as {
        writeChallengeTransition: (requestId: string, authorityId: string, challengeNonce: string, sign: (digest: Uint8Array) => Promise<Signature>) => Promise<void>
      }
      await internalAny.writeChallengeTransition(requestId, d.auth.authority.id, syntheticNonce, d.officerSign)

      const midRow = await d.auth.ctx.db.prepare('select Status, ChallengeNonce from AssociationRequest where Id = :id').get({ id: requestId })
      expect(midRow?.Status).to.equal('c')
      expect(midRow?.ChallengeNonce).to.equal(syntheticNonce)

      const firstSweep = await driveOnce(d)
      expect(firstSweep.rejected, 'R0 completes the interrupted row to r').to.equal(1)
      const afterRow = await d.auth.ctx.db.prepare('select Status, RejectionReason from AssociationRequest where Id = :id').get({ id: requestId })
      expect(afterRow?.Status).to.equal('r')
      expect(afterRow?.RejectionReason).to.equal(REGISTRANT_HAS_ACTIVE_DEVICE_REASON)

      const secondSweep = await driveOnce(d)
      expect(secondSweep.rejected, 'the second run is idempotent — the row is already r, no longer matched by the c+prefix sweep').to.equal(0)
    })
  })
})
