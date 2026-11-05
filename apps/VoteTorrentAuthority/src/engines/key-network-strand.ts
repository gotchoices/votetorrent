/**
 * D-03: This file is the ONLY place `@optimystic/db-p2p` is imported in the app layer
 * for IKeyNetwork purposes. It MUST NOT appear under packages/vote-engine/.
 *
 * Import path confirmed: `Libp2pKeyPeerNetwork` is re-exported from the root
 * `@optimystic/db-p2p` entry point (dist/src/libp2p-key-network.js, confirmed
 * in dist/src/index.d.ts → `export * from "./libp2p-key-network.js"`).
 * IKeyNetwork is exported from `@optimystic/db-core` (the db-p2p peer dependency).
 */

import { Libp2pKeyPeerNetwork } from '@optimystic/db-p2p';
import type { IKeyNetwork } from '@optimystic/db-core';
import type { StrandInstance } from '@serfab/cadre-core';

/**
 * createStrandKeyNetwork — P2P-04/P2P-05
 *
 * Returns a real IKeyNetwork implementation backed by the strand's libp2p node.
 * The strand's libp2p node already has the FRET service wired in by cadre-core's
 * createLibp2pNode, so findCoordinator/findCluster resolve through the FRET ring
 * without additional setup here.
 *
 * Throws 'Strand libp2p node not active' when the strand's libp2pNode is falsy
 * (e.g. strand is hibernated or not yet started).
 *
 * `clusterSize` became REQUIRED in @optimystic/db-p2p 1.0.0-beta.2, and the upstream reason is
 * worth restating because this file previously had the bug it describes: the old optional
 * parameter defaulted to 16, so a caller that did not know the node's own cluster size silently
 * selected a DIFFERENT-width cohort than the node's consensus path used for the same key. This
 * app configures `strandClusterSize: 2`, so the old default was off by a factor of eight.
 *
 * Upstream's own guidance is to reuse the node's existing instance where one exists rather than
 * construct a second, so `strand.keyNetwork` wins when present and the explicit size is the
 * fallback for a strand that exposes none.
 *
 * @param strand - An active StrandInstance from CadreNode.getStrand()
 * @param clusterSize - The strand's replication factor. Pass the SAME value handed to
 *   CadreNode as `strandClusterSize`, never a literal chosen here.
 * @returns A real IKeyNetwork (findCoordinator + findCluster)
 */
export function createStrandKeyNetwork(strand: StrandInstance, clusterSize: number): IKeyNetwork {
  if (!strand.libp2pNode) {
    throw new Error('Strand libp2p node not active');
  }
  const existing = (strand as StrandInstance & { keyNetwork?: IKeyNetwork }).keyNetwork;
  if (existing) {
    return existing;
  }
  return new Libp2pKeyPeerNetwork(strand.libp2pNode, clusterSize);
}
