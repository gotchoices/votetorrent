import debug from "debug";
import optimysticPlugin from "@optimystic/quereus-plugin-optimystic/plugin";
import { STRAND_SCHEMA } from "./strand-schema.js";
const log = debug("sereus:plugin:strand");
const timing = debug("sereus:plugin:strand:timing");
function applyRegistrations(db, result) {
  for (const vtable of result.vtables ?? []) {
    db.registerModule(vtable.name, vtable.module, vtable.auxData);
  }
  for (const func of result.functions ?? []) {
    db.registerFunction(func.schema);
  }
  for (const collation of result.collations ?? []) {
    db.registerCollation(collation.name, collation.func, collation.normalizer);
  }
}
async function composeStrand(db, options, platform) {
  const {
    strandId,
    bootstrapNodes = [],
    schema,
    port = 0,
    enableCache = true,
    fretProfile = "edge",
    mode
  } = options;
  let resolvedTransactor;
  if (mode !== void 0) {
    resolvedTransactor = mode === "bootstrap" ? "local" : "network";
  } else if (options.transactor !== void 0) {
    resolvedTransactor = options.transactor;
  } else {
    resolvedTransactor = "network";
  }
  const networkName = `strand-${strandId}`;
  log(
    "Connecting to strand %s (network: %s, mode=%s, transactor=%s)",
    strandId,
    networkName,
    mode ?? "(default)",
    resolvedTransactor
  );
  const storage = platform.resolveStorage ? await platform.resolveStorage({ strandId, resolvedTransactor, requestedStorage: options.storage }) : options.storage;
  await platform.registerCrypto(db);
  log("Registered crypto plugin");
  const pluginConfig = {
    default_transactor: resolvedTransactor,
    default_key_network: "libp2p",
    default_network_name: networkName,
    enable_cache: enableCache
  };
  if (resolvedTransactor === "local" && storage) {
    pluginConfig.rawStorageFactory = () => storage;
  }
  const pluginResult = optimysticPlugin(
    db,
    pluginConfig
  );
  applyRegistrations(db, pluginResult);
  log("Registered optimystic vtables and functions");
  const { collectionFactory } = pluginResult;
  let createdNode = null;
  let hydrated;
  try {
    if (resolvedTransactor !== "test" || options.libp2pNode) {
      let node;
      let coordinatedRepo;
      if (options.libp2pNode) {
        node = options.libp2pNode;
        if (!options.coordinatedRepo) {
          throw new Error("coordinatedRepo is required when libp2pNode is provided");
        }
        coordinatedRepo = options.coordinatedRepo;
        log("Using injected libp2p node");
      } else {
        const created = await platform.createNode({ networkName, bootstrapNodes, fretProfile, port, storage });
        createdNode = created;
        node = created;
        const repo = created.coordinatedRepo;
        if (!repo) {
          throw new Error("coordinatedRepo not available on created libp2p node");
        }
        coordinatedRepo = repo;
        log("Created libp2p node (port: %d, fretProfile: %s, storage=%s)", port, fretProfile, !!storage);
      }
      collectionFactory.registerLibp2pNode(networkName, node, coordinatedRepo);
      log("Registered libp2p node with collection factory");
    }
    db.setDefaultVtabName("optimystic");
    db.setDefaultVtabArgs({
      networkName,
      transactor: resolvedTransactor,
      keyNetwork: "libp2p"
    });
    log("Set default vtab to optimystic (networkName=%s, transactor=%s)", networkName, resolvedTransactor);
    const t0 = performance.now();
    hydrated = await pluginResult.hydrate(db);
    timing(
      "[strand:%s] hydrate: %dms (tables=%d, indexes=%d)",
      strandId,
      Math.round(performance.now() - t0),
      hydrated.tables,
      hydrated.indexes
    );
    log("Hydrated catalog for strand %s (tables=%d, indexes=%d)", strandId, hydrated.tables, hydrated.indexes);
    log("Applying Strand membership schema for strand %s", strandId);
    await db.exec(`
			declare schema Strand {
				${STRAND_SCHEMA}
			}
			apply schema Strand;
		`);
    log("Strand membership schema applied");
    if (schema) {
      log("Applying sApp schema for strand %s", strandId);
      await db.exec(`
				declare schema App {
					${schema}
				}
				apply schema App;
			`);
      log("sApp schema applied");
    }
  } catch (err) {
    await collectionFactory.shutdown();
    if (createdNode) {
      await createdNode.stop();
    }
    throw err;
  }
  return {
    vtables: [],
    functions: [],
    collations: [],
    hydrated,
    async shutdown() {
      log("Shutting down strand connection %s", strandId);
      await collectionFactory.shutdown();
      if (createdNode) {
        await createdNode.stop();
      }
      log("Strand connection %s shut down", strandId);
    }
  };
}
export {
  applyRegistrations,
  composeStrand
};
