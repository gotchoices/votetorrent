/**
 * election-harness.test.mjs — the seven lettered assertions from 53-07 Task
 * 3 over the test-only fixture, the harness entry, and the two-out-dir
 * split. Every path is resolved through `scripts/lib/source-paths.mjs`'s
 * `publicSrc()`/`publicRoot()` (D-25/53-01).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { publicSrc, publicRoot, repoRoot } from '../../../../scripts/lib/source-paths.mjs';
import { derivePhase, PHASE_IDS } from '../../../../packages/ui-web/src/lifecycle/election-phase.js';
import { FIXTURE_ELECTION, FIXTURE_ELECTION_TIMELINE_JSON, FIXTURE_INSTANTS } from '../fixtures/election-fixture.js';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

/** @param {string} dir @returns {string[]} */
function walkAll(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkAll(full));
		} else {
			out.push(full);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// 1. Fixture coherence, total over PHASE_IDS, over BOTH live timeline shapes
//    (Phase 54, D-08 / contract C6).
// ---------------------------------------------------------------------------

test('every PHASE_IDS member derives its own phase from FIXTURE_ELECTION.timeline at its own FIXTURE_INSTANTS entry, from BOTH the object and JSON-string timeline shapes, with indeterminate === false and zero conflicts', () => {
	assert.ok(PHASE_IDS.length > 0, 'sanity: PHASE_IDS must be non-empty');
	/** @type {Array<[string, unknown]>} */
	const shapes = [
		['object', FIXTURE_ELECTION.timeline],
		['json-string', FIXTURE_ELECTION_TIMELINE_JSON],
	];
	for (const [shapeLabel, timeline] of shapes) {
		for (const id of PHASE_IDS) {
			const result = derivePhase(FIXTURE_ELECTION, timeline, FIXTURE_INSTANTS[id]);
			assert.equal(
				result.phase,
				id,
				`[${shapeLabel}] FIXTURE_INSTANTS.${id} did not derive phase "${id}" (got ${JSON.stringify(result)})`,
			);
			assert.equal(
				result.indeterminate,
				false,
				`[${shapeLabel}] FIXTURE_INSTANTS.${id} derived indeterminate === true (got ${JSON.stringify(result)})`,
			);
			assert.deepEqual(
				result.conflicts,
				[],
				`[${shapeLabel}] FIXTURE_INSTANTS.${id} derived a non-empty conflicts array: ${JSON.stringify(result.conflicts)}`,
			);
		}
	}
});

test('FIXTURE_ELECTION_TIMELINE_JSON is JSON.parse-equivalent to FIXTURE_ELECTION.timeline (the derived-not-duplicated construction in election-fixture.js is verifiable, not merely intended)', () => {
	assert.deepEqual(JSON.parse(FIXTURE_ELECTION_TIMELINE_JSON), FIXTURE_ELECTION.timeline);
});

// D-08's tripwire. It DID trip during Phase 54: PHASE_IDS grew a fourth
// member (`closed`), and this assertion went red until 54-05 extended
// FIXTURE_INSTANTS to four entries (see election-fixture.js). That is
// D-08's whole point -- a fourth phase must trip this test LOUDLY, and the
// answer is extending the fixture, never narrowing this comparison. Any
// future attempt to make this pass by relaxing the set-equality assertion
// below (rather than extending the fixture) is a regression of D-08.
test('Object.keys(FIXTURE_INSTANTS) equals PHASE_IDS as a set (a fourth phase in Phase 54 would fail this loudly, not skip silently)', () => {
	const instantKeys = new Set(Object.keys(FIXTURE_INSTANTS));
	const phaseIds = new Set(PHASE_IDS);
	assert.deepEqual([...instantKeys].sort(), [...phaseIds].sort());
});

test('PHASE_IDS does not contain "indeterminate" (contract C1: an indeterminate outcome has no derivable instant, and admitting it to PHASE_IDS would make the set-equality assertion above unsatisfiable without weakening it)', () => {
	// Cast to ReadonlyArray<string> before .includes('indeterminate'): PHASE_IDS
	// is typed as the narrow PhaseId union under strict+checkJs, which does not
	// admit 'indeterminate' as a comparable member (matches 54-02's own
	// precedent for this exact class of diagnostic).
	const ids = /** @type {ReadonlyArray<string>} */ (PHASE_IDS);
	assert.ok(!ids.includes('indeterminate'), `PHASE_IDS must not contain "indeterminate", got: ${JSON.stringify(PHASE_IDS)}`);
});

// ---------------------------------------------------------------------------
// 2. The fixture is unreachable from production.
// ---------------------------------------------------------------------------

const FIXTURE_IMPORT_RE = /(\.\.\/)*test\/|election-fixture|fixtures\//;

test('positive control: the fixture-unreachability matcher fires on a planted import specifier', () => {
	assert.match("import x from '../../test/fixtures/election-fixture.js';", FIXTURE_IMPORT_RE);
});

test('no file under src/ contains an import specifier reaching test/, election-fixture, or fixtures/', () => {
	const files = walkAll(publicSrc());
	const offenders = [];
	for (const file of files) {
		const stripped = stripComments(readFileSync(file, 'utf8'));
		if (FIXTURE_IMPORT_RE.test(stripped)) offenders.push(file);
	}
	assert.deepEqual(offenders, [], `these src/ files reach the test-only fixture: ${offenders.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 3. Stylesheet parity.
// ---------------------------------------------------------------------------

const CSS_IMPORT_RE = /import\s+['"]([^'"]+\.css)['"]/g;

/** @param {string} source @returns {string[]} */
function cssSpecifiersOf(source) {
	/** @type {string[]} */
	const specifiers = [];
	let m;
	const re = new RegExp(CSS_IMPORT_RE.source, 'g');
	while ((m = re.exec(source))) specifiers.push(m[1]);
	return specifiers;
}

/** @param {string} baseDir @param {string} specifier @returns {string} */
function normaliseToRepoRoot(baseDir, specifier) {
	return path.relative(repoRoot, path.resolve(baseDir, specifier));
}

test('every stylesheet specifier imported by src/main.tsx is also imported by test/browser/election-shell-gate.tsx (normalising the relative prefix)', () => {
	const mainSource = readFileSync(publicSrc('main.tsx'), 'utf8');
	const gateSource = readFileSync(publicRoot('test', 'browser', 'election-shell-gate.tsx'), 'utf8');

	const mainSpecifiers = cssSpecifiersOf(mainSource); // relative to src/
	const gateSpecifiers = cssSpecifiersOf(gateSource); // relative to test/browser/

	assert.ok(mainSpecifiers.length > 0, 'sanity: main.tsx must import at least one stylesheet');

	const mainNormalised = mainSpecifiers.map((s) => normaliseToRepoRoot(publicSrc(), s));
	const gateNormalised = gateSpecifiers.map((s) => normaliseToRepoRoot(publicRoot('test', 'browser'), s));

	const missing = mainNormalised.filter((s) => !gateNormalised.includes(s));
	assert.deepEqual(missing, [], `election-shell-gate.tsx is missing stylesheet specifier(s): ${missing.join(', ')}`);
});

test('positive control: the specifier list is non-empty on both sides right now (sanity a future removal would have something to be absent from)', () => {
	const gateSource = readFileSync(publicRoot('test', 'browser', 'election-shell-gate.tsx'), 'utf8');
	assert.ok(cssSpecifiersOf(gateSource).length > 0, 'election-shell-gate.tsx currently imports at least one stylesheet');
});

// ---------------------------------------------------------------------------
// 4. Gate-config inheritance.
// ---------------------------------------------------------------------------

const GATE_CONFIG_SOURCE = stripComments(readFileSync(publicRoot('vite.gate.config.ts'), 'utf8'));

test('positive control: a fixture declaring resolve: { dedupe: [] } trips the forbidden-own-resolve matcher', () => {
	assert.match('export default { resolve: { dedupe: [] } };', /\bresolve\s*:/);
});

test('vite.gate.config.ts imports ./vite.config, calls mergeConfig, and declares no top-level resolve/plugins/server key', () => {
	assert.match(GATE_CONFIG_SOURCE, /from\s+'\.\/vite\.config'/);
	assert.match(GATE_CONFIG_SOURCE, /mergeConfig\(/);
	assert.doesNotMatch(GATE_CONFIG_SOURCE, /\bresolve\s*:/);
	assert.doesNotMatch(GATE_CONFIG_SOURCE, /\bplugins\s*:/);
	assert.doesNotMatch(GATE_CONFIG_SOURCE, /\bserver\s*:/);
});

// ---------------------------------------------------------------------------
// 5. Production build stays single-entry.
// ---------------------------------------------------------------------------

test('vite.config.ts contains no rollupOptions/input, and package.json\'s build script is exactly "vite build"', () => {
	const viteConfigSource = stripComments(readFileSync(publicRoot('vite.config.ts'), 'utf8'));
	assert.doesNotMatch(viteConfigSource, /rollupOptions/);
	assert.doesNotMatch(viteConfigSource, /\binput\s*:/);
	const manifest = JSON.parse(readFileSync(publicRoot('package.json'), 'utf8'));
	assert.equal(manifest.scripts.build, 'vite build');
});

// ---------------------------------------------------------------------------
// 6. The two out dirs are distinct and the gate one is ignored.
// ---------------------------------------------------------------------------

test('vite.gate.config.ts names dist-gate, .gitignore contains it, git check-ignore succeeds, and clean names it', () => {
	assert.match(GATE_CONFIG_SOURCE, /outDir\s*:\s*'dist-gate'/);

	const gitignoreSource = readFileSync(publicRoot('.gitignore'), 'utf8');
	assert.match(gitignoreSource, /dist-gate/);

	const manifest = JSON.parse(readFileSync(publicRoot('package.json'), 'utf8'));
	assert.match(manifest.scripts.clean, /dist-gate/);

	// git check-ignore exits 0 when the path IS ignored -- run it from the
	// repo root so it resolves relative to the actual working tree, not this
	// process's cwd.
	let ignored = false;
	try {
		execFileSync('git', ['check-ignore', 'apps/VoteTorrentPublic/dist-gate'], { cwd: repoRoot, stdio: 'pipe' });
		ignored = true;
	} catch {
		ignored = false;
	}
	assert.ok(ignored, 'expected `git check-ignore apps/VoteTorrentPublic/dist-gate` to exit 0');
});

// ---------------------------------------------------------------------------
// 7. The harness forges no production token.
// ---------------------------------------------------------------------------

test('election-shell-gate.tsx contains no __PUBLIC_APP__ and no engine-preflight import', () => {
	const gateSource = readFileSync(publicRoot('test', 'browser', 'election-shell-gate.tsx'), 'utf8');
	assert.doesNotMatch(gateSource, /__PUBLIC_APP__/);
	assert.doesNotMatch(gateSource, /engine-preflight/);
});

test("sanity: the harness entry files really are on disk", () => {
	assert.ok(existsSync(publicRoot('test', 'browser', 'election-shell-gate.tsx')));
	assert.ok(existsSync(publicRoot('test', 'browser', 'election-shell-gate.html')));
});
