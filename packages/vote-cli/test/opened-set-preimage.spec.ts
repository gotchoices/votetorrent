// opened-set-preimage.spec.ts: the vote-cli copy of the opened-set preimage is pinned to the in-app probe's
// scripts copy (phase 67 plan 30, discretion choice 1): byte-equal after comment stripping and whitespace
// collapsing, equal output on six fixture sets, permutation-invariant, sensitive to one changed option code,
// a TypeError('opened-set-shape') on malformed input, and import-free.
import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openedSetPreimage, type OpenedEntry } from '../src/proof/opened-set-preimage.js'
import { openedSetPreimage as scriptsOpenedSetPreimage } from '../../../scripts/proof/opened-set-preimage.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI_COPY = resolve(HERE, '../src/proof/opened-set-preimage.ts')
const SCRIPTS_COPY = resolve(HERE, '../../../scripts/proof/opened-set-preimage.ts')

const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const collapse = (src: string): string => strip(src).replace(/\s+/g, '')

const FIXTURES: OpenedEntry[][] = [
  [],
  [{ ballotId: 'b-1', answers: [{ questionCode: 'q1', optionCodes: ['x'] }] }],
  [{ ballotId: 'b-1', answers: [{ questionCode: 'q2', optionCodes: ['y', 'x'] }, { questionCode: 'q1', optionCodes: [] }] }],
  [
    { ballotId: 'b-2', answers: [{ questionCode: 'q1', optionCodes: ['vt-needle-0123456789'] }] },
    { ballotId: 'b-1', answers: [{ questionCode: 'q1', optionCodes: ['vt-opt-b'] }] },
    { ballotId: 'b-1', answers: [{ questionCode: 'q1', optionCodes: ['vt-needle-0123456789'] }] }
  ],
  [{ ballotId: 'ballot-election-1700000000000-1', answers: [{ questionCode: 'vt-q1', optionCodes: ['vt-opt-b'] }] }],
  [
    { ballotId: 'b-1', answers: [{ questionCode: 'q1', optionCodes: ['a', 'b', 'c'] }, { questionCode: 'q0', optionCodes: ['z'] }] },
    { ballotId: 'b-1', answers: [{ questionCode: 'q0', optionCodes: ['z'] }, { questionCode: 'q1', optionCodes: ['c', 'a', 'b'] }] }
  ]
]

describe('opened-set preimage', () => {
  it('the comment-stripped, whitespace-collapsed body equals the scripts copy', () => {
    expect(collapse(readFileSync(CLI_COPY, 'utf8'))).to.equal(collapse(readFileSync(SCRIPTS_COPY, 'utf8')))
  })

  it('both copies produce identical strings on six fixture sets', () => {
    for (const f of FIXTURES) expect(openedSetPreimage(f)).to.equal(scriptsOpenedSetPreimage(f))
    expect(new Set(FIXTURES.map((f) => openedSetPreimage(f))).size).to.equal(FIXTURES.length)
  })

  it('permuting entries, answers or option codes leaves the hash unchanged', () => {
    const base = FIXTURES[3]!
    const permuted: OpenedEntry[] = [base[2]!, base[0]!, base[1]!].map((e) => ({ ballotId: e.ballotId, answers: e.answers.slice().reverse().map((a) => ({ questionCode: a.questionCode, optionCodes: a.optionCodes.slice().reverse() })) }))
    expect(openedSetPreimage(permuted)).to.equal(openedSetPreimage(base))
    const multi = FIXTURES[5]!
    expect(openedSetPreimage([multi[1]!, multi[0]!])).to.equal(openedSetPreimage(multi))
  })

  it('one changed option code changes it', () => {
    const base = FIXTURES[1]!
    const changed: OpenedEntry[] = [{ ballotId: 'b-1', answers: [{ questionCode: 'q1', optionCodes: ['y'] }] }]
    expect(openedSetPreimage(changed)).to.not.equal(openedSetPreimage(base))
    expect(openedSetPreimage([{ ballotId: 'b-1', answers: [{ questionCode: 'q1', optionCodes: ['x', 'x'] }] }])).to.not.equal(openedSetPreimage(base))
  })

  it('malformed input throws TypeError(opened-set-shape)', () => {
    for (const bad of [undefined, null, 'x', {}, [{ ballotId: 1, answers: [] }], [{ ballotId: 'b', answers: [{ questionCode: 'q', optionCodes: [1] }] }], [{ ballotId: 'b' }]]) {
      let caught: unknown
      try {
        openedSetPreimage(bad as never)
      } catch (e) {
        caught = e
      }
      expect(caught).to.be.instanceOf(TypeError)
      expect((caught as Error).message).to.equal('opened-set-shape')
    }
  })

  it('the vote-cli copy has no import line', () => {
    const lines = readFileSync(CLI_COPY, 'utf8').split('\n')
    expect(lines.filter((l) => /^import\b/.test(l))).to.deep.equal([])
    expect(lines.filter((l) => /^export function openedSetPreimage\b/.test(l))).to.have.length(1)
  })
})
