// answer-checks.ts — is one decrypted vote entry a legal answer to its ballot template? (65-07, R7, D-71)
//
// Role:
//   - Used by the R7 block validation and, through its per-vote verdicts, by the R8 tally. It accepts exactly
//     what buildVoteEntry can produce, plus the D-71 minimum that buildVoteEntry does not check.
//
// D-71 policy:
//   - An answer with fewer options than optionRange.min, more than the cap, an unknown question or option, a
//     repeated or unsorted code, or a malformed entry makes the vote INVALID. Invalid votes are counted apart
//     from valid ones.
//   - A blank answer to a required question is VALID and reported as an info finding. `required` defaults to
//     true (vote-core Question model) and is not bound by the template digest.
//
// D-81: a VoteAnswer holds a sorted, de-duplicated option set. Rank, score and text answers cannot be
// represented faithfully, so an answered question whose type is not select is reported with the info finding
// unsupported-question-type; the structural checks still apply to it.
//
// dependsOn is not evaluated: no expression evaluator exists. The template digest binds it, but nothing judges it.
//
// Ordering uses the same UTF-16 comparator as buildVoteEntry (the producer's order), not UTF-8 bytes.
//
// Rules: findings are collected, not first-failure; every failure is a typed value and the module never
// throws. The inputs are never modified. Pure for Hermes and the browser: noble-backed relative imports only,
// no Node-only globals, no logging, no clock, no randomness.

import { ballotTemplateDigest, VOTE_ENTRY_KEYS, type TemplateBallot, type VoteEntry } from '../voting/vote-entries.js'

export const ANSWER_FINDING_CODES = Object.freeze([
  'malformed-ballot', 'malformed-entry', 'wrong-election', 'wrong-revision', 'wrong-ballot', 'template-digest-mismatch',
  'bad-nonce', 'answers-not-sorted', 'duplicate-question', 'unknown-question', 'empty-answer', 'unknown-option',
  'duplicate-option', 'options-not-sorted', 'too-many-options', 'below-minimum',
  'blank-required', 'unsupported-question-type'
] as const)

export type AnswerFindingCode = typeof ANSWER_FINDING_CODES[number]

/** Severity 'info' exactly for these; every other code is 'error'. */
export const ANSWER_INFO_CODES = Object.freeze(['blank-required', 'unsupported-question-type'] as const)

export type FindingSeverity = 'error' | 'info'

export interface AnswerFinding {
  code: AnswerFindingCode
  severity: FindingSeverity
  detail: string
  questionCode?: string
  optionCode?: string
}

/** A TemplateBallot question plus the (digest-unbound) `required` flag; vote-core's Question fits structurally. */
export type AnswerCheckQuestion = TemplateBallot['questions'][number] & { required?: boolean }
export type AnswerCheckBallot = Omit<TemplateBallot, 'questions'> & { questions: AnswerCheckQuestion[] }

export interface AnswerCheckScope {
  electionId: string
  electionRevision: number
  ballotId: string
  /** expected template digest; defaults to ballotTemplateDigest(ballot, electionRevision) */
  templateDigest?: string
}

/** Per-vote validity (D-71). The R8 tally counts only `valid: true` entries and counts the rest as invalid. */
export type VoteEntryValidity =
  | { valid: true, entry: VoteEntry, findings: readonly AnswerFinding[] }
  | { valid: false, findings: readonly AnswerFinding[] }

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

function sameKeys (obj: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(obj).sort(byString)
  return keys.length === expected.length && keys.every((k, i) => k === expected[i])
}

function finding (code: AnswerFindingCode, detail: string, extra: { questionCode?: string, optionCode?: string } = {}): AnswerFinding {
  const severity: FindingSeverity = (ANSWER_INFO_CODES as readonly string[]).includes(code) ? 'info' : 'error'
  return { code, severity, detail, ...extra }
}

/**
 * IN-03: the one rule R7 and R8 share for a question's type. An absent or null type is 'select'; a string is
 * itself; any other value is unreadable (null), which makes the ballot malformed in both modules.
 */
export function questionType (question: unknown): string | null {
  if (!isRecord(question)) return null
  const t = question.type
  if (t === undefined || t === null) return 'select'
  return typeof t === 'string' ? t : null
}

function ballotReadable (ballot: unknown): ballot is AnswerCheckBallot {
  if (!isRecord(ballot) || typeof ballot.id !== 'string' || !Array.isArray(ballot.questions)) return false
  return ballot.questions.every(q =>
    isRecord(q) && typeof q.code === 'string' && Array.isArray(q.options) && questionType(q) !== null &&
    q.options.every(o => isRecord(o) && typeof o.code === 'string')
  )
}

/** Why the entry is not shaped like a VoteEntry, or null when it is. */
function entryShapeProblem (entry: unknown): string | null {
  if (!isRecord(entry)) return 'the vote entry is not an object'
  if (!sameKeys(entry, VOTE_ENTRY_KEYS)) return 'the vote entry does not have exactly the vote entry fields'
  if (entry.v !== 1) return 'the vote entry version is not 1'
  for (const k of ['electionId', 'ballotId', 'templateDigest', 'nonce'] as const) {
    if (typeof entry[k] !== 'string') return `the vote entry field ${k} is not a string`
  }
  if (typeof entry.electionRevision !== 'number' || !Number.isSafeInteger(entry.electionRevision)) {
    return 'the vote entry electionRevision is not a safe integer'
  }
  if (!Array.isArray(entry.answers)) return 'the vote entry answers is not an array'
  for (const a of entry.answers) {
    if (!isRecord(a) || !sameKeys(a, ['optionCodes', 'questionCode'])) return 'an answer does not have exactly questionCode and optionCodes'
    if (typeof a.questionCode !== 'string') return 'an answer questionCode is not a string'
    if (!Array.isArray(a.optionCodes) || !a.optionCodes.every(c => typeof c === 'string')) return 'an answer optionCodes is not an array of strings'
  }
  return null
}

/** Judge one decrypted vote entry against its ballot template. Collects every defect; never throws. */
export function validateVoteEntryAgainstBallot (entry: unknown, ballot: AnswerCheckBallot, scope: AnswerCheckScope): VoteEntryValidity {
  const bad = (f: AnswerFinding): VoteEntryValidity => ({ valid: false, findings: [f] })
  if (!ballotReadable(ballot)) return bad(finding('malformed-ballot', 'the ballot template is not readable'))
  const problem = entryShapeProblem(entry)
  if (problem !== null) return bad(finding('malformed-entry', problem))
  const e = entry as VoteEntry
  const findings: AnswerFinding[] = []

  if (e.electionId !== scope.electionId) findings.push(finding('wrong-election', 'the vote entry names another election'))
  if (e.electionRevision !== scope.electionRevision) findings.push(finding('wrong-revision', 'the vote entry names another election revision'))
  if (e.ballotId !== scope.ballotId) findings.push(finding('wrong-ballot', 'the vote entry names another ballot'))
  let expectedDigest: string
  if (typeof scope.templateDigest === 'string') {
    expectedDigest = scope.templateDigest
  } else {
    try {
      expectedDigest = ballotTemplateDigest(ballot, scope.electionRevision)
    } catch {
      return bad(finding('malformed-ballot', 'the ballot template digest cannot be computed'))
    }
  }
  if (e.templateDigest !== expectedDigest) findings.push(finding('template-digest-mismatch', 'the vote entry names another ballot template'))
  if (!/^[0-9a-f]{64}$/.test(e.nonce)) findings.push(finding('bad-nonce', 'the vote nonce is not 64 lowercase hex characters'))

  const questions = new Map<string, AnswerCheckQuestion>()
  for (const q of ballot.questions) if (!questions.has(q.code)) questions.set(q.code, q)
  const answered = new Set<string>()
  let previous: string | null = null
  for (const answer of e.answers) {
    const qc = answer.questionCode
    answered.add(qc)
    if (previous !== null) {
      const order = byString(previous, qc)
      if (order === 0) findings.push(finding('duplicate-question', `the question ${qc} is answered twice`, { questionCode: qc }))
      else if (order > 0) findings.push(finding('answers-not-sorted', `the answer to ${qc} is out of order`, { questionCode: qc }))
    }
    previous = qc
    const q = questions.get(qc)
    if (q === undefined) {
      findings.push(finding('unknown-question', `the ballot has no question ${qc}`, { questionCode: qc }))
      continue
    }
    const chosen = answer.optionCodes
    if (chosen.length === 0) {
      findings.push(finding('empty-answer', `the answer to ${qc} has no options; a blank is absent`, { questionCode: qc }))
      continue
    }
    const distinct = new Set(chosen)
    if (distinct.size !== chosen.length) {
      findings.push(finding('duplicate-option', `the answer to ${qc} repeats an option`, { questionCode: qc }))
    } else if (!chosen.every((c, i) => i === 0 || byString(chosen[i - 1]!, c) < 0)) {
      findings.push(finding('options-not-sorted', `the options of the answer to ${qc} are not in ascending order`, { questionCode: qc }))
    }
    const known = new Set(q.options.map(o => o.code))
    for (const c of distinct) {
      if (!known.has(c)) findings.push(finding('unknown-option', `the question ${qc} has no option ${c}`, { questionCode: qc, optionCode: c }))
    }
    const range = isRecord(q.optionRange) ? q.optionRange : undefined
    const max = typeof range?.max === 'number' ? range.max : 1
    const min = typeof range?.min === 'number' ? range.min : 1
    const cap = Math.max(1, max)
    if (distinct.size > cap) {
      findings.push(finding('too-many-options', `the answer to ${qc} has ${distinct.size} options; at most ${cap} are allowed`, { questionCode: qc }))
    }
    if (distinct.size < min) {
      findings.push(finding('below-minimum', `the answer to ${qc} has ${distinct.size} options; at least ${min} are required`, { questionCode: qc }))
    }
    if (questionType(q) !== 'select') {
      findings.push(finding('unsupported-question-type', `the question ${qc} is not a select question; its answer is counted as a set of options`, { questionCode: qc }))
    }
  }

  for (const q of ballot.questions) {
    if (answered.has(q.code) || q.required === false) continue
    answered.add(q.code)
    findings.push(finding('blank-required', `the required question ${q.code} is blank`, { questionCode: q.code }))
  }

  return findings.some(f => f.severity === 'error')
    ? { valid: false, findings }
    : { valid: true, entry: e, findings }
}
