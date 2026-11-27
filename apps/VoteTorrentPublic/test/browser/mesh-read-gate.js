/**
 * mesh-read-gate.js — the phase's proof bar (D-19) and D-16's liveness proof,
 * in a REAL browser: mesh read with the officer-populated path absent, then
 * liveness in one page load.
 *
 * `56-11-PLAN.md`'s own framing, restated here so a reader does not have to
 * cross-reference: this page answers three questions no existing instrument
 * answers — (a) does a browser read an election THROUGH THE MESH, with the
 * officer-populated path absent; (b) does a change ORIGINATED IN ANOTHER
 * PROCESS arrive and re-render WITHOUT A RELOAD; (c) does it run against the
 * REAL `56-08` gateway, with `56-04`'s patch applied and provenance-checked.
 *
 * NO FIXTURE IMPORT ANYWHERE IN THIS FILE — a strictly stronger property
 * than `live-read-gate.js` has. Everything this page needs to know about the
 * seeded election (`electionId`, `networkHash`, `title`, `atInstant`, the two
 * keyholder counts) arrives as DATA, fetched from `/gate-expectations.json`,
 * which `run-mesh-read-gate.mjs` writes into the served root at gate runtime
 * from the origin's own stdout facts. This is what makes D-19(a)'s "the
 * officer-populated path is absent" PROVABLE rather than asserted: the only
 * path the rows in rungs 5/6 can have taken is the strand mesh.
 *
 * `network`/`election` are read from THIS PAGE'S OWN `location.search` — set
 * by the driver's one `page.goto` — never constructed internally the way
 * `live-read-gate.js` builds its own `search` string from compile-time
 * constants. This gate's network hash is chosen FRESH per run by the driver
 * (a per-run strandId), so it cannot be a compile-time constant here.
 *
 * NO `setTimeout` ANYWHERE IN THIS FILE, for the recorded reason
 * `live-read-gate.js`'s header names: after a store delete, a successful
 * `deleteDatabase` can be resurrected as an empty shell by an un-awaited
 * write from the shared connection singleton, and the recorded fix yields
 * through a `MessageChannel` round trip, never a timer —
 * `fake-indexeddb` is blind to the whole class, so only a real browser can
 * see it.
 *
 * The page renders NO VERDICT. It publishes `window.__MESH_READ_GATE__` and
 * sets `window.__MESH_READ_GATE_DONE__`; grading is `run-mesh-read-gate.mjs`'s
 * job. This plan claims no inversion — that is `56-13`'s.
 *
 * Every step element is written with `textContent` and by no other means:
 * nothing derived from the database may reach the DOM as markup. The
 * markup-writing property's NAME is deliberately not spelled anywhere in
 * this file — see `live-read-gate.js`'s header for the self-tripping-checker
 * reason this discipline exists.
 */
import '../../src/app.css';
import { createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { t } from '@votetorrent/ui-web';
import { ElectionShell } from '../../src/screens/ElectionShell';
import { parseElectionAddress } from '../../src/election-address.js';
import { loadBootstrapConfig } from '../../src/peer/config.js';
import { startPublicPeerBoot, PEER_BOOT_STATUS } from '../../src/peer/boot.js';
import { startPeerReplication } from '../../src/peer/reactivity-bridge.js';
import { createPageTailReader } from '../../src/peer/tail-reader.js';
import {
	closeNetworkDb,
	createNetworkDb,
	dbNameFor,
	deleteNetworkDb,
	openStoreHandle,
	PUBLIC_SUBSCRIBED_TABLES,
	readKeyReleaseProgress,
	readPublicElection,
	readRowCounts,
	upsertNetwork,
	writeRowCounts,
} from '@votetorrent/web-data/public';
// `openLiveNetworkDb` below mirrors `attachNetworkDb`'s own open+reconcile
// steps directly (see that helper's header) -- these three are the SAME
// primitives `@votetorrent/web-data`'s `reattach.js` builds `attachNetworkDb`
// from.
import { registerDbPlugins, initDB, isSchemaInitialized } from '@votetorrent/vote-engine/browser';

/** @type {any} */
const win = window;

/**
 * The entire rendering contract `run-mesh-read-gate.mjs` consumes: a string
 * LITERAL (never a bare binding — esbuild renames local bindings but
 * preserves string values, `project_esbuild_minifier_defeats_naive_dist_controls`),
 * compared by the driver against the value parsed out of a comment-stripped
 * read of THIS FILE's own source. A value check, not a presence check.
 * @type {string}
 */
export const MESH_READ_GATE_CONTRACT = 'mesh-read-gate-v1';

/** The founding revision every seeded election carries. NOT imported from the
 * fixture (this file imports no fixture at all) — the same local constant
 * `live-read-gate.js:123` declares for the identical reason: every
 * `seedElectionSurface` run creates its founding `ElectionRevision` with
 * `Revision = 0`. @type {number} */
const MESH_READ_REVISION = 0;

/**
 * Assigned ONCE at script evaluation. If the page ever reloaded, this module
 * would be re-evaluated and the value would change — a no-reload witness
 * that does not depend on the navigation-entry count alone.
 * @type {string}
 */
const LOAD_NONCE = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** @type {Array<{ t: string, ms: number, category: string, message: string }>} */
const LOG = [];
const t0 = performance.now();
/** @param {string} category @param {string} message */
const log = (category, message) =>
	LOG.push({ t: new Date().toISOString(), ms: +(performance.now() - t0).toFixed(1), category, message });

const stepsEl = document.getElementById('steps');
const rootEl = document.getElementById('root');

/** @type {Array<{ id: number, name: string, ok: boolean, detail: string }>} */
const rungs = [];

/**
 * Run one rung. A failure is a NAMED red rung with a detail line, never a
 * thrown stack that ends the run.
 * @template T
 * @param {number} id
 * @param {string} name
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ ok: boolean, value?: T }>}
 */
async function rung(id, name, fn) {
	const el = document.createElement('div');
	el.className = 'step pending';
	el.textContent = `${id} · ${name}`;
	stepsEl?.appendChild(el);
	const started = performance.now();
	try {
		const value = await fn();
		const detail = typeof value === 'string' ? value : '';
		el.className = 'step ok';
		el.textContent = `[ok] ${id} · ${name} ${detail} (${(performance.now() - started).toFixed(0)}ms)`;
		rungs.push({ id, name, ok: true, detail });
		log('pass', `${id} · ${name} ${detail}`);
		return { ok: true, value };
	} catch (err) {
		const detail = String(/** @type {any} */ (err)?.message ?? err).slice(0, 500);
		el.className = 'step fail';
		el.textContent = `[fail] ${id} · ${name} ${detail} (${(performance.now() - started).toFixed(0)}ms)`;
		rungs.push({ id, name, ok: false, detail });
		log('fail', `${id} · ${name} ${detail}`);
		return { ok: false };
	}
}

/**
 * One yield through a `MessageChannel` round trip — never a timer. See this
 * file's header.
 * @returns {Promise<void>}
 */
function yieldThroughMessageChannel() {
	return new Promise((resolve) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = () => {
			channel.port1.close();
			channel.port2.close();
			resolve(undefined);
		};
		channel.port2.postMessage(0);
	});
}

/**
 * One tick of the render clock: whichever of a frame or a task arrives
 * first. Not a timer.
 * @returns {Promise<void>}
 */
function nextTick() {
	return Promise.race([
		new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))),
		yieldThroughMessageChannel(),
	]);
}

/**
 * Minimum wall-clock gap between two evaluations of a `pollUntil` predicate,
 * in milliseconds. Read the clock, never a timer — this file registers no
 * `setTimeout` (see the header).
 *
 * WHY THIS EXISTS — measured, not defensive. `nextTick()` below resolves on
 * whichever of a frame or a `MessageChannel` hop arrives first, and the hop
 * always wins, so an unthrottled `pollUntil` re-ran its predicate roughly
 * 6,400 times a SECOND. Rung 5's predicate is a full Quereus `select` over
 * IndexedDB, so a rung that is genuinely failing — as rung 5 does the moment
 * rung 4's peer boot fails — drove ~300,000 IndexedDB-backed SQL reads through
 * the renderer in 47 seconds and killed the renderer process outright
 * ("Target crashed"), before its own 60,000ms budget expired. Measured on
 * 2026-09-05: `performance.memory.usedJSHeapSize` stayed FLAT at 51.0MB
 * throughout, so this was never a JS-heap leak — it is renderer-side
 * exhaustion driven purely by IndexedDB request volume.
 *
 * That crash destroyed the instrument: Playwright reported only "Target
 * crashed", `page.on('pageerror')` never fired, and the gate's real red rungs
 * — including rung 4's actual named error — were never published at all. A
 * gate that dies instead of reporting a named red rung measures nothing.
 *
 * THIS IS NOT A LOOSENED RUNG. Every rung keeps its exact predicate and its
 * exact wall-clock budget; only the RATE at which the predicate is re-asked
 * changes, from ~6,400/s to at most ~62/s. A rung that would have passed still
 * passes (rung 5 passes on a healthy run in ~50ms — far more than one poll),
 * and a rung that would have failed still fails, now with its named detail
 * line intact instead of a dead renderer.
 * @type {number}
 */
const POLL_MIN_INTERVAL_MS = 16;

/**
 * Poll `predicate` until it holds or the wall-clock budget expires.
 *
 * The predicate is evaluated at most once per {@link POLL_MIN_INTERVAL_MS} of
 * real elapsed time. `nextTick()`'s own semantics are deliberately UNCHANGED —
 * it keeps its frame-or-hop race, so this loop still always makes progress
 * even in a document that never paints. What is bounded here is how often the
 * predicate itself (an IndexedDB-backed SQL read, in rungs 5 and 10) is asked.
 * @param {() => (boolean | Promise<boolean>)} predicate
 * @param {number} budgetMs
 * @param {() => string} describe
 * @returns {Promise<number>} elapsed milliseconds
 */
async function pollUntil(predicate, budgetMs, describe) {
	const started = performance.now();
	let ticks = 0;
	let checks = 0;
	let lastCheck = Number.NEGATIVE_INFINITY;
	while (performance.now() - started < budgetMs) {
		const now = performance.now();
		if (now - lastCheck >= POLL_MIN_INTERVAL_MS) {
			lastCheck = now;
			checks += 1;
			// eslint-disable-next-line no-await-in-loop
			if (await predicate()) return +(performance.now() - started).toFixed(0);
		}
		// eslint-disable-next-line no-await-in-loop
		await nextTick();
		ticks += 1;
	}
	throw new Error(`${describe()} (budget ${budgetMs}ms, ${ticks} ticks, ${checks} checks)`);
}

/** @returns {string} the page's rendered text, whitespace-collapsed. */
function rootText() {
	return (rootEl?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** @returns {number} */
function navigationCount() {
	return performance.getEntriesByType('navigation').length;
}

/**
 * Open a live, query-ready handle over an ALREADY-bootstrapped network,
 * WITHOUT `attachNetworkDb`'s contract-C5 row-count integrity check. That
 * check exists for the dashboard's admin-verified-snapshot use case; this
 * gate's whole point is that this browser's counts legitimately change out
 * from under it via peer replication mid-run, so re-attaching through
 * `attachNetworkDb` (no options) here would need to retry per divergent
 * table -- `assertRowCounts` throws on the FIRST mismatch it finds, and a
 * full re-attach is a real Database open + DDL reconcile, expensive to
 * repeat. This mirrors `attachNetworkDb`'s own open+reconcile steps directly
 * (the same `openStoreHandle`/`registerDbPlugins`/`initDB` primitives it is
 * built from) and stops there -- read-only, one open, no count assertion.
 * @param {string} networkHash
 * @returns {Promise<any>}
 */
async function openLiveNetworkDb(networkHash) {
	const db = await openStoreHandle(networkHash);
	try {
		await registerDbPlugins(db);
		if (!db.declaredSchemaManager.hasDeclaredSchema('main')) {
			await initDB(db);
		}
		const initialized = await isSchemaInitialized(db);
		if (!initialized) {
			throw new Error(`openLiveNetworkDb: network "${networkHash}" has no schema-init marker -- createNetworkDb must run first`);
		}
		return db;
	} catch (err) {
		await closeNetworkDb(db);
		throw err;
	}
}

const address = parseElectionAddress(location.search);
const MESH_READ_NETWORK_HASH = address.networkHash ?? '';
const MESH_READ_ELECTION_ID = address.electionId ?? '';

/**
 * MESH_READ_DIAG (diagnostic, opt-in; the driver adds `diag=1` when its own MESH_READ_DIAG=1). Wraps the
 * replication's `readRows` so each pass logs how many rows each table returned -- table names and counts
 * only, never a row value -- and when it ran. Off by default: rung 4 then boots the production composition
 * untouched.
 */
const MESH_READ_DIAG = new URLSearchParams(globalThis.location?.search ?? '').get('diag') === '1';
const DIAG_T0 = Date.now();

/** @returns {Record<string, unknown> | undefined} */
function diagBootDeps() {
	if (!MESH_READ_DIAG) return undefined;
	return {
		createPageTailReader: (/** @type {any} */ node, /** @type {string} */ networkName) => {
			const reader = createPageTailReader(node, networkName);
			return {
				readTails: async (/** @type {any[]} */ queries, /** @type {any} */ opts) => {
					const started = Date.now();
					const answers = await reader.readTails(queries, opts);
					const summary = queries
						.map((q) => {
							const a = /** @type {any} */ (answers.get(q.collectionId));
							const table = String(q.collectionId).split('/').pop();
							return `${table}=${a === undefined ? 'none' : 'error' in a ? `err:${a.error?.name ?? 'Error'}` : a.tail === undefined ? 'empty' : `r${a.tail.revision}`}`;
						})
						.join(' ');
					console.log(`[gate-diag] +${started - DIAG_T0}ms readTails${opts?.skipWindowConsult ? ' (held only)' : ''} took ${Date.now() - started}ms: ${summary}`);
					if (opts?.skipWindowConsult) {
						// Comparison only: the same queries as an ordinary (consulting) read. Its answers are logged, never returned.
						const fullStarted = Date.now();
						const full = await reader.readTails(queries).catch((/** @type {any} */ err) => err);
						const fullSummary = full instanceof Map
							? queries.map((q) => {
								const a = /** @type {any} */ (full.get(q.collectionId));
								const table = String(q.collectionId).split('/').pop();
								return `${table}=${a === undefined ? 'none' : 'error' in a ? `err:${a.error?.name ?? 'Error'}` : a.tail === undefined ? 'empty' : `r${a.tail.revision}`}`;
							}).join(' ')
							: `threw ${full?.name ?? 'Error'}`;
						console.log(`[gate-diag] +${fullStarted - DIAG_T0}ms readTails (consulting, comparison) took ${Date.now() - fullStarted}ms: ${fullSummary}`);
					}
					return answers;
				},
			};
		},
		startPeerReplication: (/** @type {any} */ options) => {
			console.log(`[gate-diag] +${Date.now() - DIAG_T0}ms replication starts: ${options.collections.length} collections`);
			return startPeerReplication({
				...options,
				readRows: async () => {
					const started = Date.now();
					try {
						const batches = await options.readRows();
						const counts = (batches ?? []).map((/** @type {any} */ b) => `${b.table}=${b.ops?.length ?? 0}`).join(' ');
						console.log(`[gate-diag] +${started - DIAG_T0}ms readRows took ${Date.now() - started}ms: ${counts}`);
						return batches;
					} catch (/** @type {any} */ err) {
						console.log(`[gate-diag] +${started - DIAG_T0}ms readRows threw ${err?.name ?? 'Error'}`);
						throw err;
					}
				},
			});
		},
	};
}

/** @type {{ beforeText: string, afterText: string, navBefore: number, navAfter: number, nonceBefore: string, nonceAfter: string, peerId: string }} */
const observed = {
	beforeText: '',
	afterText: '',
	navBefore: -1,
	navAfter: -1,
	nonceBefore: '',
	nonceAfter: '',
	peerId: '',
};

/** @type {any} */
let expectations = null;

async function main() {
	log('start', `mesh-read-gate nonce=${LOAD_NONCE} network=${MESH_READ_NETWORK_HASH} election=${MESH_READ_ELECTION_ID}`);

	if (address.status !== 'ok') {
		throw new Error(`this page requires a fully-addressed URL; parseElectionAddress reported status "${address.status}"`);
	}

	// -- 1 -------------------------------------------------------------------
	await rung(1, 'clean slate — delete any prior store for this run’s network, and fetch the origin’s facts', async () => {
		try {
			await deleteNetworkDb(MESH_READ_NETWORK_HASH);
		} catch (err) {
			if (/** @type {any} */ (err)?.name === 'DeleteBlockedError') throw err;
		}
		await yieldThroughMessageChannel();

		const response = await fetch('/gate-expectations.json', { credentials: 'omit', cache: 'no-store' });
		if (!response.ok) throw new Error(`/gate-expectations.json fetch failed (status ${response.status})`);
		expectations = await response.json();
		if (typeof expectations?.title !== 'string' || expectations.title.length < 20) {
			// A short fixture is the defect project_ui_defects_invisible_to_every_tier
			// records; a gate that would pass on a short title is measuring nothing.
			throw new Error(`vacuous: fetched election title is shorter than 20 characters ("${expectations?.title}")`);
		}
		if (expectations.electionId !== MESH_READ_ELECTION_ID || expectations.networkHash !== MESH_READ_NETWORK_HASH) {
			throw new Error('gate-expectations.json does not name the same election/network this page was addressed with');
		}
		return `deleted; expectations fetched for "${expectations.title}"`;
	});

	// -- 2 -------------------------------------------------------------------
	await rung(2, 'the officer-populated path is ABSENT — bootstrap an empty schema and prove it holds no row', async () => {
		const probe = await createNetworkDb(MESH_READ_NETWORK_HASH);
		try {
			const counts = await readRowCounts(probe, [...PUBLIC_SUBSCRIBED_TABLES]);
			for (const table of PUBLIC_SUBSCRIBED_TABLES) {
				if (counts[table] !== 0) throw new Error(`table "${table}" already holds ${counts[table]} rows before any peer machinery started`);
			}
			await writeRowCounts(MESH_READ_NETWORK_HASH, counts);
			// The I-15 security gate (`public-election-source.js` header point 3):
			// registry membership, never the URL, is what authorises a store name.
			// Gate-owned setup performs this registration the same way a real prior
			// legitimate bootstrap would — production code never does this on this
			// browser's behalf (see `boot.js`'s own header).
			upsertNetwork({
				networkHash: MESH_READ_NETWORK_HASH,
				authorityName: 'mesh-read gate Authority',
				domain: 'mesh-read-gate.invalid',
				officerUserId: 'u1',
				bootstrappedAt: '2026-01-01T00:00:00',
			});
			const row = await readPublicElection(probe, MESH_READ_ELECTION_ID);
			if (row !== null) throw new Error('the addressed election already has a row before any replication ran');
			return `confirmed empty on ${dbNameFor(MESH_READ_NETWORK_HASH)}; registered and bootstrapped`;
		} finally {
			await closeNetworkDb(probe);
		}
	});

	// -- 3 -------------------------------------------------------------------
	await rung(3, 'bootstrap config resolves from this origin', async () => {
		const result = await loadBootstrapConfig({ fetchImpl: /** @type {any} */ (window.fetch.bind(window)), pageProtocol: location.protocol });
		if (!result.ok) throw new Error(`loadBootstrapConfig did not resolve: fault "${result.fault}"`);
		if (!Array.isArray(result.bootstrapNodes) || result.bootstrapNodes.length === 0) {
			throw new Error('loadBootstrapConfig resolved ok but with no bootstrap addresses');
		}
		for (const entry of result.bootstrapNodes) {
			if (!entry.includes('/tls/ws')) throw new Error(`bootstrap entry "${entry}" does not carry /tls/ws`);
			if (!entry.includes('/p2p/')) throw new Error(`bootstrap entry "${entry}" does not carry a /p2p/ component`);
		}
		return `${result.bootstrapNodes.length} address(es), each carrying /tls/ws and /p2p/`;
	});

	// -- 4 -------------------------------------------------------------------
	/** @type {any} */
	let boot = null;
	await rung(4, 'the Edge node connects to the gateway — the SAME composition production uses', async () => {
		boot = await startPublicPeerBoot({ networkHash: MESH_READ_NETWORK_HASH, electionId: MESH_READ_ELECTION_ID, deps: diagBootDeps() });
		if (boot.status !== PEER_BOOT_STATUS.STARTED) {
			throw new Error(`startPublicPeerBoot did not start: status "${boot.status}"${boot.subject ? ` (subject "${boot.subject}")` : ''}`);
		}
		if (typeof boot.peerId !== 'string' || boot.peerId.length === 0) {
			throw new Error('startPublicPeerBoot started but reported no peerId');
		}
		observed.peerId = boot.peerId;
		return `STARTED; peerId=${boot.peerId}; dbName=${boot.dbName}`;
	});

	// -- 5 -------------------------------------------------------------------
	// This probe handle is opened, polled and CLOSED entirely within this
	// rung -- never held open into rung 6+. Real Chromium IndexedDB, unlike
	// this app's node-tier fake, appears to fault when THREE OR MORE
	// long-lived Database connections against the same underlying store are
	// open at once during a DDL reconcile (boot.js's own replication handle,
	// this rung's own probe, and the mounted screen's own use-public-election
	// handle would otherwise all be simultaneously live) -- closing this one
	// before rung 6 mounts keeps this gate at the same two-concurrent-handle
	// shape `live-read-gate.js` already proved safe.
	await rung(5, 'rows crossed the mesh — a replicated batch applied and a row this run proved absent now reads back', async () => {
		const probe = await openLiveNetworkDb(MESH_READ_NETWORK_HASH);
		try {
			const ms = await pollUntil(
				async () => (await readPublicElection(probe, MESH_READ_ELECTION_ID)) !== null,
				60_000,
				() => 'no replicated row ever landed for the addressed election',
			);
			return `landed after ${ms}ms`;
		} finally {
			await closeNetworkDb(probe);
		}
	});

	// -- 6 -------------------------------------------------------------------
	// Mounted AFTER rung 5, deliberately: if the screen mounted first it would
	// render `notHeld` and then flip on the bridge's own notify, which would
	// make this rung depend on the notify call and destroy 56-13's ability to
	// isolate the D-16 inversion to the liveness rungs (9, 10). Production
	// starts the boot and the render together; this ordering is the gate's own.
	const sentenceBefore = t('public.fact.keyrelease.sentence', { released: 0, total: 0 });
	const sentenceAfter = t('public.fact.keyrelease.sentence', { released: 0, total: 1 });
	await rung(6, 'the page renders an election this browser never held — mounted with only search and at', async () => {
		if (!rootEl) throw new Error('#root is missing from mesh-read-gate.html');
		createRoot(rootEl).render(
			createElement(StrictMode, null, createElement(ElectionShell, { search: location.search, at: expectations.atInstant })),
		);
		const ms = await pollUntil(
			() => rootText().includes(expectations.title) && rootText().includes(sentenceBefore),
			30_000,
			() => `the page never rendered the seeded title and the pre-mutation sentence "${sentenceBefore}"; it shows: ${rootText().slice(0, 300)}`,
		);
		return `first paint with mesh content after ${ms}ms`;
	});

	// -- 7 -------------------------------------------------------------------
	await rung(7, 'the design tokens actually resolved', async () => {
		const style = getComputedStyle(document.documentElement);
		const tokenNames = ['--text', '--bg', '--space-sm'];
		/** @type {Record<string, string>} */
		const values = {};
		for (const name of tokenNames) {
			const value = style.getPropertyValue(name).trim();
			if (!value) throw new Error(`design token "${name}" did not resolve to a non-empty value`);
			values[name] = value;
		}
		if (values['--text'] === values['--bg']) {
			throw new Error('--text and --bg resolved to the SAME value — the token layer is probably not loaded');
		}
		return Object.entries(values)
			.map(([k, v]) => `${k}=${v}`)
			.join(' ');
	});

	// -- 8 -------------------------------------------------------------------
	await rung(8, 'handshake — publish readiness and wait for the driver’s mutate signal', async () => {
		observed.beforeText = rootText();
		observed.navBefore = navigationCount();
		observed.nonceBefore = LOAD_NONCE;
		if (!observed.beforeText.includes(sentenceBefore)) {
			throw new Error(`before-text does not contain the pre-mutation sentence "${sentenceBefore}"`);
		}
		if (observed.beforeText.includes(sentenceAfter)) {
			throw new Error('the pre-mutation text ALREADY contains the post-mutation sentence — rungs 9/10 could not discriminate');
		}
		win.__MESH_READ_GATE_READY__ = true;
		const ms = await pollUntil(
			() => win.__MESH_READ_GATE_MUTATED__ === true,
			60_000,
			() => 'the driver never set __MESH_READ_GATE_MUTATED__',
		);
		return `ready published; mutate signal received after ${ms}ms`;
	});

	// -- 9 -------------------------------------------------------------------
	await rung(9, 'LIVENESS — a change originated in another process re-rendered the page in ONE page load', async () => {
		const ms = await pollUntil(
			() => rootText().includes(sentenceAfter),
			30_000,
			() =>
				`the page never rendered the post-mutation sentence "${sentenceAfter}" — it still shows "${
					rootText().includes(sentenceBefore) ? sentenceBefore : rootText().slice(0, 200)
				}"`,
		);
		observed.afterText = rootText();
		observed.navAfter = navigationCount();
		observed.nonceAfter = LOAD_NONCE;

		// Three assertions, separately, so a failure says which one broke.
		if (observed.afterText === observed.beforeText) throw new Error('the rendered text did not change at all');
		if (observed.navAfter !== observed.navBefore) {
			throw new Error(`the page navigated: navigation entries ${observed.navBefore} -> ${observed.navAfter}`);
		}
		if (observed.nonceAfter !== observed.nonceBefore) {
			throw new Error(`the page RELOADED: load nonce ${observed.nonceBefore} -> ${observed.nonceAfter}`);
		}
		return `updated after ${ms}ms; nav unchanged at ${observed.navAfter}; same load`;
	});

	// -- 10 ------------------------------------------------------------------
	await rung(10, 'LIVENESS — screen and store agree, through a handle the page never handed anyone', async () => {
		const dbFresh = await openLiveNetworkDb(MESH_READ_NETWORK_HASH);
		try {
			const fresh = await readKeyReleaseProgress(dbFresh, MESH_READ_ELECTION_ID, MESH_READ_REVISION);
			const onScreen = t('public.fact.keyrelease.sentence', { released: fresh.released, total: fresh.keyholderCount });
			if (!rootText().includes(onScreen)) {
				throw new Error(`the store holds "${onScreen}" but the page does not show it — the render is STALE relative to the store`);
			}
			return `store and screen agree: ${onScreen}`;
		} finally {
			await closeNetworkDb(dbFresh);
		}
	});

	// Teardown — releases only what this gate opened. Rung 5's and rung 10's
	// own probe handles are already closed inside their own rungs (see
	// rung 5's comment on why).
	if (boot !== null) {
		try {
			await boot.stop();
		} catch {
			// Same.
		}
	}

	finish();
}

function finish() {
	const passed = rungs.filter((r) => r.ok).length;
	win.__MESH_READ_GATE__ = Object.freeze({
		contract: MESH_READ_GATE_CONTRACT,
		rungs: rungs.map((r) => Object.freeze({ ...r })),
		passed,
		total: rungs.length,
		beforeText: observed.beforeText,
		afterText: observed.afterText,
		navBefore: observed.navBefore,
		navAfter: observed.navAfter,
		loadNonce: LOAD_NONCE,
		peerId: observed.peerId,
		expectations,
		log: LOG,
	});
	win.__MESH_READ_GATE_DONE__ = true;
	console.log(`[mesh-read-gate] ${passed}/${rungs.length} rungs passed`);
}

main().catch((err) => {
	log('crash', String(/** @type {any} */ (err)?.stack ?? err));
	win.__MESH_READ_GATE__ = Object.freeze({
		contract: MESH_READ_GATE_CONTRACT,
		crashed: String(/** @type {any} */ (err)?.stack ?? err),
		rungs: rungs.map((r) => Object.freeze({ ...r })),
		passed: rungs.filter((r) => r.ok).length,
		total: rungs.length,
		log: LOG,
	});
	win.__MESH_READ_GATE_DONE__ = true;
	console.error('[mesh-read-gate] crashed', err);
});
