/**
 * Jest manual mock for @optimystic/db-p2p (app-layer Jest environment).
 *
 * @optimystic/db-p2p ships as ESM-only with deep transitive deps (libp2p, p2p-fret,
 * uint8arrays, etc.) that cannot be transformed by the react-native Jest preset.
 * This mock provides a Libp2pKeyPeerNetwork stub that satisfies the
 * key-network-strand.test.ts contract: returns an object with findCoordinator and
 * findCluster that delegate to the strand's libp2pNode.services.fret FRET ring.
 *
 * Production behavior: the real Libp2pKeyPeerNetwork (from the installed dist) is
 * used at Metro/RN runtime — this mock is Jest-only.
 */

class Libp2pKeyPeerNetwork {
  constructor(libp2p) {
    this._libp2p = libp2p;
  }

  async findCoordinator(key, options) {
    const fret = this._libp2p.services && this._libp2p.services.fret;
    if (fret) {
      const hashedKey = await fret.hashKey(key);
      const neighbors = await fret.getNeighbors(hashedKey);
      if (neighbors && neighbors.length > 0) {
        return neighbors[0];
      }
    }
    return { toString: () => 'mock-peer-id' };
  }

  async findCluster(key) {
    const fret = this._libp2p.services && this._libp2p.services.fret;
    if (fret) {
      const hashedKey = await fret.hashKey(key);
      const cohort = await fret.assembleCohort(hashedKey);
      return cohort;
    }
    return new Map();
  }
}

module.exports = {
  Libp2pKeyPeerNetwork,
};
