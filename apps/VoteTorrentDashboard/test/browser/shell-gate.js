/**
 * shell-gate.js -- the tier-2 two-page proof that the live dashboard's LOCAL
 * COPY persists across page loads and that "forget this network" removes
 * exactly one network, driven by `run-headless.mjs` (its phase names are the
 * runner's URL parameters, not user copy).
 *
 * Every phase runs the REAL live boot (`startDashboardBoot`) with the gate's
 * fake peer layer injected through `deps` (from `./live-gate.js`: a fake
 * member node handing the real strand reader a seeded in-memory strand
 * image, the real replication bridge, a scripted pairing check). The live
 * store, the registry, the lifecycle lock and the forget path are the
 * shipped modules. Importing `./live-gate.js` also loads the design tokens
 * (its `../../src/app.css` import); its driver does not run here, because
 * this page's `<html>` carries no `data-gate="live-gate"`.
 *
 *   restore-seed   seed PRIMARY and SECOND, boot each until its first
 *                  completed pass, then stop; report PRIMARY's row counts.
 *   restore-verify a fresh page: no seeding. Boot PRIMARY with the relay
 *                  unreachable: the local copy opens with zero completed
 *                  passes, its counts equal `&expect=` exactly, and after the
 *                  grace the view is Offline with the persisted last update.
 *   forget         a wrong typed confirmation is refused and changes
 *                  nothing; the right one forgets PRIMARY; SECOND untouched.
 *   forget-verify  a fresh page: nothing of PRIMARY is left in IndexedDB or
 *                  the registry; SECOND re-attaches with equal counts.
 *
 * Readout: `window.__SHELL_GATE__` (`phase`, `passed`, `total`, `failed`,
 * `log`, `counts`) and `window.__SHELL_GATE_DONE__`. Every step renders with
 * `textContent` only. No fixture value is logged beyond counts.
 */
import {
	GATE_NETWORKS,
	createFakePeerLayer,
	createStrandImage,
	loadPeerModules,
	seedGateNetwork,
} from './live-gate.js';
import { forgetNetwork, assertNetworkForgotten, ForgetConfirmationMismatchError } from '../../src/lifecycle/forget-network.js';
import { attachLiveDb, closeNetworkDb, dbNameFor, findNetwork, readRowCounts } from '@votetorrent/web-data/officer';
import { SEED_TABLES, EXPECTED_COUNTS } from '../../../../packages/web-data/test/fixtures/seed-founding-authority.js';
import { SEED_EXPECTED_COUNTS } from '../../../../packages/web-data/test/fixtures/seed-election-surface.js';

/** @type {any} */
const win = window;

const PRIMARY = GATE_NETWORKS.A;
const SECOND = GATE_NETWORKS.B;
/** The fixture tables whose counts this gate compares. */
const COUNT_TABLES = [...SEED_TABLES, ...Object.keys(SEED_EXPECTED_COUNTS)];
/** The counts a fully replicated fixture image leaves in a live store. */
const FIXTURE_COUNTS = { ...EXPECTED_COUNTS, ...SEED_EXPECTED_COUNTS };
/** Spec literal: the reducer's offline grace (UI-SPEC section 1). */
const OFFLINE_GRACE_MS = 10_000;

/** @type {Array<{ t: string, ms: number, category: string, message: string, meta?: unknown }>} */
const LOG = [];
const t0 = performance.now();
/** @param {string} category @param {string} message @param {unknown} [meta] */
const log = (category, message, meta) =>
	LOG.push({ t: new Date().toISOString(), ms: +(performance.now() - t0).toFixed(1), category, message, ...(meta !== undefined ? { meta } : {}) });

const params = new URLSearchParams(location.search);
const PHASE = params.get('phase') ?? 'restore-seed';

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

/** @param {() => boolean} predicate @param {number} timeoutMs @param {string} label */
async function waitUntil(predicate, timeoutMs, label) {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
}

/** @param {string} hash */
async function countsOf(hash) {
	const db = await attachLiveDb(hash, { create: false });
	try {
		return await readRowCounts(db, COUNT_TABLES);
	} finally {
		await closeNetworkDb(db);
	}
}

/** @param {Record<string, number>} actual @param {Record<string, number>} expected */
function sameCounts(actual, expected) {
	const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
	for (const k of keys) if (actual[k] !== expected[k]) return false;
	return true;
}

/**
 * The real boot over the fake layer, until its first completed pass, then stopped.
 * @param {import('./live-gate.js').GateNetworkSpec} spec
 */
async function bootUntilFirstPass(spec) {
	const { startDashboardBoot } = await loadPeerModules();
	const image = await createStrandImage();
	const { bootDeps, control } = createFakePeerLayer({ image: { [spec.networkHash]: image }, mode: { [spec.networkHash]: 'auto' } });
	const boot = await startDashboardBoot({ networkHash: spec.networkHash, deps: bootDeps });
	if (boot.failure !== null) throw new Error(`the boot failed: ${boot.failure}`);
	await waitUntil(() => (control.counts()[spec.networkHash]?.passesComplete ?? 0) >= 1, 30_000, 'the first completed pass');
	await boot.whenIdle();
	await boot.stop();
}

async function runRestoreSeed() {
	await rung('1 · seed PRIMARY and SECOND fresh (old entry and store removed, empty live store, paired entry)', async () => {
		await seedGateNetwork(PRIMARY);
		await seedGateNetwork(SECOND);
		return 'seeded';
	});
	const primaryR = await rung('2 · PRIMARY: the live boot replicates the strand image into the local copy and stops', async () => {
		await bootUntilFirstPass(PRIMARY);
		return 'first pass completed';
	});
	const secondR = await rung('3 · SECOND: the same', async () => {
		await bootUntilFirstPass(SECOND);
		return 'first pass completed';
	});
	await rung('4 · both entries are paired and PRIMARY carries a persisted last update', async () => {
		for (const spec of [PRIMARY, SECOND]) {
			const entry = findNetwork(spec.networkHash);
			if (!entry || entry.pairing === null) throw new Error(`entry ${spec.key} is missing or unpaired`);
		}
		if (typeof findNetwork(PRIMARY.networkHash)?.lastPassAt !== 'number') throw new Error('PRIMARY has no persisted lastPassAt');
		return 'paired';
	});
	if (!primaryR.ok || !secondR.ok) return;
	await rung('5 · the local copies hold non-zero fixture counts', async () => {
		const counts = await countsOf(PRIMARY.networkHash);
		win.__SHELL_GATE__ = { ...(win.__SHELL_GATE__ ?? {}), counts };
		const second = await countsOf(SECOND.networkHash);
		for (const [table, n] of Object.entries({ ...counts, ...second })) if (!(n > 0)) throw new Error(`table ${table} holds ${n} rows`);
		log('counts', 'PRIMARY counts', counts);
		return JSON.stringify(counts);
	});
}

async function runRestoreVerify() {
	/** @type {Record<string, number>} */
	let expected = {};
	await rung('1 · `&expect=` parses and the PRIMARY entry exists (this page seeds nothing)', async () => {
		expected = JSON.parse(params.get('expect') ?? 'null');
		if (!expected || typeof expected !== 'object' || Object.keys(expected).length === 0) throw new Error('no expected counts');
		if (!findNetwork(PRIMARY.networkHash)) throw new Error('no PRIMARY entry: restore-seed must run first');
		return 'present';
	});
	const { startDashboardBoot } = await loadPeerModules();
	const image = await createStrandImage();
	const { bootDeps, control } = createFakePeerLayer({ image: { [PRIMARY.networkHash]: image }, mode: { [PRIMARY.networkHash]: 'never' } });
	/** @type {any} */
	let boot = null;
	await rung('2 · the relay is unreachable, yet the boot opens the local copy (db set, no failure)', async () => {
		boot = await startDashboardBoot({ networkHash: PRIMARY.networkHash, deps: bootDeps });
		if (boot.failure !== null) throw new Error(`failure ${boot.failure}`);
		if (!boot.db) throw new Error('no local store handle');
		return 'opened';
	});
	if (!boot) return;
	await rung('3 · the local copy counts equal phase 1 exactly', async () => {
		const counts = await readRowCounts(boot.db, COUNT_TABLES);
		win.__SHELL_GATE__ = { ...(win.__SHELL_GATE__ ?? {}), counts };
		if (!sameCounts(counts, expected)) throw new Error(`counts differ: ${JSON.stringify(counts)}`);
		return JSON.stringify(counts);
	});
	await rung('4 · after the grace the view is Offline with the persisted last update, and no pass completed', async () => {
		await new Promise((r) => setTimeout(r, OFFLINE_GRACE_MS + 1500));
		const view = boot.getStatus();
		const persisted = findNetwork(PRIMARY.networkHash)?.lastPassAt ?? null;
		const done = control.counts()[PRIMARY.networkHash]?.passesComplete ?? 0;
		if (view.kind !== 'offline') throw new Error(`view kind ${view.kind}`);
		if (view.lastPassAt !== persisted) throw new Error('the view last update is not the persisted one');
		if (done !== 0) throw new Error(`${done} completed pass(es)`);
		return `offline, last update ${persisted}`;
	});
	await boot.stop();
}

async function runForget() {
	/** @type {Record<string, number> | null} */
	let secondBefore = null;
	await rung('1 · both entries are present before the forget', async () => {
		if (!findNetwork(PRIMARY.networkHash) || !findNetwork(SECOND.networkHash)) throw new Error('an entry is missing');
		secondBefore = await countsOf(SECOND.networkHash);
		return 'present';
	});
	await rung('2 · a wrong typed confirmation is refused and leaves PRIMARY in place', async () => {
		try {
			await forgetNetwork({ networkHash: PRIMARY.networkHash, typedConfirmation: `${PRIMARY.authorityName} (wrong)` });
		} catch (err) {
			if (!(err instanceof ForgetConfirmationMismatchError)) throw new Error(`refused with ${/** @type {any} */ (err)?.name}`);
			if (!findNetwork(PRIMARY.networkHash)) throw new Error('the entry is gone after a refusal');
			return 'refused';
		}
		throw new Error('a wrong confirmation was accepted');
	});
	await rung('3 · the exact authority name forgets PRIMARY', async () => {
		const result = await forgetNetwork({ networkHash: PRIMARY.networkHash, typedConfirmation: PRIMARY.authorityName });
		if (findNetwork(PRIMARY.networkHash)) throw new Error('the entry survived');
		return `remaining ${result.remaining.length}`;
	});
	await rung('4 · SECOND is untouched: entry present, counts equal', async () => {
		if (!findNetwork(SECOND.networkHash)) throw new Error('SECOND entry is gone');
		const after = await countsOf(SECOND.networkHash);
		if (!secondBefore || !sameCounts(after, secondBefore)) throw new Error('SECOND counts changed');
		return JSON.stringify(after);
	});
}

async function runForgetVerify() {
	await rung('1 · assertNetworkForgotten(PRIMARY) resolves on a fresh page', async () => {
		await assertNetworkForgotten(PRIMARY.networkHash);
		return 'forgotten';
	});
	await rung('2 · indexedDB.databases() lists no store of PRIMARY', async () => {
		const names = (await indexedDB.databases()).map((d) => d.name ?? '');
		if (names.includes(dbNameFor(PRIMARY.networkHash))) throw new Error('the live store is still listed');
		return `${names.length} databases listed`;
	});
	await rung('3 · SECOND re-attaches with the fixture counts', async () => {
		const counts = await countsOf(SECOND.networkHash);
		if (!sameCounts(counts, FIXTURE_COUNTS)) throw new Error(`counts ${JSON.stringify(counts)}`);
		return JSON.stringify(counts);
	});
}

function finish() {
	const failed = steps.filter((s) => s.el.classList.contains('fail'));
	const verdictEl = document.getElementById('verdict');
	const text =
		failed.length === 0 ? `PASS phase "${PHASE}": all ${steps.length} rungs passed` : `FAIL phase "${PHASE}": ${failed.length} of ${steps.length} failed`;
	if (verdictEl) verdictEl.textContent = text;
	log('verdict', text);
	win.__SHELL_GATE__ = {
		...(win.__SHELL_GATE__ ?? {}),
		phase: PHASE,
		passed: steps.length - failed.length,
		total: steps.length,
		failed: failed.map((f) => f.el.dataset.name),
		log: LOG,
	};
	win.__SHELL_GATE_DONE__ = true;
	console.log('[shell-gate] ' + text);
}

async function main() {
	log('start', `shell-gate phase=${PHASE}`);
	if (PHASE === 'restore-seed') await runRestoreSeed();
	else if (PHASE === 'restore-verify') await runRestoreVerify();
	else if (PHASE === 'forget') await runForget();
	else if (PHASE === 'forget-verify') await runForgetVerify();
	else throw new Error(`shell-gate: unknown phase "${PHASE}"`);
	finish();
}

main().catch((err) => {
	win.__SHELL_GATE__ = { phase: PHASE, crashed: String(/** @type {any} */ (err)?.name ?? 'Error'), log: LOG };
	win.__SHELL_GATE_DONE__ = true;
});
