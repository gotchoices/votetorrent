// `vt officer ballot-submit`: propose a ballot and submit it for confirmation through the shared
// `proposeBallot` / `submitBallot` / `readBallotConfirmation` (@votetorrent/workflows/authority, the
// Authority's EditBallotScreen body). Replaces tools/lean-rig/lean/lean-part2.ts 771-801 (the default
// needle ballot, proposeBallot, submitBallotForConfirmation) and tools/vote-cli/src/workflows/authority.mjs
// 364-403. Approval-class: the lazy submit signer may sign above a `ceb` threshold of 1.
//
// Without `--ballot-file` the rig's default ballot is built: one question, two options, option 0's
// code a fresh needle that goes ONLY to a 0600 file under `secrets/` (written after the token
// preflight, so a refused token leaves no file) and is registered with the daemon's redactor. With
// `--ballot-file` the file (absolute, regular, at most 64 KiB) is validated question by question and
// no needle exists. Results hold ids, counts, booleans and timings only.

import { randomBytes } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Question } from '@votetorrent/vote-core'
import { proposeBallot, readBallotConfirmation, submitBallot } from '@votetorrent/workflows/authority'
import type { SignCallback } from '@votetorrent/workflows/platform'
import { CALL_APPROVAL_ARG_KEYS, withCallApproval } from '../../approval/call-approval.js'
import type { OfficerVerbContext } from '../../network/network-verb-support.js'
import { createPrivateFileOnce } from '../../vault/private-file.js'
import {
  assertTestParty,
  elapsedMs,
  officerElectionDeps,
  officerSignerFactory,
  pickArgs,
  refuse,
  serializeOfficerWrite,
  startedNow,
  type OfficerElectionDeps
} from './election-deps.js'

const ALLOWED = ['network', 'election', 'ballotId', 'ballotFile', 'description', ...CALL_APPROVAL_ARG_KEYS]
const BALLOT_ID_RE = /^[A-Za-z0-9._-]{1,80}$/
const MAX_BALLOT_FILE_BYTES = 65536
const MAX_DESCRIPTION = 2000
const MAX_QUESTIONS = 32
const MIN_OPTIONS = 2
const MAX_OPTIONS = 64
const DEFAULT_DESCRIPTION = 'vt-ballot'
const NEEDLE_PREFIX = 'vt-needle-'
const NEEDLE_CHARS = 10
const BASE36 = 'abcdefghijklmnopqrstuvwxyz0123456789'

interface BallotShape {
  questions: Question[]
  districts: string[]
}

const base36 = (n: number): string => Array.from(randomBytes(n), (b) => BASE36[b % 36]!).join('')

function question(code: string, title: string, instructions: string, options: Array<{ code: string, title: string }>, sequence: number): Question {
  return { code, title, instructions, type: 'select', options, optionRange: { min: 1, max: 1 }, sequence, required: true }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** The tools/vote-cli ballot file shape: `{ questions: [{ code, title, options: [{ code, title }] }], districts? }`. */
function readBallotFile(path: unknown): BallotShape {
  if (typeof path !== 'string' || !isAbsolute(path)) refuse('ballot-file-invalid')
  let st
  try {
    st = lstatSync(path)
  } catch {
    refuse('ballot-file-invalid')
  }
  if (!st.isFile() || st.size > MAX_BALLOT_FILE_BYTES) refuse('ballot-file-invalid')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    refuse('ballot-file-invalid')
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.questions) || parsed.questions.length < 1 || parsed.questions.length > MAX_QUESTIONS) refuse('ballot-file-invalid')
  const questions = parsed.questions.map((q, i) => {
    if (!isRecord(q) || !isStr(q.code) || !isStr(q.title) || !Array.isArray(q.options)) refuse('ballot-file-invalid')
    if (q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) refuse('ballot-file-invalid')
    const options = q.options.map((o) => {
      if (!isRecord(o) || !isStr(o.code) || !isStr(o.title)) refuse('ballot-file-invalid')
      return { code: o.code, title: o.title }
    })
    return question(q.code, q.title, '', options, i)
  })
  let districts: string[] = []
  if (parsed.districts !== undefined) {
    if (!Array.isArray(parsed.districts) || !parsed.districts.every(isStr)) refuse('ballot-file-invalid')
    districts = parsed.districts
  }
  return { questions, districts }
}

/** The rig's default ballot: `vt-q1` with the needle at code-order index 0 and `vt-opt-b`. */
function defaultBallot(needle: string): BallotShape {
  return {
    questions: [question('vt-q1', 'vt-q1', 'Choose one option.', [{ code: needle, title: 'vt option one' }, { code: 'vt-opt-b', title: 'vt-opt-b' }], 0)],
    districts: []
  }
}

export async function runBallotSubmit(deps: OfficerElectionDeps, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t0 = startedNow()
  const a = pickArgs(args, ALLOWED)
  assertTestParty(deps.partyId)
  if (a.network === undefined) refuse('network-required')
  if (a.election === undefined) refuse('election-required')
  const ballotId = a.ballotId
  if (ballotId !== undefined && (typeof ballotId !== 'string' || !BALLOT_ID_RE.test(ballotId))) refuse('ballot-id-invalid')
  const description = a.description === undefined ? DEFAULT_DESCRIPTION : a.description
  if (typeof description !== 'string' || description.length > MAX_DESCRIPTION) refuse('description-invalid')
  let needle: string | undefined
  let shape: BallotShape
  if (a.ballotFile !== undefined) {
    shape = readBallotFile(a.ballotFile)
  } else {
    needle = NEEDLE_PREFIX + base36(NEEDLE_CHARS)
    shape = defaultBallot(needle)
  }
  const electionId = a.election
  return withCallApproval(args, (approval) =>
    serializeOfficerWrite(deps.writeKey, async () => {
      const network = await deps.openNetwork(a.network)
      const electionEngine = await network.openElection(electionId)
      const signer = officerSignerFactory(deps, approval)
      await signer.preflight()
      let needleFile: string | null = null
      if (needle !== undefined) {
        deps.secrets.add(needle, { windows: true })
        needleFile = join(deps.secretsDir, `ballot-needle-${ballotId ?? base36(8)}.txt`)
        if (!createPrivateFileOnce(needleFile, needle + '\n')) refuse('needle-file-exists')
      }
      const p0 = startedNow()
      const ballot = await proposeBallot({
        electionEngine,
        draft: { authorityId: network.authorityId, description, districts: shape.districts, questions: shape.questions },
        ballotId,
        electionId: electionId as string,
        now: deps.now()
      })
      const proposeMs = elapsedMs(p0)
      let lazy: SignCallback | undefined
      const sign: SignCallback = async (digest) => {
        lazy ??= await signer.createSigner()
        return lazy(digest)
      }
      const s0 = startedNow()
      await submitBallot({ electionEngine, ballotId: ballot.id, sign })
      const submitMs = elapsedMs(s0)
      const view = await readBallotConfirmation({ electionEngine, ballotId: ballot.id })
      return {
        electionId,
        ballotId: ballot.id,
        questions: shape.questions.length,
        options: shape.questions.reduce((n, q) => n + q.options.length, 0),
        needleFile,
        locked: view.locked,
        confirmed: view.confirmed,
        ownTaskOpen: view.ownTaskOpen,
        signatures: signer.signatures(),
        proposeMs,
        submitMs,
        ms: elapsedMs(t0)
      }
    })
  )
}

export default async function ballotSubmit(ctx: OfficerVerbContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return runBallotSubmit(officerElectionDeps(ctx), args)
}
