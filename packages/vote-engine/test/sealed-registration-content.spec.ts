/**
 * sealed-registration-content.spec.ts — Phase 62 Plan 31 (D-49, T-62-01-10), Task 1.
 *
 * C1-C9: proves `src/registration/sealed-registration-content.ts`'s seal/open codec in isolation,
 * against the real Quereus schema, before any engine write/read site flips. No marker placed
 * anywhere in this file may ever appear in a sealed envelope, an error message, or a `console.*`
 * call (C8) — stubbing every console method across every case is this file's own leak tripwire.
 */

import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RegisterInit } from '@votetorrent/vote-core'
import {
  REGISTRANT_PRIVATE_BINDING_LABEL,
  REGISTRANT_PRIVATE_EMPTY_DETAILS,
  isSealedRegistrationContent,
  openRegistrantPrivateDetails,
  openRegistrationPayload,
  registrantPrivateBinding,
  sealRegistrantPrivateDetails,
  sealRegistrationPayload
} from '../src/registration/sealed-registration-content.js'
import { envelopeRecipientUserIds } from '../src/crypto/index.js'
import { IntakeError } from '../src/intake/types.js'
import { addTestAuthority, createTestNetwork, makeTestOutsiderOpener, provisionTestIntakeRecipient } from './fixtures/test-context.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'

function randomMarker (): string {
  return `MARKER-D49-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
}

function makeRegisterInit (fx: TestAuthorityContext, overrides: { requestId: string; lastNameMarker?: string }): RegisterInit {
  return {
    registrant: { id: `${overrides.requestId}-registrant`, authorityId: fx.authority.id, expiration: '2099-01-01T00:00:00Z' },
    public: { lastName: overrides.lastNameMarker ?? 'Doe', firstName: 'Jane' },
    private: { expiration: '2099-01-01T00:00:00Z', details: [] }
  }
}

describe('src/registration/sealed-registration-content.ts (D-49, T-62-01-10)', () => {
  // C8: captured across every case below — never cleared mid-describe, so a leak anywhere in this
  // file's own run is caught regardless of which case produced it.
  const consoleCalls: string[] = []
  const originalConsole = { log: console.log, warn: console.warn, error: console.error }

  before(() => {
    console.log = (...args: unknown[]) => { consoleCalls.push(args.map(String).join(' ')); }
    console.warn = (...args: unknown[]) => { consoleCalls.push(args.map(String).join(' ')); }
    console.error = (...args: unknown[]) => { consoleCalls.push(args.map(String).join(' ')); }
  })

  after(() => {
    console.log = originalConsole.log
    console.warn = originalConsole.warn
    console.error = originalConsole.error
  })

  async function freshAuthority (): Promise<TestAuthorityContext> {
    return addTestAuthority(await createTestNetwork())
  }

  describe('C1 — seal then open (recipient)', () => {
    it('no marker substring in the sealed text; recipients equal the founder; open gives opened + deep-equal payload', async () => {
      const fx = await freshAuthority()
      await provisionTestIntakeRecipient(fx.ctx, fx.authority.id)
      const marker = randomMarker()
      const requestId = 'c1-req'
      const init = makeRegisterInit(fx, { requestId, lastNameMarker: marker })
      const plaintext = JSON.stringify(init)
      const payloadCidRow = await fx.ctx.db.prepare('select Digest(:payload) as d').get({ payload: plaintext })
      const payloadCid = payloadCidRow!.d as string

      const sealed = await sealRegistrationPayload(fx.ctx.db, { authorityId: fx.authority.id, requestId, payloadCid, plaintext })
      expect(sealed).to.not.include(marker)
      expect(envelopeRecipientUserIds(sealed)).to.have.members([fx.user.id])

      const read = await openRegistrationPayload(fx.ctx.db, fx.ctx.intakeOpener, { requestId, payloadCid, stored: sealed })
      expect(read.access).to.equal('opened')
      expect(read.payload).to.deep.equal(init)
    })
  })

  describe('C2 — no opener / non-recipient', () => {
    it('undefined opener gives no-opener; outsider opener gives not-a-recipient; payload undefined in both', async () => {
      const fx = await freshAuthority()
      await provisionTestIntakeRecipient(fx.ctx, fx.authority.id)
      const requestId = 'c2-req'
      const init = makeRegisterInit(fx, { requestId })
      const plaintext = JSON.stringify(init)
      const payloadCidRow = await fx.ctx.db.prepare('select Digest(:payload) as d').get({ payload: plaintext })
      const payloadCid = payloadCidRow!.d as string
      const sealed = await sealRegistrationPayload(fx.ctx.db, { authorityId: fx.authority.id, requestId, payloadCid, plaintext })

      const noOpener = await openRegistrationPayload(fx.ctx.db, undefined, { requestId, payloadCid, stored: sealed })
      expect(noOpener.access).to.equal('no-opener')
      expect(noOpener.payload).to.equal(undefined)

      const { opener: outsiderOpener } = await makeTestOutsiderOpener()
      const notRecipient = await openRegistrationPayload(fx.ctx.db, outsiderOpener, { requestId, payloadCid, stored: sealed })
      expect(notRecipient.access).to.equal('not-a-recipient')
      expect(notRecipient.payload).to.equal(undefined)
    })
  })

  describe('C3 — tier-2 recheck on a sealed row', () => {
    it('sealing P2 under a binding whose digest is Digest(P1) opens as tampered', async () => {
      const fx = await freshAuthority()
      await provisionTestIntakeRecipient(fx.ctx, fx.authority.id)
      const requestId = 'c3-req'
      const initP1 = makeRegisterInit(fx, { requestId, lastNameMarker: 'P1-Name' })
      const initP2 = makeRegisterInit(fx, { requestId, lastNameMarker: 'P2-Name' })
      const p1Json = JSON.stringify(initP1)
      const p1CidRow = await fx.ctx.db.prepare('select Digest(:payload) as d').get({ payload: p1Json })
      const p1Cid = p1CidRow!.d as string

      // A peer holding a copied PayloadCid (p1Cid) seals a DIFFERENT plaintext (P2) under that same
      // binding digest — exactly what `sealRegistrationPayload` would do if called with P2's text but
      // P1's cid.
      const sealedP2UnderP1Cid = await sealRegistrationPayload(fx.ctx.db, {
        authorityId: fx.authority.id, requestId, payloadCid: p1Cid, plaintext: JSON.stringify(initP2)
      })

      const read = await openRegistrationPayload(fx.ctx.db, fx.ctx.intakeOpener, { requestId, payloadCid: p1Cid, stored: sealedP2UnderP1Cid })
      expect(read.access).to.equal('tampered')
      expect(read.payload).to.equal(undefined)
    })
  })

  describe('C4 — binding transplant', () => {
    it('an envelope sealed for request X opened as request Y gives unreadable, never opened', async () => {
      const fx = await freshAuthority()
      await provisionTestIntakeRecipient(fx.ctx, fx.authority.id)
      const initX = makeRegisterInit(fx, { requestId: 'c4-req-x' })
      const plaintext = JSON.stringify(initX)
      const payloadCidRow = await fx.ctx.db.prepare('select Digest(:payload) as d').get({ payload: plaintext })
      const payloadCid = payloadCidRow!.d as string
      const sealed = await sealRegistrationPayload(fx.ctx.db, { authorityId: fx.authority.id, requestId: 'c4-req-x', payloadCid, plaintext })

      const read = await openRegistrationPayload(fx.ctx.db, fx.ctx.intakeOpener, { requestId: 'c4-req-y', payloadCid, stored: sealed })
      expect(read.access).to.equal('unreadable')
      expect(read.payload).to.equal(undefined)
    })
  })

  describe('C5 — unsealed legacy rows', () => {
    it('matching Digest gives unsealed + parsed payload; mismatched Digest gives tampered; non-JSON gives unreadable; non-string gives unreadable', async () => {
      const fx = await freshAuthority()
      const init = makeRegisterInit(fx, { requestId: 'c5-req' })
      const plaintext = JSON.stringify(init)
      const payloadCidRow = await fx.ctx.db.prepare('select Digest(:payload) as d').get({ payload: plaintext })
      const payloadCid = payloadCidRow!.d as string

      const matching = await openRegistrationPayload(fx.ctx.db, undefined, { requestId: 'c5-req', payloadCid, stored: plaintext })
      expect(matching.access).to.equal('unsealed')
      expect(matching.payload).to.deep.equal(init)

      const otherCidRow = await fx.ctx.db.prepare('select Digest(:payload) as d').get({ payload: 'something-else' })
      const mismatched = await openRegistrationPayload(fx.ctx.db, undefined, { requestId: 'c5-req', payloadCid: otherCidRow!.d as string, stored: plaintext })
      expect(mismatched.access).to.equal('tampered')

      const nonJsonText = 'not-json-at-all'
      const nonJsonCidRow = await fx.ctx.db.prepare('select Digest(:payload) as d').get({ payload: nonJsonText })
      const nonJson = await openRegistrationPayload(fx.ctx.db, undefined, { requestId: 'c5-req', payloadCid: nonJsonCidRow!.d as string, stored: nonJsonText })
      expect(nonJson.access).to.equal('unreadable')

      const nonString = await openRegistrationPayload(fx.ctx.db, undefined, { requestId: 'c5-req', payloadCid, stored: 12345 })
      expect(nonString.access).to.equal('unreadable')
    })
  })

  describe('C6 — zero recipients', () => {
    it('sealRegistrationPayload rejects IntakeError no-recipients on a fresh, unprovisioned network', async () => {
      const fx = await freshAuthority()
      const requestId = 'c6-req'
      const init = makeRegisterInit(fx, { requestId })
      const plaintext = JSON.stringify(init)
      const payloadCidRow = await fx.ctx.db.prepare('select Digest(:payload) as d').get({ payload: plaintext })
      const payloadCid = payloadCidRow!.d as string

      let caught: unknown
      try {
        await sealRegistrationPayload(fx.ctx.db, { authorityId: fx.authority.id, requestId, payloadCid, plaintext })
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(IntakeError)
      expect((caught as IntakeError).name).to.equal('IntakeError')
      expect((caught as IntakeError).code).to.equal('no-recipients')
    })
  })

  describe('C7 — private details', () => {
    it('empty details -> the constant with zero recipients; non-empty seals/opens for the recipient and refuses outsiders; null gives unsealed/[]; non-array gives unreadable; registrant transplant gives unreadable', async () => {
      const fx = await freshAuthority()
      await provisionTestIntakeRecipient(fx.ctx, fx.authority.id)
      const marker = randomMarker()
      const registrantId = 'c7-registrant'

      const emptyOnUnprovisioned = await sealRegistrantPrivateDetails(
        (await freshAuthority()).ctx.db,
        { authorityId: 'does-not-matter', registrantId, details: [] }
      )
      expect(emptyOnUnprovisioned).to.equal(REGISTRANT_PRIVATE_EMPTY_DETAILS)

      const details = [{ name: 'ssn', value: marker }]
      const sealed = await sealRegistrantPrivateDetails(fx.ctx.db, { authorityId: fx.authority.id, registrantId, details })
      expect(sealed).to.not.include(marker)

      const opened = await openRegistrantPrivateDetails(fx.ctx.db, fx.ctx.intakeOpener, { registrantId, stored: sealed })
      expect(opened.access).to.equal('opened')
      expect(opened.details).to.deep.equal(details)

      const noOpener = await openRegistrantPrivateDetails(fx.ctx.db, undefined, { registrantId, stored: sealed })
      expect(noOpener.access).to.equal('no-opener')

      const { opener: outsiderOpener } = await makeTestOutsiderOpener()
      const notRecipient = await openRegistrantPrivateDetails(fx.ctx.db, outsiderOpener, { registrantId, stored: sealed })
      expect(notRecipient.access).to.equal('not-a-recipient')

      const nullRead = await openRegistrantPrivateDetails(fx.ctx.db, fx.ctx.intakeOpener, { registrantId, stored: null })
      expect(nullRead.access).to.equal('unsealed')
      expect(nullRead.details).to.deep.equal([])

      const nonArrayJson = '{"not":"an array"}'
      const nonArrayRead = await openRegistrantPrivateDetails(fx.ctx.db, undefined, { registrantId, stored: nonArrayJson })
      expect(nonArrayRead.access).to.equal('unreadable')

      const sealedForOtherRegistrant = await sealRegistrantPrivateDetails(fx.ctx.db, { authorityId: fx.authority.id, registrantId: 'c7-other-registrant', details })
      const transplant = await openRegistrantPrivateDetails(fx.ctx.db, fx.ctx.intakeOpener, { registrantId, stored: sealedForOtherRegistrant })
      expect(transplant.access).to.equal('unreadable')
    })
  })

  describe('C9 — purity', () => {
    it('no console., no Buffer, and no crypto specifier in the source (comments stripped)', () => {
      const testDir = dirname(fileURLToPath(import.meta.url))
      const filePath = join(testDir, '../src/registration/sealed-registration-content.ts')
      const raw = readFileSync(filePath, 'utf8')
      const stripped = raw
        .split('\n')
        .filter((line) => !/^\s*\/\//.test(line) && !/^\s*\*/.test(line))
        .join('\n')
      expect(stripped).to.not.match(/console\./)
      expect(stripped).to.not.match(/\bBuffer\b/)
      expect(stripped).to.not.match(/from ['"]crypto['"]/)
    })
  })

  describe('C8 — no leak', () => {
    it('no console call across C1-C7 captured any marker substring', () => {
      for (const call of consoleCalls) {
        expect(call).to.not.match(/MARKER-D49-/)
      }
    })
  })

  describe('registrantPrivateBinding', () => {
    it('is not datetime-bound and names the label constant', async () => {
      const fx = await freshAuthority()
      const binding = await registrantPrivateBinding(fx.ctx.db, 'some-registrant')
      expect(binding.requestId).to.equal('some-registrant')
      expect(binding.digest).to.be.a('string')
      expect(REGISTRANT_PRIVATE_BINDING_LABEL).to.equal('vt-registrant-private-1')
    })
  })

  describe('isSealedRegistrationContent', () => {
    it('never throws and distinguishes sealed from unsealed text', async () => {
      expect(isSealedRegistrationContent('plain json text')).to.equal(false)
      expect(isSealedRegistrationContent(null)).to.equal(false)
      expect(isSealedRegistrationContent(42)).to.equal(false)
      expect(isSealedRegistrationContent('{"v":1}')).to.equal(false)

      const fx = await freshAuthority()
      await provisionTestIntakeRecipient(fx.ctx, fx.authority.id)
      const sealed = await sealRegistrantPrivateDetails(fx.ctx.db, { authorityId: fx.authority.id, registrantId: 'sealed-probe', details: [{ name: 'x', value: 'y' }] })
      expect(isSealedRegistrationContent(sealed)).to.equal(true)
    })
  })
})
