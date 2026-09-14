/**
 * topology.mjs — how a gate node is built.
 *
 * ONE definition, imported by both gates. `multipeer-gate.mjs` builds its four nodes in a
 * single process; `multiproc-gate.mjs` builds the same four through `peer-agent.mjs`, one
 * OS process each. If the two gates constructed their nodes separately they would drift,
 * and a cross-process FAIL against an in-process PASS would no longer be evidence about
 * the process boundary — it would just be evidence that the two harnesses differ.
 */
import { CadreNode } from '@serfab/cadre-core';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';

export const PARTY_ID = 'multipeer-gate';
export const STRAND_ID = 'multipeer-gate-strand';
export const SAPP_ID = 'org.sereus.multipeer-gate';

/**
 * A single-table schema. StrandDatabase.executeSchema() supplies the
 * `declare schema App { ... } apply schema App;` wrapper itself, so this is raw DDL.
 *
 * `Value` and `Writer` are what the distributed-database legs assert on: a row that
 * merely EXISTS on the reader proves propagation, but only its contents prove WHICH
 * write won when two peers wrote concurrently.
 */
export const SCHEMA = `
create table GateRow (
  Id text primary key,
  Value text,
  Writer text
);
`;

/**
 * StrandDatabase.executeSchema() wraps the DDL as `declare schema App { ... }`, so the
 * table lands in `App` while the default schema path is `main`. Unqualified it resolves
 * to nothing: "Table 'GateRow' not found in schema path: main".
 */
export const GATE_TABLE = 'App.GateRow';

/** The block the table's rows live in — what the replication-factor legs count holders of. */
export const GATE_ROW_BLOCK = 'default/GateRow';

/**
 * Records every block id this node has ever been asked to persist.
 *
 * The holder census cannot be taken from a read: a node materializes a row when it
 * propagates and will answer for it afterwards whether or not it stores a replica. Only
 * the storage layer knows who actually holds what.
 */
export class TrackingStorage extends MemoryRawStorage {
  constructor() { super(); this.seen = new Set(); }
  async saveMetadata(id, m) { this.seen.add(id); return super.saveMetadata(id, m); }
  async saveRevision(id, r, a) { this.seen.add(id); return super.saveRevision(id, r, a); }
  async saveMaterializedBlock(id, a, b) { this.seen.add(id); return super.saveMaterializedBlock(id, a, b); }
}

/**
 * Shared CadreNode options. Every node on one strand MUST agree on strandClusterSize.
 *
 * `privateKey` is supplied explicitly rather than letting libp2p mint an ephemeral one:
 * `getIdentityOwnerKey()` — which owner genesis needs — throws on an ephemeral key,
 * because that key is internal to libp2p and never exposed.
 */
export function baseConfig({ partyId = PARTY_ID, bootstrapNodes, privateKey, clusterSize, storage }) {
  return {
    privateKey,
    controlNetwork: { partyId, bootstrapNodes },
    // The gate hosts an unsigned demo schema, so relax the fail-closed signature policy
    // exactly as the reference drone harness does. Not a production posture.
    requireSignedSchemas: false,
    strandFilter: { mode: 'all' },
    storage: { provider: () => storage },
    strandClusterSize: clusterSize,
    hibernation: { enabled: false },
  };
}

/**
 * An always-on storage node: relay server ON, direct ws listen.
 *
 * ONLY storage-profile nodes serve blocks (`enableRingZulu` and `storageRing` are gated
 * on `profile === 'storage'`), so drone count is the discriminator between a block-cluster
 * breadth problem and a relay-only reachability problem.
 */
export function droneOptions({ bootstrapNodes, privateKey, clusterSize, storage, partyId }) {
  return {
    ...baseConfig({ partyId, bootstrapNodes, privateKey, clusterSize, storage }),
    profile: 'storage', // turns the circuit-relay-v2 relay server ON
    network: {
      transports: [webSockets()],
      listenAddrs: ['/ip4/0.0.0.0/tcp/0/ws'], // ephemeral — avoids EADDRINUSE
      relayServerInit: {
        reservations: {
          maxReservations: 32,             // n=4 plus headroom (library default is 15)
          defaultDurationLimit: 10 * 60 * 1000,
          defaultDataLimit: BigInt(1 << 20),
        },
        maxInboundHopStreams: 64,
        maxOutboundStopStreams: 64,
      },
    },
  };
}

/**
 * A relay-only peer: NO direct listen address, only relays. This is what makes the peer
 * undialable except through a relay — the constraint the whole gate exists to exercise.
 *
 * cadre-core 0.12.0 moved this from `network.listenAddrs` to `network.relayAddrs` and now
 * REJECTS the old shape on a control node: a `<relay>/p2p-circuit` listen entry makes
 * libp2p dial the relay from inside `libp2p.start()`, during the bring-up quiet period
 * that denies exactly that dial. `relayAddrs` takes the 'search' route instead (one bare
 * `/p2p-circuit` listener) and drives the reservation explicitly AFTER the control
 * database is up. `listenAddrs` is deliberately left unset so the peer keeps no direct
 * listener — naming a relay alone does not add one back.
 */
export function relayOnlyPeerOptions({ relayAddrs, bootstrapNodes, privateKey, clusterSize, storage, partyId, direct = false }) {
  return {
    ...baseConfig({ partyId, bootstrapNodes, privateKey, clusterSize, storage }),
    profile: 'transaction',
    network: {
      transports: [
        webSockets(),
        // Required for a `/p2p-circuit` LISTEN address to be honoured at all — without it
        // libp2p rejects the address with UnsupportedListenAddressError and the peer never
        // starts.
        //
        // reservationConcurrency defaults to 1, which serialises and then DROPS the
        // surplus. Kept sized to the relay count: L2 asserts a reservation per relay.
        circuitRelayTransport({ reservationConcurrency: Math.max(1, relayAddrs.length) }),
      ],
      relayAddrs,
      // `direct` is the diagnostic escape hatch, NOT the topology under test. Giving the
      // peer a direct listener removes the one constraint this gate exists to exercise,
      // which is exactly why it is useful: if the database legs pass with a direct
      // listener and fail without one, the fault is in relay-only addressing rather than
      // in replication, and the two are otherwise very hard to tell apart. Any run using
      // it is reported as a diagnostic, never as a gate result.
      ...(direct ? { listenAddrs: ['/ip4/0.0.0.0/tcp/0/ws'] } : {}),
    },
  };
}

/** Build (but do not start) a node of either role. */
export function buildNode(role, opts) {
  const storage = new TrackingStorage();
  const options = role === 'drone'
    ? droneOptions({ ...opts, storage })
    : relayOnlyPeerOptions({ ...opts, storage });
  return { node: new CadreNode(options), storage };
}

export { generateKeyPair };

/** The strand config both gates add. */
export function strandConfig({ strandId = STRAND_ID, sAppId = SAPP_ID, schema = SCHEMA, mode }) {
  return {
    strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' },
    sAppConfig: { id: sAppId, version: '1.0.0', schema, latencyHint: 'interactive' },
    mode,
  };
}
