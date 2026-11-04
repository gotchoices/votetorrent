/**
 * shell-gate.js -- RETIRED STUB.
 *
 * Every phase of this page drove the removed sign-in restore path: it
 * restored a network from a fake transport, re-attached it in a fresh page
 * and then forgot it through the old shell's freshness wiring. That path is
 * gone from the dashboard, so no phase of this page can run any more.
 *
 * The live-boot gate rewrite (66-25) replaces this page with one that drives
 * the live boot. Until then this stub FAILS LOUDLY: it publishes a result
 * object carrying `crashed` text, which every shell phase in
 * `run-headless.mjs` reads as a failure, so a stale run can never report
 * PASS.
 *
 * It imports nothing: no `src/` module, no test fixture, no workspace
 * package. It carries no pairing code and no secret.
 */

const RETIRED_TEXT = 'retired: this page drove a removed path; the live-boot gate replaces it';

const win = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
const PHASE = new URLSearchParams(location.search).get('phase') ?? 'restore-seed';

win.__SHELL_GATE__ = { phase: PHASE, retired: true, crashed: RETIRED_TEXT, log: [] };
win.__SHELL_GATE_DONE__ = true;

const verdict = document.getElementById('verdict');
if (verdict) verdict.textContent = RETIRED_TEXT;

// eslint-disable-next-line no-console
console.error(`[shell-gate] ${RETIRED_TEXT}`);
