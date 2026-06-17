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
// Update CONTROL_ADDR after each drone restart (drone prints this on startup).
// Example: '/ip4/10.0.2.2/tcp/52345/ws/p2p/12D3KooW...'
// This constant is used for the control network bootstrap address.
// ---------------------------------------------------------------------------
const CONTROL_ADDR = '/ip4/10.0.2.2/tcp/0/ws/p2p/UPDATE_AFTER_DRONE_RESTART';
const PARTY_ID = 'votetorrent';

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
          controlNetwork: { partyId: PARTY_ID, bootstrapNodes: [CONTROL_ADDR] },
          profile: 'transaction',
          strandFilter: { mode: 'all' },
          storage: { provider: () => new LevelDBRawStorage(db) },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          network: {
            transports: [webSockets(), circuitRelayTransport()],
            listenAddrs: [],
            // Permissive gater — allows loopback / emulator host dials (D-11).
            // Per-strand enrollment gating is v2.x scope.
            // Cast needed: connectionGater is accepted at runtime by cadre-core's
            // createLibp2pNode but is not currently reflected in NetworkConfig typings.
            // Same pattern as dial-probe.ts (spike-validated on-device).
            connectionGater: { denyDialMultiaddr: async () => false },
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
