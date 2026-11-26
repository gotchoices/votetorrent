// The role node builder: ONE Node CadreNode per peer over per-scope FileRawStorage, a stable 0600 peer
// key and file-backed durable slots, built from the shared option set (`buildCadreNodeOptions`) and
// started by the shared boot sequence (`bootCadreNode`) of @votetorrent/workflows, exactly as both apps'
// CadreNodeProviders are. Port of the lean rig's node builder `buildRoleNode` with its inline option
// block REPLACED by the shared builder, its shared `party.json` replaced by a `partyId` parameter, and
// its isolation gater kept only under `--instruments`.
//
// Every cadre-core, libp2p, storage and vote-engine value is injected through `RoleNodeDeps`
// (`defaultRoleNodeDeps()` reads the real imports) so the unit specs build a node with fakes. The two
// shared functions are NOT injectable: they are the code under test. No posture key (cluster size,
// signed schemas, strand filter, hibernation, reactivity, listen addresses) is set here; the shared
// builder owns them all.
//
// A rejected boot stops the LAST node the closure made and closes every store before rethrowing the
// same error, so a failed daemon leaves no store.lock behind. The relay-reservation wait is bounded.

import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { webSockets } from '@libp2p/websockets'
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs'
import {
  CadreNode,
  PersistentBootstrapPeerStore,
  PersistentStrandNetworkStateStore,
  PersistentTrustedOwnerStore,
  controlStorageScope,
  ed25519KeyPairFromLibp2p,
  softwareOwnerSigner
} from '@serfab/cadre-core'
import { EDGE_READER_PROTOCOL, createEdgeReaderRefusal, registerVoteTorrentFunctions } from '@votetorrent/vote-engine/rn'
import {
  AUTHORITY_JOINED_NETWORKS_KEY,
  AUTHORITY_JOIN_BOOTSTRAP_KEY,
  JoinedNetworksUnreadableError,
  VOTER_JOINED_NETWORKS_KEY,
  VOTER_JOIN_BOOTSTRAP_KEY,
  bootCadreNode,
  buildCadreNodeOptions,
  createJoinBootstrapStore,
  createJoinedNetworksStore,
  sanitizeAuthorityJoinBootstrap,
  sanitizeVoterJoinBootstrap,
  type CadreNodeBootInput,
  type CadreNodeOptionsInput,
  type JoinBootstrapStore,
  type JoinedNetworksStore
} from '@votetorrent/workflows'
import {
  hostPoolRendezvous,
  readOwnerTrustClassification,
  reanchorOwnKey,
  withIdentityOwnerKey,
  type OwnerTrustNode,
  type RendezvousHostNode,
  type WithIdentityOwnerKey
} from '@votetorrent/workflows/authority'
import type { Role } from '../ctl/protocol.js'
import { last8 } from '../secrecy/redact.js'
import type { FileKvStorage } from '../vault/file-kv.js'
import { fileSlot, slotKey } from './durable-slots.js'
import { loadOrCreatePeerKey } from './peer-key.js'
import { awaitRelayReservation } from './relay-readiness.js'
import { createScopedStorage, type RawStorageLike } from './scoped-storage.js'

/** The apps' store scopes, so a CLI peer of a role persists under the same slot names as a phone of that role. */
export const AUTHORITY_CADRE_STORE_SCOPE = 'votetorrent-cadre-node'
export const VOTER_CADRE_STORE_SCOPE = 'votetorrent-voter-cadre-node'

export type RoleKind = 'authority' | 'voter'

const NODE_STOP_MS = 10_000
const RENDEZVOUS_DETACH_MS = 2_000
const RENDEZVOUS_READ_MS = 2_000
const CLOSE_STORES_MS = 5_000

export interface BuildRoleNodeOptions {
  role: Role
  label: string
  partyId: string
  peerDir: string
  relay: { multiaddr: string, peerId: string }
  /** The open `node/async-storage.json` (the AsyncStorage stand-in), owned by the caller. */
  kv: FileKvStorage
  warn: (...a: unknown[]) => void
  instruments: boolean
  relayReadyMs: number
  bootTimeoutMs: number
}

/** Every engine value the builder dereferences. `defaultRoleNodeDeps()` returns the real ones. */
export interface RoleNodeDeps {
  CadreNode: typeof CadreNode
  controlStorageScope: typeof controlStorageScope
  PersistentTrustedOwnerStore: typeof PersistentTrustedOwnerStore
  PersistentStrandNetworkStateStore: typeof PersistentStrandNetworkStateStore
  PersistentBootstrapPeerStore: typeof PersistentBootstrapPeerStore
  ed25519KeyPairFromLibp2p: typeof ed25519KeyPairFromLibp2p
  softwareOwnerSigner: typeof softwareOwnerSigner
  FileRawStorage: new (basePath: string) => RawStorageLike
  webSockets: typeof webSockets
  circuitRelayTransport: typeof circuitRelayTransport
  generateKeyPair: typeof generateKeyPair
  privateKeyToProtobuf: typeof privateKeyToProtobuf
  privateKeyFromProtobuf: typeof privateKeyFromProtobuf
  peerIdFromPrivateKey: typeof peerIdFromPrivateKey
  createEdgeReaderRefusal: typeof createEdgeReaderRefusal
  EDGE_READER_PROTOCOL: string
  registerVoteTorrentFunctions: typeof registerVoteTorrentFunctions
  withIdentityOwnerKey: typeof withIdentityOwnerKey
  reanchorOwnKey: typeof reanchorOwnKey
  readOwnerTrustClassification: typeof readOwnerTrustClassification
  hostPoolRendezvous: typeof hostPoolRendezvous
}

export function defaultRoleNodeDeps(): RoleNodeDeps {
  return {
    CadreNode,
    controlStorageScope,
    PersistentTrustedOwnerStore,
    PersistentStrandNetworkStateStore,
    PersistentBootstrapPeerStore,
    ed25519KeyPairFromLibp2p,
    softwareOwnerSigner,
    FileRawStorage,
    webSockets,
    circuitRelayTransport,
    generateKeyPair,
    privateKeyToProtobuf,
    privateKeyFromProtobuf,
    peerIdFromPrivateKey,
    createEdgeReaderRefusal,
    EDGE_READER_PROTOCOL,
    registerVoteTorrentFunctions,
    withIdentityOwnerKey,
    reanchorOwnKey,
    readOwnerTrustClassification,
    hostPoolRendezvous
  }
}

export interface RoleStores {
  joinBootstrap: JoinBootstrapStore
  joinedNetworks: JoinedNetworksStore
}

/** The 67-08 stores of a kind over the peer's kv: authority reads an unreadable joined list as a refusal, a voter as empty. */
export function createRoleStores(kind: RoleKind, kv: FileKvStorage): RoleStores {
  if (kind === 'authority') {
    return {
      joinBootstrap: createJoinBootstrapStore(kv, AUTHORITY_JOIN_BOOTSTRAP_KEY, sanitizeAuthorityJoinBootstrap),
      joinedNetworks: createJoinedNetworksStore(kv, AUTHORITY_JOINED_NETWORKS_KEY, {
        unreadable: 'reject',
        unreadableError: () => new JoinedNetworksUnreadableError()
      })
    }
  }
  return {
    joinBootstrap: createJoinBootstrapStore(kv, VOTER_JOIN_BOOTSTRAP_KEY, sanitizeVoterJoinBootstrap),
    joinedNetworks: createJoinedNetworksStore(kv, VOTER_JOINED_NETWORKS_KEY, { unreadable: 'empty' })
  }
}

export interface BuiltRoleNode {
  node: CadreNode
  /** The node with the identity owner key restored (authority only; null for a voter). */
  ownerNode: WithIdentityOwnerKey<CadreNode> | null
  /** The full peer id. No verb ever returns it; use `peerId8`. */
  peerId: string
  peerId8: string
  kind: RoleKind
  storeScope: string
  recreated: boolean
  recreatedScope: string | null
  reanchor: string | null
  ownerTrust: 'ok' | 'needs-reinvite' | 'memory-only' | null
  rendezvous: 'hosted' | 'not-hosted' | 'skipped'
  /** How long the relay reservation took to appear. */
  relayReadyMs: number
  stores: RoleStores
  /** Instruments (non-null only with `instruments`): peers this node refuses in both directions / refuses to dial. */
  isolated: Set<string> | null
  dialRefused: Set<string> | null
  destroyScope(scope: string): Promise<void>
  closeStores(): Promise<void>
  /** node stop (10 s), rendezvous detach (2 s), closeStores (5 s). Idempotent. */
  stop(): Promise<void>
}

export class BootTimeoutError extends Error {
  readonly code = 'boot-timeout' as const

  constructor() {
    super('boot-timeout')
    this.name = 'BootTimeoutError'
  }
}

const roleKind = (role: Role): RoleKind => (role === 'voter' ? 'voter' : 'authority')

function bounded<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms).unref?.())])
}

const idOf = (p: unknown): string => String((p as { toString?: () => string } | undefined)?.toString?.() ?? p)

/** The `node` cadre-core's `start()` expects, read as a plain multiaddr source. */
interface AddrSource {
  getMultiaddrs(): ReadonlyArray<unknown>
}

export async function buildRoleNode(opts: BuildRoleNodeOptions, deps: RoleNodeDeps = defaultRoleNodeDeps()): Promise<BuiltRoleNode> {
  const { partyId, peerDir, relay, kv, warn, instruments } = opts
  // 1. kind and scope
  const kind = roleKind(opts.role)
  const storeScope = kind === 'authority' ? AUTHORITY_CADRE_STORE_SCOPE : VOTER_CADRE_STORE_SCOPE
  // 2. the peer key
  const privateKey = await loadOrCreatePeerKey(peerDir, deps)
  const peerId = deps.peerIdFromPrivateKey(privateKey).toString()
  const peerId8 = last8(peerId)
  // 3. the durable stores
  const slotFor = (slotKind: 'trustedOwners' | 'strandNetworkState' | 'bootstrapPeers'): ReturnType<typeof fileSlot> =>
    fileSlot(kv, slotKey(slotKind, storeScope, partyId))
  const stores: NonNullable<CadreNodeOptionsInput['stores']> = {}
  if (kind === 'authority') {
    stores.trustedOwners = await deps.PersistentTrustedOwnerStore.open(slotFor('trustedOwners'), partyId)
    stores.strandNetworkState = await deps.PersistentStrandNetworkStateStore.open(slotFor('strandNetworkState'), partyId)
  } else {
    // The Voter provider's rule: a store that cannot be opened degrades to cadre-core's in-memory default.
    try {
      stores.trustedOwners = await deps.PersistentTrustedOwnerStore.open(slotFor('trustedOwners'), partyId)
    } catch {
      warn('[vt-node] durable store unavailable:', 'trustedOwners')
    }
    try {
      stores.bootstrapPeers = await deps.PersistentBootstrapPeerStore.open(slotFor('bootstrapPeers'), partyId)
    } catch {
      warn('[vt-node] durable store unavailable:', 'bootstrapPeers')
    }
  }
  // 4-5. the join stores
  const roleStores = createRoleStores(kind, kv)
  const bootstrap = await roleStores.joinBootstrap.readJoinBootstrap()
  // 6. scoped storage and ONE edge-reader refusal per boot
  const scoped = createScopedStorage(peerDir, deps.FileRawStorage)
  const refusal = deps.createEdgeReaderRefusal()
  // 7. instruments
  const isolated = instruments ? new Set<string>() : null
  const dialRefused = instruments ? new Set<string>() : null
  const connectionGater = instruments
    ? {
        denyDialMultiaddr: async () => false,
        denyDialPeer: async (p: unknown) => isolated!.has(idOf(p)) || dialRefused!.has(idOf(p)),
        denyInboundEncryptedConnection: async (p: unknown) => isolated!.has(idOf(p)),
        denyOutboundEncryptedConnection: async (p: unknown) => isolated!.has(idOf(p)) || dialRefused!.has(idOf(p))
      }
    : undefined
  // 8. the createNode closure: the shared builder on EVERY construction, the last node kept for the catch
  let last: CadreNode | null = null
  let ownerNode: WithIdentityOwnerKey<CadreNode> | null = null
  const createNode = (): CadreNode => {
    const input: CadreNodeOptionsInput = {
      role: kind,
      partyId,
      privateKey,
      relay: [relay.multiaddr],
      bootstrap,
      storage: { provider: (scope) => scoped.provider(scope) },
      transports: { webSockets: deps.webSockets, circuitRelayTransport: deps.circuitRelayTransport },
      edgeReader: kind === 'voter' ? { refusal, protocol: deps.EDGE_READER_PROTOCOL } : { refusal },
      strandDatabaseSetup: deps.registerVoteTorrentFunctions,
      stores,
      ...(kind === 'voter' ? { ownAddrs: () => ((last as AddrSource | null)?.getMultiaddrs?.() ?? []).map((a) => String(a)) } : {}),
      ...(connectionGater !== undefined ? { connectionGater } : {})
    }
    const options = buildCadreNodeOptions(input)
    const made = new deps.CadreNode(options as unknown as ConstructorParameters<typeof CadreNode>[0])
    if (kind === 'authority') {
      ownerNode = deps.withIdentityOwnerKey(made, privateKey as Parameters<typeof deps.withIdentityOwnerKey>[1], {
        ed25519KeyPairFromLibp2p: deps.ed25519KeyPairFromLibp2p,
        softwareOwnerSigner: deps.softwareOwnerSigner
      })
    }
    last = made
    return made
  }
  // 9. the shared boot, with the owner-trust and rendezvous steps for the authority only
  const bootInput: CadreNodeBootInput<CadreNode> = {
    partyId,
    createNode,
    destroyScope: (scope) => scoped.destroyScope(scope),
    controlStorageScope: (party) => deps.controlStorageScope(party),
    logTag: '[vt-node]',
    warn,
    ...(kind === 'authority'
      ? {
          ownerTrust: {
            storeKind: 'persistent' as const,
            reanchorOwnKey: (n: CadreNode) => deps.reanchorOwnKey(n as unknown as OwnerTrustNode),
            readOwnerTrustClassification: (n: CadreNode, k: 'persistent') => deps.readOwnerTrustClassification(n as unknown as OwnerTrustNode, k)
          },
          rendezvous: {
            host: (n: CadreNode) => deps.hostPoolRendezvous(n as unknown as RendezvousHostNode),
            shouldHost: () => true
          }
        }
      : {})
  }
  let bootTimer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    bootTimer = setTimeout(() => reject(new BootTimeoutError()), opts.bootTimeoutMs)
    bootTimer.unref?.()
  })
  let boot: Awaited<ReturnType<typeof bootCadreNode<CadreNode>>>
  let relayReadyMs = 0
  try {
    boot = await Promise.race([bootCadreNode(bootInput), timeout])
    // 10. the bounded relay reservation
    const ready = await Promise.race([awaitRelayReservation(boot.node as AddrSource, relay.peerId, { timeoutMs: opts.relayReadyMs }), timeout])
    relayReadyMs = ready.waitedMs
  } catch (e) {
    if (bootTimer !== undefined) clearTimeout(bootTimer)
    const failed = last as CadreNode | null
    if (failed !== null) await failed.stop().catch(() => undefined)
    await scoped.closeStores()
    throw e
  }
  if (bootTimer !== undefined) clearTimeout(bootTimer)

  // The rendezvous outcome, read with a short wait; the detach stays with stop().
  let rendezvous: BuiltRoleNode['rendezvous'] = 'skipped'
  if (boot.rendezvous !== null) {
    const detach = await bounded(boot.rendezvous, RENDEZVOUS_READ_MS)
    rendezvous = detach ? 'hosted' : 'not-hosted'
  }
  const rendezvousPromise = boot.rendezvous

  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      await bounded(boot.node.stop().catch(() => undefined), NODE_STOP_MS)
      if (rendezvousPromise !== null) {
        const detach = await bounded(rendezvousPromise, RENDEZVOUS_DETACH_MS)
        if (detach) await bounded(detach().catch(() => undefined), RENDEZVOUS_DETACH_MS)
      }
      await bounded(scoped.closeStores(), CLOSE_STORES_MS)
    })()
    return stopping
  }

  return {
    node: boot.node,
    ownerNode: kind === 'authority' ? ownerNode : null,
    peerId,
    peerId8,
    kind,
    storeScope,
    recreated: boot.recreated,
    recreatedScope: boot.recreatedScope,
    reanchor: boot.reanchor,
    ownerTrust: boot.ownerTrust,
    rendezvous,
    relayReadyMs,
    stores: roleStores,
    isolated,
    dialRefused,
    destroyScope: (scope) => scoped.destroyScope(scope),
    closeStores: () => scoped.closeStores(),
    stop
  }
}
