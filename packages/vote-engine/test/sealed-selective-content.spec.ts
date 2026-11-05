/**
 * sealed-selective-content.spec.ts — Phase 62 Plan 36 (D-52, T-62-31-13), Task 1.
 *
 * SC1-SC8: proves the selective seal/open pair in `src/registration/sealed-registration-content.ts`
 * in isolation against the real Quereus schema, before the engine flips. The Cid is over the
 * PLAINTEXT leaves (`cid(set_commit(leaves))`); the open function re-checks it (tier-2 recheck).
 */

import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SelectiveLeaf } from '@votetorrent/vote-core'
import {
  REGISTRANT_SELECTIVE_BINDING_LABEL,
  isSealedRegistrationContent,
  openRegistrantSelectiveDetails,
  registrantSelectiveBinding,
  sealRegistrantSelectiveDetails
} from '../src/registration/sealed-registration-content.js'
import { envelopeRecipientUserIds } from '../src/crypto/index.js'
import { IntakeError } from '../src/intake/types.js'
import { addTestAuthority, createTestNetwork, makeTestOutsiderOpener, provisionTestIntakeRecipient } from './fixtures/test-context.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'
import type { Database } from '@quereus/quereus'

function randomMarker (): string {
  return `MARKER-D52-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
}

async function makeLeaves (db: Database, values: Array<[string, string | number]>): Promise<SelectiveLeaf[]> {
  const out: SelectiveLeaf[] = []
  for (const [name, value] of values) {
    const row = await db.prepare('select random_bytes(128) as s').get({})
    out.push({ name, value, salt: String(row!.s) } as SelectiveLeaf)
  }
  return out
}

async function cidOf (db: Database, leaves: unknown): Promise<string> {
  const row = await db.prepare('select cid(set_commit(:plaintextLeaves)) as c').get({ plaintextLeaves: JSON.stringify(leaves) })
  return row!.c as string
}

describe('selective seal/open (D-52, T-62-31-13)', () => {
  const consoleCalls: string[] = []
  const originalConsole = { log: console.log, warn: console.warn, error: console.error }
  const seenErrors: string[] = []
  const markers: string[] = []

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

  async function fresh (): Promise<TestAuthorityContext> {
    return addTestAuthority(await createTestNetwork())
  }

  describe('SC1 — seal then open (recipient)', () => {
    it('no marker/salt in sealed text; recipients equal founder; open gives opened + deep-equal leaves', async () => {
      const fx = await fresh()
      await provisionTestIntakeRecipient(fx.ctx, fx.authority.id)
      const marker = randomMarker()
      markers.push(marker)
      const leaves = await makeLeaves(fx.ctx.db, [['income', marker], ['dob', '1990-01-01']])
      markers.push(String(leaves[0].salt))
      const cid = await cidOf(fx.ctx.db, leaves)
      const registrantId = 'sc1-registrant'

      const sealed = await sealRegistrantSelectiveDetails(fx.ctx.db, { authorityId: fx.authority.id, registrantId, cid, leaves })
      expect(sealed).to.not.include(marker)
      expect(sealed).to.not.include(String(leaves[0].salt))
      expect(isSealedRegistrationContent(sealed)).to.equal(true)
      expect(envelopeRecipientUserIds(sealed)).to.have.members([fx.user.id])

      const read = await openRegistrantSelectiveDetails(fx.ctx.db, fx.ctx.intakeOpener, { registrantId, cid, stored: sealed })
      expect(read.access).to.equal('opened')
      expect(read.leaves).to.deep.equal(leaves)
    })
  })

  describe('SC2 — no opener / non-recipient', () => {
    it('undefined opener gives no-opener; outsider gives not-a-recipient; leaves undefined', async () => {
      const fx = await fresh()
      await provisionTestIntakeRecipient(fx.ctx, fx.authority.id)
      const leaves = await makeLeaves(fx.ctx.db, [['a', 'b']])
      const cid = await cidOf(fx.ctx.db, leaves)
      const sealed = await sealRegistrantSelectiveDetails(fx.ctx.db, { authorityId: fx.authority.id, registrantId: 'sc2', cid, leaves })

      const noOpener = await openRegistrantSelectiveDetails(fx.ctx.db, undefined, { registrantId: 'sc2', cid, stored: sealed })
      expect(noOpener.access).to.equal('no-opener')
      expect(noOpener.leaves).to.equal(undefined)

      const { opener } = await makeTestOutsiderOpener()
      const notRecipient = await openRegistrantSelectiveDetails(fx.ctx.db, opener, { registrantId: 'sc2', cid, stored: sealed })
      expect(notRecipient.access).to.equal('not-a-recipient')
      expect(notRecipient.leaves).to.equal(undefined)
    })
  })

  describe('SC3 — tier-2 recheck on a sealed row', () => {
    it('leaves L2 sealed under a binding for Cid(L1) open as tampered', async () => {
      const fx = await fresh()
      await provisionTestIntakeRecipient(fx.ctx, fx.authority.id)
      const l1 = await makeLeaves(fx.ctx.db, [['a', 'one']])
      const l2 = await makeLeaves(fx.ctx.db, [['a', 'two']])
      const cid1 = await cidOf(fx.ctx.db, l1)
      const sealed = await sealRegistrantSelectiveDetails(fx.ctx.db, { authorityId: fx.authority.id, registrantId: 'sc3', cid: cid1, leaves: l2 })
      const read = await openRegistrantSelectiveDetails(fx.ctx.db, fx.ctx.intakeOpener, { registrantId: 'sc3', cid: cid1, stored: sealed })
      expect(read.access).to.equal('tampered')
      expect(read.leaves).to.equal(undefined)
    })
  })

  describe('SC4 — binding transplant', () => {
    it('another registrant or another Cid gives unreadable', async () => {
      const fx = await fresh()
      await provisionTestIntakeRecipient(fx.ctx, fx.authority.id)
      const leaves = await makeLeaves(fx.ctx.db, [['a', 'one']])
      const other = await makeLeaves(fx.ctx.db, [['a', 'two']])
      const cid = await cidOf(fx.ctx.db, leaves)
      const cidY = await cidOf(fx.ctx.db, other)
      const sealed = await sealRegistrantSelectiveDetails(fx.ctx.db, { authorityId: fx.authority.id, registrantId: 'sc4-a', cid, leaves })

      const asB = await openRegistrantSelectiveDetails(fx.ctx.db, fx.ctx.intakeOpener, { registrantId: 'sc4-b', cid, stored: sealed })
      expect(asB.access).to.equal('unreadable')
      expect(asB.leaves).to.equal(undefined)
      const asY = await openRegistrantSelectiveDetails(fx.ctx.db, fx.ctx.intakeOpener, { registrantId: 'sc4-a', cid: cidY, stored: sealed })
      expect(asY.access).to.equal('unreadable')
      expect(asY.leaves).to.equal(undefined)
    })
  })

  describe('SC5 — unsealed legacy rows', () => {
    it('matching Cid unsealed; mismatch tampered; non-JSON / non-array / null / non-string unreadable', async () => {
      const fx = await fresh()
      const leaves = await makeLeaves(fx.ctx.db, [['a', 'one'], ['b', 2]])
      const cid = await cidOf(fx.ctx.db, leaves)
      const text = JSON.stringify(leaves)

      const ok = await openRegistrantSelectiveDetails(fx.ctx.db, undefined, { registrantId: 'sc5', cid, stored: text })
      expect(ok.access).to.equal('unsealed')
      expect(ok.leaves).to.deep.equal(leaves)

      const wrongCid = await cidOf(fx.ctx.db, await makeLeaves(fx.ctx.db, [['z', 'z']]))
      const bad = await openRegistrantSelectiveDetails(fx.ctx.db, undefined, { registrantId: 'sc5', cid: wrongCid, stored: text })
      expect(bad.access).to.equal('tampered')
      expect(bad.leaves).to.equal(undefined)

      const nonJson = await openRegistrantSelectiveDetails(fx.ctx.db, undefined, { registrantId: 'sc5', cid, stored: 'not-json' })
      expect(nonJson.access).to.equal('unreadable')
      const nonArray = await openRegistrantSelectiveDetails(fx.ctx.db, undefined, { registrantId: 'sc5', cid, stored: '{"a":1}' })
      expect(nonArray.access).to.equal('unreadable')
      const nul = await openRegistrantSelectiveDetails(fx.ctx.db, undefined, { registrantId: 'sc5', cid, stored: null })
      expect(nul.access).to.equal('unreadable')
      const num = await openRegistrantSelectiveDetails(fx.ctx.db, undefined, { registrantId: 'sc5', cid, stored: 12345 })
      expect(num.access).to.equal('unreadable')
    })
  })

  describe('SC6 — zero recipients', () => {
    it('rejects IntakeError no-recipients on an unprovisioned network', async () => {
      const fx = await fresh()
      const leaves = await makeLeaves(fx.ctx.db, [['a', 'one']])
      const cid = await cidOf(fx.ctx.db, leaves)
      let caught: unknown
      try {
        await sealRegistrantSelectiveDetails(fx.ctx.db, { authorityId: fx.authority.id, registrantId: 'sc6', cid, leaves })
      } catch (err) {
        caught = err
        seenErrors.push(String((err as Error).message))
      }
      expect(caught).to.be.instanceOf(IntakeError)
      expect((caught as IntakeError).name).to.equal('IntakeError')
      expect((caught as IntakeError).code).to.equal('no-recipients')
    })
  })

  describe('SC8b — empty set (WR-02)', () => {
    it('unsealed [] under its own Cid opens unsealed; under a foreign Cid tampered; sealed empty stays unreadable', async () => {
      const fx = await fresh()
      const probe = await fx.ctx.db.prepare('select cid(set_commit(:p)) as c').get({ p: '[]' })
      expect(probe!.c).to.not.equal(null)
      const emptyCid = probe!.c as string

      const ok = await openRegistrantSelectiveDetails(fx.ctx.db, undefined, { registrantId: 'sc8e', cid: emptyCid, stored: '[]' })
      expect(ok.access).to.equal('unsealed')
      expect(ok.leaves).to.deep.equal([])

      const foreign = await cidOf(fx.ctx.db, await makeLeaves(fx.ctx.db, [['z', 'z']]))
      const bad = await openRegistrantSelectiveDetails(fx.ctx.db, undefined, { registrantId: 'sc8e', cid: foreign, stored: '[]' })
      expect(bad.access).to.equal('tampered')
      expect(bad.leaves).to.equal(undefined)

      await provisionTestIntakeRecipient(fx.ctx, fx.authority.id)
      const envelope = await sealRegistrantSelectiveDetails(fx.ctx.db, { authorityId: fx.authority.id, registrantId: 'sc8e', cid: emptyCid, leaves: [] })
      const sealedEmpty = await openRegistrantSelectiveDetails(fx.ctx.db, fx.ctx.intakeOpener, { registrantId: 'sc8e', cid: emptyCid, stored: envelope })
      expect(sealedEmpty.access).to.equal('unreadable')
      expect(sealedEmpty.leaves).to.equal(undefined)
    })
  })

  describe('SC7 — no leak', () => {
    it('no console call or error message captured a marker or salt', () => {
      expect(markers.length).to.be.greaterThan(0)
      for (const call of [...consoleCalls, ...seenErrors]) {
        for (const m of markers) expect(call).to.not.include(m)
      }
    })
  })

  describe('SC8 — purity', () => {
    it('no console., no Buffer, no crypto specifier in the source (comments stripped)', () => {
      const testDir = dirname(fileURLToPath(import.meta.url))
      const raw = readFileSync(join(testDir, '../src/registration/sealed-registration-content.ts'), 'utf8')
      const stripped = raw.split('\n').filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l)).join('\n')
      expect(stripped).to.not.match(/console\./)
      expect(stripped).to.not.match(/\bBuffer\b/)
      expect(stripped).to.not.match(/from ['"]crypto['"]/)
    })
  })

  describe('registrantSelectiveBinding', () => {
    it('names the label and depends on the Cid', async () => {
      const fx = await fresh()
      const a = await registrantSelectiveBinding(fx.ctx.db, 'r', 'cid-1')
      const b = await registrantSelectiveBinding(fx.ctx.db, 'r', 'cid-2')
      expect(a.requestId).to.equal('r')
      expect(a.digest).to.not.equal(b.digest)
      expect(REGISTRANT_SELECTIVE_BINDING_LABEL).to.equal('vt-registrant-selective-1')
    })
  })
})
