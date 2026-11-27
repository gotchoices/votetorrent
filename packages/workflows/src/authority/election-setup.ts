/**
 * election-setup.ts: the officer's election create / revise workflow bodies.
 *
 * Extracted by phase 67 plan 10 from `apps/VoteTorrentAuthority/src/screens/elections/CreateElectionScreen.tsx`
 * handlePropose (lines 131-306: `createElection`, `checkElectionKeyholders`, `keyholderSeatPlaceholders`,
 * `BALLOT_DEADLINE_LEAD_MS`) and `EditElectionScreen.tsx` handlePropose (lines 120-213:
 * `proposeElectionRevision`). The screens keep their React state, field errors and navigation and call
 * these functions; the `vt` CLI calls the same functions, so the officer workflow lives once.
 *
 * Secrecy contract: nothing here logs. The signer arrives as a callback factory (`createSigner`) that is
 * invoked exactly once per `createElection`, and never as a key; the device (or CLI) private key stays
 * closed over on the caller's side (D-01). Every input refusal comes back as `{ ok: false, refusal }`
 * BEFORE any engine write, and the keyholder refusals come back before the signer is even created, so a
 * refused form costs the officer no biometric prompt and leaves no signed AdminSigning rows. Builder and
 * engine errors are rethrown unchanged for the caller to map.
 *
 * Load-time rule (wave 3): this module imports vote-core and vote-engine as TYPES only. The v1.1
 * create-election builder is taken from the engine instance (`IElectionsEngine.buildCreateElection()`,
 * which the real engine implements as the ElectionsCreateElectionBuilder over itself), because a value
 * import of the vote-engine root evaluates the whole engine graph under every app suite that loads any
 * workflows binding, and partial test doubles of its dependencies crash it at load.
 */
import type {
  ElectionDetails,
  ElectionEvent,
  ElectionInit,
  ElectionType,
  IElectionsEngine,
  KeyholderInvite,
} from '@votetorrent/vote-core'
import type { ElectionsCreateElectionBuilder } from '@votetorrent/vote-engine'
import type { SignCallback } from '../platform/signer.js'
import { validateKeyholderPolicy } from './keyholder-policy.js'
import type { KeyholderPolicyReason } from './keyholder-policy.js'
import { findTimelineOrderViolation } from './resolve-election-timeline.js'
import type { TimelineOrderViolation } from './resolve-election-timeline.js'

/** The app's hidden ballot-deadline rule: `now + 10 days` (CreateElectionScreen line 189). */
export const BALLOT_DEADLINE_LEAD_MS = 10 * 24 * 60 * 60 * 1000

export type ElectionSetupRefusalCode =
  | 'title-required'
  | 'no-keyholders'
  | KeyholderPolicyReason
  | 'election-date-invalid'
  | 'revision-deadline-invalid'
  | 'revision-deadline-after-date'
  | 'election-date-too-soon'
  | 'timeline-order'

/**
 * A refusal carries only a code plus, for `election-date-too-soon`, the deadline the date must not
 * precede, and for `timeline-order`, the violating event pair. Never engine text, keys or signatures.
 */
export interface ElectionSetupRefusal {
  code: ElectionSetupRefusalCode
  ballotDeadline?: number
  violation?: TimelineOrderViolation
}

export type ElectionSetupResult<T> = ({ ok: true } & T) | { ok: false; refusal: ElectionSetupRefusal }

export interface ElectionKeyholdersOk {
  ok: true
  /** Trimmed, non-blank names in input order. */
  keyholders: string[]
  /** `Math.max(0, Math.trunc(threshold))`, the value both screens wrote as `keyholderThreshold`. */
  threshold: number
}

/**
 * WR-02 + WR-03 (both screens): strip blank rows so empty names never inflate `keyholders.length` or
 * `keyholderThreshold`, refuse an empty list, then apply the 2-of-N keyholder policy.
 */
export function checkElectionKeyholders(
  names: readonly string[],
  threshold: number
): ElectionKeyholdersOk | { ok: false; refusal: ElectionSetupRefusal } {
  const clean = names.map((name) => name.trim()).filter(Boolean)
  if (clean.length === 0) return { ok: false, refusal: { code: 'no-keyholders' } }
  const policy = validateKeyholderPolicy(clean, Math.trunc(threshold))
  if (!policy.ok) return { ok: false, refusal: { code: policy.reason } }
  return { ok: true, keyholders: clean, threshold: Math.max(0, Math.trunc(threshold)) }
}

/**
 * The name-only keyholder placeholders both screens write into a revision (identical literal in Create
 * and Edit): the seat share itself is minted later by `inviteKeyholderSeat`. Seven fields, input order.
 */
export function keyholderSeatPlaceholders(names: readonly string[]): KeyholderInvite[] {
  return names.map((name) => ({
    name,
    type: 'k',
    expiration: '0',
    inviteKey: '',
    invitePrivate: '',
    inviteSignature: '',
    digest: '',
  }))
}

export interface CreateElectionInput {
  authorityId: string
  title: string
  /** Epoch ms; `NaN` is refused as `election-date-invalid`. */
  date: number
  /** Epoch ms; `NaN` is refused as `revision-deadline-invalid`. */
  revisionDeadline: number
  type: ElectionType
  keyholders: string[]
  threshold: number
  tags: string[]
  instructions: string
  timeline: Record<ElectionEvent, number>
  /**
   * Optional override of the app's `now + BALLOT_DEADLINE_LEAD_MS` rule. The app never passes it; the
   * CLI passes `votingStarts` for a compressed test timeline (the lean rig's choice). The builder's
   * timeline rules and the schema's `BallotDeadlineValid` CHECK still apply to any value.
   */
  ballotDeadline?: number
}

export interface CreateElectionParams {
  electionsEngine: Pick<
    IElectionsEngine,
    'buildCreateElection' | 'seedElectionSigning' | 'peekNextTid' | 'seedElectionRevisionSigning' | 'createElection'
  >
  input: CreateElectionInput
  /** Called exactly once, after the keyholder checks and before the date checks (screen line 158). */
  createSigner: () => Promise<SignCallback>
  /** The instant the election id, the ballot deadline and the revision timestamp derive from. */
  now: number
}

/**
 * CreateElectionScreen handlePropose, in the screen's exact order:
 *  (1) blank title; (2) keyholder refusals (no signer, no engine call before this point);
 *  (3) `createSigner()` once; (4) NaN date, NaN revision deadline;
 *  (5) `electionId = 'election-' + now`, `ballotDeadline = input.ballotDeadline ?? now + lead`;
 *  (6) revision deadline after date, date before ballot deadline, timeline order (no builder or engine yet);
 *  (7) builder chain + `build()` (throws the builder's errors, the rules the Voter applies);
 *  (8) `seedElectionSigning`, the peeked next tid plus one, `seedElectionRevisionSigning` with the SAME timeline
 *      object reference and the SAME seven election fields the builder received (digest parity);
 *  (9) `createElection(payload, { signingNonce, revisionSigningNonce })`.
 */
export async function createElection(params: CreateElectionParams): Promise<ElectionSetupResult<{ electionId: string }>> {
  const { electionsEngine, input, createSigner, now } = params

  const title = input.title.trim()
  if (!title) return { ok: false, refusal: { code: 'title-required' } }

  const keyholders = checkElectionKeyholders(input.keyholders, input.threshold)
  if (!keyholders.ok) return keyholders

  // Build the signer once; the callback closes over the private key on the caller's side (D-01).
  const sign = await createSigner()

  // WR-05: the two required core dates must actually PARSE; never let an unparseable value fall back
  // to a fabricated timeline in the signed, immutable election.
  if (Number.isNaN(input.date)) return { ok: false, refusal: { code: 'election-date-invalid' } }
  if (Number.isNaN(input.revisionDeadline)) return { ok: false, refusal: { code: 'revision-deadline-invalid' } }

  // One election id for both the seam call and the builder payload: the AdminSigning.Digest and the
  // Election.InsertValid Digest must use the IDENTICAL id.
  const electionId = `election-${now}`
  const date = input.date
  const revisionDeadline = input.revisionDeadline
  const ballotDeadline = input.ballotDeadline ?? now + BALLOT_DEADLINE_LEAD_MS

  // Deadline coherence, caught BEFORE the engine so the caller gets a field-level refusal instead of a
  // raw SQL CHECK (RevisionDeadline <= Date / BallotDeadlineValid) or a builder TIMELINE_ORDER error.
  if (revisionDeadline > date) return { ok: false, refusal: { code: 'revision-deadline-after-date' } }
  if (ballotDeadline > date) return { ok: false, refusal: { code: 'election-date-too-soon', ballotDeadline } }
  const violation = findTimelineOrderViolation(input.timeline)
  if (violation !== null) return { ok: false, refusal: { code: 'timeline-order', violation } }

  const electionFields = {
    id: electionId,
    authorityId: input.authorityId,
    title,
    date,
    revisionDeadline,
    ballotDeadline,
    type: input.type,
  }
  const pastRevTs = now - 1000
  const keyholderThreshold = keyholders.threshold

  // Assemble the full payload via the v1.1 builder (D-03 / FACT-02): the engine's own
  // ElectionsCreateElectionBuilder (the interface names only the IBuilder surface; the setter chain is
  // the class's, the same chain the screen used). The builder is immutable: each setter returns a new one.
  const builder = (electionsEngine.buildCreateElection() as ElectionsCreateElectionBuilder)
    .setElection(electionFields)
    .setRevision({
      electionId,
      revision: 0,
      revisionTimestamp: pastRevTs,
      tags: input.tags,
      instructions: input.instructions,
      keyholders: keyholderSeatPlaceholders(keyholders.keyholders),
      timeline: input.timeline,
      keyholderThreshold,
    })
  // Validate BEFORE either signature: build() throws the builder's errors, including the engine's
  // timeline check (the rules the Voter applies), so an election the Voter would refuse costs no
  // signature and leaves no signed AdminSigning rows.
  const payload = builder.build()

  // The engine signing seam owns tid + Digest computation (D-03). Pass the SAME election fields so the
  // seam's AdminSigning.Digest matches what createElection's Election.InsertValid computes.
  const signingNonce = await electionsEngine.seedElectionSigning(electionFields, sign)

  // The ElectionRevision row (Revision=0) via the companion seam: revTid is the peeked next tid plus one
  // (Election consumes T, revision consumes T+1); pastRevTs is PAST and identical to what setRevision received;
  // the timeline is the same object reference the builder payload signs.
  const revTid = (await electionsEngine.peekNextTid()) + 1
  const revisionSigningNonce = await electionsEngine.seedElectionRevisionSigning(
    electionId,
    input.authorityId,
    {
      revision: 0,
      revisionTimestamp: pastRevTs,
      tags: input.tags,
      instructions: input.instructions,
      timeline: input.timeline,
      keyholderThreshold,
    },
    revTid,
    sign
  )

  // createElection directly (not builder.commit(), which does not forward signingNonce), so both nonces
  // reach the engine. The engine is the single source of the revision's keyholders (D-27).
  await electionsEngine.createElection(payload, { signingNonce, revisionSigningNonce })
  return { ok: true, electionId }
}

export interface ElectionRevisionInput {
  type: ElectionType
  keyholders: string[]
  threshold: number
  tags: string[]
  instructions: string
  timeline: Record<ElectionEvent, number>
}

export interface ProposeElectionRevisionParams {
  electionsEngine: Pick<IElectionsEngine, 'adjustElection'>
  /** The cached details the screen loaded once (EUI-01, D-01): ids and immutable dates come from here. */
  current: ElectionDetails
  input: ElectionRevisionInput
  now: number
}

/**
 * EditElectionScreen handlePropose: keyholder refusals, then the timeline-order refusal, then an
 * `ElectionInit` built field for field from the cached details (IN-24: `revision.electionId` is the SAME
 * expression as `election.id`), then `adjustElection`. Non-signing (D-01): there is no signer parameter.
 */
export async function proposeElectionRevision(params: ProposeElectionRevisionParams): Promise<ElectionSetupResult<{}>> {
  const { electionsEngine, current, input, now } = params

  const keyholders = checkElectionKeyholders(input.keyholders, input.threshold)
  if (!keyholders.ok) return keyholders

  const violation = findTimelineOrderViolation(input.timeline)
  if (violation !== null) return { ok: false, refusal: { code: 'timeline-order', violation } }

  const init: ElectionInit = {
    election: {
      id: current.election.id,
      authorityId: current.election.authorityId,
      title: current.election.title,
      date: current.election.date,
      revisionDeadline: current.election.revisionDeadline,
      ballotDeadline: current.election.ballotDeadline,
      type: input.type,
    },
    revision: {
      electionId: current.election.id,
      revision: (current.current.revision ?? 0) + 1,
      // revisionTimestamp must be in the past
      revisionTimestamp: now - 1000,
      tags: input.tags,
      instructions: input.instructions,
      keyholders: keyholderSeatPlaceholders(keyholders.keyholders),
      timeline: input.timeline,
      keyholderThreshold: keyholders.threshold,
    },
  }
  await electionsEngine.adjustElection(init)
  return { ok: true }
}
