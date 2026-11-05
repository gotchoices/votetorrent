/**
 * attestation-verdict.spec.ts — Phase 47-08 real-engine + mock-parity spec
 * for the D-03 `AttestationVerdict` store.
 *
 * Proves: both write paths (pass AND fail) inside `associate()`, the
 * write-before-throw ordering (behaviorally AND via a static source-order
 * lock), the text-code shape of `Verdict`, monotonic `Sequence` per
 * `(RegistrantId, DeviceKey)`, `InsertOnly`, that the store never touches
 * `AssociationPrivate`, the skip-verify (`AttestationRequired=0`) no-row
 * contract, the two-directional ordering guard (T-47-11), and
 * `MockAssociationEngine` parity.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { AttestationChallenge, AttestationVerification, DeviceAttestation, IAttestationVerifier, Signature } from '@votetorrent/vote-core'
import { AssociationEngine } from '../src/association/association-engine.js'
import { MockAssociationEngine } from '../src/association/mock-association-engine.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { createTestNetwork, addTestAuthority, addTestElection, testKeyPairFor } from './fixtures/test-context.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'
import type { EngineContext } from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers (copied from association.spec.ts, id prefixes changed to avoid
// cross-file id collisions inside the same mocha process)
// ---------------------------------------------------------------------------

/** Resolve the single Election row seeded by addTestElection() for this authority. */
async function resolveElectionId (ctx: EngineContext, authorityId: string): Promise<string> {
  const row = await ctx.db
    .prepare('select Id from Election where AuthorityId = :authorityId limit 1')
    .get({ authorityId })
  if (!row) throw new Error('resolveElectionId: Election not found for authority')
  return row.Id as string
}

/** Build a real secp256k1 sign callback (@noble/curves v2 defaults — prehash:true). */
function makeRealSigner (userId: string): { sign: (digest: Uint8Array) => Promise<Signature>; publicHex: string; privateHex: string } {
  const { privateHex, publicHex } = testKeyPairFor(userId)
  const privBytes = hexToBytes(privateHex)
  const sign = async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes) // v2 default: prehash:true
    return { signerUserId: userId, signerKey: publicHex, signature: bytesToHex(sig) }
  }
  return { sign, publicHex, privateHex }
}

let registrantSeq = 0
function nextRegistrantId (): string {
  registrantSeq += 1
  return `verdict-registrant-${Date.now()}-${registrantSeq}`
}

let deviceSeq = 0
function nextDeviceKey (): string {
  deviceSeq += 1
  return `verdict-device-key-${Date.now()}-${deviceSeq}`
}

const FUTURE_REGISTRANT_EXPIRATION = Date.now() + 365 * 86_400_000

function makeDeviceAttestation (overrides?: Partial<DeviceAttestation>): DeviceAttestation {
  deviceSeq += 1
  return {
    publicKey: `verdict-device-pubkey-${deviceSeq}`,
    deviceId: `verdict-device-id-${Date.now()}-${deviceSeq}`,
    attestationTime: Date.now(),
    certificateChain: ['cert-a', 'cert-b'],
    ...overrides
  }
}

/** Seed an active Registrant (Status='a') for the attestation flow to associate against. */
async function setupAssociationTest (): Promise<{
  auth: TestAuthorityContext
  registrantId: string
  engine: AssociationEngine
  registrationEngine: RegistrationEngine
  sign: (digest: Uint8Array) => Promise<Signature>
}> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const { sign } = makeRealSigner(auth.user.id)
  const registrationEngine = new RegistrationEngine(auth.ctx)
  const registrantId = nextRegistrantId()
  await registrationEngine.createRegistrant(
    { id: registrantId, authorityId: auth.authority.id, privateCid: 'verdict-test-private-cid-placeholder', expiration: FUTURE_REGISTRANT_EXPIRATION },
    sign
  )
  const engine = new AssociationEngine(auth.ctx)
  return { auth, registrantId, engine, registrationEngine, sign }
}

const REJECT_REASON = 'simulated rejection (D-03 fail-path)'
const rejectingVerifier: IAttestationVerifier = {
  async verify (): Promise<AttestationVerification> {
    return { ok: false, reason: REJECT_REASON }
  }
}

/** A verifier that ALWAYS throws — proves whether verify() was ever invoked at all. */
const throwIfCalledVerifier: IAttestationVerifier = {
  async verify (): Promise<AttestationVerification> {
    throw new Error('verify() must not run on the non-attested (AttestationRequired=0) path — D-14c')
  }
}

/** A subclass whose recordAttestationVerdict always throws — proves the T-47-11 ordering guard. */
class ThrowingVerdictEngine extends AssociationEngine {
  async recordAttestationVerdict (): Promise<void> {
    throw new Error('synthetic verdict-store failure')
  }
}

// ===========================================================================

describe('AttestationVerdict store (D-03)', () => {
  describe('associate() write site — both paths', () => {
    it('pass path: exactly one AttestationVerdict row, Verdict=pass, Sequence=0, Reason null', async () => {
      const { auth, registrantId, engine, sign } = await setupAssociationTest()
      const deviceKey = nextDeviceKey()
      const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, sign)
      const attestation = makeDeviceAttestation()

      await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation }, sign)

      const verdicts = await engine.getAttestationVerdicts(registrantId, deviceKey)
      expect(verdicts).to.have.lengthOf(1)
      expect(verdicts[0].verdict).to.equal('pass')
      expect(verdicts[0].sequence).to.equal(0)
      expect(verdicts[0].reason).to.be.undefined

      const associationCount = await auth.ctx.db
        .prepare('select count(*) as n from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      expect(Number(associationCount?.n)).to.equal(1)
    })

    it('fail path (THE test of this plan): a fail-verdict row exists after a rejected associate()', async () => {
      const { auth, registrantId, sign } = await setupAssociationTest()
      const engine = new AssociationEngine(auth.ctx, rejectingVerifier)
      const deviceKey = nextDeviceKey()
      const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, sign)
      const attestation = makeDeviceAttestation()

      let threw = false
      try {
        await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation }, sign)
      } catch (err) {
        threw = true
        expect((err as Error).message).to.match(/attestation verification failed/)
      }
      expect(threw, 'expected associate() to throw on seam rejection').to.be.true

      const row = await auth.ctx.db
        .prepare('select Verdict, Reason, Sequence from AttestationVerdict where RegistrantId = :r and DeviceKey = :d')
        .get({ r: registrantId, d: deviceKey })
      expect(
        row,
        'D-03: the verdict insert must run BEFORE the fail-closed throw — a fail verdict with no row means the insert moved after it'
      ).to.not.be.undefined
      expect(row?.Verdict).to.equal('fail')
      expect(Number(row?.Sequence)).to.equal(0)
      expect(row?.Reason).to.equal(REJECT_REASON)
    })

    it('fail path leaves NO Association/AssociationPrivate rows, while the verdict row survives', async () => {
      const { auth, registrantId, sign } = await setupAssociationTest()
      const engine = new AssociationEngine(auth.ctx, rejectingVerifier)
      const deviceKey = nextDeviceKey()
      const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, sign)
      const attestation = makeDeviceAttestation()

      try {
        await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation }, sign)
      } catch {
        // expected
      }

      // This is exactly why 47-01 declares NO foreign-key CHECK on
      // AttestationVerdict.DeviceKey: an FK would make this row impossible.
      const associationCount = await auth.ctx.db
        .prepare('select count(*) as n from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      expect(Number(associationCount?.n)).to.equal(0)
      const privateCount = await auth.ctx.db
        .prepare('select count(*) as n from AssociationPrivate where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      expect(Number(privateCount?.n)).to.equal(0)

      const verdictCount = await auth.ctx.db
        .prepare('select count(*) as n from AttestationVerdict where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      expect(Number(verdictCount?.n)).to.equal(1)
    })

    it('Verdict is a TEXT code, never a boolean (votetorrent.qsql:1661-1662 rationale)', async () => {
      const { auth, registrantId: passRegistrantId, sign } = await setupAssociationTest()
      const passEngine = new AssociationEngine(auth.ctx)
      const deviceKeyPass = nextDeviceKey()
      const passChallenge = await passEngine.issueAttestationChallenge(passRegistrantId, deviceKeyPass, sign)
      await passEngine.associate({ registrantId: passRegistrantId, deviceKey: deviceKeyPass, nonce: passChallenge.nonce, attestation: makeDeviceAttestation() }, sign)

      const failEngine = new AssociationEngine(auth.ctx, rejectingVerifier)
      const deviceKeyFail = nextDeviceKey()
      const failChallenge = await failEngine.issueAttestationChallenge(passRegistrantId, deviceKeyFail, sign)
      try {
        await failEngine.associate({ registrantId: passRegistrantId, deviceKey: deviceKeyFail, nonce: failChallenge.nonce, attestation: makeDeviceAttestation() }, sign)
      } catch {
        // expected
      }

      const passRow = await auth.ctx.db
        .prepare('select Verdict from AttestationVerdict where RegistrantId = :r and DeviceKey = :d')
        .get({ r: passRegistrantId, d: deviceKeyPass })
      const failRow = await auth.ctx.db
        .prepare('select Verdict from AttestationVerdict where RegistrantId = :r and DeviceKey = :d')
        .get({ r: passRegistrantId, d: deviceKeyFail })

      expect(typeof passRow?.Verdict).to.equal('string')
      expect(typeof failRow?.Verdict).to.equal('string')
      expect(passRow?.Verdict).to.equal('pass')
      expect(failRow?.Verdict).to.equal('fail')
      for (const bad of [0, 1, '0', '1', true, false]) {
        expect(passRow?.Verdict).to.not.equal(bad)
        expect(failRow?.Verdict).to.not.equal(bad)
      }
    })

    it('skip-verify path (AttestationRequired=0) writes NO verdict row; AttestationCid is still non-null', async () => {
      const { auth, registrantId, registrationEngine, sign } = await setupAssociationTest()
      const elec = await addTestElection(auth)
      const electionId = await resolveElectionId(elec.ctx, elec.authority.id)
      await registrationEngine.setElectionAttestationPolicy(electionId, false, sign)

      const engine = new AssociationEngine(auth.ctx, throwIfCalledVerifier)
      const deviceKey = nextDeviceKey()
      const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, sign, electionId)
      const attestation = makeDeviceAttestation()

      // Resolving (not throwing) is itself the proof that verify() never ran.
      await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation }, sign)

      const associationRow = await auth.ctx.db
        .prepare('select count(*) as n from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      expect(Number(associationRow?.n)).to.equal(1)

      const verdicts = await engine.getAttestationVerdicts(registrantId, deviceKey)
      expect(verdicts).to.have.lengthOf(0)

      // D-03 contract 47-15/47-16 depend on: AttestationCid is non-null on the
      // non-attested path too (Phase 45 D-14a..D-14e) — so the ABSENCE of a
      // verdict row, not AttestationCid, is the honest "never attested" signal.
      const association = await engine.getAssociation(registrantId, deviceKey)
      expect(association?.attestationCid).to.not.be.null
      expect(association?.attestationCid).to.be.a('string').with.length.greaterThan(0)
    })

    describe('ordering guard (T-47-11), two directions', () => {
      it('(a) a throwing recordAttestationVerdict on the FAIL path does not mask or re-shape the rejection', async () => {
        const { auth, registrantId, sign } = await setupAssociationTest()
        const engine = new ThrowingVerdictEngine(auth.ctx, rejectingVerifier)
        const deviceKey = nextDeviceKey()
        const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, sign)
        const attestation = makeDeviceAttestation()

        let caught: Error | undefined
        try {
          await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation }, sign)
        } catch (err) {
          caught = err as Error
        }
        expect(caught).to.not.be.undefined
        expect(caught!.message).to.match(/attestation verification failed/)
        expect(caught!.message).to.not.match(/synthetic verdict-store failure/)
        expect(caught!.cause).to.be.instanceOf(Error)
        expect((caught!.cause as Error).message).to.equal('synthetic verdict-store failure')
      })

      it('(b) a throwing recordAttestationVerdict on the PASS path is surfaced, never swallowed; no Association is written', async () => {
        const { auth, registrantId, sign } = await setupAssociationTest()
        const engine = new ThrowingVerdictEngine(auth.ctx)
        const deviceKey = nextDeviceKey()
        const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, sign)
        const attestation = makeDeviceAttestation()

        let caught: Error | undefined
        try {
          await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation }, sign)
        } catch (err) {
          caught = err as Error
        }
        expect(caught).to.not.be.undefined
        expect(caught!.message).to.match(/synthetic verdict-store failure/)

        const associationCount = await auth.ctx.db
          .prepare('select count(*) as n from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
          .get({ registrantId, deviceKey })
        expect(Number(associationCount?.n)).to.equal(0)
      })
    })
  })

  describe('source-order lock (write-before-throw)', () => {
    it('this.recordAttestationVerdict( precedes if (!verification.ok) in association-engine.ts', () => {
      const here = dirname(fileURLToPath(import.meta.url))
      const srcPath = join(here, '..', 'src', 'association', 'association-engine.ts')
      const lines = readFileSync(srcPath, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))

      const recordIdx = lines.findIndex((l) => l.includes('this.recordAttestationVerdict('))
      const gateIdx = lines.findIndex((l) => l.includes('if (!verification.ok)'))

      expect(recordIdx, 'this.recordAttestationVerdict( anchor not found').to.be.greaterThan(-1)
      expect(gateIdx, 'if (!verification.ok) anchor not found').to.be.greaterThan(-1)
      expect(
        recordIdx,
        'moving the verdict insert after the fail-closed throw records nothing on the fail path — D-03 delivers nothing'
      ).to.be.lessThan(gateIdx)
    })
  })

  describe('recordAttestationVerdict / getAttestationVerdicts (direct)', () => {
    it('Sequence is monotonic per (RegistrantId, DeviceKey); independent across device keys and registrants', async () => {
      const { auth, registrantId, engine, registrationEngine, sign } = await setupAssociationTest()
      const deviceKeyA = nextDeviceKey()
      const deviceKeyB = nextDeviceKey()

      await engine.recordAttestationVerdict(registrantId, deviceKeyA, { ok: false, reason: 'r1' })
      await engine.recordAttestationVerdict(registrantId, deviceKeyA, { ok: true })
      await engine.recordAttestationVerdict(registrantId, deviceKeyA, { ok: false, reason: 'r3' })

      const aRows = await engine.getAttestationVerdicts(registrantId, deviceKeyA)
      expect(aRows.map((r) => r.sequence)).to.deep.equal([0, 1, 2])
      expect(aRows.map((r) => r.verdict)).to.deep.equal(['fail', 'pass', 'fail'])

      await engine.recordAttestationVerdict(registrantId, deviceKeyB, { ok: true })
      const bRows = await engine.getAttestationVerdicts(registrantId, deviceKeyB)
      expect(bRows[0].sequence).to.equal(0)

      // second registrant IN THE SAME authority context, same device key — no cross-registrant bleed
      const registrantId2 = nextRegistrantId()
      await registrationEngine.createRegistrant(
        { id: registrantId2, authorityId: auth.authority.id, privateCid: 'verdict-test-private-cid-placeholder-2', expiration: FUTURE_REGISTRANT_EXPIRATION },
        sign
      )
      await engine.recordAttestationVerdict(registrantId2, deviceKeyA, { ok: true })
      const secondRegistrantRows = await engine.getAttestationVerdicts(registrantId2, deviceKeyA)
      expect(secondRegistrantRows[0].sequence).to.equal(0)
    })

    it('two OVERLAPPING recordAttestationVerdict calls both land, with distinct Sequences (WR-06)', async () => {
      // Same read-then-insert race as RegistrantAccessEvent: a
      // `select max(Sequence)` followed by an unwrapped `insert`, with no
      // transaction around the pair. Here a lost row is a lost VERDICT — and
      // the fail verdict is precisely the one that must never vanish, since it
      // is the record that a device was rejected.
      const { registrantId, engine } = await setupAssociationTest()
      const deviceKey = nextDeviceKey()

      await Promise.all([
        engine.recordAttestationVerdict(registrantId, deviceKey, { ok: false, reason: 'racing-fail' }),
        engine.recordAttestationVerdict(registrantId, deviceKey, { ok: true })
      ])

      const rows = await engine.getAttestationVerdicts(registrantId, deviceKey)
      expect(rows, 'BOTH verdicts must be recorded — a lost row here is a lost fail verdict').to.have.length(2)
      expect(new Set(rows.map((r) => r.sequence)).size, 'the two rows must carry DISTINCT sequences').to.equal(2)
      expect(rows.map((r) => r.verdict).sort()).to.deep.equal(['fail', 'pass'])
    })

    it('a verdict insert that LANDS and then reports failure is not written twice (WR-01)', async () => {
      // The retry's original predicate was "did the high-water mark advance?"
      // — but our own row advances it. An exec that rejects AFTER the row
      // landed (project memory records intermittent
      // `stale revision: rev 1 vs rev 1` rejections from @optimystic/db-p2p
      // 0.18) was therefore read as a lost race, and the retry appended a
      // SECOND copy at sequence + 1. AttestationVerdict is InsertOnly, so a
      // duplicated pass/fail judgement can never be removed from the table
      // that exists to keep those judgements honest.
      const { registrantId, engine } = await setupAssociationTest()
      const deviceKey = nextDeviceKey()
      const ctx = (engine as unknown as { ctx: EngineContext }).ctx

      const realExec = ctx.db.exec.bind(ctx.db)
      let rejectedOnce = false
      ;(ctx.db as unknown as { exec: typeof ctx.db.exec }).exec = async (sql: any, params?: any) => {
        const result = await realExec(sql, params)
        if (!rejectedOnce && typeof sql === 'string' && sql.includes('insert into AttestationVerdict')) {
          rejectedOnce = true
          // The write COMMITTED; only the acknowledgement failed.
          throw new Error('stale revision: rev 1 vs rev 1')
        }
        return result
      }

      try {
        await engine.recordAttestationVerdict(registrantId, deviceKey, { ok: false, reason: 'revoked hardware root' })
      } finally {
        ;(ctx.db as unknown as { exec: typeof ctx.db.exec }).exec = realExec
      }

      expect(rejectedOnce, 'the fault injector must actually have fired, or this test is vacuous').to.equal(true)
      const rows = await engine.getAttestationVerdicts(registrantId, deviceKey)
      expect(rows, 'the landed verdict must NOT be duplicated by the retry').to.have.length(1)
      expect(rows[0].sequence).to.equal(0)
      expect(rows[0].verdict).to.equal('fail')
      expect(rows[0].reason).to.equal('revoked hardware root')
    })

    it('the landed-row probe survives a trailing-zero millisecond, which Quereus stores truncated (WR-01 root cause, 51-02)', async () => {
      // REGRESSION LOCK for the ~20-25% flake documented in
      // `.planning/todos/pending/2026-08-11-attestation-verdict-wr01-retry-duplicates-intermittently.md`.
      //
      // Quereus coerces the `datetime` column through a normalization that
      // drops the trailing `Z` AND strips trailing zeros from the fractional
      // seconds: a bound `...:31.910Z` comes back as `...:31.91`. The probe
      // originally compared the two as strings after removing only the `Z`
      // (`stripZ`), so whenever `Date.now()` landed on a millisecond ending in
      // zero the probe answered "not ours", the retry ran, and a SECOND copy
      // of the same verdict was appended. `AttestationVerdict` is InsertOnly,
      // so the duplicate is permanent. This is the exact defect
      // `recordRegistrantAccessEvent` already found and fixed for
      // `RegistrantAccessEvent.Timestamp` — see
      // `registrant-access-trail.spec.ts`'s twin of this test.
      //
      // This test PINS the clock to a trailing-zero millisecond so the
      // regression is deterministic rather than a ~1-in-10 flake. Do not
      // "fix" a failure here by loosening the comparison to ignore the
      // timestamp — that would let a genuinely foreign row at the same
      // sequence be mistaken for ours and silently DROP a verdict write.
      const { registrantId, engine } = await setupAssociationTest()
      const deviceKey = nextDeviceKey()
      const ctx = (engine as unknown as { ctx: EngineContext }).ctx

      const realNow = Date.now
      // .910 -> Quereus stores ".91". Any ms ending in 0 reproduces it.
      const pinned = new Date('2026-08-05T12:04:31.910Z').getTime()
      Date.now = () => pinned

      const realExec = ctx.db.exec.bind(ctx.db)
      let rejectedOnce = false
      ;(ctx.db as unknown as { exec: typeof ctx.db.exec }).exec = async (sql: any, params?: any) => {
        const result = await realExec(sql, params)
        if (!rejectedOnce && typeof sql === 'string' && sql.includes('insert into AttestationVerdict')) {
          rejectedOnce = true
          throw new Error('stale revision: rev 1 vs rev 1')
        }
        return result
      }

      try {
        await engine.recordAttestationVerdict(registrantId, deviceKey, { ok: false, reason: 'revoked hardware root' })
      } finally {
        ;(ctx.db as unknown as { exec: typeof ctx.db.exec }).exec = realExec
        Date.now = realNow
      }

      expect(rejectedOnce, 'the fault injector must actually have fired, or this test is vacuous').to.equal(true)
      const rows = await engine.getAttestationVerdicts(registrantId, deviceKey)
      expect(rows, 'a trailing-zero millisecond must not defeat the own-row probe and duplicate the verdict').to.have.length(1)
      expect(rows[0].sequence).to.equal(0)
      expect(rows[0].verdict).to.equal('fail')
    })

    it('a forced failure where the row genuinely did NOT land still retries and writes exactly one row', async () => {
      // The counterpart to the two tests above: when the insert truly never
      // committed (no side effect at all), the retry must still succeed —
      // this is the ordinary "transient storage error" case the whole guard
      // exists to recover from, not just the "landed but ack failed" case.
      const { registrantId, engine } = await setupAssociationTest()
      const deviceKey = nextDeviceKey()
      const ctx = (engine as unknown as { ctx: EngineContext }).ctx

      const realExec = ctx.db.exec.bind(ctx.db)
      let failedOnce = false
      ;(ctx.db as unknown as { exec: typeof ctx.db.exec }).exec = async (sql: any, params?: any) => {
        if (!failedOnce && typeof sql === 'string' && sql.includes('insert into AttestationVerdict')) {
          failedOnce = true
          // Never calls realExec — nothing lands, unlike the "stale revision"
          // fault injector above which commits before throwing.
          throw new Error('transient storage error: no side effect')
        }
        return await realExec(sql, params)
      }

      try {
        await engine.recordAttestationVerdict(registrantId, deviceKey, { ok: true })
      } finally {
        ;(ctx.db as unknown as { exec: typeof ctx.db.exec }).exec = realExec
      }

      expect(failedOnce, 'the fault injector must actually have fired, or this test is vacuous').to.equal(true)
      const rows = await engine.getAttestationVerdicts(registrantId, deviceKey)
      expect(rows, 'the retry must write the row that genuinely never landed').to.have.length(1)
      expect(rows[0].sequence).to.equal(0)
      expect(rows[0].verdict).to.equal('pass')
    })

    it('a probe failure inside the verdict retry never REPLACES the original insert error (WR-01)', async () => {
      const { registrantId, engine } = await setupAssociationTest()
      const deviceKey = nextDeviceKey()
      const ctx = (engine as unknown as { ctx: EngineContext }).ctx

      const realExec = ctx.db.exec.bind(ctx.db)
      const realPrepare = ctx.db.prepare.bind(ctx.db)
      let insertFailed = false
      ;(ctx.db as unknown as { exec: typeof ctx.db.exec }).exec = async (sql: any, params?: any) => {
        if (typeof sql === 'string' && sql.includes('insert into AttestationVerdict')) {
          insertFailed = true
          throw new Error('THE-REAL-INSERT-FAILURE')
        }
        return await realExec(sql, params)
      }
      ;(ctx.db as unknown as { prepare: typeof ctx.db.prepare }).prepare = (sql: any, ...rest: any[]) => {
        if (insertFailed && typeof sql === 'string' && sql.includes('AttestationVerdict')) {
          throw new Error('THE-PROBE-FAILURE')
        }
        return realPrepare(sql, ...rest)
      }

      let caught: unknown
      try {
        await engine.recordAttestationVerdict(registrantId, deviceKey, { ok: true })
      } catch (err) {
        caught = err
      } finally {
        ;(ctx.db as unknown as { exec: typeof ctx.db.exec }).exec = realExec
        ;(ctx.db as unknown as { prepare: typeof ctx.db.prepare }).prepare = realPrepare
      }

      expect(insertFailed, 'the fault injector must actually have fired').to.equal(true)
      expect(caught).to.be.instanceOf(Error)
      expect(String((caught as Error).message)).to.contain('THE-REAL-INSERT-FAILURE')
      expect(String((caught as Error).message), 'the probe failure must not mask the insert failure').to.not.contain('THE-PROBE-FAILURE')
    })

    it('read shape and ordering: unfiltered spans device keys, narrowed returns only one, last element is most recent', async () => {
      const { registrantId, engine } = await setupAssociationTest()
      const deviceKeyA = nextDeviceKey()
      const deviceKeyB = nextDeviceKey()

      await engine.recordAttestationVerdict(registrantId, deviceKeyA, { ok: false, reason: 'r1' })
      await engine.recordAttestationVerdict(registrantId, deviceKeyA, { ok: true })
      await engine.recordAttestationVerdict(registrantId, deviceKeyA, { ok: false, reason: 'r3' })
      await engine.recordAttestationVerdict(registrantId, deviceKeyB, { ok: true })

      const all = await engine.getAttestationVerdicts(registrantId)
      expect(all).to.have.lengthOf(4)
      // ordered DeviceKey asc then Sequence asc
      const sortedKeys = [...all].sort((a, b) => (a.deviceKey < b.deviceKey ? -1 : a.deviceKey > b.deviceKey ? 1 : a.sequence - b.sequence))
      expect(all.map((r) => `${r.deviceKey}:${r.sequence}`)).to.deep.equal(sortedKeys.map((r) => `${r.deviceKey}:${r.sequence}`))

      const narrowed = await engine.getAttestationVerdicts(registrantId, deviceKeyA)
      expect(narrowed).to.have.lengthOf(3)
      expect(narrowed.every((r) => r.deviceKey === deviceKeyA)).to.be.true
      const last = narrowed[narrowed.length - 1]
      expect(last.sequence).to.equal(2)
      expect(last.verdict).to.equal('fail')
    })

    it('reason and verifiedAt round-trip: reason is undefined (not null) when omitted; verifiedAt is Z-suffixed', async () => {
      const { registrantId, engine } = await setupAssociationTest()
      const deviceKey = nextDeviceKey()

      await engine.recordAttestationVerdict(registrantId, deviceKey, { ok: true })
      await engine.recordAttestationVerdict(registrantId, deviceKey, { ok: false, reason: 'exact-reason' })

      const rows = await engine.getAttestationVerdicts(registrantId, deviceKey)
      expect(rows[0].reason).to.be.undefined
      expect(rows[1].reason).to.equal('exact-reason')
      for (const row of rows) {
        expect(row.verifiedAt).to.match(/Z$/)
      }
    })

    it('unwired ctx: getAttestationVerdicts resolves [] without throwing; recordAttestationVerdict rejects', async () => {
      const engine = new AssociationEngine()
      // Reads degrade to empty; writes fail loudly (the getAssociation bare-guard vs requireCtx asymmetry).
      const result = await engine.getAttestationVerdicts('x')
      expect(result).to.deep.equal([])

      let threw = false
      try {
        await engine.recordAttestationVerdict('x', 'y', { ok: true })
      } catch {
        threw = true
      }
      expect(threw).to.be.true
    })

    it('InsertOnly: raw update and delete are rejected; the seeded row is unchanged', async () => {
      const { auth, registrantId, engine } = await setupAssociationTest()
      const deviceKey = nextDeviceKey()
      await engine.recordAttestationVerdict(registrantId, deviceKey, { ok: true })

      let updateErr: unknown
      try {
        await auth.ctx.db.exec(
          `update AttestationVerdict with context Tid = 9, now = ${Date.now()} set Reason = 'tampered'`
        )
      } catch (err) {
        updateErr = err
      }
      // Missing mutation context may fire before InsertOnly.
      expect(updateErr).to.be.instanceOf(Error)

      let deleteErr: unknown
      try {
        await auth.ctx.db.exec(
          `delete from AttestationVerdict with context Tid = 9, now = ${Date.now()}`
        )
      } catch (err) {
        deleteErr = err
      }
      // Missing mutation context may fire before InsertOnly.
      expect(deleteErr).to.be.instanceOf(Error)

      const row = await auth.ctx.db
        .prepare('select Reason from AttestationVerdict where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      expect(row?.Reason).to.not.equal('tampered')
    })

    it('never touches AssociationPrivate: its Cid is unchanged by further verdicts', async () => {
      const { auth, registrantId, engine, sign } = await setupAssociationTest()
      const deviceKey = nextDeviceKey()
      const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, sign)
      await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation: makeDeviceAttestation() }, sign)

      const before = await auth.ctx.db
        .prepare('select Cid from AssociationPrivate where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      const capturedCid = before?.Cid

      await engine.recordAttestationVerdict(registrantId, deviceKey, { ok: true })
      await engine.recordAttestationVerdict(registrantId, deviceKey, { ok: false, reason: 'x' })

      const countRow = await auth.ctx.db
        .prepare('select count(*) as n from AssociationPrivate where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      expect(Number(countRow?.n)).to.equal(1)

      const after = await auth.ctx.db
        .prepare('select Cid from AssociationPrivate where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      expect(after?.Cid).to.equal(capturedCid)
    })
  })

  describe('MockAssociationEngine parity', () => {
    it('recordAttestationVerdict: sequences restart per device key and per registrant', async () => {
      const mock = new MockAssociationEngine()
      const registrantId = nextRegistrantId()
      const deviceKeyA = nextDeviceKey()
      const deviceKeyB = nextDeviceKey()

      await mock.recordAttestationVerdict(registrantId, deviceKeyA, { ok: false, reason: 'r1' })
      await mock.recordAttestationVerdict(registrantId, deviceKeyA, { ok: true })
      await mock.recordAttestationVerdict(registrantId, deviceKeyA, { ok: false, reason: 'r3' })
      const aRows = await mock.getAttestationVerdicts(registrantId, deviceKeyA)
      expect(aRows.map((r) => r.sequence)).to.deep.equal([0, 1, 2])

      await mock.recordAttestationVerdict(registrantId, deviceKeyB, { ok: true })
      const bRows = await mock.getAttestationVerdicts(registrantId, deviceKeyB)
      expect(bRows[0].sequence).to.equal(0)

      const registrantId2 = nextRegistrantId()
      await mock.recordAttestationVerdict(registrantId2, deviceKeyA, { ok: true })
      const secondRegistrantRows = await mock.getAttestationVerdicts(registrantId2, deviceKeyA)
      expect(secondRegistrantRows[0].sequence).to.equal(0)
    })

    it('getAttestationVerdicts: unfiltered/narrowed shapes match the real engine; associate() records exactly one pass verdict', async () => {
      const mock = new MockAssociationEngine()
      const registrantId = nextRegistrantId()
      const deviceKeyA = nextDeviceKey()
      const deviceKeyB = nextDeviceKey()

      await mock.recordAttestationVerdict(registrantId, deviceKeyA, { ok: false, reason: 'r1' })
      await mock.recordAttestationVerdict(registrantId, deviceKeyA, { ok: true })
      await mock.recordAttestationVerdict(registrantId, deviceKeyB, { ok: true })

      const all = await mock.getAttestationVerdicts(registrantId)
      expect(all).to.have.lengthOf(3)
      const keySet = all.map((r) => Object.keys(r).sort()).map((k) => k.join(','))
      const expectedKeySet = ['deviceKey', 'reason', 'registrantId', 'sequence', 'verdict', 'verifiedAt'].sort().join(',')
      for (const k of keySet) {
        // reason is optional and may be absent from the key set for pass rows —
        // compare against the union of possible shapes instead of exact equality.
        expect(expectedKeySet.includes(k) || k === ['deviceKey', 'registrantId', 'sequence', 'verdict', 'verifiedAt'].sort().join(',')).to.equal(true)
      }

      const narrowed = await mock.getAttestationVerdicts(registrantId, deviceKeyA)
      expect(narrowed).to.have.lengthOf(2)
      expect(narrowed.every((r) => r.deviceKey === deviceKeyA)).to.be.true

      // The mock holds no IAttestationVerifier and can therefore only ever
      // produce a 'pass' verdict from associate() — fail-path behavior is
      // proven against the real engine only (tests above).
      const deviceKey = nextDeviceKey()
      const challenge = await mock.issueAttestationChallenge('mock-assoc-registrant', deviceKey, { signerUserId: 'u', signerKey: 'k', signature: 's' })
      await mock.associate(
        { registrantId: 'mock-assoc-registrant', deviceKey, nonce: challenge.nonce, attestation: makeDeviceAttestation() },
        { signerUserId: 'u', signerKey: 'k', signature: 's' }
      )
      const mockVerdicts = await mock.getAttestationVerdicts('mock-assoc-registrant', deviceKey)
      expect(mockVerdicts).to.have.lengthOf(1)
      expect(mockVerdicts[0].verdict).to.equal('pass')
    })

    it('associate() with attestationRequired:false writes the association and NO verdict — the real engine\'s AttestationRequired=0 path', async () => {
      // 47-REVIEW IN-04. The real engine records no verdict at all when
      // ElectionAttestationPolicy.AttestationRequired = 0 (proven against the
      // real engine in the skip-verify test above). That is the common
      // non-attested path per Phase 45 D-14a, and it is exactly the state
      // VerdictBadge's "none" branch exists for. Before this option the mock
      // recorded a pass verdict unconditionally, so no mock-driven screen test
      // could reach "none" — and a green mock run could wrongly suggest that
      // branch was dead code. This locks the reachability.
      const mock = new MockAssociationEngine({ attestationRequired: false })
      const registrantId = nextRegistrantId()
      const deviceKey = nextDeviceKey()
      const sig: Signature = { signerUserId: 'u', signerKey: 'k', signature: 's' }

      const challenge = await mock.issueAttestationChallenge(registrantId, deviceKey, sig)
      await mock.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation: makeDeviceAttestation() }, sig)

      // The association itself is still written — only the verdict is skipped.
      expect(await mock.getAssociation(registrantId, deviceKey)).to.not.be.undefined
      expect(await mock.getAttestationVerdicts(registrantId, deviceKey)).to.deep.equal([])
      expect(await mock.getAttestationVerdicts(registrantId)).to.deep.equal([])
    })

    it('defaults to attestationRequired:true so no existing caller changes behavior', async () => {
      // The no-arg and explicit-true constructions must be indistinguishable;
      // every pre-IN-04 call site passes no options.
      const registrantId = nextRegistrantId()
      const deviceKey = nextDeviceKey()
      const sig: Signature = { signerUserId: 'u', signerKey: 'k', signature: 's' }

      for (const mock of [new MockAssociationEngine(), new MockAssociationEngine({}), new MockAssociationEngine({ attestationRequired: true })]) {
        const challenge = await mock.issueAttestationChallenge(registrantId, deviceKey, sig)
        await mock.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation: makeDeviceAttestation() }, sig)
        expect(await mock.getAttestationVerdicts(registrantId, deviceKey)).to.have.lengthOf(1)
      }
    })
  })
})
