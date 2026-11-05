/**
 * filesystem-registration-transport.spec.ts — Phase 48 Plan 09 (D-01)
 *
 * Binding-local round-trip spec for `FilesystemRegistrationTransport`, run
 * directly against a real temp directory — no database, no engine, no
 * network. Proves: stage -> authority-side intake read -> decision publish
 * -> poll, with a GENUINELY signed request (real secp256k1, not a string
 * literal), path traversal refused before any write, a malformed document
 * skipped rather than fatal, and a stale cursor re-delivering rather than
 * losing a decision.
 *
 * DECLARED BLIND SPOT: this spec exercises no schema CHECK. A signature
 * accepted here says nothing about whether the real `SignatureValid` CHECK
 * would accept it at INSERT time — that proof lives in
 * `registration-request.spec.ts` (48-07), against the real Quereus schema.
 * This module is a courier; it verifies nothing, and neither does this spec.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import type { RegistrationRequestInit, Signature } from '@votetorrent/vote-core'
import {
  FilesystemRegistrationTransport
} from '../src/registration/transport/filesystem-registration-transport.js'
import type { RequestDigestFn } from '../src/registration/transport/filesystem-registration-transport.js'

/**
 * Real secp256k1 keypair + sign callback (@noble/curves v2 defaults —
 * `prehash:true`). Adapted from `authority-transport.spec.ts:31-40`;
 * `signerUserId` is deliberately empty — a prospective registrant has no
 * `User` row, matching `registration-request.spec.ts`'s own convention.
 */
function makeRealSigner (): { publicHex: string; sign: (digest: Uint8Array) => Promise<Signature> } {
  const privBytes = secp256k1.utils.randomSecretKey()
  const publicHex = bytesToHex(secp256k1.getPublicKey(privBytes))
  const sign = async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signature: bytesToHex(sig), signerKey: publicHex, signerUserId: '' }
  }
  return { publicHex, sign }
}

/**
 * A deterministic stand-in for the real schema digest. A deterministic
 * stand-in is correct HERE precisely because this spec proves COURIER
 * behavior (does the byte sequence the callback receives match what
 * `computeDigest` produced, does the resulting document round-trip) — not
 * schema conformance. The real digest, injected in production, must match
 * the schema's `SignatureValid` CHECK field-for-field (48-07's DG-1
 * expression); that is the intake plan's contract, not this module's.
 */
const computeDigest: RequestDigestFn = async (init) => {
  const encoder = new TextEncoder()
  return encoder.encode(`stub-digest:${init.id}`)
}

let idSeq = 0
function nextId (): string {
  idSeq += 1
  return `fs-transport-req-${idSeq}`
}

/**
 * A valid `RegistrationRequestInit` with a plausible payload and an
 * EXPLICIT, fixture-chosen `submittedAt` — never `new Date().toISOString()`.
 * The submitter chooses `submittedAt` at signing time, so the fixture must
 * too; a generated one would make case 3's byte-identity assertion vacuous.
 */
function makeInit (overrides: Partial<RegistrationRequestInit> = {}): RegistrationRequestInit {
  const id = overrides.id ?? nextId()
  return {
    id,
    authorityId: 'fs-transport-authority',
    payload: {
      registrant: { id, authorityId: 'fs-transport-authority', expiration: '2099-01-01T00:00:00.000Z' },
      public: { lastName: 'Torrent', firstName: 'Vote' },
      private: { expiration: '2099-01-01T00:00:00.000Z', details: [] }
    },
    // Fixed fixture literal, chosen well before any test runs, so it can
    // never coincide with the courier's own stagedAt write-time marker.
    submittedAt: '2020-06-15T09:30:00.123Z',
    ...overrides
  }
}

describe('filesystem registration transport', () => {
  let root: string
  let transport: FilesystemRegistrationTransport

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fs-registration-transport-'))
    transport = new FilesystemRegistrationTransport({ rootDir: root, computeDigest })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('1. stages one document and returns the id', async () => {
    const init = makeInit()
    const { publicHex, sign } = makeRealSigner()
    const signature = await sign(await computeDigest(init, publicHex))

    const returnedId = await transport.submitRequest(init, publicHex, signature)
    expect(returnedId).to.equal(init.id)

    const files = (await readdir(join(root, 'requests'))).filter((f) => f.endsWith('.json'))
    expect(files).to.have.lengthOf(1)
    expect(files[0]).to.match(new RegExp(`^\\d{16}-${init.id}\\.json$`))
  })

  it('2. resolves a callback through the injected digest', async () => {
    const init = makeInit()
    const { publicHex, sign } = makeRealSigner()

    let invocationCount = 0
    let receivedDigest: Uint8Array | undefined
    const callback = async (digest: Uint8Array): Promise<Signature> => {
      invocationCount += 1
      receivedDigest = digest
      return await sign(digest)
    }

    await transport.submitRequest(init, publicHex, callback)

    const expectedDigest = await computeDigest(init, publicHex)
    expect(invocationCount).to.equal(1)
    expect(receivedDigest).to.deep.equal(expectedDigest)

    const files = await readdir(join(root, 'requests'))
    const raw = await readFile(join(root, 'requests', files[0]!), 'utf8')
    const parsed = JSON.parse(raw) as { signature: Signature }
    expect(parsed.signature.signature).to.be.a('string')
    // No private-key hex (64 hex chars = 32 bytes) anywhere in the persisted
    // document — only compressed public keys (66 hex chars) and compact
    // signatures (128 hex chars) are ever written.
    expect(raw).to.not.match(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i)
  })

  it("3. round-trips the payload and the submitter's submittedAt field-for-field", async () => {
    const init = makeInit()
    const { publicHex, sign } = makeRealSigner()
    const signature = await sign(await computeDigest(init, publicHex))

    await transport.submitRequest(init, publicHex, signature)
    const staged = await transport.readStagedRequests()

    expect(staged).to.have.lengthOf(1)
    const entry = staged[0]!
    expect(entry.init.payload).to.deep.equal(init.payload)
    expect(entry.requesterKey).to.equal(publicHex)
    expect(entry.signature).to.deep.equal(signature)
    // Byte-identical to the fixture literal — not re-formatted, not re-stamped.
    expect(entry.init.submittedAt).to.equal(init.submittedAt)
    expect(entry.stagedAt).to.be.a('string')
    expect(entry.stagedAt).to.not.equal(entry.init.submittedAt)
  })

  it('4. bridge markers survive unchanged (D-03)', async () => {
    const bridgeInit = makeInit({ issuerType: 'bridge', bridgeId: 'fs-transport-bridge-1' })
    const { publicHex: bridgeKey, sign: bridgeSign } = makeRealSigner()
    await transport.submitRequest(bridgeInit, bridgeKey, await bridgeSign(await computeDigest(bridgeInit, bridgeKey)))

    const registrantInit = makeInit()
    const { publicHex: registrantKey, sign: registrantSign } = makeRealSigner()
    await transport.submitRequest(registrantInit, registrantKey, await registrantSign(await computeDigest(registrantInit, registrantKey)))

    const staged = await transport.readStagedRequests()
    const bridgeEntry = staged.find((s) => s.requestId === bridgeInit.id)
    const registrantEntry = staged.find((s) => s.requestId === registrantInit.id)

    expect(bridgeEntry?.init.issuerType).to.equal('bridge')
    expect(bridgeEntry?.init.bridgeId).to.equal('fs-transport-bridge-1')
    expect(registrantEntry?.init.bridgeId).to.be.undefined
  })

  it('5. cursors advance monotonically', async () => {
    const cursors: string[] = []
    for (let i = 0; i < 3; i++) {
      const init = makeInit()
      const { publicHex, sign } = makeRealSigner()
      await transport.submitRequest(init, publicHex, await sign(await computeDigest(init, publicHex)))
      const staged = await transport.readStagedRequests(cursors[cursors.length - 1])
      const last = staged[staged.length - 1]!
      cursors.push(last.cursor)
    }

    expect(cursors[1]! > cursors[0]!).to.equal(true)
    expect(cursors[2]! > cursors[1]!).to.equal(true)

    const fromFirst = await transport.readStagedRequests(cursors[0])
    expect(fromFirst.map((s) => s.cursor)).to.deep.equal([cursors[1], cursors[2]])
  })

  it('6. decision round-trip', async () => {
    const requestId = nextId()
    const cursor = await transport.publishDecision({ requestId, status: 'a', decidedAt: new Date().toISOString() })
    expect(cursor).to.be.a('string')

    const notices = await transport.pollDecisions()
    expect(notices).to.have.lengthOf(1)
    expect(notices[0]!.requestId).to.equal(requestId)
    expect(notices[0]!.status).to.equal('a')
    expect(notices[0]!.cursor).to.be.a('string').and.not.equal('')

    const afterCursor = await transport.pollDecisions(notices[0]!.cursor)
    expect(afterCursor).to.deep.equal([])
  })

  it('7. stale cursor re-delivers rather than loses', async () => {
    await transport.publishDecision({ requestId: nextId(), status: 'a', decidedAt: new Date().toISOString() })
    await transport.publishDecision({ requestId: nextId(), status: 'r', reason: 'ineligible', decidedAt: new Date().toISOString() })

    // A cursor from BEFORE either publish (empty string sorts before any
    // zero-padded seq) is "stale" relative to both.
    const staleCursor = ''
    const firstPoll = await transport.pollDecisions(staleCursor)
    const secondPoll = await transport.pollDecisions(staleCursor)

    expect(firstPoll).to.have.lengthOf(2)
    expect(secondPoll).to.have.lengthOf(2)
    expect(secondPoll.map((n) => n.requestId)).to.deep.equal(firstPoll.map((n) => n.requestId))
  })

  it('8. a rejection carries its reason (D-06)', async () => {
    const requestId = nextId()
    await transport.publishDecision({
      requestId,
      status: 'r',
      reason: 'Requester-key signature did not match the payload on file',
      decidedAt: new Date().toISOString()
    })

    const notices = await transport.pollDecisions()
    const notice = notices.find((n) => n.requestId === requestId)
    expect(notice?.status).to.equal('r')
    expect(notice?.reason).to.equal('Requester-key signature did not match the payload on file')
  })

  it('9. path traversal is refused before any write', async () => {
    const traversalPayloads = ['../escape', '../../etc/passwd', '/abs', '.', '..']
    const { publicHex, sign } = makeRealSigner()

    for (const badId of traversalPayloads) {
      const init = makeInit({ id: badId })
      let caught: unknown
      try {
        await transport.submitRequest(init, publicHex, await sign(await computeDigest(init, publicHex)))
      } catch (err) {
        caught = err
      }
      expect(caught, `submitRequest must reject id ${JSON.stringify(badId)}`).to.be.instanceOf(Error)
    }

    // assertSafeIdentifier throws BEFORE ensureLayout ever runs, so no
    // subdirectory — and therefore no file — was ever created under root.
    const rootEntries = await readdir(root)
    expect(rootEntries).to.deep.equal([])
  })

  it('10. a malformed document is skipped, not fatal', async () => {
    const init = makeInit()
    const { publicHex, sign } = makeRealSigner()
    // Trigger ensureLayout / create requests/ via one valid submission first.
    await transport.submitRequest(init, publicHex, await sign(await computeDigest(init, publicHex)))

    const requestsDir = join(root, 'requests')
    await writeFile(join(requestsDir, '0000000000000001-junk.json'), 'not json at all', 'utf8')
    await writeFile(join(requestsDir, '0000000000000002-stray.tmp'), 'irrelevant', 'utf8')

    const staged = await transport.readStagedRequests()
    expect(staged).to.have.lengthOf(1)
    expect(staged[0]!.requestId).to.equal(init.id)

    expect(transport.skipped.some((s) => s.file === '0000000000000001-junk.json')).to.equal(true)
    // The stray .tmp file never matches the <16-digit>-<id>.json pattern, so
    // it is silently excluded from the candidate set — never even attempted,
    // never recorded as a skip.
    expect(transport.skipped.some((s) => s.file.endsWith('.tmp'))).to.equal(false)
  })

  it('11. (WR-10) a decision document whose status is outside the vote-core union is REFUSED, not coerced through', async () => {
    // Publish one legitimate decision first so decisions/ exists and the layout is real.
    await transport.publishDecision({ requestId: nextId(), status: 'a', decidedAt: new Date().toISOString() })

    // Hand-write a drop file carrying a status the schema does not know. Before WR-10 this passed
    // the bare `typeof status === 'string'` check and was coerced with
    // `status as RegistrationRequestStatus`, so it surfaced as a well-typed
    // RegistrationDecisionNotice whose downstream `switch (notice.status)` took NO branch — a
    // decision silently lost, which this seam's contract forbids ("loss is not" permitted).
    const decisionsDir = join(root, 'decisions')
    await writeFile(
      join(decisionsDir, '0000000000009999-vocabulary-drift.json'),
      // `version: 1` is mandatory — without it readDocuments skips the entry before pollDecisions
      // ever sees the status, and the test would pass vacuously.
      JSON.stringify({ version: 1, requestId: nextId(), status: 'approved', decidedAt: new Date().toISOString() }),
      'utf8'
    )

    let caught: unknown
    try {
      await transport.pollDecisions()
    } catch (err) {
      caught = err
    }
    expect(caught, 'an unknown status code must be refused, not dropped or coerced').to.be.instanceOf(Error)
    expect((caught as Error).message).to.include('outside the vote-core union')
    // The refusal must still name the binding that produced it — the seam helper takes a `where`
    // prefix precisely so a shared guard does not produce an anonymous error.
    expect((caught as Error).message).to.include('FilesystemRegistrationTransport.pollDecisions')
    // A vocabulary mismatch is NOT an ordinary malformed-document skip: it must surface rather
    // than join the `skipped` accumulator, because every later notice from the same producer
    // would be mis-decided the same way.
    expect(transport.skipped.some((s) => s.file.includes('vocabulary-drift'))).to.equal(false)
  })

  it('12. (WR-11) `skipped` reports the most recent read only — a permanently-malformed file is not re-appended on every poll', async () => {
    const init = makeInit()
    const { publicHex, sign } = makeRealSigner()
    await transport.submitRequest(init, publicHex, await sign(await computeDigest(init, publicHex)))

    const requestsDir = join(root, 'requests')
    await writeFile(join(requestsDir, '0000000000000001-junk.json'), 'not json at all', 'utf8')

    // Three reads of the SAME unchanged directory. Before WR-11 `skipped` was a lifetime
    // accumulator, so the one permanently-malformed file appeared 1, then 2, then 3 times — a
    // host mapping it into TransportSyncReport.errorItemIds rendered the same item id N times
    // after N syncs, and the array grew without bound on a long-lived instance.
    await transport.readStagedRequests()
    const afterFirst = transport.skipped.length
    await transport.readStagedRequests()
    const afterSecond = transport.skipped.length
    await transport.readStagedRequests()
    const afterThird = transport.skipped.length

    expect(afterFirst, 'the malformed file must be reported once by the first read').to.equal(1)
    expect(afterSecond, 'a second read of the same directory must report it once, not twice').to.equal(1)
    expect(afterThird, 'and a third read must still report it once — the array is per-read, not cumulative').to.equal(1)
    expect(transport.skipped[0]!.file).to.equal('0000000000000001-junk.json')

    // Once the offending file is gone, the NEXT read reports nothing — a stale skip must not
    // outlive the condition that produced it.
    await rm(join(requestsDir, '0000000000000001-junk.json'))
    await transport.readStagedRequests()
    expect(transport.skipped, 'a resolved skip must not survive into the next read').to.deep.equal([])
  })
})
