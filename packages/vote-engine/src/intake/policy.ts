// src/intake/policy.ts — Phase 62 Plan 14 (D-29, D-46)
//
// Reads the greatest `AuthorityIntakePolicy` revision for an authority (no
// row means manual re-association and no REST bridge — D-46's default) and
// implements the D-45/D-46 routing rule: the identity-fallback
// re-association path is ALWAYS officer-reviewed, whatever the policy says.

import { DEFAULT_REASSOCIATION_MODE, IntakeError, REASSOCIATION_MODES, REST_BRIDGE_URL_MAX_LENGTH } from './types.js'
import type { AuthorityIntakePolicyView, ReassociationMatchMethod, ReassociationMode, ReassociationRoute } from './types.js'
import type { IntakeQueryPort } from './query-port.js'

// https-only, no userinfo, no whitespace. A regex (not `new URL()`): React
// Native's URL implementation lacks several getters, and the row is PUBLIC
// (web-data classifies it CLASS.PUBLIC), so credentials embedded as
// userinfo must never be accepted. The host is captured so the private/local
// host refusal below can run on it.
const REST_BRIDGE_URL_PATTERN = /^https:\/\/([A-Za-z0-9.-]+)(:[0-9]{1,5})?([/?#][^\s]*)?$/

/** IPv4 blocks a bridge URL must never point at: [network as a 32-bit integer, prefix length]. */
const REFUSED_IPV4_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [ipv4ToInt(0, 0, 0, 0), 8],
  [ipv4ToInt(10, 0, 0, 0), 8],
  [ipv4ToInt(100, 64, 0, 0), 10],
  [ipv4ToInt(127, 0, 0, 0), 8],
  [ipv4ToInt(169, 254, 0, 0), 16],
  [ipv4ToInt(172, 16, 0, 0), 12],
  [ipv4ToInt(192, 0, 0, 0), 24],
  [ipv4ToInt(192, 0, 2, 0), 24],
  [ipv4ToInt(192, 168, 0, 0), 16],
  [ipv4ToInt(198, 18, 0, 0), 15],
  [ipv4ToInt(198, 51, 100, 0), 24],
  [ipv4ToInt(203, 0, 113, 0), 24],
  [ipv4ToInt(224, 0, 0, 0), 4],
  [ipv4ToInt(240, 0, 0, 0), 4]
]

const REFUSED_HOST_SUFFIXES = ['.localhost', '.local', '.lan', '.internal', '.home.arpa'] as const

function ipv4ToInt (a: number, b: number, c: number, d: number): number {
  return ((a * 256 + b) * 256 + c) * 256 + d
}

function inBlock (address: number, network: number, prefix: number): boolean {
  const size = 2 ** (32 - prefix)
  return Math.floor(address / size) === Math.floor(network / size)
}

/**
 * True when `host` names the phone's own network rather than a public bridge
 * (initial/G1 IN-03): localhost and the local-only suffixes, single-label
 * hosts, non-canonical numeric spellings of an address, and the private,
 * loopback, link-local, shared, documentation, benchmarking, multicast and
 * reserved IPv4 blocks. One trailing dot is stripped first.
 *
 * Insider-only, TLS-only SSRF hardening: a public DNS name that resolves to a
 * private address is NOT caught here (a recorded residual). IPv6 literals are
 * already refused by the URL pattern (no brackets). Not `new URL()`: React
 * Native lacks its getters.
 */
export function isPrivateOrLocalBridgeHost (host: string): boolean {
  const h = (host.endsWith('.') ? host.slice(0, -1) : host).toLowerCase()
  if (h.length === 0 || !h.includes('.')) return true
  if (h === 'localhost') return true
  if (REFUSED_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix))) return true
  const labels = h.split('.')
  if (labels.some((label) => label.startsWith('0x'))) return true
  if (/^[0-9.]+$/.test(h)) {
    const canonical = labels.length === 4 && labels.every((l) => /^(0|[1-9][0-9]{0,2})$/.test(l) && Number(l) <= 255)
    if (!canonical) return true
    const [a, b, c, d] = labels.map(Number) as [number, number, number, number]
    const address = ipv4ToInt(a, b, c, d)
    return REFUSED_IPV4_BLOCKS.some(([network, prefix]) => inBlock(address, network, prefix))
  }
  return false
}

export function isValidRestBridgeUrl (url: unknown): url is string {
  if (typeof url !== 'string' || url.length < 1 || url.length > REST_BRIDGE_URL_MAX_LENGTH) return false
  const match = REST_BRIDGE_URL_PATTERN.exec(url)
  return match !== null && !isPrivateOrLocalBridgeHost(match[1]!)
}

interface RawPolicyRow {
  readonly Revision: unknown
  readonly RestBridgeUrl: unknown
  readonly ReassociationMode: unknown
  readonly SetAt: unknown
}

function defaultView (authorityId: string): AuthorityIntakePolicyView {
  return {
    authorityId,
    revision: 0,
    restBridgeUrl: null,
    reassociationMode: DEFAULT_REASSOCIATION_MODE,
    setAt: null,
    isDefault: true
  }
}

/** Defensive reader: a forged/corrupt row never produces an invalid view — it falls back field by field. */
export function normalizeIntakePolicyRow (
  authorityId: string,
  row: RawPolicyRow | undefined
): AuthorityIntakePolicyView {
  if (row === undefined) return defaultView(authorityId)

  const revisionNumber = Number(row.Revision)
  if (!Number.isSafeInteger(revisionNumber) || revisionNumber < 1) {
    return defaultView(authorityId)
  }
  const restBridgeUrl = isValidRestBridgeUrl(row.RestBridgeUrl) ? row.RestBridgeUrl : null
  const mode: ReassociationMode = (REASSOCIATION_MODES as readonly string[]).includes(row.ReassociationMode as string)
    ? (row.ReassociationMode as ReassociationMode)
    : DEFAULT_REASSOCIATION_MODE
  const setAt = typeof row.SetAt === 'string' ? row.SetAt : null

  return { authorityId, revision: revisionNumber, restBridgeUrl, reassociationMode: mode, setAt, isDefault: false }
}

export async function readIntakePolicyFrom (port: IntakeQueryPort, authorityId: string): Promise<AuthorityIntakePolicyView> {
  if (typeof authorityId !== 'string' || authorityId.length === 0) {
    throw new IntakeError('invalid-argument', 'readIntakePolicyFrom: authorityId must be a non-empty string')
  }
  const rows = await port.query<RawPolicyRow>(
    'select Revision, RestBridgeUrl, ReassociationMode, SetAt from AuthorityIntakePolicy where AuthorityId = :authorityId order by Revision desc limit 1',
    { authorityId }
  )
  return normalizeIntakePolicyRow(authorityId, rows[0])
}

/**
 * D-45/D-46: `'automatic'` applies ONLY when the policy says automatic AND
 * the match method is `'code'` — the identity fallback always routes to
 * manual review, whatever the policy's `reassociationMode` is. 62-18
 * applies this route.
 */
export function reassociationRouteFor (
  policy: Pick<AuthorityIntakePolicyView, 'reassociationMode'>,
  matchMethod: ReassociationMatchMethod
): ReassociationRoute {
  return policy.reassociationMode === 'automatic' && matchMethod === 'code' ? 'automatic' : 'manual'
}
