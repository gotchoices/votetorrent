/**
 * ceremony.mjs — owner genesis and the invite/enrolment ceremony, over handles.
 *
 * Unchanged in substance from the version that lived inside `multipeer-gate.mjs`; it now
 * takes handles so the identical ceremony runs whether the joiner is in this process or
 * in its own. That matters more than it looks: cross-process, the invite genuinely has to
 * be encoded, written to a pipe and decoded at the far end, which is the path a real
 * deployment uses (the invite travels as a QR code) and the path an in-process run skips
 * by handing one node a live object belonging to another.
 */
import {
  ENROLL_TIMEOUT_MS, ENROLL_ATTEMPTS, ENROLL_RETRY_MS,
  SETTLE_TIMEOUT_MS, SETTLE_GRACE_MS, withTimeout,
} from './runner.mjs';

/**
 * Owner genesis on the founder. cadre-core deliberately never runs this implicitly — the
 * hosting app owns it — so a harness must do it explicitly or every owner-signed control
 * write (including `createInvite`) fails.
 *
 *   trustOwnerKeys   anchor the owner pubkey in this node's node-local trusted set
 *   ensureOwnerKey   enroll it in the replicated OwnerKey table
 *   initializeSeedBootstrap  hand the private half to the seed/invite signer
 */
export async function ownerGenesis(ctx, founder) {
  const { publicKeyB64 } = await founder.genesis();
  ctx.V(`owner genesis done (ownerKey=${publicKeyB64.slice(0, 12)}…)`);
  return publicKeyB64;
}

/**
 * `true` / `false` / `'unknown'` — never throws.
 *
 * `isAuthorizedMember` reads the control database, and that read can fail outright
 * (`Block default/Revocation is unavailable (peers-unreachable)`) rather than answering. That
 * is NOT a membership verdict, and treating it as one is what made this ceremony look broken:
 * the check was the FIRST statement in the attempt, so once reads started failing every
 * remaining attempt died before reaching `createInvite`, and the ceremony that would have
 * fixed things never ran. Worse, the failure was then reported as "membership did not take"
 * on a joiner that had in fact been accepted.
 */
export async function isMemberOrUnknown(ctx, owner, peerId) {
  const { value, error } = await owner.isAuthorizedMember(peerId);
  if (value === 'unknown') ctx.V(`membership read for ${peerId} could not be answered: ${error}`);
  return value;
}

export async function enrol(ctx, owner, joiners) {
  for (const handle of joiners) {
    const peerId = handle.peerId();
    let lastErr = null;

    for (let attempt = 1; attempt <= ENROLL_ATTEMPTS; attempt++) {
      const before = await isMemberOrUnknown(ctx, owner, peerId);
      if (before === true) { lastErr = null; break; }

      // Re-run the ceremony only when the control database DEFINITELY says this peer is not
      // a member, or on the first pass. An `unknown` on a later attempt means the ceremony
      // has already run and its result merely cannot be read yet — waiting is the right move,
      // and re-running would storm createInvite/acceptPhone through a read outage for no gain
      // (measured: three joiners x five full ceremonies, minutes of work, no effect).
      if (before === false || attempt === 1) {
        try {
          // Bounded like dialInvite below. createInvite is a control WRITE, and this call sits
          // on the same path whose reads are known to stall; an unbounded write here would
          // hang the whole gate rather than fail it.
          const { encodedInvite } = await withTimeout(
            owner.createInvite(), ENROLL_TIMEOUT_MS, `${handle.name} createInvite`);
          await withTimeout(handle.dialInvite(encodedInvite), ENROLL_TIMEOUT_MS, `${handle.name} dialInvite`);
          try {
            await owner.acceptPhone(peerId, encodedInvite);
          } catch (e) {
            ctx.V(`${handle.name} acceptPhone unavailable: ${e?.message ?? e}`);
          }
          ctx.V(`${handle.name} ceremony ran (attempt ${attempt})`);
        } catch (e) {
          lastErr = e;
          ctx.V(`${handle.name} ceremony attempt ${attempt}/${ENROLL_ATTEMPTS} failed: ${e?.message ?? e}`);
        }
      }

      const settled = await isMemberOrUnknown(ctx, owner, peerId);
      if (settled === true) { lastErr = null; break; }
      lastErr = settled === 'unknown'
        ? new Error('ceremony ran, but the control database could not be read to confirm it')
        : new Error('ceremony completed but membership did not take');

      await new Promise((r) => setTimeout(r, ENROLL_RETRY_MS * attempt)); // linear backoff
    }

    if (lastErr) ctx.L(`WARN enrolment for ${handle.name} did not settle after ${ENROLL_ATTEMPTS} attempt(s): ${lastErr?.message ?? lastErr}`);
    else ctx.V(`${handle.name} enrolled`);
  }
}

/**
 * Wait for the topology to settle before the enrolment ceremony.
 *
 * cadre-core 0.12.0 changed WHEN a relay reservation lands: `network.relayAddrs` takes
 * libp2p's 'search' route and `CadreNode.start()` drives the reservation explicitly AFTER
 * the control database is up, where 0.11.0's relay-qualified listen entry reserved from
 * inside `libp2p.start()`. So `start()` can now return before a relay-only peer has a
 * circuit address, and enrolment issued in that window reads owner-signed control state
 * that no one can serve yet — it fails with
 *   Block default/Revocation is unavailable (peers-unreachable)
 * which is a TIMING artifact, not a membership verdict.
 *
 * `enrol()`'s bounded retry alone is not enough: on 0.12.0 the whole retry budget can
 * elapse before the reservation lands, so the gate went from deterministic to flaky (it
 * passed one run and failed the next on an unchanged tree). Gate on the observable
 * preconditions instead — the founder sees everyone, and every relay-only peer holds a
 * `/p2p-circuit` address — then let the existing retry cover the residual jitter.
 *
 * Returns false on timeout rather than throwing: enrolment still runs, and L3 still
 * reports the real failure if membership genuinely cannot be established.
 */
export async function settleTopology(ctx, founder, all, relayOnly, ms = SETTLE_TIMEOUT_MS) {
  const deadline = Date.now() + ms;
  for (;;) {
    const founderPeers = (await founder.connections()).peers.length;
    let meshed = founderPeers >= all.length - 1;
    if (meshed) {
      for (const h of all) {
        if ((await h.connections()).count < 1) { meshed = false; break; }
      }
    }
    let reserved = true;
    for (const h of relayOnly) {
      if (!(await h.addrs()).some((a) => a.includes('/p2p-circuit'))) { reserved = false; break; }
    }
    if (meshed && reserved) {
      await new Promise((r) => setTimeout(r, SETTLE_GRACE_MS));  // let the control writes land
      ctx.V(`topology settled (founder sees ${founderPeers}, ${relayOnly.length} reservation(s))`);
      return true;
    }
    if (Date.now() >= deadline) {
      ctx.L(`WARN topology did not settle in ${ms}ms (meshed=${meshed} reserved=${reserved}) — enrolling anyway`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
