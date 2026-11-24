// The founding inputs a phone officer enters on Add Network, as the CLI builds them: the network's
// name and relay, the primary authority, the one founding officer with every schema scope, the app's
// three threshold policies, no timestamp authorities, and the device user with its one signing key.
// These are CLI-owned (RESEARCH 1.C): they equal the Authority app's founding defaults
// (AddNetworkScreen + FOUNDING_OFFICER_SCOPES) and never come from test fixtures. The shape is pinned
// against the engine fixtures in test/golden/network-init-shape.json. Pure: no I/O, no clock reads
// other than the `nowMs` default.

import { ElectionType, UserKeyType } from '@votetorrent/vote-core'
import type { NetworkInit, Scope, ThresholdPolicy, User } from '@votetorrent/vote-core'
import { NetworkVerbError } from './network-verb-support.js'

/** The schema's `view Scope` codes in its order (packages/vote-core/schema/votetorrent.qsql). */
export const FOUNDING_SCOPES: readonly Scope[] = Object.freeze(['rn', 'rad', 'vrg', 'iad', 'uai', 'ceb', 'mel', 'cap', 'ik'] as Scope[])

/** The app's founding threshold policies: rn, mel and ceb at 1 (an unset scope means 1 in the schema). */
export const FOUNDING_THRESHOLD_POLICIES: readonly ThresholdPolicy[] = Object.freeze([
  Object.freeze({ policy: 'rn', threshold: 1 }),
  Object.freeze({ policy: 'mel', threshold: 1 }),
  Object.freeze({ policy: 'ceb', threshold: 1 })
] as ThresholdPolicy[])

/** Ten years: the app's device-user key lifetime. */
export const AUTHORITY_KEY_LIFETIME_MS = 10 * 365 * 24 * 60 * 60 * 1000

export type FoundingElectionType = 'official' | 'adhoc'

export interface BuildNetworkInitOptions {
  name: string
  relays: readonly string[]
  authorityName?: string
  domain?: string
  adminName?: string
  adminTitle?: string
  electionType?: FoundingElectionType
  nowMs?: number
}

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,63}$/u
const AUTHORITY_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,79}$/u
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const COMPRESSED_KEY_RE = /^(02|03)[0-9a-f]{64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const bad = (argName: string): never => {
  throw new NetworkVerbError('bad-arg', { argName })
}

function text(v: unknown, re: RegExp, argName: string): string {
  if (typeof v !== 'string' || !re.test(v)) bad(argName)
  return v as string
}

function relayList(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0) bad('relays')
  const out: string[] = []
  for (const r of v as unknown[]) {
    if (typeof r !== 'string' || !r.startsWith('/') || !r.includes('/p2p/')) bad('relays')
    out.push(r as string)
  }
  return out
}

function electionTypeOf(v: unknown): ElectionType {
  if (v === undefined || v === 'official') return ElectionType.official
  if (v === 'adhoc') return ElectionType.adhoc
  return bad('electionType')
}

function nowOf(v: unknown): number {
  if (v === undefined) return Date.now()
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) bad('nowMs')
  return v as number
}

/** The NetworkInit a `vt officer found` commits: the Add Network screen's values, no media fields. */
export function buildNetworkInit(opts: BuildNetworkInitOptions): NetworkInit {
  const name = text(opts.name, NAME_RE, 'name')
  const relays = relayList(opts.relays)
  const authorityName = opts.authorityName === undefined ? `${name} Authority` : text(opts.authorityName, AUTHORITY_NAME_RE, 'authorityName')
  const domainName = opts.domain === undefined ? 'authority.vt.invalid' : text(opts.domain, DOMAIN_RE, 'domain')
  const adminName = opts.adminName === undefined ? 'vt officer' : text(opts.adminName, NAME_RE, 'adminName')
  const adminTitle = opts.adminTitle === undefined ? 'Chair' : text(opts.adminTitle, NAME_RE, 'adminTitle')
  const electionType = electionTypeOf(opts.electionType)
  const nowMs = nowOf(opts.nowMs)
  return {
    name,
    relays,
    primaryAuthority: { name: authorityName, domainName },
    admin: {
      officers: [{ init: { name: adminName, title: adminTitle, scopes: [...FOUNDING_SCOPES] } }],
      effectiveAt: nowMs,
      thresholdPolicies: FOUNDING_THRESHOLD_POLICIES.map((p) => ({ policy: p.policy, threshold: p.threshold }))
    },
    policies: { timestampAuthorities: [], numberRequiredTSAs: 0, electionType }
  }
}

export interface BuildAuthorityUserOptions {
  id: string
  name: string
  /** A compressed secp256k1 public key, 66 lowercase hex characters. */
  publicKeyHex: string
  nowMs: number
}

/** The officer/keyholder device user: public fields only, one mobile-type (secp256k1) key with a ten-year expiry. */
export function buildAuthorityUser(opts: BuildAuthorityUserOptions): User {
  const id = text(opts.id, UUID_RE, 'id')
  const name = text(opts.name, AUTHORITY_NAME_RE, 'name')
  const key = text(opts.publicKeyHex, COMPRESSED_KEY_RE, 'publicKeyHex')
  const nowMs = nowOf(opts.nowMs)
  return { id, name, activeKeys: [{ key, type: UserKeyType.mobile, expiration: nowMs + AUTHORITY_KEY_LIFETIME_MS }] }
}

/** The `buildAuthorityUser` rules applied to a stored record; false for any other shape. */
export function isAuthorityUserShape(v: unknown): v is User {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const u = v as Record<string, unknown>
  if (Object.keys(u).some((k) => k !== 'id' && k !== 'name' && k !== 'activeKeys')) return false
  if (typeof u.id !== 'string' || !UUID_RE.test(u.id)) return false
  if (typeof u.name !== 'string' || !AUTHORITY_NAME_RE.test(u.name)) return false
  if (!Array.isArray(u.activeKeys) || u.activeKeys.length !== 1) return false
  const k = u.activeKeys[0] as Record<string, unknown> | null
  if (typeof k !== 'object' || k === null) return false
  if (Object.keys(k).some((x) => x !== 'key' && x !== 'type' && x !== 'expiration')) return false
  return typeof k.key === 'string' && COMPRESSED_KEY_RE.test(k.key) && k.type === UserKeyType.mobile && typeof k.expiration === 'number' && Number.isFinite(k.expiration)
}
