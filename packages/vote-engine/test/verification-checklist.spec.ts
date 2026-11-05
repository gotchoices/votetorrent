import {
  VERIFICATION_CHECKLIST_ITEM_ORDER,
  VERIFICATION_CHECKLIST_SUBSTANTIVE_ITEMS,
  canonicalizeVerificationChecklist,
  serializeVerificationChecklist,
  parseVerificationChecklist,
  verificationCid,
  isChecklistGateMet,
  type RegistrationVerificationChecklistItem
} from '@votetorrent/vote-core'
import { expect } from 'chai'

// Pure-function spec — no database, no engine, no test network. The
// schema-level proof that VerificationCid rides inside AdminSigning.Digest
// belongs to registration-request.spec.ts and the ceremony plans (48-11/12).

describe('verification-checklist', () => {
  // --- Vocabulary (2) ---

  it('VERIFICATION_CHECKLIST_ITEM_ORDER deep-equals [id, roll, eligibility, none] in that order', () => {
    expect(VERIFICATION_CHECKLIST_ITEM_ORDER).to.deep.equal(['id', 'roll', 'eligibility', 'none'])
  })

  it('VERIFICATION_CHECKLIST_SUBSTANTIVE_ITEMS deep-equals [id, roll, eligibility] and excludes none', () => {
    expect(VERIFICATION_CHECKLIST_SUBSTANTIVE_ITEMS).to.deep.equal(['id', 'roll', 'eligibility'])
    expect(VERIFICATION_CHECKLIST_SUBSTANTIVE_ITEMS).to.not.include('none')
  })

  // --- Canonicalization (3) ---

  it('canonicalizeVerificationChecklist(["none","roll","id"]) returns ["id","roll","none"] — input order does not survive', () => {
    expect(canonicalizeVerificationChecklist(['none', 'roll', 'id'])).to.deep.equal(['id', 'roll', 'none'])
  })

  it('canonicalizeVerificationChecklist(["id","id","roll"]) returns ["id","roll"] — duplicates collapse', () => {
    expect(canonicalizeVerificationChecklist(['id', 'id', 'roll'])).to.deep.equal(['id', 'roll'])
  })

  it('canonicalizeVerificationChecklist(["id","fingerprint"]) throws verificationChecklist: naming fingerprint', () => {
    expect(() => canonicalizeVerificationChecklist(['id', 'fingerprint'])).to.throw(/verificationChecklist:/)
    expect(() => canonicalizeVerificationChecklist(['id', 'fingerprint'])).to.throw(/fingerprint/)
  })

  // --- Serialization and round-trip (4) ---

  it('serializeVerificationChecklist(["roll","id"]) equals serializeVerificationChecklist(["id","roll"]) — order-independence', () => {
    expect(serializeVerificationChecklist(['roll', 'id'])).to.equal(serializeVerificationChecklist(['id', 'roll']))
  })

  it('serializeVerificationChecklist byte layout is pinned to the exact literal strings', () => {
    expect(serializeVerificationChecklist(['id', 'roll'])).to.equal('{"v":1,"checked":["id","roll"]}')
    expect(serializeVerificationChecklist([])).to.equal('{"v":1,"checked":[]}')
  })

  it('parseVerificationChecklist(serializeVerificationChecklist(...)) round-trips to the canonical array', () => {
    expect(parseVerificationChecklist(serializeVerificationChecklist(['none']))).to.deep.equal(['none'])
    expect(parseVerificationChecklist(serializeVerificationChecklist(['eligibility', 'id', 'roll'])))
      .to.deep.equal(['id', 'roll', 'eligibility'])
  })

  it('parseVerificationChecklist throws verificationChecklist: on malformed JSON, wrong version, missing/non-array checked, and unknown ids', () => {
    expect(() => parseVerificationChecklist('not json')).to.throw(/verificationChecklist:/)
    expect(() => parseVerificationChecklist('{"v":2,"checked":[]}')).to.throw(/verificationChecklist:/)
    expect(() => parseVerificationChecklist('{"v":1}')).to.throw(/verificationChecklist:/)
    expect(() => parseVerificationChecklist('{"v":1,"checked":"id"}')).to.throw(/verificationChecklist:/)
    expect(() => parseVerificationChecklist('{"v":1,"checked":["id","fingerprint"]}')).to.throw(/verificationChecklist:/)
  })

  // --- Digest binding (3) ---
  // A local recording double stands in for the injected digest — no real
  // hashing here; the point is what gets hashed, not how.

  it('verificationCid passes the recorder exactly one argument, the canonical serialized string', async () => {
    const calls: string[] = []
    const recorder = async (canonical: string): Promise<string> => {
      calls.push(canonical)
      return canonical.split('').reverse().join('')
    }
    await verificationCid(['id', 'roll'], recorder)
    expect(calls).to.have.lengthOf(1)
    expect(calls[0]).to.equal(serializeVerificationChecklist(['id', 'roll']))
  })

  it('verificationCid produces the same cid regardless of checked-set ordering', async () => {
    const double = async (canonical: string): Promise<string> => canonical.split('').reverse().join('')
    const a = await verificationCid(['roll', 'id'], double)
    const b = await verificationCid(['id', 'roll'], double)
    expect(a).to.equal(b)
  })

  it('verificationCid changes when a single checklist item is flipped — the D-07 tamper-evidence assertion: a post-hoc edit to the checklist changes these bytes, changes the VerificationCid, and therefore breaks verification of the officer\'s own signature over AdminSigning.Digest', async () => {
    const double = async (canonical: string): Promise<string> => canonical.split('').reverse().join('')
    const a = await verificationCid(['id', 'roll'], double)
    const b = await verificationCid(['id', 'eligibility'], double)
    expect(a).to.not.equal(b)
  })

  // --- Accept gate (5) ---

  it('isChecklistGateMet([]) is false — zero checked is the only blocking state', () => {
    expect(isChecklistGateMet([])).to.equal(false)
  })

  it('isChecklistGateMet(["id"]) is true — "Partial completion is always allowed and never blocks" (48-UI-SPEC.md)', () => {
    expect(isChecklistGateMet(['id'])).to.equal(true)
  })

  it('isChecklistGateMet(["none"]) is true — an honest "none performed" record is a complete state', () => {
    expect(isChecklistGateMet(['none'])).to.equal(true)
  })

  it('isChecklistGateMet is false when none is checked together with any substantive item — mutual exclusion', () => {
    expect(isChecklistGateMet(['none', 'id'])).to.equal(false)
    expect(isChecklistGateMet(['none', 'roll', 'eligibility'])).to.equal(false)
  })

  it('isChecklistGateMet ignores an unrecognised id and fails closed rather than throwing', () => {
    expect(isChecklistGateMet(['fingerprint'] as unknown as RegistrationVerificationChecklistItem[])).to.equal(false)
  })
})
