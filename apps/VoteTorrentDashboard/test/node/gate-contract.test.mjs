/**
 * gate-contract.test.mjs — makes the tier-1 gate real rather than merely declared.
 *
 * Three tests:
 *   1. The fake-indexeddb shim is genuinely wired (round-trips across close/reopen).
 *   2. The module-format contract (C1) is mechanically enforced, with a positive
 *      control proving the enforcement can actually fire.
 *   3. The sequencing contract (`--test-concurrency=1`) is declared where it is
 *      enforced (package.json's test:node script).
 *
 * Sequential and deliberate -- see the binding note in 50-04-PLAN.md and
 * .claude/skills/spike-findings-votetorrent/references/web-browser-target.md
 * § "What to Avoid": "Do not reorder or parallelise the Node suite."
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { dashboardRoot, uiWebSrc, webDataSrc } from '../../../../scripts/lib/source-paths.mjs';

const APP_ROOT = dashboardRoot();

test('fake-indexeddb: the shim round-trips a record across a close/reopen in one process', async () => {
	// Honesty note (50-VALIDATION.md): this proves the ENGINE's use of the IDB
	// API round-trips within one process. It does NOT prove browser persistence
	// -- this tier says nothing about quota, eviction, cross-tab locking or
	// structured-clone edges, and it cannot catch a missing
	// `setDefaultVtabName('store')`, whose absence is same-session-invisible.
	// Only 50-05's two-page headless-Chrome gate can catch that class of bug.
	const DB_NAME = 'gate-contract-smoke';

	/** @returns {Promise<IDBDatabase>} */
	function openDb() {
		return new Promise((resolve, reject) => {
			const req = indexedDB.open(DB_NAME, 1);
			req.onupgradeneeded = () => {
				req.result.createObjectStore('probe', { keyPath: 'id' });
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}

	/** @param {IDBDatabase} db */
	function writeRecord(db) {
		return new Promise((resolve, reject) => {
			const tx = db.transaction('probe', 'readwrite');
			tx.objectStore('probe').put({ id: 1, v: 'ok' });
			tx.oncomplete = () => resolve(undefined);
			tx.onerror = () => reject(tx.error);
		});
	}

	/** @param {IDBDatabase} db */
	function readRecord(db) {
		return new Promise((resolve, reject) => {
			const tx = db.transaction('probe', 'readonly');
			const req = tx.objectStore('probe').get(1);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}

	/** @returns {Promise<void>} */
	function deleteDb() {
		return new Promise((resolve, reject) => {
			const req = indexedDB.deleteDatabase(DB_NAME);
			req.onsuccess = () => resolve(undefined);
			req.onerror = () => reject(req.error);
		});
	}

	const db1 = await openDb();
	await writeRecord(db1);
	db1.close();

	const db2 = await openDb();
	const record = await readRecord(db2);
	assert.equal(record?.v, 'ok', 'record must round-trip across a close/reopen');
	db2.close();

	await deleteDb();
});

test('module-format contract (C1): no .ts/.tsx file exists under a tier-1-reachable directory', () => {
	// A tier-1-reachable module must be plain ESM .js with JSDoc types, because
	// `node --test` cannot import TypeScript within the 1s feedback budget and
	// type stripping is flagged on Node 22.15 but unflagged from 22.18, so a
	// .ts module in one of these directories produces a gate that behaves
	// differently on CI and on a workstation.
	// Repo-relative dashboard dirs, plus the shared package's own lifecycle
	// dir since election-phase.js followed there in 53-05 (D-01/D-02) --
	// ONLY that one package directory: src/components/ holds .tsx
	// deliberately and must not be added here. 54-03a moved the dashboard's
	// `src/db` into `packages/web-data` -- the governed set follows the move:
	// `'src/db'` is gone from the repo-relative GOVERNED_DIRS list below (that
	// directory no longer exists in this workspace) and `webDataSrc()` joins
	// GOVERNED_ABS_DIRS in its place, so this C1 contract keeps covering the
	// moved connection-layer modules rather than silently narrowing (the
	// existsSync guard below skips a missing directory rather than failing,
	// which is a coverage loss, not a crash -- 53-D06). The sign-in transport
	// directory left with the snapshot path (66-24); `src/peer` takes its slot
	// as the tier-1-reachable network layer (all `.js`, imported by node tests).
	// The positive control below keeps its synthetic `src/transport` strings:
	// the predicate is path-shape only and never reads that directory.
	const GOVERNED_DIRS = ['src/peer', 'src/auth', 'src/i18n', 'src/lifecycle'];
	const GOVERNED_ABS_DIRS = [uiWebSrc('lifecycle'), webDataSrc()];

	/** @param {string[]} paths */
	function findTsViolations(paths) {
		return paths.filter((p) => p.endsWith('.ts') || p.endsWith('.tsx'));
	}

	// Positive control FIRST — a guard that cannot fire is not a guard.
	// Deliberately built on a governed directory that is NOT moving in 54-03
	// (src/transport), so Task 3's derivation-discipline scan can run with
	// zero exemptions and no allowlist to rot.
	const syntheticViolations = findTsViolations(['src/transport/tx.ts', 'src/transport/tx.js']);
	assert.deepEqual(
		syntheticViolations,
		['src/transport/tx.ts'],
		'positive control failed: the predicate must flag a synthetic .ts path under src/transport/',
	);

	/** @param {string} dir @returns {string[]} */
	function walkFiles(dir) {
		/** @type {string[]} */
		const out = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				out.push(...walkFiles(full));
			} else {
				out.push(full);
			}
		}
		return out;
	}

	/** @type {string[]} */
	const allFiles = [];
	for (const relDir of GOVERNED_DIRS) {
		const absDir = path.join(APP_ROOT, relDir);
		if (!existsSync(absDir)) continue; // skip dirs that don't exist yet at this wave
		allFiles.push(...walkFiles(absDir).map((f) => path.relative(APP_ROOT, f)));
	}
	for (const absDir of GOVERNED_ABS_DIRS) {
		if (!existsSync(absDir)) continue;
		allFiles.push(...walkFiles(absDir).map((f) => path.relative(APP_ROOT, f)));
	}

	const violations = findTsViolations(allFiles);
	assert.deepEqual(
		violations,
		[],
		`tier-1-reachable module(s) must be plain ESM .js with JSDoc types, not .ts/.tsx: ${violations.join(', ')}`,
	);
});

test('sequencing contract: package.json test:node script declares --test-concurrency=1', () => {
	// The suite this wave stands up (and the suite 50-05 builds on top of it) is
	// deliberately sequential and stateful against one shared fake IDB; a future
	// edit dropping the flag would make it flaky in a way that looks like a
	// product bug. Assert the STRING, not the runtime behaviour.
	const manifest = JSON.parse(readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
	const testNodeScript = manifest.scripts?.['test:node'] ?? '';
	assert.ok(
		testNodeScript.includes('--test-concurrency=1'),
		`scripts["test:node"] must contain --test-concurrency=1, got: "${testNodeScript}"`,
	);
});
