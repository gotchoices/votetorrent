/**
 * compose-gate.tsx -- RETIRED STUB.
 *
 * Every phase of this page drove the removed sign-in restore path: it seeded
 * a network by redeeming a code through a fake transport, restored the
 * result into IndexedDB and then mounted the old shell on it. That path is
 * gone from the dashboard, so no phase of this page can run any more.
 *
 * The live-boot gate rewrite (66-25) replaces this page with one that mounts
 * the real shell on the live boot. Until then this stub FAILS LOUDLY: it
 * publishes a result object carrying `crashed` text, which every compose
 * phase in `run-headless.mjs` reads as a failure, so a stale run can never
 * report PASS.
 *
 * It imports nothing: no `src/` module, no test fixture, no workspace
 * package. It carries no pairing code and no secret.
 */

const RETIRED_TEXT = 'retired: this page drove a removed path; the live-boot gate replaces it';

const win = window as unknown as Record<string, unknown>;
const PHASE = new URLSearchParams(location.search).get('phase') ?? 'compose-seed';

win.__COMPOSE_GATE__ = { phase: PHASE, retired: true, crashed: RETIRED_TEXT, log: [] };
win.__COMPOSE_GATE_DONE__ = true;

const verdict = document.getElementById('verdict');
if (verdict) verdict.textContent = RETIRED_TEXT;

// eslint-disable-next-line no-console
console.error(`[compose-gate] ${RETIRED_TEXT}`);

export {};
