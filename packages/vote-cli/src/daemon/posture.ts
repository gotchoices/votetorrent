// Party and posture at daemon start: the ONE place that names the test-posture flag set.
//
// Rules (67-CONTEXT, decision of 2026-11-24):
// - A BARE start (no test-posture key) on party `votetorrent` is ALLOWED: it is how phones join a
//   host-officer network, because the apps carry the `PARTY_ID` constant. The daemon logs
//   `posture=production` once.
// - Any test-posture key together with a reserved party (`votetorrent`, `votetorrent-relay`) is
//   refused `production-party`.
// - A bare start on `votetorrent-relay` is refused `party-reserved`: that is the loopback relay's own
//   party, never a peer party.
// - A test-posture key on a role outside its `roles` is `posture-role`; a value other than the bare
//   flag (`true`) is `posture-shape`.
// - For `acceptTokenAttestations`, 67-20's `assertTokenAttestationPosture` then runs: its
//   `production-party` maps to `production-party`, any other code to `posture-shape`.
//
// All of this runs inside `parseStartArgs`, before any mkdir, lock, dial or storage open, and again as
// the first statement of `bootPeer`, so a test that bypasses `start` meets the same refusals.
// `StartArgsError` is DEFINED here and re-exported by start-args.ts, so the two modules never cycle.
// Later plans (67-26, 67-27, 67-29) import `TEST_POSTURE_FLAGS`, `isReservedParty` and the context's
// `posture` from here, never a copy; a later test-posture START flag appends one entry to
// `TEST_POSTURE_FLAGS` and one key to `parseStartArgs`.

import { PRODUCTION_PARTY_ID, assertTokenAttestationPosture } from '../attestation/marker.js'
import type { Role } from '../ctl/protocol.js'

export type StartPosture = 'production' | 'test'

export class StartArgsError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'StartArgsError'
    this.code = code
  }
}

export interface TestPostureFlag {
  /** The command-line spelling. */
  flag: string
  /** The camelCased key `buildVerbArgs` hands the local command. */
  key: string
  /** The roles that may carry it. */
  roles: readonly Role[]
}

export const TEST_POSTURE_FLAGS: readonly TestPostureFlag[] = Object.freeze([
  Object.freeze({ flag: '--accept-token-attestations', key: 'acceptTokenAttestations', roles: Object.freeze(['officer'] as const) })
])

/** The relay's own party, by its loopback fixture and relay-only.mjs. */
const RELAY_PARTY_ID = `${PRODUCTION_PARTY_ID}-relay`

export const RESERVED_PARTIES: readonly string[] = Object.freeze([PRODUCTION_PARTY_ID, RELAY_PARTY_ID])

const normalize = (partyId: string): string => partyId.trim().toLowerCase()

export function isReservedParty(partyId: string): boolean {
  return RESERVED_PARTIES.includes(normalize(partyId))
}

/** `'test'` when any test-posture key is present in the args (whatever its value), else `'production'`. */
export function startPostureOf(args: Record<string, unknown>): StartPosture {
  return TEST_POSTURE_FLAGS.some((f) => args[f.key] !== undefined) ? 'test' : 'production'
}

export interface StartPostureInput {
  role: Role
  partyId: string
  args: Record<string, unknown>
}

export function assertStartPosture(input: StartPostureInput): void {
  const { role, partyId, args } = input
  const present = TEST_POSTURE_FLAGS.filter((f) => args[f.key] !== undefined)
  for (const f of present) {
    if (args[f.key] !== true) throw new StartArgsError('posture-shape')
    if (!f.roles.includes(role)) throw new StartArgsError('posture-role')
    if (isReservedParty(partyId)) throw new StartArgsError('production-party')
    if (f.key === 'acceptTokenAttestations') {
      try {
        assertTokenAttestationPosture({ acceptTokenAttestations: true, partyId })
      } catch (e) {
        const code = (e as { code?: unknown } | undefined)?.code
        throw new StartArgsError(code === 'production-party' ? 'production-party' : 'posture-shape')
      }
    }
  }
  if (present.length === 0 && normalize(partyId) === RELAY_PARTY_ID) throw new StartArgsError('party-reserved')
}
