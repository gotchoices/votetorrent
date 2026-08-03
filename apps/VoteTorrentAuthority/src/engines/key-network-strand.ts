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
 * @param strand - An active StrandInstance from CadreNode.getStrand()
 * @returns A real IKeyNetwork (findCoordinator + findCluster)
 */
export function createStrandKeyNetwork(strand: StrandInstance): IKeyNetwork {
  if (!strand.libp2pNode) {
    throw new Error('Strand libp2p node not active');
  }
  // clusterSize is optional (defaults internally to 16 in Libp2pKeyPeerNetwork)
  return new Libp2pKeyPeerNetwork(strand.libp2pNode);
}
