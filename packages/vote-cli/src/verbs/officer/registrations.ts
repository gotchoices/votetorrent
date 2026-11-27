// `vt officer registrations`: the officer's inbox read, counts and posture. No token. Every row goes
// through an explicit ALLOW-LIST of seven keys: a `RegistrationRequestListRow` also carries the
// registrant's `lastName`/`firstName` (and a bridge label), which are never copied; nothing here reads
// a challenge nonce, a device key, a registration code or a verification value. With `detail`, the
// pending rows get their 67-18 approve blockers (costly on a real relay: about 190 reads per request,
// so `detailMs` is reported). Paging is keyset through the engine and capped at 500 rows.

import { performance } from 'node:perf_hooks'
import type { RegistrationRequestListRow, RegistrationRequestStatus } from '@votetorrent/vote-core'
import type { IRegistrationEngine } from '@votetorrent/vote-core'
import { loadRegistrationApproval, readOfficerIntakeKeyState, registrationDecisionBlockers } from '@votetorrent/workflows/authority'
import { readAttestationRows } from '../../attestation/policy.js'
import {
  IntakeVerbRefusal,
  assertIntakeTestParty,
  bindIntakeVerb,
  countRows,
  pickIntakeArgs,
  requireAuthorityArg,
  requireNetworkArg,
  type IntakeDeps
} from './intake-deps.js'

const ALLOWED: readonly string[] = Object.freeze(['authority', 'network', 'status', 'pageSize', 'max', 'detail'])

export const REGISTRATIONS_HARD_CAP = 500
export const REGISTRATIONS_DEFAULT_PAGE_SIZE = 100

const STATUSES: ReadonlySet<string> = new Set(['p', 'a', 'r'])
const DIGITS_RE = /^\d{1,4}$/

const ASSOCIATIONS_SQL = 'select count(*) as n from Association'
const CHALLENGES_SQL = "select count(*) as n from AssociationDecision where Status = 'c'"

/** The seven reply keys of a row, and nothing else. */
export interface RegistrationRowView {
  requestId: string
  status: RegistrationRequestStatus
  issuerType: string
  receivedAt: string
  hasPriorRejections: boolean
  payloadAccess: string | null
  duplicateClosure: string | null
  blockers?: string[]
}

export function allowListRow(row: RegistrationRequestListRow): RegistrationRowView {
  return {
    requestId: row.requestId,
    status: row.status,
    issuerType: row.issuerType,
    receivedAt: row.receivedAt,
    hasPriorRejections: row.hasPriorRejections === true,
    payloadAccess: typeof row.payloadAccess === 'string' ? row.payloadAccess : null,
    duplicateClosure: typeof row.duplicateClosure === 'string' ? row.duplicateClosure : null
  }
}

function parseBounded(v: unknown, fallback: number, max: number): number {
  if (v === undefined) return fallback
  if (typeof v !== 'string' || !DIGITS_RE.test(v)) throw new IntakeVerbRefusal('bad-arg')
  const n = Number(v)
  if (n < 1 || n > max) throw new IntakeVerbRefusal('bad-arg')
  return n
}

function parseDetail(v: unknown): boolean {
  if (v === undefined || v === false || v === 'false') return false
  if (v === true || v === 'true') return true
  throw new IntakeVerbRefusal('bad-arg')
}

const readOnlySigner = async (): Promise<never> => {
  throw new Error('registrations: never signs')
}

export async function runRegistrations(deps: IntakeDeps, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t0 = performance.now()
  const a = pickIntakeArgs(args, ALLOWED)
  assertIntakeTestParty(deps.partyId)
  requireAuthorityArg(a)
  requireNetworkArg(a)
  let status: RegistrationRequestStatus | undefined
  if (a.status !== undefined) {
    if (typeof a.status !== 'string' || !STATUSES.has(a.status)) throw new IntakeVerbRefusal('status-invalid')
    status = a.status as RegistrationRequestStatus
  }
  const pageSize = parseBounded(a.pageSize, REGISTRATIONS_DEFAULT_PAGE_SIZE, REGISTRATIONS_HARD_CAP)
  const max = parseBounded(a.max, REGISTRATIONS_HARD_CAP, REGISTRATIONS_HARD_CAP)
  const detail = parseDetail(a.detail)

  const { db, authorityId } = await deps.open()
  const getEngine = deps.getEngine
  const reg = await getEngine<IRegistrationEngine>('registration')
  const rows: RegistrationRowView[] = []
  let truncated = false
  let cursor: string | undefined
  paging: for (;;) {
    const page = await reg.listRegistrationRequests(
      { authorityId, ...(status !== undefined ? { status } : {}) },
      { ...(cursor !== undefined ? { cursor } : {}), pageSize }
    )
    for (const row of page.rows) {
      if (rows.length >= max) {
        truncated = true
        break paging
      }
      rows.push(allowListRow(row))
    }
    if (page.nextCursor === undefined || page.rows.length === 0) break
    cursor = page.nextCursor
  }

  let detailMs: number | undefined
  if (detail) {
    const d0 = performance.now()
    for (const row of rows) {
      if (row.status !== 'p') continue
      const view = await loadRegistrationApproval({ getEngine, requestId: row.requestId })
      row.blockers = registrationDecisionBlockers(view).approve
    }
    detailMs = Math.round(performance.now() - d0)
  }

  const counts = { pending: 0, approved: 0, rejected: 0, other: 0, challenges: 0, associations: 0 }
  for (const row of rows) {
    if (row.status === 'p') counts.pending++
    else if (row.status === 'a') counts.approved++
    else if (row.status === 'r') counts.rejected++
    else counts.other++
  }
  counts.challenges = await countRows(db, CHALLENGES_SQL)
  counts.associations = await countRows(db, ASSOCIATIONS_SQL)
  const intake = await readOfficerIntakeKeyState({ getEngine, vault: deps.intakeVault, createSigner: readOnlySigner }, authorityId)
  const attestationRows = await readAttestationRows(db, authorityId)
  return {
    posture: deps.posture.kind,
    intake,
    attestationRows,
    counts,
    rows,
    truncated,
    ...(detailMs !== undefined ? { detailMs } : {}),
    ms: Math.round(performance.now() - t0)
  }
}

export const registrationsVerb = bindIntakeVerb(runRegistrations)
