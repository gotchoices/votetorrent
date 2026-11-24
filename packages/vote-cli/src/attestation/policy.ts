// The officer's attestation policy (CLI-04, R-27). The POSTURE is the switch: a token attestation
// is verified only when the officer daemon was started with `--accept-token-attestations` on a party
// other than `votetorrent` (posture `token`); every other officer, including every app officer by
// construction, composes only the platform verifier, which refuses a token attestation. The election's
// `AttestationRequired` row decides only WHETHER the verifier runs, read here exactly as
// association-engine.ts (the policy read before `verifier.verify`) reads it: no row, or any value other
// than 0, runs the verifier; exactly 0 skips it. `vt` never writes that row to 0, and no verb of this
// package writes it at all. In posture `token`, a skipping row on any election of the authority refuses
// the run (`policy-skips-verification`), so a token run can never associate a device that nothing
// verified; in posture `production` a skipping row keeps its shipped meaning (T-67-27-11).
//
// The CLI platform verifier is the apps' six-argument PlayIntegrityVerifier dispatcher with
// `keysProvisioned` false and no iOS verifier: the CLI officer has no Play Console keys and no Apple
// roots (phone roles in a `vt` run are a deferred idea), so every Android and iOS attestation is
// refused fail-closed, and the production composition refuses every token attestation too.
//
// No console, no process.env, no instanceof: errors are classified by `.code`.

import {
  LocalConfigKeyProvider,
  PlatformDispatchingAttestationVerifier,
  PlayIntegrityVerifier
} from '@votetorrent/vote-engine/rn'
import type { AttestationChallenge, AttestationVerification, DeviceAttestation, IAttestationVerifier } from '@votetorrent/vote-core'
import { assertTokenAttestationPosture, isTokenAttestation } from './marker.js'
import { composeOfficerAttestationVerifier } from './token-attestation-verifier.js'

export type OfficerAttestationPostureKind = 'production' | 'token'

export type OfficerAttestationPosture = Readonly<{ kind: OfficerAttestationPostureKind, partyId: string }>

export interface OfficerAttestationPostureInput {
  readonly acceptTokenAttestations: unknown
  readonly partyId: string
}

/**
 * Strictly `true` on a non-production party is posture `token` (67-20's `assertTokenAttestationPosture`
 * runs and its `production-party` / `party-missing` propagate unchanged). Anything else, a truthy
 * string included, is posture `production`.
 */
export function officerAttestationPosture(input: OfficerAttestationPostureInput): OfficerAttestationPosture {
  if (input.acceptTokenAttestations === true) {
    assertTokenAttestationPosture({ acceptTokenAttestations: true, partyId: input.partyId })
    return Object.freeze({ kind: 'token', partyId: input.partyId })
  }
  return Object.freeze({ kind: 'production', partyId: input.partyId })
}

/** The voter app's Android package, the only identity the dispatcher would ever be asked about. */
const VOTER_PACKAGE_NAME = 'org.votetorrent.voter'

/**
 * The CLI's platform verifier: an UNPROVISIONED six-argument PlayIntegrityVerifier (the fifth
 * argument, `keysProvisioned`, is `false` and must never be omitted: it defaults to `true`) inside the
 * platform dispatcher with no iOS verifier. Android and iOS attestations are both refused.
 */
export function createCliPlatformVerifier(): IAttestationVerifier {
  const keys = new LocalConfigKeyProvider({ decryptionKeyBase64: '', verificationKeyBase64: '' })
  const identity = { packageName: VOTER_PACKAGE_NAME, certificateSha256Digests: [] as string[] }
  return new PlatformDispatchingAttestationVerifier(
    new PlayIntegrityVerifier(
      keys,
      [],
      identity,
      new Set<string>(),
      false,
      {}
    )
  )
}

export interface AttestationVerdictCounts {
  readonly token: { readonly accepted: number, readonly refused: number }
  readonly platform: { readonly accepted: number, readonly refused: number }
}

export interface BuiltOfficerAssociationVerifier {
  readonly verifier: IAttestationVerifier
  /** A fresh frozen copy of the four counters. */
  counts(): AttestationVerdictCounts
}

export interface BuildOfficerAssociationVerifierOptions {
  readonly posture: OfficerAttestationPosture
  readonly platformVerifier?: IAttestationVerifier
}

function freezeCounts(c: { token: { accepted: number, refused: number }, platform: { accepted: number, refused: number } }): AttestationVerdictCounts {
  return Object.freeze({
    token: Object.freeze({ accepted: c.token.accepted, refused: c.token.refused }),
    platform: Object.freeze({ accepted: c.platform.accepted, refused: c.platform.refused })
  })
}

/**
 * The officer's one verifier composition: 67-20's composer (the platform verifier itself in posture
 * `production`, the token router in posture `token`) wrapped by a counter. `verify` returns the inner
 * result VERBATIM (the same object) and moves one of four counters by whether the attestation is
 * token-shaped and whether `result.ok === true`. It stores no attestation, challenge, reason or key,
 * and a rejecting inner verifier propagates unchanged with no counter moved.
 */
export function buildOfficerAssociationVerifier(opts: BuildOfficerAssociationVerifierOptions): BuiltOfficerAssociationVerifier {
  const inner = composeOfficerAttestationVerifier({
    acceptTokenAttestations: opts.posture.kind === 'token',
    partyId: opts.posture.partyId,
    platformVerifier: opts.platformVerifier ?? createCliPlatformVerifier()
  })
  const counts = { token: { accepted: 0, refused: 0 }, platform: { accepted: 0, refused: 0 } }
  const verifier: IAttestationVerifier = {
    async verify(challenge: AttestationChallenge, attestation: DeviceAttestation): Promise<AttestationVerification> {
      const result = await inner.verify(challenge, attestation)
      const bucket = isTokenAttestation(attestation) ? counts.token : counts.platform
      if (result.ok === true) bucket.accepted++
      else bucket.refused++
      return result
    }
  }
  return { verifier, counts: () => freezeCounts(counts) }
}

export interface AttestationRows {
  /** Elections of the authority that carry an ElectionAttestationPolicy row. */
  readonly elections: number
  /** Of those, the rows whose AttestationRequired reads exactly 0 (the engine skips the verifier). */
  readonly skipping: number
}

/** The slice of the Quereus Database the row read needs (structural, so a spec passes a fake). */
export interface AttestationPolicyDb {
  prepare(sql: string): { all(params: { authorityId: string }): AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>> }
}

const ATTESTATION_ROWS_SQL =
  'select P.ElectionId as electionId, P.AttestationRequired as required from ElectionAttestationPolicy P join Election E on E.Id = P.ElectionId where E.AuthorityId = :authorityId'

/**
 * One read, bind name `:authorityId` only. A row is skipping exactly when `Number(required) === 0`,
 * the predicate of association-engine.ts's policy read (`Number(policyRow.AttestationRequired) !== 0`
 * means required). Counts only, never ids. A failing read propagates.
 */
export async function readAttestationRows(db: AttestationPolicyDb, authorityId: string): Promise<AttestationRows> {
  let elections = 0
  let skipping = 0
  for await (const row of db.prepare(ATTESTATION_ROWS_SQL).all({ authorityId })) {
    elections++
    if (Number(row.required) === 0) skipping++
  }
  return { elections, skipping }
}

export type AttestationRefusalCode = 'token-attestation-refused' | 'platform-attestation-refused' | 'policy-skips-verification'

export const ATTESTATION_REFUSAL_CODES: readonly AttestationRefusalCode[] = Object.freeze([
  'token-attestation-refused',
  'platform-attestation-refused',
  'policy-skips-verification'
])

export class AttestationPolicyError extends Error {
  readonly code: AttestationRefusalCode

  constructor(code: AttestationRefusalCode) {
    super(`attestation policy refused (${code})`)
    this.name = 'AttestationPolicyError'
    this.code = code
  }
}

/**
 * R-27 item 3: in posture `token` a skipping row refuses (`policy-skips-verification`), because the
 * engine would associate without any verifier. Posture `production` never throws here (item 4).
 */
export function assertTokenPostureVerifies(posture: OfficerAttestationPosture, rows: AttestationRows): void {
  if (posture.kind === 'token' && rows.skipping > 0) throw new AttestationPolicyError('policy-skips-verification')
}

/** The refusal codes a verdict-count delta carries, in a fixed order: token first, then platform. */
export function classifyAttestationDelta(before: AttestationVerdictCounts, after: AttestationVerdictCounts): AttestationRefusalCode[] {
  const out: AttestationRefusalCode[] = []
  if (after.token.refused > before.token.refused) out.push('token-attestation-refused')
  if (after.platform.refused > before.platform.refused) out.push('platform-attestation-refused')
  return out
}
