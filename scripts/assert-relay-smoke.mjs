#!/usr/bin/env node
/**
 * assert-relay-smoke.mjs
 *
 * Verdict authority for PUB-03's Node half (phase 40 —
 * published-package-consumption-quereus-431): "packages/p2p-probe-host/
 * relay-smoke.mjs reaches `RELAY SMOKE: PASS` on published cadre-core (a live
 * /p2p-circuit reservation)".
 *
 * Why this exists: relay-smoke.mjs is the phase's ONLY runtime/behavioural
 * claim — every other Phase 40 lock (published-stack-lock-regression.spec.ts,
 * no-portal-vendor-regression.spec.ts, quereus-single-copy-regression.spec.ts)
 * samples the yarn.lock manifest, not the actual libp2p relay handshake. Prior
 * to this script, PUB-03's Node half was `40-VALIDATION.md`-classified
 * manual-only with zero automated sampling, so the published substrate could
 * drift under it (as it has: @serfab 0.8.1 -> 0.11.0, @optimystic 0.14.1 ->
 * 0.25.1, quereus 4.3.1 -> 4.17.1) with nothing re-running the relay path
 * until someone spent emulator time chasing a regression by hand.
 *
 * relay-smoke.mjs's own exit code IS trustworthy on its happy path (unlike
 * the mocha/tsc runners assert-ci-baselines.mjs exists to second-guess) — it
 * sets exitCode=1 on every one of its internal FAIL branches and 0 only on
 * the single success path ending in `RELAY SMOKE: PASS`. But this wrapper
 * does not trust the exit code ALONE: it also greps captured stdout for the
 * literal `RELAY SMOKE: PASS` marker, and treats either a `RELAY SMOKE: FAIL`
 * marker OR a missing marker as a hard failure even if the exit code were
 * somehow 0 — belt-and-suspenders against a future edit to relay-smoke.mjs
 * that changes exit-code plumbing without changing the printed marker (or
 * vice versa).
 *
 * This script spawns a live libp2p relay-server + relay-client pair (real
 * sockets, real circuit-relay-v2 handshake) — it is deliberately NOT part of
 * the hermetic vote-engine mocha suite. It self-terminates in ~2-3s on this
 * measured hardware (relay-smoke.mjs's own internal reservation timeout is
 * 30s), so a HARD_TIMEOUT_MS well above the measured wall-clock but bounded
 * well below "hung forever" catches a stuck subprocess (e.g. a libp2p
 * upgrade that leaves a dangling socket) rather than blocking a CI job
 * indefinitely.
 *
 * Usage:
 *   node scripts/assert-relay-smoke.mjs
 *
 * Exit 0 + a `RECEIPT relay-smoke ...` line on PASS; exit 1 with the
 * captured output tail on FAIL, missing-marker, non-zero exit, or timeout.
 *
 * Update / removal trigger: if relay-smoke.mjs's printed marker text ever
 * changes, update PASS_MARKER/FAIL_MARKER in the SAME commit.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const PROBE_HOST_DIR = path.join(REPO_ROOT, 'packages', 'p2p-probe-host');

// Measured wall-clock on this hardware (2026-09-01, Node v22.15.0, 3
// consecutive runs): ~2.1s each, reservation observed at ~1.26s. relay-
// smoke.mjs's own internal RESERVATION_TIMEOUT_MS is 30_000. HARD_TIMEOUT_MS
// gives real headroom over both figures (a slower CI runner, GC pauses, a
// cold require cache) while still bounding a genuine hang -- a value close to
// the measured 2.1s would make an unrelated slow CI runner indistinguishable
// from a real regression.
const HARD_TIMEOUT_MS = 60_000;

const PASS_MARKER = 'RELAY SMOKE: PASS';
const FAIL_MARKER = 'RELAY SMOKE: FAIL';

function fail(msg) {
  process.stderr.write(`[assert-relay-smoke] ${msg}\n`);
  process.exit(1);
}

function tail(text, lines = 20) {
  return text.split('\n').slice(-lines).join('\n');
}

async function main() {
  const start = Date.now();

  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['relay-smoke.mjs'], {
      cwd: PROBE_HOST_DIR,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL, not SIGTERM: relay-smoke.mjs installs its own SIGTERM/SIGINT
      // handlers that call shutdown() and exit(1) -- a genuinely hung process
      // (the exact failure mode this timeout exists to catch) may not be
      // responsive to its own handler either, so don't rely on it.
      child.kill('SIGKILL');
    }, HARD_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, spawnError: err });
    });
  });

  const elapsedMs = Date.now() - start;
  const combined = result.stdout + result.stderr;

  if (result.spawnError) {
    fail(`failed to spawn relay-smoke.mjs: ${result.spawnError.message}`);
  }

  if (result.timedOut) {
    fail(
      `relay-smoke.mjs did not complete within HARD_TIMEOUT_MS=${HARD_TIMEOUT_MS}ms ` +
        `(killed with SIGKILL). This is a hang, not a transient slowness -- relay-smoke.mjs's ` +
        `own internal reservation timeout is 30s, so a run past ${HARD_TIMEOUT_MS}ms means the ` +
        `process itself wedged (e.g. a dangling socket / unresolved promise) rather than ` +
        `legitimately still working.\n\nCaptured output tail:\n${tail(combined)}`,
    );
  }

  const hasFailMarker = combined.includes(FAIL_MARKER);
  const hasPassMarker = combined.includes(PASS_MARKER);

  if (hasFailMarker) {
    fail(
      `relay-smoke.mjs printed "${FAIL_MARKER}" -- PUB-03 (Node half) is broken on the currently ` +
        `installed published packages.\n\nCaptured output tail:\n${tail(combined)}`,
    );
  }

  if (!hasPassMarker) {
    fail(
      `relay-smoke.mjs's output contains neither "${PASS_MARKER}" nor "${FAIL_MARKER}" ` +
        `(exit code ${result.code}). Treating a missing marker as a hard failure rather than ` +
        `trusting the exit code alone.\n\nCaptured output tail:\n${tail(combined)}`,
    );
  }

  if (result.code !== 0) {
    fail(
      `relay-smoke.mjs printed "${PASS_MARKER}" but exited with code ${result.code} (expected 0) -- ` +
        `exit code and printed marker disagree; treating this as untrustworthy rather than green.` +
        `\n\nCaptured output tail:\n${tail(combined)}`,
    );
  }

  process.stdout.write(
    `RECEIPT relay-smoke marker=PASS exit=0 elapsedMs=${elapsedMs}\n`,
  );
  process.exit(0);
}

main().catch((err) => {
  fail(`unexpected error: ${err?.stack ?? err}`);
});
