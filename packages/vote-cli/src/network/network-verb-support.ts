// The support every officer network verb (67-24) and the later officer verb groups (67-26 election,
// 67-27 intake) stand on: the verb context type, the one refusal error, the argument checks, the
// secret-file rules (0600 files, created once, inside an existing caller-owned 0700 `secrets` dir
// outside the repo), the party guard, network access by hash (the hash is ALWAYS an argument; there
// is no shared party.json), primary-authority resolution and the ONE approval seam.
//
// No module-global mutable state. No console. Every refusal is a NetworkVerbError whose message is
// the code plus, at most, an allow-listed argument name: never a value, a path or a hash.

import { lstatSync, realpathSync, type Stats } from 'node:fs'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import type { INetworkEngine, NetworkReference, User } from '@votetorrent/vote-core'
import type { NetworksEngine } from '@votetorrent/vote-engine/rn'
import type { AuthorityJoinNode, PairMintHostNode } from '@votetorrent/workflows/authority'
import type { JoinBootstrapStore, JoinedNetworksStore, KvStorage } from '@votetorrent/workflows'
import type { ApprovalScopedVault } from '../approval/signer.js'
import { createApprovalContext, type ApprovalContext } from '../approval/token.js'
import { isReservedParty, type StartPosture } from '../daemon/posture.js'
import type { RoleNetworksEngineLike } from '../node/role-networks.js'
import { REPO_ROOT } from '../run/options.js'
import type { SecretRegistry } from '../secrecy/redact.js'
import { createPrivateFileOnce, readPrivateFile } from '../vault/private-file.js'

// ---------------------------------------------------------------------------------------------
// The verb context

/**
 * The node slice the shared network workflows take: the join node and the pair-mint host node (which
 * extends the pairing and voter-invite slices). The daemon's owner-wrapped CadreNode satisfies it at
 * runtime; `officerNode(ctx)` is the one cast.
 */
export type OfficerNode = AuthorityJoinNode & PairMintHostNode

/** The NetworksEngine slice the officer verbs use. The daemon's engine IS a NetworksEngine; `officerEngine(ctx)` is the one cast. */
export type NetworksEngineLike = Pick<
  NetworksEngine,
  'buildCreate' | 'getRecentNetworks' | 'open' | 'getFoundingAnchor' | 'getJoinAnchor' | 'getEstablishedContext' | 'joinFromStrand'
>

/** The 67-08 join stores the daemon built over its kv (`BuiltRoleNode.stores`); a join writes both. */
export interface OfficerJoinStores {
  readonly joinBootstrap: Pick<JoinBootstrapStore, 'readJoinBootstrap' | 'rememberJoinBootstrap'>
  readonly joinedNetworks: Pick<JoinedNetworksStore, 'isJoinedNetwork' | 'rememberJoinedNetwork'>
}

/**
 * THE verb context type the officer verb groups read (67-24 network, 67-26 election, 67-27 intake).
 * It is a structural subset of the daemon's `VerbContext` (src/daemon/verb-context.ts), so the daemon's
 * context is assignable to it (pinned at compile time in src/verbs/officer/registry.ts) and a spec can
 * build a small fake (test/support/fake-officer-ctx.ts). Members:
 *  - identity: `role`, `partyId`, `peerDir` (the device home, 0700), `secretsDir` (0700 `<peerDir>/secrets`);
 *  - the node: `node` (the CadreNode), `built.ownerNode` (the same node with the identity owner key
 *    restored; null only for a voter), `built.stores` (the join stores);
 *  - `relay.multiaddr` (a secret when the relay is private; a founding uses it as the network's relay);
 *  - `kv` (the peer's `node/async-storage.json`), `device.vault` (the 67-13 FileKeyVault, an
 *    `ApprovalScopedVault`; approval-class work goes through `withApproval(approval)` per call);
 *  - `secrets` (the daemon's SecretRegistry: register every per-call secret BEFORE it is written);
 *  - `user` / `saveUser` (the public User record at `node/user.json`; `loadAuthorityUser` validates it);
 *  - `engine()` (the role NetworksEngine; the daemon declares the narrow `RoleNetworksEngineLike`);
 *  - `posture` / `acceptTokenAttestations` (the daemon's posture; the party guard reads them);
 *  - `onStop?` (absent on the daemon today; a verb that holds a resource may register a detach).
 */
export interface OfficerVerbContext {
  readonly role: string
  readonly partyId: string
  readonly peerDir: string
  readonly secretsDir: string
  readonly node: object
  readonly built: {
    readonly ownerNode: object | null
    readonly stores: OfficerJoinStores
  }
  readonly relay: { readonly multiaddr: string }
  readonly kv: KvStorage
  readonly device: { readonly vault: ApprovalScopedVault }
  readonly secrets: SecretRegistry
  readonly user: User | null
  saveUser(user: User): Promise<void>
  engine(): RoleNetworksEngineLike
  readonly posture: StartPosture
  readonly acceptTokenAttestations: boolean
  onStop?(fn: () => void | Promise<void>): void
}

/** The daemon's engine is the full NetworksEngine (createRoleNetworksEngine); the context declares the narrow slice. */
export function officerEngine(ctx: Pick<OfficerVerbContext, 'engine'>): NetworksEngineLike {
  return ctx.engine() as unknown as NetworksEngineLike
}

/** The owner-wrapped node the shared workflows take. Refuses `owner-node-absent` on a voter context. */
export function officerNode(ctx: Pick<OfficerVerbContext, 'built'>): OfficerNode {
  const node = ctx.built.ownerNode
  if (node === null || typeof node !== 'object') throw new NetworkVerbError('owner-node-absent')
  return node as unknown as OfficerNode
}

// ---------------------------------------------------------------------------------------------
// The refusal error

export type NetworkVerbErrorCode =
  | 'production-party'
  | 'unknown-arg'
  | 'bad-arg'
  | 'token-required'
  | 'bad-network-hash'
  | 'bad-authority-id8'
  | 'network-unknown'
  | 'network-not-open'
  | 'authority-mismatch'
  | 'authority-unreadable'
  | 'secret-path-relative'
  | 'secret-path-in-repo'
  | 'secret-path-parent'
  | 'secret-path-mode'
  | 'secret-path-owner'
  | 'secret-path-same'
  | 'secret-file-exists'
  | 'secret-file-missing'
  | 'identity-absent'
  | 'identity-corrupt'
  | 'identity-mismatch'
  | 'owner-node-absent'
  | 'network-init-invalid'
  | 'create-unconfirmed'
  | 'preview-malformed'
  | 'preview-mismatch'
  | 'join-timeout'
  | 'join-failed'
  | `join-${string}`
  | 'not-founding-officer'
  | 'not-reachable'
  | 'not-owner'
  | 'owner-setup-unavailable'
  | 'own-code-undecodable'
  | `pairing-${string}`

const ARG_NAME_RE = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/
const DETAIL_RE = /^[a-z][a-z0-9:-]{0,40}$/

export interface NetworkVerbErrorOptions {
  /** An argument name from the verb's own allow-list; anything else is dropped. */
  argName?: string
  /** A closed-set token (e.g. a pair-mint refusal code) appended to the message; anything else is dropped. */
  detail?: string
  cause?: unknown
}

export class NetworkVerbError extends Error {
  readonly code: NetworkVerbErrorCode
  readonly argName: string | undefined
  readonly detail: string | undefined

  constructor(code: NetworkVerbErrorCode, opts: NetworkVerbErrorOptions = {}) {
    const argName = typeof opts.argName === 'string' && ARG_NAME_RE.test(opts.argName) ? opts.argName : undefined
    const detail = typeof opts.detail === 'string' && DETAIL_RE.test(opts.detail) ? opts.detail : undefined
    const tail = argName !== undefined ? ` ${argName}` : detail !== undefined ? ` ${detail}` : ''
    super(`officer verb refused (${code}${tail})`)
    this.name = 'NetworkVerbError'
    this.code = code
    this.argName = argName
    this.detail = detail
    if (opts.cause !== undefined) Object.defineProperty(this, 'cause', { value: opts.cause, enumerable: false, writable: true, configurable: true })
  }
}

// ---------------------------------------------------------------------------------------------
// Arguments

export interface CheckArgsSpec {
  readonly required: readonly string[]
  readonly optional?: readonly string[]
}

/** The colocation label 67-21 adds; the daemon routes and strips it, a direct caller may still pass it. */
const PEER_KEY = 'peer'

/**
 * Allow-list the verb's arguments: an own key outside required, optional and `peer` is `unknown-arg`
 * (the key is never echoed); a present non-string value or a missing required key is `bad-arg <name>`.
 * Returns only the allow-listed keys (never `peer`).
 */
export function checkArgs(args: Record<string, unknown>, spec: CheckArgsSpec): Record<string, string> {
  const optional = spec.optional ?? []
  const allowed = new Set<string>([...spec.required, ...optional, PEER_KEY])
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw new NetworkVerbError('unknown-arg')
  const out: Record<string, string> = {}
  for (const name of spec.required) {
    const v = args[name]
    if (typeof v !== 'string') throw new NetworkVerbError('bad-arg', { argName: name })
    out[name] = v
  }
  for (const name of optional) {
    if (!Object.hasOwn(args, name)) continue
    const v = args[name]
    if (typeof v !== 'string') throw new NetworkVerbError('bad-arg', { argName: name })
    out[name] = v
  }
  return out
}

const NETWORK_HASH_RE = /^[0-9a-f]{32}$/
const AUTHORITY_ID8_RE = /^[0-9a-f]{8}$/

export function parseNetworkHash(v: unknown): string {
  if (typeof v !== 'string' || !NETWORK_HASH_RE.test(v)) throw new NetworkVerbError('bad-network-hash')
  return v
}

export function parseAuthorityId8(v: unknown): string {
  if (typeof v !== 'string' || !AUTHORITY_ID8_RE.test(v)) throw new NetworkVerbError('bad-authority-id8')
  return v
}

// ---------------------------------------------------------------------------------------------
// The party guard

/** Refuses the production party (`votetorrent`) and the relay's own party (`votetorrent-relay`), trimmed, any case. */
export function assertTestParty(partyId: unknown): void {
  if (typeof partyId !== 'string' || isReservedParty(partyId)) throw new NetworkVerbError('production-party')
}

/**
 * The posture-aware guard `found` and `join` run first: a daemon in a TEST posture (a test-posture
 * flag such as `--accept-token-attestations`) may not found or join on a reserved party; a daemon in
 * the production posture may, because that is how phones join a host-officer network today. The
 * daemon's start already refuses a test flag on a reserved party, so this is defence in depth.
 */
export function assertNetworkParty(ctx: Pick<OfficerVerbContext, 'partyId' | 'posture' | 'acceptTokenAttestations'>): void {
  if (ctx.posture === 'test' || ctx.acceptTokenAttestations === true) assertTestParty(ctx.partyId)
}

// ---------------------------------------------------------------------------------------------
// Secret files

function tryLstat(p: string): Stats | null {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

/** The realpath of the deepest existing ancestor of `p` (never `p` itself). */
function deepestExistingAncestorRealpath(p: string): string {
  let dir = dirname(p)
  for (;;) {
    if (tryLstat(dir) !== null) {
      try {
        return realpathSync(dir)
      } catch {
        return dir
      }
    }
    const up = dirname(dir)
    if (up === dir) return dir
    dir = up
  }
}

function insideRepo(real: string): boolean {
  let root: string
  try {
    root = realpathSync(REPO_ROOT)
  } catch {
    root = resolve(REPO_ROOT)
  }
  return real === root || real.startsWith(root + sep)
}

/**
 * Where a secret may be written, checked in this order and before anything is created: absolute;
 * outside the repo (by the realpath of the deepest EXISTING ancestor, so an in-repo path is never
 * made); the parent exists, is a real directory (no symlink) named `secrets`; the parent has no
 * group/other bits; the parent is owned by this uid; the target does not exist (symlinks included).
 * Returns the normalized path. Never creates the dir: the run or the operator owns `secrets/`.
 */
export function assertSecretTarget(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new NetworkVerbError('secret-path-relative')
  const target = resolve(path)
  if (insideRepo(deepestExistingAncestorRealpath(target))) throw new NetworkVerbError('secret-path-in-repo')
  const parent = dirname(target)
  const st = tryLstat(parent)
  if (st === null || st.isSymbolicLink() || !st.isDirectory() || basename(parent) !== 'secrets') throw new NetworkVerbError('secret-path-parent')
  if ((st.mode & 0o077) !== 0) throw new NetworkVerbError('secret-path-mode')
  const uid = process.getuid?.()
  if (uid !== undefined && st.uid !== uid) throw new NetworkVerbError('secret-path-owner')
  if (tryLstat(target) !== null) throw new NetworkVerbError('secret-file-exists')
  return target
}

/** `assertSecretTarget`, then a create-once 0600 file holding `text` + newline. Returns the path. */
export function writeSecretFile(path: string, text: string): string {
  const target = assertSecretTarget(path)
  if (!createPrivateFileOnce(target, text + '\n')) throw new NetworkVerbError('secret-file-exists')
  return target
}

export const SECRET_SOURCE_MAX_BYTES = 16384

/**
 * Read a secret from an absolute 0600 file of this uid (67-13 `readPrivateFile`: O_NOFOLLOW, mode and
 * owner checked on the open fd). A missing file is `secret-file-missing`; a PrivateFileError (mode,
 * owner, not-file, too-large) propagates unchanged, naming the basename only. Returns utf8, trimmed,
 * and zero-fills the buffer.
 */
export function readSecretSource(path: string, maxBytes: number = SECRET_SOURCE_MAX_BYTES): string {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new NetworkVerbError('secret-path-relative')
  const buf = readPrivateFile(resolve(path), { maxBytes })
  if (buf === null) throw new NetworkVerbError('secret-file-missing')
  const text = buf.toString('utf8').trim()
  buf.fill(0)
  return text
}

// ---------------------------------------------------------------------------------------------
// Network access by hash

export interface KnownNetwork {
  ref: NetworkReference
  network: INetworkEngine
}

function userOrUndefined(user: User | null | undefined): User | undefined {
  if (user === null || user === undefined) return undefined
  if (typeof user !== 'object' || typeof (user as { id?: unknown }).id !== 'string') throw new NetworkVerbError('identity-corrupt')
  return user
}

/**
 * "Network access by hash" for every officer verb: the hash is an ARGUMENT (parsed here), the ref
 * comes from this peer's own recents (`network-unknown` when absent), and the network is opened
 * through the engine (cache-first) as `user`, or as the context's user record when none is given.
 */
export async function openKnownNetwork(ctx: OfficerVerbContext, networkHash: unknown, user?: User | null): Promise<KnownNetwork> {
  const hash = parseNetworkHash(networkHash)
  const engine = officerEngine(ctx)
  const recents = await engine.getRecentNetworks()
  const ref = recents.find((r) => r.hash === hash)
  if (ref === undefined) throw new NetworkVerbError('network-unknown')
  const as = userOrUndefined(user ?? ctx.user)
  const network = (await engine.open(ref, as)) as INetworkEngine
  return { ref, network }
}

export interface ResolvedPrimaryAuthority {
  network: INetworkEngine
  authority: Awaited<ReturnType<INetworkEngine['openAuthority']>>
  /** The full primary authority id: internal only, never put in a reply. */
  authorityId: string
}

/**
 * Open the network and its primary authority, checking the caller's 8-char id argument against the
 * authority the network itself names (`authority-mismatch`). A failed details read is `authority-unreadable`.
 */
export async function resolvePrimaryAuthority(
  ctx: OfficerVerbContext,
  args: { networkHash: unknown, authorityId8: unknown }
): Promise<ResolvedPrimaryAuthority> {
  const id8 = parseAuthorityId8(args.authorityId8)
  const { network } = await openKnownNetwork(ctx, args.networkHash)
  let id: string
  try {
    const details = await network.getDetails()
    id = String(details.network.primaryAuthorityId)
  } catch (e) {
    throw new NetworkVerbError('authority-unreadable', { cause: e })
  }
  if (id.slice(0, 8) !== id8) throw new NetworkVerbError('authority-mismatch')
  const authority = await network.openAuthority(id)
  return { network, authority, authorityId: id }
}

// ---------------------------------------------------------------------------------------------
// Approval

/**
 * The ONE seam where the presence-class verbs of this plan (`found`, `join`, `dashboard-code`) get
 * their approval: a `tokenFile` argument naming an absolute 0600 token file. The returned context
 * reads the file afresh on every `token()` call, so a mode or owner fault surfaces as `token-refused`
 * from the 67-20 signer, with no signature and no write.
 *
 * Client-side sources (an env var, stdin, the request body) are 67-26's per-call plumbing
 * (`withCallApproval` / `attachApprovalToken`), built on top of this function; it may extend or
 * replace it. Do not add them here.
 */
export function resolveVerbApproval(args: { tokenFile?: unknown }): ApprovalContext {
  const file = args.tokenFile
  if (file === undefined || file === null) throw new NetworkVerbError('token-required')
  if (typeof file !== 'string' || !isAbsolute(file)) throw new NetworkVerbError('secret-path-relative')
  return createApprovalContext({ file: resolve(file) })
}
