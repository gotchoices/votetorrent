import { Database } from '@quereus/quereus';
import type { Libp2p } from '@libp2p/interface';
import type { IRepo } from '@optimystic/db-core';
import type { IRawStorage } from '@optimystic/db-p2p';
import type { SAppConfig, StrandMode } from './types.js';
export interface StrandDatabaseConfig {
    /** The strand ID */
    strandId: string;
    /** sApp configuration containing the schema */
    sAppConfig: SAppConfig;
    /** Libp2p node for the strand network */
    libp2pNode: Libp2p;
    /** Coordinated repo from the libp2p node */
    coordinatedRepo: IRepo;
    /**
     * Lifecycle mode. `'bootstrap'` selects a purely local transactor so the strand
     * can initialize (e.g. apply schema DDL) without network round trips on a solo
     * node. `'networked'` (the default) uses the network transactor.
     */
    mode?: StrandMode;
    /**
     * Raw storage backing the strand. When mode is `'bootstrap'` this is also used
     * by the optimystic plugin's local transactor so DML lands on the host's
     * persistent storage instead of in-memory. Must be the same instance the
     * libp2p node was created with — sharing the instance avoids cache divergence
     * across the two consumers.
     */
    rawStorage?: IRawStorage;
}
/**
 * StrandDatabase manages the sApp schema for a strand using Quereus with the
 * Optimystic backend. Each strand instance has its own isolated database with
 * the sApp's schema applied.
 *
 * This class owns the `Database` lifecycle (creation, `getDatabase()`, `close()`)
 * but delegates the actual SQL-surface composition — plugin registration, node
 * wiring, catalog hydration, schema apply — to `connectToStrand` from
 * `@serfab/quereus-plugin-sereus`, the single shared composition. The libp2p
 * node is injected here, so `connectToStrand` never *creates* the node;
 * `StrandInstanceManager` owns the node lifecycle. (The strand connection's
 * `shutdown` still stops the injected node via the collection factory, so the
 * manager's own `node.stop()` is an idempotent second stop — see `close()`.)
 */
export declare class StrandDatabase {
    private db;
    private shutdownStrand;
    private readonly config;
    private initialized;
    constructor(config: StrandDatabaseConfig);
    /**
     * Initialize the database — create the `Database` and delegate the strand
     * SQL-surface composition (plugins, node wiring, hydrate, schema apply) to
     * `connectToStrand` with the injected libp2p node.
     */
    initialize(): Promise<void>;
    /**
     * Get the underlying database for queries
     */
    getDatabase(): Database;
    /**
     * Close the database and cleanup resources. Runs the strand-connection
     * shutdown (collection-factory teardown, which also stops the injected node),
     * then closes the `Database`. `StrandInstanceManager.releaseRuntime` issues a
     * further idempotent `node.stop()` after this returns.
     */
    close(): Promise<void>;
    private ensureInitialized;
}
