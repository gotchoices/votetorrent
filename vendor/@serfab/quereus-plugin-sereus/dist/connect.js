import { registerPlugin } from "@quereus/quereus";
import cryptoPlugin from "@optimystic/quereus-plugin-crypto/plugin";
import { composeStrand } from "./compose-strand.js";
async function connectToStrand(db, options) {
  return composeStrand(db, options, {
    async registerCrypto(database) {
      await registerPlugin(database, cryptoPlugin);
    },
    async createNode({ networkName, bootstrapNodes, fretProfile, port, storage }) {
      const { createLibp2pNode } = await import("@optimystic/db-p2p");
      return createLibp2pNode({
        port,
        bootstrapNodes,
        networkName,
        fretProfile,
        ...storage && { storage }
      });
    }
  });
}
export {
  connectToStrand
};
