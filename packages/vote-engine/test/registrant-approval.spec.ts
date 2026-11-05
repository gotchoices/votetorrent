/**
 * registrant-approval.spec.ts — Phase 48 Plan 11 (D-05, D-07)
 *
 * Proves the registrant approval ceremony — "the point of the entire phase" — end-to-end against
 * the REAL Quereus schema with REAL secp256k1 signatures: seeding (pull-and-seed, idempotent),
 * materialization (parsed payload, submittedAt, issuerType, bridge label), disambiguation
 * (requestId-scoped getSignatureDigest/completeSignature, L-3), the unchanged register() outcome
 * (D-05), and D-07 tamper-evidence — that VerificationCid rides inside the SAME digest the
 * officer's key actually signs, so a post-hoc checklist edit changes the digest and would break
 * verification of the officer's own signature. No other spec in this repo proves that the
 * approval path drives RegistrationEngine.register() UNCHANGED from the officer side.
 */

import 'reflect-metadata'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { createTestNetwork, addTestAuthority, addTestElection, addSiblingAuthority, makeTestSignCallback, makeElectionInit, seedElectionSigning, provisionTestIntakeRecipient } from './fixtures/test-context.js'
import { ElectionsEngine, peekNextElectionTid } from '../src/elections/elections-engine.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { TestKeyPair } from './fixtures/keys.js'
import { digestToBytes } from '../src/utils.js'
import { toIsoZDatetime, reZuluDatetime } from '../src/signing/ceremony-helpers.js'
import { allocateTid } from '../src/database/tid-allocator.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import type { EngineContext } from '../src/types.js'
import { RegistrantAlreadyExistsError } from '@votetorrent/vote-core'
import type {
  RegisterInit,
  RegistrationRequestInit,
  RegistrationVerificationChecklistItem,
  RegistrantSignatureTask,
  SignatureTask,
  Signature,
} from '@votetorrent/vote-core'

type TestAuthority = Awaited<ReturnType<typeof addTestAuthority>>

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function makeNetworkRef () {
  return {
    hash: 'test-registrant-approval-hash',
    name: 'Test Network',
    relays: [] as string[],
    primaryAuthorityDomainName: 'test.example',
  }
}

async function setup (): Promise<TestAuthority> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  // D-49 (62-31): submitPendingRequest below drives the real (now-sealed) submitRegistrationRequest
  // — a single provisioning call here covers every call site in this file.
  await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
  return auth
}

/**
 * WR-10 prehash contract: `secp256k1.sign(digest, priv)` with NO explicit `prehash` option,
 * relying on @noble/curves v2's default (`prehash:true`) — matches
 * `authority-transport.spec.ts:31-40` and `registration-request.spec.ts`'s own helper.
 * Deliberately returns `signerUserId: ''` — a prospective registrant has no user id.
 */
function makeCallbackSigner (keyPair: TestKeyPair): (digest: Uint8Array) => Promise<Signature> {
  const privBytes = hexToBytes(keyPair.privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signature: bytesToHex(sig), signerKey: keyPair.publicHex, signerUserId: '' }
  }
}

function makeTestPayload (
  authorityId: string,
  registrantId?: string,
  payloadAuthorityId?: string,
  payloadElectionId?: string
): RegisterInit {
  return {
    registrant: {
      id: registrantId ?? crypto.randomUUID(),
      authorityId: payloadAuthorityId ?? authorityId,
      expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000),
    },
    // WR-20: also requester-chosen, and the switch that decides whether field policy runs at all.
    // Spread rather than assigned: an explicit `electionId: undefined` key survives in the
    // in-memory object but is dropped by JSON.stringify, so the payload round-trip assertion above
    // would fail on a key the submitter never sent.
    ...(payloadElectionId === undefined ? {} : { electionId: payloadElectionId }),
    private: {
      expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000),
      details: [],
    },
  }
}

/** The single Election row a fresh `addTestElection(auth)` seeded for this authority. */
async function resolveOneElectionId (ctx: EngineContext, authorityId: string): Promise<string> {
  const row = await ctx.db
    .prepare('select Id from Election where AuthorityId = :authorityId limit 1')
    .get({ authorityId })
  if (!row) throw new Error('resolveOneElectionId: no Election row for authority')
  return row.Id as string
}

/**
 * WR-20: adds a SECOND election at the same authority and returns its id. The second election
 * declares no `ElectionRegistrationField` rows — it is the "policy-free election of the same
 * authority" a requester could otherwise steer at to evade the first election's policy.
 */
async function addSecondElectionId (auth: TestAuthority): Promise<string> {
  // Deliberately NOT a second `addTestElection(auth)` call: `makeElectionInit`'s default id is the
  // fixed literal `'election-1'`, so a second call collides on `Election`'s primary key. Only the
  // `Election` row itself is needed here (the WR-20 gate joins `ElectionRegistrationField` to
  // `Election`), so the `ElectionRevision` half `addTestElection` also seeds is skipped.
  const electionsEngine = new ElectionsEngine(auth.ctx)
  const init = makeElectionInit({ id: `election-policy-free-${crypto.randomUUID()}`, authorityId: auth.authority.id })
  const tid = await peekNextElectionTid(auth.ctx.db)
  const { nonce } = await seedElectionSigning(auth.ctx, auth.authority.id, init, auth.user, tid)
  await electionsEngine.createElection(init, { signingNonce: nonce })
  return init.election.id
}

/** Submits one pending RegistrationRequest through the REAL engine method (D-02 intake, 48-07). */
async function submitPendingRequest (
  auth: TestAuthority,
  opts?: {
    issuerType?: 'registrant' | 'bridge'
    bridgeId?: string
    requesterKey?: TestKeyPair
    registrantId?: string
    /** CR-02: lets a caller submit a request addressed to auth.authority.id whose
     * payload.registrant.authorityId names a DIFFERENT authority — the adversarial shape
     * finalizeRegistrantApproval must refuse. */
    payloadAuthorityId?: string
    /** WR-20: lets a caller set (or omit) the requester-chosen `payload.electionId`. */
    payloadElectionId?: string
  }
): Promise<{ requestId: string; requester: TestKeyPair; init: RegistrationRequestInit }> {
  const requester = opts?.requesterKey ?? randomTestKeyPair()
  const engine = new RegistrationEngine(auth.ctx)
  const init: RegistrationRequestInit = {
    id: crypto.randomUUID(),
    authorityId: auth.authority.id,
    payload: makeTestPayload(auth.authority.id, opts?.registrantId, opts?.payloadAuthorityId, opts?.payloadElectionId),
    submittedAt: toIsoZDatetime(Date.now()),
    issuerType: opts?.issuerType,
    bridgeId: opts?.bridgeId,
  }
  const requestId = await engine.submitRegistrationRequest(init, requester.publicHex, makeCallbackSigner(requester))
  return { requestId, requester, init }
}

/** Registers one bridge key through the REAL D-03 registry ceremony (48-07). */
async function registerBridge (auth: TestAuthority, label: string): Promise<{ id: string; key: TestKeyPair }> {
  const key = randomTestKeyPair()
  const engine = new RegistrationEngine(auth.ctx)
  const id = crypto.randomUUID()
  await engine.registerBridgeKey({ id, authorityId: auth.authority.id, label, key: key.publicHex }, makeTestSignCallback(auth.user))
  return { id, key }
}

/** Finds the seeded RegistrantSignatureTask for a given requestId out of a pending pull. */
async function getRegistrantTask (engine: SignatureTasksEngine, requestId: string): Promise<RegistrantSignatureTask> {
  const tasks = await engine.getRequestedSignatures(true)
  const found = tasks.find(
    (t) => t.signatureType === 'registrant' && (t as RegistrantSignatureTask).requestId === requestId
  ) as RegistrantSignatureTask | undefined
  expect(found, `registrant task for requestId=${requestId} must be present`).to.not.be.undefined
  return found!
}

async function countRows (ctx: EngineContext, sql: string, params: Record<string, unknown> = {}): Promise<number> {
  const row = await ctx.db.prepare(sql).get(params as Record<string, unknown>)
  return Number(row?.n ?? 0)
}

/**
 * WR-19: the tables that can actually detect a spent officer signature. `AdminSigning` is written
 * at SEED time by `seedRegistrantSignatureTasks` — it exists whether or not the officer's signature
 * was ever consumed, so an unchanged `AdminSigning` count proves only that `seedSignedMutation` did
 * not run, nothing about `signingEngine.sign()`. `OfficerSignature`/`AdminSignature` are written at
 * SIGN time by `SigningEngine.sign` — only THOSE tables can show whether a refused approval burned
 * the officer's real signature. Resolves the task's `SigningNonce` for `requestId` via the same join
 * `completeSignature`/`finalizeRegistrantApproval` use, then counts each table by that nonce.
 */
async function signatureRowCounts (
  auth: TestAuthority,
  requestId: string
): Promise<{ nonce: string; officer: number; admin: number }> {
  const taskRow = await auth.ctx.db
    .prepare(
      `select Task.SigningNonce from Task join RegistrantSignatureTaskExtension E on E.TaskId = Task.Id where E.RequestId = :requestId`
    )
    .get({ requestId })
  expect(taskRow, `a seeded task must exist for requestId=${requestId}`).to.not.be.undefined
  const nonce = taskRow!.SigningNonce as string
  const officer = await countRows(auth.ctx, 'select count(*) as n from OfficerSignature where SigningNonce = :nonce', { nonce })
  const admin = await countRows(auth.ctx, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })
  return { nonce, officer, admin }
}

/**
 * Runs the full accept ceremony for one seeded request under the fixture officer's REAL
 * secp256k1 key (`makeTestSignCallback`), used as both the header signer and the D-07 reusable
 * per-digest callback.
 */
async function acceptRequest (
  engine: SignatureTasksEngine,
  auth: TestAuthority,
  requestId: string,
  checklist: RegistrationVerificationChecklistItem[] = ['id']
): Promise<RegistrantSignatureTask> {
  const officerSign = makeTestSignCallback(auth.user)
  const task = await getRegistrantTask(engine, requestId)
  const digestBytes = await engine.getSignatureDigest(task)
  const headerSignature = await officerSign(digestBytes)
  await engine.completeSignature(task, {
    isAccepted: true,
    signature: headerSignature,
    sign: officerSign,
    decision: { checklist },
  })
  return task
}

/**
 * Runs the accept ceremony while capturing every digest handed to the reusable `sign` callback,
 * IN ORDER. `finalizeRegistrantApproval` calls `sign` for DG-2 FIRST (inside `seedSignedMutation`,
 * before `register()` runs) — so `captured[0]` is always the DG-2 bytes. Resolves the STORED
 * `AdminSigning.Digest` row whose bytes match those captured bytes exactly (a real DB read-back,
 * not a locally-computed value) and returns it.
 */
async function acceptAndCaptureDecisionDigest (
  engine: SignatureTasksEngine,
  auth: TestAuthority,
  requestId: string,
  checklist: RegistrationVerificationChecklistItem[]
): Promise<Uint8Array> {
  const officerSign = makeTestSignCallback(auth.user)
  const captured: Uint8Array[] = []
  const wrappedSign = async (digest: Uint8Array): Promise<Signature> => {
    captured.push(digest)
    return officerSign(digest)
  }
  const task = await getRegistrantTask(engine, requestId)
  const headerDigest = await engine.getSignatureDigest(task)
  const headerSignature = await officerSign(headerDigest)
  await engine.completeSignature(task, {
    isAccepted: true,
    signature: headerSignature,
    sign: wrappedSign,
    decision: { checklist },
  })
  expect(captured.length, 'DG-2 must be the first digest handed to the reusable sign callback').to.be.greaterThan(0)
  const dg2Hex = bytesToHex(captured[0]!)

  const matches: string[] = []
  for await (const row of auth.ctx.db.eval(
    "select Digest from AdminSigning where Scope = 'vrg' and AuthorityId = :authorityId",
    { authorityId: auth.authority.id }
  )) {
    if (bytesToHex(digestToBytes(row.Digest as string)) === dg2Hex) matches.push(row.Digest as string)
  }
  expect(matches.length, 'exactly one STORED AdminSigning row must match the DG-2 bytes the officer signed').to.equal(1)
  return digestToBytes(matches[0]!)
}

// ---------------------------------------------------------------------------

describe('registrant approval ceremony', () => {
  // ---- Seeding (3) ----

  it('seeds one Task, one extension row and one unsigned vrg AdminSigning per pending request, under the signed-in officer userId', async () => {
    const auth = await setup()
    const { requestId } = await submitPendingRequest(auth)
    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)

    await engine.getRequestedSignatures(true)

    const taskCount = await countRows(
      auth.ctx,
      `select count(*) as n from Task T join RegistrantSignatureTaskExtension E on E.TaskId = T.Id where E.RequestId = :requestId`,
      { requestId }
    )
    expect(taskCount, 'exactly one Task row for this request').to.equal(1)

    const extCount = await countRows(
      auth.ctx,
      'select count(*) as n from RegistrantSignatureTaskExtension where RequestId = :requestId',
      { requestId }
    )
    expect(extCount, 'exactly one extension row for this request').to.equal(1)

    const taskRow = await auth.ctx.db
      .prepare(
        `select Task.SigningNonce from Task join RegistrantSignatureTaskExtension E on E.TaskId = Task.Id where E.RequestId = :requestId`
      )
      .get({ requestId })
    const nonce = taskRow!.SigningNonce as string

    const signingRow = await auth.ctx.db.prepare('select Scope, UserId from AdminSigning where Nonce = :nonce').get({ nonce })
    expect(signingRow, 'AdminSigning row must exist for the seeded nonce').to.not.be.undefined
    expect(signingRow!.Scope, "seeded AdminSigning row's Scope must be vrg").to.equal('vrg')
    expect(signingRow!.UserId, "seeded AdminSigning row's UserId must equal the signed-in officer's id").to.equal(auth.user.id)

    const officerSigCount = await countRows(auth.ctx, 'select count(*) as n from OfficerSignature where SigningNonce = :nonce', { nonce })
    expect(officerSigCount, 'the seeded row is UNSIGNED — no OfficerSignature yet').to.equal(0)
    const adminSigCount = await countRows(auth.ctx, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })
    expect(adminSigCount, 'the seeded row is UNSIGNED — no AdminSignature yet').to.equal(0)
  })

  it('is idempotent — a second pull creates no duplicate Task, extension or AdminSigning row', async () => {
    const auth = await setup()
    const { requestId } = await submitPendingRequest(auth)
    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)

    const countsFor = async (): Promise<[number, number, number]> => {
      const taskCount = await countRows(
        auth.ctx,
        `select count(*) as n from Task T join RegistrantSignatureTaskExtension E on E.TaskId = T.Id where E.RequestId = :requestId`,
        { requestId }
      )
      const extCount = await countRows(auth.ctx, 'select count(*) as n from RegistrantSignatureTaskExtension where RequestId = :requestId', { requestId })
      const adminCount = await countRows(auth.ctx, "select count(*) as n from AdminSigning where Scope = 'vrg' and AuthorityId = :authorityId", {
        authorityId: auth.authority.id,
      })
      return [taskCount, extCount, adminCount]
    }

    await engine.getRequestedSignatures(true)
    const before = await countsFor()

    await engine.getRequestedSignatures(true)
    const after = await countsFor()

    expect(after, 'a second pull-and-seed must create no duplicate Task/extension/AdminSigning row').to.deep.equal(before)
  })

  it('does not seed a task for a request that is no longer pending', async () => {
    const auth = await setup()
    const { requestId } = await submitPendingRequest(auth)
    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    await engine.getRequestedSignatures(true)
    await acceptRequest(engine, auth, requestId)

    // Pull again post-decision — the request's Status is no longer 'p', so the seed step's own
    // `where R.Status = 'p'` clause must skip it.
    await engine.getRequestedSignatures(true)

    const taskCount = await countRows(
      auth.ctx,
      `select count(*) as n from Task T join RegistrantSignatureTaskExtension E on E.TaskId = T.Id where E.RequestId = :requestId`,
      { requestId }
    )
    expect(taskCount, 'no additional registrant Task rows for a decided request').to.equal(1)
  })

  // ---- Materialization (3) ----

  it('returns a RegistrantSignatureTask carrying the parsed RegisterInit, submittedAt and issuerType', async () => {
    const auth = await setup()
    const { requestId, init } = await submitPendingRequest(auth)
    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    await engine.getRequestedSignatures(true)

    const task = await getRegistrantTask(engine, requestId)
    expect(task.requestId).to.equal(requestId)
    expect(task.issuerType).to.equal('registrant')
    // WR-04: assert the ENGINE already returned an ISO-Z string. The previous form wrapped the
    // value in reZuluDatetime INSIDE the assertion, which passed identically whether or not the
    // engine had re-Zulu'd it — it encoded the defect rather than catching it.
    // RegistrantSignatureTask.submittedAt is documented as an ISO-Z string (vote-core
    // tasks/models.ts), so a consumer's `new Date(task.submittedAt)` must read UTC, not host-local.
    expect(
      task.submittedAt,
      'submittedAt must already carry the trailing Z — the task contract is an ISO-Z string, not a raw Quereus read-back'
    ).to.match(/Z$/)
    // T-42-06: the plain SELECT read-back still drops trailing zero fractional digits, so the
    // value comparison stays trailing-zero-agnostic. reZuluDatetime is applied to NEITHER side.
    expect(task.submittedAt.replace(/0+Z$/, 'Z')).to.equal(init.submittedAt.replace(/0+Z$/, 'Z'))
    expect(task.payload, 'the JSON round-trip must reproduce the submitted RegisterInit, not merely a string').to.deep.equal(init.payload)
  })

  it('surfaces issuerType bridge and the registry label for a bridge-issued request', async () => {
    const auth = await setup()
    const bridge = await registerBridge(auth, 'Legacy Roll Importer')
    const { requestId } = await submitPendingRequest(auth, { issuerType: 'bridge', bridgeId: bridge.id, requesterKey: bridge.key })
    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    await engine.getRequestedSignatures(true)

    const task = await getRegistrantTask(engine, requestId)
    // D-03: issuerType, NOT bridgeLabel, is the only authoritative issuer signal — bridgeLabel is
    // present here only because the registry lookup found a label for this bridge row.
    expect(task.issuerType).to.equal('bridge')
    expect(task.bridgeLabel).to.equal('Legacy Roll Importer')
  })

  it('falls back to the base task instead of throwing when the extension row is missing', async () => {
    const auth = await setup()
    const { requestId } = await submitPendingRequest(auth)
    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    await engine.getRequestedSignatures(true)

    const orphan = await auth.ctx.db
      .prepare(`select Task.Id from Task join RegistrantSignatureTaskExtension E on E.TaskId = Task.Id where E.RequestId = :requestId`)
      .get({ requestId })
    expect(orphan, 'the seeded Task must exist before orphaning it').to.not.be.undefined
    const orphanTaskId = orphan!.Id as string

    // Schema note: RegistrantSignatureTaskExtension.DeleteValid only permits deleting the
    // extension row once its Task is already completed — a still-pending, extension-missing Task
    // cannot be constructed at all (ExtensionExists is a deferred, always-on CHECK). Complete the
    // Task directly (bypassing the accept ceremony — this proves the READ-side fallback, not the
    // ceremony), then delete the extension row, leaving a genuinely orphaned completed Task row.
    // Reading with pending=false is what makes the orphaned completed Task visible to this read.
    const completeTid = await allocateTid(auth.ctx.db, 'registration-request')
    await auth.ctx.db.exec(
      'update Task with context IsMutationValid = true, Tid = :tid set IsCompleted = 1 where Id = :id',
      { id: orphanTaskId, tid: completeTid }
    )
    const deleteTid = await allocateTid(auth.ctx.db, 'registration-request')
    await auth.ctx.db.exec(
      'delete from RegistrantSignatureTaskExtension with context Tid = :tid where TaskId = :taskId',
      { taskId: orphanTaskId, tid: deleteTid }
    )

    let tasks: SignatureTask[] | undefined
    let threw = false
    try {
      tasks = await engine.getRequestedSignatures(false)
    } catch {
      threw = true
    }
    expect(threw, 'a missing extension row must never throw — it must take down the whole task inbox otherwise').to.be.false

    const orphanEntry = tasks!.find((t) => t.signatureType === 'registrant' && !('requestId' in t))
    expect(orphanEntry, 'the orphaned Task must degrade to a base task, not be silently dropped').to.not.be.undefined
    expect((orphanEntry as RegistrantSignatureTask).requestId, "a base-task fallback's requestId must be undefined").to.be.undefined
  })

  // ---- Disambiguation (2) — two pending requests for the same officer, the ordinary case ----

  it('getSignatureDigest returns the digest belonging to the requested request, not an arbitrary pending task', async () => {
    const auth = await setup()
    const { requestId: r1 } = await submitPendingRequest(auth)
    const { requestId: r2 } = await submitPendingRequest(auth)
    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    await engine.getRequestedSignatures(true)

    const task1 = await getRegistrantTask(engine, r1)
    const task2 = await getRegistrantTask(engine, r2)

    // L-3: unscoped, the officer would be shown the wrong request's digest to sign.
    const digest1 = await engine.getSignatureDigest(task1)
    const digest2 = await engine.getSignatureDigest(task2)
    expect(bytesToHex(digest1)).to.not.equal(bytesToHex(digest2))

    const row1 = await auth.ctx.db
      .prepare(
        `select A.Digest from AdminSigning A join Task T on T.SigningNonce = A.Nonce
           join RegistrantSignatureTaskExtension E on E.TaskId = T.Id where E.RequestId = :requestId`
      )
      .get({ requestId: r1 })
    const row2 = await auth.ctx.db
      .prepare(
        `select A.Digest from AdminSigning A join Task T on T.SigningNonce = A.Nonce
           join RegistrantSignatureTaskExtension E on E.TaskId = T.Id where E.RequestId = :requestId`
      )
      .get({ requestId: r2 })

    expect(bytesToHex(digestToBytes(row1!.Digest as string)), "task1's digest must equal its own seeded AdminSigning.Digest").to.equal(bytesToHex(digest1))
    expect(bytesToHex(digestToBytes(row2!.Digest as string)), "task2's digest must equal its own seeded AdminSigning.Digest").to.equal(bytesToHex(digest2))
  })

  it('completeSignature completes the Task belonging to the request under review', async () => {
    const auth = await setup()
    const { requestId: r1 } = await submitPendingRequest(auth)
    const { requestId: r2 } = await submitPendingRequest(auth)
    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    await engine.getRequestedSignatures(true)

    await acceptRequest(engine, auth, r2)

    const isCompleted = async (requestId: string): Promise<number> => {
      const row = await auth.ctx.db
        .prepare(`select Task.IsCompleted from Task join RegistrantSignatureTaskExtension E on E.TaskId = Task.Id where E.RequestId = :requestId`)
        .get({ requestId })
      return Number(row!.IsCompleted)
    }

    expect(await isCompleted(r2), 'the accepted request (r2) must be completed').to.equal(1)
    expect(await isCompleted(r1), "the OTHER pending request (r1) must remain untouched").to.equal(0)
  })

  // ---- The accept ceremony (3) ----

  it('produces a real Registrant row through the unchanged register() path and records the decision on the request', async () => {
    const auth = await setup()
    const { requestId, init } = await submitPendingRequest(auth)
    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    await engine.getRequestedSignatures(true)

    await acceptRequest(engine, auth, requestId, ['id', 'roll'])

    // register() was called unchanged — a real Registrant row now exists for init.registrant.id.
    const registrantRow = await auth.ctx.db.prepare('select Id from Registrant where Id = :id').get({ id: init.payload.registrant.id })
    expect(registrantRow, 'a Registrant row must exist for init.registrant.id').to.not.be.undefined

    const reqRow = await auth.ctx.db
      .prepare('select Status, VerificationCid, DecidedAt, DecidingOfficerUserId, RejectionReason from RegistrationRequest where Id = :id')
      .get({ id: requestId })
    expect(reqRow!.Status).to.equal('a')
    expect(reqRow!.VerificationCid).to.be.a('string').and.not.equal('')
    // T-42-06 read-back Z-stripping — normalize before asserting full ISO-Z shape.
    expect(reZuluDatetime(reqRow!.DecidedAt as string)).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
    expect(reqRow!.DecidingOfficerUserId).to.equal(auth.user.id)
    expect(reqRow!.RejectionReason).to.equal(null)

    const taskRow = await auth.ctx.db
      .prepare(`select Task.IsCompleted from Task join RegistrantSignatureTaskExtension E on E.TaskId = Task.Id where E.RequestId = :requestId`)
      .get({ requestId })
    expect(Number(taskRow!.IsCompleted)).to.equal(1)
  })

  it('binds the decision-time checklist into the officer-signed digest — flipping one checklist item changes it', async () => {
    const auth = await setup()
    const { requestId: r1 } = await submitPendingRequest(auth)
    const { requestId: r2 } = await submitPendingRequest(auth)
    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    await engine.getRequestedSignatures(true)

    // D-07 tamper-evidence: VerificationCid rides inside the SAME digest as every other decision
    // field (DG-2), so a post-hoc checklist edit changes these bytes and would break verification
    // of the officer's own signature over AdminSigning.Digest.
    const digest1 = await acceptAndCaptureDecisionDigest(engine, auth, r1, ['id'])
    const digest2 = await acceptAndCaptureDecisionDigest(engine, auth, r2, ['id', 'roll'])

    expect(bytesToHex(digest1)).to.not.equal(bytesToHex(digest2))
  })

  it('refuses an accept that carries no reusable sign callback and one that carries no decision, creating no Registrant and consuming no signature', async () => {
    const auth = await setup()
    const { requestId: requestIdA, init: initA } = await submitPendingRequest(auth)
    const { requestId: requestIdB, init: initB } = await submitPendingRequest(auth)
    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    await engine.getRequestedSignatures(true)

    const officerSign = makeTestSignCallback(auth.user)

    // Variant A (missing `sign`) — against request A.
    const taskA = await getRegistrantTask(engine, requestIdA)
    const digestBytesA = await engine.getSignatureDigest(taskA)
    const headerSignatureA = await officerSign(digestBytesA)

    let threwA = false
    try {
      await engine.completeSignature(taskA, {
        isAccepted: true,
        signature: headerSignatureA,
        decision: { checklist: ['id'] },
        // sign deliberately omitted — a placeholder signature must never be substituted here; an
        // approval whose checklist is covered by nothing is exactly what D-07 exists to prevent.
      })
    } catch {
      threwA = true
    }
    expect(threwA, 'an accept with no reusable sign callback must be refused').to.be.true

    const registrantRowA = await auth.ctx.db.prepare('select 1 as x from Registrant where Id = :id').get({ id: initA.payload.registrant.id })
    expect(registrantRowA, 'no Registrant row may be created for the missing-sign variant').to.be.undefined

    const reqRowA = await auth.ctx.db.prepare('select Status from RegistrationRequest where Id = :id').get({ id: requestIdA })
    expect(reqRowA!.Status, 'request A must remain pending').to.equal('p')

    // A malformed accept must be refused before any signature is consumed, exactly as an
    // adversarial payload is (WR-19) — read against A's OWN nonce, not inferred from B's.
    const countsA = await signatureRowCounts(auth, requestIdA)
    expect(countsA.officer, 'a missing-sign accept must not consume the officer signature — no OfficerSignature row for A\'s nonce').to.equal(0)
    expect(countsA.admin, 'a missing-sign accept must not mint an AdminSignature row for A\'s nonce').to.equal(0)

    // Variant B (missing `decision`) — against request B. An accept with no recorded decision is
    // exactly as malformed as one with no reusable signer: a signature must not be spent to
    // discover that.
    const taskB = await getRegistrantTask(engine, requestIdB)
    const digestBytesB = await engine.getSignatureDigest(taskB)
    const headerSignatureB = await officerSign(digestBytesB)

    let threwB = false
    try {
      await engine.completeSignature(taskB, {
        isAccepted: true,
        signature: headerSignatureB,
        sign: officerSign,
        // decision deliberately omitted.
      })
    } catch {
      threwB = true
    }
    expect(threwB, 'an accept with no recorded decision must be refused').to.be.true

    const registrantRowB = await auth.ctx.db.prepare('select 1 as x from Registrant where Id = :id').get({ id: initB.payload.registrant.id })
    expect(registrantRowB, 'no Registrant row may be created for the missing-decision variant').to.be.undefined

    const reqRowB = await auth.ctx.db.prepare('select Status from RegistrationRequest where Id = :id').get({ id: requestIdB })
    expect(reqRowB!.Status, 'request B must remain pending').to.equal('p')

    // Read independently against B's OWN nonce — the point of the widening is that the
    // result.decision path is proven by its own assertion, not by code-identity with result.sign.
    const countsB = await signatureRowCounts(auth, requestIdB)
    expect(countsB.officer, 'a missing-decision accept must not consume the officer signature — no OfficerSignature row for B\'s nonce').to.equal(0)
    expect(countsB.admin, 'a missing-decision accept must not mint an AdminSignature row for B\'s nonce').to.equal(0)
  })

  // ---- CR-02 / CR-03 adversarial-payload guards ----

  it('CR-02: refuses an approval whose payload registers under an authority other than the one addressed', async () => {
    const auth = await setup()
    const foreignAuthorityId = crypto.randomUUID()
    const { requestId } = await submitPendingRequest(auth, { payloadAuthorityId: foreignAuthorityId })
    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    await engine.getRequestedSignatures(true)

    const registrantCountBefore = await countRows(auth.ctx, 'select count(*) as n from Registrant')
    const vrgCountBefore = await countRows(
      auth.ctx,
      "select count(*) as n from AdminSigning where Scope = 'vrg' and AuthorityId = :authorityId",
      { authorityId: auth.authority.id }
    )

    // Fixture integrity — the seeded row is unsigned before any accept attempt.
    const countsBefore = await signatureRowCounts(auth, requestId)
    expect(countsBefore.officer, 'the seeded row must be unsigned before the accept attempt').to.equal(0)
    expect(countsBefore.admin, 'the seeded row must be unsigned before the accept attempt').to.equal(0)

    let thrownMessage: string | undefined
    try {
      await acceptRequest(engine, auth, requestId)
    } catch (err) {
      thrownMessage = (err as Error).message
    }
    expect(thrownMessage, 'a cross-authority payload must be refused, not silently minted').to.not.be.undefined
    expect(thrownMessage, "the refusal must name the addressed authority").to.include(auth.authority.id)
    expect(thrownMessage, "the refusal must name the payload's authority").to.include(foreignAuthorityId)

    const registrantCountAfter = await countRows(auth.ctx, 'select count(*) as n from Registrant')
    expect(registrantCountAfter, 'no Registrant row may be created by a refused approval').to.equal(registrantCountBefore)

    // WR-19: a refused approval must not consume the officer's signature — no OfficerSignature row
    // may exist for the task's nonce.
    const countsAfter = await signatureRowCounts(auth, requestId)
    expect(countsAfter.officer, "a refused approval must not consume the officer's signature — no OfficerSignature row may exist for the task's nonce").to.equal(0)
    expect(
      countsAfter.admin,
      "a refused approval must not mint an AdminSignature row either — at the || 1 threshold fallback signingEngine.sign() would otherwise auto-complete one for a single officer"
    ).to.equal(0)

    const vrgCountAfter = await countRows(
      auth.ctx,
      "select count(*) as n from AdminSigning where Scope = 'vrg' and AuthorityId = :authorityId",
      { authorityId: auth.authority.id }
    )
    expect(
      vrgCountAfter,
      "the refusal must precede seedSignedMutation — this proves only that seedSignedMutation did not run (AdminSigning is written at SEED time by seedRegistrantSignatureTasks, not at sign time); it proves NOTHING about whether the officer's signature was consumed — see the OfficerSignature/AdminSignature assertions above"
    ).to.equal(vrgCountBefore)

    const reqRow = await auth.ctx.db.prepare('select Status from RegistrationRequest where Id = :id').get({ id: requestId })
    expect(reqRow!.Status, 'a refused request must remain pending, not linked to a foreign authority').to.equal('p')

    // Retryability: a second accept attempt on the same task must throw the SAME refusal, never a
    // UNIQUE constraint violation on OfficerSignature's (SigningNonce, UserId) primary key.
    let secondThrownMessage: string | undefined
    try {
      await acceptRequest(engine, auth, requestId)
    } catch (err) {
      secondThrownMessage = (err as Error).message
    }
    expect(secondThrownMessage, 'a refused approval must remain retryable via a second accept attempt').to.not.be.undefined
    expect(secondThrownMessage, 'the retry must raise the SAME CR-02 refusal fragment').to.include('not the addressed authority')
    expect(
      secondThrownMessage,
      'a refused approval must stay retryable via accept, not be burned into a PK collision on OfficerSignature'
    ).to.not.match(/UNIQUE constraint|OfficerSignature/i)

    const countsAfterRetry = await signatureRowCounts(auth, requestId)
    expect(countsAfterRetry.officer, 'after the retry, still no OfficerSignature row for the task\'s nonce').to.equal(0)
  })

  it('CR-02 (WR-21): refuses a payload naming a REAL sibling authority at which this SAME officer also serves — the dual-authority case AdminSigning.UserIdValid does not catch', async () => {
    const auth = await setup()

    // The case CR-02 actually described, and the one the original regression test did not build.
    // That test used `crypto.randomUUID()` — an authority id with NO Authority row — so even the
    // UNFIXED code would have been stopped by Registrant's own authority-existence CHECK, and
    // only its `vrgCountBefore/After` assertion was discriminating. Here the sibling authority is
    // REAL, it is in the SAME database, and `auth.user` is a genuine officer of it, so
    // `AdminSigning.UserIdValid` does NOT accidentally save us: without the CR-02 refusal a real
    // cross-authority Registrant could be minted under the sibling.
    const siblingAuthorityId = await addSiblingAuthority(auth)
    expect(siblingAuthorityId, 'the sibling authority must be a real, distinct Authority row').to.not.equal(auth.authority.id)

    // Fixture integrity — assert the dual-officer premise rather than assuming it. If this ever
    // stops holding, the test stops being the dual-authority case and silently becomes the old,
    // narrower one.
    const siblingOfficerCount = await countRows(
      auth.ctx,
      'select count(*) as n from Officer where AuthorityId = :authorityId and UserId = :userId',
      { authorityId: siblingAuthorityId, userId: auth.user.id }
    )
    expect(siblingOfficerCount, 'the signing officer must genuinely be an officer of the sibling authority').to.be.greaterThan(0)

    // The request is ADDRESSED to auth.authority.id; only the payload names the sibling.
    const { requestId } = await submitPendingRequest(auth, { payloadAuthorityId: siblingAuthorityId })
    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    await engine.getRequestedSignatures(true)

    let thrownMessage: string | undefined
    try {
      await acceptRequest(engine, auth, requestId)
    } catch (err) {
      thrownMessage = (err as Error).message
    }
    expect(thrownMessage, 'a payload naming a sibling authority must be refused').to.not.be.undefined
    expect(thrownMessage, 'the refusal must name the addressed authority').to.include(auth.authority.id)
    expect(thrownMessage, "the refusal must name the payload's authority").to.include(siblingAuthorityId)

    // The assertion WR-21 asked for by name: nothing was minted UNDER THE SIBLING.
    const siblingRegistrants = await countRows(
      auth.ctx,
      'select count(*) as n from Registrant where AuthorityId = :authorityId',
      { authorityId: siblingAuthorityId }
    )
    expect(siblingRegistrants, 'no Registrant may exist under the sibling authority after a refused approval').to.equal(0)

    // And the officer's signature was not spent (WR-19 ordering still holds on this variant).
    const counts = await signatureRowCounts(auth, requestId)
    expect(counts.officer, "a refused approval must not consume the officer's signature").to.equal(0)
    expect(counts.admin, 'a refused approval must not mint an AdminSignature row').to.equal(0)

    const reqRow = await auth.ctx.db.prepare('select Status from RegistrationRequest where Id = :id').get({ id: requestId })
    expect(reqRow!.Status, 'a refused request must remain pending').to.equal('p')
  })

  it('WR-20: an authority that declares registration field policy refuses a payload that omits electionId, and one that names a policy-free election of the same authority', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
    // Two elections at the SAME authority. Only the first declares a field policy — that asymmetry
    // is the whole point: a requester who may name any election of the authority can otherwise
    // steer at the policy-free one and evade enforcement entirely.
    const elec = await addTestElection(auth)
    const governedElectionId = await resolveOneElectionId(auth.ctx, auth.authority.id)
    const regEngine = new RegistrationEngine(auth.ctx)
    await regEngine.addElectionRegistrationField(
      { electionId: governedElectionId, fieldName: 'district', tier: 'public', requirement: 'required' },
      makeTestSignCallback(auth.user)
    )
    void elec

    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)

    // Variant A — payload omits electionId entirely. Pre-fix, register()'s
    // `if (init.electionId)` guard meant validateFieldPolicy simply never ran, and D-09 records
    // there is no schema CHECK backstop: the submitter opted out of the whole policy by leaving a
    // field blank.
    const { requestId: requestIdA } = await submitPendingRequest(auth)
    await engine.getRequestedSignatures(true)
    let messageA: string | undefined
    try {
      await acceptRequest(engine, auth, requestIdA)
    } catch (err) {
      messageA = (err as Error).message
    }
    expect(messageA, 'a payload omitting electionId must be refused while the authority declares field policy').to.not.be.undefined
    expect(messageA).to.include('names no electionId')

    // No signature spent — this gate runs on the pre-sign side, like every other refusal here.
    const countsA = await signatureRowCounts(auth, requestIdA)
    expect(countsA.officer, 'the omission refusal must not spend the officer signature').to.equal(0)

    const statusA = await auth.ctx.db.prepare('select Status from RegistrationRequest where Id = :id').get({ id: requestIdA })
    expect(statusA!.Status, 'a refused request stays pending').to.equal('p')

    // Variant B — payload names a REAL election of the SAME authority that declares no policy.
    const policyFreeElectionId = await addSecondElectionId(auth)
    expect(policyFreeElectionId, 'the second election must be distinct').to.not.equal(governedElectionId)
    const { requestId: requestIdB } = await submitPendingRequest(auth, { payloadElectionId: policyFreeElectionId })
    await engine.getRequestedSignatures(true)
    let messageB: string | undefined
    try {
      await acceptRequest(engine, auth, requestIdB)
    } catch (err) {
      messageB = (err as Error).message
    }
    expect(messageB, 'a payload steering at a policy-free election of the same authority must be refused').to.not.be.undefined
    expect(messageB).to.include('declares no registration field policy')

    // Variant C — the payload that names the governed election is NOT refused by this gate. It
    // still has to satisfy the policy itself (register()'s validateFieldPolicy owns that), and the
    // fixture payload supplies no `district`, so the error that DOES surface must come from the
    // field-policy validator rather than from this gate — proving the gate is not simply refusing
    // everything.
    const { requestId: requestIdC } = await submitPendingRequest(auth, { payloadElectionId: governedElectionId })
    await engine.getRequestedSignatures(true)
    let messageC: string | undefined
    try {
      await acceptRequest(engine, auth, requestIdC)
    } catch (err) {
      messageC = (err as Error).message
    }
    expect(messageC, 'the governed-election payload still fails the policy it now cannot evade').to.not.be.undefined
    expect(messageC, 'and it fails on the POLICY, not on this gate').to.not.include('declares no registration field policy')
    expect(messageC, 'and it fails on the POLICY, not on this gate').to.not.include('names no electionId')
  })

  it('WR-05: a finalize failure AFTER the acceptability gate leaves the accept RETRYABLE — the retry completes instead of colliding on OfficerSignature PK', async () => {
    const auth = await setup()
    const { requestId, init } = await submitPendingRequest(auth)
    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    await engine.getRequestedSignatures(true)

    // Force a failure INSIDE finalizeRegistrantApproval, strictly AFTER the acceptability gate has
    // passed and after signingEngine.sign() has already committed this officer's header signature.
    // This is the failure class 48-34 explicitly left open: the gate cannot foresee a register()
    // CHECK failure or a transient storage error, so no amount of pre-sign refusal reaches it.
    const registerProto = RegistrationEngine.prototype as unknown as {
      register: (init: RegisterInit, sign: unknown) => Promise<void>
    }
    const originalRegister = registerProto.register
    let faulted = false
    registerProto.register = async function faultingRegister (this: RegistrationEngine, ...args: [RegisterInit, unknown]) {
      if (!faulted) {
        faulted = true
        throw new Error('forced post-gate finalize fault')
      }
      return originalRegister.apply(this, args)
    }

    try {
      let firstMessage: string | undefined
      try {
        await acceptRequest(engine, auth, requestId)
      } catch (err) {
        firstMessage = (err as Error).message
      }
      expect(firstMessage, 'the forced fault must surface on the first accept').to.not.be.undefined
      expect(firstMessage).to.include('forced post-gate finalize fault')

      // The officer's header signature IS spent by now — that is the premise of WR-05, not a
      // failure of the WR-19 gate. Assert it, so the retry below is proven to be retrying over a
      // genuinely spent signature rather than over a clean slate.
      const spent = await signatureRowCounts(auth, requestId)
      expect(spent.officer, "the header signature is spent by the first attempt — this is WR-05's premise").to.equal(1)

      // The task is still open and the request still pending — nothing was completed.
      const midRow = await auth.ctx.db.prepare('select Status from RegistrationRequest where Id = :id').get({ id: requestId })
      expect(midRow!.Status, 'the request must still be pending after the failed finalize').to.equal('p')

      // THE ASSERTION WR-05 IS ABOUT: retry the SAME accept. Pre-fix this died with
      // `UNIQUE constraint failed: OfficerSignature PK` inside signingEngine.sign(), and the
      // officer could never complete this approval again — recoverable only by rejecting a request
      // they intended to approve.
      let secondMessage: string | undefined
      try {
        await acceptRequest(engine, auth, requestId)
      } catch (err) {
        secondMessage = (err as Error).message
      }
      expect(
        secondMessage,
        `the retry must succeed outright — got: ${String(secondMessage)}`
      ).to.be.undefined

      // And it must have actually completed the ceremony, not merely not-thrown.
      const finalRow = await auth.ctx.db
        .prepare('select Status, DecidingOfficerUserId from RegistrationRequest where Id = :id')
        .get({ id: requestId })
      expect(finalRow!.Status, 'the retried approval must record the decision').to.equal('a')
      expect(finalRow!.DecidingOfficerUserId, 'and it must stay attributable (WR-01)').to.equal(auth.user.id)

      const registrantRow = await auth.ctx.db
        .prepare('select Id from Registrant where Id = :id')
        .get({ id: init.payload.registrant.id })
      expect(registrantRow, 'the retried approval must mint the Registrant the first attempt could not').to.not.be.undefined

      // Exactly ONE OfficerSignature for the task nonce — the retry re-used the existing row
      // rather than inserting a second one or replacing it.
      const after = await signatureRowCounts(auth, requestId)
      expect(after.officer, 'the retry must not create a SECOND OfficerSignature row for the same nonce').to.equal(1)
    } finally {
      registerProto.register = originalRegister
    }
  })

  it('CR-03: refuses an approval whose payload reuses an existing Registrant id, creating nothing and leaving the request pending', async () => {
    const auth = await setup()
    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)

    // R1: a normal approval mints a real Registrant for id X.
    const collidingId = crypto.randomUUID()
    const { requestId: r1 } = await submitPendingRequest(auth, { registrantId: collidingId })
    await engine.getRequestedSignatures(true)
    await acceptRequest(engine, auth, r1)
    const mintedRow = await auth.ctx.db.prepare('select Id from Registrant where Id = :id').get({ id: collidingId })
    expect(mintedRow, 'R1 must mint a real Registrant row for the colliding id before R2 is tested').to.not.be.undefined

    // R2: a DIFFERENT requester submits a second request at the same authority naming the SAME id.
    const { requestId: r2 } = await submitPendingRequest(auth, { registrantId: collidingId, requesterKey: randomTestKeyPair() })
    await engine.getRequestedSignatures(true)

    const registrantCountBefore = await countRows(auth.ctx, 'select count(*) as n from Registrant')
    const vrgCountBefore = await countRows(
      auth.ctx,
      "select count(*) as n from AdminSigning where Scope = 'vrg' and AuthorityId = :authorityId",
      { authorityId: auth.authority.id }
    )

    // Fixture integrity — take the reading for R2's OWN task only; R1 already accepted
    // legitimately and its signature rows must not be counted here.
    const countsBefore = await signatureRowCounts(auth, r2)
    expect(countsBefore.officer, "R2's seeded row must be unsigned before the accept attempt").to.equal(0)
    expect(countsBefore.admin, "R2's seeded row must be unsigned before the accept attempt").to.equal(0)

    let thrownMessage: string | undefined
    let thrownErr: unknown
    try {
      await acceptRequest(engine, auth, r2)
    } catch (err) {
      thrownErr = err
      thrownMessage = (err as Error).message
    }
    expect(thrownMessage, 'an id-colliding payload must be refused, not silently converged on').to.not.be.undefined
    // R2/D-04/D-05 (57-02): the refusal is now the typed, instanceof-checkable
    // RegistrantAlreadyExistsError shared with register()'s own pre-BEGIN guard —
    // never a raw UNIQUE constraint string, and never a second, differently-worded
    // ad hoc Error.
    expect(thrownErr, 'the refusal must be RegistrantAlreadyExistsError, not a raw/ad hoc Error').to.be.instanceOf(RegistrantAlreadyExistsError)
    expect(thrownMessage, 'the refusal must name the refused request').to.include(r2)

    const registrantCountAfter = await countRows(auth.ctx, 'select count(*) as n from Registrant')
    expect(registrantCountAfter, 'a refused R2 must create no additional Registrant row').to.equal(registrantCountBefore)

    // WR-19: a refused R2 must not consume the officer's signature — read against R2's OWN nonce.
    const countsAfter = await signatureRowCounts(auth, r2)
    expect(countsAfter.officer, "a refused approval must not consume the officer's signature — no OfficerSignature row may exist for R2's nonce").to.equal(0)
    expect(
      countsAfter.admin,
      "a refused approval must not mint an AdminSignature row either — at the || 1 threshold fallback signingEngine.sign() would otherwise auto-complete one for a single officer"
    ).to.equal(0)

    const vrgCountAfter = await countRows(
      auth.ctx,
      "select count(*) as n from AdminSigning where Scope = 'vrg' and AuthorityId = :authorityId",
      { authorityId: auth.authority.id }
    )
    expect(
      vrgCountAfter,
      "the refusal must precede seedSignedMutation for R2 — this proves only that seedSignedMutation did not run for R2 (AdminSigning is written at SEED time, not sign time); it proves NOTHING about whether the officer's signature was consumed — see the OfficerSignature/AdminSignature assertions above"
    ).to.equal(vrgCountBefore)

    const reqRow2 = await auth.ctx.db.prepare('select Status from RegistrationRequest where Id = :id').get({ id: r2 })
    expect(reqRow2!.Status, 'R2 must remain pending, not silently marked approved').to.equal('p')

    const read = await new RegistrationEngine(auth.ctx).getRegistrationRequest(r2)
    expect(read?.status, "R2's read surface must still report pending").to.equal('p')
    expect(read?.registrantId, 'a refused R2 must offer no "View Registrant" CTA pointing at the other person\'s record').to.be.undefined

    // Retryability: a second accept attempt on R2 must throw the SAME refusal, never a UNIQUE
    // constraint violation on OfficerSignature's (SigningNonce, UserId) primary key.
    let secondThrownMessage: string | undefined
    let secondThrownErr: unknown
    try {
      await acceptRequest(engine, auth, r2)
    } catch (err) {
      secondThrownErr = err
      secondThrownMessage = (err as Error).message
    }
    expect(secondThrownMessage, 'a refused approval must remain retryable via a second accept attempt').to.not.be.undefined
    // Same instanceof + same named request, not the exact old wording — the retry raises the
    // SAME refusal CLASS naming the SAME request, per the shared RegistrantAlreadyExistsError.
    expect(secondThrownErr, 'the retry must raise the SAME RegistrantAlreadyExistsError class').to.be.instanceOf(RegistrantAlreadyExistsError)
    expect(secondThrownMessage, 'the retry must raise the SAME CR-03 refusal, naming the SAME request').to.include(r2)
    expect(
      secondThrownMessage,
      'a refused approval must stay retryable via accept, not be burned into a PK collision on OfficerSignature'
    ).to.not.match(/UNIQUE constraint|OfficerSignature/i)

    const countsAfterRetry = await signatureRowCounts(auth, r2)
    expect(countsAfterRetry.officer, "after the retry, still no OfficerSignature row for R2's nonce").to.equal(0)
  })
})
