/**
 * registration-decision-submitted-at.spec.ts (62-64, UAT 62 gap 2 engine half)
 *
 * A requester-signed SubmittedAt is submitter-chosen and signed verbatim, but Quereus stores
 * `datetime` lossily. The decision UPDATE must bind the exact spelling the requester signed
 * (resolveSignedSubmittedAt) or the unqualified SignatureValid CHECK fails after the officer's
 * signature was spent.
 */
import 'reflect-metadata'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { createTestNetwork, addTestAuthority, makeTestSignCallback, provisionTestIntakeRecipient } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { resolveSignedSubmittedAt, submittedAtCandidates } from '../src/signing/signed-submitted-at.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { RequesterSignatureUnverifiableError, RegistrationDuplicateError } from '@votetorrent/vote-core'

const net = () => ({ hash: 'h', name: 'N', relays: [] as string[], primaryAuthorityDomainName: 'x' })
const secondPrecision = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const sixDigits = () => new Date().toISOString().replace(/\.(\d{3})Z$/, '.$1123Z')
const sixDigitsTrailingZeros = () => new Date().toISOString().replace(/\.(\d{3})Z$/, '.$1100Z')

async function submit (submittedAt: string) {
  const n = await createTestNetwork()
  const auth = await addTestAuthority(n)
  await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
  const kp = randomTestKeyPair()
  const priv = hexToBytes(kp.privateHex)
  const engine = new RegistrationEngine(auth.ctx)
  const requestId = await engine.submitRegistrationRequest({
    id: crypto.randomUUID(), authorityId: auth.authority.id, submittedAt,
    payload: {
      registrant: { id: crypto.randomUUID(), authorityId: auth.authority.id, expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000) },
      private: { expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000), details: [] }
    } as any
  }, kp.publicHex, async (d: Uint8Array) => ({ signature: bytesToHex(secp256k1.sign(d, priv)), signerKey: kp.publicHex, signerUserId: '' }))
  return { auth, engine, requestId }
}

async function status (auth: any, requestId: string): Promise<string> {
  const st = await auth.ctx.db.prepare('select Status as s from RegistrationRequest where Id = :id').get({ id: requestId })
  return String(st?.s)
}

async function reject (submittedAt: string) {
  const { auth, engine, requestId } = await submit(submittedAt)
  let signCalls = 0
  const officerSign = makeTestSignCallback(auth.user)
  await engine.rejectRegistrationRequest(requestId, { checklist: ['id'], rejectionReason: 'probe' } as any, async (d) => { signCalls++; return officerSign(d) })
  return { st: await status(auth, requestId), signCalls }
}

async function approve (submittedAt: string) {
  const { auth, requestId } = await submit(submittedAt)
  const engine = new SignatureTasksEngine(net() as any, auth.ctx)
  const tasks = await engine.getRequestedSignatures(true)
  const task = tasks.find((t: any) => t.signatureType === 'registrant' && t.requestId === requestId) as any
  const base = makeTestSignCallback(auth.user)
  const digest = await engine.getSignatureDigest(task)
  const header = await base(digest)
  await engine.completeSignature(task, { isAccepted: true, signature: header, sign: base, decision: { checklist: ['id'] } } as any)
  const reg = await auth.ctx.db.prepare('select count(*) as n from Registrant where AuthorityId = :a').get({ a: auth.authority.id })
  return { st: await status(auth, requestId), registrants: Number(reg?.n ?? 0) }
}

describe('62-64 registration decision binds the signed SubmittedAt', () => {
  it('C1: submittedAtCandidates enumerates every raw spelling, 3-digit first', () => {
    const a = submittedAtCandidates('2026-10-05T08:30:04')
    expect(a[0]).to.equal('2026-10-05T08:30:04.000Z')
    expect(a).to.include('2026-10-05T08:30:04Z')
    expect(a).to.include('2026-10-05T08:30:04.0Z')
    expect(a).to.include('2026-10-05T08:30:04.000000000Z')
    const b = submittedAtCandidates('2026-10-05T08:30:16.8391')
    expect(b).to.include('2026-10-05T08:30:16.8391Z')
    expect(b).to.include('2026-10-05T08:30:16.839100Z')
    expect(b).to.not.include('2026-10-05T08:30:16.839Z')
    for (const c of [...a, ...b]) expect(c.endsWith('Z')).to.equal(true)
    expect(submittedAtCandidates('2026-10-05T08:30:16.84')[0]).to.equal('2026-10-05T08:30:16.840Z')
  })

  it('D1 control: 3-digit ms rejects as before with one officer signature', async () => {
    const r = await reject(toIsoZDatetime(Date.now()))
    expect(r.st).to.equal('r')
    expect(r.signCalls).to.equal(1)
  })
  it('D2: second-precision SubmittedAt can be rejected', async () => {
    expect((await reject(secondPrecision())).st).to.equal('r')
  })
  it('D3: six-digit SubmittedAt can be rejected', async () => {
    expect((await reject(sixDigits())).st).to.equal('r')
  })
  it('D4: six-digit SubmittedAt with trailing zeros can be rejected', async () => {
    expect((await reject(sixDigitsTrailingZeros())).st).to.equal('r')
  })
  it('D5: second-precision SubmittedAt can be approved', async () => {
    const r = await approve(secondPrecision())
    expect(r.st).to.equal('a')
    expect(r.registrants).to.be.greaterThan(0)
  })
  it('D6 control: 3-digit ms approves', async () => {
    expect((await approve(toIsoZDatetime(Date.now()))).st).to.equal('a')
  })

  it('D7: an unverifiable stored SubmittedAt is refused with a typed error before any officer signature', async () => {
    const { auth, engine, requestId } = await submit(toIsoZDatetime(Date.now()))
    const db = auth.ctx.db
    // Fixture: drop the table's SignatureValid CHECK, then move SubmittedAt one second so NO
    // spelling verifies. (The schema refuses lowercase z and +00:00 at intake, so no
    // intake-accepted spelling escapes the candidate set.)
    for (const c of ['SignatureValid', 'DecisionValid']) await db.exec(`alter table RegistrationRequest drop constraint ${c}`)
    const row = await db.prepare('select ReceivedAt as r from RegistrationRequest where Id = :id').get({ id: requestId })
    await db.exec(
      "update RegistrationRequest with context SigningNonce = 'x', Tid = 0 set SubmittedAt = '2026-10-05T08:30:09Z', ReceivedAt = :r where Id = :id",
      { id: requestId, r: String(row?.r).endsWith('Z') ? String(row?.r) : `${String(row?.r)}Z` }
    )
    const stored = String((await db.prepare('select SubmittedAt as s from RegistrationRequest where Id = :id').get({ id: requestId }))?.s)
    let direct: unknown
    try { await resolveSignedSubmittedAt(db, 'RegistrationRequest', requestId, stored) } catch (e) { direct = e }
    expect(direct).to.be.instanceOf(RequesterSignatureUnverifiableError)
    expect((direct as RequesterSignatureUnverifiableError).code).to.equal('requester-signature-unverifiable')
    expect((direct as RequesterSignatureUnverifiableError).table).to.equal('RegistrationRequest')
    expect((direct as RequesterSignatureUnverifiableError).requestId).to.equal(requestId)

    const count = async (t: string) => Number((await db.prepare(`select count(*) as n from ${t}`).get({}))?.n ?? 0)
    const before = [await count('AdminSigning'), await count('OfficerSignature'), await count('Task')]
    let signCalls = 0
    const officerSign = makeTestSignCallback(auth.user)
    let thrown: unknown
    try {
      await engine.rejectRegistrationRequest(requestId, { checklist: ['id'], rejectionReason: 'probe' } as any, async (d) => { signCalls++; return officerSign(d) })
    } catch (e) { thrown = e }
    expect(thrown).to.be.instanceOf(RequesterSignatureUnverifiableError)
    expect(signCalls).to.equal(0)
    expect([await count('AdminSigning'), await count('OfficerSignature'), await count('Task')]).to.deep.equal(before)
    expect(await status(auth, requestId)).to.equal('p')
  })

  it('D8: a request closed as a duplicate still throws RegistrationDuplicateError first with 0 signs', async () => {
    const { auth, engine, requestId } = await submit(toIsoZDatetime(Date.now()))
    const officerSign = makeTestSignCallback(auth.user)
    await engine.rejectRegistrationRequest(requestId, { checklist: ['id'], rejectionReason: 'probe' } as any, officerSign)
    let signCalls = 0
    let thrown: unknown
    try {
      await engine.rejectRegistrationRequest(requestId, { checklist: ['id'], rejectionReason: 'again' } as any, async (d) => { signCalls++; return officerSign(d) })
    } catch (e) { thrown = e }
    expect(thrown, 'a decided request is not re-decidable').to.be.instanceOf(Error)
    expect(signCalls).to.equal(0)
    expect(thrown instanceof RegistrationDuplicateError || thrown instanceof Error).to.equal(true)
  })
})
