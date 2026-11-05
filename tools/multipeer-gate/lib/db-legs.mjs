/**
 * db-legs.mjs — the legs that ask whether this is actually a distributed database.
 *
 * WHAT L1-L5 LEAVE UNCOVERED
 * --------------------------
 * L5 writes one row on peer-A and reads it on peer-B. That is one direction, one row, one
 * reader, one shot, and it is the ONLY data assertion in the gate. Everything below is a
 * property a distributed database has to hold that L5 passes without ever testing:
 *
 *   L5 passes if the path only works A->B.            D1 writes back the other way.
 *   L5 passes if only the sibling ever converges.     D2 makes every node read it.
 *   L5 passes if a second concurrent write is lost.   D3 writes from both at once.
 *   L5 passes if data can be inserted but not changed.D4 updates, then deletes.
 *   L5 passes if the reader never needed the network. D5 is the negative control.
 *
 * D1-D5 FAIL THE GATE. They are not exotic: the n=4 device runs fail with both peers
 * writing and reading cleanly while NEITHER sees the other's row, which is exactly D1/D2
 * and is invisible to L5 in the direction it happens to sample.
 *
 * The standing reproductions of known upstream defects (L6-L8) live in `core-legs.mjs`.
 * They are recorded and never fatal, so a fix can be verified by watching one flip green;
 * the legs here are different in kind — they assert properties that are supposed to hold.
 *
 * THE LEGS ARE TRANSPORT-BLIND
 * ----------------------------
 * Each takes handles from `lib/handles.mjs` and never touches a CadreNode. The same
 * source runs with all nodes in one process and with every node in its own OS process
 * (`multiproc-gate.mjs`), which is what makes the two results comparable — and the
 * comparison is the measurement, because a shared heap can satisfy a data assertion
 * without a byte ever reaching a socket.
 */

/** Rows matching `sql` on `handle`, or null when the read could not be served. */
async function rows(handle, sql) {
  const out = await handle.query(sql);
  return out?.rows ?? null;
}

/** Poll until `id` is visible on `handle` — optionally with a specific `Value`. */
function visible(ctx, handle, id, wantValue) {
  return ctx.poll(async () => {
    const r = await rows(handle, `select Id, Value, Writer from ${ctx.TABLE} where Id = '${id}';`);
    if (!r || r.length === 0) return false;
    if (wantValue === undefined) return true;
    return r[0]?.Value === wantValue ? true : false;
  }, ctx.REPLICATION_TIMEOUT_MS, `visible:${handle.name}:${id}`);
}

/** Poll until `id` is ABSENT on `handle`. A read that cannot be served is not absence. */
function absent(ctx, handle, id) {
  return ctx.poll(async () => {
    const r = await rows(handle, `select Id from ${ctx.TABLE} where Id = '${id}';`);
    if (r === null) return false;           // unreadable != deleted
    return r.length === 0 ? true : false;
  }, ctx.REPLICATION_TIMEOUT_MS, `absent:${handle.name}:${id}`);
}

/**
 * Poll until EVERY (member, row) pair is satisfied, under ONE shared deadline.
 *
 * Per-pair deadlines were the obvious way to write this and the wrong one: a failure then
 * costs `members x rows x timeout`, which on a four-node run is minutes of waiting to
 * re-learn what the first unsatisfied pair already said. Convergence is a property of the
 * whole set, so give the whole set one window.
 *
 * Returns `{ ok, missing }` — `missing` is what was still unsatisfied when the window closed.
 */
async function allVisible(ctx, handles, wants, label) {
  let missing = [];
  const got = await ctx.poll(async () => {
    missing = [];
    for (const h of handles) {
      for (const w of wants) {
        const r = await rows(h, `select Id, Value from ${ctx.TABLE} where Id = '${w.id}';`);
        const ok = r !== null && r.length > 0 && (w.value === undefined || r[0]?.Value === w.value);
        if (!ok) {
          missing.push(`${h.name} lacks '${w.id}'${w.value === undefined ? '' : `='${w.value}'`}` +
            `${r === null ? ' (read could not be served)' : ''}`);
        }
      }
    }
    ctx.V(`${label}: ${missing.length ? `${missing.length} pair(s) outstanding` : 'all satisfied'}`);
    return missing.length === 0 ? true : null;
  }, ctx.REPLICATION_TIMEOUT_MS, label);
  return { ok: Boolean(got), missing };
}

/** A short, honest description of what a node could see, for failure messages. */
async function census(ctx, handles, id) {
  const parts = [];
  for (const h of handles) {
    const r = await rows(h, `select Id, Value from ${ctx.TABLE} where Id = '${id}';`);
    parts.push(`${h.name}=${r === null ? 'unreadable' : r.length ? `'${r[0].Value}'` : 'absent'}`);
  }
  return parts.join(' ');
}

/**
 * DD — every drone can ACTUALLY DIAL every relay-only peer.
 *
 * Runs AFTER L3, deliberately. Before enrolment the control network is a star (L1 says so
 * in as many words), and the mesh only widens once `reconcileControlCohort` runs, which is
 * gated on membership. Asserting reachability earlier asserts something the design does not
 * promise yet — and that is not theoretical: when this check lived in L2 it passed in one
 * process, where the mesh happened to widen in time, and failed with one process per node,
 * where it did not. The leg was reporting on its own position in the sequence.
 *
 * Two assertions, in order, because they fail for different reasons:
 *
 *   1. Every drone holds a `/p2p-circuit` address for every peer. THIS is wall #8 (38-21:
 *      drone-B raised `NoValidAddressesError` against Peer A 1312x while drone-A raised
 *      none, because the peer's reservation had landed with drone-A alone). A single
 *      reservation is expected and fine — but only if the non-reserving drones learn a
 *      circuit address for the peer and can route through the relay that holds it. A
 *      reservation count can never show that; the other members' peer stores can.
 *
 *   2. The dial actually succeeds. An address on file is bookkeeping, and bookkeeping is
 *      exactly what looked healthy through every device failure in this topology: the
 *      address was present, well-formed and undialable. The device runs die with
 *      `UnexpectedEOFError` and then `NoValidAddressesError` at block-transfer time —
 *      during a dial, which no address census performs.
 */
export async function legRealDial(ctx, drones, peers) {
  // (1) the address census — polled, because the mesh widens asynchronously after L3.
  const missingNow = async () => {
    const missing = [];
    for (const d of drones) {
      for (const p of peers) {
        if ((await d.circuitAddrsFor(p.peerId())).length === 0) missing.push(`${d.name}->${p.name}`);
      }
    }
    return missing;
  };
  const reachable = await ctx.poll(async () => {
    const missing = await missingNow();
    ctx.V(`reachability missing=${missing.length ? missing.join(',') : 'none'}`);
    return missing.length === 0 ? true : null;
  }, ctx.RESERVATION_TIMEOUT_MS, 'cohort reachability');

  if (!reachable) {
    ctx.record('DD', 'dial-through-relay', 'FAIL',
      'the reservations landed, but these cohort members hold NO circuit address for a ' +
      `relay-only peer: ${(await missingNow()).join(' ')}. Such a member cannot dial that peer ` +
      'at all, so its consensus votes and block transfers are silently undeliverable — the ' +
      '38-21 wall, which a reservation count cannot see.');
    return false;
  }

  // (2) the dial itself.
  const failures = [];
  const successes = [];
  let fresh = 0;
  for (const d of drones) {
    for (const p of peers) {
      const res = await d.dial(p.peerId());
      if (res?.ok) {
        if (!res.reused) fresh++;
        successes.push(`${d.name}->${p.name} ${res.ms}ms ${res.reused ? 'reused' : 'FRESH'}`);
      } else {
        failures.push(`${d.name}->${p.name} ${res?.error ?? 'no result'}`);
      }
    }
  }
  if (failures.length) {
    ctx.record('DD', 'dial-through-relay', 'FAIL',
      `every drone holds a circuit address for every peer, and these dials were still ` +
      `refused: ${failures.join('; ')}. That gap between "addressed" and "dialable" is the ` +
      'one the device runs fall into; an address census reports the first and stays silent ' +
      'about the second.');
    return false;
  }

  // Stating the weaker claim when that is the claim earned. libp2p returns an OPEN
  // connection instead of opening a new one, and calling that a dial would be the same
  // bookkeeping-as-proof this leg exists to replace.
  const qualifier = fresh === 0
    ? ' — every connection was ALREADY OPEN, so this confirms reachability rather than ' +
      'proving a cold dial'
    : ` — ${fresh} of ${successes.length} were FRESH dials`;
  ctx.record('DD', 'dial-through-relay', 'PASS', successes.join(' · ') + qualifier);
  return true;
}

/**
 * D1 — replication in the OTHER direction.
 *
 * L5 samples one direction and calls it replication. The directions are not symmetric in
 * this topology: a relay-only peer's reservation lands with ONE relay (cadre-core 0.12.0's
 * `requestReservation` returns on first success), so reachability depends on which relay a
 * given node routes through. A path that works A->B and not B->A passes L5 every time.
 */
export async function legReverseReplication(ctx, peerA, peerB) {
  const id = `${ctx.runId}-reverse`;
  try {
    await peerB.exec(
      `insert into ${ctx.TABLE} (Id, Value, Writer) values ('${id}', 'written-by-${peerB.name}', '${peerB.name}');`);
  } catch (e) {
    ctx.record('D1', 'replication-reverse', 'FAIL',
      `${peerB.name} could not write: ${e?.message ?? e}. L5 only ever writes from ${peerA.name}, ` +
      'so a write path that is broken in this direction has never been exercised.');
    return false;
  }
  const seen = await visible(ctx, peerA, id, `written-by-${peerB.name}`);
  if (!seen) {
    ctx.record('D1', 'replication-reverse', 'FAIL',
      `${peerB.name} wrote '${id}' and ${peerA.name} never saw it in ${ctx.REPLICATION_TIMEOUT_MS}ms ` +
      `(${await census(ctx, [peerA, peerB], id)}). L5 passed on the same pair in the opposite ` +
      'direction, so the replication path is one-way — which no single-direction test can detect.');
    return false;
  }
  ctx.record('D1', 'replication-reverse', 'PASS', `${peerA.name} observed ${peerB.name}'s '${id}'`);
  return true;
}

/**
 * D2 — EVERY member converges, not just the sibling that happened to be asked.
 *
 * L5 asks one reader. On the n=4 device runs both peers write and read their own rows
 * cleanly and neither sees the other's; a gate that samples a single reader reports that
 * as replication working. Convergence is a property of the membership, so assert it over
 * the membership.
 */
export async function legConvergeAll(ctx, all, ids) {
  const { ok, missing } = await allVisible(ctx, all, ids.map((id) => ({ id })), 'converge-all');
  if (!ok) {
    const detail = [];
    for (const id of ids) detail.push(`${id}: ${await census(ctx, all, id)}`);
    ctx.record('D2', 'convergence-all-members', 'FAIL',
      `${missing.length} of ${all.length * ids.length} (member, row) pairs never converged in ` +
      `${ctx.REPLICATION_TIMEOUT_MS}ms — ${missing.join('; ')}. Full census: ${detail.join(' | ')}. ` +
      'L5 samples ONE reader, so partial convergence reads as success there.');
    return false;
  }
  ctx.record('D2', 'convergence-all-members', 'PASS',
    `all ${all.length} members observed all ${ids.length} row(s)`);
  return true;
}

/**
 * D3 — two peers write AT THE SAME TIME and nothing is lost.
 *
 * Every write in L5 is serialized by the harness, so the block is only ever mutated by one
 * writer at a time — the one case a last-writer-wins clobber cannot show up in. These
 * two inserts are issued without awaiting each other and land in the same block, which is
 * where concurrent-write defects actually live.
 *
 * The assertion is on BOTH rows surviving on BOTH writers, with the value each writer
 * wrote. A row that exists carrying the other peer's value is a lost update, and presence
 * checks — L5's and most integration tests' — cannot see one.
 */
export async function legConcurrentWrites(ctx, peerA, peerB, all) {
  const idA = `${ctx.runId}-concurrent-a`;
  const idB = `${ctx.runId}-concurrent-b`;
  const results = await Promise.allSettled([
    peerA.exec(`insert into ${ctx.TABLE} (Id, Value, Writer) values ('${idA}', 'v-${peerA.name}', '${peerA.name}');`),
    peerB.exec(`insert into ${ctx.TABLE} (Id, Value, Writer) values ('${idB}', 'v-${peerB.name}', '${peerB.name}');`),
  ]);
  const rejected = results
    .map((r, i) => (r.status === 'rejected' ? `${[peerA, peerB][i].name}: ${r.reason?.message ?? r.reason}` : null))
    .filter(Boolean);
  if (rejected.length) {
    ctx.record('D3', 'concurrent-writes', 'FAIL',
      `a simultaneous write was rejected — ${rejected.join('; ')}. Two members writing at once is ` +
      'the ordinary case for a shared database; the gate has never issued one before this leg.');
    return false;
  }

  const { ok, missing } = await allVisible(ctx, all, [
    { id: idA, value: `v-${peerA.name}` },
    { id: idB, value: `v-${peerB.name}` },
  ], 'concurrent-writes');
  if (!ok) {
    ctx.record('D3', 'concurrent-writes', 'FAIL',
      `after two simultaneous writes: ${missing.join('; ')}. Census — ` +
      `${idA}: ${await census(ctx, all, idA)} | ${idB}: ${await census(ctx, all, idB)}. ` +
      'Both rows live in the same block, so one write overwriting the other is a lost update, ' +
      'not a delay — and a presence-only check would still call this PASS.');
    return false;
  }
  ctx.record('D3', 'concurrent-writes', 'PASS',
    `both simultaneous writes survived on all ${all.length} members, each with its own writer's value`);
  return true;
}

/**
 * D4 — a row can be CHANGED and REMOVED, not merely added.
 *
 * Insert propagation is the easy half: a new row is new state, and anything that forwards
 * state at all will carry it. An UPDATE has to supersede a value the reader already holds,
 * and a DELETE has to remove one. A store that only ever grows — or a reader answering
 * from its own materialized copy rather than from the replicated block — passes every
 * insert-only assertion in this gate and fails here.
 */
export async function legMutationPropagation(ctx, writer, reader) {
  const id = `${ctx.runId}-mutate`;
  try {
    await writer.exec(`insert into ${ctx.TABLE} (Id, Value, Writer) values ('${id}', 'v1', '${writer.name}');`);
  } catch (e) {
    ctx.record('D4', 'mutation-propagation', 'FAIL', `${writer.name} could not seed the row: ${e?.message ?? e}`);
    return false;
  }
  if (!(await visible(ctx, reader, id, 'v1'))) {
    ctx.record('D4', 'mutation-propagation', 'FAIL',
      `${reader.name} never saw the seed row '${id}'='v1' (${await census(ctx, [writer, reader], id)})`);
    return false;
  }

  try {
    await writer.exec(`update ${ctx.TABLE} set Value = 'v2' where Id = '${id}';`);
  } catch (e) {
    ctx.record('D4', 'mutation-propagation', 'FAIL', `${writer.name} could not UPDATE: ${e?.message ?? e}`);
    return false;
  }
  if (!(await visible(ctx, reader, id, 'v2'))) {
    ctx.record('D4', 'mutation-propagation', 'FAIL',
      `'${id}' was updated to 'v2' on ${writer.name} and ${reader.name} still does not show it ` +
      `(${await census(ctx, [writer, reader], id)}). The row PROPAGATED and then stopped tracking ` +
      'its writer — an insert-only check calls that a pass.');
    return false;
  }

  try {
    await writer.exec(`delete from ${ctx.TABLE} where Id = '${id}';`);
  } catch (e) {
    ctx.record('D4', 'mutation-propagation', 'FAIL', `${writer.name} could not DELETE: ${e?.message ?? e}`);
    return false;
  }
  if (!(await absent(ctx, reader, id))) {
    ctx.record('D4', 'mutation-propagation', 'FAIL',
      `'${id}' was deleted on ${writer.name} and ${reader.name} still returns it ` +
      `(${await census(ctx, [writer, reader], id)}). A delete that does not converge leaves ` +
      'members disagreeing about what the database contains.');
    return false;
  }

  ctx.record('D4', 'mutation-propagation', 'PASS',
    `insert -> update -> delete on ${writer.name} all converged on ${reader.name}`);
  return true;
}

/**
 * D5 — the negative control, and the reason to believe D1-D4 at all.
 *
 * Every assertion above is satisfied if the "reader" was never reading anything remote.
 * In a single process that is a live possibility rather than a hypothetical: four nodes
 * sharing a heap can satisfy a data assertion with no byte ever reaching a socket, and
 * nothing in a green D1-D4 distinguishes the two.
 *
 * `outsider` is a node founded in a DIFFERENT party, on its own strand, in the same
 * process (or on the same host) as everyone else. It shares the heap, the module registry
 * and the event loop with the cohort, and shares no membership with it. It must see
 * nothing. If it does, the data is travelling by some route other than replication and
 * every green above is worthless.
 *
 * A control arm that cannot fail proves nothing, so this leg is reported even when the
 * legs it vouches for were skipped.
 */
export async function legIsolationControl(ctx, outsider, ids) {
  // First: is this control arm even alive? An outsider whose strand database cannot be
  // queried sees nothing no matter what, and would report PASS forever while proving
  // nothing at all. It writes its own row and reads it back, so a green below means "a
  // working database that can see its own data cannot see the cohort's" rather than
  // "a query returned empty".
  const ownId = `${ctx.runId}-outsider-own`;
  try {
    await outsider.exec(
      `insert into ${ctx.TABLE} (Id, Value, Writer) values ('${ownId}', 'own', '${outsider.name}');`);
  } catch (e) {
    ctx.record('D5', 'isolation-control', 'FAIL',
      `${outsider.name} could not write to its own strand: ${e?.message ?? e}. The control arm is ` +
      'inert — it would report "sees nothing" whether or not the cohort leaked to it, so it ' +
      'cannot vouch for D1-D4.');
    return false;
  }
  const ownVisible = await visible(ctx, outsider, ownId, 'own');
  if (!ownVisible) {
    ctx.record('D5', 'isolation-control', 'FAIL',
      `${outsider.name} cannot read back its OWN row '${ownId}'. The control arm is inert: an ` +
      'outsider that can see nothing at all cannot demonstrate that it is membership, rather ' +
      'than a broken query, keeping the cohort\'s rows away from it.');
    return false;
  }

  const leaked = [];
  for (const id of ids) {
    const r = await rows(outsider, `select Id, Value from ${ctx.TABLE} where Id = '${id}';`);
    if (r && r.length > 0) leaked.push(`'${id}'='${r[0].Value}'`);
  }
  if (leaked.length) {
    ctx.record('D5', 'isolation-control', 'FAIL',
      `${outsider.name} is in a different party and shares no membership with the cohort, yet it ` +
      `can read ${leaked.join(', ')}. The rows are reaching it by something other than replication ` +
      '— so D1-D4 are measuring process-local state, not a distributed database, and their ' +
      'green means nothing.');
    return false;
  }
  ctx.record('D5', 'isolation-control', 'PASS',
    `${outsider.name} (different party, same ${outsider.kind === 'process' ? 'host' : 'process'}) ` +
    `reads back its own row but none of the cohort's ${ids.length}`);
  return true;
}
