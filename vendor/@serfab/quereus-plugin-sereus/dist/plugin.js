import { connectToStrand } from "./connect.js";
import { parseConfig } from "./parse-config.js";
async function register(db, config = {}) {
  const options = parseConfig(config);
  const storagePath = config.storage_path;
  if (typeof storagePath === "string" && storagePath) {
    const { FileRawStorage } = await import("@optimystic/db-p2p-storage-fs");
    options.storage = new FileRawStorage(storagePath);
  }
  return connectToStrand(db, options);
}
export {
  register as default,
  parseConfig
};
