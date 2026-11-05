/**
 * Tier-2 gate page driver — imports the PRODUCTION connection-layer modules
 * from `@votetorrent/web-data/officer` (moved out of this workspace's own
 * `src/db` by 54-03a), so this gate proves the shipped code, not a copy. Read
 * `?phase=` (`seed` | `verify`), `&expect=` (phase 1's counts, encoded, for
 * phase 2 to compare against) and `&trap=` (only ever `novtab`, only ever
 * reachable from `phase=seed`, only ever used by `run-headless.mjs
 * --prove-trap`).
 *
 * This page is test-only and is never part of the production Vite build
 * (contract C2 is untouched — no copy-table string appears here).
 *
 * Readout convention mirrors spike 076's `window.__SPIKE076__` /
 * `window.__SPIKE076_DONE__`, renamed `window.__DB_GATE__` /
 * `window.__DB_GATE_DONE__` to stay distinct from 50-04's
 * `window.__DASHBOARD__` (the app's own readout hook). All custom readout
 * properties are accessed through the `win` alias below (typed `any`) rather
 * than augmenting the global `Window` interface — this file is test-only
 * scaffolding, not a module `main.tsx` or any production code imports.
 */
import { Database, registerPlugin } from '@quereus/quereus';
import indexeddbPlugin from '@quereus/plugin-indexeddb/plugin';
import { prepareDb } from '@votetorrent/vote-engine/browser';
import {
	STORE_MODULE_NAME,
	dbNameFor,
	createNetworkDb,
	closeNetworkDb,
	deleteNetworkDb,
	listObjectStores,
	openStoreHandle,
	attachNetworkDb,
	readRowCounts,
	writeRowCounts,
} from '@votetorrent/web-data/officer';
import { GATE_NETWORK_HASH, SEED_TABLES, seedFoundingAuthority } from '../../../../packages/web-data/test/fixtures/seed-founding-authority.js';

/** @type {any} */
const win = window;

/** @type {Array<{ t: string, ms: number, category: string, message: string, meta?: unknown }>} */
const LOG = [];
const t0 = performance.now();
/** @param {string} category @param {string} message @param {unknown} [meta] */
const log = (category, message, meta) =>
	LOG.push({
		t: new Date().toISOString(),
		ms: +(performance.now() - t0).toFixed(1),
		category,
		message,
		...(meta !== undefined ? { meta } : {}),
	});

const params = new URLSearchParams(location.search);
const PHASE = params.get('phase') ?? 'seed';
const TRAP = params.get('trap');

const stepsEl = document.getElementById('steps');
/** @type {{ name: string, el: HTMLElement, start: number }[]} */
const steps = [];

/** @param {{ el: HTMLElement, start: number }} rec @param {'ok'|'fail'} state @param {string} [detail] */
function settle(rec, state, detail) {
	rec.el.className = `step ${state}`;
	rec.el.textContent = `[${state}] ${rec.el.dataset.name} ${detail ?? ''} (${(performance.now() - rec.start).toFixed(0)}ms)`;
	log(state === 'ok' ? 'pass' : 'fail', rec.el.dataset.name ?? '', detail);
}

/**
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ ok: boolean, value?: T, error?: string }>}
 */
async function rung(name, fn) {
	const el = document.createElement('div');
	el.className = 'step pending';
	el.dataset.name = name;
	// Rendered with textContent only, never innerHTML — nothing derived from
	// the database may reach the DOM as markup (T-50-05-06).
	el.textContent = name;
	stepsEl?.appendChild(el);
	const rec = { name, el, start: performance.now() };
	steps.push(rec);
	try {
		const v = await fn();
		settle(rec, 'ok', typeof v === 'string' ? v : undefined);
		return { ok: true, value: v };
	} catch (err) {
		settle(rec, 'fail', String(/** @type {any} */ (err)?.message ?? err).slice(0, 400));
		return { ok: false, error: String(/** @type {any} */ (err)?.message ?? err) };
	}
}

/**
 * INTENTIONAL MIS-BUILD — used only by `trap=novtab` (reachable only from
 * `run-headless.mjs --prove-trap`) to prove the gate can still detect a
 * missing `setDefaultVtabName`. The production path
 * (`@votetorrent/web-data`'s `open-db.js`) exposes no option to skip the
 * call; this five-line local copy exists solely to exercise the negative
 * case.
 *
 * @param {string} networkHash
 * @returns {Promise<import('@quereus/quereus').Database>}
 */
async function openTrapHandle(networkHash) {
	const db = new Database();
	await registerPlugin(db, indexeddbPlugin, {
		databaseName: dbNameFor(networkHash),
		moduleName: STORE_MODULE_NAME,
		isolation: true,
	});
	// deliberately OMITTED: db.setDefaultVtabName(STORE_MODULE_NAME);
	await prepareDb(db);
	return db;
}

async function main() {
	log('start', `db-gate phase=${PHASE}${TRAP ? ` trap=${TRAP}` : ''}`, { ua: navigator.userAgent });

	if (PHASE === 'seed') {
		await rung('1 · delete any prior database for GATE_NETWORK_HASH', async () => {
			await deleteNetworkDb(GATE_NETWORK_HASH);
			return 'clean slate';
		});

		const dbR = await rung('2 · open/create the network database', () =>
			TRAP === 'novtab' ? openTrapHandle(GATE_NETWORK_HASH) : createNetworkDb(GATE_NETWORK_HASH),
		);
		if (!dbR.ok || !dbR.value) return finish();
		const db = dbR.value;

		await rung('3 · seed founding Authority + User + Admin + Officer', async () => {
			await seedFoundingAuthority(db);
			return 'seeded';
		});

		const countsR = await rung('4 · read counts and persist the contract-C5 row-count record', async () => {
			const counts = await readRowCounts(db, SEED_TABLES);
			await writeRowCounts(GATE_NETWORK_HASH, counts);
			win.__DB_GATE_COUNTS__ = counts;
			return JSON.stringify(counts);
		});

		await rung('5 · IndexedDB object stores actually created', async () => {
			const names = await listObjectStores(GATE_NETWORK_HASH);
			win.__DB_GATE_STORES__ = names;
			if (names.length === 0) {
				throw new Error('ZERO object stores — tables went to the in-memory module, not IndexedDB');
			}
			return `${names.length} stores`;
		});

		await rung('6 · close the handle before the page boundary', async () => {
			await closeNetworkDb(db);
			return 'closed';
		});

		win.__DB_GATE__ = {
			phase: 'seed',
			passed: steps.filter((s) => !s.el.classList.contains('fail')).length,
			total: steps.length,
			counts: countsR.ok ? win.__DB_GATE_COUNTS__ : undefined,
			stores: win.__DB_GATE_STORES__,
			log: LOG,
		};
	} else {
		// phase=verify creates NOTHING and applies NO seed.
		const expected = JSON.parse(params.get('expect') ?? 'null');

		await rung('1 · object stores survived the page boundary', async () => {
			const names = await listObjectStores(GATE_NETWORK_HASH);
			win.__DB_GATE_STORES__ = names;
			if (names.length === 0) throw new Error('ZERO object stores — nothing was persisted');
			return `${names.length} stores present`;
		});

		await rung('2 · probe — a fresh handle does NOT auto-restore the catalog', async () => {
			const probeDb = await openStoreHandle(GATE_NETWORK_HASH);
			try {
				await probeDb.prepare('select count(*) as c from Authority').get({});
				throw new Error('UNEXPECTED: the catalog auto-restored on a fresh handle with no DDL applied');
			} catch (err) {
				const m = String(/** @type {any} */ (err)?.message ?? err);
				if (!/not found in schema path/i.test(m)) throw err;
				return `confirmed — "${m}"`;
			} finally {
				await closeNetworkDb(probeDb);
			}
		});

		const attachR = await rung('3 · attachNetworkDb — re-declare DDL, gate on schema-init, assert row counts', () =>
			attachNetworkDb(GATE_NETWORK_HASH),
		);
		if (!attachR.ok || !attachR.value) return finish();
		const db = attachR.value;

		await rung('4 · re-read counts and compare against phase 1', async () => {
			const counts = await readRowCounts(db, SEED_TABLES);
			win.__DB_GATE_COUNTS__ = counts;
			if (!expected) return `read back: ${JSON.stringify(counts)}`;
			/** @type {string[]} */
			const diffs = [];
			for (const table of Object.keys(expected)) {
				if (counts[table] !== expected[table]) {
					diffs.push(`${table}: expected ${expected[table]}, got ${counts[table]}`);
				}
			}
			if (diffs.length) throw new Error('row counts diverged after reload: ' + diffs.join('; '));
			return `identical to phase 1: ${JSON.stringify(counts)}`;
		});

		await rung('5 · close the handle', async () => {
			await closeNetworkDb(db);
			return 'closed';
		});

		win.__DB_GATE__ = {
			phase: 'verify',
			passed: steps.filter((s) => !s.el.classList.contains('fail')).length,
			total: steps.length,
			counts: win.__DB_GATE_COUNTS__,
			stores: win.__DB_GATE_STORES__,
			log: LOG,
		};
	}
	finish();
}

function finish() {
	const failed = steps.filter((s) => s.el.classList.contains('fail'));
	const verdictEl = document.getElementById('verdict');
	const text =
		failed.length === 0
			? `PASS phase "${PHASE}" — all ${steps.length} rungs passed`
			: `FAIL phase "${PHASE}" — ${failed.length} of ${steps.length} failed`;
	if (verdictEl) verdictEl.textContent = text;
	log('verdict', text);
	win.__DB_GATE__ = {
		...(win.__DB_GATE__ ?? {}),
		phase: PHASE,
		passed: steps.length - failed.length,
		total: steps.length,
		failed: failed.map((f) => f.el.dataset.name),
		log: LOG,
	};
	win.__DB_GATE_DONE__ = true;
	console.log('[db-gate] ' + text);
}

main().catch((e) => {
	log('crash', String(e?.stack ?? e));
	win.__DB_GATE__ = { phase: PHASE, crashed: String(e?.stack ?? e), log: LOG };
	win.__DB_GATE_DONE__ = true;
	console.error('[db-gate] crashed', e);
});
