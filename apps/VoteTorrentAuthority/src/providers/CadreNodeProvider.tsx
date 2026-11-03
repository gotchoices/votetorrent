/**
 * D-03: This file is the ONLY place `@serfab/cadre-core`,
 * `@optimystic/db-p2p-storage-rn`, and `rn-leveldb` are imported for the
 * CadreNode app lifecycle. They MUST NOT appear under packages/vote-engine/.
 */

import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from "react";
import type { PropsWithChildren } from "react";
import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';
import { openOptimysticRNDb, loadOrCreateRNPeerKey } from '@optimystic/db-p2p-storage-rn';
import { createScopedRnStorageProvider } from '../engines/storage-guard';
import { isUnrestorableControlSchemaError } from '../engines/control-schema-recovery';
import { withIdentityOwnerKey, type WithIdentityOwnerKey } from '../engines/identity-owner-key';
import { CadreNode, controlStorageScope, type TrustedOwnerStore } from '@serfab/cadre-core';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import bootstrapConfigDoc from '../../bootstrap.config.json';

/** The Authority's node: a CadreNode with its identity owner key restored (cadre-core 1.18). */
export type AuthorityCadreNode = WithIdentityOwnerKey<InstanceType<typeof CadreNode>>;
import { readBootstrapConfig, type BootstrapConfigFault } from '../config/bootstrap-config';
import { noiseCryptoForNode } from '../engines/noise-crypto-config';
import { openStrandNetworkState, openTrustedOwnerStore } from '../engines/rn-durable-slot';
import { readJoinBootstrap } from '../engines/join-bootstrap';
import { readRequireOwnerTrust } from '../engines/owner-trust-setting';
import {
  OwnerTrustUnreadableError,
  readOwnerTrustClassification,
  reanchorOwnKey,
  type OwnerStoreKind,
  type OwnerTrustState,
} from '../engines/owner-trust';
import { REPLICATION_PROOF_ENABLED } from '../engines/proof-flags.generated';
import { hostPoolRendezvous } from '../engines/pool-rendezvous-host';
import { startPairMintHost, type PairMintHost } from '../engines/pair-mint-host';
import type { PairMintReply, PairMintRequest } from '@votetorrent/vote-engine/rn';

// ---------------------------------------------------------------------------
// `Promise.withResolvers` ambient augmentation (D-08/D-09).
//
// Runtime support is already there — polyfilled at `polyfills.bootstrap.js`
// for Hermes, and native under the repo-pinned Node 22.15.0 (`.nvmrc`), so
// jest resolves it too. What is missing is the TYPE: the pinned
// TypeScript@5.0.4 predates the `es2024.promise` lib (added in TS 5.4), so
// `@react-native/typescript-config`'s `lib` array has no entry that declares
// it. This augments `PromiseConstructor` project-wide rather than widening
// `lib`, since the installed compiler has no es2024 lib file to add.
// ---------------------------------------------------------------------------
declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    };
  }
}

// ---------------------------------------------------------------------------
// Context type
// ---------------------------------------------------------------------------

/**
 * CadreNodeSettlement — the one-time outcome of the boot effect (D-08/D-09).
 *
 * `status: 'ready'` implies `node` is the same non-null instance the context
 * exposes (the strand backend is the correct dispatch). `status: 'failed'`
 * implies `node` is null (solo is correct). This pair exists because
 * `node === null` alone is ambiguous — it means BOTH "still booting" and
 * "boot already failed", and a consumer cannot tell them apart without this.
 */
export interface CadreNodeSettlement {
  status: 'ready' | 'failed';
  node: AuthorityCadreNode | null;
}

interface CadreNodeContextType {
  /** The live CadreNode instance (null until started). */
  node: AuthorityCadreNode | null;
  /** Event-driven sync state derived from CadreNodeEvents (D-10 — no polling). */
  syncState: 'connected' | 'syncing' | 'offline';
  /**
   * A bootstrap-configuration fault, distinct from being offline: offline
   * means we could not reach peers, a fault means we were never told which
   * peers to reach (D-14). `null` when `bootstrap.config.json` parsed to a
   * valid, non-empty address list.
   */
  configFault: BootstrapConfigFault | null;
  /**
   * Returns the number of connected peers for a given strandId.
   * Reads node.getStrand(strandId).connectedPeers ?? 0.
   */
  connectedPeers: (strandId: string) => number;
  /**
   * D-08/D-09: a one-time-settling promise reporting whether the CadreNode
   * boot ended `'ready'` (a live node, strand backend correct) or `'failed'`
   * (no node, solo backend correct). Resolved exactly once per provider
   * mount from the boot effect's existing exits, NEVER rejected, and stable
   * across renders (ref-held) — see `CadreNodeSettlement` above.
   */
  nodeSettled: Promise<CadreNodeSettlement>;
  /**
   * Saved owner trust (D-08..D-11). Priority blocked > memory-only > needs-reinvite > ok:
   *  - 'blocked'        the saved store would not open and the officer requires saved trust; no node was
   *                     started (`nodeSettled` is failed). The copy says to reopen the app.
   *  - 'memory-only'    the saved store would not open; the node runs on cadre-core's in-memory anchor,
   *                     which a restart loses.
   *  - 'needs-reinvite' the saved anchor is empty in a cadre this phone does not own; a fresh invitation
   *                     is the only way to restore the pins.
   *  - 'ok'             anything else. A consumer that finds the value missing treats it as 'ok'.
   * There is deliberately no retry or restart member on this context.
   */
  ownerTrust: OwnerTrustState;
  /**
   * Re-classifies and never pins. Resolves with the state unchanged when there is no node or the store is
   * not the persistent one (memory-only, blocked). Sets 'ok' or 'needs-reinvite' otherwise. Rejects
   * OwnerTrustUnreadableError, leaving the state unchanged, when the classification cannot be read.
   */
  refreshOwnerTrust: () => Promise<void>;
}

/** The owner phone's own pair-mint path: see {@link usePairMintLocal}. */
export type PairMintLocal = (request: PairMintRequest) => Promise<PairMintReply>;

/**
 * Browser pairing (D-26, D-28) has its own small context, so the node context's member set stays as it is.
 * Outside the provider the getter returns null.
 */
const PairMintLocalContext = createContext<() => PairMintLocal | null>(() => null);

/**
 * Returns a getter for the owner phone's own pair-mint path, for pairing this officer's browser through
 * the same service a member's phone reaches over the wire. The getter returns null on a phone that is not
 * an owner, before the host attached and after it detached. The request must carry this phone's identity
 * peer id (`node.peerId.toString()`) as `requesterPeerId`, or the service refuses `requester-mismatch`.
 */
export function usePairMintLocal(): () => PairMintLocal | null {
  return useContext(PairMintLocalContext);
}

const CadreNodeContext = createContext<CadreNodeContextType | null>(null);

/**
 * useCadreNode — consume the CadreNode context.
 * Must be called from a component under CadreNodeProvider.
 */
export function useCadreNode(): CadreNodeContextType {
  const ctx = useContext(CadreNodeContext);
  if (!ctx) {
    throw new Error("useCadreNode must be used within a CadreNodeProvider");
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// D-14: bootstrap addresses now come from `bootstrap.config.json` (app root),
// parsed and validated by `readBootstrapConfig` (src/config/bootstrap-config.ts)
// — the same mechanism, document shape and fault taxonomy as the sibling RN
// app and the browser's `apps/VoteTorrentPublic/src/peer/config.js` (56-06).
// The prior pair of hard-coded, sentinel-carrying constants that used to
// stand here is gone; see `src/config/bootstrap-config.ts`'s own header and
// `.planning/todos/completed/` for the retired shape and why it had to go.
//
// The committed document ships an EMPTY bootstrapNodes list, which
// readBootstrapConfig reports as a fault (kind 'missing', reason
// 'empty-address-list') rather than a silent solo boot — see configFault
// below.
//
// Correcting a stale claim this block used to carry: the P2P-06 replication
// proof harness does NOT rewrite this file. `scripts/run-replication-proof.sh`
// names `src/engines/replication-proof-runner.ts` as its CONFIG_FILE, and that
// dev harness keeps its own sentinel deliberately (see the plan's threat model
// / 56-10-SUMMARY.md for the full survivor list).
// ---------------------------------------------------------------------------
const PARTY_ID = 'votetorrent';

/** The store scope for this node's two saved records (strand network state and trusted owners). */
const CADRE_STORE_SCOPE = 'votetorrent-cadre-node';

/** Strand-address re-ask interval (ms); see the `controlCohort` comment in the CadreNode config. */
const STRAND_ADDR_REFRESH_MS = 30_000;

const bootstrapConfig = readBootstrapConfig(bootstrapConfigDoc);

/**
 * resolveBootstrapNodes — blank-safe single-address guard (P2P-02).
 *
 * Pure + exported for unit testing without booting a real (ESM-only) CadreNode.
 *
 * Returns [] for an empty, undefined or whitespace-only address — booting a
 * CadreNode with an empty bootstrapNodes array is the valid offline/solo case
 * and does NOT throw (clean cold start, no red toast). Returns [addr] for
 * anything else, so the bootstrap dial / real P2P path stays reachable. The
 * input source changed (D-14 — a validated config document instead of a
 * hard-coded constant); this function's signature and contract did not.
 */
export function resolveBootstrapNodes(addr: string): string[] {
  if (!addr || !addr.trim()) {
    return [];
  }
  return [addr];
}

// The `STRAND_RELAY_LISTEN_ADDRS` constant that stood here is REMOVED.
//
// It was already dead: spike 062 retired the `strandNetwork` per-node-type override on
// cadre-core 0.10.0 (upstream gave each strand node its own derived transport peerId), and
// nothing has read this constant since — only its own declaration and a comment referenced it.
//
// It is removed rather than left dead because it CONSTRUCTED the relay-qualified
// `<addr>/p2p-circuit` shape, which cadre-core 0.12.0 now rejects outright on a control node.
// Leaving it would keep a fatal, load-bearing-looking pattern in a file whose relay config is
// the exact thing 0.12.0 changed. Relays are named by `network.relayAddrs` below.

// cadre-core 0.12.0: relays are named by `network.relayAddrs`, NOT by a relay-qualified
// `network.listenAddrs` entry — the old shape is now REJECTED at construction on a control
// node ("network.listenAddrs names a relay directly ... Move the relay to
// network.relayAddrs, which reserves after bring-up").
//
// WHY upstream changed it: a `<relay>/p2p-circuit` listen entry takes libp2p's 'configured'
// route, which dials the relay from inside `libp2p.start()` — during the bring-up quiet
// period that denies exactly that dial, so `listen()` fails and the transport manager's
// FATAL_ALL aborts start. `relayAddrs` takes the 'search' route (one bare `/p2p-circuit`
// listener, no dial) and CadreNode.start() drives the reservation explicitly once the
// control database is up. Failure is still fail-fast: a relay that never answers throws
// RelayReservationFailedError out of start().
//
// Entries are the BARE relay addrs; cadre-core appends `/p2p-circuit` itself. Still routed
// through the blank-safe resolveBootstrapNodes guard per address, so an empty validated
// address list yields [] (degraded, not a crash) — see configFault above for why an empty
// list is now a reported fault rather than a silent one.
const CONTROL_RELAY_ADDRS = bootstrapConfig.addrs.flatMap(resolveBootstrapNodes);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * CadreNodeProvider — P2P-02
 *
 * Boots a CadreNode for the app lifecycle. Constructs the node once via useRef,
 * starts it inside a useEffect (non-blocking initial render — D-06), persists
 * peerId across restarts via loadOrCreateRNPeerKey (D-06 / T-22-04).
 *
 * Registers CadreNode event listeners in a separate effect to derive an
 * event-driven syncState. No polling or setInterval (D-10).
 *
 * Wrap AppProvider with CadreNodeProvider at the app root
 * (CadreNodeProvider outer, AppProvider inner).
 */
export function CadreNodeProvider({ children }: PropsWithChildren) {
  // syncState 'offline' by default — updated by CadreNode events (D-10).
  const [syncState, setSyncState] = useState<'connected' | 'syncing' | 'offline'>('offline');
  // nodeRef holds the stable CadreNode instance (created once per mount).
  const nodeRef = useRef<AuthorityCadreNode | null>(null);
  const detachRendezvousRef = useRef<(() => Promise<void>) | null>(null);
  const pairMintHostRef = useRef<PairMintHost | null>(null);
  // nodeState is the node instance exposed via context (set after construction).
  const [node, setNode] = useState<AuthorityCadreNode | null>(null);
  // D-08..D-11: what the boot learned about the saved owner anchor, and which store backs the node.
  const [ownerTrust, setOwnerTrust] = useState<OwnerTrustState>('ok');
  const storeKindRef = useRef<OwnerStoreKind | null>(null);

  // D-08/D-09: nodeSettled — a one-time-settling promise resolved from the
  // boot effect's existing exits (never rejected). Built with
  // `Promise.withResolvers()` (polyfilled at polyfills.bootstrap.js for
  // Hermes; native under the repo-pinned Node 22.15.0 `.nvmrc`, so it
  // resolves in both the device and the jest environment) and held via the
  // lazy `if (!ref.current)` guard (mirrors AppProvider.tsx's
  // engineFactoryRef idiom) so the pair is constructed once per mount, not
  // discarded and rebuilt on every render.
  const nodeSettledRef = useRef<ReturnType<typeof Promise.withResolvers<CadreNodeSettlement>> | null>(null);
  if (!nodeSettledRef.current) {
    nodeSettledRef.current = Promise.withResolvers<CadreNodeSettlement>();
  }
  // Idempotency guard: the boot effect's three exits must resolve at most
  // once even though more than one could technically be reached.
  const nodeSettledResolvedRef = useRef(false);
  const settleNode = useCallback((settlement: CadreNodeSettlement) => {
    if (nodeSettledResolvedRef.current) return;
    nodeSettledResolvedRef.current = true;
    nodeSettledRef.current!.resolve(settlement);
  }, []);

  // Boot effect: construct + start the CadreNode.
  // Runs once on mount ([] dep array). node.start() is NOT called in the
  // provider body — must not block initial render (D-06 / T-22-03).
  useEffect(() => {
    let isMounted = true;
    let localNode: AuthorityCadreNode | null = null;

    async function bootNode() {
      // Spike 093: the P2P-11 replication proof boots its OWN CadreNode. Booting this one too puts
      // two cadre nodes on one Hermes JS thread for the whole run, and on React Native that cost
      // compounds per node (sereus-chat measured control-DB bring-up at 761 ms -> 3 s -> 43 s as
      // nodes were added to one device, and the extra nodes could not obtain a relay reservation
      // at all). The proof owns the device; this node sits the run out. Dev-only by construction.
      if (__DEV__ && REPLICATION_PROOF_ENABLED) {
        console.info('[CadreNodeProvider] skipped: the replication proof owns this device\'s cadre node');
        settleNode({ status: 'failed', node: null });
        return;
      }

      // D-14: a config fault does not block boot — the node still constructs
      // and starts (degraded, solo), it is just loud about why. Exactly one
      // console.error, naming only the closed kind/reason tokens — never the
      // document, never an address (T-56-10-03).
      if (bootstrapConfig.fault) {
        console.error(
          '[CadreNodeProvider] bootstrap config fault:',
          bootstrapConfig.fault.kind,
          bootstrapConfig.fault.reason,
        );
      }

      try {
        // Peer-identity store — 'votetorrent-cadre-node' gives a stable peerId
        // across app restarts (D-06 / T-22-04). This handle is used ONLY for
        // loadOrCreateRNPeerKey; block storage is per-scope (see below).
        const identityDb = openOptimysticRNDb({
          openFn: (n, c, e) => new LevelDB(n, c, e),
          WriteBatch: LevelDBWriteBatch,
          name: 'votetorrent-cadre-node',
        });
        const privateKey = await loadOrCreateRNPeerKey(identityDb);

        // ISO-01 (cross-network isolation fix): the storage provider MUST open a
        // DISTINCT LevelDB per scope, keyed by the id cadre-core passes in.
        //
        // Root cause it fixes: the optimystic plugin maps every table to the
        // collection URI `tree://default/{TableName}`
        // (quereus-plugin-optimystic chunk-HPFDTDHY.js:1885) and caches the local
        // transactor under the key `local:libp2p` (getTransactorKey — no
        // networkName/strandId). Neither the collection URI nor the transactor key
        // carries the strandId. The ONLY thing that isolates one strand's blocks
        // from another's is the LevelDBRawStorage instance (the underlying LevelDB
        // directory). cadre-core is built for exactly this: it calls
        // `provider(strandId)` per strand (strand-instance-manager.js:21) and
        // `provider(controlStorageScope(partyId))` — 'control-<hex(partyId)>' — for the control DB.
        //
        // The previous `() => new LevelDBRawStorage(db)` IGNORED that argument and
        // returned one shared LevelDB, so EVERY network's Authority/Officer/Admin
        // rows landed in the same `tree://default/Authority` keyspace. The
        // first-network "shoe-in" InsertValid branch requires
        // `(select count(*) from Authority) = 1`, which only holds for the very
        // first network on a fresh install — every subsequent create saw count >= 2
        // and failed `QuereusError: CHECK constraint failed: InsertValid`
        // (confirmed on-device 2026-06-25: pre-create counts User=1 Authority=3
        // Admin=1, then Authority 3->4 within the txn → read-your-own-writes works,
        // the count was simply contaminated by prior networks).
        //
        // Fix: open (and cache) one LevelDB per scope id. The id is the strand hash
        // (H16 hex) or the literal 'control'; both are filesystem-safe, but
        // sanitize defensively to match cadre-core's own getStrandStoragePath
        // convention (replace(/[^a-zA-Z0-9-]/g, '_')).
        // ISO-01 per-scope storage + release-build persistence guardrail — see engines/storage-guard.ts.
        const scopedStorageProvider = createScopedRnStorageProvider();

        // cadre-core 1.9.0 strand network state (the saved FRET table), durable across launches.
        // In memory it dies with the process, and on a phone every launch is a restart.
        const strandNetworkStateStore = await openStrandNetworkState(PARTY_ID, CADRE_STORE_SCOPE);

        // D-08: the saved trusted-owner anchor. Without it a restart leaves cadre-core's in-memory anchor
        // and every voter is refused at the pool rendezvous. `open` rejects only when the slot cannot be
        // READ; a corrupt record loads empty (owner-trust.ts covers that). Its failure is its own try.
        let trustedOwnerStore: TrustedOwnerStore | null = null;
        let storeKind: OwnerStoreKind = 'persistent';
        try {
          trustedOwnerStore = await openTrustedOwnerStore(PARTY_ID, CADRE_STORE_SCOPE);
        } catch {
          // D-10 / D-11. The setting is read ONLY on this path, and an unreadable setting counts as ON.
          const strict = await readRequireOwnerTrust().catch(() => true);
          if (strict) {
            console.error('[CadreNodeProvider] trusted-owner store unavailable and saved owner trust is required; the node was not started');
            if (isMounted) setOwnerTrust('blocked');
            settleNode({ status: 'failed', node: null });
            return;
          }
          console.warn('[CadreNodeProvider] trusted-owner store unavailable; using the in-memory anchor');
          storeKind = 'memory';
        }
        storeKindRef.current = storeKind;

        // A joined Authority install's bootstrap is the member machines its join code named. They are
        // bootstrap peers only and never relay reservation targets, as the Voter does
        // (apps/VoteTorrentVoter/src/providers/CadreNodeProvider.tsx l.239-245; D-26, research M4).
        // The recovery rebuild below reuses this list, and the control-scope wipe leaves the
        // AsyncStorage record alone. The read never rejects, so an unreadable record boots on config.
        const joinBootstrap = await readJoinBootstrap();
        const bootstrapNodes = [...new Set([...CONTROL_RELAY_ADDRS, ...joinBootstrap])];

        // cadre-core 1.18: keep the owner key = the identity key (engines/identity-owner-key.ts).
        const makeNode = () => withIdentityOwnerKey(new CadreNode({
          privateKey,
          controlNetwork: { partyId: PARTY_ID, bootstrapNodes },
          strandNetworkState: { store: strandNetworkStateStore },
          // D-08: spread only when the store opened. The recovery rebuild reuses this closure, so it gets
          // the SAME store (cadre-core keeps an injected store across stop and start).
          ...(trustedOwnerStore ? { trustedOwners: { store: trustedOwnerStore } } : {}),
          profile: 'transaction',
          // sApp-schema signing is DISABLED for VoteTorrent — a deliberate project
          // decision, not an oversight.
          //
          // This policy was never a VoteTorrent requirement. It arrived as an UPSTREAM
          // fail-closed default when the project de-vendored to published
          // @serfab/cadre-core@0.8.1 (d67a649, 2026-07-13): cadre-core's
          // strand-instance-manager.js:101 does `config.requireSignedSchemas ?? true`
          // and calls assertSchemaSignature(), which throws
          // SchemaVerificationError('missing signature') for any sAppConfig without a
          // `signature` field. VoteTorrent's schema (rn-db-factory.ts sAppConfig:
          // id 'org.votetorrent' v1.0.0) has no signature, so EVERY network creation
          // failed with "Failed to create database context: SchemaVerificationError"
          // (networks-engine.ts:59) — reproduced on-device in the release APK.
          //
          // Setting it to a literal `false` (NOT `!__DEV__`) is what "remove entirely"
          // requires: `!__DEV__` evaluates to TRUE in a release build, so it only ever
          // relaxed the policy for debug builds and left release permanently broken.
          // The relaxation excuses ONLY an absent signature — cadre-core still rejects a
          // present-but-invalid one (schema-verification.js:82) — so a signed schema
          // would still be verified if VoteTorrent ever adopts signing.
          requireSignedSchemas: false,
          strandFilter: { mode: 'all' },
          // ISO-01: per-scope storage. cadre-core invokes provider(scopeId) with the
          // strandId for each strand and 'control' for the control DB — one distinct
          // LevelDB per scope isolates each network's collections.
          storage: { provider: scopedStorageProvider },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          // CONTROL node network — reserves through the drone's CONTROL relay (P2P-11 41-11).
          network: {
            // cadre-core 1.13.0 stamps the strand-addr refresh per (sibling, strand) from the
            // sibling's OUTCOME: an answer, even an empty one, waits the full default (10 min).
            // A sibling that answered before it held the strand's addresses therefore blinds this
            // phone (round-3 UAT test 15: no strand socket for >60 s after Connect). Re-ask every
            // 30 s until the upstream fix lands; see the strand-addr-refresh-throttle todo.
            controlCohort: { strandAddrRefreshMs: STRAND_ADDR_REFRESH_MS },
            transports: [
              webSockets(),
              // D-10: cast by the global transportSymbol, not structural type — the
              // sereus-chat pattern for multi-copy @libp2p/interface brand-skew
              // (Probe 4, 41-01: not load-bearing on Node's single-copy graph but
              // re-verified at Metro/Hermes on device).
              circuitRelayTransport({
                // PROBE 5 (41-01, EXERCISED): N relay-qualified listenAddrs ALONE do
                // NOT yield N reservations under the default circuitRelayTransport() —
                // DEFAULT_RESERVATION_CONCURRENCY=1 serializes the reserve queue and
                // drops any 2nd+ reservation via reserveQueue.clear(). Size concurrency
                // to the number of known control relays driving CONTROL_RELAY_ADDRS
                // (never less than 1).
                reservationConcurrency: Math.max(1, CONTROL_RELAY_ADDRS.length),
              }) as unknown as ReturnType<typeof webSockets>,
            ],
            // D-03/D-05: always-on relay reservation-seeking (P2P-08 drone-relay path),
            // relay-qualified — but scoped to the drone's CONTROL relay (P2P-11 41-11).
            // The STRAND relay moves to strandNetwork below, so the control and strand
            // libp2p nodes no longer collide at one relay under this peer's shared PeerId.
            relayAddrs: CONTROL_RELAY_ADDRS,
            // Fail-soft on the FIRST reservation attempt. cadre-core's default (requireRelay unset)
            // throws RelayReservationFailedError out of start() when that attempt lands nothing
            // inside its budget (18 s at the default link), and this provider then stops the node
            // and settles 'failed' for the whole process: no strand network can open until the
            // app is killed. 64-53 hit exactly that on a relaunched keyholder (status: retrying)
            // while the relay refused nothing and admitted a reservation within the same minute.
            // `false` runs the SAME drive and keeps the SAME background supervisor re-driving the
            // reservation; only the throw is dropped, so a slow relay or a starved JS thread costs
            // dialability for a while instead of the session.
            requireRelay: false,
            // Permissive gater — allows loopback / emulator host dials (D-11).
            // Per-strand enrollment gating is v2.x scope.
            connectionGater: { denyDialMultiaddr: async () => false },
            // Spike 093: native Noise crypto (react-native-quick-crypto) for the control node
            // AND every strand node. Pure-JS Noise on Hermes saturated the JS thread during
            // bring-up. See engines/noise-crypto-config.ts.
            noiseCrypto: noiseCryptoForNode(),
          } as any,
          // SPIKE 062 — the `strandNetwork` override block is REMOVED on cadre-core 0.10.0.
          //
          // It was VT's 41-11 workaround for the shared-PeerId circuit-relay-v2 collision:
          // give strand nodes a SECOND relay identity so the relay could not misroute their
          // streams onto the control connection. Upstream fixed the root cause instead —
          // `strandTransportKey(identityKey, strandId)` gives each strand its OWN derived
          // transport peerId (sereus#1, spike 059) — so one relay is now correct and the
          // two-relay topology is obsolete.
          //
          // Both keys this block carried are DEAD CONFIG on 0.10.0 (verified: zero
          // occurrences of either in the published types/dist):
          //   - `strandNetwork`         — the config key our dropped yarn-patch added
          //   - `strandBootstrapNodes`  — replaced by `resolveCohortSeed`, which derives
          //     strand peers from the CONTROL cohort (`queryCadrePeers()` → siblings with a
          //     live control connection → `/sereus/strand-addr/1.0.0` RPC), not from an
          //     app-supplied strand multiaddr.
          //
          // Strand nodes therefore inherit `network` above (the single control relay), which
          // is the topology upstream's delegate-admission path expects.
          hibernation: { enabled: false },
          // Change notifications (cadre-core 1.20 `strandReactivity`, optimystic cohort-topic substrate): every
          // strand node announces the commits it coordinates, and tables tagged "optimystic.network_watch" get a
          // network watch, so a screen (useStrandChanges) is woken by a commit made on ANOTHER machine instead of
          // waiting for its focus reload or a timer. It is also what gives the strand node its matchmaking
          // handlers (Voter: pool-matchmaking-ports.ts). Cost: one cohort-topic host per strand node (db-p2p
          // builds it as a core host, 30 s renewals, even on a phone); measure CPU on the Redmi before release.
          strandReactivity: { enabled: true },
        }), privateKey);

        // node.start() is inside useEffect — never blocks initial render (D-06 / T-22-03).
        localNode = makeNode();
        try {
          await localNode.start();
        } catch (startError) {
          // Spike 105: a control store an older cadre-core wrote (1.13 -> 1.14: Revocation.RowIsGone
          // still references the dropped PendingJoin) can be neither migrated nor restored, so every
          // launch fails. cadre-core's policy is to recreate it. Recreate ONLY the control scope —
          // the peer key and every network's strand store stay — and start once more. See
          // engines/control-schema-recovery.ts for why the Authority's networks survive this.
          if (!isUnrestorableControlSchemaError(startError)) throw startError;
          const controlScope = controlStorageScope(PARTY_ID);
          console.warn(`[CadreNodeProvider] control store '${controlScope}' was written by an older cadre-core and cannot be migrated; recreating it`);
          await localNode.stop().catch(() => undefined);
          await scopedStorageProvider.destroyScope(controlScope);
          localNode = makeNode();
          await localNode.start();
        }

        // D-08 founder re-anchor: anchors this node's own key when its OwnerKey row is live. It never
        // pins a foreign key. Bounded and never rejecting, so it cannot stop the boot.
        await reanchorOwnKey(localNode);
        // D-09: classify AFTER the re-anchor. An unreadable read reports 'ok' (the token is logged).
        const classification = storeKind === 'persistent' ? await readOwnerTrustClassification(localNode, 'persistent') : 'ok';
        const nextTrust: OwnerTrustState =
          storeKind === 'memory' ? 'memory-only' : classification === 'needs-reinvite' ? 'needs-reinvite' : 'ok';

        if (isMounted) {
          nodeRef.current = localNode;
          setOwnerTrust(nextTrust);
          // Spike 102: this node is the rendezvous its voters pool their votes through. Best
          // effort — a voter that cannot reach it keeps its vote saved, never lost.
          const hosted = localNode;
          hostPoolRendezvous(hosted)
            .then((detach) => {
              if (nodeRef.current === hosted) detachRendezvousRef.current = detach;
              else void detach();
            })
            .catch((e) => console.warn('[CadreNodeProvider] pool rendezvous not hosted:', e instanceof Error ? e.message : String(e)));
          // D-26/D-28: an owner phone answers browser-pairing mint requests from its cadre's officer phones.
          // Owner phones only (startPairMintHost resolves null elsewhere), best effort and never awaited, so the
          // boot is unchanged; the log names the error class only. A phone that becomes an owner later hosts
          // from its next launch.
          startPairMintHost(hosted)
            .then((host) => {
              if (!host) return;
              if (nodeRef.current === hosted) pairMintHostRef.current = host;
              else void host.detach().catch(() => undefined);
            })
            .catch((e) => console.warn('[CadreNodeProvider] pair-mint not hosted:', e instanceof Error ? e.name : 'unknown'));
          setNode(localNode);
          // D-08/D-09: success exit — the strand backend is now the correct dispatch.
          settleNode({ status: 'ready', node: localNode });
        } else {
          // Component unmounted before start completed — clean up.
          await localNode.stop().catch(() => undefined);
          // D-08/D-09: the node was just stopped; resolve 'failed' with null so
          // the contract stays total (no path leaves nodeSettled pending).
          settleNode({ status: 'failed', node: null });
        }
      } catch (e) {
        console.error('[CadreNodeProvider] Boot error:', e instanceof Error ? e.stack : String(e));
        try {
          await localNode?.stop();
        } catch {
          // ignore stop errors
        }
        // D-08/D-09: this is the exit that today swallows the error and leaves
        // `node` null forever with no future trigger — nodeSettled now makes
        // that "boot already failed" state distinguishable from "still booting".
        settleNode({ status: 'failed', node: null });
      }
    }

    bootNode();

    return () => {
      isMounted = false;
      void detachRendezvousRef.current?.().catch(() => undefined);
      detachRendezvousRef.current = null;
      void pairMintHostRef.current?.detach().catch(() => undefined);
      pairMintHostRef.current = null;
      // Stop on unmount. Errors are swallowed since the component is gone.
      nodeRef.current?.stop().catch(() => undefined);
      nodeRef.current = null;
    };
    // Empty dep array: one boot per mount.
  }, []);

  // Event-driven sync state effect. Re-runs when node is set (after boot).
  // Registers CadreNode event listeners; returns cleanup that removes them.
  // NO polling (D-10 hard requirement — no setInterval anywhere).
  //
  // First-sync gate (quick task 260928-kkf): cadre-core emits `strand:started`
  // (payload `{strandId}` only) for a GATED joiner whose `database` is still unset —
  // `onStrandStarted` used to map that unconditionally to 'connected', which is wrong
  // for exactly the joiner this gate exists for. Fix: read `node.getStrand(strandId)`
  // — `database` unset means the strand is still gated (not yet writable) ⇒ 'syncing';
  // `database` present, OR no strandId / no instance at all (the existing test emits
  // a payload-less 'strand:started'), means the prior 'connected' behaviour is still
  // correct. Checked via `database` PRESENCE, not `status`, because a gated instance
  // can also read 'idle' (strand-instance-manager.js) — status is not the signal here.
  // `strand:writable` is the gate's OWN resolution event; nothing listened for it
  // before this fix.
  useEffect(() => {
    if (!node) return;

    const onConnected = () => setSyncState('connected');
    const onStrandStarted = (e?: { strandId?: string }) => {
      const instance = e?.strandId ? node.getStrand(e.strandId) : undefined;
      setSyncState(instance && !instance.database ? 'syncing' : 'connected');
    };
    const onStrandWritable = () => setSyncState('connected');
    const onStrandIdle = () => setSyncState('syncing');
    const onStrandError = () => setSyncState('offline');
    const onDisconnected = () => setSyncState('offline');

    node.on('control:connected', onConnected);
    node.on('strand:started', onStrandStarted);
    node.on('strand:writable', onStrandWritable);
    node.on('strand:idle', onStrandIdle);
    node.on('strand:error', onStrandError);
    node.on('control:disconnected', onDisconnected);

    return () => {
      node.off('control:connected', onConnected);
      node.off('strand:started', onStrandStarted);
      node.off('strand:writable', onStrandWritable);
      node.off('strand:idle', onStrandIdle);
      node.off('strand:error', onStrandError);
      node.off('control:disconnected', onDisconnected);
    };
  }, [node]);

  // connectedPeers reads live data from the StrandInstance (no polling — D-10).
  const connectedPeers = useCallback(
    (strandId: string): number => {
      if (!nodeRef.current) return 0;
      return nodeRef.current.getStrand(strandId)?.connectedPeers ?? 0;
    },
    [],
  );

  // Re-classifies only; never pins (D-09). See the context type for the exact semantics.
  const refreshOwnerTrust = useCallback(async (): Promise<void> => {
    const n = nodeRef.current;
    if (!n || storeKindRef.current !== 'persistent') return;
    const result = await readOwnerTrustClassification(n, 'persistent');
    if (nodeRef.current !== n) return;
    if (result === 'unreadable') throw new OwnerTrustUnreadableError();
    setOwnerTrust(result);
  }, []);

  // The attached host's own-request path, or null (no host on this phone, or not attached yet).
  const getPairMintLocal = useCallback((): PairMintLocal | null => pairMintHostRef.current?.handleLocal ?? null, []);

  return (
    <CadreNodeContext.Provider
      value={{
        node,
        syncState,
        configFault: bootstrapConfig.fault,
        connectedPeers,
        nodeSettled: nodeSettledRef.current.promise,
        ownerTrust,
        refreshOwnerTrust,
      }}
    >
      <PairMintLocalContext.Provider value={getPairMintLocal}>
      {children}
      </PairMintLocalContext.Provider>
    </CadreNodeContext.Provider>
  );
}
