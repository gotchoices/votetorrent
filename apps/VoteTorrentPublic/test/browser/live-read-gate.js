/**
 * live-read-gate.js — D-27's browser gate: a page already mounted against a
 * browser-local database is proven to RE-RENDER when a write lands in that
 * database through a SECOND handle, in ONE page load, with no reload and no
 * navigation.
 *
 * `54-PATTERNS.md` § No Analog Found lists this harness as one of only two
 * files in the phase with no analog anywhere in the repo. Its rung/settle
 * readout convention is borrowed from
 * `apps/VoteTorrentDashboard/test/browser/db-gate.js`; the two-handle idea is
 * this file's own.
 *
 * THREE THINGS TO READ BEFORE QUOTING A GREEN RUN
 * ---------------------------------------------------------------------------
 *
 * 1. IT PROVES THE SEAM, NOT THE SYNC. A green run says the page re-renders
 *    when a SAME-ORIGIN write lands. It says nothing about replication: there
 *    is no `libp2p`, no `@serfab` and no `db-p2p` anywhere in the web tree
 *    (verified), the browser store is filled by a one-time bootstrap
 *    redemption, and real replication is gated on P2P-11 and belongs to a
 *    later phase. What a green run DOES buy is that when sync arrives, the
 *    page is already correct with no UI rework — which is D-27's whole claim.
 *
 * 2. BOTH HANDLES ARE IN ONE ORIGIN BECAUSE INDEXEDDB IS ORIGIN-PARTITIONED.
 *    That is not a shortcut, it is the only shape that exists today.
 *    `54-ISSUES.md` I-01 leaves the production topology — whether the two web
 *    apps share one origin — an open question, and 54-17 carries it to the
 *    user. This gate seeds same-origin by construction and settles nothing
 *    about that question.
 *
 * 3. THE WRITE IS READ BACK THROUGH AN AGGREGATE, ON PURPOSE. A remote notice
 *    cannot invalidate the receiving handle's point-lookup read cache — the
 *    store provider is unreachable through any public API, so there is nothing
 *    to invalidate it with (see `subscribe.js`'s header, point 5). The bound
 *    is that the cached store always delegates iteration and approximate-count
 *    to the underlying store, so scans and aggregates are unaffected. The fact
 *    this gate watches is a `count(*)`, which is inside that bound. A gate
 *    that watched a primary-key point lookup would be measuring the caveat
 *    rather than the seam.
 *
 * NO `setTimeout` ANYWHERE IN THIS FILE. Two reasons, both recorded rather
 * than stylistic. After `deleteNetworkDb`, a successful `deleteDatabase` can be
 * resurrected as an empty shell by an un-awaited write from the shared
 * connection singleton, and the recorded fix yields through a `MessageChannel`
 * round trip, never a timer — `fake-indexeddb` is blind to the whole class, so
 * only a real browser can see it. And every wait for a render is a bounded
 * poll driven by `requestAnimationFrame` raced against a `MessageChannel` tick,
 * so a frame budget expiring is a NAMED red rung rather than a sleep that was
 * too short on a slow machine.
 *
 * The page renders NO VERDICT. It publishes `window.__LIVE_READ_GATE__` and
 * sets `window.__LIVE_READ_GATE_DONE__`; grading is `run-live-read-gate.mjs`'s
 * job, exactly as `db-gate.js` leaves grading to `run-headless.mjs`. A harness
 * that graded itself would be a rung nobody else could invert.
 *
 * `?control=nolisten` is the INVERSION: it skips the writer's
 * `enableChangePropagation` call and nothing else. Under it, rungs 8 and 9 must
 * FAIL — that is what `--prove-frozen` requires, and without it "the page
 * updated" passes vacuously.
 *
 * Every step element is written with `textContent` and by no other means:
 * nothing derived from the database may reach the DOM as markup. The
 * markup-writing property's NAME is deliberately not spelled anywhere in this
 * file — the shape check that forbids it scans this file's RAW bytes, comments
 * included, so a comment merely mentioning it would make that check
 * permanently red. Its mirror image (a checker whose own prose SATISFIES the
 * pattern it hunts, and is therefore permanently green) has been manufactured
 * nine times in this phase; this is the tenth, caught here.
 */
import '../../src/app.css';
import { createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { t } from '@votetorrent/ui-web';
import { ElectionShell } from '../../src/screens/ElectionShell';
import {
	ELECTION_ADDRESS_PARAM,
	NETWORK_ADDRESS_PARAM,
	parseElectionAddress,
} from '../../src/election-address.js';
import {
	attachNetworkDb,
	closeNetworkDb,
	createNetworkDb,
	dbNameFor,
	deleteNetworkDb,
	enableChangePropagation,
	readKeyReleaseProgress,
	readRowCounts,
	upsertNetwork,
	writeRowCounts,
} from '@votetorrent/web-data/public';
// The dashboard's founding seed and the shared election-surface seed. BOTH ARE
// DEPENDENCY-FREE — they import nothing but each other and take an already-open
// handle as a parameter — which is what makes them importable from this app's
// test tree without dragging any officer read surface along with them.
//
// Reusing them here is RIGHT rather than a smell: D-01's premise is literally
// that the dashboard bootstrapped this origin's IndexedDB and the public page
// reads what it left behind. Seeding through the officer-side fixture is that
// premise made executable.
import { seedFoundingAuthority } from '../../../../packages/web-data/test/fixtures/seed-founding-authority.js';
// 62-02 (D-26): a Keyholder row now needs a signed KeyholderDkgBinding in the
// same transaction. Prerequisites (InviteSlot/InviteResult/UserKey for 'u1')
// are seeded once at rung 2; rung 7's single observed mutation stays exactly
// one new Keyholder row (plus its now-mandatory binding, which this gate's
// subject assertions never read).
import { seedKeyholderPrerequisites, insertBoundKeyholder } from '../fixtures/seed-bound-keyholder.js';
import {
	SEED_ELECTION,
	SEED_EXPECTED_COUNTS,
	SEED_NOW,
	SEED_PHASE_INSTANTS,
	seedElectionSurface,
} from '../../../../packages/web-data/test/fixtures/seed-election-surface.js';

/** @type {any} */
const win = window;

/**
 * This gate's own network, DISTINCT from the dashboard gate's
 * `GATE_NETWORK_HASH` and from the shell gate's fixture hash: three harnesses
 * sharing one origin must never share a store name, or one run's teardown
 * silently deletes another run's fixture.
 * @type {string}
 */
const LIVE_GATE_NETWORK_HASH = 'vtx-live-read-network-0001';

/** The seeded election's founding revision. @type {number} */
const SEED_REVISION = 0;

/**
 * The phase whose fact set contains the key-release card. Chosen from the
 * fixture's own per-phase instants rather than written as a literal, so a
 * timeline change moves this with it.
 *
 * DELIBERATELY NOT `SEED_NOW`: that instant lands in the pre-election phase,
 * whose fact set carries no key-release card at all, so the number this gate
 * watches would never render and rung 5 would fail naming a missing sentence.
 * @type {string}
 */
const LIVE_GATE_INSTANT = SEED_PHASE_INSTANTS.settling;

/** The rendered sentence before the write, and after it. Built through `t()`
 * from the shipped copy table, never hand-typed English — a copy edit then
 * moves this gate with it instead of turning it red for the wrong reason. */
const SENTENCE_BEFORE = t('public.fact.keyrelease.sentence', { released: 0, total: 0 });
const SENTENCE_AFTER = t('public.fact.keyrelease.sentence', { released: 0, total: 1 });

/**
 * Assigned ONCE at script evaluation. If the page ever reloaded, this module
 * would be re-evaluated and the value would change — which is exactly what
 * makes it a no-reload witness that does not depend on the navigation-entry
 * count alone.
 * @type {string}
 */
const LOAD_NONCE = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const params = new URLSearchParams(location.search);
/** The only recognised control value. @type {string | null} */
const CONTROL = params.get('control') === 'nolisten' ? 'nolisten' : null;

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
 * thrown stack that ends the run — the driver must be able to see which of the
 * nine broke, and `--prove-frozen` depends on two specific ones failing while
 * the other seven still pass.
 *
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
 * One yield through a `MessageChannel` round trip. NOT a timer: the recorded
 * IndexedDB-resurrection fix yields through exactly this mechanism, because a
 * `setTimeout` lands in a later task than the pending store write and the
 * deleted database comes back as an empty shell. Both ports are closed, so the
 * yield leaves no live handle behind.
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
 * One tick of the render clock: whichever of a frame or a task arrives first.
 * `requestAnimationFrame` alone can be throttled to a standstill in a headless
 * browser, and a poll that stalls is indistinguishable from a page that never
 * updated — so the frame is RACED against a `MessageChannel` tick, which is
 * still not a timer.
 * @returns {Promise<void>}
 */
function nextTick() {
	return Promise.race([
		new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))),
		yieldThroughMessageChannel(),
	]);
}

/**
 * Poll `predicate` until it holds or the wall-clock budget expires. Throws with
 * `describe()`'s text on expiry, so the rung names WHAT it was waiting for
 * rather than reporting a bare timeout.
 *
 * @param {() => boolean} predicate
 * @param {number} budgetMs
 * @param {() => string} describe
 * @returns {Promise<number>} elapsed milliseconds
 */
async function pollUntil(predicate, budgetMs, describe) {
	const started = performance.now();
	let ticks = 0;
	while (performance.now() - started < budgetMs) {
		if (predicate()) return +(performance.now() - started).toFixed(0);
		// eslint-disable-next-line no-await-in-loop
		await nextTick();
		ticks += 1;
	}
	throw new Error(`${describe()} (budget ${budgetMs}ms, ${ticks} ticks)`);
}

/** @returns {string} the page's rendered text, whitespace-collapsed. */
function rootText() {
	return (rootEl?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** @returns {number} */
function navigationCount() {
	return performance.getEntriesByType('navigation').length;
}

/** @type {{ beforeText: string, afterText: string, navBefore: number, navAfter: number, nonceBefore: string, nonceAfter: string }} */
const observed = {
	beforeText: '',
	afterText: '',
	navBefore: -1,
	navAfter: -1,
	nonceBefore: '',
	nonceAfter: '',
};

async function main() {
	log('start', `live-read-gate control=${CONTROL ?? 'none'} nonce=${LOAD_NONCE}`);

	// -- 1 -------------------------------------------------------------------
	await rung(1, 'clean slate — delete any prior store for this gate network', async () => {
		try {
			await deleteNetworkDb(LIVE_GATE_NETWORK_HASH);
		} catch (err) {
			// A store that was never created is the normal first-run case; a
			// genuinely blocked delete raises DeleteBlockedError and IS a
			// failure, so it is re-thrown by name rather than swallowed.
			if (/** @type {any} */ (err)?.name === 'DeleteBlockedError') throw err;
		}
		await yieldThroughMessageChannel();
		return 'deleted and yielded through a MessageChannel';
	});

	// -- 2 -------------------------------------------------------------------
	// HANDLE B, the writer. It is assigned INSIDE the rung and kept open for the
	// rest of the run: the whole claim depends on the page's own handle and this
	// one being two live connections to one store, not one handle used twice.
	/** @type {any} */
	let dbB = null;
	/** @type {{ userId: string, inviteSlotCid: string, signerPublicKey: string } | null} */
	let u1Prereq = null;
	await rung(2, 'seed the election surface through handle B, and record its two preconditions', async () => {
		const db = await createNetworkDb(LIVE_GATE_NETWORK_HASH);
		dbB = db;
		await seedFoundingAuthority(db);
		await seedElectionSurface(db);
		// 62-02 (D-26): prerequisites for rung 7's signed keyholder write — 'u1'
		// (the founding officer) gets an InviteSlot/InviteResult/UserKey here so
		// the later Keyholder+binding pair is the ONLY new row rung 7 observes.
		u1Prereq = await seedKeyholderPrerequisites(db, {
			electionId: SEED_ELECTION.id,
			userId: 'u1',
			userName: 'live-read gate Officer',
			now: SEED_NOW,
		});
		const counts = await readRowCounts(db, Object.keys(SEED_EXPECTED_COUNTS));
		for (const [table, expected] of Object.entries(SEED_EXPECTED_COUNTS)) {
			if (counts[table] !== expected) {
				throw new Error(`seed row count mismatch: ${table} expected ${expected}, got ${counts[table]}`);
			}
		}
		// The two preconditions the page's own read path checks BEFORE it opens
		// anything: the re-attach row-count record, and the networks-registry
		// entry — the I-15 security gate that authorises a store name at all,
		// which runs before any database call precisely so a URL cannot name a
		// store this browser was never bootstrapped into. Both are written
		// through the data package's own exported helpers, never by poking a
		// storage key.
		await writeRowCounts(LIVE_GATE_NETWORK_HASH, counts);
		upsertNetwork({
			networkHash: LIVE_GATE_NETWORK_HASH,
			authorityName: 'live-read gate Authority',
			domain: 'live-read-gate.invalid',
			officerUserId: 'u1',
			bootstrappedAt: SEED_NOW,
		});
		return `seeded; handle B open on ${dbNameFor(LIVE_GATE_NETWORK_HASH)}`;
	});

	// -- 3 -------------------------------------------------------------------
	const search = `?${NETWORK_ADDRESS_PARAM}=${LIVE_GATE_NETWORK_HASH}&${ELECTION_ADDRESS_PARAM}=${SEED_ELECTION.id}`;
	await rung(3, 'the address this gate builds is the address 54-11 parses — checked BEFORE anything renders', async () => {
		const parsed = parseElectionAddress(search);
		if (parsed.status !== 'ok') throw new Error(`address status is "${parsed.status}", expected "ok" — the parameter names have drifted`);
		if (parsed.networkHash !== LIVE_GATE_NETWORK_HASH) throw new Error(`parsed network "${parsed.networkHash}" is not this gate's`);
		if (parsed.electionId !== SEED_ELECTION.id) throw new Error(`parsed election "${parsed.electionId}" is not the seeded one`);
		return 'ok, both parameters resolve';
	});

	// -- 4 -------------------------------------------------------------------
	await rung(4, 'mount the real screen with NO election prop, so it attaches its own handle', async () => {
		if (!rootEl) throw new Error('#root is missing from live-read-gate.html');
		// StrictMode because production mounts under StrictMode. In a production
		// React build it does not double-invoke effects, so this is fidelity
		// rather than a second code path.
		createRoot(rootEl).render(
			createElement(StrictMode, null, createElement(ElectionShell, { search, at: LIVE_GATE_INSTANT })),
		);
		const ms = await pollUntil(() => rootText().length > 0, 10_000, () => 'the page never painted any text at all');
		return `first paint after ${ms}ms`;
	});

	// -- 5 -------------------------------------------------------------------
	await rung(5, 'the page read through a handle the gate never handed it, over the same store name', async () => {
		const ms = await pollUntil(
			() => rootText().includes(SEED_ELECTION.title) && rootText().includes(SENTENCE_BEFORE),
			30_000,
			() => `the page never rendered the seeded title and the pre-write sentence "${SENTENCE_BEFORE}"; it shows: ${rootText().slice(0, 300)}`,
		);
		// The screen was given only `search` and `at`. The seeded title and the
		// aggregate sentence are BOTH on screen, so the read happened — through
		// a handle this gate never created, never passed and cannot reference,
		// against the same store name handle B holds open.
		observed.beforeText = rootText();
		observed.navBefore = navigationCount();
		observed.nonceBefore = LOAD_NONCE;
		if (dbB === null) throw new Error('handle B was not retained — rung 2 did not complete');
		return `read landed after ${ms}ms; nav=${observed.navBefore}; handle B still open on ${dbNameFor(LIVE_GATE_NETWORK_HASH)}`;
	});

	// -- 6 -------------------------------------------------------------------
	// A MUTABLE HOLDER rather than a bare `let`. The assignment below happens
	// inside a callback, and TypeScript's flow analysis narrows a `let` that is
	// only ever assigned in a nested function down to `null` at the teardown
	// site — which then reports `stop` as a property of `never`. A property on
	// a const object is not narrowed that way, so the release stays reachable.
	/** @type {{ current: { active: boolean, stop: () => void } | null }} */
	const writerPropagation = { current: null };
	await rung(6, 'start change propagation ON THE WRITER — the same product function the page calls', async () => {
		if (CONTROL === 'nolisten') {
			return 'SKIPPED by ?control=nolisten — this run is the inversion control';
		}
		if (dbB === null) throw new Error('handle B is not open');
		writerPropagation.current = enableChangePropagation(dbB, LIVE_GATE_NETWORK_HASH);
		if (!writerPropagation.current.active) throw new Error('propagation did not start on the writing handle');
		return 'active on handle B';
	});

	// -- 7 -------------------------------------------------------------------
	await rung(7, 'write through handle B while the page is mounted', async () => {
		if (dbB === null) throw new Error('handle B is not open');
		if (u1Prereq === null) throw new Error('u1Prereq was not seeded — rung 2 did not complete');
		// 62-02 (D-26): Keyholder.InsertValid now requires a signed
		// KeyholderDkgBinding in the SAME transaction — this one call still
		// produces exactly ONE new Keyholder row (the observed mutation below),
		// plus its now-mandatory binding.
		await insertBoundKeyholder(dbB, u1Prereq, { electionId: SEED_ELECTION.id, revision: SEED_REVISION, tid: 900 });
		const back = await readKeyReleaseProgress(dbB, SEED_ELECTION.id, SEED_REVISION);
		if (back.keyholderCount !== 1) throw new Error(`the write did not land: handle B reads keyholderCount ${back.keyholderCount}`);
		return 'one keyholder row inserted; handle B reads it back';
	});

	// -- 8 -------------------------------------------------------------------
	await rung(8, 'the DOM re-rendered with the NEW value, in one page load', async () => {
		const ms = await pollUntil(
			() => rootText().includes(SENTENCE_AFTER),
			30_000,
			() =>
				`the page never rendered the post-write sentence "${SENTENCE_AFTER}" — it still shows "${
					rootText().includes(SENTENCE_BEFORE) ? SENTENCE_BEFORE : rootText().slice(0, 200)
				}"`,
		);
		observed.afterText = rootText();
		observed.navAfter = navigationCount();
		observed.nonceAfter = LOAD_NONCE;

		// Three assertions, separately, so a failure says which one broke.
		if (observed.afterText === observed.beforeText) throw new Error('the rendered text did not change at all');
		if (observed.navAfter !== observed.navBefore || observed.nonceAfter !== observed.nonceBefore) {
			throw new Error(
				`the page RELOADED or navigated: navigation entries ${observed.navBefore} -> ${observed.navAfter}, ` +
					`load nonce ${observed.nonceBefore} -> ${observed.nonceAfter}`,
			);
		}
		if (observed.beforeText.includes(SENTENCE_AFTER)) {
			throw new Error('the pre-write text ALREADY contained the post-write sentence — this rung cannot discriminate');
		}
		if (!observed.beforeText.includes(SENTENCE_BEFORE)) {
			throw new Error('the pre-write text did not contain the pre-write sentence — rung 5 recorded the wrong snapshot');
		}
		return `updated after ${ms}ms, nav unchanged at ${observed.navAfter}, same load`;
	});

	// -- 9 -------------------------------------------------------------------
	await rung(9, 'the number on screen is the number the store holds — read back through a freshly attached handle', async () => {
		// Handle C attaches exactly the way the page attaches: through the same
		// re-attach helper, against the same store name. A fresh handle proves
		// the write is PERSISTED rather than an artefact of handle B's memory,
		// and comparing it to what is on screen is what makes a stale render a
		// named red rung instead of an invisible one.
		const dbC = await attachNetworkDb(LIVE_GATE_NETWORK_HASH);
		try {
			const fresh = await readKeyReleaseProgress(dbC, SEED_ELECTION.id, SEED_REVISION);
			if (fresh.keyholderCount !== 1) {
				throw new Error(`a freshly attached handle reads keyholderCount ${fresh.keyholderCount}, expected 1 — the write did not persist`);
			}
			const onScreen = t('public.fact.keyrelease.sentence', { released: fresh.released, total: fresh.keyholderCount });
			if (!rootText().includes(onScreen)) {
				throw new Error(
					`the store holds "${onScreen}" but the page does not show it — the render is STALE relative to the store`,
				);
			}
			return `store and screen agree: ${onScreen}`;
		} finally {
			await closeNetworkDb(dbC);
		}
	});

	// Teardown. Never `git`-visible state, never a delete of another harness's
	// store: this gate only releases what it opened.
	try {
		writerPropagation.current?.stop();
	} catch {
		// A stop that throws is not a finding; the run is already graded.
	}
	if (dbB !== null) {
		try {
			await closeNetworkDb(dbB);
		} catch {
			// Same.
		}
	}

	finish();
}

function finish() {
	const passed = rungs.filter((r) => r.ok).length;
	win.__LIVE_READ_GATE__ = Object.freeze({
		control: CONTROL,
		rungs: rungs.map((r) => Object.freeze({ ...r })),
		passed,
		total: rungs.length,
		beforeText: observed.beforeText,
		afterText: observed.afterText,
		navBefore: observed.navBefore,
		navAfter: observed.navAfter,
		loadNonce: LOAD_NONCE,
		sentenceBefore: SENTENCE_BEFORE,
		sentenceAfter: SENTENCE_AFTER,
		log: LOG,
	});
	win.__LIVE_READ_GATE_DONE__ = true;
	console.log(`[live-read-gate] ${passed}/${rungs.length} rungs passed (control=${CONTROL ?? 'none'})`);
}

main().catch((err) => {
	log('crash', String(err?.stack ?? err));
	win.__LIVE_READ_GATE__ = Object.freeze({
		control: CONTROL,
		crashed: String(err?.stack ?? err),
		rungs: rungs.map((r) => Object.freeze({ ...r })),
		passed: rungs.filter((r) => r.ok).length,
		total: rungs.length,
		log: LOG,
	});
	win.__LIVE_READ_GATE_DONE__ = true;
	console.error('[live-read-gate] crashed', err);
});
