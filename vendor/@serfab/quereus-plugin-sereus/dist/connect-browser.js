import cryptoPlugin from "@optimystic/quereus-plugin-crypto/plugin";
import { createLibp2pNode } from "@optimystic/db-p2p/rn";
import { webSockets } from "@libp2p/websockets";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { IndexedDBRawStorage, openOptimysticWebDb } from "@optimystic/db-p2p-storage-web";
import { composeStrand, applyRegistrations } from "./compose-strand.js";
async function connectToStrandBrowser(db, options) {
  return composeStrand(db, options, {
    registerCrypto(database) {
      applyRegistrations(database, cryptoPlugin(database, {}));
    },
    async resolveStorage({ strandId, resolvedTransactor, requestedStorage }) {
      if (requestedStorage) return requestedStorage;
      if (resolvedTransactor === "test") return void 0;
      const dbHandle = await openOptimysticWebDb(`sereus-strand-${strandId}`);
      return new IndexedDBRawStorage(dbHandle);
    },
    async createNode({ networkName, bootstrapNodes, fretProfile, storage }) {
      return createLibp2pNode({
        transports: [webSockets(), circuitRelayTransport()],
        listenAddrs: [],
        bootstrapNodes,
        networkName,
        fretProfile,
        ...storage && { storage }
      });
    }
  });
}
export {
  connectToStrandBrowser
};
