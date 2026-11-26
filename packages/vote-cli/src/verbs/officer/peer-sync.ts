// `vt officer peer-sync`: one officer sync over the shared 67-09 `createPeerSyncBinding` (the
// Authority app's peer binding): intake staged registration and association requests from the strand,
// publish decided registrations, drive association challenges and associations. Replaces the lean rig's
// `officerSync` loop body (the retired lean rig's main driver, the `binding.syncNow` call).
//
// The token is OPTIONAL: an unattended sync imports and reads with the at-rest vault, and only a step
// that must sign fails (`token-absent`, counted). With a token source the preflight runs first. In
// posture `token` a skipping AttestationRequired row refuses BEFORE `syncNow` (R-27 item 3). The reply
// holds counts, the verdict delta and the refusal codes it classifies to; never an item id.

import { performance } from 'node:perf_hooks'
import { createPeerSyncBinding } from '@votetorrent/workflows/authority'
import type { SignCallback } from '@votetorrent/workflows/platform'
import { ApprovalRefusal, CALL_APPROVAL_ARG_KEYS, hasCallApproval } from '../../approval/call-approval.js'
import { assertTokenPostureVerifies, classifyAttestationDelta, readAttestationRows, type AttestationVerdictCounts } from '../../attestation/policy.js'
import {
  IntakeVerbRefusal,
  assertIntakeTestParty,
  bindIntakeVerb,
  countRows,
  pickIntakeArgs,
  requireAuthorityArg,
  requireNetworkArg,
  withIntakeApproval,
  type IntakeDeps
} from './intake-deps.js'

const ALLOWED: readonly string[] = Object.freeze(['authority', 'network', ...CALL_APPROVAL_ARG_KEYS])

const ASSOCIATIONS_SQL = 'select count(*) as n from Association'
const CHALLENGES_SQL = "select count(*) as n from AssociationDecision where Status = 'c'"

function delta(before: AttestationVerdictCounts, after: AttestationVerdictCounts, kind: 'token' | 'platform'): { accepted: number, refused: number } {
  return { accepted: after[kind].accepted - before[kind].accepted, refused: after[kind].refused - before[kind].refused }
}

/** A policy failure is this verb's own refusal; anything else propagates. */
export function guardAttestationRows(deps: IntakeDeps, rows: Awaited<ReturnType<typeof readAttestationRows>>): void {
  try {
    assertTokenPostureVerifies(deps.posture, rows)
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code
    if (code === 'policy-skips-verification') throw new IntakeVerbRefusal('policy-skips-verification', { cause: e })
    throw e
  }
}

async function syncOnce(
  deps: IntakeDeps,
  createSigner: () => Promise<SignCallback>,
  signingRefused: () => number,
  t0: number
): Promise<Record<string, unknown>> {
  const { db, authorityId } = await deps.open()
  guardAttestationRows(deps, await readAttestationRows(db, authorityId))
  const before = deps.attestationCounts()
  const associationsBefore = await countRows(db, ASSOCIATIONS_SQL)
  const binding = createPeerSyncBinding({
    getEngine: deps.getEngine,
    createTransports: (t) => deps.createTransports(t),
    resolveVault: () => deps.intakeVault,
    createSigner
  })
  const report = await binding.syncNow({ authorityId })
  const after = deps.attestationCounts()
  return {
    imported: report.imported,
    pending: report.pending,
    errors: report.errorItemIds.length,
    associations: { before: associationsBefore, after: await countRows(db, ASSOCIATIONS_SQL) },
    challenges: await countRows(db, CHALLENGES_SQL),
    attestation: { posture: deps.posture.kind, token: delta(before, after, 'token'), platform: delta(before, after, 'platform') },
    refusals: classifyAttestationDelta(before, after),
    signingRefused: signingRefused(),
    ms: Math.round(performance.now() - t0)
  }
}

export async function runPeerSync(deps: IntakeDeps, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t0 = performance.now()
  const a = pickIntakeArgs(args, ALLOWED)
  assertIntakeTestParty(deps.partyId)
  requireAuthorityArg(a)
  requireNetworkArg(a)
  if (hasCallApproval(args)) {
    return withIntakeApproval(deps, args, ({ sign }) => syncOnce(deps, async () => sign, () => 0, t0))
  }
  let refused = 0
  const absent = async (): Promise<SignCallback> => {
    refused++
    throw new ApprovalRefusal('token-absent')
  }
  return syncOnce(deps, absent, () => refused, t0)
}

export const peerSyncVerb = bindIntakeVerb(runPeerSync)
