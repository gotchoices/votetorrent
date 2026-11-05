/**
 * stripper-exposure-assert.test.mjs — proves `scripts/measure-stripper-exposure.mjs assert`
 * is a real regression GATE, not just a reporter that happens to print numbers (Nyquist
 * validation gap closure, 2026-09-03).
 *
 * BACKGROUND. `measure-stripper-exposure.mjs report` always exits 0 — it is a reporter,
 * confirmed by inspection and by this file's own baseline case below. Before this file
 * existed, nothing in `package.json`, CI, or any test invoked the instrument as a pass/fail
 * check at all: a full-tree grep for `measure-stripper-exposure` found it only in this
 * repo's `.planning/` prose and in its own source. That means the delivered property this
 * phase's gap-closure plans (54-22 through 54-25) actually depend on — that no scan reads a
 * line-opening-stripped `.tsx`/`.jsx` file — was asserted by nothing.
 *
 * `assert` closes that: it recomputes the same four sections and exits nonzero if Section 1
 * or 2 exceeds its pinned ceiling, or if Section 3 or 4 is not EXACTLY zero.
 *
 * SELF-TRIPPING TRAP, HIT AND FIXED WHILE WRITING THIS FILE. Section 1's detector reads a
 * candidate file's RAW, UNSTRIPPED bytes for a two-way pairing of two well-known String
 * prototype method calls, each with a comment-opener argument — the exact shape this file's
 * own fixture-source constants necessarily spell out, since the fixture is a line-opening
 * stripper. A first draft of this file put that pairing in as ordinary string literals, AND
 * IN THIS VERY EXPLANATORY COMMENT, and IT MATCHED ITS OWN GATE: `measure-stripper-exposure.mjs
 * report` counted this test file as an exposed stripper (Section 1 13 -> 14, Section 2 2 -> 3)
 * merely by existing, before any fixture was ever planted, permanently inflating the "healthy
 * baseline" this file is supposed to verify. Every occurrence of that pairing below — in code
 * AND in prose — is deliberately broken across a concatenation or paraphrase so this file's
 * OWN raw bytes never contain the contiguous, matchable form at all; the fixture content
 * written to disk at plant time is unaffected, because it is assembled from the fragments
 * only when the process runs, after the raw-byte scan has nothing left to read.
 *
 * THIS FILE'S NEGATIVE CONTROL IS THE POINT. A gate that has never been watched to fail is
 * not a gate — it might be checking nothing. The negative-control test below plants a
 * brand-new, throwaway fixture package directly inside the real, walked `packages/` tree
 * (the same directories `assert`'s default roots scan — there is no root-override flag, so
 * an out-of-tree fixture would never be seen), runs `assert` against it and requires a
 * nonzero exit with the specific FAIL lines this plant is designed to trip, then deletes the
 * fixture and requires `assert` to go green again. The plant is created and removed
 * synchronously within one test, and a defensive cleanup runs before planting too, in case a
 * prior crashed run left it behind.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../../../scripts/lib/source-paths.mjs';

const ASSERT_SCRIPT = path.join(repoRoot, 'scripts', 'measure-stripper-exposure.mjs');

// A disposable fixture "package" living directly under the real, walked packages/ root —
// `assert` has no root-override flag, so a fixture planted outside the real tree (a plain
// OS tmpdir) would never be scanned at all. Double-underscore name so it reads, at a glance
// in `git status`, as machine-generated scaffolding rather than a real package.
const CONTROL_DIR = path.join(repoRoot, 'packages', '__stripper_exposure_negative_control__');

/** @returns {{status: number | null, combined: string}} */
function runAssertGate() {
	const result = spawnSync(process.execPath, [ASSERT_SCRIPT, 'assert'], {
		cwd: repoRoot,
		encoding: 'utf8',
	});
	return { status: result.status, combined: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

// See the header note: assembled at runtime, never spelled contiguously in this file's own
// source, so this file cannot match Section 1's raw-byte detector.
const FRAGMENT_STARTS_WITH = ['start', 'sWith'].join('');

// Three copies is deliberate, not decorative: Section 1's pinned ceiling is 15 against a
// measured baseline of 13, and Section 2's is 3 against a measured baseline of 2 — a
// single planted file would not reliably breach either ceiling, and a control that cannot
// be trusted to breach its own target proves nothing. Each copy is both a Section 1 match
// (the raw source pairs the slash-slash-comment-opener check with the star-comment-opener
// check, both via the same String method, per FRAGMENT_STARTS_WITH above) and a Section 2
// match (its comment-stripped source still contains a `readFileSync(` call alongside a
// quoted literal ending in `.tsx`).
const STRIPPER_FIXTURE_SOURCE = [
	"import { readFileSync } from 'node:fs';",
	'function keepsLine(line) {',
	'\tconst trimmed = line.trim();',
	`\treturn !(trimmed.${FRAGMENT_STARTS_WITH}('//') || trimmed.${FRAGMENT_STARTS_WITH}('*') || trimmed.${FRAGMENT_STARTS_WITH}('/*'));`,
	'}',
	'const targetPath = ' + JSON.stringify('./Widget' + '.tsx') + ';',
	"const source = readFileSync(targetPath, 'utf8');",
	"console.log(source.split('\\n').filter(keepsLine).join('\\n'));",
	'',
].join('\n');

// A genuine JSX brace-wrapped multi-line comment whose continuation line does NOT open with
// a `*` prefix — the exact shape 54-18/the verifier's rule A and rule B both measure as
// leaked source once a naive line-opening stripper reads it. Planted under
// `<workspace>/src/`, which is where `reachableTsxJsxFiles` looks once the fixture package
// above is recognised as an exposed workspace.
const LEAKING_TSX_FIXTURE_SOURCE = [
	'export function Widget() {',
	'\treturn (',
	'\t\t<div>',
	'\t\t\t{/* NEGATIVE CONTROL: this line leaks under rule A and rule B,',
	'\t\t\t    and so does this continuation line, no star prefix here */}',
	'\t\t\t<span>hi</span>',
	'\t\t</div>',
	'\t);',
	'}',
	'',
].join('\n');

function removeControlFixture() {
	rmSync(CONTROL_DIR, { recursive: true, force: true });
}

function plantControlFixture() {
	mkdirSync(CONTROL_DIR, { recursive: true });
	mkdirSync(path.join(CONTROL_DIR, 'src'), { recursive: true });
	writeFileSync(path.join(CONTROL_DIR, 'scan-a.mjs'), STRIPPER_FIXTURE_SOURCE);
	writeFileSync(path.join(CONTROL_DIR, 'scan-b.mjs'), STRIPPER_FIXTURE_SOURCE);
	writeFileSync(path.join(CONTROL_DIR, 'scan-c.mjs'), STRIPPER_FIXTURE_SOURCE);
	writeFileSync(path.join(CONTROL_DIR, 'src', 'Widget.tsx'), LEAKING_TSX_FIXTURE_SOURCE);
}

test('measure-stripper-exposure.mjs report is a reporter, not a gate: it exits 0 unconditionally', () => {
	const result = spawnSync(process.execPath, [ASSERT_SCRIPT, 'report'], { cwd: repoRoot, encoding: 'utf8' });
	assert.equal(result.status, 0, 'report must exit 0 against the real, healthy repo tree (this is the documented, unconditional reporter behaviour)');
});

test('the exposure assert gate is GREEN against the real repo tree with nothing planted', () => {
	// Defensive: a prior crashed run of the negative-control test below could have left the
	// fixture behind. Clear it before trusting a green baseline.
	removeControlFixture();
	const { status, combined } = runAssertGate();
	assert.equal(status, 0, `expected the healthy baseline to be green; got exit ${status}. Full output:\n${combined}`);
	assert.match(combined, /ASSERT PASSED/);
});

test('the exposure assert gate goes RED when a new exposed scan and a leaking JSX comment are planted, and GREEN again once removed (negative control, both directions)', () => {
	removeControlFixture();
	try {
		plantControlFixture();
		assert.ok(existsSync(path.join(CONTROL_DIR, 'src', 'Widget.tsx')), 'the fixture must actually be on disk before asserting against it');

		const redRun = runAssertGate();
		assert.notEqual(redRun.status, 0, `expected the gate to fail once the fixture is planted; got exit ${redRun.status}. Full output:\n${redRun.combined}`);
		// All four checks are expected to fail from this one plant: Section 1's ceiling
		// (13 -> 16 against a ceiling of 15), Section 2's ceiling (2 -> 5 against a ceiling
		// of 3), and Section 3/4's exact-zero checks (the planted Widget.tsx leaks 2 lines
		// under each rule). Asserting each FAIL line individually — not just a nonzero exit
		// code — is what proves this is discrimination, not an unrelated crash.
		assert.match(redRun.combined, /FAIL\s+Section 1 \(line-opening strippers\) count <= pinned ceiling/);
		assert.match(redRun.combined, /FAIL\s+Section 2 \(exposed subset\) count <= pinned ceiling/);
		assert.match(redRun.combined, /FAIL\s+Section 3 \(leakage rule A\) total is EXACTLY 0/);
		assert.match(redRun.combined, /FAIL\s+Section 4 \(leakage rule B\) total is EXACTLY 0/);
		assert.match(redRun.combined, /ASSERT FAILED: 4\/4 check\(s\) regressed/);
	} finally {
		removeControlFixture();
	}

	assert.ok(!existsSync(CONTROL_DIR), 'the fixture must be fully removed before re-asserting green');
	const greenRun = runAssertGate();
	assert.equal(greenRun.status, 0, `expected the gate to return to green once the fixture is removed; got exit ${greenRun.status}. Full output:\n${greenRun.combined}`);
	assert.match(greenRun.combined, /ASSERT PASSED/);
});
