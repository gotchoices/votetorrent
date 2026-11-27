// `vt voter cast`: build and sign the vote with K_vote under the per-call token, seal the record with the shared
// vault under the CLI's token-derived wrap key, and save it with the shared store over the daemon's file kv,
// all through the shared `castVote` (67-22, the Voter's Submit). Replaces the retired lean rig's host voter
// 907-1047 (selection rule `options[(N - 1) % len]`, build, sign). Approval-class: the token is read per call,
// the record is sealed before the store writes it, and the cast's choice projection (ballot id plus answers, no
// nonce) goes ONLY to a new 0600 file under `secrets/`, whose path the reply returns. The vote plaintext, the
// nonces and K_vote never reach the reply or a log. No console, no process.env, no instanceof.

import { lstatSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { castVote, readVoteContext, toVoterBallot, type VoteContext } from '@votetorrent/workflows/voter'
import type { AttestationProducer, VoteSigningProducer } from '@votetorrent/workflows/platform'
import { CALL_APPROVAL_ARG_KEYS, withCallApproval } from '../../approval/call-approval.js'
import type { ApprovalContext } from '../../approval/token.js'
import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import { createPrivateFileOnce, readPrivateFile } from '../../vault/private-file.js'
import { CLI_VOTE_PROMPT, createCliVoteRecordPorts, createRedactingVoteSendDebug } from '../../voter/vote-record-seams.js'
import {
  assertVoterTestParty,
  bindVoteVerb,
  elapsedMs,
  pickVoterArgs,
  requireVoterNetworkArg,
  startedNow,
  VoterVerbRefusal,
  type VoterVoteDeps
} from './voter-deps.js'

const CAST_ARGS: readonly string[] = ['network', 'election', 'choiceIndex', 'selectionsFile', ...CALL_APPROVAL_ARG_KEYS]
const ELECTION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/
const CHOICE_INDEX_RE = /^\d{1,2}$/
export const CHOICE_INDEX_MAX = 63
export const SELECTIONS_FILE_MAX_BYTES = 16384

/** A non-empty election id argument; absent is `election-required`, any other shape `bad-arg`. */
export function requireElectionArg(args: Record<string, unknown>): string {
  const v = args.election
  if (typeof v !== 'string' || v.length === 0) throw new VoterVerbRefusal('election-required')
  if (!ELECTION_ID_RE.test(v)) throw new VoterVerbRefusal('bad-arg')
  return v
}

/** The selections file: absolute, 0600, owner-owned, at most 16 KiB, a JSON object of office id to candidate ids. */
export function readSelectionsFile(path: unknown): Record<string, string[]> {
  if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path)) throw new VoterVerbRefusal('selections-file-invalid')
  let data: Buffer | null
  try {
    data = readPrivateFile(path, { maxBytes: SELECTIONS_FILE_MAX_BYTES })
  } catch {
    throw new VoterVerbRefusal('selections-file-invalid')
  }
  if (data === null) throw new VoterVerbRefusal('selections-file-invalid')
  let parsed: unknown
  try {
    parsed = JSON.parse(data.toString('utf8'))
  } catch {
    throw new VoterVerbRefusal('selections-file-invalid')
  } finally {
    data.fill(0)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new VoterVerbRefusal('selections-file-invalid')
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new VoterVerbRefusal('selections-file-invalid')
    out[k] = v as string[]
  }
  return out
}

/** The rig's rule: choice index `n` picks candidate `n % candidates.length` of every office that has one. */
export function selectionsForChoiceIndex(context: Pick<VoteContext, 'electionId' | 'ballots'>, n: number): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const office of toVoterBallot(context.electionId, context.ballots).offices) {
    if (office.candidates.length === 0) continue
    out[office.id] = [office.candidates[n % office.candidates.length]!.id]
  }
  return out
}

/** The choice file path for an election: `<secretsDir>/vote-choice-<election id>.json`. The whole id, because
 * ids are `election-<ms>` and any prefix would give every election the same file (`choice-file-exists`). */
export function choiceFilePath(secretsDir: string, electionId: string): string {
  return join(secretsDir, 'vote-choice-' + electionId + '.json')
}

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Counts `token()` reads without holding the token. */
export function countingApproval(approval: ApprovalContext): { approval: ApprovalContext, reads(): number } {
  let n = 0
  return {
    approval: {
      token: async () => {
        n++
        return approval.token()
      }
    },
    reads: () => n
  }
}

function isNoElection(e: unknown): boolean {
  return (e as { name?: unknown } | null | undefined)?.name === 'NoElectionError'
}

export async function runCast(deps: VoterVoteDeps, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t0 = startedNow()
  const a = pickVoterArgs(args, CAST_ARGS)
  assertVoterTestParty(deps.partyId)
  const network = requireVoterNetworkArg(a)
  const electionId = requireElectionArg(a)
  if (a.choiceIndex !== undefined && a.selectionsFile !== undefined) throw new VoterVerbRefusal('selection-ambiguous')
  let choiceIndex = 0
  if (a.choiceIndex !== undefined) {
    if (typeof a.choiceIndex !== 'string' || !CHOICE_INDEX_RE.test(a.choiceIndex) || Number(a.choiceIndex) > CHOICE_INDEX_MAX) throw new VoterVerbRefusal('choice-index-invalid')
    choiceIndex = Number(a.choiceIndex)
  }
  const fileSelections = a.selectionsFile === undefined ? undefined : readSelectionsFile(a.selectionsFile)
  const choicePath = choiceFilePath(deps.secretsDir, electionId)
  if (exists(choicePath)) throw new VoterVerbRefusal('choice-file-exists')

  return withCallApproval(args, async (rawApproval) => {
    const counted = countingApproval(rawApproval)
    const { getEngine } = await deps.openNetwork(network)
    const promptsBefore = deps.authPromptCount()
    let context: VoteContext
    try {
      context = await (deps.readContext ?? readVoteContext)({ getEngine }, deps.now())
    } catch (e) {
      if (isNoElection(e)) throw new VoterVerbRefusal('no-election', { cause: e })
      throw e
    }
    if (context.electionId !== electionId) throw new VoterVerbRefusal('election-mismatch')
    const selectionMap = fileSelections ?? selectionsForChoiceIndex(context, choiceIndex)
    const producer: VoteSigningProducer = await deps.producer(counted.approval)
    const sink = createRedactingVoteSendDebug(deps)
    const ports = createCliVoteRecordPorts({ kv: deps.kv, keys: deps.keys, approval: counted.approval, debug: sink })

    const tCast = startedNow()
    const result = await castVote(
      { getEngine, nowMs: deps.now(), selectionMap, readContext: async () => context, signPrompt: CLI_VOTE_PROMPT, recordPrompt: CLI_VOTE_PROMPT },
      {
        resolveVoteSigningProducer: (override?: AttestationProducer) => {
          if (override !== undefined) throw new TypeError('producer override refused')
          return producer
        },
        recordStore: ports.store,
        recordVault: ports.vault
      }
    )
    const castMs = elapsedMs(tCast)
    if (!result.ok) {
      const reason = result.stage === 'ineligible' ? result.eligibility.reason : result.reason
      throw new VoterVerbRefusal(`${result.stage}:${reason}`)
    }

    const tReveal = startedNow()
    const load = await ports.receipt.loadVoteReceipt(electionId, result.electionRevision)
    if (load.kind !== 'saved') throw new VoterVerbRefusal('choice-unreadable')
    const reveal = await ports.receipt.revealVoteReceipt(electionId, load.envelope, CLI_VOTE_PROMPT)
    const revealMs = elapsedMs(tReveal)
    if (reveal.kind !== 'ok') throw new VoterVerbRefusal('choice-unreadable')
    for (const v of reveal.record.votes) deps.secrets.add(v.nonce, { windows: true })
    deps.secrets.add(reveal.record.voter.signature, { windows: true })
    const projection = reveal.record.votes.map((v) => ({ ballotId: v.ballotId, answers: v.answers.map((an) => ({ questionCode: an.questionCode, optionCodes: [...an.optionCodes] })) }))
    const text = JSON.stringify(projection)
    deps.secrets.add(text, { windows: true })
    if (!createPrivateFileOnce(choicePath, text + '\n')) throw new VoterVerbRefusal('choice-file-exists')

    return {
      electionId,
      electionRevision: result.electionRevision,
      ballots: result.ballotIds,
      savedAt: result.savedAt,
      replacedStale: result.replacedStale,
      choiceFile: choicePath,
      castUnwraps: deps.authPromptCount() - promptsBefore,
      tokenReads: counted.reads(),
      castMs,
      revealMs,
      ms: elapsedMs(t0)
    }
  })
}

export const castVerb: VerbHandler<VerbContext> = bindVoteVerb(runCast)

export default castVerb
