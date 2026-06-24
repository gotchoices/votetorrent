/**
 * D-03: This file is the ONLY place `@serfab/cadre-core`,
 * `@optimystic/db-p2p-storage-rn`, and `rn-leveldb` are imported for the
 * CadreNode app lifecycle. They MUST NOT appear under packages/vote-engine/.
 */

import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from "react";
import type { PropsWithChildren } from "react";
import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';
import { openOptimysticRNDb, LevelDBRawStorage, loadOrCreateRNPeerKey } from '@optimystic/db-p2p-storage-rn';
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
        // Separate store for the control peer identity — 'votetorrent-cadre-node'
        // gives a stable peerId across app restarts (D-06 / T-22-04).
        const db = openOptimysticRNDb({
          openFn: (n, c, e) => new LevelDB(n, c, e),
          WriteBatch: LevelDBWriteBatch,
          name: 'votetorrent-cadre-node',
        });
        const privateKey = await loadOrCreateRNPeerKey(db);

        localNode = new CadreNode({
          privateKey,
          controlNetwork: { partyId: PARTY_ID, bootstrapNodes: resolveBootstrapNodes(CONTROL_ADDR) },
          profile: 'transaction',
          strandFilter: { mode: 'all' },
          storage: { provider: () => new LevelDBRawStorage(db) },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          network: {
            transports: [webSockets(), circuitRelayTransport()],
            listenAddrs: [],
            // Permissive gater — allows loopback / emulator host dials (D-11).
            // Per-strand enrollment gating is v2.x scope.
            // Cast needed for connectionGater (cadre-core upstream gap); strandBootstrapNodes
            // is typed by 23-05 (NetworkConfig.strandBootstrapNodes?: string[]).
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
