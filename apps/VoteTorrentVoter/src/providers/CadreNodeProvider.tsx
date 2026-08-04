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
import { CadreNode } from '@serfab/cadre-core';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';

// ---------------------------------------------------------------------------
// Context type
// ---------------------------------------------------------------------------

interface CadreNodeContextType {
  /** The live CadreNode instance (null until started). */
  node: InstanceType<typeof CadreNode> | null;
  /** Event-driven sync state derived from CadreNodeEvents (D-10 — no polling). */
  syncState: 'connected' | 'syncing' | 'offline';
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
// NETOP-04: configurable control and strand bootstrap addresses.
//
// These constants are the sole configurable inputs for peer reachability.
// Leaving both as placeholders boots SOLO (no bootstrap peers) — a valid
// offline/solo node that does NOT crash (resolveBootstrapNodes returns []).
//
// For the P2P-06 replication proof, the harness overwrites these lines per-run
// (D-07 pattern, run-replication-proof.sh) and git-checkouts CONFIG_FILE on EXIT.
// For a production build, a join flow (NETOP-03) supplies the real addresses.
//
// CONTROL_ADDR: drone's control-node ws multiaddr (for the control network).
// STRAND_BOOTSTRAP_ADDR: drone's strand-node ws multiaddr (for cohort formation).
// These are DIFFERENT libp2p nodes on the drone with different ephemeral ports (Pitfall 2).
// ---------------------------------------------------------------------------
const CONTROL_ADDR = '/ip4/10.0.2.2/tcp/0/ws/p2p/UPDATE_AFTER_DRONE_RESTART';
const STRAND_BOOTSTRAP_ADDR = '/ip4/10.0.2.2/tcp/0/ws/p2p/UPDATE_AFTER_DRONE_RESTART';
const PARTY_ID = 'votetorrent';

// Sentinel embedded in the committed default address. libp2p Bootstrap calls
// peerIdFromString() on the trailing /p2p/<id> segment; this placeholder is not a
// valid peerId and throws InvalidParametersError, aborting node.start(). Treat it
// (and an empty/unset address) as "no bootstrap peer configured".
const BOOTSTRAP_PLACEHOLDER = 'UPDATE_AFTER_DRONE_RESTART';

/**
 * resolveBootstrapNodes — placeholder-aware bootstrap config selection (P2P-02).
 *
 * Pure + exported for unit testing without booting a real (ESM-only) CadreNode.
 *
 * Returns [] when the address is empty/unset OR still contains the placeholder
 * sentinel — booting a CadreNode with an empty bootstrapNodes array is the valid
 * offline/solo case and does NOT throw (clean cold start, no red toast). Returns
 * [addr] for a real address so the bootstrap dial / real P2P path stays reachable.
 */
export function resolveBootstrapNodes(addr: string): string[] {
  if (!addr || addr.includes(BOOTSTRAP_PLACEHOLDER)) {
    return [];
  }
  return [addr];
}

// D-05 (41-02, P2P-11 wall #8 fix): relay-qualified per-drone listenAddrs.
// One `${addr}/p2p-circuit` entry per KNOWN drone routes through
// @libp2p/circuit-relay-v2's 'configured' reservation path (RESEARCH Pattern 1),
// which bypasses the one-slot 'discovered' cap that capped the emulator at a
// reservation with only ONE drone. Routed through the SAME placeholder-aware
// resolveBootstrapNodes guard used for strandBootstrapNodes below, so a solo/
// placeholder boot yields [] (degraded, not a crash) — never a bare
// template-string concat over an unresolved constant.
const STRAND_RELAY_LISTEN_ADDRS = resolveBootstrapNodes(STRAND_BOOTSTRAP_ADDR).map(
  (addr) => `${addr}/p2p-circuit`,
);

// P2P-11 (41-11, wall #9 — shared-PeerId strand-relay collision): the control node reserves
// through the drone's CONTROL relay, a DISTINCT relay identity from the strand node's STRAND
// relay (strandNetwork below). Two separate relay servers ⇒ each circuit-relay-v2 server holds
// only ONE connection per this peer's (shared) PeerId, so hop-connect (server/index.js:230-236
// connections[0]) can no longer misroute strand-directed streams to the control connection
// (41-10-STRAND-RELAY-ROUTING-DIAGNOSIS.md §5). Placeholder-aware exactly like
// STRAND_RELAY_LISTEN_ADDRS — a solo/placeholder boot degrades to [] (no crash).
const CONTROL_RELAY_LISTEN_ADDRS = resolveBootstrapNodes(CONTROL_ADDR).map(
  (addr) => `${addr}/p2p-circuit`,
);

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

  // Boot effect: construct + start the CadreNode.
  // Runs once on mount ([] dep array). node.start() is NOT called in the
  // provider body — must not block initial render (D-06 / T-22-03).
  useEffect(() => {
    let isMounted = true;
    let localNode: InstanceType<typeof CadreNode> | null = null;

    async function bootNode() {
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
        // `provider('control')` for the control DB (cadre-node.js:180).
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

        localNode = new CadreNode({
          privateKey,
          controlNetwork: { partyId: PARTY_ID, bootstrapNodes: resolveBootstrapNodes(CONTROL_ADDR) },
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
                // to the number of known control relays driving CONTROL_RELAY_LISTEN_ADDRS
                // (never less than 1).
                reservationConcurrency: Math.max(1, CONTROL_RELAY_LISTEN_ADDRS.length),
              }) as unknown as ReturnType<typeof webSockets>,
            ],
            // D-03/D-05: always-on relay reservation-seeking (P2P-08 drone-relay path),
            // relay-qualified — but scoped to the drone's CONTROL relay (P2P-11 41-11).
            // The STRAND relay moves to strandNetwork below, so the control and strand
            // libp2p nodes no longer collide at one relay under this peer's shared PeerId.
            listenAddrs: CONTROL_RELAY_LISTEN_ADDRS,
            // Permissive gater — allows loopback / emulator host dials (D-11).
            // Per-strand enrollment gating is v2.x scope.
            connectionGater: { denyDialMultiaddr: async () => false },
          } as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          // STRAND node network override (cadre-core strandNetwork patch, P2P-11 41-11):
          // per-strand libp2p nodes use THIS config instead of `network` above, reserving
          // through the drone's STRAND relay — a DISTINCT relay identity from the control
          // node — closing the shared-PeerId hop-connect collision (41-10 diagnosis §5).
          // Unset ⇒ strands would reuse `network` (the pre-fix collision).
          strandNetwork: {
            transports: [
              webSockets(),
              circuitRelayTransport({
                reservationConcurrency: Math.max(1, STRAND_RELAY_LISTEN_ADDRS.length),
              }) as unknown as ReturnType<typeof webSockets>,
            ],
            listenAddrs: STRAND_RELAY_LISTEN_ADDRS,
            connectionGater: { denyDialMultiaddr: async () => false },
            // NETOP-04: strand-cohort bootstrap — the drone's strand-node multiaddr.
            // Placeholder/unset → [] → strand boots solo without crashing (P2P-03 no regression).
            // For the proof, harness injects a real STRAND_BOOTSTRAP_ADDR per-run.
            strandBootstrapNodes: resolveBootstrapNodes(STRAND_BOOTSTRAP_ADDR),
          } as any,
          hibernation: { enabled: false },
        });

        // node.start() is inside useEffect — never blocks initial render (D-06 / T-22-03).
        await localNode.start();

        if (isMounted) {
          nodeRef.current = localNode;
          setNode(localNode);
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
  useEffect(() => {
    if (!node) return;

    const onConnected = () => setSyncState('connected');
    const onStrandStarted = () => setSyncState('connected');
    const onStrandIdle = () => setSyncState('syncing');
    const onStrandError = () => setSyncState('offline');
    const onDisconnected = () => setSyncState('offline');

    node.on('control:connected', onConnected);
    node.on('strand:started', onStrandStarted);
    node.on('strand:idle', onStrandIdle);
    node.on('strand:error', onStrandError);
    node.on('control:disconnected', onDisconnected);

    return () => {
      node.off('control:connected', onConnected);
      node.off('strand:started', onStrandStarted);
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
    <CadreNodeContext.Provider value={{ node, syncState, connectedPeers }}>
      {children}
    </CadreNodeContext.Provider>
  );
}
