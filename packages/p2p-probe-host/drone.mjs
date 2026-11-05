/**
 * packages/p2p-probe-host/drone.mjs — Phase 17 P2P-01 dial-proof host drone.
 *
 * Committed, repeatable dev tooling (Phase 22 reuse).  Ported from spike 009.
 *
 * A storage-profile CadreNode that listens on an ephemeral WebSocket address so
 * the Android emulator can dial it (emulator reaches the host at 10.0.2.2).
 * Boots, prints the control peerId + ws multiaddr, then stays alive.
 *
 * Prerequisites:
 *   This package is a normal yarn workspace — `yarn install` at the repo root installs its deps.
 *   The root `resolutions` pin uint8arrays only for ^5 ranges (Hermes/quereus compat), so
 *   @multiformats/multiaddr's ^6 requirement resolves to a real v6 and strict Node ESM works.
 *   The connectionGater-pass-through patch this comment used to name was RETIRED at `ca9f1b87`.
 *   `.yarn/patches/` now carries the gossipsub and quereus patches plus the Phase 56
 *   `@serfab-cadre-core-npm-0.12.0-*` public-observer patch, which DOES resolve here (same
 *   workspace, same `@serfab/cadre-core` dependency) but is INERT on this drone: it only takes
 *   effect on a `CadreNode` configured with a non-empty `publicObserverStrandIds`, and this
 *   drone sets none — D-03's outer fail-closed layer, observed in the wild. This drone is NOT
 *   the public gateway; that is `packages/p2p-probe-host/gateway.mjs`.
 *
 * Usage:
 *   cd packages/p2p-probe-host
 *   nvm use 22
 *   node drone.mjs
 *
 *   Copy the printed ws multiaddr + peerId into CONTROL_ADDR in dial-probe.ts,
 *   then run ./scripts/run-dial-probe.sh.
 *
 * Exit: Ctrl-C (SIGINT) or `kill <pid>` (SIGTERM) — both gracefully stop the node.
 */
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { CadreNode, decodeCadreInvitation, ed25519KeyPairFromLibp2p } from '@serfab/cadre-core';
import { resolveStrandRole, strandFounderOption } from './strand-role.mjs';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { multiaddr } from '@multiformats/multiaddr';
import { generateKeyPair } from '@libp2p/crypto/keys';

const PARTY_ID = 'votetorrent'; // aligned with CadreNodeProvider.tsx line 55 (OQ1 conservative fix)
const L = (...a) => console.log('[drone]', ...a);

// P2P-06: the same votetorrent.qsql DDL the device peers apply via
// VOTETORRENT_SCHEMA_SQL (vote-engine re-export, generated from this file). The
// drone MUST host the identical schema so its strand is compatible with peers A/B.
const VOTETORRENT_QSQL_RAW = readFileSync(
  new URL('../vote-core/schema/votetorrent.qsql', import.meta.url),
  'utf8',
);

// cadre-core's StrandDatabase.executeSchema() wraps the sApp schema as
// `declare schema App { ${schema} } apply schema App;`. votetorrent.qsql is itself
// wrapped in `declare schema main { ... } apply schema main;`, so passing it verbatim
// nests invalidly and Quereus throws `got '}'`. Strip the outer wrapper so only the
// inner DDL is hosted — identical to the device peers' createStrandDbFactory, keeping
// the drone's strand schema-compatible. qsql has no `main.`-qualified refs (clean strip).
const VOTETORRENT_QSQL = VOTETORRENT_QSQL_RAW
  .replace(/^\s*declare\s+schema\s+\w+\s*\{/, '')
  .replace(/\}\s*apply\s+schema\s+\w+\s*;\s*$/, '')
  .trim();

// 38-05 (D-04 n=4 topology): cross-bootstrap parameterization so a SECOND drone
// process (drone-B) can bootstrap into drone-A's control network AND strand cohort,
// exactly as 38-02's two-drone-smoke.mjs proved (drone-B's controlNetwork.bootstrapNodes
// + network.strandBootstrapNodes pointed at drone-A's addrs). drone-A itself launches
// with these unset (empty defaults) — it remains the first bootstrap peer. Follows the
// existing `process.env.X ?? default` pattern used by STRAND_ID below.
const DRONE_BOOTSTRAP_CONTROL_ADDR = process.env.DRONE_BOOTSTRAP_CONTROL_ADDR ?? '';
// Resolved here (same expression as IS_FOUNDER below) so a bad DRONE_STRAND_ROLE exits before the node starts.
const STRAND_ROLE = resolveStrandRole(process.env, !DRONE_BOOTSTRAP_CONTROL_ADDR);
const DRONE_BOOTSTRAP_STRAND_ADDR = process.env.DRONE_BOOTSTRAP_STRAND_ADDR ?? '';

const identityKey = await generateKeyPair('Ed25519');
const node = new CadreNode({
  // Supply the identity key explicitly instead of letting libp2p mint an ephemeral one:
  // `getIdentityOwnerKey()` — which owner genesis needs — THROWS on an ephemeral key
  // ("node identity not resolved"), because that key is internal to libp2p and never
  // exposed. Without this the drone cannot run genesis, cannot mint an invite, and every
  // joiner is refused as a non-member: the P2P-11 wall. Matches tools/multipeer-gate.
  //
  // Freshly generated per boot is correct here: the harness captures this drone's address
  // (which carries its peerId) from PROOF_WS_ADDR= on every run, so nothing pins it across
  // restarts. The DEVICE peerId must be stable (D-05); this host-side drone's need not be.
  privateKey: identityKey,
  controlNetwork: {
    partyId: PARTY_ID,
    bootstrapNodes: DRONE_BOOTSTRAP_CONTROL_ADDR ? [DRONE_BOOTSTRAP_CONTROL_ADDR] : [],
  },
  profile: 'storage',
  // Published @serfab/cadre-core@0.8.1 enforces a fail-closed sApp-schema signature
  // policy (requireSignedSchemas defaults true): the unsigned org.votetorrent demo
  // schema this drone hosts is rejected at strand bring-up with
  // SchemaVerificationError('missing signature'). Relax the policy for this dev-harness
  // drone — the documented dev/test relaxation, at parity with the app's proof runners
  // (replication-proof-runner.ts / strand-persistence-proof-runner.ts).
  requireSignedSchemas: false,
  strandFilter: { mode: 'all' },
  network: {
    // No `controlCohort.strandAddrRefreshMs` override: the 15 s workaround for the per-STRAND
    // refresh throttle (sereus#21) is gone. cadre-core now tracks the refresh per
    // (sibling, strand), so a sibling that connects after a pass is asked on the next tick.
    // circuitRelayTransport() is the DIALER half of circuit-relay-v2, and this node needs it
    // even though it is itself a relay SERVER (the storage profile turns that on). Supplying
    // `transports` at all REPLACES @optimystic/db-p2p's defaults wholesale —
    // `libp2p-node-base.ts` does `options.transports ?? defaults.transports` — and it is those
    // defaults (via createLibp2pNode) that would otherwise carry it. Without it libp2p's dial
    // queue drops every /p2p-circuit address at the transport filter
    // (`dialTransportForMultiaddr` finds no transport willing to dial one) and the dial dies as
    // NoValidAddressesError against a perfectly reachable peer. Invisible on loopback, where
    // every peer is directly dialable and a circuit addr is never the only route; fatal behind
    // emulator NAT, where a phone is reachable ONLY through its reservation on the other drone.
    // Replication-proof run 14: 166 NoValidAddressesError on drone-B targeting the phones while
    // its own findCluster logged `addressless=0 selfRelayOnly=0` — it held good circuit addrs it
    // had no transport to use. cadre-core documents the same pairing for RN in types.d.ts.
    transports: [webSockets(), circuitRelayTransport()],
    listenAddrs: ['/ip4/0.0.0.0/tcp/0/ws'], // ephemeral — avoids EADDRINUSE
    // No `relayServerInit`: cadre-core now forwards it itself (sereus#19) and defaults a
    // party-run relay to uncapped reservations (applyDefaultLimit: false, 128 slots, 2 h),
    // the values spike 095 had to set here after 358 TransferLimitErrors at a 1 MiB cap.
    ...(DRONE_BOOTSTRAP_STRAND_ADDR && { strandBootstrapNodes: [DRONE_BOOTSTRAP_STRAND_ADDR] }),
  },
  // STRAND CLUSTER BREADTH (spike 062 re-run). cadre-core 0.10.0 exposes
  // `strandClusterSize`; it defaults to DEFAULT_STRAND_CLUSTER_SIZE = 4, described upstream
  // as "the smallest breadth whose 0.75 super-majority still commits with one holder
  // offline". That default is why the n=4 proof could form a cohort and still never
  // replicate: breadth 4 needs ceil(0.75 * 4) = 3 holders to commit, but each peer sees
  // `strandPeers=1` — a TWO-member cohort — so a commit can never reach quorum. Nothing
  // errors; the write just never becomes visible, which is exactly the observed signature
  // (clean logs, silent read-poll timeout).
  //
  // MIN_CLUSTER_SIZE is 2, and every node on one strand MUST agree on the value, so this is
  // set here AND in packages/p2p-probe-host/drone.mjs.
  //
  // Trade-off, stated upstream and accepted for a dev proof: at breadth 2 read repair cannot
  // converge, because a lone corroborator's stale answer is taken as the cluster's truth.
  // Commit correctness is unaffected — this is replication breadth, not safety.
  strandClusterSize: 2,
  hibernation: { enabled: false },
});

await node.start();
const addrs = node.getControlNode().getMultiaddrs().map(m => m.toString());
L('control peerId =', node.peerId?.toString());
L('control addrs  =', JSON.stringify(addrs));
// Machine-readable address line for the replication-proof harness (D-07 auto-injection).
// The human READY line below is a TEMPLATE with literal <PORT>/<PEER_ID> placeholders —
// scripts must parse THIS line, not that one. Prefer the loopback ws multiaddr; the harness
// rewrites 127.0.0.1 → 10.0.2.2 for the Android emulator host mapping.
const proofWsAddr = addrs.find(a => a.includes('/ip4/127.0.0.1/') && a.includes('/ws')) ?? addrs[0] ?? '';
L('PROOF_WS_ADDR=' + proofWsAddr);

// Provenance marker (P2P-11). Asserts at RUNTIME — not by grepping this file, and not from the
// source tree a bundler may or may not have picked up — that this node registered a transport
// willing to dial a /p2p-circuit address. This is the exact predicate libp2p's dial path uses
// (`transportManager.dialTransportForMultiaddr`, filtered at dial-queue.js:351); when it is
// false every dial to a phone behind emulator NAT dies as NoValidAddressesError before a packet
// leaves this process, and the drone looks healthy while replicating nothing.
try {
  const tm = node.getControlNode()?.components?.transportManager;
  const probe = proofWsAddr ? multiaddr(proofWsAddr + '/p2p-circuit') : undefined;
  const dialable = tm && probe ? tm.dialTransportForMultiaddr(probe) != null : undefined;
  L('CIRCUIT_DIALABLE=' + String(dialable));
} catch (err) {
  L('CIRCUIT_DIALABLE=unknown (' + (err?.message ?? err) + ')');
}
L('READY — update CONTROL_ADDR in dial-probe.ts with the /ip4/10.0.2.2/tcp/<PORT>/ws/p2p/<PEER_ID> addr above, then run ./scripts/run-dial-probe.sh');

// ── CADRE MEMBERSHIP: owner genesis + the invite/accept ceremony ────────────────────────
//
// WHY THIS EXISTS (P2P-11 root cause, 2026-08-24, re-confirmed 2026-09-03). Every device
// n=4 run through 38-21/41-09 failed with the strand cohort never forming. The cause is not
// addressing, relays or db-p2p: the devices are simply NOT MEMBERS. drone-A refuses their
// strand-addr requests with
//     sereus:cadre:strand-addr Refusing strand-addr from non-member <device control peerId>
// because `isAuthorizedMember` needs a CadrePeer row carrying an anchored voucher, and this
// harness never ran a ceremony that creates one. Devices were addressable but unauthorized,
// so their strand nodes received no cohort addresses and replication could never start.
//
// cadre-core deliberately never runs owner genesis implicitly — the hosting app owns it — so
// a harness must do it explicitly or every owner-signed control write (createCadreInvitation
// included) fails. This mirrors tools/multipeer-gate, which is the green n=4 reference for this
// ceremony; keep the two in step.
//
// cadre-core 1.14 replaced the two-sided invite ceremony (owner `createInvite`, joiner
// `trustOwnerKeys` + `dialInvite`, owner `acceptPhone`) with ONE-SIDED redemption: the owner
// mints a cadre invitation (`createCadreInvitation`), and the joiner redeems it at any member it
// can reach (`redeemCadreInvitation`). The member that answers seats the joiner's `CadrePeer`
// row itself, during the redemption — no owner-side accept, no peerId crossing a process
// boundary, no enrollment window (1.14 deleted it: a stranger's connection is now admitted
// provisionally and the per-stream protocol guard is the boundary). So the founder mints ONE
// multi-use invitation, the harness injects it into the phones and drone-B, and each redeems.
//
// The pre-1.14 auto-accept loop (`watchForJoiners`: authorize every connected non-member) is
// kept only as an OPT-IN fallback (DRONE_AUTO_ACCEPT=1), ported to `authorizePeer`. It is off by
// default because redemption already authorizes every joiner, and because under 1.14 every
// stranger holds a connection here for a while, so "connected" no longer implies "invited".
// DRONE_ENROL_DIR stays as an explicit out-of-band path (drop a file named for a peerId).
const IS_FOUNDER = !DRONE_BOOTSTRAP_CONTROL_ADDR;
const DRONE_ENROL_DIR = process.env.DRONE_ENROL_DIR ?? '';
const DRONE_AUTO_ACCEPT = process.env.DRONE_AUTO_ACCEPT === '1';
// A joiner drone (drone-B) redeems the founder's invitation; the harness passes it through from
// the founder's PROOF_INVITE= line. Unset on the founder, which mints its own.
const DRONE_INVITE = process.env.DRONE_INVITE ?? '';
// One invitation serves every joiner of a run: drone-B and both phones redeem it (3 uses), and
// a phone that restarts mid-run re-redeems idempotently without spending a seat. The surplus is
// headroom for a re-run against the same drone. Lifetime covers the longest device runs (~40 min)
// with margin; nothing has to refresh it.
const DRONE_INVITE_USES = Number(process.env.DRONE_INVITE_USES ?? 8);
const ENROL_WINDOW_MS = Number(process.env.DRONE_ENROL_WINDOW_MS ?? 6 * 60 * 60 * 1000);
// Poll interval for the opt-in auto-accept fallback, overridable so a test can drive ticks
// FASTER than an accept returns — the only way to reproduce the re-entrancy race on fast
// loopback, where the accept completes well inside the default interval.
const ENROL_POLL_MS = Number(process.env.DRONE_ENROL_POLL_MS ?? 2000);
// Grace before a newly-seen peer is treated as a phone, so a strand node's delegate grant
// can land first. Settle time after a successful accept, so the next accept in the same tick
// does not read through that write's convergence window. Bound on transient accept retries.
const DELEGATE_GRACE_MS = Number(process.env.DRONE_DELEGATE_GRACE_MS ?? 15000);
const ENROL_SETTLE_MS = Number(process.env.DRONE_ENROL_SETTLE_MS ?? 4000);
const ENROL_TRANSIENT_MAX_ATTEMPTS = Number(process.env.DRONE_ENROL_MAX_ATTEMPTS ?? 12);

if (IS_FOUNDER) {
  // Owner genesis MUST run while this node is still SOLO. It writes owner-signed control
  // state; once the control DB is spread across a cohort, that write needs a quorum the
  // joiners cannot yet serve and it fails with
  //   Block default/Revocation is unavailable (peers-unreachable)
  // drone-A boots with empty bootstrapNodes, so "solo" holds here by construction — but this
  // block must stay ABOVE addStrand and above anything that admits a peer.
  // cadre-core 1.18 deleted getIdentityOwnerKey(); derive the same identity owner key here.
  const owner = ed25519KeyPairFromLibp2p(identityKey);
  await node.trustOwnerKeys([owner.publicKeyB64], 'operator');
  const controlDb = node.getControlDatabase();
  if (!controlDb) throw new Error('founder has no control database after start()');
  await controlDb.ensureOwnerKey(owner.publicKeyB64);
  await node.initializeSeedBootstrap(owner.privateKeyB64);
  L(`owner genesis done (ownerKey=${owner.publicKeyB64.slice(0, 12)}…)`);

  // Untargeted (any redeemer), member-only (never an owner grant), multi-use. Minted while
  // solo, so the CadreInvite row commits locally with no quorum to wait on.
  const { encoded } = await node.createCadreInvitation({
    uses: DRONE_INVITE_USES,
    expiresInMs: ENROL_WINDOW_MS,
  });
  // Machine-readable, like PROOF_WS_ADDR= above: the harness greps this line and injects the
  // encoded invitation into the runner's PROOF_INVITE constant (D-07 injection pattern).
  L('PROOF_INVITE=' + encoded);
  L(`ENROL_INVITATION uses=${DRONE_INVITE_USES} expiresInMs=${ENROL_WINDOW_MS}`);

  if (DRONE_AUTO_ACCEPT) {
    if (DRONE_ENROL_DIR) {
      mkdirSync(DRONE_ENROL_DIR, { recursive: true });
      L('ENROL_WATCH=' + DRONE_ENROL_DIR);
    }
    watchForJoiners();
    L('ENROL_ARMED — auto-accepting connected non-members for the life of this run (DRONE_AUTO_ACCEPT=1)');
  }
} else if (DRONE_INVITE) {
  // A NON-founder drone (drone-B) is a joiner like any device and redeems the founder's
  // invitation. Redemption pins the invitation's owner keys into this node's anchor BEFORE it
  // dials (so drone-B verifies owner-signed control state rather than merely being admitted —
  // the gap fixed 2026-10-08 on the pre-1.14 API), and the answering member seats drone-B's
  // CadrePeer row. Not fatal on failure, so the run's logs still show what the drone saw.
  try {
    const result = await node.redeemCadreInvitation(decodeCadreInvitation(DRONE_INVITE));
    L(`ENROL_REDEEMED — admitted by ${result.peerId ?? '<unnamed member>'} at ${result.redeemedAt}`);
  } catch (e) {
    L('WARN ENROL_REDEEM_FAILED:', e?.name ?? '', e?.message ?? e);
  }
}

/**
 * Accept joiners: every peer connected to the control node that is not yet a member, plus any
 * peerId dropped into DRONE_ENROL_DIR out-of-band.
 *
 * Polling rather than an event subscription: this runs for the whole ~40-minute proof, a
 * missed `peer:connect` would silently cost the run, and a re-read costs nothing.
 */
function watchForJoiners() {
  // Peers whose ceremony reached a DEFINITE outcome (accepted, or refused on the merits).
  const settled = new Set();
  // peerId -> epoch ms first observed, so a delegate grant has a tick to land before we
  // mistake a strand transport for a phone (see the delegate guard below).
  const firstSeenAt = new Map();
  // peerId -> count of transient (infrastructure) accept failures, to bound the retries.
  const transientFailures = new Map();
  // The tick body awaits (authorizePeer, the settle delay), so it outlives the ENROL_POLL_MS
  // interval and overlapping invocations would otherwise interleave. `settled` is only
  // written AFTER the awaited accept — so without these two guards, concurrent ticks all pass
  // the `settled.has` check before any of them records the outcome, and the same peer is
  // accepted many times over (observed: 12 accepts of one peerId). That is precisely the
  // concurrent-CadrePeer-write contention that tore a multi-tree commit. `tickRunning`
  // serialises the ticks; `inFlight` is the belt-and-braces per-peer claim.
  let tickRunning = false;
  const inFlight = new Set();
  const selfId = node.peerId?.toString();

  // A control-DB read/write that could not be SERVED is not a membership verdict — the same
  // distinction the multipeer gate's L3 draws. `authorizePeer` reads `Revocation`/`CadrePeer`
  // to evaluate the joiner, so it surfaces cluster unavailability as a throw that looks
  // exactly like a refusal. Retrying these is the whole point; retrying a real refusal spins.
  const isTransientControlFailure = (msg) =>
    /unavailable \((?:peers|cohort)-unreachable\)|could not determine whether it exists|exhausted \d+ retries|unresolved rival action|was not atomic/i.test(msg);

  setInterval(async () => {
    if (tickRunning) return; // a previous tick is still awaiting an accept/settle
    tickRunning = true;
    try {
    const candidates = new Set();

    // Primary: peers already connected to this control node.
    try {
      for (const p of node.getControlNode()?.getPeers?.() ?? []) candidates.add(p.toString());
    } catch (e) {
      L('WARN could not enumerate control peers:', e?.message ?? e);
    }

    // Secondary: explicit out-of-band drops.
    if (DRONE_ENROL_DIR) {
      try {
        for (const f of readdirSync(DRONE_ENROL_DIR)) {
          if (!f.startsWith('.')) candidates.add(f);
        }
      } catch {
        // dir not there yet, or transiently unreadable — next tick retries
      }
    }

    for (const peerId of candidates) {
      if (peerId === selfId || settled.has(peerId)) continue;

      const now = Date.now();
      if (!firstSeenAt.has(peerId)) {
        firstSeenAt.set(peerId, now);
        // Deliberately fall through to the delegate guard rather than accepting on sight.
      }

      // A member's strand node reserves a circuit here under its OWN derived transport
      // peerId (cadre-core 0.12.0 strand-transport-key). It is admitted natively by
      // delegate-admission.js via /sereus/strand-addr/1.0.0 — it is NOT a phone, and
      // running authorizePeer against it writes a spurious CadrePeer row. In the first n=4
      // device run that spurious write tore a multi-tree commit: `default/CadrePeer`
      // persisted while its `_uniq_7.stampid` index did not, unrollbackable.
      if (node.hasDelegateAdmission?.(peerId)) {
        settled.add(peerId);
        L('ENROL_SKIPPED_DELEGATE=' + peerId);
        continue;
      }
      // The grant lands a beat after the strand node first connects — measured at 11s in the
      // first n=4 device run (connection 09:59:02.392, grant 09:59:13.162) — so a peer seen
      // only moments ago may be a delegate whose grant has not arrived yet. The grace period
      // is set ABOVE that measured latency; a phone waiting an extra few seconds costs
      // nothing across a ~40-minute proof, whereas accepting early corrupts the control DB.
      if (now - firstSeenAt.get(peerId) < DELEGATE_GRACE_MS) continue;

      if (inFlight.has(peerId)) continue;
      inFlight.add(peerId); // claimed BEFORE the await — never check-then-act across it
      try {
        // A peer that already redeemed the invitation is a member; authorizing it again would be
        // a second concurrent CadrePeer write, the contention that once tore a multi-tree commit.
        if (await node.isAuthorizedMember(peerId).catch(() => false)) {
          settled.add(peerId);
          inFlight.delete(peerId);
          L('ENROL_ALREADY_MEMBER=' + peerId);
          continue;
        }
        await node.authorizePeer(peerId);
        settled.add(peerId);
        inFlight.delete(peerId);
        L('ENROL_ACCEPTED=' + peerId);
      } catch (e) {
        const msg = e?.message ?? String(e);
        // A control write leaves the DB briefly unreadable until replication reaches a second
        // holder. Accepts run back-to-back in one tick, so joiner N+1's read lands inside the
        // window joiner N's write just opened — in the first n=4 device run Peer B failed 33ms
        // after Peer A was accepted, and never retried, which stranded it as a non-member and
        // failed the whole proof. Retry the outage; never retry a refusal on the merits.
        const attempts = (transientFailures.get(peerId) ?? 0) + 1;
        inFlight.delete(peerId); // released so a later tick may retry it
        if (isTransientControlFailure(msg) && attempts <= ENROL_TRANSIENT_MAX_ATTEMPTS) {
          transientFailures.set(peerId, attempts);
          L(`ENROL_RETRY=${peerId} attempt=${attempts}/${ENROL_TRANSIENT_MAX_ATTEMPTS} (control-DB unavailable, not a refusal) ${msg}`);
          continue;
        }
        settled.add(peerId);
        L('ENROL_FAILED=' + peerId + ' ' + msg);
        continue;
      }
      // Let this write converge before accepting the next candidate in THIS tick, so we stop
      // manufacturing the very read outage the retry above now has to absorb.
      await new Promise(r => setTimeout(r, ENROL_SETTLE_MS));
      // Verify separately, and never let a failed READ read as a failed ceremony. The
      // read-back races the control write: in gate runs `isAuthorizedMember` threw
      // `Block default/Revocation is unavailable (peers-unreachable)` on every attempt for a
      // joiner that was in fact enrolled, which is what made the gate's own enrolment step
      // look like it "did not settle" when it had. Confirmation is best-effort; ENROL_ACCEPTED
      // above is the ceremony's real outcome.
      void confirmMember(peerId);
    }
    } finally {
      tickRunning = false;
    }
  }, ENROL_POLL_MS).unref?.();
}

async function confirmMember(peerId) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      if (await node.isAuthorizedMember(peerId)) {
        L('ENROLLED=' + peerId);
        return;
      }
    } catch (e) {
      L(`  · membership read for ${peerId} not yet serviceable (attempt ${attempt}): ${e?.message ?? e}`);
    }
    await new Promise(r => setTimeout(r, 2000 * attempt));
  }
  L('WARN ENROL_UNCONFIRMED=' + peerId + ' — authorizePeer succeeded but membership could not ' +
    'be read back; treat strandPeers as the authoritative signal');
}

// P2P-06 replication proof: host the VoteTorrent strand so transaction-profile
// peers A and B can replicate through this always-on storage cadre (D-01/D-02
// Option-B topology). strandId is the KNOWN test-network hash (== networkHash,
// D-05) exported by Peer A's created network and passed in via STRAND_ID.
// mode:'bootstrap' — the drone starts solo and transitions naturally as peers
// connect (T-22-14: 'networked' solo would hang). The storage profile +
// MemoryRawStorage are kept (dev/test tooling, D-02 — ephemeral store is fine).
const STRAND_ID = process.env.STRAND_ID ?? 'UPDATE_WITH_TEST_NETWORK_HASH';
await node.addStrand({
  strandRow: { Id: STRAND_ID, MemberPrivateKey: null, Type: 'o' },
  sAppConfig: {
    id: 'org.votetorrent',
    version: '1.0.0',
    schema: VOTETORRENT_QSQL,
    latencyHint: 'interactive',
  },
  mode: 'bootstrap',
  // A founder is never gated on first sync, and this drone (when it is the founding one) IS the
  // bootstrap host everyone else syncs FROM. But founder-ness is normally DERIVED from
  // `strandRow.FounderOwnerKey` matching this node's owner key, and the row above is hand-built
  // with no such provenance -- so the derivation says "joiner" even here. Under cadre-core
  // >= 1.1.0's first-sync gate that is a deadlock, not a slow start: a joiner is withheld its
  // database until some member's Header reaches it, and with nobody founding, no Header ever
  // exists. Every node then reports "no member of this strand has been reachable since this
  // machine joined" and every write fails with "no active strand database" -- which reads exactly
  // like a peer-reachability failure. An explicit value wins over the derivation. Left undefined
  // on a joiner drone, so its gating is the real thing.
  // founder:true only when this drone founds the strand. With no STRAND_ID set, an unset
  // DRONE_STRAND_ROLE keeps the inferred options (control founder -> founder:true, joiner drone ->
  // no founder key). With an explicit STRAND_ID, resolveStrandRole refuses to start unless
  // DRONE_STRAND_ROLE is given; use join (founder:false) when a device created the network, else
  // two histories share one id (round-3 test 15).
  ...strandFounderOption(STRAND_ROLE),
  // Belt and braces for the joiner drone: `awaitFirstSync: false` returns as soon as the runtime
  // is launched (possibly 'syncing' with no database) instead of blocking the whole rig's start-up
  // on a sibling that may not be up yet -- run 30 died here after 30002 ms, as did
  // tools/multipeer-gate. The documented other half is that the caller awaits writability itself.
  awaitFirstSync: false,
});
L('STRAND_ROLE=' + STRAND_ROLE.role + (STRAND_ROLE.explicit ? '' : ' (default)'));
L(`[replication-proof] strand started, strandId=${STRAND_ID}`);
// Advertise the drone's strand-node listen multiaddr so the harness can inject it
// into the runner's STRAND_BOOTSTRAP_ADDR and peers can dial the strand cohort.
// Mirrors the PROOF_WS_ADDR= control-node advertisement above (D-07 pattern, REPL-01).
const strand = node.getStrand(STRAND_ID);
const strandAddrs = strand?.libp2pNode?.getMultiaddrs?.().map(m => m.toString()) ?? [];
const strandWs = strandAddrs.find(a => a.includes('/ip4/127.0.0.1/') && a.includes('/ws')) ?? strandAddrs[0] ?? '';
if (!strandWs) {
  L('PROOF_STRAND_ADDR_MISSING — strand node has no listen multiaddr');
} else {
  L('PROOF_STRAND_ADDR=' + strandWs);
}

// IN-15 (17-REVIEW): handle SIGTERM (plain `kill <pid>`) as well as SIGINT
// (Ctrl-C) so both stop paths shut the node down gracefully.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    L(`${sig} — stopping...`);
    await node.stop();
    process.exit(0);
  });
}
setInterval(() => {}, 1 << 30); // stay alive
