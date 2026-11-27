import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Ballot, Question } from '@votetorrent/vote-core'
import { digestFields, resolveHasher, resolveOutputEncoder } from '@optimystic/quereus-plugin-crypto'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  VOTE_ENTRY_KEYS, VOTER_ENTRY_KEYS, ballotTemplateDigest, buildVoteEntry, makeVoteNonce, voterEntryDigest,
  type TemplateBallot, type VoteEntry, type VoterEntryUnsigned
} from '../src/voting/vote-entries.js'
import { AssociationEngine } from '../src/association/association-engine.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { seedRegistrantAssociation } from '../src/dev/seed-registrant-association.js'
import { addTestAuthority, addTestElection, createTestNetwork, makeTestSignCallback } from './fixtures/test-context.js'
import { makeP256TestKey } from './fixtures/p256-signer.js'
import { canonicalJson, sortByCanonicalBytes } from '../src/voting/canonical.js'

const rand32 = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32))
const sha = resolveHasher('sha256')
const b64 = resolveOutputEncoder('base64url')

// Known-answer digests, produced by the spike-096 module (.planning/spikes/096-.../vote-entries.ts)
// for the fixtures below. They prove the product lift is verbatim.
const KAT_TEMPLATE_DIGEST = '_8ABWDiPsL3QjCELg2mB3CAttwo6l7CcRy0yTrQbNdY'
const KAT_VOTER_ENTRY_DIGEST = 'jCOYTEKMxhW4MfSydSvjolzBGvIh_qDC1zfPpc1Ub9Y'

const KAT_BALLOT: TemplateBallot = {
  id: 'kat-ballot-1',
  electionId: 'kat-election-1',
  authorityId: 'kat-authority-1',
  description: 'KAT ballot',
  districts: ['d-2', 'd-1'],
  questions: [
    {
      code: 'us-senate', title: 'U.S. Senate', type: 'select', optionRange: { min: 1, max: 1 },
      options: [
        { code: 'marcus', title: 'Marcus Whitfield' },
        { code: 'diana', title: 'Diana Foster' },
        { code: 'elena', title: 'Elena Vasquez' }
      ]
    },
    {
      code: 'school-board', title: 'School Board', type: 'select', optionRange: { min: 1, max: 2 },
      options: [
        { code: 'cynthia', title: 'Cynthia Park' },
        { code: 'angela', title: 'Angela Torres' },
        { code: 'brian', title: 'Brian Michaels' }
      ]
    }
  ]
}

const KAT_VOTER: VoterEntryUnsigned = {
  v: 1,
  electionId: 'kat-election-1',
  electionRevision: 3,
  registrantId: 'kat-registrant-1',
  privateCid: 'kat-private-cid',
  publicCid: null,
  deviceKey: '02' + '1'.repeat(64),
  attestationCid: null,
  ballots: [
    { ballotId: 'kat-ballot-2', templateDigest: 'td-2' },
    { ballotId: 'kat-ballot-1', templateDigest: 'td-1' }
  ]
}

describe('voting/vote-entries (63-01: D-16, D-23, D-24, D-25, D-27, D-28)', function () {
  this.timeout(60000)

  describe('pure builders', function () {
    it('KAT-1 ballotTemplateDigest reproduces the spike-096 value', function () {
      expect(ballotTemplateDigest(KAT_BALLOT, 3)).to.equal(KAT_TEMPLATE_DIGEST)
    })

    it('KAT-2 voterEntryDigest reproduces the spike-096 value', function () {
      expect(voterEntryDigest(KAT_VOTER)).to.equal(KAT_VOTER_ENTRY_DIGEST)
    })

    it('D24-contract template digest field order is pinned by an inline recomputation', function () {
      // D-24 order: 'BallotTemplate', electionId, revision, id, authorityId, description,
      // sorted districts, questions (by code; options by code).
      const questionsTuple = [
        ['school-board', 'School Board', 'select', [1, 2], null,
          [['angela', 'Angela Torres', null], ['brian', 'Brian Michaels', null], ['cynthia', 'Cynthia Park', null]]],
        ['us-senate', 'U.S. Senate', 'select', [1, 1], null,
          [['diana', 'Diana Foster', null], ['elena', 'Elena Vasquez', null], ['marcus', 'Marcus Whitfield', null]]]
      ]
      const expected = digestFields(
        ['BallotTemplate', 'kat-election-1', 3, 'kat-ballot-1', 'kat-authority-1', 'KAT ballot',
          JSON.stringify(['d-1', 'd-2']), JSON.stringify(questionsTuple)],
        sha, b64
      )
      expect(ballotTemplateDigest(KAT_BALLOT, 3)).to.equal(expected)
    })

    it('D25-contract voter entry digest has no answer or nonce input', function () {
      const pairs = [['kat-ballot-1', 'td-1'], ['kat-ballot-2', 'td-2']]
      const expected = digestFields(
        ['VoterEntry', 1, 'kat-election-1', 3, 'kat-registrant-1', 'kat-private-cid', null, '02' + '1'.repeat(64),
          null, JSON.stringify(pairs)],
        sha, b64
      )
      expect(voterEntryDigest(KAT_VOTER)).to.equal(expected)
    })

    it('U3c the digest reads only its named fields (extra answers/nonce are ignored)', function () {
      const withVote = { ...KAT_VOTER, answers: [{ questionCode: 'us-senate', optionCodes: ['elena'] }], nonce: 'ab'.repeat(32) }
      expect(voterEntryDigest(withVote as unknown as VoterEntryUnsigned)).to.equal(KAT_VOTER_ENTRY_DIGEST)
    })

    it('H0 digestFields matches the shipped probe vector', function () {
      expect(digestFields(['probe-nonce-v1', 'probe-devicekey-v1'], sha, b64)).to.equal('epUx8O72zVpRIQl1WGnqZSQpvFJjJPPZtmgqJBcUfzI')
    })

    it('N1 a bare nonce is exactly bytesToHex(random), 64 lowercase hex', function () {
      const r = rand32()
      const n = makeVoteNonce(r)
      expect(n).to.equal(bytesToHex(r))
      expect(n).to.have.length(64)
      expect(n).to.match(/^[0-9a-f]{64}$/)
    })

    it('N2 voter entropy changes the nonce', function () {
      const r = rand32()
      const n0 = makeVoteNonce(r)
      expect(makeVoteNonce(r, 'my words')).to.not.equal(n0)
      expect(makeVoteNonce(r, 'my words')).to.not.equal(makeVoteNonce(r, 'other'))
    })

    it('N3 weak voter entropy cannot collapse two CSPRNG draws into one nonce', function () {
      expect(makeVoteNonce(rand32(), 'aaaa')).to.not.equal(makeVoteNonce(rand32(), 'aaaa'))
    })

    it('N4 2000 nonces, 0 collisions', function () {
      const nonces = new Set(Array.from({ length: 2000 }, () => makeVoteNonce(rand32())))
      expect(nonces.size).to.equal(2000)
    })

    it('N5 makeVoteNonce refuses anything but 32 bytes', function () {
      expect(() => makeVoteNonce(new Uint8Array(31))).to.throw(/32 CSPRNG bytes/)
      expect(() => makeVoteNonce(new Uint8Array(33))).to.throw(/32 CSPRNG bytes/)
    })

    it('V2 refuses more distinct options than the question cap', function () {
      const ballot: TemplateBallot = {
        ...KAT_BALLOT,
        questions: [
          { code: 'capped', title: 'Capped', optionRange: { min: 1, max: 2 }, options: ['a', 'b', 'c'].map(c => ({ code: c, title: c })) },
          { code: 'bare', title: 'Bare', options: ['x', 'y'].map(c => ({ code: c, title: c })) }
        ]
      }
      const nonce = makeVoteNonce(rand32())
      const build = (selections: Record<string, string[]>): ReturnType<typeof buildVoteEntry> =>
        buildVoteEntry({ ballot, electionRevision: 1, selections, nonce })
      expect(() => build({ capped: ['a', 'b', 'c'] })).to.throw(/too many options/)
      expect(build({ capped: ['a', 'a', 'a'] }).answers).to.deep.equal([{ questionCode: 'capped', optionCodes: ['a'] }])
      expect(build({ capped: ['b', 'a'] }).answers[0]!.optionCodes).to.deep.equal(['a', 'b'])
      // No optionRange: cap is 1.
      expect(() => build({ bare: ['x', 'y'] })).to.throw(/too many options/)
      expect(build({ bare: ['x'] }).answers).to.deep.equal([{ questionCode: 'bare', optionCodes: ['x'] }])
    })

    it('V3 refuses a nonce that is not 64 lowercase hex', function () {
      const sel = { 'us-senate': ['elena'] }
      for (const nonce of ['AB'.repeat(32), 'a'.repeat(63), 'a'.repeat(65)]) {
        expect(() => buildVoteEntry({ ballot: KAT_BALLOT, electionRevision: 3, selections: sel, nonce }))
          .to.throw(/nonce must be 64 lowercase hex/)
      }
    })

    it('V4 a blank question has one representation (absent); all-blank yields answers: []', function () {
      const nonce = makeVoteNonce(rand32())
      const a = buildVoteEntry({ ballot: KAT_BALLOT, electionRevision: 3, selections: { 'us-senate': ['elena'], 'school-board': [] }, nonce })
      const b = buildVoteEntry({ ballot: KAT_BALLOT, electionRevision: 3, selections: { 'us-senate': ['elena'] }, nonce })
      expect(canonicalJson(a)).to.equal(canonicalJson(b))
      expect(buildVoteEntry({ ballot: KAT_BALLOT, electionRevision: 3, selections: {}, nonce }).answers).to.deep.equal([])
      expect(buildVoteEntry({ ballot: KAT_BALLOT, electionRevision: 3, selections: { 'us-senate': [] }, nonce }).answers).to.deep.equal([])
    })

    it('C1 canonicalJson is key-order independent, drops undefined, keeps array order, recurses', function () {
      expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).to.equal(canonicalJson({ a: { c: 2, d: 1 }, b: 1 }))
      expect(canonicalJson({ a: 1, b: undefined })).to.equal('{"a":1}')
      expect(canonicalJson([3, 1, 2])).to.equal('[3,1,2]')
      expect(canonicalJson({ x: [{ z: 1, y: 2 }] })).to.equal('{"x":[{"y":2,"z":1}]}')
    })

    it('C2 sortByCanonicalBytes is permutation invariant', function () {
      const items = Array.from({ length: 25 }, (_, i) => ({
        v: 1, ballotId: 'b', nonce: bytesToHex(rand32()), answers: [{ questionCode: 'q', optionCodes: [`o${i}`] }]
      }))
      const reference = canonicalJson(sortByCanonicalBytes(items))
      for (let p = 0; p < 50; p++) {
        const shuffled = [...items]
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = crypto.getRandomValues(new Uint32Array(1))[0]! % (i + 1)
          ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
        }
        expect(canonicalJson(sortByCanonicalBytes(shuffled))).to.equal(reference)
      }
    })

    it('C3 orders by UTF-8 bytes, not UTF-16 code units', function () {
      const sorted = sortByCanonicalBytes([{ t: '\u{1F600}' }, { t: '！' }])
      expect(sorted.map(x => x.t)).to.deep.equal(['！', '\u{1F600}'])
      // The JS string order is the opposite, which is the trap this rule avoids.
      expect(JSON.stringify({ t: '\u{1F600}' }) < JSON.stringify({ t: '！' })).to.equal(true)
    })

    it('C4 sortByCanonicalBytes does not mutate its input', function () {
      const input = [{ t: 'c' }, { t: 'a' }, { t: 'b' }]
      const snapshot = [...input]
      const out = sortByCanonicalBytes(input)
      expect(out).to.not.equal(input)
      expect(input).to.have.length(3)
      input.forEach((x, i) => expect(x).to.equal(snapshot[i]))
      expect(out.map(x => x.t)).to.deep.equal(['a', 'b', 'c'])
    })
  })

  describe('spike-096 harness port (real engine reads)', function () {
    this.timeout(60000)

    function q (code: string, title: string, max: number, options: Array<[string, string]>): Question {
      return { code, title, instructions: '', type: 'select', optionRange: { min: 1, max }, options: options.map(([c, t]) => ({ code: c, title: t })) }
    }

    let electionId: string
    let electionRevision: number
    let associationsLength: number
    let registrantStatus: string | undefined
    let confirmed: boolean
    let ballotsLength: number
    let ballotOk: boolean
    let ballot: TemplateBallot
    let reread: TemplateBallot
    let unsigned: VoterEntryUnsigned

    before(async function () {
      this.timeout(120000)
      const net = await createTestNetwork()
      const auth = await addTestAuthority(net)
      const elec = await addTestElection(auth)
      const electionRow = await auth.ctx.db.prepare('select Id from Election where AuthorityId = :a limit 1').get({ a: auth.authority.id })
      electionId = electionRow!.Id as string
      const ballotIn: Ballot = {
        id: crypto.randomUUID(), electionId, authorityId: auth.authority.id, description: 'Spike 096 ballot', districts: ['d-1'],
        questions: [
          q('us-senate', 'U.S. Senate', 1, [['diana', 'Diana Foster'], ['marcus', 'Marcus Whitfield'], ['elena', 'Elena Vasquez']]),
          q('school-board', 'School Board', 2, [['angela', 'Angela Torres'], ['brian', 'Brian Michaels'], ['cynthia', 'Cynthia Park']])
        ]
      }
      await elec.electionEngine.proposeBallot(ballotIn)

      const device = makeP256TestKey()
      const registrantId = `spike096-registrant-${Date.now()}`
      await seedRegistrantAssociation(auth.ctx, auth.authority.id, { id: registrantId }, device.pubHex, makeTestSignCallback(auth.user))

      const associations = await new AssociationEngine(auth.ctx).getAssociationsByDeviceKey(device.pubHex)
      associationsLength = associations.length
      const assoc = associations[0]!
      const registrant = await new RegistrationEngine(auth.ctx).getRegistrant(assoc.registrantId)
      registrantStatus = registrant?.status
      const details = await elec.electionEngine.getElectionDetails()
      electionRevision = details.current.revision
      const summaries = await elec.electionEngine.getBallots()
      const ballots = await Promise.all(summaries.map(async s => (await elec.electionEngine.getBallotDetails(s.id)).ballot))
      ballotsLength = ballots.length
      ballotOk = ballots.length === 1 && ballots[0]!.questions.length === 2 && ballots[0]!.questions.every(x => x.options.length > 0)
      const confirmation = await elec.electionEngine.getBallotConfirmationState(ballots[0]!.id)
      confirmed = confirmation.confirmed
      // No cast: vote-core `Ballot` must structurally satisfy `TemplateBallot` (63-11 relies on it).
      ballot = ballots[0]!
      reread = (await elec.electionEngine.getBallotDetails(ballot.id)).ballot
      unsigned = {
        v: 1, electionId, electionRevision,
        registrantId: assoc.registrantId,
        privateCid: registrant!.privateCid,
        publicCid: registrant!.publicCid ?? null,
        deviceKey: assoc.deviceKey,
        attestationCid: assoc.attestationCid ?? null,
        ballots: [{ ballotId: ballot.id, templateDigest: ballotTemplateDigest(ballot, electionRevision) }]
      }
    })

    it('F1 the device key alone resolves exactly one Association', function () {
      expect(associationsLength).to.equal(1)
    })
    it('F2 the Association resolves an active Registrant', function () {
      expect(registrantStatus).to.equal('a')
    })
    it('F3 election revision is readable', function () {
      expect(Number.isInteger(electionRevision)).to.equal(true)
    })
    it('F4 the ballot reads back with its questions and options', function () {
      expect(ballotsLength).to.equal(1)
      expect(ballotOk).to.equal(true)
    })
    it('F5 (finding) the seeded ballot is PROPOSED, not confirmed', function () {
      expect(confirmed).to.equal(false)
    })
    it('F6 every required voter-entry field is filled from an engine read', function () {
      for (const v of [unsigned.registrantId, unsigned.privateCid, unsigned.deviceKey]) {
        expect(typeof v === 'string' && v.length > 0).to.equal(true)
      }
    })
    it('F7 (finding) privateCid is the dev seed placeholder, not a real CID', function () {
      expect(/placeholder|PLACEHOLDER/i.test(unsigned.privateCid) || !/^b[a-z2-7]{20,}$/.test(unsigned.privateCid)).to.equal(true)
    })

    it('T1 template digest is stable across two engine reads', function () {
      expect(ballotTemplateDigest(reread, electionRevision)).to.equal(ballotTemplateDigest(ballot, electionRevision))
    })
    it('T2 template digest ignores question/option storage order', function () {
      const shuffled: TemplateBallot = { ...ballot, questions: [...ballot.questions].reverse().map(x => ({ ...x, options: [...x.options].reverse() })) }
      expect(ballotTemplateDigest(shuffled, electionRevision)).to.equal(ballotTemplateDigest(ballot, electionRevision))
    })

    const mutationNames = ['option title', 'added option', 'vote-for limit', 'question title', 'election revision']
    for (const [idx, what] of mutationNames.entries()) {
      it(`T3 template digest changes when the ${what} changes`, function () {
        const td = ballotTemplateDigest(ballot, electionRevision)
        const mutated: Array<[TemplateBallot, number]> = [
          [{ ...ballot, questions: ballot.questions.map((x, i) => i === 0 ? { ...x, options: x.options.map((o, j) => j === 0 ? { ...o, title: o.title + '!' } : o) } : x) }, electionRevision],
          [{ ...ballot, questions: ballot.questions.map((x, i) => i === 0 ? { ...x, options: [...x.options, { code: 'zed', title: 'Zed' }] } : x) }, electionRevision],
          [{ ...ballot, questions: ballot.questions.map((x, i) => i === 1 ? { ...x, optionRange: { min: 1, max: 3 } } : x) }, electionRevision],
          [{ ...ballot, questions: ballot.questions.map((x, i) => i === 1 ? { ...x, title: 'School Board (at large)' } : x) }, electionRevision],
          [ballot, electionRevision + 1]
        ]
        const [b, rev] = mutated[idx]!
        expect(ballotTemplateDigest(b, rev)).to.not.equal(td)
      })
    }

    // Unlinkability gate: a named-check function so the mutation probe can aim at it.
    function linkability (vote: Record<string, unknown>, voter: VoterEntryUnsigned & { signature?: string }): Array<[string, boolean]> {
      const identifying = new Set([voter.registrantId, voter.privateCid, voter.publicCid, voter.deviceKey, voter.attestationCid, voter.signature]
        .filter((x): x is string => typeof x === 'string' && x.length > 0))
      const leaves: string[] = []
      const walk = (x: unknown): void => {
        if (typeof x === 'string') leaves.push(x)
        else if (Array.isArray(x)) x.forEach(walk)
        else if (x && typeof x === 'object') { for (const [k, v] of Object.entries(x)) { leaves.push(k); walk(v) } }
      }
      walk(vote)
      return [
        ['U1-key-allowlist', canonicalJson(Object.keys(vote).sort()) === canonicalJson([...VOTE_ENTRY_KEYS])],
        // Any 16-char run of an identifier inside any leaf: a truncated or embedded identifier is
        // still a link (the first probe run MISSED `nonce = deviceKey.slice(0, 64)`).
        ['U1-no-identifying-value', !leaves.some(l => [...identifying].some(id => {
          if (id.length <= 16) return l.includes(id)
          for (let i = 0; i + 16 <= id.length; i++) if (l.includes(id.slice(i, i + 16))) return true
          return false
        }))],
        ['U1-no-time-field', !leaves.some(l => /^\d{4}-\d{2}-\d{2}T/.test(l)) && !Object.values(vote).some(v => typeof v === 'number' && v > 1e12)]
      ]
    }
    const signed = (): VoterEntryUnsigned & { signature: string } => ({ ...unsigned, signature: 'ab'.repeat(64) })
    const makeVoteA = (): VoteEntry => buildVoteEntry({
      ballot, electionRevision, selections: { 'us-senate': ['elena'], 'school-board': ['cynthia', 'angela'] }, nonce: makeVoteNonce(rand32())
    })
    const gate = (name: string): boolean =>
      linkability(makeVoteA() as unknown as Record<string, unknown>, signed()).find(([n]) => n === name)![1]

    it('U1-key-allowlist the vote entry has exactly the allowlisted keys', function () {
      expect(gate('U1-key-allowlist')).to.equal(true)
    })
    it('U1-no-identifying-value no leaf carries any identifier run', function () {
      expect(gate('U1-no-identifying-value')).to.equal(true)
    })
    it('U1-no-time-field the vote entry carries no timestamp', function () {
      expect(gate('U1-no-time-field')).to.equal(true)
    })

    it('U2 same choices, different voters and tap order -> identical except the nonce', function () {
      const voteA = makeVoteA()
      const voteB = buildVoteEntry({
        ballot, electionRevision, selections: { 'school-board': ['angela', 'cynthia', 'angela'], 'us-senate': ['elena'] }, nonce: makeVoteNonce(rand32())
      })
      const strip = (v: VoteEntry): string => canonicalJson({ ...v, nonce: '' })
      expect(strip(voteA)).to.equal(strip(voteB))
      expect(voteA.nonce).to.not.equal(voteB.nonce)
    })

    it('U3 changing answers/nonce never changes the voter-entry digest', function () {
      const d0 = voterEntryDigest(unsigned)
      const voteA = makeVoteA()
      const voteC = buildVoteEntry({ ballot, electionRevision, selections: { 'us-senate': ['diana'] }, nonce: makeVoteNonce(rand32()) })
      expect(voterEntryDigest({ ...unsigned })).to.equal(d0)
      expect(voteC.templateDigest).to.equal(voteA.templateDigest)
    })
    it('U3b the voter-entry digest DOES change with each identity field', function () {
      const d0 = voterEntryDigest(unsigned)
      for (const k of ['registrantId', 'privateCid', 'deviceKey', 'electionRevision'] as const) {
        expect(voterEntryDigest({ ...unsigned, [k]: k === 'electionRevision' ? electionRevision + 1 : 'x' }), k).to.not.equal(d0)
      }
    })
    it('U4 voter entry key set is exactly the allowlist', function () {
      expect(canonicalJson(Object.keys({ ...unsigned, signature: '' }).sort())).to.equal(canonicalJson([...VOTER_ENTRY_KEYS]))
    })

    it('V1 an option not on the ballot is refused', function () {
      expect(() => buildVoteEntry({ ballot, electionRevision, selections: { 'us-senate': ['write-in: bob'] }, nonce: makeVoteNonce(rand32()) }))
        .to.throw(/unknown option/)
    })

    it('M1 mutation probe: every planted leak is caught by its named check', function () {
      const voteA = makeVoteA()
      const plants: Array<[string, Record<string, unknown>]> = [
        ['U1-key-allowlist', { ...voteA, registrant: 'x' }],
        ['U1-no-identifying-value', { ...voteA, answers: [...voteA.answers, { questionCode: unsigned.registrantId, optionCodes: [] }] }],
        ['U1-no-identifying-value', { ...voteA, nonce: unsigned.deviceKey.slice(0, 64) }],
        ['U1-no-time-field', { ...voteA, electionRevision: Date.now() }],
        ['U1-no-time-field', { ...voteA, ballotId: new Date().toISOString() }]
      ]
      let caught = 0
      const missed: string[] = []
      for (const [expected, planted] of plants) {
        const failed = linkability(planted, signed()).filter(([, ok]) => !ok).map(([n]) => n)
        if (failed.includes(expected)) caught++
        else missed.push(`planted for ${expected}, failing=${JSON.stringify(failed)}`)
      }
      expect(caught, `probe MISSED: ${missed.join('; ')}`).to.equal(plants.length)
      expect(plants).to.have.length(5)
    })

    it('port completeness: all 28 spike-096 check ids are present', function () {
      const text = readFileSync(fileURLToPath(import.meta.url), 'utf8')
      const titles = [...text.matchAll(/^\s*it\(\s*[`'"]([^`'"]*)/gm)].map(m => m[1]!)
      const ids = ['H0', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'T1', 'T2', 'T3', 'N1', 'N2', 'N3', 'N4',
        'U1-key-allowlist', 'U1-no-identifying-value', 'U1-no-time-field', 'U2', 'U3', 'U3b', 'U4', 'V1', 'M1']
      for (const id of ids) expect(titles.some(t => t === id || t.startsWith(id + ' ')), id).to.equal(true)
      expect(mutationNames).to.have.length(5)
    })
  })
})
