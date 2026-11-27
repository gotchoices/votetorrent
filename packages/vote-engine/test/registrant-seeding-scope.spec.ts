/**
 * registrant-seeding-scope.spec.ts — Phase 48 Plan 30 (CR-01) + Plan 33 (CR-04)
 *
 * `seedRegistrantSignatureTasks` (signature-tasks-engine.ts) pulls EVERY pending
 * `RegistrationRequest` in the local DB with no authority predicate, and isolates only the
 * missing-`CurrentAdmin` case. Because D-02 deliberately makes intake unauthenticated, a single
 * request naming any locally-known `Authority` the signed-in officer does not serve fails
 * `AdminSigning.UserIdValid`, propagates out of the loop and out of `getRequestedSignatures`'s
 * try, and is rethrown — permanently disabling `TasksScreen` for that officer, for ALL signature
 * types, re-firing on every mount because the offending row stays `'p'`.
 *
 * The first `describe` below (CR-01) proves three things against the REAL Quereus schema and the
 * REAL engine:
 *   1. scope   — a request addressed to an authority the signed-in officer does not serve is
 *                never seeded, and never blocks a request at the officer's own authority.
 *   2. isolation — a per-row failure never aborts the batch; the failure is transient, not
 *                permanent.
 *   3. inbox availability — getRequestedSignatures(true) resolves and still returns every other
 *                signature type's tasks while an un-seedable request is pending.
 *
 * The second `describe` below (CR-04) proves the fix for a defect round 2's own CR-01 fix
 * introduced: the per-row `try { ... } catch { continue }` envelope also swallows a failed
 * `ROLLBACK`, which — because Quereus's transaction model is flat and handle-global — leaves the
 * shared `Database` handle mid-transaction for the rest of the session, with zero telemetry. It
 * proves four things against the SAME real schema and real engine:
 *   4. recovery  — a failed `ROLLBACK` gets one bounded recovery attempt, and the shared handle is
 *                usable again afterwards (a subsequent `BEGIN` on it succeeds).
 *   5. telemetry — every pass returns an identifier-free tally that distinguishes a skipped row
 *                from an empty inbox, and the ORDINARY per-row skip (not the aborted case) is
 *                proven to recover on the next pull.
 *   6. the residual — a DOUBLY-unrecoverable `ROLLBACK` (the row's own ROLLBACK and the engine's
 *                single bounded recovery attempt both fail) stops the pass instead of continuing
 *                onto a handle whose transaction state is unknown; that stuck state is bounded and
 *                telemetered but explicitly NOT self-healing — no pull recovers it, and none is
 *                asserted to.
 *   7. serialization — two overlapping `getRequestedSignatures(true)` calls on the SAME handle
 *                (the badge and the screen's real shape) seed each pending request exactly once,
 *                never twice and never zero times.
 *
 * NOT proven here: that TasksScreen renders on a device, that the new scoping predicate matches a
 * real device's Officer/CurrentAdmin history (both 48-32's concern), that a `ROLLBACK` fails in
 * practice on a real LevelDB-backed handle (the CR-04 tests force it), or that the tally has any
 * UI consumer this round — it does not, by design.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import {
  createTestNetwork,
  addTestAuthority,
  addTestElection,
  seedAuthorityInvite,
  seedUserInvite,
  seedProposedBallot,
  makeDistinctTestUser,
  addSiblingAuthority,
  provisionTestIntakeRecipient,
} from './fixtures/test-context.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { TestKeyPair } from './fixtures/keys.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { UserEngine } from '../src/user/user-engine.js'
import type { EngineContext } from '../src/types.js'
import type {
  RegisterInit,
  RegistrationRequestInit,
  BallotSignatureTask,
  SignatureTask,
  Signature,
  Scope,
  User,
} from '@votetorrent/vote-core'

// ---------------------------------------------------------------------------
// Module-level helpers — mirrors registrant-approval.spec.ts's module-local set
// (that spec keeps its own copies module-local; not exported for reuse).
// ---------------------------------------------------------------------------

function makeNetworkRef () {
  return {
    hash: 'test-registrant-seeding-scope-hash',
    name: 'Test Network',
    relays: [] as string[],
    primaryAuthorityDomainName: 'test.example',
  }
}

async function setup (): Promise<TestAuthorityContext> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  // D-49 (62-31): submitPendingRequest below drives the real (now-sealed) submitRegistrationRequest
  // against auth.authority.id — a single provisioning call here covers that address; call sites
  // that address a FOREIGN or SIBLING authority provision that authority separately (see below).
  await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
  return auth
}

/**
 * D-49: registers `foreignUser`'s intake encryption key for `foreignAuthorityId` so a request
 * addressed there can be sealed — `foreignUser` is a genuine officer of that authority
 * (`createForeignAuthority`), but is NOT `ctx.user` on the fixture's own `auth.ctx`, so a throwaway
 * ctx object (sharing the same `db`) is built here rather than mutating `auth.ctx`.
 */
async function provisionForeignIntakeRecipient (auth: TestAuthorityContext, foreignAuthorityId: string, foreignUser: User): Promise<void> {
  const foreignCtx = { db: auth.ctx.db, user: foreignUser }
  // `UserEncryptionKey.SignerIsUser` is a hard EXISTS check against UserKey — `foreignUser` (seeded
  // via `createForeignAuthority`'s raw `insert into User`) has no UserKey row by default (only the
  // founder gets one from genesis). Bootstrap one for real first (62-14-SUMMARY's own documented
  // pattern), then register the intake key.
  await new UserEngine({ ...foreignUser, activeKeys: [] }, foreignCtx).addKey(foreignUser.activeKeys[0]!)
  await provisionTestIntakeRecipient(foreignCtx, foreignAuthorityId)
}

/**
 * WR-10 prehash contract: `secp256k1.sign(digest, priv)` with NO explicit `prehash` option,
 * relying on @noble/curves v2's default (`prehash:true`) — matches
 * `registrant-approval.spec.ts`'s own helper. Deliberately returns `signerUserId: ''` — a
 * prospective registrant has no user id.
 */
function makeCallbackSigner (keyPair: TestKeyPair): (digest: Uint8Array) => Promise<Signature> {
  const privBytes = hexToBytes(keyPair.privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signature: bytesToHex(sig), signerKey: keyPair.publicHex, signerUserId: '' }
  }
}

function makeTestPayload (authorityId: string, registrantId?: string): RegisterInit {
  return {
    registrant: {
      id: registrantId ?? crypto.randomUUID(),
      authorityId,
      expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000),
    },
    private: {
      expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000),
      details: [],
    },
  }
}

/**
 * Submits one pending RegistrationRequest through the REAL engine method (D-02 intake, 48-07).
 * Unlike registrant-approval.spec.ts's version, this accepts an explicit `authorityId` override
 * so a request can be addressed to an authority OTHER than `auth.authority.id` — the CR-01 case.
 * Forward-compat with 48-31 (payload.registrant.authorityId must equal the request's
 * AuthorityId): `makeTestPayload` is always called with the SAME `authorityId`.
 */
async function submitPendingRequest (
  auth: TestAuthorityContext,
  opts?: {
    authorityId?: string
    issuerType?: 'registrant' | 'bridge'
    bridgeId?: string
    requesterKey?: TestKeyPair
    registrantId?: string
  }
): Promise<{ requestId: string; requester: TestKeyPair; init: RegistrationRequestInit }> {
  const requester = opts?.requesterKey ?? randomTestKeyPair()
  const authorityId = opts?.authorityId ?? auth.authority.id
  const engine = new RegistrationEngine(auth.ctx)
  const init: RegistrationRequestInit = {
    id: crypto.randomUUID(),
    authorityId,
    payload: makeTestPayload(authorityId, opts?.registrantId),
    submittedAt: toIsoZDatetime(Date.now()),
    issuerType: opts?.issuerType,
    bridgeId: opts?.bridgeId,
  }
  const requestId = await engine.submitRegistrationRequest(init, requester.publicHex, makeCallbackSigner(requester))
  return { requestId, requester, init }
}

async function countRows (ctx: EngineContext, sql: string, params: Record<string, unknown> = {}): Promise<number> {
  const row = await ctx.db.prepare(sql).get(params as Record<string, unknown>)
  return Number(row?.n ?? 0)
}

async function extensionCount (ctx: EngineContext, requestId: string): Promise<number> {
  return countRows(
    ctx,
    `select count(*) as n from RegistrantSignatureTaskExtension E
       join RegistrationRequest R on R.Id = E.RequestId
       where R.Id = :requestId`,
    { requestId }
  )
}

/**
 * Materializes a SECOND, genuinely foreign authority: a real `User` row for a brand-new officer
 * (via the `seedUserInvite` recipe, test/user.spec.ts:142-160), a real authority-invite ceremony
 * (`seedAuthorityInvite`, mirroring test/registration.spec.ts:830-850's "Forger Authority"
 * recipe), and a `createAuthority` call issued through a NetworkEngine bound to the FOREIGN
 * user's own EngineContext — NOT `auth`'s.
 *
 * `NetworkEngine.createAuthority` binds every inserted Officer row's UserId to `ctx.user.id` of
 * WHOEVER CALLS IT (a real, documented v1.2 limitation — `OfficerInit` carries no per-officer
 * userId), so routing the call through `auth.networkEngine` (as the Forger-Authority recipe does
 * verbatim) would make `auth.user` an officer of the new authority too — the OPPOSITE of what
 * this suite needs. `networksEngine.open(ref, foreignUser, false)` returns a NetworkEngine bound
 * to a fresh EngineContext sharing the SAME underlying `db`, with `ctx.user = foreignUser` — that
 * is the context this helper uses for the `createAuthority` call, so the foreign authority's real
 * Officer row lands under `foreignUser.id`, and `auth.user` never becomes an officer there.
 */
async function createForeignAuthority (
  auth: TestAuthorityContext
): Promise<{ foreignAuthorityId: string; foreignUser: User }> {
  const foreignUser = makeDistinctTestUser()

  // Seed the foreign officer's real User row (test/user.spec.ts:142-160 recipe).
  const { inviteSlotCid, inviteSignature } = await seedUserInvite(auth, foreignUser)
  const userTid = Date.now() + Math.floor(Math.random() * 100_000)
  await auth.ctx.db.exec(
    `insert into User (Id, Name, ImageRef)
     with context SigningNonce = null, InviteSlotCid = :inviteSlotCid, InviteSignature = :inviteSignature, Tid = ${userTid}
     values (:userId, :userName, :userImageRef)`,
    {
      userId: foreignUser.id,
      userName: foreignUser.name,
      userImageRef: foreignUser.imageRef ? JSON.stringify(foreignUser.imageRef) : null,
      inviteSlotCid,
      inviteSignature,
    }
  )

  // Real authority-invite ceremony naming the foreign officer (test/registration.spec.ts:830-850).
  const inviteCtx = await seedAuthorityInvite(auth, {
    name: 'Foreign Authority',
    domainName: 'foreign.example.com',
    officers: [{ userId: foreignUser.id, title: 'Chair', scopes: JSON.stringify(['rad']) }],
  })

  // Route createAuthority through the FOREIGN user's own context (see doc comment above) so the
  // real Officer row this inserts is bound to foreignUser.id, not auth.user.id.
  const foreignNetworkEngine = await auth.networksEngine.open(auth.ref, foreignUser, false)
  await foreignNetworkEngine.createAuthority(
    { name: 'Foreign Authority', domainName: 'foreign.example.com' },
    {
      officers: [{ init: { name: 'Foreign Officer', title: 'Chair', scopes: ['rad'] as Scope[] } }],
      effectiveAt: inviteCtx.adminEffectiveAt,
      thresholdPolicies: [{ policy: 'rad', threshold: 1 }],
    },
    { inviteSlotCid: inviteCtx.inviteSlotCid, inviteSignature: 'a'.repeat(128) }
  )

  const forgerRow = await auth.ctx.db
    .prepare('select Id from Authority where Name = :n')
    .get({ n: 'Foreign Authority' })
  const foreignAuthorityId = forgerRow!.Id as string
  expect(foreignAuthorityId).to.be.a('string').and.not.equal(auth.authority.id)

  return { foreignAuthorityId, foreignUser }
}

// ---------------------------------------------------------------------------

describe('registrant task seeding — authority scope and per-row isolation (CR-01)', () => {
  it('does not seed a request addressed to an authority the signed-in officer does not serve', async () => {
    const auth = await setup()
    const selfUserId = auth.user.id

    const { foreignAuthorityId, foreignUser } = await createForeignAuthority(auth)
    await provisionForeignIntakeRecipient(auth, foreignAuthorityId, foreignUser)

    // Fixture-integrity assertions — these must hold BEFORE any behavioural assertion is made.
    const officerCount = await countRows(
      auth.ctx,
      'select count(*) as n from Officer where AuthorityId = :authorityId and UserId = :userId',
      { authorityId: foreignAuthorityId, userId: selfUserId }
    )
    expect(officerCount, 'fixture integrity: the signed-in officer must NOT be an Officer at the foreign authority').to.equal(0)

    const currentAdminCount = await countRows(
      auth.ctx,
      'select count(*) as n from CurrentAdmin where AuthorityId = :authorityId',
      { authorityId: foreignAuthorityId }
    )
    expect(currentAdminCount, 'fixture integrity: the foreign authority must have exactly one CurrentAdmin row').to.equal(1)

    // One pending request at the foreign authority, one at the officer's own authority.
    const { requestId: foreignRequestId } = await submitPendingRequest(auth, { authorityId: foreignAuthorityId })
    const { requestId: ownRequestId } = await submitPendingRequest(auth, { authorityId: auth.authority.id })

    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    let rejected = false
    let rejectionMessage = ''
    try {
      await engine.getRequestedSignatures(true)
    } catch (err) {
      rejected = true
      rejectionMessage = err instanceof Error ? err.message : String(err)
    }
    expect(
      rejected,
      `getRequestedSignatures(true) must resolve, not reject, while a foreign-authority request is pending (got: ${rejectionMessage})`
    ).to.be.false

    const ownCount = await extensionCount(auth.ctx, ownRequestId)
    expect(ownCount, 'the own-authority request must be seeded exactly once').to.equal(1)

    const foreignCount = await extensionCount(auth.ctx, foreignRequestId)
    expect(foreignCount, 'the foreign-authority request must never be seeded').to.equal(0)

    const foreignStatusRow = await auth.ctx.db
      .prepare('select Status from RegistrationRequest where Id = :id')
      .get({ id: foreignRequestId })
    expect(foreignStatusRow?.Status, 'the foreign-authority request must remain pending').to.equal('p')

    const foreignAdminSigningCount = await countRows(
      auth.ctx,
      "select count(*) as n from AdminSigning where AuthorityId = :authorityId and Scope = 'vrg'",
      { authorityId: foreignAuthorityId }
    )
    expect(foreignAdminSigningCount, 'no AdminSigning attempt may ever be made at the foreign authority').to.equal(0)
  })

  it('isolates a per-row failure so the remaining pending requests still seed', async () => {
    const auth = await setup()
    const { requestId: id1 } = await submitPendingRequest(auth)
    const { requestId: id2 } = await submitPendingRequest(auth)

    const dbHandle = auth.ctx.db as unknown as { exec: (sql: string, params?: Record<string, unknown>) => Promise<unknown> }
    const origExec = dbHandle.exec.bind(auth.ctx.db)
    let faulted = false
    dbHandle.exec = async (sql: string, params?: Record<string, unknown>): Promise<unknown> => {
      if (!faulted && sql.includes('insert into AdminSigning')) {
        faulted = true
        dbHandle.exec = origExec
        throw new Error('forced per-row seeding fault')
      }
      return origExec(sql, params)
    }

    try {
      const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
      let rejected = false
      let rejectionMessage = ''
      try {
        await engine.getRequestedSignatures(true)
      } catch (err) {
        rejected = true
        rejectionMessage = err instanceof Error ? err.message : String(err)
      }
      expect(
        rejected,
        `getRequestedSignatures(true) must resolve even with a forced per-row fault (got: ${rejectionMessage})`
      ).to.be.false

      const firstPullCount = (await extensionCount(auth.ctx, id1)) + (await extensionCount(auth.ctx, id2))
      expect(firstPullCount, 'exactly one of the two pending requests must seed on the SAME call as the fault').to.equal(1)

      // Second pull, no fault installed — the failed row must seed now (transient, not permanent).
      await engine.getRequestedSignatures(true)
      const secondPullCount1 = await extensionCount(auth.ctx, id1)
      const secondPullCount2 = await extensionCount(auth.ctx, id2)
      expect(secondPullCount1, 'request 1 must be seeded by the second, unfaulted pull').to.equal(1)
      expect(secondPullCount2, 'request 2 must be seeded by the second, unfaulted pull').to.equal(1)
    } finally {
      dbHandle.exec = origExec
    }
  })

  it('keeps every other signature type visible while an unseedable request is pending', async () => {
    const auth = await setup()
    const elec = await addTestElection(auth)
    const { ballotId } = await seedProposedBallot(elec)
    await elec.electionEngine.submitBallotForConfirmation(ballotId)

    const { foreignAuthorityId, foreignUser } = await createForeignAuthority(elec)
    await provisionForeignIntakeRecipient(elec, foreignAuthorityId, foreignUser)
    await submitPendingRequest(elec, { authorityId: foreignAuthorityId })

    const engine = new SignatureTasksEngine(makeNetworkRef(), elec.ctx)
    const tasks: SignatureTask[] = await engine.getRequestedSignatures(true)

    const ballotTask = tasks.find(
      (t) => t.signatureType === 'ballot' && (t as BallotSignatureTask).ballot.proposed.id === ballotId
    ) as BallotSignatureTask | undefined
    expect(
      ballotTask,
      'the ballot signature task must still be visible while a foreign-authority request sits unseedable'
    ).to.not.be.undefined
    expect(ballotTask?.ballot.proposed.id).to.equal(ballotId)
  })
})

// ---------------------------------------------------------------------------
// CR-04 — rollback recovery, skip telemetry and pass serialization.
// ---------------------------------------------------------------------------

/**
 * The tally is a new public field this suite must read BEFORE it exists (Task 1 is RED-first), so
 * read it structurally rather than through an import that would not compile pre-fix. This makes
 * every RED failure a behavioural chai assertion (`expected undefined to not be undefined`), never
 * a TypeScript compile error.
 */
type SeedOutcomeProbe = {
  considered: number
  seeded: number
  skipped: number
  aborted: boolean
  handleInAutocommit: boolean
}

function lastSeedOutcome (engine: SignatureTasksEngine): SeedOutcomeProbe | undefined {
  return (engine as unknown as { lastSeedOutcome?: SeedOutcomeProbe }).lastSeedOutcome
}

interface SeedFaultOptions {
  failFirstAdminSigningInsert: boolean
  rollbackFailures: number
}

/**
 * A two-stage fault injector, written once and reused across Tests 4, 5 and 6 — extends the
 * existing one-shot idiom above (the CR-01 "isolates a per-row failure" test) into a reusable,
 * two-axis form: it can fault the FIRST `insert into AdminSigning` (the ordinary per-row failure
 * CR-01 already exercises) and/or the first N `ROLLBACK` calls (the CR-04 recovery path), in any
 * combination, so a single helper drives every fault shape this describe block needs.
 */
function installSeedFaultInjector (
  auth: TestAuthorityContext,
  opts: SeedFaultOptions
): { restore: () => Promise<void> } {
  const dbHandle = auth.ctx.db as unknown as { exec: (sql: string, params?: Record<string, unknown>) => Promise<unknown> }
  const origExec = dbHandle.exec.bind(auth.ctx.db)
  let adminSigningArmed = opts.failFirstAdminSigningInsert
  let rollbackFailuresRemaining = opts.rollbackFailures
  let restored = false
  dbHandle.exec = async (sql: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (adminSigningArmed && sql.includes('insert into AdminSigning')) {
      adminSigningArmed = false
      throw new Error('forced per-row seeding fault')
    }
    if (rollbackFailuresRemaining > 0 && sql.trim() === 'ROLLBACK') {
      rollbackFailuresRemaining--
      throw new Error('forced rollback fault')
    }
    return origExec(sql, params)
  }
  return {
    restore: async (): Promise<void> => {
      if (restored) return
      restored = true
      dbHandle.exec = origExec
      try {
        await origExec('ROLLBACK')
      } catch {
        // Best-effort — a genuinely stuck handle (Test 6's doubly-unrecoverable case) must never
        // leak into another assertion in the same test.
      }
    },
  }
}

/**
 * Test 7 needs two logically-concurrent passes to genuinely INTERLEAVE their BEGIN/COMMIT
 * envelopes on the SAME handle, not merely be invoked concurrently. Empirically, without this
 * forcer, Node's microtask scheduling combined with this engine's promise-only (no real I/O)
 * async chain lets the first-invoked pass run to full completion before the second pass's
 * continuation advances past its own first read — so the race Test 7 exists to catch never
 * manifests, and the test would pass whether or not the fix is applied. Forcing a genuine
 * macrotask-level event-loop yield before every `BEGIN` gives the OTHER pass a real opportunity
 * to interleave, reproducing the concurrency the badge (`useTaskCount.fetchCount`) and the screen
 * (`TasksScreen`'s focus effect) can trigger for real. This is a TEST-HARNESS timing aid only —
 * it does not change what SQL either pass issues.
 */
function installBeginYieldForcer (auth: TestAuthorityContext): { restore: () => void } {
  const dbHandle = auth.ctx.db as unknown as { exec: (sql: string, params?: Record<string, unknown>) => Promise<unknown> }
  const origExec = dbHandle.exec.bind(auth.ctx.db)
  dbHandle.exec = async (sql: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (sql === 'BEGIN') {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    return origExec(sql, params)
  }
  return {
    restore: () => {
      dbHandle.exec = origExec
    },
  }
}

describe('registrant task seeding — rollback recovery, skip telemetry and pass serialization (CR-04)', () => {
  it('leaves the shared Database handle usable after a failed ROLLBACK', async () => {
    const auth = await setup()
    await submitPendingRequest(auth)
    await submitPendingRequest(auth)
    await submitPendingRequest(auth)

    const injector = installSeedFaultInjector(auth, { failFirstAdminSigningInsert: true, rollbackFailures: 1 })
    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    try {
      let rejected = false
      let rejectionMessage = ''
      try {
        await engine.getRequestedSignatures(true)
      } catch (err) {
        rejected = true
        rejectionMessage = err instanceof Error ? err.message : String(err)
      }
      expect(
        rejected,
        `getRequestedSignatures(true) must resolve even when a ROLLBACK fails (got: ${rejectionMessage})`
      ).to.be.false

      // With the injector restored, the shared handle's actual state — not the fault harness's —
      // is what the recovery path must leave usable.
      await injector.restore()

      expect(
        auth.ctx.db.getAutocommit(),
        'the shared Database handle must be back in autocommit after the engine\'s own bounded ROLLBACK recovery'
      ).to.be.true
      let beginThrew = false
      try {
        await auth.ctx.db.exec('BEGIN')
      } catch {
        beginThrew = true
      }
      expect(
        beginThrew,
        'db.exec("BEGIN") on the SAME handle must succeed after a failed ROLLBACK — the verifier\'s literal requirement'
      ).to.be.false
      await auth.ctx.db.exec('ROLLBACK')

      const outcome = lastSeedOutcome(engine)
      expect(outcome, 'the engine must expose a tally after the pass').to.not.be.undefined
      expect(
        outcome!.aborted,
        'a failed ROLLBACK stops the pass even when the bounded recovery attempt itself succeeds'
      ).to.be.true
      expect(
        outcome!.handleInAutocommit,
        'the tally must report the handle is back in autocommit when the bounded recovery succeeded'
      ).to.be.true
    } finally {
      await injector.restore()
    }
  })

  it('reports an identifier-free tally that distinguishes a skipped row from an empty inbox', async () => {
    const auth = await setup()
    const { requestId: id1 } = await submitPendingRequest(auth)
    const { requestId: id2 } = await submitPendingRequest(auth)

    const injector = installSeedFaultInjector(auth, { failFirstAdminSigningInsert: true, rollbackFailures: 0 })
    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    try {
      await engine.getRequestedSignatures(true)

      const outcome = lastSeedOutcome(engine)
      expect(outcome, 'the engine must expose a tally after the pass').to.not.be.undefined
      expect(outcome, 'the tally must be exactly this shape after one ordinary per-row failure among two considered rows').to.deep.equal({
        considered: 2,
        seeded: 1,
        skipped: 1,
        aborted: false,
        handleInAutocommit: true,
      })

      const serialized = JSON.stringify(outcome)
      expect(serialized, 'the tally must never carry the first request id — D-02 intake is unauthenticated').to.not.include(id1)
      expect(serialized, 'the tally must never carry the second request id — D-02 intake is unauthenticated').to.not.include(id2)
      for (const [field, value] of Object.entries(outcome!)) {
        expect(['number', 'boolean'], `tally field "${field}" must be a number or boolean, never a string identifier`).to.include(typeof value)
      }

      await injector.restore()

      // Second, unfaulted pull — the SOLE evidence in this suite that recovery happens after an
      // ORDINARY per-row skip (aborted === false). It says NOTHING about Test 6's aborted (break)
      // path — that path's non-recovery is asserted separately, and deliberately not here.
      await engine.getRequestedSignatures(true)
      const secondOutcome = lastSeedOutcome(engine)
      expect(secondOutcome!.skipped, 'the row skipped on the first pull must be retried and seeded on this unfaulted pull').to.equal(0)
      expect(secondOutcome!.seeded, 'exactly the one previously-skipped row seeds on this pull').to.equal(1)

      expect(await extensionCount(auth.ctx, id1), 'request 1 must have exactly one extension row after both pulls — the lock did not wedge').to.equal(1)
      expect(await extensionCount(auth.ctx, id2), 'request 2 must have exactly one extension row after both pulls — the lock did not wedge').to.equal(1)
    } finally {
      await injector.restore()
    }
  })

  it('stops the pass instead of continuing when the ROLLBACK cannot be recovered', async () => {
    const auth = await setup()
    const { requestId: id1 } = await submitPendingRequest(auth)
    const { requestId: id2 } = await submitPendingRequest(auth)
    const { requestId: id3 } = await submitPendingRequest(auth)

    const injector = installSeedFaultInjector(auth, { failFirstAdminSigningInsert: true, rollbackFailures: 2 })
    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    try {
      let rejected = false
      let rejectionMessage = ''
      try {
        await engine.getRequestedSignatures(true)
      } catch (err) {
        rejected = true
        rejectionMessage = err instanceof Error ? err.message : String(err)
      }
      expect(
        rejected,
        `getRequestedSignatures(true) must resolve even when BOTH the row's ROLLBACK and the recovery attempt fail (got: ${rejectionMessage})`
      ).to.be.false

      const outcome = lastSeedOutcome(engine)
      expect(outcome, 'the engine must expose a tally after the pass').to.not.be.undefined
      expect(outcome!.aborted, 'a doubly-unrecoverable ROLLBACK stops the pass').to.be.true
      expect(
        outcome!.handleInAutocommit,
        'the handle must be reported mid-transaction — the residual this plan bounds and telemeters rather than hides'
      ).to.be.false
      expect(outcome!.considered, 'all three pending requests were in the work set').to.equal(3)
      expect(outcome!.seeded, 'no row committed before the abort').to.equal(0)
      expect(
        outcome!.seeded + outcome!.skipped,
        'seeded + skipped must be strictly less than considered, proving the remaining rows were never attempted on a handle whose transaction state is unknown'
      ).to.be.lessThan(outcome!.considered)

      const total = (await extensionCount(auth.ctx, id1)) + (await extensionCount(auth.ctx, id2)) + (await extensionCount(auth.ctx, id3))
      expect(total, 'no RegistrantSignatureTaskExtension row may exist for any of the three requests').to.equal(0)
    } finally {
      // This cleanup IS the external reset the must-haves name: the engine does not self-heal from
      // a doubly-unrecoverable ROLLBACK, so a real caller would remain stuck until something
      // OUTSIDE the seed pass clears the transaction or the handle is replaced. Deliberately NOT
      // asserting a recovering second pull here — there is nothing in the code that recovers it.
      await injector.restore()
    }
  })

  it('serializes concurrent seed passes on the same handle', async () => {
    const auth = await setup()
    const { requestId: id1 } = await submitPendingRequest(auth)
    const { requestId: id2 } = await submitPendingRequest(auth)
    const { requestId: id3 } = await submitPendingRequest(auth)

    // The badge (useTaskCount.fetchCount) and the screen (TasksScreen's focus effect) are exactly
    // this shape — two independent SignatureTasksEngine instances over the SAME ctx.db.
    const e1 = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    const e2 = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)

    // Force a genuine event-loop interleaving opportunity around every BEGIN — see the forcer's
    // doc comment for why this is necessary for the race to manifest at all in this harness.
    const forcer = installBeginYieldForcer(auth)
    let rejected = false
    let rejectionMessage = ''
    try {
      try {
        await Promise.all([e1.getRequestedSignatures(true), e2.getRequestedSignatures(true)])
      } catch (err) {
        rejected = true
        rejectionMessage = err instanceof Error ? err.message : String(err)
      }
    } finally {
      forcer.restore()
    }
    expect(rejected, `both overlapping seed passes must resolve (got: ${rejectionMessage})`).to.be.false

    for (const id of [id1, id2, id3]) {
      const count = await extensionCount(auth.ctx, id)
      expect(
        count,
        `request ${id} must have EXACTLY ONE extension row — a duplicate row or a row left unseeded are both failure directions, since RequestId carries only a non-unique index`
      ).to.equal(1)
    }

    expect(lastSeedOutcome(e1)?.aborted, 'engine 1\'s pass must not abort').to.not.equal(true)
    expect(lastSeedOutcome(e2)?.aborted, 'engine 2\'s pass must not abort').to.not.equal(true)
    expect(
      auth.ctx.db.getAutocommit(),
      'the shared handle must be back in autocommit after both overlapping passes complete'
    ).to.be.true
  })

  it('WR-22: a request addressed to an authority where this officer holds no vrg scope is NOT seeded, while a vrg-scoped one is', async () => {
    const auth = await setup()

    // Two REAL sibling authorities in the SAME database. `auth.user` is a genuine officer of BOTH
    // — the only difference is the scope set, which is exactly the variable under test. Before
    // WR-22 the seed predicate tested Officer MEMBERSHIP only and never read Officer.Scopes, so
    // both requests below seeded identically and any officer of any scope could go on to mint a
    // Registrant single-handedly (AdminSigning.UserIdValid never reads Scopes;
    // AdminSigning.SignerKeyValid and OfficerSignature.OfficerValid are hardcoded stubs; and
    // SigningEngine.sign's threshold falls back to 1 with no declared 'vrg' policy).
    const scopedAuthorityId = await addSiblingAuthority(auth, {
      name: 'Vrg Scoped Authority',
      domainName: 'vrg-scoped.example.com',
      scopes: ['rad', 'vrg'] as Scope[],
    })
    const unscopedAuthorityId = await addSiblingAuthority(auth, {
      name: 'Rad Only Authority',
      domainName: 'rad-only.example.com',
      scopes: ['rad'] as Scope[],
    })
    await provisionTestIntakeRecipient(auth.ctx, scopedAuthorityId)
    await provisionTestIntakeRecipient(auth.ctx, unscopedAuthorityId)

    // Fixture integrity — assert the premise instead of assuming it: the officer must genuinely be
    // an officer at BOTH, so a non-seed can only be attributable to the scope.
    for (const authorityId of [scopedAuthorityId, unscopedAuthorityId]) {
      const officerCount = await countRows(
        auth.ctx,
        'select count(*) as n from Officer where AuthorityId = :authorityId and UserId = :userId',
        { authorityId, userId: auth.user.id }
      )
      expect(officerCount, `the officer must be a real Officer at ${authorityId}`).to.be.greaterThan(0)
    }

    const { requestId: scopedRequestId } = await submitPendingRequest(auth, { authorityId: scopedAuthorityId })
    const { requestId: unscopedRequestId } = await submitPendingRequest(auth, { authorityId: unscopedAuthorityId })

    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    let rejected = false
    let rejectionMessage = ''
    try {
      await engine.getRequestedSignatures(true)
    } catch (err) {
      rejected = true
      rejectionMessage = err instanceof Error ? err.message : String(err)
    }
    expect(rejected, `the pull must resolve normally (got: ${rejectionMessage})`).to.be.false

    expect(
      await extensionCount(auth.ctx, scopedRequestId),
      'a request at an authority where the officer HOLDS vrg must still seed — the gate must not blank the inbox wholesale'
    ).to.equal(1)
    expect(
      await extensionCount(auth.ctx, unscopedRequestId),
      "a request at an authority where the officer holds only 'rad' must NOT be seeded"
    ).to.equal(0)

    // And the un-seeded row is EXCLUDED from the work set, not skipped inside it — the scope test
    // lives in the collection predicate, so it must never cost a Tid or a DB round trip per pull.
    const outcome = lastSeedOutcome(engine)
    expect(outcome!.considered, 'only the vrg-scoped request may enter the work set').to.equal(1)
    expect(outcome!.seeded, 'and it seeds').to.equal(1)
    expect(outcome!.skipped, 'the unscoped request is filtered out, never attempted and skipped').to.equal(0)
  })

  it('WR-23: a failure of the work-set COLLECTION query is reported as an aborted pass, not rethrown out of getRequestedSignatures', async () => {
    const auth = await setup()
    await submitPendingRequest(auth)

    // Fault the seed pass's own collection `eval` — identified by the CR-01 scoping predicate's
    // Officer/CurrentAdmin join, which no other query in this engine issues. Every OTHER `eval` on
    // this handle (including getRequestedSignatures' own base task-row read, further down the same
    // call) is left untouched, so this test isolates exactly the statement WR-23 named.
    const dbHandle = auth.ctx.db as unknown as {
      eval: (sql: string, params?: Record<string, unknown>) => AsyncIterable<Record<string, unknown>>
    }
    const origEval = dbHandle.eval.bind(auth.ctx.db)
    dbHandle.eval = (sql: string, params?: Record<string, unknown>) => {
      if (sql.includes('from RegistrationRequest R') && sql.includes('join CurrentAdmin CA')) {
        throw new Error('forced work-set collection fault')
      }
      return origEval(sql, params)
    }

    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    try {
      let rejected = false
      let rejectionMessage = ''
      let tasks: SignatureTask[] = []
      try {
        tasks = await engine.getRequestedSignatures(true)
      } catch (err) {
        rejected = true
        rejectionMessage = err instanceof Error ? err.message : String(err)
      }

      // Pre-fix this rejected: the error escaped runRegistrantSeedPass, rejected the seedPassLocks
      // chain's `next`, and getRequestedSignatures' outer catch rethrew it — CR-01's blank-inbox
      // failure mode for this one call.
      expect(
        rejected,
        `a collection-query failure must not reject getRequestedSignatures (got: ${rejectionMessage})`
      ).to.be.false
      expect(tasks, 'the call must still return a task array, not undefined').to.be.an('array')

      // And it must be REPORTED, not silently swallowed — the CR-04 distinction.
      const outcome = lastSeedOutcome(engine)
      expect(outcome, 'the engine must expose a tally even when collection failed').to.not.be.undefined
      expect(outcome!.aborted, 'a collection failure is an aborted pass').to.be.true
      expect(outcome!.considered, 'a partial work set must not be reported as if it were the whole set').to.equal(0)
      expect(outcome!.seeded, 'nothing can have been seeded from a work set that was never collected').to.equal(0)

      // The mutex is not wedged: with the fault removed, the next pass runs normally.
      dbHandle.eval = origEval
      await engine.getRequestedSignatures(true)
      const recovered = lastSeedOutcome(engine)
      expect(recovered!.aborted, 'the following pass must run normally once the fault is removed').to.be.false
      expect(recovered!.seeded, 'the pending request seeds on the recovered pass').to.equal(1)
    } finally {
      dbHandle.eval = origEval
    }
  })
})
