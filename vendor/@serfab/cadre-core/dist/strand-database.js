import debug from "debug";
import { Database, registerPlugin } from "@quereus/quereus";
import cryptoPlugin from "@optimystic/quereus-plugin-crypto/plugin";
import optimysticPlugin from "@optimystic/quereus-plugin-optimystic/plugin";
const log = debug("sereus:cadre:strand-db");
const timing = debug("sereus:cadre:timing");
class StrandDatabase {
  constructor(config) {
    this.db = null;
    this.collectionFactory = null;
    this.initialized = false;
    this.config = config;
  }
  /**
   * Initialize the database - register plugins and execute sApp schema
   */
  async initialize() {
    if (this.initialized) {
      log("StrandDatabase for strand %s already initialized", this.config.strandId);
      return;
    }
    log(
      "Initializing StrandDatabase for strand: %s (sApp: %s v%s)",
      this.config.strandId,
      this.config.sAppConfig.id,
      this.config.sAppConfig.version
    );
    this.db = new Database();
    const sid = this.config.strandId;
    let t0 = performance.now();
    await registerPlugin(this.db, cryptoPlugin);
    timing("[strandDb:%s] cryptoPlugin: %dms", sid, Math.round(performance.now() - t0));
    log("Registered crypto plugin");
    t0 = performance.now();
    const networkName = `strand-${sid}`;
    const mode = this.config.mode ?? "networked";
    const defaultTransactor = mode === "bootstrap" ? "local" : "network";
    const rawStorage = this.config.rawStorage;
    const pluginConfig = {
      default_transactor: defaultTransactor,
      default_key_network: "libp2p",
      default_network_name: networkName,
      enable_cache: true
    };
    if (mode === "bootstrap" && rawStorage) {
      pluginConfig.rawStorageFactory = () => rawStorage;
    }
    const pluginResult = optimysticPlugin(
      this.db,
      pluginConfig
    );
    log(
      "Optimystic plugin registered for strand %s (mode=%s, transactor=%s, persistentStorage=%s)",
      sid,
      mode,
      defaultTransactor,
      mode === "bootstrap" && !!rawStorage
    );
    for (const vtable of pluginResult.vtables) {
      this.db.registerModule(vtable.name, vtable.module, vtable.auxData);
    }
    for (const func of pluginResult.functions) {
      this.db.registerFunction(func.schema);
    }
    timing("[strandDb:%s] optimysticPlugin: %dms", sid, Math.round(performance.now() - t0));
    this.collectionFactory = pluginResult.collectionFactory;
    t0 = performance.now();
    this.collectionFactory.registerLibp2pNode(
      networkName,
      this.config.libp2pNode,
      this.config.coordinatedRepo
    );
    timing("[strandDb:%s] registerLibp2pNode: %dms", sid, Math.round(performance.now() - t0));
    log("Registered libp2p node with collection factory");
    t0 = performance.now();
    this.db.setDefaultVtabName("optimystic");
    this.db.setDefaultVtabArgs({
      networkName,
      transactor: defaultTransactor,
      keyNetwork: "libp2p"
    });
    timing("[strandDb:%s] setDefaultVtab: %dms", sid, Math.round(performance.now() - t0));
    log("Set default vtab to optimystic (networkName=%s, transactor=%s)", networkName, defaultTransactor);
    t0 = performance.now();
    const hydrated = await pluginResult.hydrate(this.db);
    timing(
      "[strandDb:%s] hydrate: %dms (tables=%d, indexes=%d)",
      sid,
      Math.round(performance.now() - t0),
      hydrated.tables,
      hydrated.indexes
    );
    log(
      "Hydrated catalog for strand %s (tables=%d, indexes=%d)",
      sid,
      hydrated.tables,
      hydrated.indexes
    );
    t0 = performance.now();
    await this.executeSchema();
    timing("[strandDb:%s] executeSchema: %dms", sid, Math.round(performance.now() - t0));
    this.initialized = true;
    log("StrandDatabase for strand %s initialized successfully", sid);
  }
  async executeSchema() {
    const rawSchema = this.config.sAppConfig.schema;
    log("Applying sApp schema for strand %s", this.config.strandId);
    const wrappedSchema = `
      declare schema App {
        ${rawSchema}
      }
      apply schema App;
    `;
    await this.db.exec(wrappedSchema);
    log("sApp schema applied to strand %s", this.config.strandId);
  }
  /**
   * Get the underlying database for queries
   */
  getDatabase() {
    this.ensureInitialized();
    return this.db;
  }
  /**
   * Close the database and cleanup resources
   */
  async close() {
    if (this.collectionFactory) {
      await this.collectionFactory.shutdown();
      this.collectionFactory = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
    log("StrandDatabase for strand %s closed", this.config.strandId);
  }
  ensureInitialized() {
    if (!this.initialized || !this.db) {
      throw new Error(`StrandDatabase for strand ${this.config.strandId} not initialized. Call initialize() first.`);
    }
  }
}
export {
  StrandDatabase
};
