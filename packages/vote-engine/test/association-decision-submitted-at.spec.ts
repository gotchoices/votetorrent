/**
 * association-decision-submitted-at.spec.ts (62-64): AssociationRequest challenge and terminal
 * transitions bind the exact SubmittedAt the requester signed.
 */
import 'reflect-metadata'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { createTestNetwork, addTestAuthority, makeTestSignCallback } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { AssociationEngine } from '../src/association/association-engine.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { resolveSignedSubmittedAt } from '../src/signing/signed-submitted-at.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilesystemAssociationTransport } from '../src/association/transport/filesystem-association-transport.js'
import { RequesterSignatureUnverifiableError } from '@votetorrent/vote-core'

const secondPrecision = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const sixDigits = () => new Date().toISOString().replace(/\.(\d{3})Z$/, '.$1123Z')

async function setup (submittedAt: string) {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const officerSign = makeTestSignCallback(auth.user)
  const registrantId = `adsa-registrant-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await new RegistrationEngine(auth.ctx).createRegistrant(
    { id: registrantId, authorityId: auth.authority.id, privateCid: 'adsa-private-cid', expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000) },
    officerSign
  )
  const engine = new AssociationEngine(auth.ctx)
  const kp = randomTestKeyPair()
  const priv = hexToBytes(kp.privateHex)
  const id = await engine.submitAssociationRequest({
    id: crypto.randomUUID(), authorityId: auth.authority.id, registrantId, deviceKey: kp.publicHex, submittedAt
  }, kp.publicHex, async (d: Uint8Array) => ({ signature: bytesToHex(secp256k1.sign(d, priv)), signerKey: kp.publicHex, signerUserId: '' }))
  return { auth, engine, id, registrantId, officerSign, kp }
}

async function status (auth: any, id: string): Promise<string> {
  return String((await auth.ctx.db.prepare('select Status as s from AssociationRequest where Id = :id').get({ id }))?.s)
}

async function rejectViaPass (submittedAt: string) {
  const s = await setup(submittedAt)
  const published: string[] = []
  await (s.engine as any).rejectPendingRequest(
    { id: s.id, authorityId: s.auth.authority.id, registrantId: s.registrantId, deviceKey: s.kp.publicHex },
    'test-reason', s.officerSign, { publishDecision: async (d: { status: string }) => { published.push(d.status); return 'cid' } }
  )
  return { st: await status(s.auth, s.id), published }
}

describe('62-64 association decisions bind the signed SubmittedAt', () => {
  it('A1 control: a 3-digit-ms request goes p -> c -> r', async () => {
    const r = await rejectViaPass(toIsoZDatetime(Date.now()))
    expect(r.st).to.equal('r')
    expect(r.published).to.deep.equal(['r'])
  })
  it('A2: a second-precision request completes challenge then reject', async () => {
    expect((await rejectViaPass(secondPrecision())).st).to.equal('r')
  })
  it('A3: a six-digit request completes challenge then reject', async () => {
    expect((await rejectViaPass(sixDigits())).st).to.equal('r')
  })

  async function tamper () {
    const s = await setup(toIsoZDatetime(Date.now()))
    const db = s.auth.ctx.db
    for (const c of ['SignatureValid', 'TransitionValid']) await db.exec(`alter table AssociationRequest drop constraint ${c}`)
    const row = await db.prepare('select ReceivedAt as r from AssociationRequest where Id = :id').get({ id: s.id })
    await db.exec(
      "update AssociationRequest with context SigningNonce = 'x', Tid = 0 set SubmittedAt = '2026-10-05T08:30:09Z', ReceivedAt = :r where Id = :id",
      { id: s.id, r: String(row?.r).endsWith('Z') ? String(row?.r) : `${String(row?.r)}Z` }
    )
    return s
  }

  it('A4: an unverifiable stored SubmittedAt throws RequesterSignatureUnverifiableError (AssociationRequest)', async () => {
    const s = await tamper()
    const stored = String((await s.auth.ctx.db.prepare('select SubmittedAt as s from AssociationRequest where Id = :id').get({ id: s.id }))?.s)
    let thrown: unknown
    try { await resolveSignedSubmittedAt(s.auth.ctx.db, 'AssociationRequest', s.id, stored) } catch (e) { thrown = e }
    expect(thrown).to.be.instanceOf(RequesterSignatureUnverifiableError)
    expect((thrown as RequesterSignatureUnverifiableError).table).to.equal('AssociationRequest')
  })

  it('A5: records how processPendingAssociationRequests treats one undecidable row (no change in behaviour)', async () => {
    const s = await tamper()
    const rootDir = await mkdtemp(join(tmpdir(), 'assoc-decision-submitted-at-'))
    try {
      const transport = new FilesystemAssociationTransport({ rootDir })
      // LEG 1 has a per-row try (WR-06): the unverifiable row is skipped and the pass completes.
      const res = await s.engine.processPendingAssociationRequests(s.auth.authority.id, s.officerSign, transport)
      expect(res.challengesIssued).to.equal(0)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
    expect(await status(s.auth, s.id), 'the undecidable row stays pending').to.equal('p')
  })
})
