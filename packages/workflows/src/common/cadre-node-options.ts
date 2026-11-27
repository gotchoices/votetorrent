/**
 * cadre-node-options.ts — the ONE CadreNode option set of both apps and the vt CLI.
 *
 * `buildCadreNodeOptions` returns the full option object both CadreNodeProviders used to build inline
 * (and the lean rig mirrored twice more, already drifting). It carries every posture constant the project
 * decided on, and it REFUSES the unsafe role combinations: a voter must declare the edge-reader protocol
 * and a relay-only invite address source, and an authority may carry neither, so no voter daemon can
 * become an approver by omission and no authority can declare itself a non-approving reader.
 *
 * Contract with the caller (an app provider or a CLI role node):
 * - The caller creates the edge-reader refusal ONCE per boot and calls this builder on EVERY node
 *   construction, so a control-store recovery rebuild gets fresh transports and the same refusal, stores
 *   and storage provider (cadre-core keeps an injected store across stop and start; the provider tests
 *   pin that the rebuild sees the same objects).
 * - Nothing in this file reads an address, a key or a party id from anywhere but its input: no
 *   environment, no config file, no default party id. Every library value (the transport factories, the
 *   storage provider, the refusal, the schema setup function, the noise crypto) arrives through the input,
 *   so the app jest doubles and the CLI's real imports both govern what the node receives.
 * - `requireSignedSchemas: false` is a recorded project decision (see the comment at the key), not a
 *   test posture.
 * - The builder is synchronous and pure apart from calling the two transport factories once each per call.
 *   Callers pass the result to their own `new CadreNode(...)` with a single cast at that site.
 */

/** Strand-address re-ask interval (ms); see the `controlCohort` key below. */
export const STRAND_ADDR_REFRESH_MS = 30_000

/**
 * relayOnlyAddrs — the addresses this phone publishes to its cadre (spike 100, F2 decision).
 *
 * A voter is a member of the authority's cadre, and every member's control database replicates
 * every member's `CadrePeer` row, address included. So whatever this phone publishes, every other
 * voter's phone stores. The decision recorded for spike 100: phones publish ONLY relay-circuit
 * addresses (`…/p2p-circuit/p2p/<self>`), which name the authority's relay, never the phone's own
 * IP. Wired as cadre-core's `network.inviteAddressResolver`, which feeds both the redemption
 * request and the self-record refresh (`resolveInviteAddresses` → `collectSelfAddrs`). An empty
 * list is a valid answer: a phone dials out; nobody needs to dial it.
 *
 * Still visible to every member (recorded limits, not fixed here): this phone's peer id, and one
 * `CadrePeer` row per voter on every phone.
 */
export function relayOnlyAddrs(addrs: readonly string[]): string[] {
  return addrs.filter(addr => typeof addr === 'string' && addr.includes('/p2p-circuit'))
}

export type CadreNodeRole = 'authority' | 'voter'

/** The object vote-engine's `createEdgeReaderRefusal()` returns. Create it ONCE per boot. */
export interface EdgeReaderRefusalPair {
  hook(strandId: string): unknown
  control: unknown
}

/** The two libp2p transport factories, passed in so the caller's own imports (or jest doubles) are used. */
export interface CadreNodeTransportFactories {
  webSockets(): unknown
  circuitRelayTransport(init: { reservationConcurrency: number }): unknown
}

export interface CadreNodeOptionsInput {
  role: CadreNodeRole
  /** Non-empty. Both apps keep their own party constant; the CLI passes its configured one. */
  partyId: string
  privateKey: unknown
  /** Bare relay multiaddrs (cadre-core appends the circuit suffix itself); blank entries are dropped. */
  relay: readonly string[]
  /** Extra bootstrap peers such as a join code's dial hints. Bootstrap peers only, never relay targets. */
  bootstrap: readonly string[]
  storage: { open(scopeId: string): Promise<unknown> }
  transports: CadreNodeTransportFactories
  /** `protocol` is REQUIRED for a voter and FORBIDDEN for an authority. */
  edgeReader: { refusal: EdgeReaderRefusalPair; protocol?: string }
  strandDatabaseSetup(db: unknown): unknown
  /** Each store is spread into the options only when defined. */
  stores?: { strandNetworkState?: unknown; trustedOwners?: unknown; bootstrapPeers?: unknown }
  /** REQUIRED for a voter (the relay-only invite address source, read at call time); FORBIDDEN for an authority. */
  ownAddrs?: () => readonly string[]
  noiseCrypto?: unknown
  /** Default: a gater whose `denyDialMultiaddr` resolves false. */
  connectionGater?: Record<string, unknown>
  /** Default `'device'`. A voter is only ever `'device'`. */
  nodeClass?: 'device' | 'server'
}

/** The network block of the option set (a named type so the gate markers appear once, in the literal). */
export interface VoteTorrentCadreNodeNetworkOptions {
  controlCohort: { strandAddrRefreshMs: number }
  inviteAddressResolver?: () => Promise<string[]>
  transports: unknown[]
  relayAddrs: string[]
  requireRelay: false
  connectionGater: Record<string, unknown>
  noiseCrypto?: unknown
}

/** Structural shape of what `buildCadreNodeOptions` returns (the caller casts it to cadre-core's config). */
export interface VoteTorrentCadreNodeOptions {
  privateKey: unknown
  controlNetwork: { partyId: string; bootstrapNodes: string[] }
  strandNetworkState?: { store: unknown }
  trustedOwners?: { store: unknown }
  bootstrapPeers?: { store: unknown }
  nodeClass: 'device' | 'server'
  requireSignedSchemas: false
  strandFilter: { mode: 'all' }
  storage: { open(scopeId: string): Promise<unknown> }
  network: VoteTorrentCadreNodeNetworkOptions
  hibernation: { readonly enabled: false }
  strandReactivity: { enabled: true }
  strandCohortRefusal(strandId: string): unknown
  strandDatabaseSetup(db: unknown): unknown
  controlCohortRefusal: unknown
  edgeReaderProtocol?: string
}

export type CadreNodeOptionsErrorCode =
  | 'party-id-missing'
  | 'node-class-invalid'
  | 'storage-provider-missing'
  | 'transport-factory-missing'
  | 'edge-reader-refusal-missing'
  | 'edge-reader-protocol-missing'
  | 'edge-reader-protocol-forbidden'
  | 'invite-address-source-missing'
  | 'invite-address-source-forbidden'
  | 'strand-database-setup-missing'
  | 'create-node-missing'
  | 'destroy-scope-missing'
  | 'control-scope-missing'

/** Closed text per code. No message ever echoes an input value (an address, a key, a party id). */
const CODE_MESSAGES: Readonly<Record<CadreNodeOptionsErrorCode, string>> = {
  'party-id-missing': 'cadre node options need a non-empty party id',
  'node-class-invalid': "cadre node options need nodeClass 'device' or 'server' (a voter is only 'device')",
  'storage-provider-missing': 'cadre node options need a storage provider function',
  'transport-factory-missing': 'cadre node options need the webSockets and circuitRelayTransport factories',
  'edge-reader-refusal-missing': 'cadre node options need the edge-reader refusal pair (hook and control)',
  'edge-reader-protocol-missing': 'a voter node must declare the edge-reader protocol',
  'edge-reader-protocol-forbidden': 'an authority node must not declare the edge-reader protocol',
  'invite-address-source-missing': 'a voter node must supply its own-address source for the relay-only invite addresses',
  'invite-address-source-forbidden': 'an authority node must not supply an invite address source',
  'strand-database-setup-missing': 'cadre node options need the strand database setup function',
  'create-node-missing': 'cadre node boot needs a createNode function',
  'destroy-scope-missing': 'cadre node boot needs a destroyScope function',
  'control-scope-missing': 'cadre node boot needs a controlStorageScope function',
}

export class CadreNodeOptionsError extends Error {
  readonly code: CadreNodeOptionsErrorCode
  constructor(code: CadreNodeOptionsErrorCode) {
    super(CODE_MESSAGES[code])
    this.name = 'CadreNodeOptionsError'
    this.code = code
  }
}

/** Structural check on `name`, so a copy from another module graph is still recognised. */
export function isCadreNodeOptionsError(e: unknown): e is CadreNodeOptionsError {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'CadreNodeOptionsError'
}

const isFunction = (v: unknown): v is (...args: unknown[]) => unknown => typeof v === 'function'

export function buildCadreNodeOptions(input: CadreNodeOptionsInput): VoteTorrentCadreNodeOptions {
  const { role, partyId, privateKey, edgeReader, strandDatabaseSetup, stores, ownAddrs, noiseCrypto } = input
  if (typeof partyId !== 'string' || partyId.trim() === '') throw new CadreNodeOptionsError('party-id-missing')
  const nodeClass = input.nodeClass ?? 'device'
  if (nodeClass !== 'device' && nodeClass !== 'server') throw new CadreNodeOptionsError('node-class-invalid')
  if (role === 'voter' && nodeClass !== 'device') throw new CadreNodeOptionsError('node-class-invalid')
  const open = input.storage?.open
  if (!isFunction(open)) throw new CadreNodeOptionsError('storage-provider-missing')
  const { webSockets, circuitRelayTransport } = input.transports ?? ({} as Partial<CadreNodeTransportFactories>)
  if (!isFunction(webSockets) || !isFunction(circuitRelayTransport)) throw new CadreNodeOptionsError('transport-factory-missing')
  const refusal = edgeReader?.refusal
  if (!refusal || !isFunction(refusal.hook) || typeof refusal.control !== 'object' || refusal.control === null) {
    throw new CadreNodeOptionsError('edge-reader-refusal-missing')
  }
  if (!isFunction(strandDatabaseSetup)) throw new CadreNodeOptionsError('strand-database-setup-missing')
  const protocol = edgeReader.protocol
  if (role === 'voter') {
    if (typeof protocol !== 'string' || protocol === '') throw new CadreNodeOptionsError('edge-reader-protocol-missing')
    if (!isFunction(ownAddrs)) throw new CadreNodeOptionsError('invite-address-source-missing')
  } else {
    if (protocol !== undefined) throw new CadreNodeOptionsError('edge-reader-protocol-forbidden')
    if (ownAddrs !== undefined) throw new CadreNodeOptionsError('invite-address-source-forbidden')
  }

  // Relays are named by the relay-addrs key, never by a listen entry: cadre-core rejects a relay-qualified
  // listen entry at construction on a control node (libp2p would dial the relay from inside start(), during
  // the bring-up quiet period that denies exactly that dial). Entries are the BARE relay addrs; cadre-core
  // appends the circuit suffix itself. Blank entries are dropped, so an empty validated list yields []
  // (degraded, not a crash; the caller reports the config fault). The identifier is named for the relay gates.
  const CONTROL_RELAY_ADDRS = (input.relay ?? []).filter(
    (addr): addr is string => typeof addr === 'string' && addr.trim() !== '',
  )
  // Bootstrap = relays first, then the caller's extra peers (a join code's dial hints). Those hints are
  // bootstrap peers ONLY and never relay targets: a member is not necessarily a relay, and one that does not
  // answer a reservation would keep the relay supervisor re-driving it for nothing.
  const bootstrapNodes = [...new Set([...CONTROL_RELAY_ADDRS, ...(input.bootstrap ?? [])])]
  const voterOnly = role === 'voter'
  const ownAddrsFn = ownAddrs as (() => readonly string[]) | undefined

  return {
    privateKey,
    controlNetwork: { partyId, bootstrapNodes },
    // Each store is spread only when it opened. The caller reuses the same input across a recovery rebuild,
    // so the rebuilt node gets the SAME store objects.
    ...(stores?.strandNetworkState !== undefined ? { strandNetworkState: { store: stores.strandNetworkState } } : {}),
    ...(stores?.trustedOwners !== undefined ? { trustedOwners: { store: stores.trustedOwners } } : {}),
    ...(stores?.bootstrapPeers !== undefined ? { bootstrapPeers: { store: stores.bootstrapPeers } } : {}),
    nodeClass,
    // sApp-schema signing is DISABLED for VoteTorrent: a deliberate project decision, not an oversight.
    // The policy was never a VoteTorrent requirement. It arrived as an UPSTREAM fail-closed default when the
    // project de-vendored to the published cadre-core (`config.requireSignedSchemas ?? true`, which throws
    // SchemaVerificationError('missing signature') for any sAppConfig without a `signature`). VoteTorrent's
    // sApp schema has no signature, so EVERY network creation failed, reproduced on-device
    // in the release build. A literal `false` (NOT a dev-only flag, which left release builds broken) is what
    // "remove entirely" requires. The relaxation excuses ONLY an absent signature; cadre-core still rejects a
    // present-but-invalid one, so a signed schema would still be verified if VoteTorrent ever adopts signing.
    requireSignedSchemas: false,
    strandFilter: { mode: 'all' },
    // Per-scope storage: cadre-core 1.25 invokes open(scopeId) once per scope (the control scope and
    // each strand), and the returned NodeStorage holds blocks, kv and pieces for that scope.
    storage: { open },
    // CONTROL node network block: it reserves through the configured CONTROL relay(s). cadre-core forwards
    // this one object to the control node AND every strand node (strand nodes derive their own transport
    // peer id, so one relay is correct and no per-strand override exists).
    network: {
      // cadre-core 1.13 stamps the strand-addr refresh per (sibling, strand) from the sibling's OUTCOME: an
      // answer, even an empty one, waits the full default (10 min). A sibling that answered before it held the
      // strand's addresses therefore blinds this node (no strand socket for >60 s after Connect). Re-ask
      // every 30 s until the upstream fix lands.
      controlCohort: { strandAddrRefreshMs: STRAND_ADDR_REFRESH_MS },
      // Voter only (F2): publish only relay-circuit addresses to the cadre, never this phone's own IP. The
      // source is read at call time, so the resolver follows the live node.
      ...(voterOnly && ownAddrsFn ? { inviteAddressResolver: async () => relayOnlyAddrs(ownAddrsFn()) } : {}),
      transports: [
        webSockets(),
        // Cast by the global transport symbol, not structural type: the pattern for multi-copy
        // @libp2p/interface brand skew (not load-bearing on Node's single-copy graph, re-verified on device).
        circuitRelayTransport({
          // N relay entries ALONE do NOT yield N reservations under the default transport: the default
          // reservation concurrency of 1 serialises the reserve queue and drops any 2nd+ reservation. Size it
          // to the number of known control relays (never less than 1).
          reservationConcurrency: Math.max(1, CONTROL_RELAY_ADDRS.length),
        }) as unknown as ReturnType<typeof webSockets>,
      ],
      // Always-on relay reservation-seeking, scoped to the CONTROL relay(s) the caller named.
      relayAddrs: CONTROL_RELAY_ADDRS,
      // Fail-soft on the FIRST reservation attempt. cadre-core's default (requireRelay unset) throws
      // RelayReservationFailedError out of start() when that attempt lands nothing inside its budget (18 s at
      // the default link), and the boot then stops the node for the whole process: no strand network can open
      // until the app is killed. A relaunched keyholder on a loaded emulator hit exactly that while the relay
      // refused nothing and admitted a reservation within the same minute. `false` runs the SAME drive and
      // keeps the SAME background supervisor re-driving the reservation; only the throw is dropped, so a slow
      // relay or a starved JS thread costs dialability for a while instead of the session.
      requireRelay: false,
      // Permissive gater by default (loopback / emulator host dials). Per-strand enrollment gating is later scope.
      connectionGater: input.connectionGater ?? { denyDialMultiaddr: async () => false },
      // Native Noise crypto on the apps (pure-JS Noise on Hermes saturated the JS thread during bring-up);
      // the caller decides, so it is spread only when given.
      ...(noiseCrypto !== undefined ? { noiseCrypto } : {}),
    },
    hibernation: { enabled: false },
    // Change notifications (cadre-core 1.20 `strandReactivity`, optimystic cohort-topic substrate): every strand
    // node announces the commits it coordinates, and tables tagged "optimystic.network_watch" get a network
    // watch, so a screen is woken by a commit made on ANOTHER machine instead of waiting for its focus reload
    // or a timer. It is also what gives the strand node its matchmaking handlers. Cost: one cohort-topic host
    // per strand node (db-p2p builds it as a core host, 30 s renewals, even on a phone); the CLI role node
    // gains this too, so measure its RSS against the budget.
    strandReactivity: { enabled: true },
    // Keeps strand peers that declared themselves read-only edge readers (an officer's browser dashboard, which
    // stores nothing; a phone Voter) out of this node's write cohorts and coordinator choice, so a write never
    // waits on an approval that peer cannot give. Reads are unaffected. A peer is refused only on its own
    // identify, so no peer can get another one refused.
    strandCohortRefusal: refusal.hook,
    // VoteTorrent's SQL functions on each strand database before cadre-core applies the schema (patched
    // cadre-core `strandDatabaseSetup`): quereus 5.6 refuses a CHECK calling an unregistered function at
    // CREATE TABLE, so registering them after the strand opened is too late.
    strandDatabaseSetup,
    // The same refusal for the CONTROL network (VoteTorrent cadre-core patch): a paired dashboard is a cadre
    // member, and the control cohort is every member, so without it every control write (a voter's admission,
    // a join code, a record refresh) waited on the browser; with the browser unresponsive a control write took
    // well over a minute on the host. Reads are unaffected.
    controlCohortRefusal: refusal.control,
    // Voter only: a phone approves nothing (doc/architecture.md "Transaction only"). It declares itself an edge
    // reader, so every machine's refusal keeps it out of their control and strand write cohorts and coordinator
    // picks, and its strand node withdraws the storage services and stores nothing. Without it a phone asleep
    // held every write in the network for ~20 s per round (db-p2p waits on every cohort member). Its own writes
    // still land through the authority's machines.
    ...(voterOnly ? { edgeReaderProtocol: protocol as string } : {}),
  }
}
