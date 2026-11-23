// src/intake/cosign.ts — co-signed AuthorityIntakePolicy changes above a 'vrg' threshold of 1.
//
// Schema version 2 (votetorrent.qsql, AuthorityIntakePolicy): a PROPOSED change is a row with a
// negative Revision (-N proposes revision N) carrying the initiator's signed 'vrg' session
// (SigningNonce) and the Tid its digest binds (SigningTid). Every other current 'vrg' holder gets an
// 'intake-policy' signature Task for that session (the shared fan-out). When a co-signer's signature
// takes the session to its threshold, the EFFECTIVE row (Revision N, the same values) is inserted
// under the reached session. Readers take the greatest Revision, so a proposal is never read as the
// policy in force.

import type { Database, SqlValue } from '@quereus/quereus'
import { ConstraintError } from '@quereus/quereus'
import type { IntakeQueryPort } from './query-port.js'
import { REASSOCIATION_MODES, type IntakePolicyProposalView, type ReassociationMode } from './types.js'
import { computeSigningStatus } from '../signing/threshold.js'

// Defined in types.ts so the intake types never import this module (the ./browser purity walker
// follows type imports too, and this module reaches the transports through query-port).
export type { IntakePolicyProposalView } from './types.js'

interface RawProposalRow {
  readonly AuthorityId: unknown
  readonly Revision: unknown
  readonly RestBridgeUrl: unknown
  readonly ReassociationMode: unknown
  readonly SetAt: unknown
  readonly SigningNonce: unknown
  readonly SigningTid: unknown
}

const PROPOSAL_COLUMNS = 'AuthorityId, Revision, RestBridgeUrl, ReassociationMode, SetAt, SigningNonce, SigningTid'

function modeOf (value: unknown): ReassociationMode {
  return (REASSOCIATION_MODES as readonly string[]).includes(value as string) ? (value as ReassociationMode) : 'manual'
}

async function rows<T> (db: Database, sql: string, params: Record<string, unknown>): Promise<T[]> {
  const out: T[] = []
  for await (const row of db.eval(sql, params as Record<string, SqlValue>)) out.push(row as T)
  return out
}

/** The next revision a change may take: above every effective revision AND every proposal. */
export async function nextIntakePolicyRevision (port: IntakeQueryPort, authorityId: string): Promise<number> {
  const found = await port.query<{ hi: unknown, lo: unknown }>(
    'select max(Revision) as hi, min(Revision) as lo from AuthorityIntakePolicy where AuthorityId = :authorityId',
    { authorityId }
  )
  const hi = Number(found[0]?.hi ?? 0) || 0
  const lo = Number(found[0]?.lo ?? 0) || 0
  return Math.max(hi, -lo, 0) + 1
}

async function toView (db: Database, row: RawProposalRow): Promise<IntakePolicyProposalView> {
  const authorityId = String(row.AuthorityId)
  const revision = -Number(row.Revision)
  const signingNonce = String(row.SigningNonce)
  const status = await computeSigningStatus(db, signingNonce)
  const applied = (await rows(db, 'select 1 as x from AuthorityIntakePolicy where AuthorityId = :authorityId and Revision = :revision', { authorityId, revision })).length > 0
  return {
    authorityId,
    revision,
    restBridgeUrl: typeof row.RestBridgeUrl === 'string' ? row.RestBridgeUrl : null,
    reassociationMode: modeOf(row.ReassociationMode),
    setAt: String(row.SetAt),
    signingNonce,
    threshold: status?.threshold ?? 1,
    signatures: status?.signatures ?? 0,
    reached: status?.reached ?? false,
    unreachable: status?.unreachable ?? false,
    applied
  }
}

/** Every proposal for `authorityId`, newest first. */
export async function listIntakePolicyProposals (db: Database, authorityId: string): Promise<IntakePolicyProposalView[]> {
  const found = await rows<RawProposalRow>(
    db,
    `select ${PROPOSAL_COLUMNS} from AuthorityIntakePolicy where AuthorityId = :authorityId and Revision <= -1 order by Revision asc`,
    { authorityId }
  )
  const out: IntakePolicyProposalView[] = []
  for (const row of found) out.push(await toView(db, row))
  return out
}

/** The proposal behind a signing session, or `undefined`. */
export async function readIntakePolicyProposalByNonce (db: Database, signingNonce: string): Promise<IntakePolicyProposalView | undefined> {
  const found = await rows<RawProposalRow>(
    db,
    `select ${PROPOSAL_COLUMNS} from AuthorityIntakePolicy where SigningNonce = :signingNonce and Revision <= -1 limit 1`,
    { signingNonce }
  )
  return found[0] ? toView(db, found[0]) : undefined
}

/**
 * Inserts the effective row for the proposal behind `signingNonce` once its session has reached
 * the threshold. Idempotent: returns `'applied'` when it inserted the row, `'already-applied'` when
 * the row exists (including a concurrent writer winning the primary key), `'not-reached'` below the
 * threshold, and `'no-proposal'` when the session has no proposal. The schema checks the reached
 * session and the digest; this never binds a threshold boolean of its own.
 */
export async function applyReachedIntakePolicyProposal (
  db: Database,
  signingNonce: string
): Promise<'applied' | 'already-applied' | 'not-reached' | 'no-proposal'> {
  const found = await rows<RawProposalRow>(
    db,
    `select ${PROPOSAL_COLUMNS} from AuthorityIntakePolicy where SigningNonce = :signingNonce and Revision <= -1 limit 1`,
    { signingNonce }
  )
  const row = found[0]
  if (!row) return 'no-proposal'
  const authorityId = String(row.AuthorityId)
  const revision = -Number(row.Revision)
  const existing = await rows(db, 'select 1 as x from AuthorityIntakePolicy where AuthorityId = :authorityId and Revision = :revision', { authorityId, revision })
  if (existing.length > 0) return 'already-applied'
  const reached = await rows(db, 'select 1 as x from AdminSignature where SigningNonce = :signingNonce', { signingNonce })
  if (reached.length === 0) return 'not-reached'
  const tid = Number(row.SigningTid)
  if (!Number.isSafeInteger(tid)) throw new Error('applyReachedIntakePolicyProposal: the proposal carries no usable SigningTid')
  try {
    await db.exec(
      `insert into AuthorityIntakePolicy (AuthorityId, Revision, RestBridgeUrl, ReassociationMode, SetAt)
       with context SigningNonce = :signingNonce, Tid = ${tid}
       values (:authorityId, :revision, :restBridgeUrl, :reassociationMode, :setAt)`,
      {
        signingNonce,
        authorityId,
        revision,
        restBridgeUrl: typeof row.RestBridgeUrl === 'string' ? row.RestBridgeUrl : null,
        reassociationMode: row.ReassociationMode as SqlValue,
        setAt: row.SetAt as SqlValue
      }
    )
  } catch (err) {
    const again = await rows(db, 'select 1 as x from AuthorityIntakePolicy where AuthorityId = :authorityId and Revision = :revision', { authorityId, revision })
    if (again.length > 0 && (err instanceof ConstraintError || String((err as Error)?.message ?? '').includes('UNIQUE'))) return 'already-applied'
    throw err
  }
  return 'applied'
}
