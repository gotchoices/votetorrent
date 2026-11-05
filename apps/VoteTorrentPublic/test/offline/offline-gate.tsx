/**
 * offline-gate.tsx — the harness for 56-12's computed-style browser gate
 * (D-17's staleness banner, D-13's config-fault box).
 *
 * Modelled on `test/browser/election-shell-gate.tsx`'s own shape: imports
 * `../../src/app.css` FIRST so the built bundle carries `app.css`,
 * `tokens.css` and `components.css`; branches on a `fixture` query
 * parameter; publishes ONE frozen readout the runner reads; grades nothing
 * itself. See that file's own header for the conventions this one inherits
 * rather than re-derives (the bounded `requestAnimationFrame` poll, the
 * never-throw mount wrapper, the address-shaped constants built from
 * `election-address.js`'s own exported parameter names).
 *
 * TWO RECOGNISED VALUES for `?fixture=`, mutually exclusive; with the
 * parameter absent or unrecognised this page mounts nothing and simply
 * publishes an inert readout (never exercised by the runner, kept only so a
 * stray navigation cannot hang):
 *
 * - `stale` — seeds the shared public surface via `seedFixtureSurface()`
 *   (`../fixtures/seed-public-surface.js`; load-bearing — `attachNetworkDb`
 *   refuses a handle with no persisted row-count record, so an unseeded
 *   branch would render a FAULT while claiming to render the FINDING), then
 *   mounts `ElectionShell` with a `source` seam that REPRODUCES the real
 *   production condition `use-public-election.ts`'s own `console.debug` line
 *   already describes: a handle exposing no change channel. The election id
 *   on the page's OWN URL controls which election is requested — this is
 *   what lets the runner drive both the happy path (the seeded election,
 *   `connection: 'down'` because the channel is hidden) and the
 *   discrimination rung (`UNHELD_ELECTION_ID`, seeded network, unseeded
 *   election — `notHeld`, never a banner) from the SAME fixture value.
 *
 * - `config` — mounts `PublicApp` with NO props, so the REAL production
 *   composition runs: the real loader, a real same-origin `fetch` of
 *   `/config.json`, the real fault classification, the real render. No
 *   loader is injected here — injection is the Node tier's job
 *   (`test/node/offline-surfaces.test.mjs`), and a gate that injected one
 *   would prove nothing about the composition. The runner writes/removes
 *   `config.json` in the served `dist-offline/` root BETWEEN navigations;
 *   `loadBootstrapConfig` sends `cache: 'no-store'`, so each navigation
 *   genuinely refetches.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/app.css';
import { ElectionShell } from '../../src/screens/ElectionShell';
import { PublicApp } from '../../src/screens/PublicApp';
import { COPY } from '@votetorrent/ui-web';
import { DEFAULT_PUBLIC_SOURCE } from '../../src/public-election-source.js';
import type { PublicSourceDeps } from '../../src/public-election-source.js';
import { ELECTION_ADDRESS_PARAM, NETWORK_ADDRESS_PARAM } from '../../src/election-address.js';
import {
	FIXTURE_NETWORK_HASH,
	FIXTURE_ELECTION_DB_ID,
	FIXTURE_SETTLING_INSTANT,
	PUBLIC_SURFACE_EXPECTED_COUNTS,
	SEED_NOW,
	seedPublicSurface,
} from '../fixtures/seed-public-surface.js';
import { createNetworkDb, closeNetworkDb, deleteNetworkDb, writeRowCounts, upsertNetwork } from '@votetorrent/web-data/public';

declare global {
	interface Window {
		__OFFLINE_GATE__?: Readonly<{
			harness: string;
			fixture: string | null;
			error: string | null;
			injectedInstant: string | null;
			requestedElectionId: string | null;
		}>;
		__UI_GATE_DONE__?: boolean;
	}
}

// ---------------------------------------------------------------------------
// The fixed, hours-old canonical instant the 'stale' branch's nowCanonical()
// reports (Fixture requirement 5). Derived from the real clock at MODULE
// LOAD minus a constant offset, so it is stale on any machine on any day — a
// fixture timestamped seconds before the run cannot discriminate an absolute
// rendering from a relative one. Exported so the runner recomputes the
// expected sentence from the SAME value rather than restating it.
// ---------------------------------------------------------------------------

const STALE_OFFSET_MS = 6 * 60 * 60 * 1000; // six hours — comfortably over the runner's own one-hour anti-vacuity floor
export const STALE_INSTANT = new Date(Date.now() - STALE_OFFSET_MS).toISOString().slice(0, 19);

// ---------------------------------------------------------------------------
// The 'stale' branch's module-constant source (56-12/D-17). A MODULE
// constant, never a per-render object literal: `source` is one of
// `use-public-election.ts`'s own effect dependencies, and a fresh object
// every render would re-run the read on every commit.
// ---------------------------------------------------------------------------

const STALE_SOURCE: PublicSourceDeps = Object.freeze({
	...DEFAULT_PUBLIC_SOURCE,
	/**
	 * Awaits the real `attachNetworkDb`, then wraps the resolved handle in a
	 * `Proxy` whose `get` trap returns `undefined` for the change-channel
	 * method name (`onDataChange`) and otherwise forwards through
	 * `Reflect.get`, binding functions to the target so engine methods keep
	 * their receiver. This is a REPRODUCTION of the real production
	 * condition `use-public-election.ts`'s own header and `console.debug`
	 * line already describe — a handle exposing no change channel — not a
	 * planted UI state.
	 */
	attachNetworkDb: async (networkHash: string, options?: unknown) => {
		const real = await DEFAULT_PUBLIC_SOURCE.attachNetworkDb(networkHash, options as never);
		return new Proxy(real, {
			get(target: object, prop: string | symbol, receiver: unknown) {
				if (prop === 'onDataChange') return undefined;
				const value = Reflect.get(target, prop, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
	},
	nowCanonical: () => STALE_INSTANT,
});

// ---------------------------------------------------------------------------
// Fixture-parameter resolution — THIS PAGE's own second query parameter,
// read by this file only and never forwarded into ElectionShell's own
// address under a different name.
// ---------------------------------------------------------------------------

const FIXTURE_PARAM = 'fixture';
const STALE_FIXTURE = 'stale';
const CONFIG_FIXTURE = 'config';

const pageParams = new URLSearchParams(window.location.search);
const fixtureParamValue = pageParams.get(FIXTURE_PARAM);
const staleMode = fixtureParamValue === STALE_FIXTURE;
const configMode = fixtureParamValue === CONFIG_FIXTURE;

/**
 * The 'stale' branch's address. The election id is read off THIS PAGE's own
 * URL (defaulting to the seeded `FIXTURE_ELECTION_DB_ID`) so the runner can
 * drive both the happy path and the `staleness-absent-when-not-ready`
 * discrimination rung (an unseeded election id, same seeded network) from
 * one fixture value, purely by varying the navigated URL.
 */
const staleNetworkHash = pageParams.get(NETWORK_ADDRESS_PARAM) ?? FIXTURE_NETWORK_HASH;
const staleElectionId = pageParams.get(ELECTION_ADDRESS_PARAM) ?? FIXTURE_ELECTION_DB_ID;
const STALE_SEARCH = `?${NETWORK_ADDRESS_PARAM}=${staleNetworkHash}&${ELECTION_ADDRESS_PARAM}=${staleElectionId}`;

/**
 * Seed the same public surface `election-shell-gate.tsx`'s own
 * `seedFixtureSurface()` seeds — same recipe, same reason (this branch's
 * read path is `findNetwork` -> `attachNetworkDb`, and `attachNetworkDb`
 * refuses a handle with no persisted row-count record). The handle is
 * closed at the end: `ElectionShell` opens its own.
 */
async function seedStaleSurface(): Promise<void> {
	try {
		await deleteNetworkDb(FIXTURE_NETWORK_HASH);
	} catch {
		// A database that was never created is the normal first-run case.
	}
	const db = await createNetworkDb(FIXTURE_NETWORK_HASH);
	try {
		await seedPublicSurface(db);
		await writeRowCounts(FIXTURE_NETWORK_HASH, PUBLIC_SURFACE_EXPECTED_COUNTS);
		upsertNetwork({
			networkHash: FIXTURE_NETWORK_HASH,
			authorityName: 'vtx-fixture Authority',
			domain: 'vtx-fixture.invalid',
			officerUserId: 'u1',
			bootstrappedAt: SEED_NOW,
		});
	} finally {
		await closeNetworkDb(db);
	}
}

const rootElement = document.getElementById('root');
if (!rootElement) {
	throw new Error('offline-gate.tsx: #root element not found in offline-gate.html');
}

/** Re-bound with a non-nullable declared type — the guard above narrows
 * `rootElement` for top-level statements only, not inside the async
 * closures below. Same idiom `election-shell-gate.tsx` uses for the
 * identical reason. */
const gateContainer: HTMLElement = rootElement;

let renderError: string | null = null;

async function mountStale(): Promise<void> {
	try {
		await seedStaleSurface();
	} catch (err) {
		renderError = renderError ?? `stale seed failed: ${String((err as { message?: unknown })?.message ?? err)}`;
		return;
	}
	try {
		createRoot(gateContainer).render(
			<StrictMode>
				<ElectionShell search={STALE_SEARCH} at={FIXTURE_SETTLING_INSTANT} source={STALE_SOURCE} />
			</StrictMode>,
		);
	} catch (err) {
		renderError = renderError ?? String((err as { message?: unknown })?.message ?? err);
	}
}

function mountConfig(): void {
	try {
		createRoot(gateContainer).render(
			<StrictMode>
				<PublicApp />
			</StrictMode>,
		);
	} catch (err) {
		renderError = renderError ?? String((err as { message?: unknown })?.message ?? err);
	}
}

/**
 * Bounded `requestAnimationFrame` poll — NEVER a fixed sleep — on the same
 * precedent `election-shell-gate.tsx`'s `settleUntilMounted` sets.
 */
function settleUntilMounted(maxFrames: number, ready: () => boolean): Promise<void> {
	return new Promise((resolve) => {
		let frames = 0;
		function tick() {
			frames += 1;
			if (ready() || frames >= maxFrames) {
				resolve();
				return;
			}
			requestAnimationFrame(tick);
		}
		requestAnimationFrame(tick);
	});
}

function rootHasText(text: string): boolean {
	const root = document.getElementById('root');
	return root !== null && (root.textContent ?? '').includes(text);
}

/**
 * The 'stale' branch's own ready predicate. Waits for EITHER the staleness
 * badge's text (the happy path) OR the not-held title's text (the
 * discrimination rung's unseeded-election navigation) — exactly one of the
 * two can ever appear on a given navigation, and a predicate that resolved
 * during `reading` is the single most likely way this gate would report a
 * false green (per this plan's own `<action>`).
 */
function staleReady(): boolean {
	return rootHasText(COPY['public.staleness.badge']) || rootHasText(COPY['public.election.notHeld.title']);
}

/**
 * The 'config' branch's own ready predicate. Waits for whichever of the
 * three states the currently-served `config.json` produces: either fault
 * title, or (once a valid config clears the fault) the election address
 * line, which `ElectionShell` renders as soon as `configFault` resolves to
 * `null` — well before the underlying election READ itself resolves.
 */
function configReady(): boolean {
	return (
		rootHasText(COPY['public.config.missing.title']) ||
		rootHasText(COPY['public.config.malformed.title']) ||
		document.querySelector('#root .election-address code') !== null
	);
}

const mountPromise = staleMode ? mountStale() : configMode ? Promise.resolve(mountConfig()) : Promise.resolve();

mountPromise
	.then(() => {
		if (staleMode) return settleUntilMounted(900, staleReady);
		if (configMode) return settleUntilMounted(900, configReady);
		return settleUntilMounted(30, () => true);
	})
	.then(() => {
		const requestedElectionId = staleMode ? staleElectionId : pageParams.get(ELECTION_ADDRESS_PARAM);
		window.__OFFLINE_GATE__ = Object.freeze({
			harness: 'offline-gate',
			fixture: fixtureParamValue,
			error: renderError,
			injectedInstant: staleMode ? STALE_INSTANT : null,
			requestedElectionId,
		});
		window.__UI_GATE_DONE__ = true;
	});
