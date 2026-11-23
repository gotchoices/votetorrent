/**
 * registration-stale-close.spec.ts — closing a stale registration request.
 *
 * Above a 'vrg' threshold of 1 a request whose co-signers never act stays pending forever and the
 * requester is never told. Once its session has been open for REGISTRATION_STALE_CLOSE_TIMEOUT_MS
 * (7 days), any single officer holding 'vrg' may close it as rejected with a reason
 * (`RegistrationEngine.closeStaleRegistrationRequest`). Before the timeout the engine refuses, and
 * the ordinary single-officer reject stays refused at every age (no veto).
 *
 * Also pins the schema answer: RegistrationDecision needs ONE current 'vrg' officer's signature, so
 * the published 'r' decision commits at threshold 2 without a schema change.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { Database } from '@quereus/quereus'
import {
  REGISTRATION_STALE_CLOSE_TIMEOUT_MS,
  RegistrationStaleCloseError,
  type RegisterInit,
  type RegistrationRequestInit,
  type Signature
} from '@votetorrent/vote-core'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { seedSignedMutation } from '../src/signing/signed-mutation.js'
import { P2pRegistrationTransport } from '../src/registration/transport/p2p-registration-transport.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { provisionTestIntakeRecipient } from './fixtures/test-context.js'
import { createThresholdAuthority, type ThresholdAuthorityFixture } from './fixtures/threshold-authority.js'

const DAY_MS = 86_400_000

function requesterSigner (): { publicHex: string, sign: (digest: Uint8Array) => Promise<Signature> } {
  const kp = randomTestKeyPair()
  const priv = hexToBytes(kp.privateHex)
  return {
    publicHex: kp.publicHex,
    sign: async (digest) => ({ signature: bytesToHex(secp256k1.sign(digest, priv)), signerKey: kp.publicHex, signerUserId: '' })
  }
}

async function submitPending (fx: ThresholdAuthorityFixture): Promise<string> {
  const requester = requesterSigner()
  const payload: RegisterInit = {
    registrant: { id: crypto.randomUUID(), authorityId: fx.authorityId, expiration: toIsoZDatetime(Date.now() + 365 * DAY_MS) },
    private: { expiration: toIsoZDatetime(Date.now() + 365 * DAY_MS), details: [] }
  }
  const init: RegistrationRequestInit = { id: crypto.randomUUID(), authorityId: fx.authorityId, payload, submittedAt: toIsoZDatetime(Date.now()) }
  return new RegistrationEngine(fx.elec.ctx).submitRegistrationRequest(init, requester.publicHex, requester.sign)
}

/** Seeds the request's review session (the registrant Tasks), as the inbox read does. */
async function seedReviewSession (fx: ThresholdAuthorityFixture): Promise<void> {
  const net = { hash: 'stale-close', name: 'Stale close', relays: [] as string[], primaryAuthorityDomainName: 'x.example' }
  await new SignatureTasksEngine(net, { db: fx.elec.ctx.db, user: fx.holders[0]!.user, intakeOpener: fx.elec.ctx.intakeOpener }).getRequestedSignatures(true)
}

function engineAt (fx: ThresholdAuthorityFixture, user: ThresholdAuthorityFixture['holders'][number]['user'], nowMs: number): RegistrationEngine {
  return new RegistrationEngine({ db: fx.elec.ctx.db, user, intakeOpener: fx.elec.ctx.intakeOpener }, { now: () => nowMs })
}

async function requestRow (db: Database, requestId: string): Promise<Record<string, unknown>> {
  const row = await db.prepare('select Status, RejectionReason, DecidingOfficerUserId from RegistrationRequest where Id = :requestId').get({ requestId })
  return row as Record<string, unknown>
}

async function count (db: Database, sql: string, params: Record<string, unknown> = {}): Promise<number> {
  const row = await db.prepare(sql).get(params as any)
  return Number(row?.n ?? 0)
}

async function expectStaleCloseRefusal (p: Promise<unknown>, code: string): Promise<RegistrationStaleCloseError> {
  let caught: unknown
  try {
    await p
  } catch (err) {
    caught = err
  }
  expect(caught, `expected RegistrationStaleCloseError(${code})`).to.be.instanceOf(RegistrationStaleCloseError)
  expect((caught as RegistrationStaleCloseError).code).to.equal(code)
  return caught as RegistrationStaleCloseError
}

function strandPort (db: Database) {
  return {
    async query<T> (sql: string, params: Record<string, unknown>): Promise<T[]> {
      const rows: T[] = []
      for await (const row of db.eval(sql, params as any)) rows.push(row as unknown as T)
      return rows
    },
    async mutate (sql: string, params: Record<string, unknown>): Promise<void> {
      await db.exec(sql, params as any)
    },
    async close (): Promise<void> {}
  }
}

describe('closing a stale registration request (vrg threshold above 1)', function () {
  this.timeout(60_000)

  let fx: ThresholdAuthorityFixture
  let requestId: string

  beforeEach(async () => {
    fx = await createThresholdAuthority()
    await provisionTestIntakeRecipient(fx.elec.ctx, fx.authorityId)
    requestId = await submitPending(fx)
    await seedReviewSession(fx)
  })

  it('the timeout is one named constant of 7 days', () => {
    expect(REGISTRATION_STALE_CLOSE_TIMEOUT_MS).to.equal(7 * DAY_MS)
  })

  it('before the timeout: not available, and a close is refused with no write', async () => {
    const engine = engineAt(fx, fx.holders[1]!.user, Date.now() + REGISTRATION_STALE_CLOSE_TIMEOUT_MS - 60_000)
    const availability = await engine.getStaleCloseAvailability(requestId)
    expect(availability?.threshold).to.equal(2)
    expect(availability?.available).to.equal(false)
    expect(Date.parse(availability!.availableAt) - Date.parse(availability!.openedAt)).to.equal(REGISTRATION_STALE_CLOSE_TIMEOUT_MS)

    const signingsBefore = await count(fx.elec.ctx.db, 'select count(*) as n from AdminSigning')
    const err = await expectStaleCloseRefusal(engine.closeStaleRegistrationRequest(requestId, { rejectionReason: 'No co-signer answered' }, fx.holders[1]!.sign), 'too-early')
    expect(err.availableAt).to.equal(availability!.availableAt)
    expect((await requestRow(fx.elec.ctx.db, requestId)).Status).to.equal('p')
    expect(await count(fx.elec.ctx.db, 'select count(*) as n from AdminSigning')).to.equal(signingsBefore)
  })

  it('after the timeout: one officer closes it as rejected, the reason is recorded, and the decision publishes', async () => {
    const engine = engineAt(fx, fx.holders[1]!.user, Date.now() + REGISTRATION_STALE_CLOSE_TIMEOUT_MS + 60_000)
    expect((await engine.getStaleCloseAvailability(requestId))?.available).to.equal(true)

    await engine.closeStaleRegistrationRequest(requestId, { rejectionReason: '  No co-signer answered  ' }, fx.holders[1]!.sign)

    const row = await requestRow(fx.elec.ctx.db, requestId)
    expect(row.Status).to.equal('r')
    expect(row.RejectionReason).to.equal('No co-signer answered')
    expect(row.DecidingOfficerUserId).to.equal(fx.holders[1]!.user.id)
    expect(await engine.getStaleCloseAvailability(requestId)).to.equal(undefined)
    const read = await engine.getRegistrationRequest(requestId)
    expect(read?.verificationChecklist).to.deep.equal(['none'])

    // The voter is told: one officer's signed RegistrationDecision commits at threshold 2.
    const transport = new P2pRegistrationTransport({
      openStrand: async () => strandPort(fx.elec.ctx.db),
      computeDigest: async () => new Uint8Array(32),
      strandId: `stale-close-${crypto.randomUUID()}`,
      decisionSigner: { authorityId: fx.authorityId, sign: fx.holders[1]!.sign }
    })
    const result = await engine.publishRegistrationDecision({ authorityId: fx.authorityId, publishDecision: (d) => transport.publishDecision(d) }, requestId)
    expect(result.outcome).to.equal('published')
    expect(result.publishedStatus).to.equal('r')
    const decision = await fx.elec.ctx.db.prepare('select Status, Reason from RegistrationDecision where RequestId = :requestId').get({ requestId })
    expect(decision?.Status).to.equal('r')
    expect(decision?.Reason).to.equal('No co-signer answered')
  })

  it('the ordinary single-officer reject stays refused at threshold 2, even after the timeout', async () => {
    const engine = engineAt(fx, fx.holders[1]!.user, Date.now() + 30 * DAY_MS)
    let caught: unknown
    try {
      await engine.rejectRegistrationRequest(requestId, { checklist: ['none'], rejectionReason: 'veto' }, fx.holders[1]!.sign)
    } catch (err) {
      caught = err
    }
    expect(caught).to.be.instanceOf(Error)
    expect((await requestRow(fx.elec.ctx.db, requestId)).Status).to.equal('p')
  })

  it('an officer without vrg is refused', async () => {
    const engine = engineAt(fx, fx.nonHolder.user, Date.now() + 30 * DAY_MS)
    await expectStaleCloseRefusal(engine.closeStaleRegistrationRequest(requestId, { rejectionReason: 'x' }, fx.nonHolder.sign), 'not-authorized')
    expect((await requestRow(fx.elec.ctx.db, requestId)).Status).to.equal('p')
  })

  it('an empty reason is refused', async () => {
    const engine = engineAt(fx, fx.holders[1]!.user, Date.now() + 30 * DAY_MS)
    await expectStaleCloseRefusal(engine.closeStaleRegistrationRequest(requestId, { rejectionReason: '   ' }, fx.holders[1]!.sign), 'reason-required')
  })

  it('a decided request is refused', async () => {
    const engine = engineAt(fx, fx.holders[1]!.user, Date.now() + 30 * DAY_MS)
    await engine.closeStaleRegistrationRequest(requestId, { rejectionReason: 'stale' }, fx.holders[1]!.sign)
    await expectStaleCloseRefusal(engine.closeStaleRegistrationRequest(requestId, { rejectionReason: 'again' }, fx.holders[2]!.sign), 'not-pending')
  })

  it('the single-officer signing option completes a session for a holder and refuses a non-holder', async () => {
    const digestExpr = "select Digest('stale-close-probe', :probe) as d"
    const holderCtx = { db: fx.elec.ctx.db, user: fx.holders[1]!.user }
    const reached = await seedSignedMutation(holderCtx, fx.authorityId, 'vrg', 1, digestExpr, { probe: crypto.randomUUID() }, fx.holders[1]!.sign, { singleOfficer: true })
    expect(await count(fx.elec.ctx.db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce: reached })).to.equal(1)

    const before = await count(fx.elec.ctx.db, 'select count(*) as n from AdminSignature')
    let caught: unknown
    try {
      await seedSignedMutation({ db: fx.elec.ctx.db, user: fx.nonHolder.user }, fx.authorityId, 'vrg', 1, digestExpr, { probe: crypto.randomUUID() }, fx.nonHolder.sign, { singleOfficer: true })
    } catch (err) {
      caught = err
    }
    expect(caught).to.be.instanceOf(Error)
    expect(String((caught as Error).message)).to.include('single-officer close')
    expect(await count(fx.elec.ctx.db, 'select count(*) as n from AdminSignature')).to.equal(before)
  })
})

describe('closing a stale registration request (vrg threshold 1)', function () {
  this.timeout(60_000)

  it('is refused: one approval decides it, so the ordinary reject applies', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: [{ policy: 'rad', threshold: 1 }, { policy: 'vrg', threshold: 1 }] as any })
    await provisionTestIntakeRecipient(fx.elec.ctx, fx.authorityId)
    const requestId = await submitPending(fx)
    const engine = engineAt(fx, fx.holders[1]!.user, Date.now() + 30 * DAY_MS)
    expect((await engine.getStaleCloseAvailability(requestId))?.available).to.equal(false)
    await expectStaleCloseRefusal(engine.closeStaleRegistrationRequest(requestId, { rejectionReason: 'x' }, fx.holders[1]!.sign), 'threshold-is-one')
  })
})
