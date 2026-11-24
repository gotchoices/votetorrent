// opened-set-check.ts: the opened-set preimage check every `tally` and `results` call runs (phase 67 plan 30).
// Replaces tools/lean-rig/lean/lean-part2.ts legRelease X1 (1295-1328) and the per-option comparison of X3
// (1330-1371): reconstruct the election key from the PUBLIC released shares, open every VoteBlock and every
// vote entry, hash `openedSetPreimage` of the projected entries, and require zero open failures, per-option
// counts equal to the engine's tally and, with expected files, the same preimage hash as the voters' choice
// files. The reconstructed secret is zero-filled in a finally; option codes are never returned. No console,
// no process.env, no instanceof.

import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { KeyReleaseEngine, openElectionBlock, openVoteEntries } from '@votetorrent/vote-engine/rn'
import type { EngineContext } from '@votetorrent/vote-engine/rn'
import type { SecretRegistry } from '../secrecy/redact.js'
import { readPrivateFile } from '../vault/private-file.js'
import { openedSetPreimage, type OpenedEntry } from './opened-set-preimage.js'

export type { OpenedAnswer, OpenedEntry } from './opened-set-preimage.js'

/** `name` is 67-26's `VerbRefusal`, so the ctl error view and the client treat it like every verb refusal. */
export class OpenedSetError extends Error {
  readonly code: string

  constructor (code: string) {
    super(`opened set refused (${code})`)
    this.name = 'VerbRefusal'
    this.code = code
  }
}

export const EXPECTED_FILE_MAX_BYTES = 65536
export const EXPECTED_FILES_MAX = 16

const BLOCK_SQL = 'select Id, BallotId, Ciphertext from VoteBlock where ElectionId = :electionId and ElectionRevision = :revision'

export function sha256Hex (text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * The voters' choice files: each an absolute, 0600, owner-owned regular file of at most 64 KiB whose JSON is an
 * array `openedSetPreimage` accepts (the `cast` verb's projection). Every text is registered windowed before
 * anything else sees it. Anything else is `expected-file-invalid`; the refusal never names a path.
 */
export function readChoiceFiles (paths: readonly string[], secrets: SecretRegistry): OpenedEntry[] {
  if (paths.length > EXPECTED_FILES_MAX) throw new OpenedSetError('expected-file-invalid')
  const out: OpenedEntry[] = []
  for (const path of paths) {
    if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path)) throw new OpenedSetError('expected-file-invalid')
    let data: Buffer | null
    try {
      data = readPrivateFile(path, { maxBytes: EXPECTED_FILE_MAX_BYTES })
    } catch {
      throw new OpenedSetError('expected-file-invalid')
    }
    if (data === null) throw new OpenedSetError('expected-file-invalid')
    const text = data.toString('utf8')
    data.fill(0)
    secrets.add(text, { windows: true })
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new OpenedSetError('expected-file-invalid')
    }
    if (!Array.isArray(parsed)) throw new OpenedSetError('expected-file-invalid')
    try {
      openedSetPreimage(parsed as OpenedEntry[])
    } catch {
      throw new OpenedSetError('expected-file-invalid')
    }
    for (const entry of parsed as OpenedEntry[]) out.push(entry)
  }
  return out
}

/** The engine's `tallied` result, as far as the check reads it (structural, so a fake fits). */
export interface TalliedResults {
  status: 'tallied'
  electionId: string
  revision: number
  totals: { valid: number, invalid: number, excluded: number }
  ballots: Array<{ ballotId: string, votes: number, valid: number, invalid: number, excluded: number, questions: Array<{ code: string, options: Array<{ code: string, count: number }> }> }>
}

export interface OpenedSetCheckInput {
  est: EngineContext
  electionId: string
  results: TalliedResults
  /** The voters' choice files' entries (`readChoiceFiles`); absent skips the hash comparison. */
  expected?: OpenedEntry[]
  /** The ballot needle; absent skips the needle check. */
  needle?: string
}

export interface OpenedSetCheck {
  openedCount: number
  openFailures: 0
  openedSetSha256: string
  expectedChecked: boolean
  /** true when checked; null when no expected files were given */
  expectedMatch: boolean | null
  /** true when checked; null when no needle was given */
  needleInOpened: boolean | null
  decryptMs: number
}

/** The reconstruct and open calls, injectable by the unit spec (the verbs use the vote-engine defaults). */
export interface OpenedSetSeams {
  keyRelease: (est: EngineContext) => { reconstructElectionKey(electionId: string): Promise<{ secretKey: Uint8Array, revision: number, jointPublicKey: string }> }
  openBlock: typeof openElectionBlock
  openEntries: typeof openVoteEntries
  now: () => number
}

export const DEFAULT_OPENED_SET_SEAMS: OpenedSetSeams = Object.freeze({
  keyRelease: (est: EngineContext) => new KeyReleaseEngine(est),
  openBlock: openElectionBlock,
  openEntries: openVoteEntries,
  now: () => Date.now()
})

function isEntryShape (v: unknown): v is OpenedEntry {
  const e = v as { ballotId?: unknown, answers?: unknown } | null
  return e !== null && typeof e === 'object' && typeof e.ballotId === 'string' && Array.isArray(e.answers) &&
    e.answers.every((a) => a !== null && typeof a === 'object' && typeof (a as { questionCode?: unknown }).questionCode === 'string' &&
      Array.isArray((a as { optionCodes?: unknown }).optionCodes) && ((a as { optionCodes: unknown[] }).optionCodes).every((c) => typeof c === 'string'))
}

/** The engine's per-option counts, keyed `ballotId/questionCode/optionCode`, zero counts dropped. */
export function engineCountMap (results: TalliedResults): Map<string, number> {
  const out = new Map<string, number>()
  for (const b of results.ballots) for (const q of b.questions) for (const o of q.options) if (o.count > 0) out.set(`${b.ballotId}/${q.code}/${o.code}`, o.count)
  return out
}

function countMapOf (entries: readonly OpenedEntry[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const e of entries) for (const a of e.answers) for (const c of a.optionCodes) {
    const k = `${e.ballotId}/${a.questionCode}/${c}`
    out.set(k, (out.get(k) ?? 0) + 1)
  }
  return out
}

function sameCounts (a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

export async function checkOpenedSet (input: OpenedSetCheckInput, seams: OpenedSetSeams = DEFAULT_OPENED_SET_SEAMS): Promise<OpenedSetCheck> {
  const t0 = seams.now()
  const { est, electionId, results } = input
  let recon: { secretKey: Uint8Array, revision: number, jointPublicKey: string }
  try {
    recon = await seams.keyRelease(est).reconstructElectionKey(electionId)
  } catch {
    throw new OpenedSetError('key-not-reconstructable')
  }
  const projected: OpenedEntry[] = []
  let openFailures = 0
  try {
    const ek = { electionId, revision: recon.revision, jointPublicKey: recon.jointPublicKey }
    const rows: Array<{ Id: unknown, BallotId: unknown, Ciphertext: unknown }> = []
    for await (const row of est.db.eval(BLOCK_SQL, { electionId, revision: recon.revision })) rows.push(row as { Id: unknown, BallotId: unknown, Ciphertext: unknown })
    for (const row of rows) {
      const opened = seams.openBlock(recon.secretKey, ek, { blockId: String(row.Id), ciphertext: row.Ciphertext })
      if (!opened.ok) {
        openFailures += 1
        continue
      }
      for (const entry of seams.openEntries(recon.secretKey, ek, String(row.BallotId), opened.payload)) {
        if (!entry.ok) {
          openFailures += 1
          continue
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(entry.voteEntryJson)
        } catch {
          openFailures += 1
          continue
        }
        const p = parsed as { ballotId?: unknown, answers?: unknown }
        const projection = { ballotId: p.ballotId, answers: p.answers }
        if (!isEntryShape(projection)) {
          openFailures += 1
          continue
        }
        projected.push({ ballotId: projection.ballotId, answers: projection.answers.map((a) => ({ questionCode: a.questionCode, optionCodes: [...a.optionCodes] })) })
      }
    }
  } finally {
    recon.secretKey.fill(0)
  }
  const openedSetSha256 = sha256Hex(openedSetPreimage(projected))
  const openedCounts = countMapOf(projected)
  if (openFailures > 0) throw new OpenedSetError('opened-set-mismatch')
  if (!sameCounts(openedCounts, engineCountMap(results))) throw new OpenedSetError('opened-set-mismatch')
  if (projected.length !== results.totals.valid) throw new OpenedSetError('opened-set-mismatch')
  let expectedMatch: boolean | null = null
  if (input.expected !== undefined) {
    expectedMatch = sha256Hex(openedSetPreimage(input.expected)) === openedSetSha256
    if (!expectedMatch) throw new OpenedSetError('opened-set-mismatch')
  }
  let needleInOpened: boolean | null = null
  if (input.needle !== undefined) {
    needleInOpened = projected.some((e) => e.answers.some((a) => a.optionCodes.includes(input.needle as string)))
    if (!needleInOpened) throw new OpenedSetError('needle-not-opened')
  }
  return {
    openedCount: projected.length,
    openFailures: 0,
    openedSetSha256,
    expectedChecked: input.expected !== undefined,
    expectedMatch,
    needleInOpened,
    decryptMs: Math.round(seams.now() - t0)
  }
}
