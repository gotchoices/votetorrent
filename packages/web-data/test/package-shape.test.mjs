/**
 * package-shape.test.mjs — the tier-1 proof that `@votetorrent/web-data`'s
 * shape properties are falsifiable, not merely asserted. Modelled rung-for-
 * rung on `packages/ui-web/test/package-shape.test.mjs` — see that file's
 * header for the two forbidden vacuous shapes this file also avoids:
 *   - Do not interpolate a value under test into a test's NAME.
 *   - Do not use an always-true disjunct in an assertion's condition.
 *
 * What each rung catches:
 *   1. The exports map has exactly two keys, `./public` and `./officer`,
 *      mapping to their expected targets.
 *   2. The map has NO `"."` key — the D-04 structural claim. Proven with
 *      `Object.prototype.hasOwnProperty`, plus a positive control that the
 *      same check fires against a synthetic manifest object that DOES have
 *      one (so this rung cannot be vacuously true).
 *   3. Both subpath targets resolve to files that exist on disk.
 *   4. `@votetorrent/web-data/public` is Node-importable with no bundler.
 *   5. The three peer-declared packages (`@quereus/quereus`,
 *      `@quereus/plugin-indexeddb`, `@votetorrent/vote-engine`) appear in
 *      BOTH `peerDependencies` and `devDependencies` — the ui-web TS2875
 *      guard, one instance more, with one measured exception: `yarn install`
 *      REJECTS a `patch:` resolution-protocol descriptor in `peerDependencies`
 *      (a peer range must be a plain semver range, not a resolution
 *      descriptor — confirmed live: `yarn install` rewrote an attempted
 *      literal-copy peer entry to `"*"`, silently discarding the version
 *      guard). So `@quereus/quereus`'s peer entry is the plain version the
 *      patch is based on (`4.17.1`), asserted as a substring of the patched
 *      devDependencies descriptor rather than a literal-string match; the
 *      other two peers, which carry no patch protocol, ARE asserted by exact
 *      string equality.
 *   6. `@votetorrent/ui-web` appears in none of this package's dependency
 *      blocks — this package has no UI charter and must not acquire the
 *      dedupe/gate-script obligation `scripts/assert-ui-web-dedupe-and-gate.mjs`
 *      imposes on ui-web consumers.
 *   7. The `./officer` barrel exports the whole live-store surface (the live
 *      store open, the change-notice seam and the registry additions) and
 *      still exports the snapshot-era attach and row-count writer, which
 *      stay until their scheduled retirement.
 *   8. The `./public` barrel exports NONE of the live-store names (D-04
 *      audience split), plus a positive control: the same absence check
 *      fires against a synthetic module object that has one of them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(HERE, '..');

const PKG = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));

test('rung 1: the exports map is exactly two keys, ./public and ./officer, mapping to their expected targets', () => {
	assert.deepEqual(Object.keys(PKG.exports), ['./public', './officer']);
	assert.equal(PKG.exports['./public'], './src/public/index.js');
	assert.equal(PKG.exports['./officer'], './src/officer/index.js');
});

test('rung 2: the exports map has no "." key (D-04 — a bare "." would let a consumer reach both audiences through one specifier)', () => {
	assert.equal(Object.prototype.hasOwnProperty.call(PKG.exports, '.'), false);
});

test('rung 2 (positive control): the hasOwnProperty check fires against a synthetic manifest that DOES have a "." key', () => {
	const syntheticExports = { '.': './src/index.js', './public': './src/public/index.js' };
	assert.equal(Object.prototype.hasOwnProperty.call(syntheticExports, '.'), true);
});

test('rung 3: both subpath targets resolve to files that exist', () => {
	for (const target of Object.values(PKG.exports)) {
		const resolved = path.join(PACKAGE_ROOT, target);
		assert.ok(existsSync(resolved), `expected ${resolved} to exist`);
	}
});

test('rung 4: the real ./public subpath is Node-importable with no bundler', async () => {
	const mod = await import('@votetorrent/web-data/public');
	assert.equal(typeof mod, 'object');
	assert.notEqual(mod, null);
});

test('rung 5: @quereus/plugin-indexeddb and @votetorrent/vote-engine appear in BOTH peerDependencies and devDependencies at identical version strings (TS2875 guard)', () => {
	const exactMatchDeps = ['@quereus/plugin-indexeddb', '@votetorrent/vote-engine'];
	for (const dep of exactMatchDeps) {
		assert.ok(dep in PKG.peerDependencies, `peerDependencies must declare "${dep}"`);
		assert.ok(dep in PKG.devDependencies, `devDependencies must declare "${dep}"`);
		assert.equal(
			PKG.peerDependencies[dep],
			PKG.devDependencies[dep],
			`peerDependencies.${dep} and devDependencies.${dep} must be identical version strings`,
		);
	}
});

test('rung 5b: @quereus/quereus appears in BOTH peerDependencies and devDependencies; peer carries the plain version, dev carries the patch descriptor built on it (yarn rejects a patch: descriptor as a peer range)', () => {
	const dep = '@quereus/quereus';
	assert.ok(dep in PKG.peerDependencies, `peerDependencies must declare "${dep}"`);
	assert.ok(dep in PKG.devDependencies, `devDependencies must declare "${dep}"`);
	const peerVersion = PKG.peerDependencies[dep];
	const devVersion = PKG.devDependencies[dep];
	assert.match(peerVersion, /^\d+\.\d+\.\d+$/, `peerDependencies.${dep} must be a plain semver version, got "${peerVersion}"`);
	assert.match(devVersion, /^patch:/, `devDependencies.${dep} must be the patch: resolution descriptor, got "${devVersion}"`);
	assert.ok(
		devVersion.includes(peerVersion),
		`devDependencies.${dep}'s patch descriptor must be built on the exact version peerDependencies.${dep} names`,
	);
});

test('rung 6: @votetorrent/ui-web appears in none of this package\'s dependency blocks', () => {
	const fieldsToCheck = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
	for (const field of fieldsToCheck) {
		const section = PKG[field] ?? {};
		assert.equal(
			'@votetorrent/ui-web' in section,
			false,
			`${field} must never declare "@votetorrent/ui-web" — this package has no UI charter`,
		);
	}
});

/** The live-store names only the officer audience may see. */
const OFFICER_LIVE_NAMES = Object.freeze([
	'attachLiveDb',
	'LiveStoreMissingError',
	'LiveStoreUnavailableError',
	'PAIRING_TABLES',
	'ADMIN_PANEL_AND_GATE_TABLES',
	'OFFICER_SUBSCRIBED_TABLES',
	'OFFICER_CHANGE_OPS',
	'OFFICER_CHANGE_CHANNEL_PREFIX',
	'officerChangeChannelName',
	'notifyOfficerPeerWrite',
	'subscribeToOfficerChanges',
	'isLegacyEntry',
	'recordLastPassAt',
	'PAIRING_RELAY_ADDRS_MAX',
]);

/**
 * @param {object} mod
 * @returns {string[]}
 */
function liveNamesExportedBy(mod) {
	return OFFICER_LIVE_NAMES.filter((name) => Object.prototype.hasOwnProperty.call(mod, name));
}

test('rung 7: the ./officer barrel exports every live-store name and keeps the snapshot-era exports', async () => {
	const mod = await import('@votetorrent/web-data/officer');
	assert.deepEqual(liveNamesExportedBy(mod), [...OFFICER_LIVE_NAMES]);
	assert.equal(typeof mod.attachLiveDb, 'function');
	assert.equal(typeof mod.subscribeToOfficerChanges, 'function');
	assert.equal(mod.PAIRING_RELAY_ADDRS_MAX, 16);
	assert.equal(typeof mod.attachNetworkDb, 'function');
	assert.equal(typeof mod.writeRowCounts, 'function');
});

test('rung 8 (positive control): the absence check fires against a synthetic module that has a live-store name', () => {
	const synthetic = { listNetworks() {}, attachLiveDb() {} };
	assert.deepEqual(liveNamesExportedBy(synthetic), ['attachLiveDb']);
});

test('rung 8: the ./public barrel exports none of the live-store names', async () => {
	const mod = await import('@votetorrent/web-data/public');
	assert.deepEqual(liveNamesExportedBy(mod), []);
});
