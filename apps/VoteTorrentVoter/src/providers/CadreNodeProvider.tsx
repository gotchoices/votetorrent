/**
 * D-03: This file is the ONLY place `@serfab/cadre-core`,
 * `@optimystic/db-p2p-storage-rn`, and `rn-leveldb` are imported for the
 * CadreNode app lifecycle. They MUST NOT appear under packages/vote-engine/.
 */

import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from "react";
import type { PropsWithChildren } from "react";
import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';
import { openOptimysticRNDb, loadOrCreateRNPeerKey } from '@optimystic/db-p2p-storage-rn';
import { createScopedRnStorageProvider } from '../engines/storage-guard';
import { isUnrestorableControlSchemaError } from '../engines/control-schema-recovery';
import { CadreNode, controlStorageScope } from '@serfab/cadre-core';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import bootstrapConfigDoc from '../../bootstrap.config.json';
import { readBootstrapConfig, type BootstrapConfigFault } from '../config/bootstrap-config';
import { relayOnlyAddrs } from '../config/relay-only-addrs';
import { readJoinBootstrap } from '../engines/join-bootstrap';
import { openBootstrapPeerStore, openTrustedOwnerStore } from '../engines/rn-durable-slot';
import { noiseCryptoForNode } from '../engines/noise-crypto-config';

// ---------------------------------------------------------------------------
// Context type
// ---------------------------------------------------------------------------

interface CadreNodeContextType {
  /** The live CadreNode instance (null until started). */
  node: InstanceType<typeof CadreNode> | null;
  /**
   * The once-per-mount settle of the node start (#99; mirrors the Authority's `nodeSettled`
   * 'ready' | 'failed', as React state so consumers react through effect deps). 'starting' from
   * mount until start() settles; then 'ready' (set in the same commit as `node`) or 'failed'
   * (start() rejected, including the control-recreate retry). Changes at most once per mount.
   */
  nodeStatus: 'starting' | 'ready' | 'failed';
  /** Event-driven sync state derived from CadreNodeEvents (D-10 — no polling). */
  syncState: 'connected' | 'syncing' | 'offline';
  /**
   * A bootstrap-configuration fault, distinct from being offline: offline
   * means we could not reach peers, a fault means we were never told which
   * peers to reach (D-14). `null` when `bootstrap.config.json` parsed to a
   * valid, non-empty address list, OR when a network join left this phone dial targets
   * (spike 100: a joined voter's bootstrap comes from its join code, not the shipped file).
   */
  configFault: BootstrapConfigFault | null;
  /**
   * Re-read the join bootstrap a network join just stored, so `configFault` clears without a
   * restart. Optional so test doubles of this context need not provide it.
   */
  refreshJoinBootstrap?: () => Promise<void>;
  /**
   * Returns the number of connected peers for a given strandId.
   * Reads node.getStrand(strandId).connectedPeers ?? 0.
   */
  connectedPeers: (strandId: string) => number;
}

const CadreNodeContext = createContext<CadreNodeContextType | null>(null);

/**
 * useCadreNode — consume the CadreNode context.
 * Must be called from a component under CadreNodeProvider.
 */
export function useCadreNode(): CadreNodeContextType {
  const ctx = useContext(CadreNodeContext);
  if (!ctx) {
    throw new Error("useCadreNode must be used within a CadreNodeProvider");
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// D-14: bootstrap addresses now come from `bootstrap.config.json` (app root),
// parsed and validated by `readBootstrapConfig` (src/config/bootstrap-config.ts)
// — the same mechanism, document shape and fault taxonomy as the sibling RN
// app and the browser's `apps/VoteTorrentPublic/src/peer/config.js` (56-06).
// The prior pair of hard-coded, sentinel-carrying constants that used to
// stand here is gone; see `src/config/bootstrap-config.ts`'s own header and
// `.planning/todos/completed/` for the retired shape and why it had to go.
//
// The committed document ships an EMPTY bootstrapNodes list, which
// readBootstrapConfig reports as a fault (kind 'missing', reason
// 'empty-address-list') rather than a silent solo boot — see configFault
// below.
//
// Correcting a stale claim this block used to carry: the P2P-06 replication
// proof harness does NOT rewrite this file. `scripts/run-replication-proof.sh`
// names `src/engines/replication-proof-runner.ts` as its CONFIG_FILE, and that
// dev harness keeps its own sentinel deliberately (see the plan's threat model
// / 56-10-SUMMARY.md for the full survivor list).
// ---------------------------------------------------------------------------
const PARTY_ID = 'votetorrent';

/** Node-local store scope (the same name as the peer-identity store below). */
const CADRE_STORE_SCOPE = 'votetorrent-voter-cadre-node';

/** Strand-address re-ask interval (ms); see the `controlCohort` comment in the CadreNode config. */
const STRAND_ADDR_REFRESH_MS = 30_000;

const bootstrapConfig = readBootstrapConfig(bootstrapConfigDoc);

/**
 * resolveBootstrapNodes — blank-safe single-address guard (P2P-02).
 *
 * Pure + exported for unit testing without booting a real (ESM-only) CadreNode.
 *
 * Returns [] for an empty, undefined or whitespace-only address — booting a
 * CadreNode with an empty bootstrapNodes array is the valid offline/solo case
 * and does NOT throw (clean cold start, no red toast). Returns [addr] for
 * anything else, so the bootstrap dial / real P2P path stays reachable. The
 * input source changed (D-14 — a validated config document instead of a
 * hard-coded constant); this function's signature and contract did not.
 */
export function resolveBootstrapNodes(addr: string): string[] {
  if (!addr || !addr.trim()) {
    return [];
  }
  return [addr];
}

// The `STRAND_RELAY_LISTEN_ADDRS` constant that stood here is REMOVED.
//
// It was already dead: spike 062 retired the `strandNetwork` per-node-type override on
// cadre-core 0.10.0 (upstream gave each strand node its own derived transport peerId), and
// nothing has read this constant since — only its own declaration and a comment referenced it.
//
// It is removed rather than left dead because it CONSTRUCTED the relay-qualified
// `<addr>/p2p-circuit` shape, which cadre-core 0.12.0 now rejects outright on a control node.
// Leaving it would keep a fatal, load-bearing-looking pattern in a file whose relay config is
// the exact thing 0.12.0 changed. Relays are named by `network.relayAddrs` below.

// cadre-core 0.12.0: relays are named by `network.relayAddrs`, NOT by a relay-qualified
// `network.listenAddrs` entry — the old shape is now REJECTED at construction on a control
// node ("network.listenAddrs names a relay directly ... Move the relay to
// network.relayAddrs, which reserves after bring-up").
//
// WHY upstream changed it: a `<relay>/p2p-circuit` listen entry takes libp2p's 'configured'
// route, which dials the relay from inside `libp2p.start()` — during the bring-up quiet
// period that denies exactly that dial, so `listen()` fails and the transport manager's
// FATAL_ALL aborts start. `relayAddrs` takes the 'search' route (one bare `/p2p-circuit`
// listener, no dial) and CadreNode.start() drives the reservation explicitly once the
// control database is up. cadre-core's default is fail-fast (a first attempt that lands nothing
// throws RelayReservationFailedError out of start()); this provider sets `requireRelay: false`
// below, so a slow relay costs dialability for a while instead of the node.
//
// Entries are the BARE relay addrs; cadre-core appends `/p2p-circuit` itself. Still routed
// through the blank-safe resolveBootstrapNodes guard per address, so an empty validated
// address list yields [] (degraded, not a crash) — see configFault above for why an empty
// list is now a reported fault rather than a silent one.
const CONTROL_RELAY_ADDRS = bootstrapConfig.addrs.flatMap(resolveBootstrapNodes);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * CadreNodeProvider — P2P-02
 *
 * Boots a CadreNode for the app lifecycle. Constructs the node once via useRef,
 * starts it inside a useEffect (non-blocking initial render — D-06), persists
 * peerId across restarts via loadOrCreateRNPeerKey (D-06 / T-22-04).
 *
 * Registers CadreNode event listeners in a separate effect to derive an
 * event-driven syncState. No polling or setInterval (D-10).
 *
 * Wrap AppProvider with CadreNodeProvider at the app root
 * (CadreNodeProvider outer, AppProvider inner).
 */
export function CadreNodeProvider({ children }: PropsWithChildren) {
  // syncState 'offline' by default — updated by CadreNode events (D-10).
  const [syncState, setSyncState] = useState<'connected' | 'syncing' | 'offline'>('offline');
  // nodeRef holds the stable CadreNode instance (created once per mount).
  const nodeRef = useRef<InstanceType<typeof CadreNode> | null>(null);
  // nodeState is the node instance exposed via context (set after construction).
  const [node, setNode] = useState<InstanceType<typeof CadreNode> | null>(null);
  const [nodeStatus, setNodeStatus] = useState<'starting' | 'ready' | 'failed'>('starting');
  // Spike 100: how many dial targets a network join stored (0 = none; the shipped file decides).
  const [joinBootstrapCount, setJoinBootstrapCount] = useState(0);
  const refreshJoinBootstrap = useCallback(async () => {
    setJoinBootstrapCount((await readJoinBootstrap()).length);
  }, []);

  // Boot effect: construct + start the CadreNode.
  // Runs once on mount ([] dep array). node.start() is NOT called in the
  // provider body — must not block initial render (D-06 / T-22-03).
  useEffect(() => {
    let isMounted = true;
    let localNode: InstanceType<typeof CadreNode> | null = null;

    async function bootNode() {
      // D-14: a config fault does not block boot — the node still constructs
      // and starts (degraded, solo), it is just loud about why. Exactly one
      // console.error, naming only the closed kind/reason tokens — never the
      // document, never an address (T-56-10-03).
      if (bootstrapConfig.fault) {
        console.error(
          '[CadreNodeProvider] bootstrap config fault:',
          bootstrapConfig.fault.kind,
          bootstrapConfig.fault.reason,
        );
      }

      try {
        // Peer-identity store — 'votetorrent-voter-cadre-node' gives a stable
        // peerId across app restarts (D-06 / T-22-04). This handle is used ONLY
        // for loadOrCreateRNPeerKey; block storage is per-scope (see below).
        // Namespaced distinct from the authority app's 'votetorrent-cadre-node'
        // to avoid any cross-app on-device store collision.
        const identityDb = openOptimysticRNDb({
          openFn: (n, c, e) => new LevelDB(n, c, e),
          WriteBatch: LevelDBWriteBatch,
          name: 'votetorrent-voter-cadre-node',
        });
        const privateKey = await loadOrCreateRNPeerKey(identityDb);

        // ISO-01 (cross-network isolation fix): the storage provider MUST open a
        // DISTINCT LevelDB per scope, keyed by the id cadre-core passes in.
        //
        // Root cause it fixes: the optimystic plugin maps every table to the
        // collection URI `tree://default/{TableName}`
        // (quereus-plugin-optimystic chunk-HPFDTDHY.js:1885) and caches the local
        // transactor under the key `local:libp2p` (getTransactorKey — no
        // networkName/strandId). Neither the collection URI nor the transactor key
        // carries the strandId. The ONLY thing that isolates one strand's blocks
        // from another's is the LevelDBRawStorage instance (the underlying LevelDB
        // directory). cadre-core is built for exactly this: it calls
        // `provider(strandId)` per strand (strand-instance-manager.js:21) and
        // `provider(controlStorageScope(partyId))` — 'control-<hex(partyId)>' — for the control DB.
        //
        // The previous `() => new LevelDBRawStorage(db)` IGNORED that argument and
        // returned one shared LevelDB, so EVERY network's Authority/Officer/Admin
        // rows landed in the same `tree://default/Authority` keyspace. The
        // first-network "shoe-in" InsertValid branch requires
        // `(select count(*) from Authority) = 1`, which only holds for the very
        // first network on a fresh install — every subsequent create saw count >= 2
        // and failed `QuereusError: CHECK constraint failed: InsertValid`
        // (confirmed on-device 2026-06-25: pre-create counts User=1 Authority=3
        // Admin=1, then Authority 3->4 within the txn → read-your-own-writes works,
        // the count was simply contaminated by prior networks).
        //
        // Fix: open (and cache) one LevelDB per scope id. The id is the strand hash
        // (H16 hex) or the literal 'control'; both are filesystem-safe, but
        // sanitize defensively to match cadre-core's own getStrandStoragePath
        // convention (replace(/[^a-zA-Z0-9-]/g, '_')).
        // ISO-01 per-scope storage + release-build persistence guardrail — see engines/storage-guard.ts.
        const scopedStorageProvider = createScopedRnStorageProvider('votetorrent-voter-strand');

        // Spike 100: a joined phone's bootstrap is the authority's member machines its join code
        // named (engines/join-bootstrap.ts). They are bootstrap peers ONLY, never `relayAddrs`: a
        // member is not necessarily a relay, and one that does not answer a reservation would
        // keep the relay supervisor re-driving it for nothing.
        const joinBootstrap = await readJoinBootstrap();
        if (isMounted) setJoinBootstrapCount(joinBootstrap.length);
        const bootstrapNodes = [...new Set([...CONTROL_RELAY_ADDRS, ...joinBootstrap])];
        // Spike 100: persist the trusted-owner anchor (the owner keys a redeemed invitation pins)
        // and the bootstrap-peer store across restarts — see engines/rn-durable-slot.ts for the
        // measured failure without them.
        // A store that cannot be opened degrades to cadre-core's in-memory default (what every
        // launch had before) rather than blocking boot; the closed token says which one.
        const trustedOwnerStore = await openTrustedOwnerStore(PARTY_ID, CADRE_STORE_SCOPE).catch(() => {
          console.warn('[CadreNodeProvider] trusted-owner store unavailable; using the in-memory anchor');
          return undefined;
        });
        const bootstrapPeerStore = await openBootstrapPeerStore(PARTY_ID, CADRE_STORE_SCOPE).catch(() => {
          console.warn('[CadreNodeProvider] bootstrap-peer store unavailable; using the in-memory store');
          return undefined;
        });

        // The resolver below reads the node's live addresses, so it needs the node it belongs to.
        const nodeHolder: { current: InstanceType<typeof CadreNode> | null } = { current: null };
        const track = (made: InstanceType<typeof CadreNode>) => {
          nodeHolder.current = made;
          return made;
        };
        const makeNode = () => track(new CadreNode({
          privateKey,
          controlNetwork: { partyId: PARTY_ID, bootstrapNodes },
          ...(trustedOwnerStore ? { trustedOwners: { store: trustedOwnerStore } } : {}),
          ...(bootstrapPeerStore ? { bootstrapPeers: { store: bootstrapPeerStore } } : {}),
          profile: 'transaction',
          // Published @serfab/cadre-core@0.8.1 added a fail-closed sApp-schema signature
          // policy (requireSignedSchemas defaults true): the unsigned `org.votetorrent`
          // demo schema (rn-db-factory sAppConfig has id:'org.votetorrent' + no signature)
          // is rejected at strand bring-up with SchemaVerificationError('missing
          // signature'), which surfaces on-device as `seedDevNetwork failed`. Relax the
          // policy in DEV only — the documented dev/test relaxation for the unsigned demo
          // schema, at parity with the authority app's proof runners
          // (strand-persistence-proof-runner.ts / replication-proof-runner.ts) and the
          // p2p-probe dev harness. Production sApp-schema signing (id = author ed25519
          // pubkey + signSchema()) is a separate productionization task. Discovered by the
          // 44-10 on-device boot proof (jest is blind — it does not boot a real CadreNode).
          // Was `!__DEV__`, which relaxed the policy for debug builds only and therefore
          // left RELEASE builds hitting SchemaVerificationError('missing signature') —
          // the unsigned `org.votetorrent` schema never became signed, so the release
          // branch was permanently broken rather than merely strict. sApp-schema signing
          // is now disabled outright for VoteTorrent (see the authority app's
          // CadreNodeProvider for the full upstream trace): it was never a project
          // requirement, only an upstream cadre-core@0.8.1 fail-closed default.
          requireSignedSchemas: false,
          strandFilter: { mode: 'all' },
          // ISO-01: per-scope storage. cadre-core invokes provider(scopeId) with the
          // strandId for each strand and 'control' for the control DB — one distinct
          // LevelDB per scope isolates each network's collections.
          storage: { provider: scopedStorageProvider },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          // CONTROL node network — reserves through the drone's CONTROL relay (P2P-11 41-11).
          network: {
            // Same as the Authority (D-2): cadre-core 1.13+ waits the full default (10 min) after a
            // sibling's empty strand-addr answer, which blinds a phone that joined before the
            // sibling held the strand's addresses. Re-ask every 30 s until the upstream fix lands.
            controlCohort: { strandAddrRefreshMs: STRAND_ADDR_REFRESH_MS },
            // Spike 100 (F2 decision): publish only relay-circuit addresses to the cadre, never
            // this phone's own IP — see config/relay-only-addrs.ts.
            inviteAddressResolver: async () =>
              relayOnlyAddrs((nodeHolder.current?.getMultiaddrs() ?? []).map(addr => addr.toString())),
            transports: [
              webSockets(),
              // D-10: cast by the global transportSymbol, not structural type — the
              // sereus-chat pattern for multi-copy @libp2p/interface brand-skew
              // (Probe 4, 41-01: not load-bearing on Node's single-copy graph but
              // re-verified at Metro/Hermes on device).
              circuitRelayTransport({
                // PROBE 5 (41-01, EXERCISED): N relay-qualified listenAddrs ALONE do
                // NOT yield N reservations under the default circuitRelayTransport() —
                // DEFAULT_RESERVATION_CONCURRENCY=1 serializes the reserve queue and
                // drops any 2nd+ reservation via reserveQueue.clear(). Size concurrency
                // to the number of known control relays driving CONTROL_RELAY_ADDRS
                // (never less than 1).
                reservationConcurrency: Math.max(1, CONTROL_RELAY_ADDRS.length),
              }) as unknown as ReturnType<typeof webSockets>,
            ],
            // D-03/D-05: always-on relay reservation-seeking (P2P-08 drone-relay path),
            // relay-qualified — but scoped to the drone's CONTROL relay (P2P-11 41-11).
            // The STRAND relay moves to strandNetwork below, so the control and strand
            // libp2p nodes no longer collide at one relay under this peer's shared PeerId.
            relayAddrs: CONTROL_RELAY_ADDRS,
            // Fail-soft on the FIRST reservation attempt (same as the Authority, outer 5f8e7b2c).
            // cadre-core's default (requireRelay unset) throws RelayReservationFailedError out of
            // start() when that attempt lands nothing inside its budget (18 s at the default link),
            // and the catch below then stops the node for the whole process: VoterAppProvider waits
            // for a node before it re-opens a joined network, so the phone never re-attaches until
            // the app is killed. 64-53 hit exactly that on a relaunched Authority keyholder while the
            // relay admitted a reservation within the same minute. `false` runs the SAME drive and
            // keeps the SAME background supervisor re-driving the reservation; only the throw is
            // dropped.
            requireRelay: false,
            // Permissive gater — allows loopback / emulator host dials (D-11).
            // Per-strand enrollment gating is v2.x scope.
            connectionGater: { denyDialMultiaddr: async () => false },
            // Native Noise crypto (react-native-quick-crypto) for the control node AND every
            // strand node, as on the Authority (spike 093): pure-JS Noise on Hermes saturates the
            // JS thread during bring-up. See engines/noise-crypto-config.ts.
            noiseCrypto: noiseCryptoForNode(),
          } as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          // On cadre-core 0.10.0 the `strandNetwork` override block is REMOVED.
          //
          // It was VT's 41-11 workaround for the shared-peerId circuit-relay-v2 collision: give
          // strand nodes a SECOND relay identity so the relay could not misroute their streams
          // onto the control connection. Upstream fixed the ROOT CAUSE instead — each strand
          // node now derives its OWN transport peerId via
          // `strandTransportKey(identityKey, strandId)` — so one relay is correct and the
          // two-relay topology is obsolete.
          //
          // IMPORTANT (supersedes the earlier "peer id duplication" framing): a peerId is NO
          // LONGER the cadre's authority key. Every libp2p node a cadre runs gets its own
          // transport identity; cadre AUTHORITY is unchanged and stays on the control node,
          // where the peerId->authority derivation (`ed25519PublicKeyB64FromPeerId`) is a
          // control-network path only. The collision was never an authority/owner problem —
          // it was one identity being reused across several libp2p nodes, and it is resolved
          // by letting each node hold its own id.
          //
          // Both keys this block carried are DEAD CONFIG on 0.10.0 (zero occurrences in the
          // published types/dist):
          //   - `strandNetwork`        — the key our now-retired yarn-patch added
          //   - `strandBootstrapNodes` — replaced by `resolveCohortSeed`, which derives strand
          //     peers from the CONTROL cohort (`queryCadrePeers()` -> siblings with a live
          //     control connection -> `/sereus/strand-addr/1.0.0` RPC), not from an
          //     app-supplied strand multiaddr.
          //
          // Strand nodes therefore inherit `network` above (the single control relay).
          hibernation: { enabled: false },
          // Change notifications (cadre-core 1.20 `strandReactivity`, optimystic cohort-topic substrate): every
          // strand node announces the commits it coordinates, and tables tagged "optimystic.network_watch" get a
          // network watch, so a screen (useStrandChanges) is woken by a commit made on ANOTHER machine instead of
          // waiting for its focus reload or a timer. It is also what gives the strand node its matchmaking
          // handlers (Voter: pool-matchmaking-ports.ts). Cost: one cohort-topic host per strand node (db-p2p
          // builds it as a core host, 30 s renewals, even on a phone); measure CPU on the Redmi before release.
          strandReactivity: { enabled: true },
        }));

        // node.start() is inside useEffect — never blocks initial render (D-06 / T-22-03).
        localNode = makeNode();
        try {
          await localNode.start();
        } catch (startError) {
          // Spike 105: a control store an older cadre-core wrote (1.13 -> 1.14: Revocation.RowIsGone
          // still references the dropped PendingJoin) can be neither migrated nor restored, so every
          // launch fails. cadre-core's policy is to recreate it. Recreate ONLY the control scope —
          // the peer key and every network's strand store stay — and start once more.
          if (!isUnrestorableControlSchemaError(startError)) throw startError;
          const controlScope = controlStorageScope(PARTY_ID);
          console.warn(`[CadreNodeProvider] control store '${controlScope}' was written by an older cadre-core and cannot be migrated; recreating it`);
          await localNode.stop().catch(() => undefined);
          await scopedStorageProvider.destroyScope(controlScope);
          localNode = makeNode();
          await localNode.start();
        }

        if (isMounted) {
          nodeRef.current = localNode;
          setNode(localNode);
          setNodeStatus('ready');
        } else {
          // Component unmounted before start completed — clean up.
          await localNode.stop().catch(() => undefined);
        }
      } catch (e) {
        console.error('[CadreNodeProvider] Boot error:', e instanceof Error ? e.stack : String(e));
        try {
          await localNode?.stop();
        } catch {
          // ignore stop errors
        }
        if (isMounted) setNodeStatus('failed');
      }
    }

    bootNode();

    return () => {
      isMounted = false;
      // Stop on unmount. Errors are swallowed since the component is gone.
      nodeRef.current?.stop().catch(() => undefined);
      nodeRef.current = null;
    };
    // Empty dep array: one boot per mount.
  }, []);

  // Event-driven sync state effect. Re-runs when node is set (after boot).
  // Registers CadreNode event listeners; returns cleanup that removes them.
  // NO polling (D-10 hard requirement — no setInterval anywhere).
  //
  // First-sync gate (quick task 260928-kkf, mirrors the authority app's provider):
  // cadre-core emits `strand:started` (payload `{strandId}` only) for a GATED joiner
  // whose `database` is still unset — `onStrandStarted` used to map that
  // unconditionally to 'connected', which is wrong for exactly the joiner this gate
  // exists for. Fix: read `node.getStrand(strandId)` — `database` unset means the
  // strand is still gated (not yet writable) ⇒ 'syncing'; `database` present, OR no
  // strandId / no instance at all, means the prior 'connected' behaviour is still
  // correct. Checked via `database` PRESENCE, not `status`, because a gated instance
  // can also read 'idle' — status is not the signal here. `strand:writable` is the
  // gate's OWN resolution event; nothing listened for it before this fix.
  useEffect(() => {
    if (!node) return;

    const onConnected = () => setSyncState('connected');
    const onStrandStarted = (e?: { strandId?: string }) => {
      const instance = e?.strandId ? node.getStrand(e.strandId) : undefined;
      setSyncState(instance && !instance.database ? 'syncing' : 'connected');
    };
    const onStrandWritable = () => setSyncState('connected');
    const onStrandIdle = () => setSyncState('syncing');
    const onStrandError = () => setSyncState('offline');
    const onDisconnected = () => setSyncState('offline');

    node.on('control:connected', onConnected);
    node.on('strand:started', onStrandStarted);
    node.on('strand:writable', onStrandWritable);
    node.on('strand:idle', onStrandIdle);
    node.on('strand:error', onStrandError);
    node.on('control:disconnected', onDisconnected);

    return () => {
      node.off('control:connected', onConnected);
      node.off('strand:started', onStrandStarted);
      node.off('strand:writable', onStrandWritable);
      node.off('strand:idle', onStrandIdle);
      node.off('strand:error', onStrandError);
      node.off('control:disconnected', onDisconnected);
    };
  }, [node]);

  // connectedPeers reads live data from the StrandInstance (no polling — D-10).
  const connectedPeers = useCallback(
    (strandId: string): number => {
      if (!nodeRef.current) return 0;
      return nodeRef.current.getStrand(strandId)?.connectedPeers ?? 0;
    },
    [],
  );

  return (
    <CadreNodeContext.Provider
      value={{
        node,
        nodeStatus,
        syncState,
        configFault: joinBootstrapCount > 0 ? null : bootstrapConfig.fault,
        connectedPeers,
        refreshJoinBootstrap,
      }}>
      {children}
    </CadreNodeContext.Provider>
  );
}
