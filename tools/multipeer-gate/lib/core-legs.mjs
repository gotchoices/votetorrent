/**
 * core-legs.mjs — L1-L5 (the verdict) and L6-L8 (standing reproductions), over handles.
 *
 * These are the legs that used to live inside `multipeer-gate.mjs`. Their assertions and
 * their reasoning are unchanged; what changed is that they now talk to a handle instead of
 * a CadreNode, so `multiproc-gate.mjs` runs the SAME legs with every node in its own OS
 * process. Keeping one copy is not tidiness: if the two gates had their own L1-L5, a
 * cross-process failure against an in-process pass would be evidence about the two
 * harnesses rather than about the process boundary.
 */
import { GATE_ROW_BLOCK, strandConfig } from './topology.mjs';
import { ISSUE_15, L7_NOTE, ADD_STRAND_TIMEOUT_MS, withTimeout } from './runner.mjs';
import { enrol } from './ceremony.mjs';

/**
 * L1 — control-plane reachability.
 *
 * Deliberately NOT a full-mesh assertion. On bring-up the control network is a star:
 * every joiner dials the founder, and the mesh only widens once `reconcileControlCohort`
 * runs — which is itself gated on the membership L3 tests. Asserting a full mesh here
 * would fail for a reason that belongs to L3 and would mislabel the blocker.
 *
 * What must hold: every node has at least one control connection, and the founder can
 * see all of them. A relay-only peer that cannot reach the founder fails right here.
 */
export async function legControlMesh(ctx, founder, all) {
  const wantFounder = all.length - 1;
  const counts = async () => {
    const out = [];
    for (const h of all) out.push({ name: h.name, n: (await h.connections()).count });
    return out;
  };
  const got = await ctx.poll(async () => {
    const c = await counts();
    ctx.V(`control ${c.map((x) => `${x.name}=${x.n}`).join(' ')}`);
    const founderCount = (await founder.connections()).count;
    return c.every((x) => x.n >= 1) && founderCount >= wantFounder ? c : null;
  }, ctx.MESH_TIMEOUT_MS, 'control reachability');

  if (!got) {
    const c = await counts();
    ctx.record('L1', 'control-reachability', 'FAIL',
      `expected every node >= 1 control connection and the founder >= ${wantFounder}, ` +
      `got ${c.map((x) => `${x.name}=${x.n}`).join(' ')}`);
    return false;
  }
  ctx.record('L1', 'control-reachability', 'PASS',
    `${got.map((x) => `${x.name}=${x.n}`).join(' ')} (founder >= ${wantFounder}, each >= 1)`);
  return true;
}

/**
 * The distinct RELAY IDENTITIES a peer holds circuit addresses through.
 *
 * Identity, never address count. One relay listening on several interfaces yields several
 * `/p2p-circuit` addresses, so counting addresses reads one relay as breadth.
 */
async function relayIdsOf(handle) {
  const circuits = (await handle.addrs()).filter((a) => a.includes('/p2p-circuit'));
  return {
    circuits,
    ids: new Set(circuits.map((c) => c.split('/p2p-circuit')[0].split('/p2p/').pop())),
  };
}

/**
 * L2 — every relay-only peer holds a relay RESERVATION.
 *
 * This asserted `circuits.length >= RELAYS`, which counts ADDRESSES: drone-A listens on two
 * interfaces, so at RELAYS=2 its two `/p2p-circuit` addresses satisfied the count on their own
 * and the leg passed reporting `2 addr/1 relay` — printing the shortfall inside its own PASS
 * line. Identities are counted now.
 *
 * But the bar is ONE, not RELAYS — on THIS version. cadre-core 0.12.0's
 * `driveRelayReservation` dials every configured relay and asks *the first one that answers*
 * for a slot, returning as soon as a single `/p2p-circuit` address appears
 * (`requestReservation` returns on first success). Verified against the installed dist.
 *
 * This is a CHANGE, not a constant: on 0.11.0 relays were named by a `<relay>/p2p-circuit`
 * `listenAddrs` entry (libp2p's 'configured' route, which reserves with EACH named relay),
 * and this gate's README records `peer-A=4 addr/2 relay` from that era. 0.12.0's 'search'
 * route yields `2 addr/1 relay` for the same config. So `RELAYS` is how many relays are
 * OFFERED, and demanding one reservation per relay would fail a healthy 0.12.0 stack. If a
 * later version restores per-relay reservations, raise this bar with it.
 *
 * WHETHER THE OTHER MEMBERS CAN REACH THE PEER IS NOT ASKED HERE — see leg DD, and see the
 * note in this file's history for why it moved. Briefly: this leg runs before enrolment, and
 * before enrolment the control network is a star by design (L1 says so). Demanding that
 * drone-B already hold an address for peer-A is demanding something the design does not
 * promise yet. In one process it happened to be true and the check passed; with one process
 * per node it is false, and the leg failed for a reason that belonged to its own position in
 * the sequence rather than to the system. Reachability is now asserted after L3, where the
 * mesh is supposed to have widened.
 */
export async function legRelayReservation(ctx, peers) {
  const survey = async () => {
    const out = [];
    for (const p of peers) out.push({ name: p.name, ...(await relayIdsOf(p)) });
    return out;
  };
  const got = await ctx.poll(async () => {
    const seen = await survey();
    ctx.V(`reservations ${seen.map((s) => `${s.name}=${s.circuits.length}addr/${s.ids.size}relay`).join(' ')}`);
    return seen.every((s) => s.ids.size >= 1) ? seen : null;
  }, ctx.RESERVATION_TIMEOUT_MS, 'relay reservation');

  if (!got) {
    const seen = await survey();
    ctx.record('L2', 'relay-reservation', 'FAIL',
      'every relay-only peer needs at least one circuit reservation, got ' +
      `${seen.map((s) => `${s.name}=${s.circuits.length} addr/${s.ids.size} relay`).join(' ')}. ` +
      'Distinct relay IDENTITIES are counted, not addresses — several addresses of ONE relay ' +
      'are not breadth.');
    return false;
  }

  ctx.record('L2', 'relay-reservation', 'PASS',
    got.map((s) => `${s.name}=${s.circuits.length} addr/${s.ids.size} relay`).join(' '));
  return true;
}

/**
 * L3 — the relay-only peers are AUTHORIZED cadre members.
 *
 * `isAuthorizedMember` is the exact predicate the strand-address responder consults, so
 * this asserts the real gate rather than a proxy for it. Authorization needs a CadrePeer
 * row carrying an anchored voucher; merely being connected is not enough.
 */
export async function legCadreAuthorization(ctx, owner, peers) {
  // The probe itself can fail to ANSWER rather than answer false — `isAuthorizedMember`
  // reads the control DB, and if that read cannot be served the query raises. That is a
  // distinct, and more interesting, failure than "not a member", so report it as its own
  // thing rather than as a membership verdict.
  let probeError = null;
  const check = async () => {
    const out = [];
    for (const p of peers) {
      const { value, error } = await owner.isAuthorizedMember(p.peerId());
      if (value === 'unknown') { probeError = error; ctx.V(`authorization probe unanswered: ${error}`); return null; }
      out.push({ name: p.name, ok: value });
    }
    probeError = null;
    ctx.V(`authorization ${out.map((o) => `${o.name}=${o.ok}`).join(' ')}`);
    return out.every((o) => o.ok) ? out : null;
  };

  // With ENROLL=0 no ceremony ran, so membership can never BECOME true — waiting the full
  // convergence window would only make the documented negative control four times slower.
  const window = ctx.ENROLL ? ctx.AUTH_TIMEOUT_MS : Math.min(ctx.AUTH_TIMEOUT_MS, ctx.T(15_000));
  const got = await ctx.poll(check, window, 'cadre authorization');
  if (got) {
    ctx.record('L3', 'cadre-authorization', 'PASS', `${got.map((o) => o.name).join(', ')} authorized`);
    return true;
  }

  if (probeError) {
    ctx.record('L3', 'cadre-authorization', 'FAIL',
      `the membership probe could not be answered: ${probeError}. ` +
      'This is NOT "peer is not a member" — the control-database read itself failed, so ' +
      'the cadre cannot evaluate its own membership. Suspect control-DB cluster health ' +
      '(a `peers-unreachable` block read usually means the cluster cannot serve a quorum).');
    return false;
  }

  const finalState = [];
  for (const p of peers) {
    const { value, error } = await owner.isAuthorizedMember(p.peerId());
    finalState.push(`${p.name}=${error ? `error(${error})` : value}`);
  }
  const { members } = await owner.listAuthorizedMembers();
  ctx.record('L3', 'cadre-authorization', 'FAIL',
    `${finalState.join(' ')}; owner lists ${members.length} authorized member(s). ` +
    (ctx.ENROLL
      ? 'The enrolment ceremony ran but did not produce authorized membership.'
      : 'ENROLL=0 — no ceremony was attempted.') +
    ' Un-authorized peers are refused the strand-address RPC as `non-member`, so their ' +
    'strand nodes never receive cohort addresses and L4/L5 cannot pass.');
  return false;
}

/** L4 — each strand node assembles a cohort bigger than itself. */
export async function legStrandCohort(ctx, all) {
  const key = 'multipeer-gate-probe-block';
  const survey = async () => {
    const out = [];
    for (const h of all) out.push({ name: h.name, ...(await h.cohort(key)) });
    return out;
  };
  const got = await ctx.poll(async () => {
    const sizes = await survey();
    ctx.V(`cohort ${sizes.map((s) => `${s.name}=${s.count}`).join(' ')}`);
    return sizes.every((s) => s.count >= 2) ? sizes : null;
  }, ctx.COHORT_TIMEOUT_MS, 'strand cohort');

  if (!got) {
    const sizes = await survey();
    ctx.record('L4', 'strand-cohort', 'FAIL',
      `expected every strand node to assemble >= 2 cohort members, got ` +
      `${sizes.map((s) => `${s.name}=${s.count}`).join(' ')}. ` +
      'A node stuck at 1 has only itself: it was never given a peer to dial, which points ' +
      'upstream at strand-address seeding (L3), not at the dial layer.');
    return false;
  }
  ctx.record('L4', 'strand-cohort', 'PASS', got.map((s) => `${s.name}=${s.count}`).join(' '));
  return true;
}

/**
 * L5 — the original data assertion: a row written by one relay-only peer is readable by
 * the other. One direction, one row, one reader. Everything it does not cover is in
 * `db-legs.mjs`, and the gap is not academic — see that file's header.
 *
 * Returns the row id so the later legs can assert on the same row.
 */
export async function legReplication(ctx, peerA, peerB) {
  const id = `${ctx.runId}-forward`;
  try {
    await peerA.exec(
      `insert into ${ctx.TABLE} (Id, Value, Writer) values ('${id}', 'written-by-${peerA.name}', '${peerA.name}');`);
  } catch (e) {
    ctx.record('L5', 'replication', 'FAIL', `${peerA.name} write failed: ${e?.message ?? e}`);
    return null;
  }
  ctx.V(`${peerA.name} wrote ${id}`);

  const seen = await ctx.poll(async () => {
    const { rows, error } = await peerB.query(`select Id from ${ctx.TABLE} where Id = '${id}';`);
    if (error) ctx.V(`${peerB.name} read retry: ${error}`);
    return rows?.some((r) => r?.Id === id) ?? false;
  }, ctx.REPLICATION_TIMEOUT_MS, 'replication');

  if (!seen) {
    ctx.record('L5', 'replication', 'FAIL',
      `${peerB.name} never observed row '${id}' within ${ctx.REPLICATION_TIMEOUT_MS}ms`);
    return null;
  }
  ctx.record('L5', 'replication', 'PASS', `${peerB.name} observed '${id}'`);
  return id;
}

// ── standing reproductions ───────────────────────────────────────────────────────────

/** Which named nodes' storage has ever been asked to persist `blockId`. */
export async function holdersOf(blockId, all) {
  const out = [];
  for (const h of all) {
    try { if ((await h.heldBlocks()).includes(blockId)) out.push(h.name); } catch { /* node is gone */ }
  }
  return out;
}

async function allBlockIds(all) {
  const u = new Set();
  for (const h of all) {
    try { for (const id of await h.heldBlocks()) u.add(id); } catch { /* node is gone */ }
  }
  return u;
}

/**
 * L6 — replication factor. L5 proves the row PROPAGATED to a live peer. It never asks how
 * many nodes hold it. Measured on 0.24.2 in the default config the answer is one, and
 * 24-27 of the ~33 blocks in the run are singly held — so a green L5 can be green over
 * unreplicated data.
 */
export async function legReplicationFactor(ctx, all) {
  await new Promise((r) => setTimeout(r, ctx.SETTLE_MS));
  const holders = await holdersOf(GATE_ROW_BLOCK, all);
  const ids = await allBlockIds(all);
  const singly = [];
  for (const id of [...ids].sort()) {
    const h = await holdersOf(id, all);
    if (h.length === 1) singly.push(id);
    ctx.V(`${String(h.length)}/${all.length}  ${id}  [${h.join(', ')}]`);
  }
  return ctx.recordStanding('L6', 'replication-factor',
    holders.length >= ctx.CLUSTER_SIZE,
    `'${GATE_ROW_BLOCK}' held by ${holders.length}/${all.length} [${holders.join(', ') || 'nobody'}], ` +
    `want >= CLUSTER_SIZE (${ctx.CLUSTER_SIZE}); ${singly.length}/${ids.size} blocks in this run are singly held`,
    ISSUE_15);
}

/**
 * L7 — late-joiner convergence. Every reader so far was present when the row was written.
 * A distributed database has to serve a member that arrives afterwards.
 *
 * Joining also widens every node's cohort view, which is #15's trigger — so this leg meets
 * the defect from the direction a real deployment does: by growing.
 *
 * WHY IT IS RED (triaged 2026-08-25, and it is NOT #15):
 *
 *   1. `peer-C` starts. `CadreNode.start()` reads `optimystic/schema` from the control DB.
 *   2. It already holds one connection — its relay/bootstrap drone — so that drone lands
 *      in the cohort and a real consult runs (no solo-self short-circuit).
 *   3. The drone DENIES the inbound stream:
 *        `db-p2p:sync-service:error inbound stream denied peer=<peer-C>
 *         protocol=/optimystic/control-<party>/db-p2p/sync/1.0.0
 *         reason=predicate returned false`
 *      `peer-C` is not an authorized cadre member yet. db-p2p supplies the mechanism
 *      (`InboundStreamAuthorization`); cadre-core supplies the predicate.
 *   4. A denial reaches the requester as SILENCE. `answered === 0` -> `isolated` ->
 *      `cohort-unreachable`, and `start()` throws.
 *   5. Enrolment can only run after `start()` returns. So the node can never join.
 *
 * A bootstrap ordering deadlock, not a replication defect. The evidence that rules the
 * other candidates out: `no-quorum { responders: 0, required: 1 }` — required is 1, so the
 * corroboration floor had already relaxed and #15 (which needs 2) is not in play; and
 * `findCluster:done peers=2 addressless=0 selfRelayOnly=0` — every member had an address,
 * so #13/#14 are not either.
 *
 * Worth reporting upstream separately: at the verdict level an authorization denial is
 * indistinguishable from unreachability. This said `cohort-unreachable` — network — when
 * the truth was permission.
 */
export async function legLateJoiner(ctx, founder, spawnPeer, rowId, all) {
  const name = 'peer-C';
  let handle;
  try {
    handle = await spawnPeer(name);
    if (ctx.ENROLL) await enrol(ctx, founder, [handle]);
    await withTimeout(handle.addStrand(strandConfig({ mode: 'networked' })), ADD_STRAND_TIMEOUT_MS, `${name} addStrand`);
  } catch (e) {
    // A standing reproduction that swallows ANY error is an instrument that can never be
    // seen to be broken: it reports its own defects as the upstream defect it is watching
    // for, in the same reassuring wording. This leg was doing exactly that — a missing
    // strand config threw `Cannot read properties of undefined (reading 'Id')` and was
    // filed as `expected red (inbound-stream authorization denies the boot read)`.
    //
    // So the red only counts as the KNOWN red when it looks like the known red.
    const msg = `${e?.message ?? e}`;
    const isKnown = /cohort-unreachable|isolated|no-quorum|denied|predicate returned false/i.test(msg);
    if (!isKnown) {
      ctx.record('L7', 'late-joiner-convergence', 'FAIL',
        `${name} could not join, and NOT for the documented reason: ${msg}. The documented ` +
        'failure is an inbound-stream authorization denial surfacing as `cohort-unreachable`; ' +
        'this is something else, so it is reported as a real failure rather than filed under ' +
        'the standing reproduction.');
      return false;
    }
    return ctx.recordStanding('L7', 'late-joiner-convergence', false,
      `${name} could not join after the write: ${msg}`, L7_NOTE);
  }
  all.push(handle);

  const seen = await ctx.poll(async () => {
    const { rows } = await handle.query(`select Id from ${ctx.TABLE} where Id = '${rowId}';`);
    return rows?.some((r) => r?.Id === rowId) ?? false;
  }, ctx.REPLICATION_TIMEOUT_MS, 'late-joiner');

  return ctx.recordStanding('L7', 'late-joiner-convergence', Boolean(seen),
    seen ? `${name} read '${rowId}' after joining`
         : `${name} joined, enrolled and never saw '${rowId}' in ${ctx.REPLICATION_TIMEOUT_MS}ms`,
    L7_NOTE);
}

/**
 * L8 — durability. The promise that separates a distributed database from a cache: losing
 * a node must not lose data.
 *
 * The assertion is on the CENSUS, not on a read, and that distinction is the leg's whole
 * point. Storage here is in-memory, so a block held by one node ceases to exist the moment
 * that node stops. A read can still succeed afterwards — the surviving nodes materialized
 * the row when it propagated and will answer from their own state — which means a naive
 * write-then-read-back check (L5, and most integration tests) reports PASS over data that
 * is no longer stored anywhere. We stop the holder, then report both numbers so the
 * difference is visible.
 *
 * Cross-process the victim's OS process is KILLED, so its heap is genuinely destroyed. In
 * a single process `stop()` is the strongest available move and the objects survive in the
 * heap regardless, which is one more reason the two shapes are not interchangeable.
 *
 * Destructive, so it runs last.
 */
export async function legDurability(ctx, all, rowId) {
  const before = await holdersOf(GATE_ROW_BLOCK, all);
  if (before.length === 0) {
    return ctx.recordStanding('L8', 'durability', false,
      `nobody holds '${GATE_ROW_BLOCK}', so there is nothing to lose`, ISSUE_15);
  }
  const victim = all.find((h) => h.name === before[0]);
  const survivors = all.filter((h) => h.name !== victim.name);

  ctx.L(`stopping ${victim.name} — holder 1 of ${before.length} [${before.join(', ')}] ...`);
  try {
    await victim.kill();
  } catch (e) {
    ctx.V(`${victim.name} stop error: ${e?.message ?? e}`);
  }
  await new Promise((r) => setTimeout(r, ctx.SETTLE_MS));

  // Does any SURVIVING node still hold the block? That is the durability question.
  const after = await holdersOf(GATE_ROW_BLOCK, survivors);

  // And, separately, can anyone still read it? If yes while `after` is empty, the read is
  // being served from memory, not from a stored replica.
  let readableBy = null;
  for (const sv of survivors) {
    const ok = await ctx.poll(async () => {
      const { rows } = await sv.query(`select Id from ${ctx.TABLE} where Id = '${rowId}';`);
      return rows?.some((r) => r?.Id === rowId) ?? false;
    }, ctx.REPLICATION_TIMEOUT_MS, `durability:${sv.name}`);
    if (ok) { readableBy = sv.name; break; }
  }

  const gloss = after.length === 0 && readableBy
    ? `; ${readableBy} still READS '${rowId}', but from its own materialized state — ` +
      'no surviving node holds the block, so a read-back check would call this durable when it is not'
    : after.length === 0
      ? `; and no survivor can read '${rowId}' either`
      : `; ${readableBy ?? 'nobody'} reads it back`;

  return ctx.recordStanding('L8', 'durability', after.length > 0,
    `'${GATE_ROW_BLOCK}' was held by [${before.join(', ')}]; after ${ctx.kind === 'process' ? 'killing' : 'stopping'} ` +
    `${victim.name} it is held by ${after.length}/${survivors.length} survivors [${after.join(', ') || 'none'}]${gloss}`,
    ISSUE_15);
}
