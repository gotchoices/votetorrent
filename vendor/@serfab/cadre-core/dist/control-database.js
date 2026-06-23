import debug from "debug";
import { toString as uint8ArrayToString } from "uint8arrays";
import { Database, registerPlugin } from "@quereus/quereus";
import cryptoPlugin from "@optimystic/quereus-plugin-crypto/plugin";
import optimysticPlugin from "@optimystic/quereus-plugin-optimystic/plugin";
import { digest, randomBytes } from "@optimystic/quereus-plugin-crypto";
const log = debug("sereus:cadre:control-db");
const timing = debug("sereus:cadre:timing");
const CONTROL_SCHEMA = `-- This manages a Sereus party's cadre, or set of nodes, and their participation in strands (networks)
declare schema CadreControl {
    -- A key that can authorize various control changes
    table AuthorityKey (
        Key text primary key,
        constraint Authorized check (
            -- Bootstrap: first authority key needs no existing authorization
            (select count(1) from AuthorityKey) <= 1

                -- Old authority can authorize by signature and transaction stamp id (not repeatable)
                or (old.Key is not null and old.Key = context.AuthorityKey and verify(digest(context.StampId, 'sha256', 'utf8'), context.Signature, old.Key, 'ed25519'))

                -- or other authorities can authorize by signature and transaction stamp id (not repeatable)
                or exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(digest(context.StampId, 'sha256', 'utf8'), context.Signature, A.Key, 'ed25519'))
        )
    ) with context (AuthorityKey text null, Signature text null, StampId text);

    -- A key that can validate a strand formation disclosure
    table ValidationKey (
        Key text primary key,
        constraint Authorized check (
            -- Authorities can authorize by signature and transaction stamp id (not repeatable)
            exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(digest(context.StampId, 'sha256', 'utf8'), context.Signature, A.Key, 'ed25519'))
        )
    ) with context (AuthorityKey text, StampId text, Signature text);

    -- A network of members sharing an sApp database, each contributing peer nodes (their cadre) to the overall cohort
    -- Cadre peers should participate in each of these strands
    table Strand (
        Id text primary key,    -- UUID
        MemberPrivateKey text null unique,   -- Our private key as a member of this strand
        Type text, -- Types: 'o' = Open, 'c' = Closed -- Open can still control writes in the sApp, but only Closed controls reads
        constraint Authorized check (
            -- Authorized by authority signature and transaction stamp id (not repeatable)
            exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(digest(context.StampId, 'sha256', 'utf8'), context.Signature, A.Key, 'ed25519'))

                -- or authorized by a cadre peer who has received a valid formation invitation
                or exists (select 1 from FormationUsage FU where FU.StrandId = new.Id)
        ),
        -- TODO: constraint to ensure member private key only if closed
    ) with context (AuthorityKey text, StampId text, Signature text);

    -- A peer (node) that is part of the cadre
    table CadrePeer (
        PeerId text primary key,
        Multiaddr text,
        constraint AuthorizedInsert check on insert, delete (
            -- Authorized by an authority key
            -- Use utf8 input encoding since peer IDs are base58btc strings, not base64url
            exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(digest(coalesce(new.PeerId, old.PeerId), 'sha256', 'utf8'), context.Signature, A.Key, 'ed25519'))
        ),
        constraint AuthorizedUpdate check on update (
            -- Peer can change its own multiaddr (using utf8 encoding for both values)
            verify(digest(new.PeerId, 'sha256', 'utf8') || digest(new.Multiaddr, 'sha256', 'utf8'), context.Signature, new.PeerId, 'ed25519')
                -- or authorized by an authority key
                or exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(digest(new.PeerId, 'sha256', 'utf8'), context.Signature, A.Key, 'ed25519'))
        )
    ) with context (AuthorityKey text null, Signature text);

    -- An open invitation to form a strand with this party
    table FormationInvite (
        Token text primary key, -- Just a random string
        sAppId text, -- The app for the strand that will be formed
        ExpiresAt datetime null,
        TotalUses int null check (TotalUses >= 0),
        ValidationUrl text null,   -- Web hook - send disclosure, IP address...
        constraint AuthorizedAddOrRemove check on insert, delete (
            -- Authorized by an authority key to add or remove this invite
            exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(digest(context.StampId), context.Signature, A.Key))
        )
    ) with context (AuthorityKey text, StampId text, Signature text);

    table FormationUsage (
        Token text,
        UseNumber int,
        Disclosure text,
        StrandId text,
        primary key (Token, UseNumber),
        constraint InsertOnly check on update, delete (false),
        constraint Monotonic check (
            new.UseNumber = coalesce((select max(UseNumber) from FormationUsage U where U.Token = new.Token), 0) + 1
        ),
        constraint Authorized check on insert (
            -- Satisfies an invitation
            exists (
                select 1 from FormationInvite FI
                    where FI.Token = new.Token
                        and (FI.TotalUses is null or FI.TotalUses >= new.UseNumber)
                        and (FI.ExpiresAt is null or FI.ExpiresAt > context.Now)
                        and (FI.ValidationUrl is null or verify(digest(new.Token, new.Disclosure), context.ValidationSignature, context.ValidationKey))
            )
        ),
        constraint StrandExists check (exists (select 1 from Strand S where S.Id = new.StrandId)),
    ) with context (PeerId text, PeerSignature text, Now datetime, ValidationKey text null, ValidationSignature text null);
}

apply schema CadreControl;`;
function generateStampId(peerId) {
  const peerIdHash = digest(peerId, "sha256", "utf8", "bytes");
  const peerIdHashPart = peerIdHash.slice(0, 16);
  const randomPart = randomBytes(128, "bytes");
  const combined = new Uint8Array(32);
  combined.set(peerIdHashPart, 0);
  combined.set(randomPart, 16);
  return uint8ArrayToString(combined, "base64url");
}
class ControlDatabase {
  constructor(config) {
    this.db = null;
    this.collectionFactory = null;
    this.initialized = false;
    this.config = config;
  }
  /**
   * Initialize the database - load schema and register plugins
   */
  async initialize() {
    if (this.initialized) {
      log("ControlDatabase already initialized");
      return;
    }
    log("Initializing ControlDatabase for party: %s", this.config.partyId);
    this.db = new Database();
    let t0 = performance.now();
    await registerPlugin(this.db, cryptoPlugin);
    timing("[controlDb] cryptoPlugin: %dms", Math.round(performance.now() - t0));
    log("Registered crypto plugin");
    t0 = performance.now();
    const networkName = `control-${this.config.partyId}`;
    const pluginResult = optimysticPlugin(this.db, {
      default_transactor: "network",
      default_key_network: "libp2p",
      default_network_name: networkName,
      enable_cache: true
    });
    for (const vtable of pluginResult.vtables) {
      this.db.registerModule(vtable.name, vtable.module, vtable.auxData);
    }
    for (const func of pluginResult.functions) {
      this.db.registerFunction(func.schema);
    }
    timing("[controlDb] optimysticPlugin: %dms", Math.round(performance.now() - t0));
    this.collectionFactory = pluginResult.collectionFactory;
    t0 = performance.now();
    this.collectionFactory.registerLibp2pNode(
      networkName,
      this.config.libp2pNode,
      this.config.coordinatedRepo
    );
    timing("[controlDb] registerLibp2pNode: %dms", Math.round(performance.now() - t0));
    log("Registered libp2p node with collection factory");
    t0 = performance.now();
    await this.loadSchema();
    timing("[controlDb] loadSchema: %dms", Math.round(performance.now() - t0));
    this.initialized = true;
    log("ControlDatabase initialized successfully");
  }
  async loadSchema() {
    let schemaContent;
    if (this.config.schemaPath) {
      log("Loading schema from file: %s", this.config.schemaPath);
      if (typeof process !== "undefined" && process.versions?.node) {
        try {
          const fs = require("fs/promises");
          schemaContent = await fs.readFile(this.config.schemaPath, "utf-8");
        } catch (error) {
          throw new Error(
            `Failed to load schema from ${this.config.schemaPath}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      } else {
        throw new Error(
          "Loading schema from file is not supported in React Native. Remove the schemaPath option to use the embedded schema instead."
        );
      }
    } else {
      log("Using embedded control schema");
      schemaContent = CONTROL_SCHEMA;
    }
    await this.db.exec(schemaContent);
    log("Schema loaded and executed");
  }
  /**
   * Query all strands from the control database
   */
  async queryStrands() {
    this.ensureInitialized();
    const results = [];
    for await (const row of this.db.eval("select Id, MemberPrivateKey, Type from CadreControl.Strand")) {
      results.push({
        Id: row.Id,
        MemberPrivateKey: row.MemberPrivateKey,
        Type: row.Type
      });
    }
    return results;
  }
  /**
   * Get the underlying database for advanced queries
   */
  getDatabase() {
    this.ensureInitialized();
    return this.db;
  }
  /**
   * Insert the initial authority key (bootstrap - no existing authorities required)
   */
  async insertAuthorityKey(key) {
    this.ensureInitialized();
    log("Inserting authority key: %s", key);
    await this.db.exec(`
      insert into CadreControl.AuthorityKey (Key)
        with context AuthorityKey = null, Signature = null, StampId = StampId()
        values (?)
    `, [key]);
    log("Authority key inserted");
  }
  /**
   * Insert a strand into the control database using authority signature.
   * This starts a transaction, gets the StampId, signs it, and inserts the strand.
   *
   * @param strandId - Unique identifier for the strand
   * @param type - Strand type: 'o' for open, 'c' for closed
   * @param authorityKey - Public key of the authorizing authority
   * @param signStampId - Function to sign the stamp ID with the authority's private key
   * @param memberPrivateKey - Optional private key for membership in closed strands
   */
  async insertStrand(strandId, type, authorityKey, signStampId, memberPrivateKey) {
    this.ensureInitialized();
    log("Inserting strand: %s (type: %s)", strandId, type);
    const peerId = this.config.libp2pNode.peerId.toString();
    const stampId = generateStampId(peerId);
    const signature = signStampId(stampId);
    await this.db.exec(`
      insert into CadreControl.Strand (Id, Type, MemberPrivateKey)
        with context AuthorityKey = ?, Signature = ?, StampId = ?
        values (?, ?, ?)
    `, [authorityKey, signature, stampId, strandId, type, memberPrivateKey ?? null]);
    log("Strand inserted: %s", strandId);
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
    log("ControlDatabase closed");
  }
  ensureInitialized() {
    if (!this.initialized || !this.db) {
      throw new Error("ControlDatabase not initialized. Call initialize() first.");
    }
  }
}
export {
  ControlDatabase
};
