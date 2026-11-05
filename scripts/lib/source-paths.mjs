#!/usr/bin/env node
//
// scripts/lib/source-paths.mjs
//
// Purpose : the single answer to "where does this source file live" for every
//           Node-tier test and repo-root tooling script that needs to read
//           bytes out of the working tree (D-03).
//
//           Before this module, 18 of the dashboard's 22 node-tier test files
//           each hand-derived their own root by walking up from
//           `fileURLToPath(import.meta.url)`, with a fixed `'..', '..'` hop
//           count baked into every one of them. Phase 53 waves 2-4 relocate
//           `app.css`'s token block into `packages/ui-web`, `i18n/copy.js`
//           and two components into `packages/ui-web`, and
//           `lifecycle/election-phase.js` elsewhere. Each of those moves would
//           have re-broken every scattered derivation independently. With this
//           module, a move changes a **call argument** here — `dashboardSrc(...)`
//           becomes `uiWebSrc(...)` — not a derivation in 18 places.
//
//           This module is test-and-script tooling only. It is never imported
//           by any app `src/` module and it never reaches a production bundle.
//
// Modes   : imported as an ESM module. Not a CLI; has no `--selftest` entry
//           point of its own. `apps/VoteTorrentDashboard/test/node/source-paths.test.mjs`
//           is its unit test.
//
// Deps    : node:fs, node:path, node:url only.
//
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Walk upward from `startDir`, at each level reading `package.json` if
 * present, and return the first directory whose `package.json` parses with
 * `name === 'votetorrent'` and a truthy `workspaces` key. Depth-independent
 * by construction — no `'..', '..'` hop count is hard-coded anywhere in this
 * walk, which is what makes the whole module relocatable.
 *
 * @param {string} startDir
 * @returns {string}
 */
function findRepoRoot(startDir) {
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
				// Not parseable as JSON, or not the marker file — keep walking.
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			throw new Error(
				`scripts/lib/source-paths.mjs: walked up to filesystem root without finding the ` +
					`repo-root package.json (name === 'votetorrent' with a 'workspaces' key), ` +
					`starting from ${startDir}`,
			);
		}
		dir = parent;
	}
}

/**
 * The repository root, computed once at module load by walking upward from
 * this module's own directory. Cwd-independent by construction — this module
 * never reads the current working directory.
 *
 * @type {string}
 */
export const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Containment invariant (mitigates T-53-01-02). Every exported path-building
 * function routes its result through this before returning it. A `..`
 * segment that escapes the repo is a bug at the call site, and the resolver
 * refuses rather than silently reading outside the tree.
 *
 * @param {string} candidate
 * @returns {string}
 */
function assertContained(candidate) {
	const normalised = path.normalize(candidate);
	const relative = path.relative(repoRoot, normalised);
	if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(
			`scripts/lib/source-paths.mjs: refusing a path that escapes the repository root ` +
				`(${repoRoot}): resolved to ${normalised}`,
		);
	}
	return normalised;
}

/**
 * The generic cross-workspace escape hatch: joins `repoRoot`, a repo-relative
 * workspace directory such as `packages/vote-core` or `apps/VoteTorrentAuthority`,
 * and any further path segments. Pure joining — does not check existence.
 *
 * @param {string} workspaceRelPath
 * @param {...string} segs
 * @returns {string}
 */
export function workspacePath(workspaceRelPath, ...segs) {
	return assertContained(path.join(repoRoot, workspaceRelPath, ...segs));
}

/** @param {...string} segs @returns {string} */
export function dashboardRoot(...segs) {
	return workspacePath('apps/VoteTorrentDashboard', ...segs);
}

/** @param {...string} segs @returns {string} */
export function dashboardSrc(...segs) {
	return dashboardRoot('src', ...segs);
}

/**
 * `packages/ui-web` does not exist yet as of Phase 53 wave 1. This function
 * is named here deliberately so waves 2-4 repoint a call argument rather
 * than re-deriving a root. Pure joining, no existence check.
 *
 * @param {...string} segs
 * @returns {string}
 */
export function uiWebRoot(...segs) {
	return workspacePath('packages/ui-web', ...segs);
}

/** @param {...string} segs @returns {string} */
export function uiWebSrc(...segs) {
	return uiWebRoot('src', ...segs);
}

/**
 * `apps/VoteTorrentPublic` does not exist yet as of Phase 53 wave 1. Same
 * rationale as `uiWebRoot` — named ahead of the directory's creation.
 *
 * @param {...string} segs
 * @returns {string}
 */
export function publicRoot(...segs) {
	return workspacePath('apps/VoteTorrentPublic', ...segs);
}

/** @param {...string} segs @returns {string} */
export function publicSrc(...segs) {
	return publicRoot('src', ...segs);
}

/**
 * `packages/web-data` does not exist yet as of Phase 54 wave 1. This function
 * is named here deliberately so 54-03's move repoints a call argument rather
 * than re-deriving a root. Pure joining, no existence check. This root is
 * JSX-free by charter and is therefore deliberately NOT added to
 * `scripts/lint-copy.mjs`'s `ROOTS` list — that scanner fails (rather than
 * skips) a root that walks to zero `.tsx` files.
 *
 * @param {...string} segs
 * @returns {string}
 */
export function webDataRoot(...segs) {
	return workspacePath('packages/web-data', ...segs);
}

/** @param {...string} segs @returns {string} */
export function webDataSrc(...segs) {
	return webDataRoot('src', ...segs);
}

/**
 * Returns the `file://` href string for a dynamic `import()` call, built
 * with `pathToFileURL` (never string concatenation) so idioms 2 and 3 have
 * a resolver-shaped form.
 *
 * @param {string} absolutePath
 * @returns {string}
 */
export function moduleUrl(absolutePath) {
	return pathToFileURL(absolutePath).href;
}
