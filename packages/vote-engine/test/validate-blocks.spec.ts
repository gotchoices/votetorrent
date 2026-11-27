/**
 * validate-blocks.spec.ts — R7 (D-70, D-71): the shared pool payload shape check, the ballot answer
 * validator and the comprehensive block validation, over the 65-05 committed-row fixture.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { serializeBlockCiphertext } from '../src/crypto/index.js'
import { encryptElectionBlock, encryptVoteEntry, reencryptElectionBlock } from '../src/key-release/election-block.js'
import {
  checkFormedPoolBlock,
  checkPoolPayloadShape,
  consentDigest,
  formPoolBlock,
  poolBlockCid,
  poolBlockId,
  type FormedPoolBlock,
  type PoolBallot,
  type PoolBlockCheck,
  type PoolContribution
} from '../src/pool/pool-block.js'
import { canonicalJson, sortByCanonicalBytes } from '../src/voting/canonical.js'
import { ballotTemplateDigest, buildVoteEntry, makeVoteNonce, type VoteEntry } from '../src/voting/vote-entries.js'
import {
  ANSWER_FINDING_CODES,
  ANSWER_INFO_CODES,
  questionType,
  validateVoteEntryAgainstBallot,
  type VoteEntryValidity
} from '../src/blocks/answer-checks.js'
import { VALIDATION_CODES, VALIDATION_INFO_CODES, validateElectionBlocks } from '../src/blocks/validate-blocks.js'
import {
  FIXTURE_ELECTION_ID,
  FIXTURE_EXPIRATION,
  FIXTURE_REVISION,
  FIXTURE_VOTING_STARTS,
  fixtureAuthorization,
  makeCommittedBlock,
  makeCommittedElection,
  makeFixtureElection,
  makeFixtureTemplate,
  makeFixtureVoter,
  seededShuffle,
  signVoterEntry
} from './fixtures/pool-blocks.js'
import { makeP256TestKey, signDigestP256 } from './fixtures/p256-signer.js'

// The oracle below is the b0cee4af body of checkFormedPoolBlock and sameOrder, copied verbatim from
// `git show b0cee4af:packages/vote-engine/src/pool/pool-block.ts` (only the two names changed).
// PS-4 proves the refactored function returns exactly what this one returns.

const legacySameOrder = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((x, i) => canonicalJson(x) === canonicalJson(b[i]))

/**
 * What a member checks before it signs a formed block. Every refusal names its reason (the former
 * relays it to the pool); a member never signs a block that fails any of these.
 */
export function legacyCheckFormedPoolBlock (block: FormedPoolBlock, mine: PoolContribution, ballot: PoolBallot): PoolBlockCheck {
  const p = block.payload
  if (p?.v !== 2 || !Array.isArray(p.votes) || !Array.isArray(p.voterRecords)) return { ok: false, reason: 'the block is not a pool block' }
  if (block.templateDigest !== ballot.templateDigest) return { ok: false, reason: 'the block names another ballot template' }
  if (p.votes.length !== p.voterRecords.length) return { ok: false, reason: 'vote and voter counts differ' }
  if (p.votes.length !== block.registrantIds.length) return { ok: false, reason: 'the voter list does not match the entries' }
  if (!legacySameOrder(p.votes, sortByCanonicalBytes(p.votes)) || !legacySameOrder(p.voterRecords, sortByCanonicalBytes(p.voterRecords))) {
    return { ok: false, reason: 'the entries are not in canonical order' }
  }
  if (p.votes.filter(v => v === mine.voteCiphertext).length !== 1) return { ok: false, reason: 'my vote is missing or altered' }
  const myEntry = canonicalJson(mine.voterEntry)
  if (p.voterRecords.filter(r => canonicalJson(r) === myEntry).length !== 1) return { ok: false, reason: 'my voter entry is missing or altered' }
  if (new Set(p.votes as string[]).size !== p.votes.length) return { ok: false, reason: 'a vote appears twice' }
  const ids = (p.voterRecords as VoterEntry[]).map(r => r?.registrantId)
  if (new Set(ids).size !== ids.length) return { ok: false, reason: 'a voter appears twice' }
  if (canonicalJson([...ids].sort()) !== canonicalJson(block.registrantIds)) return { ok: false, reason: 'the voter list does not match the entries' }
  for (const r of p.voterRecords as VoterEntry[]) {
    if (r?.electionId !== ballot.electionKey.electionId || r?.electionRevision !== ballot.electionKey.revision) {
      return { ok: false, reason: 'a voter entry is for another election or revision' }
    }
  }
  if (poolBlockId(p) !== block.blockId) return { ok: false, reason: 'the block id is not the digest of the payload' }
  let rederived: string
  try {
    rederived = serializeBlockCiphertext(reencryptElectionBlock(ballot.electionKey, block.blockId, p, block.randomness))
  } catch {
    return { ok: false, reason: 'the disclosed randomness is unusable' }
  }
  if (rederived !== block.ciphertext) return { ok: false, reason: 'the ciphertext does not encrypt the shown payload' }
  if (poolBlockCid(block.ciphertext) !== block.cid) return { ok: false, reason: 'the cid does not match the ciphertext' }
  return { ok: true }
}

describe('pool payload shape (65-07: checkPoolPayloadShape)', function () {
  this.timeout(30_000)

  let set: ReturnType<typeof makeCommittedElection>
  let b2: ReturnType<typeof makeCommittedElection>['blocks'][number]
  let b1: ReturnType<typeof makeCommittedElection>['blocks'][number]
  const scope2 = { electionId: FIXTURE_ELECTION_ID, revision: FIXTURE_REVISION }

  before(() => {
    set = makeCommittedElection({ ballotIds: ['ballot-a'], blocks: [{ size: 4 }, { size: 3, payloadVersion: 1 }] })
    b2 = set.blocks[0]!
    b1 = set.blocks[1]!
  })

  const ids2 = (): string[] => [...b2.formed!.registrantIds]
  const votes2 = (): string[] => [...(b2.payload.votes as string[])]
  const recs2 = (): any[] => [...(b2.payload.voterRecords as any[])]
  const payloadOf = (votes: unknown[], voterRecords: unknown[], v: 1 | 2 = 2): any => ({ v, votes, voterRecords })

  it('PS-1 an honest v:2 and an honest v:1 payload are ok', () => {
    expect(checkPoolPayloadShape(b2.payload, b2.formed!.registrantIds, scope2)).to.deep.equal({ ok: true })
    const ids1 = JSON.parse(b1.row.VoterRegistrantIds) as string[]
    expect(checkPoolPayloadShape(b1.payload, ids1, scope2)).to.deep.equal({ ok: true })
  })

  it('PS-2 every code, its stage and its legacy reason', () => {
    const cases: Array<[string, any, string[], any, string, 'structure' | 'records', string]> = [
      ['null payload', null, ids2(), scope2, 'not-a-payload', 'structure', 'the block is not a pool block'],
      ['votes not an array', { v: 2, votes: 'x', voterRecords: recs2() }, ids2(), scope2, 'not-a-payload', 'structure', 'the block is not a pool block'],
      ['one record dropped', payloadOf(votes2(), recs2().slice(1)), ids2(), scope2, 'counts-differ', 'structure', 'vote and voter counts differ'],
      ['short voter list', b2.payload, ids2().slice(1), scope2, 'voter-count-mismatch', 'structure', 'the voter list does not match the entries'],
      ['votes reversed', payloadOf(votes2().reverse(), recs2()), ids2(), scope2, 'not-canonical-order', 'structure', 'the entries are not in canonical order'],
      ['duplicate vote', payloadOf(sortByCanonicalBytes([votes2()[0], ...votes2().slice(0, 1), ...votes2().slice(2)]), recs2()), ids2(), scope2, 'duplicate-vote', 'records', 'a vote appears twice'],
      ['duplicate voter', payloadOf(votes2(), sortByCanonicalBytes([recs2()[0], { ...recs2()[0], privateCid: 'zzz' }, recs2()[2], recs2()[3]])), ids2(), scope2, 'duplicate-voter', 'records', 'a voter appears twice'],
      ['stranger in list', b2.payload, [...ids2().slice(1), 'stranger'].sort(), scope2, 'voter-list-mismatch', 'records', 'the voter list does not match the entries'],
      ['other revision scope', b2.payload, ids2(), { electionId: FIXTURE_ELECTION_ID, revision: 2 }, 'voter-entry-scope-mismatch', 'records', 'a voter entry is for another election or revision']
    ]
    for (const [name, payload, ids, scope, code, stage, reason] of cases) {
      const r = checkPoolPayloadShape(payload, ids, scope)
      expect(r, name).to.deep.equal({ ok: false, code, stage, reason })
    }
    expect(checkPoolPayloadShape(b2.payload, ids2()), 'no scope').to.deep.equal({ ok: true })
  })

  it('PS-3 structure failures are reported before record failures', () => {
    const dup = sortByCanonicalBytes([votes2()[0], votes2()[0], votes2()[2], votes2()[3]])
    const r = checkPoolPayloadShape(payloadOf([...dup].reverse(), recs2()), ids2(), scope2)
    expect(r).to.deep.include({ ok: false, code: 'not-canonical-order', stage: 'structure' })
  })

  it('PS-4 checkFormedPoolBlock equals the b0cee4af body on every tampered block and every member', () => {
    const poolBallot: PoolBallot = b2.ballot.poolBallot
    const contribs: PoolContribution[] = b2.voters.map(v => v.contribution)
    const formed = b2.formed!
    const other = formPoolBlock(contribs.slice(0, 3), poolBallot)
    const withPayload = (payload: any): FormedPoolBlock => ({ ...formed, payload })
    const swapped = sortByCanonicalBytes(votes2().map((v, i) => (i === votes2().indexOf(contribs[1]!.voteCiphertext) ? contribs[0]!.voteCiphertext : v)))
    const dupVoter = sortByCanonicalBytes([recs2()[0], { ...recs2()[0], privateCid: 'zzz' }, recs2()[2], recs2()[3]])
    const rec0Rev2 = sortByCanonicalBytes(recs2().map((r, i) => (i === 0 ? { ...r, electionRevision: 2 } : r)))
    const blocks: Array<[string, FormedPoolBlock]> = [
      ['honest', formed],
      ['votes reversed', withPayload(payloadOf(votes2().reverse(), recs2()))],
      ['registrantIds.slice(1)', { ...formed, registrantIds: formed.registrantIds.slice(1) }],
      ['formed without member 0', formPoolBlock(contribs.slice(1), poolBallot)],
      ['member 0 vote twice', withPayload(payloadOf(swapped, recs2()))],
      ['voter twice', withPayload(payloadOf(votes2(), dupVoter))],
      ['templateDigest other', { ...formed, templateDigest: 'other' }],
      ['record revision 2', withPayload(payloadOf(votes2(), rec0Rev2))],
      ['ciphertext of another block', { ...formed, ciphertext: other.ciphertext }],
      ['cid of another block', { ...formed, cid: other.cid }],
      ['blockId first char changed', { ...formed, blockId: (formed.blockId[0] === 'A' ? 'B' : 'A') + formed.blockId.slice(1) }],
      ['payload v:1', withPayload(payloadOf(votes2(), recs2(), 1))],
      ['payload null', withPayload(null)]
    ]
    for (const [name, block] of blocks) {
      for (const mine of contribs) {
        const now: PoolBlockCheck = checkFormedPoolBlock(block, mine, poolBallot)
        const then = legacyCheckFormedPoolBlock(block, mine, poolBallot)
        expect(now, `${name} / ${mine.member}`).to.deep.equal(then)
      }
    }
    expect(legacyCheckFormedPoolBlock(blocks[0]![1], contribs[0]!, poolBallot)).to.deep.equal({ ok: true })
    expect(checkFormedPoolBlock(blocks[4]![1], contribs[0]!, poolBallot)).to.deep.equal({ ok: false, reason: 'my vote is missing or altered' })
  })

  it('PS-5 hostile JSON values give a typed failure, never a throw', () => {
    const r = checkPoolPayloadShape(payloadOf(['a', 'b', 'c'], [null, 1, 'x']), ['i', 'j', 'k'], scope2)
    expect(r.ok).to.equal(false)
    const r2 = checkPoolPayloadShape(payloadOf(['a', 'b', 'c'], ['x', 1, null]), ['i', 'j', 'k'], scope2)
    expect(r2.ok).to.equal(false)
    // keep the shared helpers referenced so the oracle imports stay honest
    expect(typeof poolBlockId).to.equal('function')
    expect(typeof poolBlockCid).to.equal('function')
    expect(typeof reencryptElectionBlock).to.equal('function')
    expect(typeof serializeBlockCiphertext).to.equal('function')
    expect(typeof canonicalJson).to.equal('function')
  })
})

describe('answer checks (65-07: validateVoteEntryAgainstBallot, D-71)', function () {
  this.timeout(30_000)

  const t = makeFixtureTemplate('ballot-a')
  const tOpt = { ...t, questions: t.questions.map(q => (q.code === 'q3' ? { ...q, required: false } : q)) }
  const scope = { electionId: FIXTURE_ELECTION_ID, electionRevision: FIXTURE_REVISION, ballotId: 'ballot-a' }
  const nonce = (): string => makeVoteNonce(globalThis.crypto.getRandomValues(new Uint8Array(32)))
  const build = (selections: Record<string, string[]>, ballot = t): VoteEntry =>
    buildVoteEntry({ ballot, electionRevision: FIXTURE_REVISION, selections, nonce: nonce() })
  const codes = (r: VoteEntryValidity): string[] => r.findings.map(f => f.code)
  const errors = (r: VoteEntryValidity): string[] => r.findings.filter(f => f.severity === 'error').map(f => f.code)
  const base = (): VoteEntry => build({ q1: ['a'], q2: ['x'] }, tOpt)
  const raw = (over: Record<string, unknown>): unknown => ({ ...base(), ...over })
  const withQ2 = (over: Record<string, unknown>): ReturnType<typeof makeFixtureTemplate> =>
    makeFixtureTemplate('ballot-a', { questions: t.questions.map(q => (q.code === 'q2' ? { ...q, ...over } : q)) })

  it('AC-1 producer output validates', () => {
    for (const sel of [{ q1: ['a'], q2: ['x'] }, { q1: ['c'], q2: ['y', 'x'] }]) {
      const e = build(sel, tOpt)
      const r = validateVoteEntryAgainstBallot(e, tOpt, scope)
      expect(r.valid).to.equal(true)
      if (r.valid) expect(r.entry).to.deep.equal(e)
      expect(r.findings).to.deep.equal([])
    }
    const blank = validateVoteEntryAgainstBallot(build({ q1: ['b'] }, tOpt), tOpt, scope)
    expect(blank.valid).to.equal(true)
    expect(blank.findings).to.have.length(1)
    expect(blank.findings[0]).to.deep.include({ code: 'blank-required', severity: 'info', questionCode: 'q2' })
    const plain = validateVoteEntryAgainstBallot(build({ q1: ['a'], q2: ['x'] }), t, scope)
    expect(plain.valid).to.equal(true)
    expect(plain.findings).to.have.length(1)
    expect(plain.findings[0]).to.deep.include({ code: 'blank-required', questionCode: 'q3' })
  })

  it('AC-2 D-71 minimum', () => {
    const tm = withQ2({ optionRange: { min: 2, max: 3 }, required: true })
    const below = validateVoteEntryAgainstBallot(build({ q1: ['a'], q2: ['x'] }, tm), tm, scope)
    expect(below.valid).to.equal(false)
    expect(errors(below)).to.deep.equal(['below-minimum'])
    expect(below.findings.find(f => f.code === 'below-minimum')?.questionCode).to.equal('q2')
    expect(validateVoteEntryAgainstBallot(build({ q1: ['a'], q2: ['x', 'y'] }, tm), tm, scope).valid).to.equal(true)
    const blank = validateVoteEntryAgainstBallot(build({ q1: ['a'] }, tm), tm, scope)
    expect(blank.valid).to.equal(true)
    expect(blank.findings.filter(f => f.code === 'blank-required' && f.questionCode === 'q2')).to.have.length(1)
    const opt = { ...tm, questions: tm.questions.map(q => (q.code === 'q2' || q.code === 'q3' ? { ...q, required: false } : q)) }
    expect(validateVoteEntryAgainstBallot(build({ q1: ['a'] }, opt), opt, scope).findings).to.deep.equal([])
  })

  it('AC-3 one error code per single-defect raw entry', () => {
    const q1 = (optionCodes: string[]): unknown => ({ questionCode: 'q1', optionCodes })
    const q2 = (optionCodes: string[]): unknown => ({ questionCode: 'q2', optionCodes })
    const cases: Array<[string, unknown]> = [
      ['unknown-question', raw({ answers: [q1(['a']), q2(['x']), { questionCode: 'q9', optionCodes: ['a'] }] })],
      ['unknown-option', raw({ answers: [q1(['zz']), q2(['x'])] })],
      ['too-many-options', raw({ answers: [q1(['a', 'b']), q2(['x'])] })],
      ['duplicate-option', raw({ answers: [q1(['a']), q2(['x', 'x'])] })],
      ['options-not-sorted', raw({ answers: [q1(['a']), q2(['y', 'x'])] })],
      ['empty-answer', raw({ answers: [q1(['a']), q2([])] })],
      ['answers-not-sorted', raw({ answers: [q2(['x']), q1(['a'])] })],
      ['duplicate-question', raw({ answers: [q1(['a']), q1(['a']), q2(['x'])] })],
      ['bad-nonce', raw({ nonce: 'A'.repeat(64) })],
      ['bad-nonce', raw({ nonce: 'a'.repeat(63) })],
      ['template-digest-mismatch', raw({ templateDigest: 'other' })],
      ['wrong-ballot', raw({ ballotId: 'ballot-b' })],
      ['wrong-election', raw({ electionId: 'other-election' })],
      ['wrong-revision', raw({ electionRevision: 2 })]
    ]
    for (const [code, entry] of cases) {
      const r = validateVoteEntryAgainstBallot(entry, tOpt, scope)
      expect(r.valid, code).to.equal(false)
      expect(errors(r), code).to.deep.equal([code])
    }
    const unk = validateVoteEntryAgainstBallot(raw({ answers: [q1(['zz']), q2(['x'])] }), tOpt, scope)
    expect(unk.findings[0]).to.deep.include({ optionCode: 'zz', questionCode: 'q1' })
  })

  it('AC-4 malformed entries give one malformed-entry finding', () => {
    const b = base() as any
    const { nonce: _n, ...noNonce } = b
    const bad: unknown[] = [
      null, [], 'x', noNonce, { ...b, extra: 1 }, { ...b, v: 2 }, { ...b, answers: 'x' },
      { ...b, answers: [{ questionCode: 'q1', optionCodes: ['a'], extra: 1 }] },
      { ...b, answers: [{ questionCode: 'q1', optionCodes: [1] }] },
      { ...b, electionRevision: '1' }, { ...b, electionRevision: 1n }
    ]
    for (const e of bad) {
      const r = validateVoteEntryAgainstBallot(e, tOpt, scope)
      expect(r.valid).to.equal(false)
      expect(codes(r)).to.deep.equal(['malformed-entry'])
    }
  })

  it('AC-5 non-select questions are info, structure still applies', () => {
    const e = build({ q1: ['a'], q2: ['x'], q3: ['r1'] }, tOpt)
    const r = validateVoteEntryAgainstBallot(e, tOpt, scope)
    expect(r.valid).to.equal(true)
    expect(r.findings).to.have.length(1)
    expect(r.findings[0]).to.deep.include({ code: 'unsupported-question-type', severity: 'info', questionCode: 'q3' })
    const bad = validateVoteEntryAgainstBallot(raw({ answers: [{ questionCode: 'q1', optionCodes: ['a'] }, { questionCode: 'q2', optionCodes: ['x'] }, { questionCode: 'q3', optionCodes: ['zz'] }] }), tOpt, scope)
    expect(bad.valid).to.equal(false)
    expect(errors(bad)).to.deep.equal(['unknown-option'])
  })

  it('AC-6 every defect is collected in a fixed order', () => {
    const e = raw({ nonce: 'BAD', answers: [{ questionCode: 'q1', optionCodes: ['zz'] }] })
    const r = validateVoteEntryAgainstBallot(e, tOpt, scope)
    expect(codes(r)).to.deep.equal(['bad-nonce', 'unknown-option', 'blank-required'])
  })

  it('AC-7 the scope digest is authoritative; required does not move the digest', () => {
    const e = raw({ templateDigest: 'custom' })
    expect(codes(validateVoteEntryAgainstBallot(e, tOpt, scope))).to.deep.equal(['template-digest-mismatch'])
    expect(codes(validateVoteEntryAgainstBallot(e, tOpt, { ...scope, templateDigest: 'custom' }))).to.deep.equal([])
    expect(ballotTemplateDigest(t, FIXTURE_REVISION)).to.equal(ballotTemplateDigest(tOpt, FIXTURE_REVISION))
  })

  it('AC-8 a hostile ballot gives malformed-ballot', () => {
    for (const ballot of [{ ...tOpt, questions: 'x' }, { ...tOpt, questions: [{ title: 'no code', options: [] }] }, null, { ...tOpt, questions: [{ code: 'q1', options: [null] }] }]) {
      const r = validateVoteEntryAgainstBallot(base(), ballot as any, scope)
      expect(r.valid).to.equal(false)
      expect(codes(r)).to.deep.equal(['malformed-ballot'])
    }
  })

  it('AC-10 (IN-03) a null type is select; a non-string type makes the ballot malformed', () => {
    const nullType = { ...tOpt, questions: tOpt.questions.map(q => (q.code === 'q1' ? { ...q, type: null } : q)) } as any
    const r = validateVoteEntryAgainstBallot(base(), nullType, scope)
    expect(r.valid).to.equal(true)
    expect(codes(r)).to.not.include('unsupported-question-type')
    expect(questionType({ code: 'q', type: null })).to.equal('select')
    expect(questionType({ code: 'q' })).to.equal('select')
    expect(questionType({ code: 'q', type: 'rank' })).to.equal('rank')
    expect(questionType({ code: 'q', type: 5 })).to.equal(null)
    for (const type of [5, true, {}, []]) {
      const bad = { ...tOpt, questions: tOpt.questions.map(q => (q.code === 'q1' ? { ...q, type } : q)) } as any
      expect(codes(validateVoteEntryAgainstBallot(base(), bad, scope)), JSON.stringify(type)).to.deep.equal(['malformed-ballot'])
    }
  })

  it('AC-9 pure, closed codes, severity rule', () => {
    const entry = raw({ nonce: 'BAD', answers: [{ questionCode: 'q3', optionCodes: ['r1'] }, { questionCode: 'q9', optionCodes: [] }] })
    const entryCopy = structuredClone(entry)
    const ballotCopy = structuredClone(tOpt)
    const r1 = validateVoteEntryAgainstBallot(entry, tOpt, scope)
    const r2 = validateVoteEntryAgainstBallot(entry, tOpt, scope)
    expect(r1).to.deep.equal(r2)
    expect(entry).to.deep.equal(entryCopy)
    expect(tOpt).to.deep.equal(ballotCopy)
    for (const f of r1.findings) {
      expect(f.detail).to.be.a('string').that.is.not.empty
      expect(ANSWER_FINDING_CODES).to.include(f.code)
      expect(f.severity).to.equal((ANSWER_INFO_CODES as readonly string[]).includes(f.code) ? 'info' : 'error')
    }
  })
})

describe('validate election blocks (65-07: R7, D-70, D-71)', function () {
  this.timeout(60_000)

  let set: ReturnType<typeof makeCommittedElection>
  let scope: { electionId: string, electionRevision: number }
  let ballotsOpt: any[]
  let release: { secretKey: Uint8Array, jointPublicKey: string }
  const input = (over: Record<string, unknown> = {}): any => ({
    scope, rows: set.rows, voterRows: set.voterRows, ballots: ballotsOpt, ...set.authorization, ...over
  })
  const optional = (t: any): any => ({ ...t, questions: t.questions.map((q: any) => (q.code === 'q3' ? { ...q, required: false } : q)) })

  before(() => {
    set = makeCommittedElection({ ballotIds: ['ballot-a', 'ballot-b'], blocks: [{ size: 3 }, { size: 4 }, { ballotIndex: 1, size: 3 }, { size: 3, payloadVersion: 1 }] })
    scope = { electionId: FIXTURE_ELECTION_ID, electionRevision: FIXTURE_REVISION }
    ballotsOpt = set.election.ballots.map(b => optional(b.template))
    release = { secretKey: set.election.electionSecret, jointPublicKey: set.election.electionKey.jointPublicKey }
  })

  const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))

  function assertTotals (r: any): void {
    expect(r.ok, JSON.stringify(r)).to.equal(true)
    const t = r.totals
    expect(t.valid + t.invalid + t.excluded + t.undecryptable).to.equal(t.entries)
    // WR-05: valid and invalid count only votes of valid blocks; excluded is the attested volume of invalid ones
    let valid = 0; let invalid = 0; let excluded = 0; let undecryptable = 0
    for (const b of r.blocks) {
      if (b.status === 'invalid') excluded += b.attestedEntries
      else if (b.status === 'valid') for (const v of b.votes) { if (v.status === 'valid') valid++; else invalid++ }
      else if (b.shadowedBy === null) undecryptable += b.declaredEntries
      // T-65-05-03: a shadowed block counts nothing, and only a block of a shared Cid is ever shadowed
      if (b.shadowedBy !== null) {
        expect(b.attestedEntries).to.equal(0)
        expect(r.blocks.some((o: any) => o.leafHash === b.shadowedBy && o.blockCid === b.blockCid)).to.equal(true)
      }
      expect(b.leafHash).to.match(/^[0-9a-f]{64}$/)
    }
    expect({ valid, invalid, excluded, undecryptable }).to.deep.equal({ valid: t.valid, invalid: t.invalid, excluded: t.excluded, undecryptable: t.undecryptable })
    const all = [...r.findings, ...r.blocks.flatMap((b: any) => b.findings)]
    for (const f of all) {
      expect(VALIDATION_CODES).to.include(f.code)
      expect(f.severity).to.equal((VALIDATION_INFO_CODES as readonly string[]).includes(f.code) ? 'info' : 'error')
      expect(f.blockCid).to.be.a('string')
      expect(f.detail).to.be.a('string').that.is.not.empty
    }
    const cids = r.blocks.map((b: any) => b.blockCid)
    expect([...cids].sort(byteOrder)).to.deep.equal(cids)
  }
  const run = (over: Record<string, unknown> = {}): any => {
    const r = validateElectionBlocks(input(over))
    assertTotals(r)
    return r
  }
  const runR = (over: Record<string, unknown> = {}): any => run({ release, ...over })
  const bf = (r: any, cid: string): any => r.blocks.find((b: any) => b.blockCid === cid)
  const codesOf = (b: any): string[] => b.findings.map((f: any) => f.code)
  const clone = <T>(x: T): T => structuredClone(x)

  /** Replace block rows and voter rows of one fixture block. */
  function swapBlock (block: any, wrapped: { row: any, voterRows: any[] }): { rows: any[], voterRows: any[] } {
    return {
      rows: set.rows.map(r => (r === block.row ? wrapped.row : r)),
      voterRows: [...set.voterRows.filter(v => v.BlockCid !== block.row.Cid), ...wrapped.voterRows]
    }
  }

  /** Re-encrypt a payload and re-sign every voter row, so only the intended defect is present. */
  function rewrap (block: any, payload: any, o: { id?: string, rowId?: string, row?: Record<string, unknown>, keys?: Record<string, { pubHex: string, privBytes: Uint8Array }> } = {}): { row: any, voterRows: any[] } {
    const encId = o.id ?? poolBlockId(payload)
    const rowId = o.rowId ?? encId
    const ct = serializeBlockCiphertext(encryptElectionBlock(set.election.electionKey, encId, payload))
    const cid = poolBlockCid(ct)
    const row = { ...block.row, Cid: cid, Id: rowId, Ciphertext: ct, ...(o.row ?? {}) }
    const voterRows = block.voters.map((v: any) => {
      const reg = v.voterEntry.registrantId
      const pub = o.keys?.[reg]?.pubHex ?? v.pubHex
      const priv = o.keys?.[reg]?.privBytes ?? v.priv
      return {
        ElectionId: FIXTURE_ELECTION_ID, BallotId: block.row.BallotId, RegistrantId: reg, BlockCid: cid, BlockId: rowId,
        ElectionRevision: FIXTURE_REVISION, DeviceKey: pub,
        Signature: signDigestP256(consentDigest({ cid, blockId: rowId }, block.ballot.poolBallot, reg, pub), priv)
      }
    })
    return { row, voterRows }
  }

  it('VB-1 before release every block is not-decryptable-yet', () => {
    const r = run()
    expect(r.released).to.equal(false)
    expect(r.blocks).to.have.length(4)
    for (const b of r.blocks) {
      expect(b).to.deep.include({ status: 'not-decryptable-yet', payloadVersion: null })
      expect(b.votes).to.deep.equal([])
      expect(b.findings).to.deep.equal([])
    }
    expect(r.totals).to.deep.equal({ blocks: 4, entries: 13, valid: 0, invalid: 0, excluded: 0, undecryptable: 13 })
  })

  it('VB-2 after release every block and vote is valid', () => {
    const r = runR()
    expect(r.released).to.equal(true)
    for (const b of r.blocks) {
      const fixture = set.blocks.find(x => x.row.Cid === b.blockCid)!
      expect(b.status).to.equal('valid')
      expect(b.payloadVersion).to.equal(fixture.payloadVersion)
      expect(b.findings).to.deep.equal([])
      expect(b.votes.every((v: any) => v.status === 'valid')).to.equal(true)
      expect(b.votes.map((v: any) => canonicalJson(v.entry)).sort()).to.deep.equal(fixture.voters.map(v => canonicalJson(v.voteEntry)).sort())
    }
    expect(set.blocks.filter(b => b.payloadVersion === 1)).to.have.length(1)
    expect(r.totals).to.deep.equal({ blocks: 4, entries: 13, valid: 13, invalid: 0, excluded: 0, undecryptable: 0 })
    const plain = runR({ ballots: set.election.ballots.map(b => b.template) })
    expect(plain.blocks.every((b: any) => b.status === 'valid' && b.votes.every((v: any) => v.status === 'valid'))).to.equal(true)
    const fs = plain.blocks.flatMap((b: any) => b.findings)
    expect(fs).to.have.length(13)
    for (const f of fs) expect(f).to.deep.include({ code: 'blank-required', severity: 'info', questionCode: 'q3' })
    for (const f of fs) expect(f.voteIndex).to.be.a('number')
    expect(plain.totals.valid).to.equal(13)
  })

  describe('VB-3 no-key block defects', () => {
    const target = (): any => set.blocks[0]!
    const expectOnly = (r: any, cid: string, code: string): any => {
      const b = bf(r, cid)
      expect(b.status).to.equal('invalid')
      expect(codesOf(b)).to.deep.equal([code])
      for (const o of r.blocks) if (o.blockCid !== cid) expect(o.findings, o.blockCid).to.deep.equal([])
      return b
    }
    const withRow = (over: Record<string, unknown>, block: any = target()): any => ({ rows: set.rows.map(r => (r === block.row ? { ...r, ...over } : r)) })

    it('cid, count, list defects', () => {
      const t = target()
      expectOnly(run(withRow({ Ciphertext: set.blocks[1]!.row.Ciphertext })), t.row.Cid, 'cid-mismatch')
      expectOnly(run(withRow({ EntryCount: 2 })), t.row.Cid, 'entry-count-mismatch')
      expectOnly(run(withRow({ VoterRegistrantIds: 'not json' })), t.row.Cid, 'voter-list-malformed')
      expectOnly(run(withRow({ VoterRegistrantIds: '[1,2,3]' })), t.row.Cid, 'voter-list-malformed')
      const reversed = JSON.stringify((JSON.parse(t.row.VoterRegistrantIds) as string[]).reverse())
      expectOnly(run(withRow({ VoterRegistrantIds: reversed })), t.row.Cid, 'voter-list-not-canonical')
      expectOnly(run(withRow({ TemplateDigest: 'changed' })), t.row.Cid, 'template-mismatch')
    })

    it('voter row defects', () => {
      const t = target()
      const mine = set.voterRows.filter(v => v.BlockCid === t.row.Cid)
      const others = set.voterRows.filter(v => v.BlockCid !== t.row.Cid)
      const missing = run({ voterRows: [...others, ...mine.slice(1)] })
      const mb = expectOnly(missing, t.row.Cid, 'voter-row-missing')
      expect(mb.findings[0].registrantId).to.equal(mine[0]!.RegistrantId)

      const k = makeP256TestKey()
      const stranger = {
        ...mine[0]!, RegistrantId: 'stranger', DeviceKey: k.pubHex,
        Signature: signDigestP256(consentDigest({ cid: t.row.Cid, blockId: t.row.Id }, t.ballot.poolBallot, 'stranger', k.pubHex), k.privBytes)
      }
      // CR-03: an unlisted row and a second row are report-level, never a finding on the block they name
      for (const extra of [stranger, clone(mine[0]!)]) {
        const r = run({ voterRows: [...set.voterRows, extra] })
        for (const b of r.blocks) expect(b.findings, b.blockCid).to.deep.equal([])
        expect(r.findings.map((f: any) => [f.code, f.blockCid, f.registrantId])).to.deep.equal([['voter-row-forged', t.row.Cid, extra.RegistrantId]])
      }
      const mism = set.voterRows.map(v => (v === mine[1] ? { ...v, BlockId: 'other-id' } : v))
      expectOnly(run({ voterRows: mism }), t.row.Cid, 'voter-row-mismatch')
      const flipped = set.voterRows.map(v => (v === mine[2] ? { ...v, Signature: (v.Signature[0] === '0' ? '1' : '0') + v.Signature.slice(1) } : v))
      const fb = expectOnly(run({ voterRows: flipped }), t.row.Cid, 'consent-signature-invalid')
      expect(fb.findings[0].registrantId).to.equal(mine[2]!.RegistrantId)
    })

    const t0 = (): any => set.blocks[0]!
    it('unknown ballot and malformed rows', () => {
      const b2 = set.blocks[2]!
      expectOnly(run({ ballots: ballotsOpt.filter(b => b.id !== 'ballot-b') }), b2.row.Cid, 'unknown-ballot')
      // WR-06: a malformed row is a report-level finding, never a block, and touches no other block
      const nul = run({ rows: [...set.rows, null, { ...t0().row, Cid: 'NOT-BASE32', Id: 'x' }] })
      expect(nul.blocks).to.have.length(4)
      for (const b of nul.blocks) expect(b.findings).to.deep.equal([])
      expect(nul.findings.map((f: any) => [f.code, f.blockCid])).to.deep.equal([['malformed-row', ''], ['malformed-row', 'NOT-BASE32']])
      expect(nul.totals.blocks).to.equal(4)
      const t = target()
      const bad = run(withRow({ Ciphertext: 7 }))
      const bb = bf(bad, t.row.Cid)
      expect(bb.status).to.equal('invalid')
      expect(codesOf(bb)).to.deep.equal(['malformed-row'])
      expect(bad.totals).to.include({ undecryptable: 10, excluded: 3, entries: 13 })
    })
  })

  it('VB-4 cross-block double voting, duplicate rows, orphan voter rows', () => {
    const e = makeFixtureElection({ ballotIds: ['ballot-a'] })
    const ballot = e.ballots[0]!
    const vs = [0, 1, 2, 3, 4].map(i => makeFixtureVoter(e, ballot, i))
    const A = makeCommittedBlock(e, ballot, [vs[0]!, vs[1]!, vs[2]!])
    const B = makeCommittedBlock(e, ballot, [vs[0]!, vs[3]!, vs[4]!])
    const r = run({ rows: [A.row, B.row], voterRows: [...A.voterRows, ...B.voterRows], ballots: [optional(ballot.template)], ...fixtureAuthorization(vs) })
    for (const b of [A, B]) {
      const f = bf(r, b.row.Cid).findings.filter((x: any) => x.code === 'registrant-in-two-blocks')
      expect(f).to.have.length(1)
      expect(f[0].registrantId).to.equal(vs[0]!.voterEntry.registrantId)
      expect(bf(r, b.row.Cid).status).to.equal('invalid')
    }
    // WR-06: a second copy is set aside at report level; the block itself keeps no finding
    const dup = run({ rows: [...set.rows, set.rows[0]] })
    expect(dup.totals.blocks).to.equal(4)
    expect(codesOf(bf(dup, set.rows[0]!.Cid))).to.deep.equal([])
    expect(dup.findings.map((f: any) => [f.code, f.blockCid, f.severity])).to.deep.equal([['duplicate-block', set.rows[0]!.Cid, 'error']])
    // a forged row with the honest block's Cid but a ciphertext that does not hash to it never displaces it
    const forged = { ...set.rows[0]!, Id: '0-forged', Ciphertext: set.rows[1]!.Ciphertext }
    for (const rows of [[forged, ...set.rows], [...set.rows, forged]]) {
      const fr = runR({ rows })
      expect(bf(fr, set.rows[0]!.Cid).status).to.equal('valid')
      expect(bf(fr, set.rows[0]!.Cid).blockId).to.equal(set.rows[0]!.Id)
      expect(fr.findings.map((f: any) => f.code)).to.deep.equal(['duplicate-block'])
    }
    // T-65-05-03: a row reusing the honest Id under its own Cid is not a duplicate; it is a block of its own, judged
    // on its own consent rows (none name it), and the honest block stays valid
    const ownCt = 'forged ciphertext text'
    const sameId = { ...set.rows[0]!, Cid: poolBlockCid(ownCt), Ciphertext: ownCt }
    for (const rows of [[sameId, ...set.rows], [...set.rows, sameId]]) {
      const sr = runR({ rows })
      expect(sr.totals.blocks).to.equal(5)
      expect(sr.findings.map((f: any) => f.code)).to.deep.equal([])
      expect(bf(sr, set.rows[0]!.Cid).status).to.equal('valid')
      expect(bf(sr, sameId.Cid).status).to.equal('invalid')
      expect(bf(sr, sameId.Cid).blockId).to.equal(set.rows[0]!.Id)
      expect(bf(sr, sameId.Cid).attestedEntries).to.equal(0)
      expect(codesOf(bf(sr, sameId.Cid))).to.include('voter-row-missing')
    }
    const orphan = run({ voterRows: [...set.voterRows, { ...set.voterRows[0]!, BlockCid: 'nope' }] })
    expect(orphan.findings).to.have.length(1)
    expect(orphan.findings[0]).to.deep.include({ code: 'voter-row-without-block', severity: 'info', blockCid: 'nope' })
    expect(orphan.totals.blocks).to.equal(4)
  })

  describe('VB-5 after-release block defects', () => {
    const block = (): any => set.blocks[0]!
    const records = (): any[] => [...(block().payload.voterRecords as any[])]
    const votes = (): any[] => [...(block().payload.votes as any[])]
    function tampered (wrapped: { row: any, voterRows: any[] }, b: any = block()): any {
      const { rows, voterRows } = swapBlock(b, wrapped)
      const r = runR({ rows, voterRows })
      const f = bf(r, wrapped.row.Cid)
      expect(f.status, JSON.stringify(f.findings)).to.equal('invalid')
      for (const o of r.blocks) if (o.blockCid !== wrapped.row.Cid) expect(o.status).to.equal('valid')
      return f
    }

    it('block level', () => {
      const b = block()
      expect(codesOf(tampered(rewrap(b, b.payload, { id: 'wrong-id-0' })))).to.deep.equal(['id-mismatch'])

      const dne = rewrap(b, b.payload, { id: 'another-id-0', rowId: b.row.Id })
      const { rows, voterRows } = swapBlock(b, dne)
      const r = runR({ rows, voterRows })
      const f = bf(r, dne.row.Cid)
      expect(f.status).to.equal('invalid')
      expect(f.votes).to.deep.equal([])
      expect(f.payloadVersion).to.equal(null)
      expect(codesOf(f)).to.deep.equal(['block-does-not-open'])
      // WR-05: a released block that does not open is invalid, so its entries are excluded, not undecryptable
      expect(r.totals).to.include({ undecryptable: 0, excluded: 3, valid: 10, entries: 13 })

      const order = tampered(rewrap(b, { ...b.payload, votes: votes().reverse() }))
      expect(codesOf(order)).to.include('not-canonical-order')
      const counts = tampered(rewrap(b, { ...b.payload, voterRecords: records().slice(1) }))
      expect(codesOf(counts)).to.include('counts-differ')
      const pcm = codesOf(tampered(rewrap(b, b.payload, { row: { EntryCount: 5 } })))
      expect(pcm).to.include.members(['entry-count-mismatch', 'payload-count-mismatch'])
      // WR-05: the votes inside a block-invalid block are neither valid nor invalid in the totals
      const inv = runR(swapBlock(b, rewrap(b, b.payload, { id: 'wrong-id-1' })))
      expect(inv.totals).to.deep.equal({ blocks: 4, entries: 13, valid: 10, invalid: 0, excluded: 3, undecryptable: 0 })
    })

    it('v:1 clear votes repeated', () => {
      const b1 = set.blocks[3]!
      const vs = [...(b1.payload.votes as any[])]
      const dupVotes = sortByCanonicalBytes([vs[0], clone(vs[0]), vs[2]])
      const f = tampered(rewrap(b1, { ...b1.payload, votes: dupVotes }), b1)
      expect(codesOf(f)).to.include('duplicate-vote')
    })

    it('voter entry defects', () => {
      const b = block()
      const recs = records()
      const order = (rs: any[]): any[] => sortByCanonicalBytes(rs)
      const target = recs[0]
      const voter = b.voters.find((v: any) => v.voterEntry.registrantId === target.registrantId)
      const reg = target.registrantId

      const altered = order([{ ...target, privateCid: 'altered' }, ...recs.slice(1)])
      const f1 = tampered(rewrap(b, { ...b.payload, voterRecords: altered }))
      expect(f1.findings.find((x: any) => x.code === 'voter-entry-signature-invalid')?.registrantId).to.equal(reg)

      const { signature: _s, ...unsigned } = target
      const noBallot = order([signVoterEntry({ ...unsigned, ballots: [] }, voter.priv), ...recs.slice(1)])
      const f2 = tampered(rewrap(b, { ...b.payload, voterRecords: noBallot }))
      expect(codesOf(f2)).to.include('voter-entry-ballot-missing')
      expect(codesOf(f2)).to.not.include('voter-entry-signature-invalid')

      const k = makeP256TestKey()
      const f3 = tampered(rewrap(b, b.payload, { keys: { [reg]: k } }))
      expect(codesOf(f3)).to.include('voter-entry-device-key-mismatch')

      const rev2 = order([signVoterEntry({ ...unsigned, electionRevision: 2 }, voter.priv), ...recs.slice(1)])
      const f4 = tampered(rewrap(b, { ...b.payload, voterRecords: rev2 }))
      expect(codesOf(f4)).to.include('voter-entry-scope-mismatch')

      const extra = order([{ ...target, extra: 1 }, ...recs.slice(1)])
      const f5 = tampered(rewrap(b, { ...b.payload, voterRecords: extra }))
      expect(codesOf(f5)).to.include('voter-entry-malformed')
    })
  })

  it('VB-6 per-vote validity under D-71', () => {
    const base = makeFixtureTemplate('ballot-a')
    const tpl = makeFixtureTemplate('ballot-a', { questions: base.questions.map(q => (q.code === 'q2' ? { ...q, optionRange: { min: 2, max: 3 } } : q)) })
    const e = makeFixtureElection({ templates: [tpl] })
    const ballot = e.ballots[0]!
    const nonce = (): string => makeVoteNonce(globalThis.crypto.getRandomValues(new Uint8Array(32)))
    const entry = (selections: Record<string, string[]>): any => buildVoteEntry({ ballot: tpl, electionRevision: FIXTURE_REVISION, selections, nonce: nonce() })
    const tooMany = { ...entry({ q1: ['a'], q2: ['x', 'y'] }), answers: [{ questionCode: 'q1', optionCodes: ['a', 'b'] }, { questionCode: 'q2', optionCodes: ['x', 'y'] }] }
    const v3 = makeFixtureVoter(e, ballot, 3, { selections: { q1: ['a'], q2: ['x', 'y'] } })
    const wrongCt = encryptVoteEntry(e.electionKey, 'another-ballot', v3.voteJson)
    const voters = [
      makeFixtureVoter(e, ballot, 0, { selections: { q1: ['a'], q2: ['x', 'y'] } }),
      makeFixtureVoter(e, ballot, 1, { selections: { q1: ['b'], q2: ['x'] } }),
      makeFixtureVoter(e, ballot, 2, { voteEntry: tooMany }),
      { ...v3, voteCiphertext: wrongCt, contribution: { ...v3.contribution, voteCiphertext: wrongCt } },
      makeFixtureVoter(e, ballot, 4, { selections: { q1: ['c'] } })
    ]
    const blockFx = makeCommittedBlock(e, ballot, voters)
    const rel = { secretKey: e.electionSecret, jointPublicKey: e.electionKey.jointPublicKey }
    const inp = { scope, rows: [blockFx.row], voterRows: blockFx.voterRows, ballots: [optional(tpl)], ...fixtureAuthorization(voters) }
    const r: any = validateElectionBlocks({ ...inp, release: rel } as any)
    assertTotals(r)
    const b = r.blocks[0]
    expect(b.status).to.equal('valid')
    expect(b.votes.filter((v: any) => v.status === 'valid')).to.have.length(2)
    const invalid = b.votes.filter((v: any) => v.status === 'invalid')
    expect(invalid).to.have.length(3)
    expect(invalid.flatMap((v: any) => v.codes).sort()).to.deep.equal(['below-minimum', 'too-many-options', 'vote-does-not-open'])
    const verdictIndex = new Map<number, string>(b.votes.map((v: any) => [v.index, v.status]))
    for (const f of b.findings.filter((x: any) => x.severity === 'error')) {
      expect(f.voteIndex).to.be.a('number')
      expect(verdictIndex.get(f.voteIndex)).to.equal('invalid')
    }
    expect(b.findings.some((f: any) => f.code === 'blank-required' && f.severity === 'info')).to.equal(true)
    expect(r.totals).to.deep.equal({ blocks: 1, entries: 5, valid: 2, invalid: 3, excluded: 0, undecryptable: 0 })
    const pre: any = validateElectionBlocks(inp as any)
    assertTotals(pre)
    expect(pre.totals.undecryptable).to.equal(5)
  })

  it('VB-7 the caller secret is checked, copied and never retained', () => {
    const wrong = secp256k1.utils.randomSecretKey()
    expect(validateElectionBlocks(input({ release: { secretKey: wrong, jointPublicKey: release.jointPublicKey } }))).to.deep.include({ ok: false, reason: 'secret-mismatch' })
    expect(validateElectionBlocks(input({ release: { secretKey: new Uint8Array(32), jointPublicKey: release.jointPublicKey } }))).to.deep.include({ ok: false, reason: 'invalid-secret' })
    const before = Uint8Array.from(release.secretKey)
    const r = runR()
    expect(Array.from(release.secretKey)).to.deep.equal(Array.from(before))
    const seen = new Set<unknown>()
    const walk = (v: unknown): void => {
      expect(v instanceof Uint8Array).to.equal(false)
      if (v !== null && typeof v === 'object' && !seen.has(v)) {
        seen.add(v)
        for (const x of Object.values(v as object)) walk(x)
      }
    }
    walk(r)
  })

  it('VB-8 refusals and hostile input never throw', () => {
    const other = set.rows.map((r, i) => (i === 0 ? { ...r, ElectionId: 'other-election' } : r))
    expect(validateElectionBlocks(input({ rows: other }))).to.deep.include({ ok: false, reason: 'mixed-election' })
    const rev = set.rows.map((r, i) => (i === 0 ? { ...r, ElectionRevision: 2 } : r))
    expect(validateElectionBlocks(input({ rows: rev }))).to.deep.include({ ok: false, reason: 'mixed-revision' })
    const revBig = set.rows.map((r, i) => (i === 0 ? { ...r, ElectionRevision: 2n } : r))
    expect(validateElectionBlocks(input({ rows: revBig }))).to.deep.include({ ok: false, reason: 'mixed-revision' })
    const bad: any[] = [
      { rows: 'x' }, { voterRows: {} }, { ballots: null }, { scope: { electionRevision: 1 } },
      { ballots: [ballotsOpt[0], ballotsOpt[0]] }, { ballots: [{ ...ballotsOpt[0], questions: 'x' }] },
      { release: 5 }, { release: { secretKey: 'x', jointPublicKey: release.jointPublicKey } },
      { registrants: undefined }, { associations: 'x' }, { timeline: undefined }, { timeline: { votingStarts: NaN } }, { timeline: { votingStarts: '0' } }
    ]
    for (const over of bad) expect(validateElectionBlocks(input(over)), JSON.stringify(Object.keys(over))).to.deep.include({ ok: false, reason: 'malformed-input' })
    expect(validateElectionBlocks(null as any)).to.deep.include({ ok: false, reason: 'malformed-input' })
    const skipped = run({ voterRows: [null, ...set.voterRows] })
    expect(skipped.totals.blocks).to.equal(4)
    expect(skipped.blocks.every((b: any) => b.findings.length === 0)).to.equal(true)
  })

  it('VB-9 deterministic for any input order and for bigint columns', () => {
    const a = runR()
    expect(runR()).to.deep.equal(a)
    for (const seed of [1, 2, 3]) {
      expect(runR({ rows: seededShuffle(set.rows, seed), voterRows: seededShuffle(set.voterRows, seed + 10), ballots: seededShuffle(ballotsOpt, seed + 20) })).to.deep.equal(a)
    }
    const big = runR({
      rows: set.rows.map(r => ({ ...r, ElectionRevision: BigInt(r.ElectionRevision), EntryCount: BigInt(r.EntryCount) })),
      voterRows: set.voterRows.map(v => ({ ...v, ElectionRevision: BigInt(v.ElectionRevision) }))
    })
    expect(big).to.deep.equal(a)
  })

  it('VB-10 v:1 clear votes are validated too', () => {
    const e = makeFixtureElection({ ballotIds: ['ballot-a'] })
    const ballot = e.ballots[0]!
    const good = buildVoteEntry({ ballot: ballot.template, electionRevision: FIXTURE_REVISION, selections: { q1: ['a'], q2: ['x'] }, nonce: makeVoteNonce(globalThis.crypto.getRandomValues(new Uint8Array(32))) })
    const badEntry = { ...good, answers: [{ questionCode: 'q1', optionCodes: ['zz'] }, ...good.answers.slice(1)] } as VoteEntry
    const vs = [makeFixtureVoter(e, ballot, 0, { voteEntry: good }), makeFixtureVoter(e, ballot, 1, { voteEntry: badEntry })]
    const fx = makeCommittedBlock(e, ballot, vs, { payloadVersion: 1 })
    const rel = { secretKey: e.electionSecret, jointPublicKey: e.electionKey.jointPublicKey }
    const r: any = validateElectionBlocks({ scope, rows: [fx.row], voterRows: fx.voterRows, ballots: [optional(ballot.template)], ...fixtureAuthorization(vs), release: rel } as any)
    assertTotals(r)
    const b = r.blocks[0]
    expect(b.payloadVersion).to.equal(1)
    expect(b.status).to.equal('valid')
    expect(b.votes.filter((v: any) => v.status === 'valid')).to.have.length(1)
    const inv = b.votes.find((v: any) => v.status === 'invalid')
    expect(inv.codes).to.deep.equal(['unknown-option'])
    expect(r.totals).to.deep.equal({ blocks: 1, entries: 2, valid: 1, invalid: 1, excluded: 0, undecryptable: 0 })
  })

  describe('VB-12 authorization (CR-02): the schema VoterAssociated rule, re-checked', () => {
    const t = (): any => set.blocks[0]!
    const reg0 = (): string => t().voterRows[0]!.RegistrantId
    const key0 = (): string => t().voterRows[0]!.DeviceKey
    const auth = (): any => clone(set.authorization)
    const only = (r: any, codes: string[]): void => {
      const b = bf(r, t().row.Cid)
      expect(b.status).to.equal('invalid')
      expect(codesOf(b)).to.deep.equal(codes)
      expect(b.findings.every((f: any) => f.registrantId === reg0())).to.equal(true)
      for (const o of r.blocks) if (o.blockCid !== t().row.Cid) expect(o.findings, o.blockCid).to.deep.equal([])
    }
    const withRegistrant = (mut: (r: any) => void): any => { const a = auth(); mut(a.registrants.find((r: any) => r.Id === reg0())); return a }
    const withAssociation = (mut: (r: any) => void): any => { const a = auth(); mut(a.associations.find((r: any) => r.RegistrantId === reg0())); return a }

    it('an honest election passes and the reference time is votingStarts', () => {
      expect(run().blocks.every((b: any) => b.findings.length === 0)).to.equal(true)
      expect(Date.parse(FIXTURE_EXPIRATION)).to.be.greaterThan(FIXTURE_VOTING_STARTS)
    })

    it('voter-not-registered: missing, not active, or expired by votingStarts', () => {
      const a = auth()
      a.registrants = a.registrants.filter((r: any) => r.Id !== reg0())
      only(run(a), ['voter-not-registered'])
      for (const status of ['s', 'r', 'A', '']) only(run(withRegistrant(r => { r.Status = status })), ['voter-not-registered'])
      only(run(withRegistrant(r => { r.Expiration = new Date(FIXTURE_VOTING_STARTS).toISOString() })), ['voter-not-registered'])
      only(run(withRegistrant(r => { r.Expiration = '2030-01-01 00:00:00' })), ['voter-not-registered'])
      expect(codesOf(bf(run(withRegistrant(r => { r.Expiration = new Date(FIXTURE_VOTING_STARTS + 1).toISOString() })), t().row.Cid))).to.deep.equal([])
      expect(codesOf(bf(run(withRegistrant(r => { r.Expiration = '2030-01-01T00:00:00.123456Z' })), t().row.Cid))).to.deep.equal([])
    })

    it('device-key-not-associated: missing, another key, or expired by votingStarts', () => {
      const a = auth()
      a.associations = a.associations.filter((r: any) => r.RegistrantId !== reg0())
      only(run(a), ['device-key-not-associated'])
      only(run(withAssociation(r => { r.DeviceKey = makeP256TestKey().pubHex })), ['device-key-not-associated'])
      only(run(withAssociation(r => { r.DeviceKey = key0().toUpperCase() })), ['device-key-not-associated'])
      only(run(withAssociation(r => { r.Expiration = new Date(FIXTURE_VOTING_STARTS - 1).toISOString() })), ['device-key-not-associated'])
      only(run(withAssociation(r => { r.RegistrantId = 'someone-else' })), ['device-key-not-associated'])
      // a later voting start expires every row: every block fails both checks
      const late = run({ timeline: { votingStarts: Date.parse('2031-01-01T00:00:00.000Z') } })
      for (const b of late.blocks) {
        expect(b.status).to.equal('invalid')
        expect([...new Set(codesOf(b))]).to.deep.equal(['voter-not-registered', 'device-key-not-associated'])
      }
    })

    it('a self-certifying block of strangers validates invalid and is never tallied as valid', () => {
      const e = set.election
      const ballot = e.ballots[0]!
      const strangers = [0, 1, 2].map(i => makeFixtureVoter(e, ballot, 100 + i))
      const fake = makeCommittedBlock(e, ballot, strangers)
      const r = runR({ rows: [...set.rows, fake.row], voterRows: [...set.voterRows, ...fake.voterRows] })
      const fb = bf(r, fake.row.Cid)
      expect(fb.status).to.equal('invalid')
      expect([...new Set(codesOf(fb))].sort()).to.deep.equal(['device-key-not-associated', 'voter-not-registered'])
      for (const o of r.blocks) if (o.blockCid !== fake.row.Cid) expect(o.status).to.equal('valid')
      // the same block with its strangers registered is valid: the codes come from the authorization alone
      const ok = runR({ rows: [...set.rows, fake.row], voterRows: [...set.voterRows, ...fake.voterRows], ...fixtureAuthorization([...set.blocks.flatMap(b => b.voters), ...strangers]) })
      expect(bf(ok, fake.row.Cid).status).to.equal('valid')
    })
  })

  describe('VB-13 attribution (CR-03): unauthenticated rows never make an honest block invalid', () => {
    const honest = (): any => set.blocks[0]!
    const flip = (hex: string): string => (hex[0] === '0' ? '1' : '0') + hex.slice(1)

    it('a forged block listing an honest registrant, with no valid consent, leaves the honest block valid', () => {
      const e = set.election
      const ballot = e.ballots[0]!
      const victim = honest().voters[0]!
      const others = [makeFixtureVoter(e, ballot, 200), makeFixtureVoter(e, ballot, 201)]
      // B' names the victim; its voter rows carry no valid consent (signed with a stranger key)
      const forged = makeCommittedBlock(e, ballot, [{ ...victim, pubHex: others[0]!.pubHex, priv: others[0]!.priv } as any, ...others])
      for (const consent of ['stranger-key', 'flipped', 'missing']) {
        const fvr = consent === 'missing'
          ? forged.voterRows.filter((v: any) => v.RegistrantId !== victim.voterEntry.registrantId)
          : consent === 'flipped' ? forged.voterRows.map((v: any) => (v.RegistrantId === victim.voterEntry.registrantId ? { ...v, Signature: flip(v.Signature) } : v)) : forged.voterRows
        const r = runR({ rows: [...set.rows, forged.row], voterRows: [...set.voterRows, ...fvr] })
        expect(bf(r, honest().row.Cid).status, consent).to.equal('valid')
        expect(codesOf(bf(r, honest().row.Cid)), consent).to.deep.equal([])
        const fb = bf(r, forged.row.Cid)
        expect(fb.status, consent).to.equal('invalid')
        expect(codesOf(fb), consent).to.not.include('registrant-in-two-blocks')
      }
    })

    it('extra rows naming the honest block with bad consent are report-level; a forged duplicate that sorts first loses to the row that verifies', () => {
      const b = honest()
      const mine = b.voterRows
      const k = makeP256TestKey()
      const badUnlisted = { ...mine[0]!, RegistrantId: 'stranger', DeviceKey: k.pubHex, Signature: flip(mine[0]!.Signature) }
      // a forged duplicate for a listed registrant whose row key sorts before the honest one ('0' < any hex)
      const badDup = { ...mine[1]!, DeviceKey: `00${mine[1]!.DeviceKey.slice(2)}`, Signature: '00'.repeat(64) }
      const unnamed = { ...mine[2]!, RegistrantId: '' }
      for (const voterRows of [[...set.voterRows, badUnlisted, badDup, unnamed], [badDup, unnamed, badUnlisted, ...set.voterRows]]) {
        const r = runR({ voterRows })
        for (const blk of r.blocks) {
          expect(blk.status).to.equal('valid')
          expect(blk.findings).to.deep.equal([])
        }
        expect(r.findings.map((f: any) => f.code)).to.deep.equal(['voter-row-forged', 'voter-row-forged', 'voter-row-forged'])
        expect(r.findings.every((f: any) => f.blockCid === b.row.Cid && f.severity === 'error')).to.equal(true)
        expect(r.totals.valid).to.equal(13)
      }
    })

    it('with no row that verifies, the best row decides the block finding and the rest are report-level', () => {
      const b = honest()
      const target = b.voterRows[0]!
      const bad1 = { ...target, Signature: flip(target.Signature) }
      const bad2 = { ...target, BlockId: 'other', Signature: '11'.repeat(64) }
      const voterRows = [...set.voterRows.filter(v => v !== target), bad2, bad1]
      const r = run({ voterRows })
      expect(codesOf(bf(r, b.row.Cid))).to.deep.equal(['consent-signature-invalid'])
      expect(r.findings.map((f: any) => f.code)).to.deep.equal(['voter-row-forged'])
    })
  })

  it('VB-14 (IN-07) a non-canonical decrypted vote is flagged (info) and still judged; a non-JSON one names the parse failure', () => {
    const e = makeFixtureElection({ ballotIds: ['ballot-a'] })
    const ballot = e.ballots[0]!
    const plain = [0, 1, 2].map(i => makeFixtureVoter(e, ballot, i))
    const v1 = plain[1]!
    const loose = encryptVoteEntry(e.electionKey, 'ballot-a', JSON.stringify(v1.voteEntry, null, 1))
    const v2 = plain[2]!
    const notJson = encryptVoteEntry(e.electionKey, 'ballot-a', '{"v":1,')
    const voters = [
      plain[0]!,
      { ...v1, voteCiphertext: loose, contribution: { ...v1.contribution, voteCiphertext: loose } },
      { ...v2, voteCiphertext: notJson, contribution: { ...v2.contribution, voteCiphertext: notJson } }
    ]
    const fx = makeCommittedBlock(e, ballot, voters)
    const r: any = validateElectionBlocks({
      scope, rows: [fx.row], voterRows: fx.voterRows, ballots: [optional(ballot.template)], ...fixtureAuthorization(voters),
      release: { secretKey: e.electionSecret, jointPublicKey: e.electionKey.jointPublicKey }
    } as any)
    assertTotals(r)
    const b = r.blocks[0]
    expect(b.status).to.equal('valid')
    const flagged = b.findings.filter((f: any) => f.code === 'vote-not-canonical')
    expect(flagged).to.have.length(1)
    expect(flagged[0]).to.deep.include({ severity: 'info' })
    expect(b.votes.find((v: any) => v.index === flagged[0].voteIndex).status).to.equal('valid')
    const nj = b.findings.find((f: any) => f.code === 'vote-not-json')
    expect(nj.detail).to.match(/^a decrypted vote is not JSON: /)
    expect(r.totals).to.include({ valid: 2, invalid: 1 })
  })

  it('VB-11 finding order inside a block is fixed', () => {
    const t = set.blocks[0]!
    const mine = set.voterRows.filter(v => v.BlockCid === t.row.Cid)
    const rows = set.rows.map(r => (r === t.row ? { ...r, TemplateDigest: 'changed' } : r))
    const voterRows = set.voterRows.map(v => (v === mine[0] ? { ...v, Signature: (v.Signature[0] === '0' ? '1' : '0') + v.Signature.slice(1) } : v))
    const c = codesOf(bf(run({ rows, voterRows }), t.row.Cid))
    expect(c).to.deep.equal(['template-mismatch', 'consent-signature-invalid'])
  })
})
