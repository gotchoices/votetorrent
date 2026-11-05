/**
 * publish-self-record.ts — publishSelfRecordAfterEnrol.
 *
 * Works around a documented @serfab/cadre-core 1.6.0 gap (cadre-node.js, the NOTE in
 * `startRecordRefresh`): a node AUTHORIZED AFTER IT BOOTED does not publish its signed
 * `CadrePeer` address record until the next heartbeat, up to 7.5 minutes later. Its boot-time
 * publish runs ~1s after start, before any invite enrollment, finds no readable row of its own,
 * and skips. After that the only triggers are the heartbeat and an address change, and a
 * relay-only phone's addresses stop changing once its reservation lands. Until it publishes,
 * its row carries only the owner's vouch (`Sig` null, no addrs), so every other member's
 * `resolvePeerAddrs` rejects it and nobody can dial it back. In the P2P-11 proof that phone
 * joined the strand with `strandPeers=0` and failed with `Missing block`.
 *
 * An invited phone is exactly this case, so after enrolling, call the public, idempotent
 * `registerSelf()` until it reports a real write. `skipped` means the owner's row has not
 * replicated to us yet, so we wait and retry. A throw is retried too (a control write that
 * could not land yet). Bounded: gives up after `timeoutMs` and reports the last outcome,
 * never throws.
 *
 * Drop this once cadre-core republishes on membership change itself (the fix its own NOTE
 * proposes: `ControlDatabase.setMembershipChangeListener`).
 */

import type { SelfRegistrationOutcome } from '@serfab/cadre-core';

/** Structural subset of `CadreNode` — the real `CadreNode` satisfies it with no cast. */
export interface SelfRecordPublisher {
  registerSelf(): Promise<SelfRegistrationOutcome>;
}

export interface PublishSelfRecordOptions {
  /** Total budget before giving up. Default 120 s. */
  timeoutMs?: number;
  /** Delay between attempts. Default 5 s. */
  intervalMs?: number;
  signal?: AbortSignal;
}

export interface PublishSelfRecordResult {
  /** True once `registerSelf()` reported `inserted` or `refreshed`. */
  published: boolean;
  /** The last outcome seen, or `'error'` if the last attempt threw. */
  outcome: SelfRegistrationOutcome | 'error';
  attempts: number;
  elapsedMs: number;
  lastError?: unknown;
}

export async function publishSelfRecordAfterEnrol(
  node: SelfRecordPublisher,
  options: PublishSelfRecordOptions = {},
): Promise<PublishSelfRecordResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 5_000;
  const startedAt = Date.now();
  let attempts = 0;
  let outcome: SelfRegistrationOutcome | 'error' = 'skipped';
  let lastError: unknown;

  for (;;) {
    attempts++;
    try {
      outcome = await node.registerSelf();
      lastError = undefined;
    } catch (error) {
      outcome = 'error';
      lastError = error;
    }
    const elapsedMs = Date.now() - startedAt;
    if (outcome === 'inserted' || outcome === 'refreshed') {
      return { published: true, outcome, attempts, elapsedMs };
    }
    if (options.signal?.aborted || elapsedMs + intervalMs > timeoutMs) {
      return { published: false, outcome, attempts, elapsedMs, lastError };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}
