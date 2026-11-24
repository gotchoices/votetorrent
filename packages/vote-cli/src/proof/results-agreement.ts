// results-agreement.ts: the results read every peer makes (phase 67 plan 30), and the agreement object the
// ctl spec compares across the officer, the keyholders and the voters. Replaces tools/lean-rig/lean/lean-part2.ts
// legRelease X3 (1330-1371: the same tally root on the officer and a keyholder within 120 s) and X5 (1407-1420:
// the voters' read) with the shared `readElectionResults` (the Voter Results screen's read), the opened-set
// check and a canonical agreement hash. Option codes never appear: counts are a sorted multiset plus
// `countsSha256`. No console, no process.env, no instanceof.

import { ElectionResultsEngine, ElectionsEngine, TallyPublicationEngine } from '@votetorrent/vote-engine/rn'
import type { EngineContext } from '@votetorrent/vote-engine/rn'
import { readElectionResults, type ElectionResultsRead } from '@votetorrent/workflows/voter'
import type { SecretRegistry } from '../secrecy/redact.js'
import { readPrivateFile } from '../vault/private-file.js'
import { checkOpenedSet, DEFAULT_OPENED_SET_SEAMS, engineCountMap, readChoiceFiles, sha256Hex, type OpenedEntry, type OpenedSetCheck, type OpenedSetSeams, type TalliedResults } from './opened-set-check.js'

export class ResultsAgreementError extends Error {
  readonly code: string

  constructor (code: string) {
    super(`results refused (${code})`)
    this.name = 'VerbRefusal'
    this.code = code
  }
}

export const RESULTS_POLL_MS = 5000
export const RESULTS_WAIT_MAX_MS = 600000
export const NEEDLE_FILE_MAX_BYTES = 4096

/** The three engines the shared results read asks for, built as both apps' engine factories build them. */
export function resultsEngines (est: EngineContext): <T>(engineName: string) => Promise<T> {
  const engines = new Map<string, unknown>()
  return async <T>(name: string): Promise<T> => {
    let engine = engines.get(name)
    if (engine === undefined) {
      if (name === 'elections') engine = new ElectionsEngine(est)
      else if (name === 'electionResults') engine = new ElectionResultsEngine(est)
      else if (name === 'tallyPublication') engine = new TallyPublicationEngine(est)
      else throw new ResultsAgreementError('engine-unknown')
      engines.set(name, engine)
    }
    return engine as T
  }
}

/** The field paths every peer must agree on, compared one by one by `diffAgreement`. */
export const AGREEMENT_FIELDS = Object.freeze([
  'electionId',
  'revision',
  'status',
  'tallyRoot',
  'blockRoot',
  'blockCount',
  'totals.valid',
  'totals.invalid',
  'totals.excluded',
  'ballots[].ballotId',
  'ballots[].votes',
  'ballots[].valid',
  'ballots[].invalid',
  'ballots[].excluded',
  'countsSha256',
  'openedSetSha256',
  'publication.found',
  'publication.signatureValid',
  'publication.treeOk',
  'publication.matchesRecomputed'
] as const)

export interface AgreementBallot {
  ballotId: string
  votes: number
  valid: number
  invalid: number
  excluded: number
}

export interface AgreementPublication {
  found: boolean
  signatureValid: boolean
  treeOk: boolean
  matchesRecomputed: boolean
}

export interface AgreementFields {
  electionId: string
  revision: number
  status: 'tallied'
  tallyRoot: string
  blockRoot: string
  blockCount: number
  totals: { valid: number, invalid: number, excluded: number }
  ballots: AgreementBallot[]
  countsSha256: string
  openedSetSha256: string
  publication: AgreementPublication
}

export interface Agreement {
  fields: AgreementFields
  agreementSha256: string
}

/** JSON with every object's keys sorted, so equal values hash equal. */
export function canonicalJson (value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}'
  }
  return JSON.stringify(value)
}

/** The publication flags, read from the engine object by identity and never defaulted to true. */
export function publicationFlags (publication: ElectionResultsRead['publication']): AgreementPublication {
  const found = publication !== null && publication !== 'unknown'
  if (!found) return { found: false, signatureValid: false, treeOk: false, matchesRecomputed: false }
  const p = publication as { signatureValid?: unknown, treeCheck?: { ok?: unknown }, matchesRecomputed?: unknown }
  return {
    found: true,
    signatureValid: p.signatureValid === true,
    treeOk: p.treeCheck?.ok === true,
    matchesRecomputed: p.matchesRecomputed === true
  }
}

function talliedOf (read: ElectionResultsRead): TalliedResults & { tallyRoot: string, blockRoot: string, blockCount: number } {
  const r = read.results as unknown as { status: string }
  if (r.status !== 'tallied') throw new ResultsAgreementError('results-' + r.status)
  return read.results as unknown as TalliedResults & { tallyRoot: string, blockRoot: string, blockCount: number }
}

/** The per-option count hash: sha256 of the canonical JSON of the sorted `[key, count]` pairs. */
export function countsSha256Of (results: TalliedResults): string {
  const pairs = [...engineCountMap(results).entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return sha256Hex(canonicalJson(pairs))
}

/** The sorted multiset of per-option counts (no option codes). */
export function countsMultiset (results: TalliedResults): number[] {
  return [...engineCountMap(results).values()].sort((a, b) => a - b)
}

export function agreementOf (read: ElectionResultsRead, opened: Pick<OpenedSetCheck, 'openedSetSha256'>): Agreement {
  const r = talliedOf(read)
  const ballots: AgreementBallot[] = r.ballots
    .map((b) => ({ ballotId: b.ballotId, votes: b.votes, valid: b.valid, invalid: b.invalid, excluded: b.excluded }))
    .sort((a, b) => (a.ballotId < b.ballotId ? -1 : a.ballotId > b.ballotId ? 1 : 0))
  const fields: AgreementFields = {
    electionId: r.electionId,
    revision: r.revision,
    status: 'tallied',
    tallyRoot: r.tallyRoot,
    blockRoot: r.blockRoot,
    blockCount: r.blockCount,
    totals: { valid: r.totals.valid, invalid: r.totals.invalid, excluded: r.totals.excluded },
    ballots,
    countsSha256: countsSha256Of(r),
    openedSetSha256: opened.openedSetSha256,
    publication: publicationFlags(read.publication)
  }
  return { fields, agreementSha256: sha256Hex(canonicalJson(fields)) }
}

function fieldValue (fields: AgreementFields, path: string): unknown {
  if (path.startsWith('ballots[].')) {
    const member = path.slice('ballots[].'.length) as keyof AgreementBallot
    return fields.ballots.map((b) => b[member])
  }
  let cur: unknown = fields
  for (const part of path.split('.')) cur = (cur as Record<string, unknown> | undefined)?.[part]
  return cur
}

/** The `AGREEMENT_FIELDS` paths whose values differ between two agreements (empty when they agree). */
export function diffAgreement (a: Agreement, b: Agreement): string[] {
  return AGREEMENT_FIELDS.filter((path) => canonicalJson(fieldValue(a.fields, path)) !== canonicalJson(fieldValue(b.fields, path)))
}

export interface ReadAgreedResultsInput {
  getEngine: <T>(engineName: string) => Promise<T>
  est: EngineContext
  electionId: string
  waitMs: number
  requirePublished: boolean
  expected?: OpenedEntry[]
  needle?: string
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  seams?: OpenedSetSeams
}

export interface AgreedResults {
  read: ElectionResultsRead
  opened: OpenedSetCheck
  agreement: Agreement
  polls: number
  waitedMs: number
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Poll the shared results read every 5 s until the election is `tallied` (and, with `requirePublished`, its
 * publication is found with a valid signature, a consistent tree and matching roots), or until `waitMs` has
 * elapsed; then run the opened-set check and build the agreement.
 */
export async function readAgreedResults (input: ReadAgreedResultsInput): Promise<AgreedResults> {
  const now = input.now ?? (() => Date.now())
  const sleep = input.sleep ?? defaultSleep
  const started = now()
  let polls = 0
  let read: ElectionResultsRead
  for (;;) {
    polls++
    read = await readElectionResults({ getEngine: input.getEngine, fallbackElectionId: undefined })
    const r = read.results as unknown as { status: string, electionId: string, reason?: string }
    if (r.status !== 'no-election' && r.electionId !== input.electionId) throw new ResultsAgreementError('election-mismatch')
    const published = publicationFlags(read.publication)
    const verified = published.found && published.signatureValid && published.treeOk && published.matchesRecomputed
    if (r.status === 'tallied' && (!input.requirePublished || verified)) break
    const waited = now() - started
    if (waited >= input.waitMs) {
      if (r.status === 'unavailable') throw new ResultsAgreementError(`results-unavailable:${String(r.reason)}`)
      if (r.status !== 'tallied') throw new ResultsAgreementError(`results-${r.status}`)
      throw new ResultsAgreementError('publication-unverified')
    }
    await sleep(Math.min(RESULTS_POLL_MS, input.waitMs - waited))
  }
  const opened = await checkOpenedSet(
    { est: input.est, electionId: input.electionId, results: read.results as unknown as TalliedResults, ...(input.expected === undefined ? {} : { expected: input.expected }), ...(input.needle === undefined ? {} : { needle: input.needle }) },
    input.seams ?? DEFAULT_OPENED_SET_SEAMS
  )
  const agreement = agreementOf(read, opened)
  return { read, opened, agreement, polls, waitedMs: now() - started }
}

// ---------------------------------------------------------------------------------------------
// The shared `results` verb arguments and reply (the voter, officer and keyholder verbs call these)

export interface ResultsArgs {
  waitMs: number
  requirePublished: boolean
  expected: OpenedEntry[] | undefined
  needle: string | undefined
}

/**
 * Parse the results verb's optional arguments: `waitMs` (digits 0..600000, default 0), `requirePublished`
 * (a bare flag or 'true'), `expectedFiles` (comma list of up to 16 absolute paths) and `needleFile` (an
 * absolute 0600 file whose trimmed text is registered windowed). `refuse(code)` is the verb's own refusal.
 */
export function parseResultsArgs (a: Record<string, unknown>, secrets: SecretRegistry, refuse: (code: string) => never): ResultsArgs {
  let waitMs = 0
  if (a.waitMs !== undefined) {
    if (typeof a.waitMs !== 'string' || !/^\d{1,7}$/.test(a.waitMs) || Number(a.waitMs) > RESULTS_WAIT_MAX_MS) refuse('wait-invalid')
    waitMs = Number(a.waitMs)
  }
  let requirePublished = false
  if (a.requirePublished !== undefined) {
    if (a.requirePublished !== true && a.requirePublished !== 'true') refuse('bad-arg')
    requirePublished = true
  }
  let expected: OpenedEntry[] | undefined
  if (a.expectedFiles !== undefined) {
    if (typeof a.expectedFiles !== 'string' || a.expectedFiles.length === 0) refuse('expected-file-invalid')
    const paths = a.expectedFiles.split(',').map((p) => p.trim())
    try {
      expected = readChoiceFiles(paths, secrets)
    } catch (e) {
      refuse(String((e as { code?: unknown } | null)?.code ?? 'expected-file-invalid'))
    }
  }
  let needle: string | undefined
  if (a.needleFile !== undefined) {
    if (typeof a.needleFile !== 'string' || a.needleFile.length === 0 || a.needleFile[0] !== '/') refuse('needle-file-invalid')
    let data: Buffer | null = null
    try {
      data = readPrivateFile(a.needleFile, { maxBytes: NEEDLE_FILE_MAX_BYTES })
    } catch {
      refuse('needle-file-invalid')
    }
    if (data === null) refuse('needle-file-invalid')
    needle = (data as Buffer).toString('utf8').trim()
    ;(data as Buffer).fill(0)
    if (needle.length === 0) refuse('needle-file-invalid')
    secrets.add(needle, { windows: true })
  }
  return { waitMs, requirePublished, expected, needle }
}

/** The results reply, identical on every role: ids, counts, booleans, 8-char root prefixes, hashes and timings. */
export function resultsReply (r: AgreedResults, electionId: string, ms: number): Record<string, unknown> {
  const f = r.agreement.fields
  return {
    electionId,
    revision: f.revision,
    status: f.status,
    blockCount: f.blockCount,
    valid: f.totals.valid,
    invalid: f.totals.invalid,
    excluded: f.totals.excluded,
    counts: countsMultiset(r.read.results as unknown as TalliedResults),
    tallyRoot8: f.tallyRoot.slice(0, 8),
    blockRoot8: f.blockRoot.slice(0, 8),
    publication: f.publication,
    openedCount: r.opened.openedCount,
    expectedMatch: r.opened.expectedMatch,
    needleInOpened: r.opened.needleInOpened,
    agreementSha256: r.agreement.agreementSha256,
    polls: r.polls,
    waitedMs: r.waitedMs,
    ms
  }
}
