/**
 * replication-proof-runner.ts — P2P-06 on-device symmetric replication proof (dev tooling).
 *
 * Symmetric both-write / both-read proof (D-01/D-02): each peer creates a uniquely-named
 * network (`replication-test-<peerIdTail>`) via its own strand-backed session, then polls
 * for the OTHER peer's network. PASS = the peer's network is visible within the bounded
 * poll window; FAIL = timeout.
 *
 * Gated: `__DEV__ && REPLICATION_PROOF_ENABLED` — Metro dead-code-eliminates this entire
 * body in release builds (T-23-03-03).
 *
 * Boots its OWN CadreNode (store `votetorrent-cadre-probe-replication` — OQ2) so it is
 * self-contained and never collides with CadreNodeProvider's `votetorrent-cadre-node`.
 *
 * D-03 fresh-state wipe: done by `scripts/run-replication-proof.sh` (`wipe_proof_strand_store`),
 * NOT here. The script wipes ONLY the proof strand store, before Step 1 and before the Step-4
 * relaunch, and never before the D-05 relaunch (see section 3 below for why). The node-identity
 * store (`votetorrent-cadre-node`) is NEVER destroyed (T-23-03-02).
 *
 * Markers emitted (multi-arg — logcat grep must use .* between tag and message):
 *   [replication-proof] starting
 *   [replication-proof] peerId=<id>          (D-05 / P2P-04)
 *   [replication-proof] relayReservation=<true|false>  (D-09 relay-READY; 38-02-locked
 *                                             observable: getMultiaddrs()/p2p-circuit poll)
 *   [replication-proof] strandId=<hash>      (OQ3 handshake)
 *   [replication-proof] peers=N              (D-06 / ENG-05)
 *   [replication-proof] strandPeers=N        (REPL-01 strand-cohort connection count)
 *   [replication-proof] relayAddrsPerDrone=[...], relayAddrsPerDroneCount=N  (D-04 per-drone
 *                                             relay-reservation instrumentation)
 *   [replication-proof] ========== REPLICATION VERDICT: PASS|FAIL ==========
 *
 * Fire-and-forget from index.js. Never throws — all errors caught and logged.
 *
 * Static import only — dynamic require() breaks Metro (Phase 16-07 lesson).
 *
 * WRITE-PHASE CHOREOGRAPHY (2026-09-28, debug session p2p11-multi-peer-replication,
 * "User Decisions (checkpoint 3)" — supersedes the earlier bare shoe-in insert):
 *
 * `Authority.InsertValid`'s "very first authority" branch admits exactly ONE unauthorized
 * writer per strand (`count(*) from Authority = 1`, spec'd as the network's one-time root of
 * trust — see `doc/administration.md`). The original proof had BOTH peers attempt that same
 * shoe-in insert, which only one of them can ever satisfy — a proof-authoring oversight
 * (commit `66d9bed7`), not a deliberate design. This write phase now races for that slot for
 * real and drives the REAL invite ceremony for whichever peer loses it:
 *
 *   1. FOUNDER attempt (both peers try this first): insert a real User -> Authority -> Admin
 *      -> Officer (in THIS order — `Officer.AdminValid`'s non-invite branch requires Admin to
 *      already exist, which is why this can't reuse `NetworkEngine.createAuthority()`'s own
 *      Authority -> Officer -> Admin order; that order is correct ONLY for the invite-bound
 *      path it was built for — see the debug session's Option-1 implementation note). Whichever
 *      peer's Authority insert lands first genuinely becomes "the first authority"; then it
 *      issues a real Authority invite via `AuthorityEngine.createAuthorityInvite()` ->
 *      `saveInviteWithSigning('iad', ...)` (a real secp256k1 threshold-signing ceremony,
 *      threshold=1) and publishes an `InviteSlot` for its sibling to find.
 *   2. JOINER fallback (whichever peer's genesis attempt fails, for ANY reason — losing the
 *      Authority race is the expected case, but any other genesis failure degrades to this same
 *      path): poll the shared strand DB for the founder's `InviteSlot`, ensure its own User row
 *      exists (shoe-in if still free, otherwise via the InviteSlot's own invite-bound branch —
 *      `User.InsertValid` carries the identical one-free-slot pattern as `Authority`), accept
 *      the invite via `NetworkEngine.respondToInvite()` (the real authority-accept branch, which
 *      commits the 7-arg Digest `Admin.MutationValid` later recomputes), then create its OWN
 *      authority via the real invite-bound `NetworkEngine.createAuthority(..., { inviteSlotCid,
 *      inviteSignature })`.
 *
 * Both roles set `ownWriteOk = true` on success (section 5/7 false-PASS-fix contract
 * unchanged, see CORRECTION 5 in the debug session file). The read phase (section 6) detects
 * "saw the other peer's contribution" by any `Authority.Id` that is NOT in `ownAuthorityIds` —
 * the SET of every Authority id this peer's own genesis ceremony ever committed (not just the
 * single id it ends up resolving as "mine"; see the leg-6b false-PASS fix, 2026-09-28T20:03,
 * documented at both `ownAuthorityIds`'s declaration in section 5 and `isForeignAuthorityRow`'s
 * declaration in section 6 — a founder attempt can commit its `repl-auth-<tail>` row and then
 * fail LATER in the same ceremony, leaving an orphan that a single-id comparison misreads as the
 * other peer's row), falling back to the old `repl-auth-`-prefix heuristic only when this peer
 * never got ANY id committed (total write-phase failure).
 *
 * Test/harness-only: no schema or product-engine-method change. `NetworkEngine`,
 * `AuthorityEngine`, and the schema are called/read exactly as production code already does;
 * only this proof-harness file's own orchestration grew.
 */

import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';
import { openOptimysticRNDb, loadOrCreateRNPeerKey } from '@optimystic/db-p2p-storage-rn';
import { createScopedRnStorageProvider, scopedRnStoreName } from './storage-guard';
import { CadreNode, decodeCadreInvitation } from '@serfab/cadre-core';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { VOTETORRENT_SCHEMA_SQL, NetworkEngine, AuthorityEngine, registerDbPlugins } from '@votetorrent/vote-engine/rn';
import { REPLICATION_PROOF_ENABLED } from './proof-flags.generated';
import { createStrandDbFactory } from './rn-db-factory';
import { isSelfVouched } from './self-voucher';
import { publishSelfRecordAfterEnrol, type PublishSelfRecordResult } from './publish-self-record';
import { NOISE_CRYPTO_MODE, noiseCryptoForNode } from './noise-crypto-config';
import { openStrandNetworkState } from './rn-durable-slot';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import type {
  Authority,
  AuthorityInviteInvokes,
  InviteAction,
  LocalStorage,
  Scope,
  Signature,
  ThresholdPolicy,
  User,
} from '@votetorrent/vote-core';

// Multi-arg form — REQUIRED so logcat renders '[replication-proof]', 'msg' and the
// harness `.*` grep matches. (STATE.md v2.0 Phase 17 Plan 06 lesson.)
const L = (...a: unknown[]) => console.info('[replication-proof]', ...a);

// Distinct store name for the proof runner's own CadreNode identity (OQ2).
// NEVER 'votetorrent-cadre-node' — that store holds the stable peerId (D-05 / T-23-03-02).
const CADRE_STORE = 'votetorrent-cadre-probe-replication';

// The proof strand's id, which is also its store scope. The on-disk store is
// scopedRnStoreName(PROOF_STORE_PREFIX, PROOF_NETWORK_STORE); run-replication-proof.sh's
// PROOF_STRAND_STORE must match it, because the script owns the D-03 wipe (T-23-03-02).
const PROOF_NETWORK_STORE = 'replication-proof-strand';
// Store-name prefix for this proof's scoped LevelDBs — used by the provider, and by the script's wipe.
const PROOF_STORE_PREFIX = 'votetorrent-replication-strand';

// Control address — the drone's control-node ws multiaddr. The harness injects this per-run
// (D-07 automated injection). Placeholder boots solo (no crash — CF-02 bootstrap mode).
const CONTROL_ADDR = '/ip4/10.0.2.2/tcp/0/ws/p2p/UPDATE_AFTER_DRONE_RESTART';

// Strand-cohort bootstrap address — the drone's strand-node ws multiaddr. The harness
// injects this per-run (REPL-01 / 23-06). Separate from CONTROL_ADDR — these are DIFFERENT
// libp2p nodes on the drone with different ephemeral ports (Pitfall 2). Placeholder boots
// strand solo (empty strandBootstrapNodes → bootstrap mode, no crash — P2P-03 no regression).
const STRAND_BOOTSTRAP_ADDR = '/ip4/10.0.2.2/tcp/0/ws/p2p/UPDATE_AFTER_DRONE_RESTART';

// 38-05 (D-04 n=4 topology): SECOND drone's strand-node ws multiaddr (drone-B). The
// harness injects this per-run alongside STRAND_BOOTSTRAP_ADDR — both drones join the
// SAME strand as full voting members, so the emulator's strand cohort must dial both.
// Placeholder-aware exactly like STRAND_BOOTSTRAP_ADDR (boots with drone-B omitted if
// unset, no crash — backward compatible with a single-drone run).
const STRAND_BOOTSTRAP_ADDR_B = '/ip4/10.0.2.2/tcp/0/ws/p2p/UPDATE_AFTER_DRONE_RESTART';

// SECOND drone's CONTROL-node ws multiaddr (drone-B). Injected per-run like CONTROL_ADDR. It
// is a second control bootstrap AND a second relay candidate: before it existed the phones
// dialled drone-A alone, so drone-B held no connection to either phone and every dial-back
// ended in NO_RESERVATION (2026-10-08 runs 2-6). Placeholder-aware: a single-drone run omits it.
const CONTROL_ADDR_B = '/ip4/10.0.2.2/tcp/0/ws/p2p/UPDATE_AFTER_DRONE_RESTART';

// Where the joiner fetches the founder's Authority invite share (dev proof channel, 62-102).
// NetworkEngine.respondToInvite signs with the invite's one-time PRIVATE key, which only the
// founder phone holds. The founder logs it as PROOF_INVITE_SHARE=; the harness serves the
// latest one over plain HTTP on the host, which the emulator reaches at 10.0.2.2. Throwaway
// keys from a throwaway proof network, never a device key. Placeholder disables the channel.
const PROOF_INVITE_SHARE_URL = 'UPDATE_AFTER_DRONE_RESTART';

// Cadre invitation — the base64url-encoded CadreInvitation (cadre-core 1.14+) drone-A mints at
// boot and advertises as PROOF_INVITE=. The harness injects it here per-run, exactly like the
// addresses above (D-07), after rewriting its member addresses to the emulator alias.
//
// Without this the peer boots addressable but UNAUTHORIZED, and drone-A refuses its
// strand-addr request as a non-member — the P2P-11 root cause found 2026-08-24. Redeeming it is
// the WHOLE ceremony on 1.14: the member that answers seats this peer's CadrePeer row during the
// redemption, so no owner-side accept (and no peerId hand-off to the drone) is involved any more.
// Placeholder-aware like the addresses: a placeholder skips the ceremony and boots unenrolled,
// which is the pre-fix behaviour and a deliberate arm.
const PROOF_INVITE = 'UPDATE_AFTER_DRONE_RESTART';

// resolveBootstrapNodes — placeholder-aware address resolver (mirrors CadreNodeProvider).
// Returns [] for empty/unset OR placeholder (safe solo boot), [addr] for a real address.
const BOOTSTRAP_PLACEHOLDER = 'UPDATE_AFTER_DRONE_RESTART';
function resolveBootstrapNodes(addr: string): string[] {
  if (!addr || addr.includes(BOOTSTRAP_PLACEHOLDER)) {
    return [];
  }
  return [addr];
}

// The dev invite-share channel (PROOF_INVITE_SHARE_URL). The harness serves every
// PROOF_INVITE_SHARE= line it has seen, one `<inviteKey>.<invitePrivate>` per line.
const INVITE_SHARE_CHANNEL = !PROOF_INVITE_SHARE_URL.includes(BOOTSTRAP_PLACEHOLDER);

/** The shares published so far, by inviteKey. Empty on any fetch failure (the caller re-polls). */
async function fetchInviteShares(): Promise<Map<string, string>> {
  const shares = new Map<string, string>();
  try {
    const res = await fetch(PROOF_INVITE_SHARE_URL, { cache: 'no-store' });
    if (res.ok) {
      for (const line of (await res.text()).split('\n')) {
        const [key, priv] = line.trim().split('.');
        if (key && priv) {
          shares.set(key, priv);
        }
      }
    }
  } catch {
    // Unreachable channel reads as "no share yet"; the joiner's bounded poll reports the miss.
  }
  return shares;
}

// In solo bootstrap mode (harness Step 1) the drone address has not been injected yet,
// so CONTROL_ADDR is still the placeholder. Boot with NO bootstrap node — the runner is
// genuinely solo (CF-02 bootstrap mode), creates the proof network, and emits strandId=.
const BOOTSTRAP_NODES = [...resolveBootstrapNodes(CONTROL_ADDR), ...resolveBootstrapNodes(CONTROL_ADDR_B)];

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

// P2P-11 (41-11, wall #9 — shared-PeerId strand-relay collision): the control node reserves
// through the drone's CONTROL relay, a DISTINCT relay identity from the strand node's STRAND
// relay (strandNetwork below). Two separate relay servers ⇒ each circuit-relay-v2 server holds
// only ONE connection per this peer's (shared) PeerId, so hop-connect (server/index.js:230-236
// connections[0]) can no longer misroute strand streams to the control connection (41-10
// diagnosis §5 — the cadre-core strandNetwork patch unlocks the per-node-type override Probe 1
// proved did not exist before). Placeholder-aware (degrades to [] — no crash, solo boot).
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
// through the placeholder-aware resolveBootstrapNodes guard, so a solo/placeholder boot
// yields [] (degraded, not a crash).
// drone-B is listed second: cadre-core reserves through the FIRST relay that answers, so
// drone-A stays the primary and drone-B is the fallback when drone-A does not answer.
const CONTROL_RELAY_ADDRS = [...resolveBootstrapNodes(CONTROL_ADDR), ...resolveBootstrapNodes(CONTROL_ADDR_B)];

// Poll constants (consistent with dial-probe.ts connection-poll shape).
// PEER_POLL_MAX: 3 ticks × 1 s = 3 s peer-connection wait (exits early when peers appear).
//   On a real device with a live drone the peer handshake typically completes within 1–2 s.
//   3 ticks is the minimum that covers transient boot delays without blocking unit tests past
//   Jest's default 5 s timeout (tests 2 and 3 each run the full 3 s peer wait).
// REPL_POLL_MAX: 120 ticks, nominally × 1 s = 120 s replication wait (exits early when strand
//   replicates). The read poll is ONLY entered when peerCount >= 1 after the peer wait. If
//   peerCount === 0 the verdict is FAIL immediately — no peers means no replication is possible.
//   NOTE (2026-09-28): the "1 s" is POLL_INTERVAL_MS's sleep only — each tick's own
//   `SELECT Id FROM Authority` is a real distributed-DB round trip, not a local read, and on
//   device has measured closer to ~4 s/tick (a run captured only tick 105/120 reached after 420 s
//   of harness-side polling). The 120-tick BUDGET itself is unaffected by this note — only
//   run-replication-proof.sh's VERDICT_TIMEOUT (which waits for this loop to finish, one way or
//   the other) needs to budget for the real wall-clock duration, not the nominal one.
const PEER_POLL_MAX = 3;
const REPL_POLL_MAX = 120;
const POLL_INTERVAL_MS = 1000;
// STRAND_PEER_POLL_MAX: 25 ticks × 1 s = 25 s strand-cohort connection wait (Fix A, Phase 30;
//   RAISED from 10 by W1b, 2026-09-10).
//   The write below opens an Optimystic cluster stream to the drone's strand node; that stream
//   resets ("0/N super-majority") if the strand transport has not connected yet. Wait for the
//   LIVE strand connection (getConnections().length >= 1) before writing. Exits early on connect.
//
//   MUST EXCEED the drone's enrolment grace. `drone.mjs` holds each newly-seen peer for
//   DELEGATE_GRACE_MS (default 15_000, env DRONE_DELEGATE_GRACE_MS) before accepting it, so it
//   cannot be a member sooner than that. At the old 10 the runner gave up FIVE SECONDS BEFORE the
//   drone would even accept it, then emitted strandPeers=0 — which the harness read as a genuine
//   cohort-formation failure and aborted on. A peer cannot join a cohort it is not yet a member of;
//   the wait has to outlast the ceremony that makes it one.
//
//   Kept under jest's 30 s testTimeout so a spec that does spin the full loop still fails on its
//   assertion rather than on a timeout. If DELEGATE_GRACE_MS is ever raised past ~20 s, this and
//   that timeout both need revisiting together.
const STRAND_PEER_POLL_MAX = 25;

// INVITE_SLOT_POLL_MAX: bounded wait (ticks x POLL_INTERVAL_MS) for the JOINER role to find the
// FOUNDER's published Authority InviteSlot (checkpoint-3 write-phase choreography, 2026-09-28).
// The founder's own ceremony before publishing (4 raw inserts + a real threshold-signing
// ceremony via AuthorityEngine.saveInviteWithSigning) is itself several real control-DB round
// trips — sized generously (60s) rather than reusing the shorter STRAND_PEER_POLL_MAX, which
// bounds a cheaper local connection-count read, not a cross-peer replicated-row wait.
const INVITE_SLOT_POLL_MAX = 60;
// Spike 095 leg 3: how many times a founder whose row committed re-tries JUST the invite ceremony.
const FOUNDER_INVITE_RETRIES = 3;

// Fixed identity/shape constants for the write-phase choreography's genesis + invite ceremony.
// Values are arbitrary (this is a byte-replication proof, not a real authority) but must be
// used CONSISTENTLY between the InviteResult.Digest binding (respondToInvite's invokes) and the
// actual invite-bound Authority/Admin/Officer insert (createAuthority) — see
// Admin.MutationValid's invite branch in votetorrent.qsql.
const FOUNDER_AUTHORITY_NAME = 'Replication Proof Authority';
const FOUNDER_AUTHORITY_DOMAIN = 'replication-proof.local';
const FOUNDER_OFFICER_TITLE = 'Proof Officer';
const FOUNDER_OFFICER_SCOPES: Scope[] = ['iad'];
const FOUNDER_THRESHOLD_POLICIES: ThresholdPolicy[] = [{ policy: 'iad', threshold: 1 }];
const JOIN_AUTHORITY_NAME = 'Replication Proof Authority (joined)';
const JOIN_AUTHORITY_DOMAIN = 'replication-proof-joined.local';
const JOIN_OFFICER_TITLE = 'Proof Officer (joined)';
const JOIN_OFFICER_SCOPES: Scope[] = ['rad'];
const JOIN_THRESHOLD_POLICIES: ThresholdPolicy[] = [{ policy: 'rad', threshold: 1 }];

// CONTROL_RETRY_MAX / CONTROL_RETRY_INTERVAL_MS: 24 x 5 s = 120 s budget for a control-DB read or
//   write that could not be SERVED (W1b, 2026-09-10).
//
//   A read that cannot be served is NOT a verdict. A peer that is not yet an authorized cadre
//   member has its control-DB streams denied by cadre-core's authorizeInboundControlStream(), and
//   db-p2p surfaces that denial as `Block default/Revocation is unavailable (cohort-unreachable)`
//   rather than as a permission error (upstream Optimystic#16 — a refusal and an absence are the
//   same observable). The drone holds each newly-seen peer for DELEGATE_GRACE_MS (15 s) before
//   accepting it, so this state is EXPECTED for the first seconds of every networked run.
//
//   Before this, the write phase converted that throw into an immediate FAIL verdict; the harness's
//   verdict poll matched it at once and killed the drones ~38 s in — before the ceremony that would
//   have authorized this peer could finish. The proof failed fast on the exact condition it was
//   waiting for. Measured across runs 2, 4 and 5.
//
//   Same call the multipeer gate made for its L3 flake (commit 1d3f722a, "a read outage is not a
//   membership verdict"), and the same predicate `packages/p2p-probe-host/drone.mjs` already uses
//   in isTransientControlFailure() to bound acceptPhone's retries — kept character-identical so the
//   two cannot drift apart.
const CONTROL_RETRY_MAX = 24;
const CONTROL_RETRY_INTERVAL_MS = 5000;

/**
 * True when a control-DB failure means "could not be served", not "refused on the merits".
 * Verbatim from drone.mjs's isTransientControlFailure() — change both or neither.
 */
const isTransientControlFailure = (msg: string): boolean =>
  /unavailable \((?:peers|cohort)-unreachable\)|could not determine whether it exists|exhausted \d+ retries|unresolved rival action|was not atomic/i.test(msg);

/**
 * Run `op` under the transient-control-failure retry budget. A transient failure is retried until
 * the budget is spent; anything else rethrows immediately, so a genuine defect still surfaces fast.
 */
async function withControlRetry<T>(
  label: string,
  op: () => Promise<T>,
  maxAttempts: number = CONTROL_RETRY_MAX,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isTransientControlFailure(msg)) {
        throw err;
      }
      lastErr = err;
      if (attempt === 0) {
        L(label, 'control DB not servable yet (expected while enrolment converges), retrying:', msg);
      }
      await new Promise<void>(r => setTimeout(r, CONTROL_RETRY_INTERVAL_MS));
    }
  }
  L(label, 'control DB still not servable after', maxAttempts, 'attempt(s) — giving up');
  throw lastErr;
}
// RELAY_POLL_MAX: 10 ticks × 1 s = 10 s relay-reservation wait (D-09). 38-02's Node-only
// smoke measured the /p2p-circuit reservation completing in ~1.3s against a live drone
// relay, so 10s is a generous bound; emitted unconditionally (true or false) after the
// bounded wait — never blocks indefinitely, mirrors the strandPeers= polling shape.
const RELAY_POLL_MAX = 10;

// AUTH_GATE_BUDGET_MS: a WALL-CLOCK budget for section 4b, deliberately not a tick count.
//
// The previous `AUTH_GATE_POLL_MAX x CONTROL_RETRY_INTERVAL_MS` arithmetic was wrong by
// construction. Once `isSelfAuthorized()` is raced against AUTH_GATE_CALL_TIMEOUT_MS, a tick
// costs the sleep PLUS up to that deadline, so the comment's "24 ticks x 5 s = 120 s" actually
// spent up to 24 x 9 s = 216 s. Run 24 measured it: 151 s on Peer B, 223 s on Peer A. Peer A's
// extra time pushed its strandPeers= marker 12 s past the harness's 300 s REPL-01 window, so the
// run was recorded as "marker never emitted" when the marker did arrive — the harness clock
// failed it, not the product.
//
// A deadline cannot drift when the per-call timeout changes; a tick count silently can.
//
// The sizing premise this comment used to carry — "the gate plus the strand build (~90 s observed)
// plus STRAND_PEER_POLL_MAX still clear the 300 s window with room to spare" — was FALSE, and run
// 25 is the run it cost. The ~90 s came from run 24's Peer A, which is the duration of a strand
// build that FAILED; the healthy builds in the same two runs measured 63 s and 162 s. At 162 s the
// arithmetic is 90 + 162 + 25 = 277 s plus ~10 s of boot, i.e. the window is already spent, and
// Peer A was killed 215 s into an acquire its sibling had needed 162 s for.
//
// The gate no longer has to clear that window at all: REPL-01 now starts its strand budget at the
// `controlRelayAddrs=` marker (see run-replication-proof.sh), so this budget and the strand
// budget are consumed in series rather than out of one pot. Kept at 90 s because that is what the
// gate itself is worth — it is a convergence sample, not a wait for something that will arrive.
const AUTH_GATE_BUDGET_MS = 90_000;

// AUTH_GATE_CALL_TIMEOUT_MS: deadline for ONE self-voucher read (getControlDatabase().
// queryCadrePeers()). Deliberately shorter than CONTROL_RETRY_INTERVAL_MS so a stalled call
// cannot outlive its own poll slot and drag the budget past what the harness allows.
const AUTH_GATE_CALL_TIMEOUT_MS = 4000;

// ACQUIRE_HEARTBEAT_MS: cadence of the `acquire pending` marker emitted while the strand acquire
// is in flight. The acquire is the longest single operation in the proof and, until now, the only
// one that logged NOTHING between its start (`controlRelayAddrs=`) and its end (`strandId=`).
// Run 25 died in that silence: the harness killed Peer A mid-acquire, the runner had thrown
// nothing, and the only surviving evidence that the app was still working was ART's GC lines in
// logcat — so the run was written up as a hang it never demonstrated. A heartbeat makes "slow"
// and "stuck" two different observations instead of the same silence.
const ACQUIRE_HEARTBEAT_MS = 15_000;

/**
 * One libp2p listen failure per line, stack frames stripped.
 *
 * libp2p's `UnsupportedListenAddressesError` (transport-manager's `listen()`) reports EVERY
 * configured listen entry in a SINGLE message, each followed by a full stack trace. On device
 * that message runs to several KB and logcat truncates one log record at ~4 KB: run 24's copy was
 * cut off inside the FIRST entry's stack, so the only address we could read was
 * `/ip4/0.0.0.0/tcp/0` — and the entry that actually explains the failure was never on screen.
 * Two hypotheses were built on that fragment before the truncation was noticed.
 *
 * Dropping the `at ...` frames keeps the whole address list inside one record. Any other error is
 * returned as its own lines unchanged, so this is safe on the general write-failure path.
 */
function errorLinesWithoutStack(err: unknown): string[] {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .split('\n')
    .filter(line => !/^\s*at\s/.test(line))
    .map(line => line.trimEnd())
    .filter(line => line.length > 0);
}

/**
 * Opens the proof's strand handle AND registers vote-engine's per-Database UDFs on it — the same
 * two steps NetworksEngine.open()/createContext() always run back to back. The DbFactory alone
 * registers nothing (cadre-core registers plugins only on its CONTROL database), so a handle taken
 * straight from it lacks `SignatureValid`/`SignatureValidP256`/`isISODatetime`, and the first
 * signed insert (AdminSigning, inside saveInviteWithSigning) fails
 * `Function not found: SignatureValidP256/3` — the on-device leg-6b founder failure (checkpoint 4,
 * item 2). Every strand handle this proof uses must come through here.
 */
async function acquireProofDb(
  factory: ReturnType<typeof createStrandDbFactory>,
): Promise<Awaited<ReturnType<ReturnType<typeof createStrandDbFactory>>>> {
  const db = await factory(PROOF_NETWORK_STORE);
  await registerDbPlugins(db);
  return db;
}

/**
 * Boot entry point.  Fire-and-forget from index.js after AppRegistry.registerComponent.
 * No-op (returns immediately) when REPLICATION_PROOF_ENABLED is false or __DEV__ is false.
 * Never throws — any failure is caught and logged as `[replication-proof] ERROR:`.
 *
 * P2P-06 / SC2 — the in-app harness that drives the on-device proof.
 */
export async function runReplicationProof(): Promise<void> {
  if (!(__DEV__ && REPLICATION_PROOF_ENABLED)) {
    return;
  }

  L('starting');

  let node: InstanceType<typeof CadreNode> | undefined;

  try {
    // ── 1. Boot the runner's own CadreNode (mirrors dial-probe.ts lines 49–74) ──────────────
    const rnDb = openOptimysticRNDb({
      openFn: (n: string, c: boolean, e: boolean) => new LevelDB(n, c, e),
      WriteBatch: LevelDBWriteBatch,
      name: CADRE_STORE,
    });
    const privateKey = await loadOrCreateRNPeerKey(rnDb);

    // cadre-core 1.9.0: a DURABLE strand network state (the saved FRET table, which replaced
    // spike 094's peer book), so the D-05 relaunch dials the strand peers this phone met before
    // anything else, instead of coming back up alone. Scoped by CADRE_STORE so the app's own
    // CadreNode never shares this node's state.
    const strandNetworkStateStore = await openStrandNetworkState('votetorrent', CADRE_STORE);

    node = new CadreNode({
      privateKey,
      controlNetwork: { partyId: 'votetorrent', bootstrapNodes: BOOTSTRAP_NODES },
      strandNetworkState: { store: strandNetworkStateStore },
      profile: 'transaction',
      // Published @serfab/cadre-core@0.8.1 added a fail-closed sApp-schema signature
      // policy (requireSignedSchemas defaults true): an unsigned sAppConfig is rejected
      // at strand bring-up with SchemaVerificationError('missing signature'). This proof
      // runner applies the unsigned votetorrent demo schema (sAppConfig id:'org.votetorrent',
      // no signature), so relax the policy for the proof node — the documented dev/test
      // relaxation, at parity with strand-persistence-proof-runner.ts. Production sApp-schema
      // signing (id = author ed25519 pubkey + signSchema()) is a separate productionization task.
      requireSignedSchemas: false,
      strandFilter: { mode: 'all' },
      // ISO-01 per-scope storage + persistence guardrail (aligned with the app providers).
      storage: { provider: createScopedRnStorageProvider(PROOF_STORE_PREFIX) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // CONTROL node network — reserves through the drone's CONTROL relay (P2P-11 41-11).
      network: {
        transports: [
          webSockets(),
          // D-10: cast by the global transportSymbol, not structural type — the
          // sereus-chat pattern for multi-copy @libp2p/interface brand-skew
          // (Probe 4, 41-01: not load-bearing on Node's single-copy graph but
          // re-verified at Metro/Hermes on device).
          circuitRelayTransport({
            // PROBE 5 (41-01, EXERCISED): N relay-qualified listenAddrs ALONE do NOT
            // yield N reservations under the default circuitRelayTransport() —
            // DEFAULT_RESERVATION_CONCURRENCY=1 serializes+drops. Size concurrency to
            // the number of known control relays driving CONTROL_RELAY_ADDRS.
            reservationConcurrency: Math.max(1, CONTROL_RELAY_ADDRS.length),
          }) as unknown as ReturnType<typeof webSockets>,
        ],
        // 38-20/41-02: this runner boots its OWN CadreNode (never CadreNodeProvider's),
        // so it needs the SAME D-03 always-on relay-client posture, relay-qualified — but
        // scoped to the drone's CONTROL relay (P2P-11 41-11 wall #9). An empty listenAddrs
        // array means libp2p's transportManager.listen() is never invoked for
        // '/p2p-circuit', so @libp2p/circuit-relay-v2's ReservationStore never calls
        // reserveRelay() (relayReservation=false, hop-connect later denied NO_RESERVATION).
        // The STRAND relay moves to strandNetwork below (the cadre-core strandNetwork patch),
        // so the control and strand libp2p nodes no longer reserve at the SAME relay under
        // this peer's shared PeerId — the wall #9 collision.
        relayAddrs: CONTROL_RELAY_ADDRS,
        // Permissive gater — dev probe only (matches dial-probe.ts / cadre-runtime-ondevice.md).
        connectionGater: { denyDialMultiaddr: async () => false },
        // Spike 093: native Noise crypto, the same switch as CadreNodeProvider. The mode is
        // logged below (noiseCrypto=) so every capture says which arm it measured.
        noiseCrypto: noiseCryptoForNode(),
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
        // On cadre-core 0.10.0 the `strandNetwork` override block is REMOVED.
        //
        // It was VT's 41-11 workaround for the shared-peerId circuit-relay-v2 collision: give
        // strand nodes a SECOND relay identity so the relay could not misroute their streams
        // onto the control connection. Upstream fixed the ROOT CAUSE instead — each strand
        // node now derives its OWN transport peerId via
        // `strandTransportKey(identityKey, strandId)` — so one relay is correct and the
        // two-relay topology is obsolete.
        //
        // IMPORTANT (supersedes the earlier "peer id duplication" framing): a peerId is NO
        // LONGER the cadre's authority key. Every libp2p node a cadre runs gets its own
        // transport identity; cadre AUTHORITY is unchanged and stays on the control node,
        // where the peerId->authority derivation (`ed25519PublicKeyB64FromPeerId`) is a
        // control-network path only. The collision was never an authority/owner problem —
        // it was one identity being reused across several libp2p nodes, and it is resolved
        // by letting each node hold its own id.
        //
        // Both keys this block carried are DEAD CONFIG on 0.10.0 (zero occurrences in the
        // published types/dist):
        //   - `strandNetwork`        — the key our now-retired yarn-patch added
        //   - `strandBootstrapNodes` — replaced by `resolveCohortSeed`, which derives strand
        //     peers from the CONTROL cohort (`queryCadrePeers()` -> siblings with a live
        //     control connection -> `/sereus/strand-addr/1.0.0` RPC), not from an
        //     app-supplied strand multiaddr.
        //
        // Strand nodes therefore inherit `network` above (the single control relay).
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

    // cadre-core 0.13.0 ends start() with driveControlRelayReservation(), which waits on the
    // supervisor's FIRST attempt (DEFAULT_RELAY_RESERVE_TIMEOUT_MS, 10 s) and THROWS
    // RelayReservationFailedError if no reservation landed in time. That is fatal to the proof
    // and should not be: upstream's own comment says "everything above in start() has completed
    // by the time this runs" and "the retries carry on in the background after this resolves".
    // So the node IS started and the reservation IS still being pursued — only the WAIT expired.
    //
    // Runs 21 and 22 both died here, and always on the D-05 force-stop relaunch rather than the
    // first boot. That is the D-05 leg's own doing: it restarts the app with a STABLE peerId, so
    // the relay is still holding that peer's previous reservation and re-granting it takes longer
    // than the 10 s budget upstream sized for a "healthy dial-plus-reserve [that] is sub-second".
    //
    // Swallow ONLY this error, and only by name. Any other start() failure is a real defect and
    // must still abort. The relayReservation= marker below reports the true state either way, so a
    // run that genuinely never reserves stays legible as that rather than being hidden here.
    try {
      await node.start();
    } catch (startErr) {
      const name = (startErr as { name?: string } | undefined)?.name;
      if (name !== 'RelayReservationFailedError') {
        throw startErr;
      }
      L('start: relay reservation wait expired, continuing (retries run in the background):',
        startErr instanceof Error ? startErr.message : String(startErr));
    }

    // ── 2. D-05 / P2P-04 peerId marker ──────────────────────────────────────────────────────
    const peerId = node.peerId?.toString() ?? 'unknown';
    L('peerId=', peerId);
    L('noiseCrypto=', NOISE_CRYPTO_MODE);
    // What the durable strand network state holds for the proof strand AT BOOT, i.e. the FRET
    // entries a relaunch re-imports. 0 on a fresh install; >0 on the D-05 relaunch is the
    // restart path doing its job. `+rec` marks an entry carrying a signed address record (the
    // dial hint); `serving=` is the peers db-p2p saw serving the strand. Peer ids are tail-8 only.
    const strandNetworkStateSummary = (): string => {
      const state = strandNetworkStateStore.load(PROOF_NETWORK_STORE);
      const entries = state?.fretTable?.entries ?? [];
      return `${entries.length} [${entries.map(e => `${String(e.id).slice(-8)}:${e.state}${e.addressRecord ? '+rec' : ''}`).join(',')}] serving=${state?.servingPeers?.length ?? 0}`;
    };
    L('strandNetworkState(boot)=', strandNetworkStateSummary());

    // Derive unique per-peer suffix for the proof network name (last 8 chars of peerId).
    const peerTail = peerId.length >= 8 ? peerId.slice(-8) : peerId;

    // ── 2b. D-09: relay-reservation READY marker (P2P-08 close confirmation) ────────────────
    // Locked observable (38-02 Wave-0 smoke, self:peer:update never fired in that run):
    // poll node.getMultiaddrs() for a '/p2p-circuit' entry. Bounded wait, then emit
    // UNCONDITIONALLY (true on success, false on timeout) — never string-interpolated, always
    // the multi-arg L(...) form — so the harness's wait_for_logcat_line can key off the marker
    // regardless of whether the reservation actually completed (mirrors strandPeers= below).
    const hasRelayReservation = (): boolean =>
      (node?.getMultiaddrs() ?? []).some((ma) => ma.toString().includes('/p2p-circuit'));
    for (let i = 0; i < RELAY_POLL_MAX && !hasRelayReservation(); i++) {
      await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    L('relayReservation=', hasRelayReservation());

    // ── 2c. Cadre enrolment — redeem the owner's invitation (P2P-11 membership gate) ───────
    // Ordering matters: AFTER the relay reservation, because on cadre-core 0.12.0 a
    // relay-only peer can return from start() before it holds a circuit address, and an
    // invite dialed in that window reads owner-signed control state nobody can serve yet
    // (`Block default/Revocation is unavailable (peers-unreachable)`) — a timing artifact,
    // not a membership verdict. Before the strand work, because the strand-addr request is
    // exactly what gets refused while this peer is a non-member.
    //
    // Emitted UNCONDITIONALLY (like relayReservation= and strandPeers=) so the harness can
    // key off the marker whether or not the ceremony succeeded, and so an unenrolled run is
    // legible as such instead of failing later as a mystery cohort failure.
    // Started after a successful enrol and awaited just before the strand acquire (section 5).
    // See publish-self-record.ts: without it a phone enrolled after boot leaves its CadrePeer
    // row unsigned and addressless for up to 7.5 min, so no drone can dial it back.
    let selfRecordPublish: Promise<PublishSelfRecordResult> | undefined;
    if (PROOF_INVITE.includes(BOOTSTRAP_PLACEHOLDER)) {
      L('enrolInvite=skipped (no invite injected — this peer will be refused as a non-member)');
    } else {
      try {
        const invitation = decodeCadreInvitation(PROOF_INVITE);
        // redeemCadreInvitation pins the invitation's ownerKeys into this node's anchor BEFORE it
        // dials (the step whose absence left the anchor EMPTY — cadreAuthorized=false on every
        // run before 2026-10-08), then redeems at the listed members in order. Acceptance means
        // a member seated this peer's row; it still has to REPLICATE here before the cohort
        // honours this peer's streams, which is what the 4b write gate waits for.
        L('ownerKeysAnchored=', invitation.ownerKeys.length);
        const redeemed = await node.redeemCadreInvitation(invitation);
        L('enrolInvite=ok', 'admittedBy=', redeemed.peerId ?? '<unnamed>', 'at', redeemed.redeemedAt);
        selfRecordPublish = publishSelfRecordAfterEnrol(node);
      } catch (enrolErr) {
        // Never fatal: a peer that could not redeem still runs the proof, so an unenrolled run
        // reads as THAT (cadreAuthorized=false, refused strand-addr) instead of an early abort.
        // Fail loudly in the log, continue, and let strandPeers= be the authoritative signal.
        L('enrolInvite=failed', enrolErr);
      }
    }

    // ── 3. D-03 fresh-state wipe — owned by the harness script, NOT done in-app ─────────────
    // This used to `LevelDB.destroyDB` the proof strand store on EVERY boot, including Peer A's
    // D-05 relaunch, which would discard any blocks Peer A already held in a networked cohort.
    // An in-app boot cannot tell Step 4 from D-05, so the script wipes the store while the app
    // is force-stopped: before Step 1 and before the Step-4 relaunch, never before D-05.
    // (This was first suspected of causing `Missing block`; device leg 7 refuted that. The real
    // cause was the unpublished self record — see publish-self-record.ts.)
    L('strand store wipe: owned by harness (not wiped in-app)', scopedRnStoreName(PROOF_STORE_PREFIX, PROOF_NETWORK_STORE));

    // ── 4. WAIT for peers FIRST, so the strand factory selects 'networked' mode ─────────────
    // createStrandDbFactory picks bootstrap (local) vs networked by peer presence AT CALL TIME.
    // The write MUST happen after the drone connection is established, or it commits to the
    // local bootstrap transactor and never replicates. In the harness's solo Step-1 boot no
    // peer ever appears (peers=0) — that run only needs the strandId= handshake marker; its
    // FAIL verdict is ignored by the harness. In the networked Step-4 run the drone connects
    // and peerCount becomes >= 1, so the subsequent write goes through the networked transactor.
    const cn = node.getControlNode();
    for (let i = 0; i < PEER_POLL_MAX && (cn?.getConnections().length ?? 0) === 0; i++) {
      await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    const peerCount = cn?.getConnections().length ?? 0;
    // D-06 / ENG-05: live peer-count marker — logged once (pass or timeout).
    L('peers=', peerCount);

    // REPL-01: live strand-cohort connection reader (Fix A, Phase 30).
    // Reads the LIVE strand libp2p connection count via getConnections() — NOT cadre-core's
    // stale strand peer-count field (initialized to 0, never updated → always read 0).
    // IMPORTANT: the strand does not exist until addStrand runs in the write phase below, so
    // getStrand(PROOF_NETWORK_STORE) is undefined HERE — the bounded wait + strandPeers= marker
    // are emitted AFTER the strand is created (see section 5), not before.
    const readStrandPeers = (): number =>
      (node as InstanceType<typeof CadreNode> & {
        getStrand?: (id: string) => { libp2pNode?: { getConnections?: () => unknown[] } } | undefined;
      }).getStrand?.(PROOF_NETWORK_STORE)?.libp2pNode?.getConnections?.().length ?? 0;

    // D-04 (41-02): per-drone relay-reservation instrumentation, mirroring readStrandPeers()'s
    // shape. Reads the STRAND node's OWN /p2p-circuit multiaddrs (distinct from the control-node
    // relayReservation= marker above) so a wall-#8-class per-drone reservation asymmetry is
    // caught from run #1 instead of a later costly device run. Only meaningful once the strand
    // node exists (after addStrand resolves, section 5 below) — mirrors readStrandPeers().
    const readStrandRelayAddrs = (): string[] =>
      ((node as InstanceType<typeof CadreNode> & {
        getStrand?: (id: string) => { libp2pNode?: { getMultiaddrs?: () => unknown[] } } | undefined;
      }).getStrand?.(PROOF_NETWORK_STORE)?.libp2pNode?.getMultiaddrs?.() ?? [])
        .map((ma) => String(ma))
        .filter((addr) => addr.includes('/p2p-circuit'));

    // ── 4b. WRITE GATE: wait until the OWNER has actually authorized this peer ──────────────
    // Run 18 (2026-09-11) failed here, and `enrolInvite=ok` is why. On the pre-1.14 API that marker
    // meant only that THIS peer dialed the invite; it said nothing about the owner-side
    // `acceptPhone`, the half that conferred membership. (On 1.14 `enrolInvite=ok` means a member
    // seated our row — but it must still replicate HERE, so the gate stays.) Measured gap
    // between the two on the n=4 device run:
    //
    //     Peer A  enrolInvite=ok 04:02:18   ->  drone ENROL_ACCEPTED 04:03:48   (90 s)
    //     Peer B  enrolInvite=ok 04:02:04   ->  drone ENROL_ACCEPTED 04:04:18   (134 s)
    //
    // Both peers wrote inside that gap (A by 20 s, B by 81 s), so every cohort stream the write
    // needed was refused — 572 denials of `.../db-p2p/sync/1.0.0` on drone-A alone, reason
    // "not in the materialized authorized set". The write still reported success (it commits to a
    // cohort of nobody and says nothing — upstream Optimystic#19), it was never retried, and both
    // peers ended the run holding only their own row.
    //
    // QUICK-260928-jwi: the gate USED to be `listAuthorizedMembers().some(m => m.peerId ===
    // peerId)`, which can NEVER pass — cadre-core's listAuthorizedMembers()/isAuthorizedMember()
    // unconditionally exclude self (documented check 1, cadre-node.js: `row.peerId !==
    // selfPeerId`). `isMember(self)` is not a substitute either: it is true before any owner has
    // vouched at all, so it would report authorized before the ceremony this gate exists to wait
    // for. Every real device run through 2026-09-28 could therefore only ever log
    // `cadreAuthorized= false`, having spent the whole gate budget on a predicate that was always
    // going to answer false.
    //
    // The gate now checks `isSelfVouched()` — that THIS peer's own replicated CadrePeer row
    // carries a voucher from an owner anchored in the local trust store, with a signature that
    // verifies. That is checks 2-5 of the SAME predicate the drone's
    // `authorizeInboundControlStream` applies, evaluated against our own row (see self-voucher.ts):
    //  1. It is the SAME predicate the drone's `authorizeInboundControlStream` consults, so the
    //     proof waits on exactly the condition that was refusing it — not on a proxy for it.
    //  2. It is observable from the phone. Reading the drone's stdout would mean routing a peerId
    //     back through logcat, which races (see the P2P-11 notes); and the drone accepting is not
    //     sufficient anyway — the membership row must REPLICATE here before this peer's own
    //     streams are honored by the cohort.
    //
    // Bounded and non-fatal: emitted unconditionally (true on success, false on timeout) like
    // relayReservation= and peers=, so a run that never gets authorized stays legible as THAT
    // rather than failing later as a mystery cohort failure. Bounded by AUTH_GATE_BUDGET_MS (a
    // wall-clock deadline, currently 90 s — see that constant; this comment used to say
    // "45 x 5 s = 225 s", which was already stale arithmetic for the old tick-count shape).
    // SKIPPED when nothing could possibly authorize this peer. The harness's Step 1 is a SOLO
    // bootstrap boot: no drone, no invite injected (`enrolInvite=skipped`), `peers=0`. There is no
    // member to redeem at, so `cadreAuthorized` can never become true and waiting the full
    // budget is not caution, it is dead time — run 23 spent 122 s of it there and pushed the
    // `strandId=` handshake past the harness's 420 s Step-1 window, failing a step that was
    // otherwise healthy (the app was still alive and working when the harness gave up).
    //
    // Emitted as `skipped` rather than silently bypassed, so a run that skipped the gate is
    // legible as that and never mistaken for one that passed it.
    // Keyed on peer count alone. `peers=0` is the structural case — with no connection there is
    // nobody to have seated our row and nobody to serve the control read, so the answer cannot
    // change no matter how long we wait. (An unenrolled peer WITH peers is a different shape: the
    // gate runs, spends its budget and reports `false`, which is the honest answer and is exactly
    // how an unenrolled networked run should read.)
    const canBeAuthorized = peerCount > 0;
    if (!canBeAuthorized) {
      L('cadreAuthorized=skipped (peers=0 — no cohort that could authorize this peer)');
    }

    let authGateLoggedError = false;
    // Captured rather than closing over the `let node`, which TS cannot narrow inside a closure.
    const authNode = node;
    const isSelfAuthorized = async (): Promise<boolean> => {
      try {
        // RACED AGAINST A DEADLINE, not merely awaited. Run 19 hung here for 8+ minutes: while
        // this peer is a non-member its control-DB reads are the thing being denied, and a
        // self-voucher read does not always THROW that denial — it can simply never settle. An
        // un-raced await then blocks the proof forever, the strand is never created, and the
        // harness times out at REPL-01 with no verdict (and the drones spend the whole window
        // logging NoValidAddressesError against a strand node that will never exist).
        // A call that does not answer inside one poll interval IS the "not yet" answer.
        const vouched = await Promise.race([
          isSelfVouched(authNode, peerId),
          new Promise<null>(r => setTimeout(() => r(null), AUTH_GATE_CALL_TIMEOUT_MS)),
        ]);
        if (vouched === null) {
          if (!authGateLoggedError) {
            authGateLoggedError = true;
            L('write gate: self-voucher read did not answer within',
              AUTH_GATE_CALL_TIMEOUT_MS, 'ms (expected while enrolment converges)');
          }
          return false;
        }
        return vouched;
      } catch (err) {
        // While this peer is a non-member its own control-DB reads are the thing being denied, so
        // a throw here IS the "not yet" answer, not a defect. Logged once for legibility.
        const msg = err instanceof Error ? err.message : String(err);
        if (!authGateLoggedError) {
          authGateLoggedError = true;
          L('write gate: control DB not readable yet (expected while enrolment converges):', msg);
        }
        return false;
      }
    };
    if (canBeAuthorized) {
      const authGateStart = Date.now();
      const authGateDeadline = authGateStart + AUTH_GATE_BUDGET_MS;
      let selfAuthorized = await isSelfAuthorized();
      while (!selfAuthorized && Date.now() < authGateDeadline) {
        await new Promise<void>(r => setTimeout(r, CONTROL_RETRY_INTERVAL_MS));
        selfAuthorized = await isSelfAuthorized();
      }
      L('cadreAuthorized=', selfAuthorized, 'after', Math.round((Date.now() - authGateStart) / 1000), 's');
    }

    // The exact INPUT to cadre-core's strand listen-address resolution, logged per peer.
    // `strandNodeAddrs` -> `resolveListenAddrs` returns UNDEFINED when neither `network.listenAddrs`
    // nor `network.relayAddrs` is set, and db-p2p then falls back to its own default
    // `/ip4/0.0.0.0/tcp/0` — an address neither webSockets() nor circuitRelayTransport() will even
    // accept for listening, which is fatal under libp2p's default FATAL_ALL. Run 24 failed that way
    // on Peer A while Peer B started cleanly, on what is supposed to be ONE shared module constant,
    // so the constant itself is now on the record for both peers.
    L('controlRelayAddrs=', CONTROL_RELAY_ADDRS, 'controlRelayAddrsCount=', CONTROL_RELAY_ADDRS.length);

    // ── 5. WRITE: create the strand (correct mode now known) + run the invite choreography ────
    // createStrandDbFactory(node) calls setSchemaPath(['App','main']) internally so bare SQL
    // table names resolve without rewriting engine queries (D-14). The strand factory is used
    // — not the local rnDbFactory and not a bare Quereus Database constructor call (Pitfall 7).
    //
    // Write target = Authority, NOT Network: Network is a singleton (`primary key ()`) gated by
    // a valid PrimaryAuthorityId + signing context; Authority is multi-row (PK=Id) and admits
    // exactly one free ("shoe-in") insert — the network's one-time root of trust — with every
    // subsequent Authority admitted only via a real Invite. See the write-phase choreography
    // doc comment at the top of this file (checkpoint 3, 2026-09-28) for the full design: both
    // peers race for the shoe-in slot; the winner (founder) issues a real invite; the loser
    // (joiner) accepts it for real. This is still a pure strand-replication proof (no product
    // schema/engine change), now exercising the real authorization design instead of bypassing it.
    let strandDb: Awaited<ReturnType<ReturnType<typeof createStrandDbFactory>>> | undefined;
    const proofAuthId = `repl-auth-${peerTail}`;
    // Harness false-PASS fix (2026-09-28, CORRECTION 3 / Eliminated): tracks whether THIS peer's
    // own contribution actually landed (already present, freshly inserted, or raced in under the
    // same Id) — as opposed to whether this peer merely SAW another peer's row. Stays false on
    // any write-phase failure (including a rethrown non-idempotent error, e.g. `CHECK constraint
    // failed: InsertValid`), which falls through to the outer catch below without setting it.
    // The final verdict (section 7) requires BOTH this AND seeing another peer's row.
    let ownWriteOk = false;
    // The authority id THIS peer ends up owning as its FINAL resolved authority — 'repl-auth-
    // <peerTail>' if it won the founder race, or the server-generated id
    // `NetworkEngine.createAuthority` resolves via InviteResult.InvokedId if it joined instead.
    // Kept for logging/idempotence only — do NOT use this alone to decide "foreign" in section 6
    // (see ownAuthorityIds below and the leg-6b false-PASS regression it fixes).
    let myAuthorityId: string | undefined;
    // Leg-6b false-PASS fix (2026-09-28, ORCHESTRATOR CORRECTION / checkpoint-4 item 1): EVERY
    // Authority row this peer itself ever got committed, not just the ONE it ends up resolving as
    // "mine". A founder attempt can commit its `repl-auth-<tail>` Authority row and then fail
    // LATER in the same genesis ceremony (e.g. the Admin/Officer inserts, or the
    // AuthorityEngine.saveInviteWithSigning threshold-signing ceremony — observed on-device as a
    // missing-SQL-function error) — the attempt as a whole throws and falls back to
    // attemptJoinViaInvite, but the orphaned `repl-auth-<tail>` row it already committed survives
    // in the shared strand DB. `myAuthorityId` only ever holds the LAST-resolved id (the joiner's
    // invite-bound id in that case), so a predicate comparing a read row against `myAuthorityId`
    // alone wrongly counts that orphan as "the other peer's row" — the exact leg-6b defect. Track
    // every id this peer itself wrote (orphan or final) here instead, and in section 6 treat a row
    // as foreign iff it is NOT in this set.
    const ownAuthorityIds = new Set<string>();
    try {
      const strandDbFactory = createStrandDbFactory(node as Parameters<typeof createStrandDbFactory>[0]);
      // The shared strand ID is the PROOF_NETWORK_STORE constant; both peers join the same strand.
      // OQ3: strandId=<hash> is logged so the harness can launch the drone with STRAND_ID=<hash>.
      // W1b: THE throwing call. Acquiring the strand DB reads the control DB, so it is denied
      // outright while this peer is still a non-member — this is where the whole write phase was
      // dying, BEFORE the strandId= marker was even emitted (the WARN precedes strandId= in every
      // failed run's logcat). Wrapping the presence check and the insert alone left this uncovered
      // and the retry never fired once.
      // W1b: retry ONLY when there is a peer to converge WITH. The harness's Step-1 boot is
      // deliberately solo (peers=0, no drone), so a control-DB failure there is terminal, not
      // transient — nothing will ever authorize this node. Retrying burned the full 120s budget
      // in bootstrap mode and the strandId= marker never appeared inside the harness's 240s
      // window, so the run died at Step 1. Fail fast there exactly as before; retry only in the
      // networked run, which is the case the budget exists for.
      //
      // Heartbeat the acquire (see ACQUIRE_HEARTBEAT_MS). `acquire settled` is emitted from a
      // `finally`, so a throw reports its duration too — the failure path is exactly where the
      // number is worth having.
      if (selfRecordPublish) {
        const pub = await selfRecordPublish;
        L('selfRecordPublished=', pub.published, 'outcome=', pub.outcome, 'attempts=', pub.attempts,
          'after', Math.round(pub.elapsedMs / 1000), 's', ...(pub.lastError ? ['lastError=', pub.lastError] : []));
      }
      const acquireStart = Date.now();
      const acquireElapsedS = () => Math.round((Date.now() - acquireStart) / 1000);
      const acquireHeartbeat = setInterval(() => {
        L('acquire pending', acquireElapsedS(), 's');
      }, ACQUIRE_HEARTBEAT_MS);
      try {
        strandDb = await withControlRetry(
          'write phase acquire:',
          () => acquireProofDb(strandDbFactory),
          peerCount > 0 ? CONTROL_RETRY_MAX : 1,
        );
      } finally {
        clearInterval(acquireHeartbeat);
        L('acquire settled', acquireElapsedS(), 's');
      }

      // Log OQ3 handshake marker before the write so the harness can capture it.
      L('strandId=', PROOF_NETWORK_STORE);

      // Fix A (Phase 30): the strand node now EXISTS (addStrand resolved) and is dialing its
      // strandBootstrapNodes (the drone's strand addr). Wait (bounded) for the LIVE strand
      // connection >= 1 BEFORE the DDL write — the Authority insert opens an Optimystic cluster
      // stream to the drone's strand node, which resets (→ "0/N super-majority") if the cohort
      // transport has not connected yet. Only wait when a control peer is present (the solo
      // Step-1 boot has peers=0 → strandPeers=0 → FAIL, which the harness ignores).
      if (peerCount > 0) {
        for (let i = 0; i < STRAND_PEER_POLL_MAX && readStrandPeers() === 0; i++) {
          await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
        }
      }
      // REPL-01: live strand-cohort size marker, emitted AFTER addStrand + the bounded wait.
      L('strandPeers=', readStrandPeers());
      L('strandNetworkState=', strandNetworkStateSummary());
      // D-04: per-drone relay-reservation marker, emitted alongside strandPeers= (the strand
      // node now exists). Expect ONE /p2p-circuit multiaddr PER drone reserved with (2 for the
      // n=4 topology) after the D-05 fix — length is logged too so a per-drone count is
      // greppable without parsing the array.
      L('relayAddrsPerDrone=', readStrandRelayAddrs(), 'relayAddrsPerDroneCount=', readStrandRelayAddrs().length);

      // Use VOTETORRENT_SCHEMA_SQL to satisfy the import (tree-shaken in release).
      void VOTETORRENT_SCHEMA_SQL;
      // Every VoteTorrent table is context-gated, so every mutation below carries the signing
      // context envelope via Quereus's inline `with context <var> = <value>` clause (mirrors
      // NetworksEngine.createNetwork's TX1). 'Authority'/'Officer'/'Admin'/'User'/'InviteSlot'/
      // 'InviteResult' resolve to their 'App.*' names via the setSchemaPath set by
      // createStrandDbFactory (D-14).
      const db = strandDb;
      const proofUserId = `repl-user-${peerTail}`;
      // ONE founder signing key per run. Harness-only identity, never the device's real key
      // (mirrors vote-engine/test/fixtures/test-context.ts's makeTestSignCallback). The signer
      // checks (04c15797, 2026-10-02) require the signer to be a registered, unexpired UserKey of
      // the signing user, so genesis registers it below and every invite signing (incl. the
      // re-issue retry) must use this same key, not a fresh one per call.
      const founderPrivateKey = secp256k1.utils.randomSecretKey();
      const founderPublicKeyHex = bytesToHex(secp256k1.getPublicKey(founderPrivateKey));
      const nowDt = (): string =>
        // Canonical datetime form — NO trailing 'Z', no milliseconds (19 chars). Matches
        // vote-engine's nowCanonicalDatetime() exactly; reimplemented locally rather than
        // imported because packages/vote-engine's utils.ts is not exported from the RN-safe
        // '/rn' subpath (see rn-entry.ts's controlled re-export list) and this harness file may
        // not add a new product-code export per the checkpoint-3 binding scope. Passing the
        // WRONG format here reproduces the deferred-CHECK datetime-coercion bug documented in
        // toCanonicalDatetime's own doc comment (memory: project_quereus_deferred_check_...).
        new Date().toISOString().slice(0, 19);

      // IDEMPOTENCE (D-05 relaunch, generalized from the spike-062 single-insert check to the
      // multi-row genesis ceremony below): if this peer already has an Officer row for its own
      // proof user — under EITHER role, founder or joiner — it already completed the whole
      // choreography in a prior boot of this SAME peer (the strand store's distributed state
      // survives the D-03 LOCAL-cache wipe + D-05 relaunch; only the local replica is cleared).
      // Recover the authority id from that row rather than re-running the ceremony, which would
      // otherwise die on `UNIQUE constraint failed: User.Id` at the very first insert.
      const existingAuthorityId = await withControlRetry('write phase: presence check', async () => {
        for await (const row of db.eval(
          `SELECT AuthorityId FROM Officer WHERE UserId = '${proofUserId}'`,
        )) {
          if (row && row['AuthorityId']) {
            return String(row['AuthorityId']);
          }
        }
        return undefined;
      });

      /**
       * FOUNDER attempt: insert User -> Authority -> Admin -> Officer, in THIS order (see the
       * write-phase choreography doc comment at the top of this file for why the order matters
       * and why `NetworkEngine.createAuthority()` cannot be reused here), then issue a real
       * Authority invite via AuthorityEngine so the sibling can join for real. Throws on ANY
       * failure — losing the Authority shoe-in race is the expected case, but this deliberately
       * does not special-case the error: any genesis failure degrades to attemptJoinViaInvite.
       */
      async function attemptFounderGenesis(): Promise<string> {
        await withControlRetry('write phase founder: user insert', () =>
          db.exec(
            `insert into User (Id, Name, ImageRef)
              with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = 0
              values ('${proofUserId}', 'Proof User ${peerTail}', null);`,
          ),
        );
        // The founder's first key, exactly as NetworksEngine.createNetwork registers one
        // (UserKey.InsertValid's first-key branch: count = 1 and context.UserKey is null).
        const keyExpiration = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19);
        await withControlRetry('write phase founder: user key insert', () =>
          db.exec(
            `insert into UserKey (UserId, Type, PubKey, Expiration)
              with context UserKey = null, Signature = null, Tid = 0, now = '${nowDt()}', IsSignatureValid = true
              values ('${proofUserId}', 'M', '${founderPublicKeyHex}', '${keyExpiration}');`,
          ),
        );
        await withControlRetry('write phase founder: authority insert', () =>
          db.exec(
            `insert into Authority (Id, Name, DomainName, ImageRef)
              with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = 0
              values ('${proofAuthId}', '${FOUNDER_AUTHORITY_NAME}', '${FOUNDER_AUTHORITY_DOMAIN}', null);`,
          ),
        );
        // Record the commit IMMEDIATELY, before any of the ceremony steps below that can still
        // fail (Admin/Officer inserts, the real threshold-signing invite ceremony). If any of
        // those throw, this row is an ORPHAN that survives in the shared strand DB even though
        // this attempt as a whole fails and falls back to attemptJoinViaInvite — it must still be
        // recognized as OUR OWN row in section 6, not misread as the other peer's (leg-6b fix).
        ownAuthorityIds.add(proofAuthId);
        const adminEffectiveAt = nowDt();
        await withControlRetry('write phase founder: admin insert', () =>
          db.exec(
            `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
              with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = 0
              values ('${proofAuthId}', '${adminEffectiveAt}', '${JSON.stringify(FOUNDER_THRESHOLD_POLICIES)}');`,
          ),
        );
        await withControlRetry('write phase founder: officer insert', () =>
          db.exec(
            `insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes)
              with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = 0
              values ('${proofAuthId}', '${adminEffectiveAt}', '${proofUserId}', '${FOUNDER_OFFICER_TITLE}', '${JSON.stringify(FOUNDER_OFFICER_SCOPES)}');`,
          ),
        );

        await issueFounderInvite();
        return proofAuthId;
      }

      /**
       * The founder's real Authority invite, split out so a founder whose row committed can
       * retry JUST this step (spike 095 leg 3). Real engine calls: a genuine secp256k1
       * threshold-signing ceremony (threshold=1) via AuthorityEngine.saveInviteWithSigning ->
       * SigningEngine (its own default-constructed instance), publishing a real InviteSlot the
       * joiner will find and accept.
       */
      async function issueFounderInvite(): Promise<void> {
        const authorityEngine = new AuthorityEngine(
          { id: proofAuthId, name: FOUNDER_AUTHORITY_NAME, domainName: FOUNDER_AUTHORITY_DOMAIN } as Authority,
          { db, user: { id: proofUserId, name: `Proof User ${peerTail}`, activeKeys: [] } as User },
        );
        const inviteShare = authorityEngine.createAuthorityInvite(FOUNDER_AUTHORITY_NAME);
        // Signs with the run's founderPrivateKey (registered as a UserKey at genesis).
        const signCallback = async (digest: Uint8Array): Promise<Signature> => ({
          signature: bytesToHex(secp256k1.sign(digest, founderPrivateKey)),
          signerKey: founderPublicKeyHex,
          signerUserId: proofUserId,
        });
        await authorityEngine.saveInviteWithSigning(inviteShare, 'iad' as Scope, signCallback);
        // Hand the share to the joiner through the harness (see PROOF_INVITE_SHARE_URL). Logged
        // only after the slot is saved, so the share always names a slot that exists.
        L(`PROOF_INVITE_SHARE=${inviteShare.inviteKey}.${inviteShare.invitePrivate}`);
        sharePublished = true;
      }

      // Set once THIS founder has published an invite share. With the share channel on, only that
      // counts as an open invite: a slot the signing ceremony left half-done (2026-10-09 run 10:
      // a strand read failed mid-signing with `Some peers did not complete`) has no share, so the
      // joiner could never redeem it, and treating it as open stopped the founder re-issuing.
      let sharePublished = false;

      /** Is an Authority InviteSlot visible that nobody has redeemed yet? */
      async function unredeemedAuthoritySlotExists(): Promise<boolean> {
        return withControlRetry('write phase founder: InviteSlot presence', async () => {
          for await (const row of db.eval(
            `SELECT Cid FROM InviteSlot WHERE Type = 'au' AND Cid NOT IN (SELECT SlotCid FROM InviteResult)`,
          )) {
            if (row && row['Cid']) return true;
          }
          return false;
        });
      }

      /**
       * JOINER fallback: poll for the founder's InviteSlot, accept it via the real
       * NetworkEngine.respondToInvite() authority-accept branch (commits the 7-arg Digest
       * Admin.MutationValid later recomputes), then create this peer's OWN authority via the
       * real invite-bound NetworkEngine.createAuthority(..., { inviteSlotCid, inviteSignature }).
       */
      async function attemptJoinViaInvite(): Promise<string> {
        type SlotRow = { cid: string; inviteKey: string; inviteSignature: string; invitePrivate?: string };
        let slot: SlotRow | undefined;
        for (let i = 0; i < INVITE_SLOT_POLL_MAX && !slot; i++) {
          slot = await withControlRetry('write phase joiner: poll InviteSlot', async () => {
            // With the share channel on, take only a slot whose share the founder published: a
            // half-signed slot left by a failed ceremony can never be redeemed (run 10).
            const shares = INVITE_SHARE_CHANNEL ? await fetchInviteShares() : undefined;
            for await (const row of db.eval(
              // Unredeemed only: a slot with an InviteResult is spent, and redeeming it again fails
              // `UNIQUE constraint failed: InviteResult.SlotCid` (spike 095 leg 3, Peer A).
              `SELECT Cid, InviteKey, InviteSignature FROM InviteSlot WHERE Type = 'au' AND Cid NOT IN (SELECT SlotCid FROM InviteResult)`,
            )) {
              if (row && row['Cid']) {
                const candidate: SlotRow = {
                  cid: String(row['Cid']),
                  inviteKey: String(row['InviteKey']),
                  inviteSignature: String(row['InviteSignature'] ?? ''),
                };
                if (!shares) {
                  return candidate;
                }
                const invitePrivate = shares.get(candidate.inviteKey);
                if (invitePrivate) {
                  return { ...candidate, invitePrivate };
                }
              }
            }
            return undefined;
          });
          if (!slot) {
            if (i === 0) {
              L(INVITE_SHARE_CHANNEL
                ? 'write phase joiner: no Authority InviteSlot with a published share yet, waiting for the founder'
                : 'write phase joiner: no Authority InviteSlot yet, waiting for the founder to publish one');
            }
            await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
          }
        }
        if (!slot) {
          throw new Error(
            `write phase joiner: no Authority InviteSlot${INVITE_SHARE_CHANNEL ? ' with a published share' : ''} appeared within ${INVITE_SLOT_POLL_MAX} polls`,
          );
        }

        // Ensure this peer's OWN User row exists. createAuthority() never creates one, and this
        // peer's own genesis attempt above may have already inserted it (harmless — the shoe-in
        // slot is still "ours") or may have failed before reaching it (the shoe-in slot may
        // already be gone too, in which case fall back to User's own invite-bound branch,
        // reusing the InviteSlot's own Cid + InviteSignature exactly as
        // InvitationEngine.respondToInvite's keyholder-accept branch does for its minted User).
        try {
          await withControlRetry('write phase joiner: user shoe-in attempt', () =>
            db.exec(
              `insert into User (Id, Name, ImageRef)
                with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = 0
                values ('${proofUserId}', 'Proof User ${peerTail}', null);`,
            ),
          );
        } catch (userErr) {
          const msg = userErr instanceof Error ? userErr.message : String(userErr);
          if (!/UNIQUE constraint failed: User\.Id/.test(msg)) {
            await withControlRetry('write phase joiner: user invite-bound insert', () =>
              db.exec(
                `insert into User (Id, Name, ImageRef)
                  with context SigningNonce = null, InviteSlotCid = '${slot!.cid}', InviteSignature = '${slot!.inviteSignature}', Tid = 0
                  values ('${proofUserId}', 'Proof User ${peerTail}', null);`,
              ),
            );
          }
        }

        // Undefined without the share channel, so respondToInvite fails closed (invite-key-required).
        const invitePrivate = slot.invitePrivate;
        const joinAdminEffectiveAt = nowDt();
        const inviteAction: InviteAction<AuthorityInviteInvokes> = {
          invite: { type: 'au', expiration: '', inviteKey: slot.inviteKey, inviteSignature: '' },
          isAccepted: true,
          invokes: {
            authority: { name: JOIN_AUTHORITY_NAME, domainName: JOIN_AUTHORITY_DOMAIN },
            admin: { effectiveAt: joinAdminEffectiveAt, thresholdPolicies: JSON.stringify(JOIN_THRESHOLD_POLICIES) },
            officers: [
              {
                adminEffectiveAt: joinAdminEffectiveAt,
                userId: proofUserId,
                title: JOIN_OFFICER_TITLE,
                scopes: JSON.stringify(JOIN_OFFICER_SCOPES),
              },
            ],
          },
          // 62-102: NetworkEngine.respondToInvite signs with the invite's one-time private key
          // itself and refuses (code invite-key-required) without it. The founder phone hands
          // it over through the harness share channel (fetchInviteShares). The field below is
          // ignored by the engine.
          invitePrivate,
          inviteSignature: 'a'.repeat(128),
        };
        const networkEngine = new NetworkEngine(
          {
            hash: 'replication-proof',
            name: 'Replication Proof',
            primaryAuthorityDomainName: FOUNDER_AUTHORITY_DOMAIN,
            relays: [],
          },
          {
            getItem: async () => undefined,
            setItem: async () => undefined,
            removeItem: async () => undefined,
            clear: async () => undefined,
          } as LocalStorage,
          { db, user: { id: proofUserId, name: `Proof User ${peerTail}`, activeKeys: [] } as User },
        );
        const invokedId = await networkEngine.respondToInvite(inviteAction);
        if (!invokedId) {
          throw new Error('write phase joiner: respondToInvite did not return an invokedId');
        }
        await networkEngine.createAuthority(
          { name: JOIN_AUTHORITY_NAME, domainName: JOIN_AUTHORITY_DOMAIN },
          {
            officers: [
              { init: { name: `Proof Officer ${peerTail}`, title: JOIN_OFFICER_TITLE, scopes: JOIN_OFFICER_SCOPES } },
            ],
            effectiveAt: joinAdminEffectiveAt,
            thresholdPolicies: JOIN_THRESHOLD_POLICIES,
          },
          { inviteSlotCid: slot.cid, inviteSignature: 'a'.repeat(128) },
        );
        // Only recorded once createAuthority() itself has succeeded — that is the call that
        // actually inserts this peer's own Authority row under `invokedId` (respondToInvite above
        // only commits an InviteResult row, a different table, not read by section 6's predicate).
        ownAuthorityIds.add(invokedId);
        return invokedId;
      }

      if (existingAuthorityId) {
        L('write phase: own genesis already present, skipping (idempotent)', existingAuthorityId);
        myAuthorityId = existingAuthorityId;
        ownAuthorityIds.add(existingAuthorityId);
        ownWriteOk = true;
      } else {
        try {
          myAuthorityId = await attemptFounderGenesis();
          L('write phase: founder published authority + invite', myAuthorityId);
          ownWriteOk = true;
        } catch (founderErr) {
          L(
            'write phase: founder attempt did not complete (expected for the non-founding peer), falling back to join-via-invite:',
            founderErr instanceof Error ? founderErr.message : String(founderErr),
          );
          if (ownAuthorityIds.has(proofAuthId)) {
            // SPIKE 095 leg 3: this phone's founder row COMMITTED, then the ceremony threw later
            // (there, `the repo could not determine whether it exists` inside the invite signing).
            // It is the founder. It used to fall through to the joiner path, find its OWN
            // InviteSlot and redeem it, leaving the sibling nothing to join through (the leg-6b
            // self-orphan shape again). A founder never redeems an invite. It makes sure one is
            // open for the sibling, and its committed Authority row is its own write.
            const inviteOpen = async (): Promise<boolean> =>
              INVITE_SHARE_CHANNEL ? sharePublished : unredeemedAuthoritySlotExists();
            let published = await inviteOpen();
            for (let attempt = 1; !published && attempt <= FOUNDER_INVITE_RETRIES; attempt++) {
              L('write phase founder: row committed but no open invite, re-issuing, attempt', attempt);
              try {
                await issueFounderInvite();
                published = true;
              } catch (inviteErr) {
                L('write phase founder: invite re-issue failed:', inviteErr instanceof Error ? inviteErr.message : String(inviteErr));
                published = await inviteOpen();
              }
            }
            if (!published) {
              throw new Error('write phase founder: founder row committed but no invite could be opened for the sibling');
            }
            myAuthorityId = proofAuthId;
            L('write phase: founder row committed and invite open for the sibling', myAuthorityId);
            ownWriteOk = true;
          } else {
            myAuthorityId = await attemptJoinViaInvite();
            L('write phase: joined authority via real invite flow', myAuthorityId);
            ownWriteOk = true;
          }
        }
      }
    } catch (writeErr) {
      // Write phase error — log the error; proof continues to the read phase, but ownWriteOk
      // stays false (never set on this path) so the section-7 verdict FAILs regardless of what
      // the read phase below observes — the harness false-PASS this guards against.
      L('WARN write phase error (proof will FAIL):', writeErr instanceof Error ? writeErr.message : String(writeErr));
      // The line above is what logcat truncates. Re-emit the same error one line per record with
      // stacks stripped, so a multi-address listen failure is fully readable (see
      // errorLinesWithoutStack). Only for errors that actually span lines — a one-line error is
      // already complete above.
      const writeErrLines = errorLinesWithoutStack(writeErr);
      if (writeErrLines.length > 1) {
        for (const line of writeErrLines) {
          L('write phase error detail:', line);
        }
      }
      // Still emit OQ3 strandId marker for harness capture even on write failure.
      if (!strandDb) {
        L('strandId=', PROOF_NETWORK_STORE);
      }
      // Robust diagnostic (Phase 30): addStrand can throw during distributed schema init when
      // the strand cohort has not formed (strandPeers=0), before the success-path emit above is
      // reached. Always emit the live strandPeers= marker so the harness gate sees the real
      // cohort signal (0) rather than "marker never emitted".
      L('strandPeers=', readStrandPeers());
      L('strandNetworkState=', strandNetworkStateSummary());
      // D-04: mirror the per-drone relay marker on the failure path too, for the same reason.
      L('relayAddrsPerDrone=', readStrandRelayAddrs(), 'relayAddrsPerDroneCount=', readStrandRelayAddrs().length);
    }

    // ── 6. READ: bounded poll for the OTHER peer's proof Authority row ───────────────────────
    // The other peer writes Authority Id `repl-auth-<theirTail>` (theirTail ≠ peerTail).
    // Any `repl-auth-*` row that is NOT this peer's own proves cross-peer strand replication
    // succeeded (D-01 symmetric proof — no role flag).
    //
    // OPTIMIZATION: if peerCount === 0 after the peer-wait, skip the read poll entirely and
    // emit FAIL immediately. No peers → no replication is possible within the poll window;
    // this also keeps unit-test runtime within Jest's default 5 s timeout.
    //
    // NOTE: this tracks only what this peer SAW in its read set. It is NOT the verdict by
    // itself — see section 7. Renamed from `verdict` (2026-09-28 harness false-PASS fix): the
    // old name implied seeing another peer's row was sufficient for PASS, which let a peer whose
    // OWN write failed (e.g. `CHECK constraint failed: InsertValid`) still report PASS merely for
    // having read a row the OTHER peer wrote (CORRECTION 3 / Eliminated, 2026-09-28).
    let sawOtherPeerRow = false;
    // Leg-6b false-PASS fix (2026-09-28, ORCHESTRATOR CORRECTION / checkpoint-4 item 1):
    // "foreign" means "NOT one of the ids THIS peer itself ever got committed" — checked against
    // `ownAuthorityIds` (section 5), a SET populated at every point this peer's own genesis
    // ceremony actually commits an Authority row, not just the single id it ends up resolving as
    // "mine". The single-id comparison this replaced (`id !== myAuthorityId`) was wrong: a
    // founder attempt can commit its `repl-auth-<tail>` row and then fail LATER in the same
    // ceremony (Admin/Officer inserts, or the real threshold-signing invite ceremony — observed
    // on-device as a missing-SQL-function error), falling back to attemptJoinViaInvite, which
    // resolves a DIFFERENT id (the invite-bound InviteResult.InvokedId) as `myAuthorityId`. Both
    // ids are this SAME peer's own rows, but only one of them ever matched `myAuthorityId` — the
    // orphaned `repl-auth-<tail>` row was misread as "the other peer's row" (a live device leg,
    // 2026-09-28T20:03, reproduced exactly this: `authorityRows=2` were BOTH Peer B's own, no
    // Peer A row existed at all, yet the old predicate reported PASS). Falls back to the old
    // 'repl-auth-' prefix heuristic only when this peer never got ANY id committed (total
    // write-phase failure, in which case the verdict FAILs on ownWriteOk regardless of what this
    // predicate decides).
    const isForeignAuthorityRow = (id: string): boolean =>
      ownAuthorityIds.size > 0 ? !ownAuthorityIds.has(id) : id.startsWith('repl-auth-');
    if (peerCount > 0) {
      try {
        const strandDbFactory = createStrandDbFactory(node as Parameters<typeof createStrandDbFactory>[0]);
        const readDb = strandDb ?? await withControlRetry(
          'read phase:',
          () => acquireProofDb(strandDbFactory),
          peerCount > 0 ? CONTROL_RETRY_MAX : 1,
        );

        // W1b instrumentation (2026-09-10). The loop below previously selected ONLY the sibling's
        // row and swallowed every error with a bare `catch {}`, retrying 120 times in silence — so
        // a failed run produced no error, no row census, and no way to tell "the sibling's row
        // never arrived" from "every read threw". Both are now reported. Verdict semantics are
        // UNCHANGED: the filter that sets `sawOtherPeerRow` is applied in JS over the same row set.
        let readErrCount = 0;
        let firstReadErr: string | undefined;
        let lastCensus = '\u0000';
        let ticks = 0;
        for (let i = 0; i < REPL_POLL_MAX && !sawOtherPeerRow; i++) {
          ticks = i + 1;
          try {
            // `eval` yields rows lazily via AsyncIterableIterator (no `all` on Database).
            const seen: string[] = [];
            for await (const row of readDb.eval(`SELECT Id FROM Authority`)) {
              if (row && row['Id']) {
                seen.push(String(row['Id']));
              }
            }
            // Report the census on CHANGE, and every 15th tick as a heartbeat, so the log shows
            // what this peer can actually see rather than only what it was hunting for.
            const census = seen.slice().sort().join(',');
            if (census !== lastCensus || i % 15 === 0) {
              L('read tick', i, 'authorityRows=', seen.length, 'ids=', seen.length ? seen : '(none)');
              lastCensus = census;
            }
            if (seen.some(isForeignAuthorityRow)) {
              sawOtherPeerRow = true;
              break;
            }
            await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
          } catch (pollErr) {
            readErrCount++;
            const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
            if (firstReadErr === undefined) {
              firstReadErr = msg;
              L('read tick', i, 'FIRST read error:', msg);
            }
            await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
          }
        }
        L('read phase done: ticks=', ticks, 'readErrors=', readErrCount, 'firstError=', firstReadErr ?? '(none)');
      } catch (readErr) {
        L('WARN read phase error:', readErr instanceof Error ? readErr.message : String(readErr));
      }
    }

    // ── 7. REPLICATION VERDICT (byte-identical to logcat grep target) ───────────────────────
    // Harness false-PASS fix (2026-09-28): PASS requires BOTH that this peer's own write landed
    // (ownWriteOk, section 5) AND that it saw another peer's row (sawOtherPeerRow, section 6).
    // Seeing another peer's row alone is not evidence this peer replicated successfully if this
    // peer's own insert never committed.
    const verdict = ownWriteOk && sawOtherPeerRow;
    L('verdict inputs: ownWriteOk=', ownWriteOk, 'sawOtherPeerRow=', sawOtherPeerRow);
    L(`========== REPLICATION VERDICT: ${verdict ? 'PASS' : 'FAIL'} ==========`);

    await node.stop();
  } catch (e) {
    L('ERROR:', e instanceof Error ? e.stack : String(e));
    // Emit a FAIL verdict — the harness needs the verdict line regardless of errors.
    L('========== REPLICATION VERDICT: FAIL ==========');
    try {
      await node?.stop();
    } catch {
      // ignore stop errors
    }
  }
}
