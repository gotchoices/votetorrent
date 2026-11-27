/**
 * source-paths.test.mjs — unit test for `scripts/lib/source-paths.mjs` (D-03).
 *
 * This file touches no IndexedDB, so unlike most of this suite it does not
 * import `fake-indexeddb/auto` — doing so would imply a persistence claim
 * this tier cannot make.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
	repoRoot,
	workspacePath,
	dashboardSrc,
	uiWebSrc,
	webDataRoot,
	webDataSrc,
	moduleUrl,
} from '../../../../scripts/lib/source-paths.mjs';

test('repoRoot is the workspace root, identified by marker not by hop count', () => {
	assert.ok(path.isAbsolute(repoRoot), 'repoRoot must be an absolute path');

	const pkgPath = path.join(repoRoot, 'package.json');
	const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
	assert.equal(pkg.name, 'votetorrent', 'root package.json name must be votetorrent');
	assert.ok(pkg.workspaces, 'root package.json must declare a workspaces key');

	const selfUrl = new URL('../../../../scripts/lib/source-paths.mjs', import.meta.url);
	const selfPath = fileURLToPath(selfUrl);
	const relFromRoot = path.relative(repoRoot, selfPath).split(path.sep).join('/');
	assert.equal(relFromRoot, 'scripts/lib/source-paths.mjs');
});

test('dashboardSrc resolves to real bytes, not just a plausible string', () => {
	// This proof needs any real file still under this workspace's own src/;
	// the status reducer is pure (no IndexedDB), so reading and importing it
	// has no side effects.
	const contents = readFileSync(dashboardSrc('live', 'status.js'), 'utf8');
	assert.ok(
		contents.includes('export function reduceStatus'),
		'dashboardSrc must resolve to the real status.js, not merely a well-formed path',
	);
});

test('resolution is independent of the process working directory', () => {
	const originalCwd = process.cwd();
	try {
		const before = dashboardSrc('live', 'status.js');
		process.chdir(os.tmpdir());
		const after = dashboardSrc('live', 'status.js');
		assert.equal(after, before, 'resolution must not change when cwd changes');
	} finally {
		process.chdir(originalCwd);
	}
});

test("resolution is independent of the caller's depth", () => {
	// Re-implement the marker predicate locally, deliberately, so this proves
	// the module's answer rather than merely agreeing with itself.

	/** @param {string} startDir @returns {string} */
	function localFindRepoRoot(startDir) {
		let dir = startDir;
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const pkgPath = path.join(dir, 'package.json');
			if (existsSync(pkgPath)) {
				try {
					const parsed = JSON.parse(readFileSync(pkgPath, 'utf8'));
					if (parsed && parsed.name === 'votetorrent' && parsed.workspaces) {
						return dir;
					}
				} catch {
					// keep walking
				}
			}
			const parent = path.dirname(dir);
			if (parent === dir) {
				throw new Error(`localFindRepoRoot: no marker found starting from ${startDir}`);
			}
			dir = parent;
		}
	}

	const deepStart = path.join(repoRoot, 'apps', 'VoteTorrentDashboard', 'test', 'node');
	const independentRoot = localFindRepoRoot(deepStart);
	assert.equal(independentRoot, repoRoot, 'the depth-independent walk must agree with repoRoot');
});

test('future roots are nameable before they exist', () => {
	const expected = path.join(repoRoot, 'packages', 'ui-web', 'src', 'tokens.css');
	assert.doesNotThrow(() => uiWebSrc('tokens.css'));
	assert.equal(uiWebSrc('tokens.css'), expected);
	// Deliberately no existence assertion: correct in wave 1, wrong from wave 2 onward.
});

test('moduleUrl produces a specifier a dynamic import actually accepts', async () => {
	const url = moduleUrl(dashboardSrc('live', 'status.js'));
	assert.ok(url.startsWith('file://'), 'moduleUrl must return a file:// href');
	const ns = await import(url);
	assert.equal(typeof ns.reduceStatus, 'function', 'the dynamically imported module must expose a reduceStatus function');
});

test('containment refuses a path that escapes the repository', () => {
	assert.throws(() => dashboardSrc('..', '..', '..', '..', 'etc', 'passwd'));

	// Discriminating half: a legitimate cross-workspace call must NOT throw.
	const schemaPath = workspacePath('packages/vote-core', 'schema', 'votetorrent.qsql');
	assert.doesNotThrow(() => readFileSync(schemaPath, 'utf8'));
	const contents = readFileSync(schemaPath, 'utf8');
	assert.ok(contents.includes('declare schema main'));
});

test('webDataRoot/webDataSrc are nameable before packages/web-data exists (D-03)', () => {
	assert.doesNotThrow(() => webDataSrc('open-db.js'));
	assert.equal(webDataSrc('open-db.js'), path.join(repoRoot, 'packages', 'web-data', 'src', 'open-db.js'));
	assert.equal(webDataRoot('package.json'), path.join(repoRoot, 'packages', 'web-data', 'package.json'));
	assert.equal(webDataSrc(), path.join(repoRoot, 'packages', 'web-data', 'src'));
	// Deliberately no existence assertion: correct in wave 1, wrong from 54-03 onward.
});

test('webDataSrc containment refuses a path that escapes the repository', () => {
	assert.throws(() => webDataSrc('..', '..', '..', '..', 'etc', 'passwd'));

	// Discriminating half: a legitimate call must NOT throw.
	assert.doesNotThrow(() => webDataSrc('open-db.js'));
});
