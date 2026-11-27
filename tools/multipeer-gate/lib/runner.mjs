/**
 * runner.mjs — configuration, timing and reporting, shared by both gates.
 *
 * Every knob keeps the name and default it had when all of this lived in
 * `multipeer-gate.mjs`, so a command line that worked before still works.
 */
export const DRONES = Number(process.env.DRONES ?? 2);
export const RELAYS = Number(process.env.RELAYS ?? 1);
export const CLUSTER_SIZE = Number(process.env.CLUSTER_SIZE ?? 2);
export const ENROLL = (process.env.ENROLL ?? '1') !== '0';
export const SCALE = Number(process.env.TIMEOUT_SCALE ?? 1);
export const VERBOSE = process.env.VERBOSE === '1';

/** Run the distributed-database legs (D*). On by default — turn off to time L1-L5 alone. */
export const DB_LEGS = (process.env.DB_LEGS ?? '1') !== '0';

/**
 * DIAGNOSTIC: also give the relay-only peers a direct listen address.
 *
 * This removes the constraint the gate is built around, so a run with it set is NOT a gate
 * result and says so in its summary. It exists to separate two failures that look alike:
 * "the peers cannot be addressed through a relay" and "the database does not replicate".
 * With `PEER_DIRECT=1` the first is taken off the table, so whatever the data legs then
 * report is about the database.
 */
export const PEER_DIRECT = process.env.PEER_DIRECT === '1';

export const T = (ms) => Math.round(ms * SCALE);

export const START_TIMEOUT_MS = T(45_000);
export const ADD_STRAND_TIMEOUT_MS = T(60_000);
export const MESH_TIMEOUT_MS = T(30_000);
export const RESERVATION_TIMEOUT_MS = T(20_000);
export const ENROLL_TIMEOUT_MS = T(30_000);
// L3's own window, deliberately NOT shared with ENROLL_TIMEOUT_MS (the ceremony's per-dial
// timeout). They are different waits: one bounds a single dial, the other bounds how long the
// control database may take to become READABLE after the enrolment write.
//
// 120s, not 30s. Measured 2026-09-03 at RELAYS=2: at 30s the gate failed 2 of 5 runs, always at
// L3, always `Block default/Revocation is unavailable (peers-unreachable)` — a read that cannot
// be served, not a membership verdict. A 4x window passed 4 of 4. The enrolment write leaves the
// control DB briefly unreadable while replication spreads the new revision to a second holder,
// and that convergence sometimes takes over 30 seconds on loopback.
//
// This is a longer WAIT, not a retry that hides a failure: a peer that never becomes a member
// still fails L3, and `ENROLL=0` still fails it immediately. Overridable so the two waits can be
// varied independently when diagnosing.
export const AUTH_TIMEOUT_MS = T(Number(process.env.AUTH_TIMEOUT_MS ?? 120_000));
export const COHORT_TIMEOUT_MS = T(30_000);
export const REPLICATION_TIMEOUT_MS = T(60_000);
export const POLL_MS = T(500);
export const ENROLL_ATTEMPTS = Number(process.env.ENROLL_ATTEMPTS ?? 5);
export const ENROLL_RETRY_MS = T(2_000);
// 0.12.0 reserves relays AFTER control bring-up, so the enrolment preconditions land late.
export const SETTLE_TIMEOUT_MS = T(60_000);
export const SETTLE_GRACE_MS = T(3_000);
export const SETTLE_MS = T(5_000);        // let replication quiesce before counting holders
/** How long an agent may take to answer one control request before it is called dead. */
export const RPC_TIMEOUT_MS = T(Number(process.env.RPC_TIMEOUT_MS ?? 180_000));

export const ISSUE_15 = 'Optimystic#15';  // singly-held blocks can never gain a second holder
/** The late-joiner red is real but NOT attributed to a specific issue — see the leg comment. */
export const L7_NOTE = 'inbound-stream authorization denies the boot read; see the leg comment';

/**
 * Create the reporting/timing context every leg is handed.
 *
 * `tag` distinguishes the two gates in the log, and `kind` records which shape produced
 * the result — a PASS from a single process and a PASS from four processes are different
 * claims and must not be quoted as if they were the same one.
 */
export function createContext({ tag, kind, table, runId }) {
  const results = [];
  const L = (...a) => console.log(`[${tag}]`, ...a);
  const V = (...a) => { if (VERBOSE) console.log(`[${tag}]  ·`, ...a); };

  function record(id, title, status, detail) {
    results.push({ id, title, status, detail });
    L(`${status.padEnd(9)}  ${id}  ${title}${detail ? ` — ${detail}` : ''}`);
  }

  /**
   * A STANDING REPRODUCTION: a leg expected to be red on current upstream, kept so a fix
   * can be verified by watching it flip. It is recorded but never fails the gate — the
   * verdict stays with the legs that are supposed to be green — and if it unexpectedly
   * PASSES that is reported loudly, because it means the defect is fixed.
   */
  function recordStanding(id, title, ok, detail, note) {
    record(id, title, ok ? 'FIXED' : 'KNOWN-RED',
      ok ? `${detail} — this leg is a standing reproduction (${note}); it just went GREEN, so check whether that is fixed`
         : `${detail} — expected red (${note})`);
    return ok;
  }

  /** Poll `probe` until it returns a truthy value or the deadline passes. */
  async function poll(probe, ms, label) {
    const deadline = Date.now() + ms;
    for (;;) {
      const last = await probe();
      if (last) return last;
      if (Date.now() >= deadline) return null;
      V(`${label}: not yet (${Math.round((deadline - Date.now()) / 1000)}s left)`);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  return {
    tag, kind, results, L, V, record, recordStanding, poll,
    TABLE: table,
    runId,
    REPLICATION_TIMEOUT_MS, MESH_TIMEOUT_MS, RESERVATION_TIMEOUT_MS,
    AUTH_TIMEOUT_MS, COHORT_TIMEOUT_MS, SETTLE_MS, CLUSTER_SIZE, ENROLL,
    T,
  };
}

export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The verdict. Legs recorded as FIXED / KNOWN-RED are standing reproductions and never
 * decide it; only PASS/FAIL legs do.
 */
export function summarize(ctx, { fatalFailure, shapeNote }) {
  const { L, results } = ctx;
  L('');
  L('──────────────────────────── SUMMARY ────────────────────────────');
  for (const r of results) L(` ${r.status.padEnd(9)}  ${r.id}  ${r.title}`);
  L('─────────────────────────────────────────────────────────────────');
  const failed = results.find((r) => r.status === 'FAIL') ?? fatalFailure;
  const passed = !failed;
  if (passed) {
    L(`${ctx.tag.toUpperCase()}: PASS — ${results.filter((r) => r.status === 'PASS').length} leg(s) green.`);
  } else {
    L(`${ctx.tag.toUpperCase()}: FAIL at ${failed?.id ?? '?'} (${failed?.title ?? 'startup'}) — ${results.length} leg(s) ran.`);
    L('Legs are ordered, so this is the EARLIEST broken link, not a downstream symptom.');
    L("Re-run with DEBUG='optimystic:db-p2p:*,db-p2p:*,sereus:*' for the underlying trace.");
  }
  for (const line of shapeNote) L(line);
  return passed ? 0 : 1;
}
