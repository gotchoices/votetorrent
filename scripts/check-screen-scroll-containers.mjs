#!/usr/bin/env node
/**
 * check-screen-scroll-containers.mjs — 57-18 gap closure (UAT-10, tier 1).
 *
 * The missing-scroll-container defect class: a `*Screen.tsx` in either RN
 * app (Authority, Voter) rendering no reachable scroll container, so
 * content below the fold is permanently stranded on a stock-density
 * device. 57-16 found and fixed the first instance (Authority
 * `SettingsScreen.tsx`); 57-17's enumerated sweep
 * (`57-17-SCROLL-TRIAGE.md`) found and fixed the rest. This script is the
 * regression guard that keeps the class closed, wired into the blocking
 * root `lint` chain (see `package.json`) rather than left opt-in — an
 * opt-in gate that nothing runs is the same as no gate
 * (`check-peer-requirements.mjs`'s own reasoning, followed verbatim here).
 *
 * WHAT THIS GATE PROVES, AND AT WHAT STRENGTH: it is a STATIC STRUCTURAL
 * gate — it inspects source text, never a rendered tree and never a real
 * viewport. It proves a scroll container EXISTS somewhere reachable from a
 * screen's render tree. It does NOT prove that container has nonzero
 * height, that scrolling reaches the last control, or that nothing is
 * clipped by a footer/tab-bar/IME. The full blind-spot list, and the two
 * other tiers that cover part of what this one cannot see, are written
 * down in `57-18-GATE-CONTROL.md` rather than implied by a green run here.
 *
 * CLASSIFICATION, per `*Screen.tsx` found under each root, applied to a
 * source that has had (1) block comments, then (2) line comments, then
 * (3) string-literal contents stripped, in that order — block comments
 * first, so a `//` sequence inside a block comment is never mistaken for a
 * line-comment opener once the block comment is gone:
 *
 *   1. CLEAN if the stripped source contains a JSX OPENING TAG for
 *      `ScrollView`, `FlatList`, `SectionList`, `KeyboardAwareScrollView`
 *      or `Animated.ScrollView` — matched on the `<` prefix, never on a
 *      bare identifier, so an import that is never rendered does not
 *      satisfy the gate.
 *   2. Otherwise CLEAN if the screen has a `DELEGATES_TO` entry, VERIFIED
 *      (not trusted) by reading the named child file, stripping it the
 *      same way, and applying rule 1 to IT. A child that no longer scrolls
 *      turns the screen into a VIOLATION, and a `DELEGATES_TO` entry whose
 *      screen or child file no longer exists on disk is a VIOLATION too —
 *      a stale entry is loud, never inert (see the mapping-integrity
 *      check below, which runs once before any root is scanned).
 *   3. Otherwise CLEAN if the screen has an `EXCLUSIONS` entry whose
 *      mechanical predicate currently holds. A predicate that stops
 *      holding re-arms the screen as a VIOLATION; an exclusion whose file
 *      is missing is a VIOLATION.
 *   4. Otherwise VIOLATION, naming which of the three escape hatches the
 *      screen would need.
 *
 * THE SELF-TRIPPING HAZARD, and which direction it runs here: this repo
 * has three recorded incidents of a checker whose own comment quoted the
 * pattern it grepped for, leaving it permanently green. Here the hazard
 * runs in the SCANNED files, not this scanner: a screen's own doc comment
 * or a `testID` string could contain the word the matcher looks for, and a
 * naive matcher would treat that as a real scroll container. That is
 * exactly why comments and string-literal contents are stripped before
 * matching — the per-root inertness control below proves that stripping is
 * actually live, not merely claimed.
 *
 * Structure follows `scripts/lint-copy.mjs`: dependency-free ESM, node
 * builtins plus the two shared repo-tooling modules
 * (`scripts/lib/source-paths.mjs`, `scripts/lib/strip-comments.mjs`), one
 * `OK:` line per completed step on stdout, `FAIL:` lines on stderr,
 * violations accumulated across ALL roots so a report never silently
 * shrinks from two roots to one, `process.exit(1)` on any violation.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from './lib/source-paths.mjs';
import { stripComments } from './lib/strip-comments.mjs';

const PREFIX = '[check-screen-scroll-containers]';

/** @param {string} message */
function ok(message) {
	process.stdout.write(`${PREFIX} OK: ${message}\n`);
}

/** @param {string} message */
function fail(message) {
	process.stderr.write(`${PREFIX} FAIL: ${message}\n`);
	process.exit(1);
}

/** @param {string} message */
function controlFailed(message) {
	process.stderr.write(`${PREFIX} CONTROL FAILED: ${message}\n`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// String-literal stripper. `stripComments` (shared, from `strip-comments.mjs`)
// removes block and line comments while tracking quote state so a `//`
// inside a string survives; it deliberately leaves string CONTENTS intact.
// This gate needs those contents neutralised too — the plan's inertness
// control requires a token that appears ONLY inside a double-quoted string
// to be invisible to the matcher, exactly the class the D-06/D-09-style
// gates in this repo strip before scanning.
//
// ACCEPTED LIMITATION (stated, not hidden): a `${...}` interpolation inside
// a template literal is tracked only by brace depth, not by re-entering full
// quote/string tracking for code nested inside it. No screen file in this
// repo puts JSX markup inside a template-literal interpolation, so this is
// the same class of accepted, documented gap `strip-comments.mjs` itself
// carries for multi-line templates.
// ---------------------------------------------------------------------------

/** @param {string} source @returns {string} */
function stripStringLiterals(source) {
	let out = '';
	let i = 0;
	const n = source.length;
	/** @type {string | null} */
	let quote = null;
	let interpDepth = 0;
	while (i < n) {
		const c = source[i];
		const c2 = i + 1 < n ? source[i + 1] : '';
		if (interpDepth > 0) {
			if (c === '{') interpDepth += 1;
			else if (c === '}') {
				interpDepth -= 1;
				if (interpDepth === 0) {
					out += c;
					i += 1;
					quote = '`';
					continue;
				}
			}
			out += c;
			i += 1;
			continue;
		}
		if (quote === null) {
			if (c === "'" || c === '"' || c === '`') {
				quote = c;
				out += c;
				i += 1;
				continue;
			}
			out += c;
			i += 1;
			continue;
		}
		if (quote === '`' && c === '$' && c2 === '{') {
			interpDepth = 1;
			out += c + c2;
			i += 2;
			continue;
		}
		if (c === '\\') {
			// Escape sequence inside a string: neutralise both characters
			// without collapsing the length (keeps line/offset math sane).
			out += '  ';
			i += 2;
			continue;
		}
		if (c === quote) {
			quote = null;
			out += c;
			i += 1;
			continue;
		}
		out += c === '\n' ? '\n' : ' ';
		i += 1;
	}
	return out;
}

/**
 * JSX opening tag for a scroll container. Matched on the `<` prefix only —
 * a bare identifier (e.g. an unused import, or the name appearing only in
 * a type position) must never satisfy this.
 */
const SCROLL_TAG_RE = /<(ScrollView|FlatList|SectionList|KeyboardAwareScrollView|Animated\.ScrollView)\b/;

/** @param {string} source @returns {boolean} */
function rendersScrollContainer(source) {
	const stripped = stripStringLiterals(stripComments(source));
	return SCROLL_TAG_RE.test(stripped);
}

// ---------------------------------------------------------------------------
// The two escape hatches. Both are VERIFIED against disk at scan time, never
// trusted as static assertions — see rules 2 and 3 above.
// ---------------------------------------------------------------------------

/** Screen path (repo-root-relative) -> child component path that provides
 * its scroll container. Seeded with the two entries 57-17's triage ledger
 * established (`57-17-SCROLL-TRIAGE.md`, "CreateBallot / EditBallot
 * refutation"): both ballot screens delegate their whole body to
 * `BallotTemplateForm`, which IS a `ScrollView` at its own render root. */
const DELEGATES_TO = Object.freeze({
	'apps/VoteTorrentAuthority/src/screens/ballots/CreateBallotScreen.tsx':
		'apps/VoteTorrentAuthority/src/screens/ballots/components/BallotTemplateForm.tsx',
	'apps/VoteTorrentAuthority/src/screens/ballots/EditBallotScreen.tsx':
		'apps/VoteTorrentAuthority/src/screens/ballots/components/BallotTemplateForm.tsx',
});

/** Screen path (repo-root-relative) -> { reason, predicateDescription,
 * predicate(absPath) }. A predicate that stops holding re-arms the gate on
 * that screen — the exclusion is not a permanent allowlist entry. */
const EXCLUSIONS = Object.freeze({
	'apps/VoteTorrentAuthority/src/screens/elections/KeyholderScreen.tsx': {
		reason: '0-byte stub, renders nothing',
		predicateDescription: 'file size is 0 bytes',
		/** @param {string} absPath @returns {boolean} */
		predicate: (absPath) => statSync(absPath).size === 0,
	},
});

/**
 * @typedef {{ verdict: 'CLEAN' | 'VIOLATION', reason: string }} Verdict
 */

/**
 * Classifies already-read source text against a repo-root-relative path.
 * Takes source as a parameter (rather than reading from disk) so the
 * per-root synthetic controls below can run the EXACT SAME classification
 * logic real screens go through, with a fake path that can never collide
 * with a real `DELEGATES_TO`/`EXCLUSIONS` entry.
 *
 * @param {string} source
 * @param {string} relPath
 * @returns {Verdict}
 */
function classifySource(source, relPath) {
	if (rendersScrollContainer(source)) {
		return { verdict: 'CLEAN', reason: 'renders a scroll container directly' };
	}

	if (Object.prototype.hasOwnProperty.call(DELEGATES_TO, relPath)) {
		const childRel = DELEGATES_TO[relPath];
		const childAbs = path.join(repoRoot, childRel);
		if (!existsSync(childAbs)) {
			return {
				verdict: 'VIOLATION',
				reason: `DELEGATES_TO entry names a child that no longer exists on disk (${childRel}) — stale entry, must be corrected or removed.`,
			};
		}
		const childSource = readFileSync(childAbs, 'utf8');
		if (rendersScrollContainer(childSource)) {
			return {
				verdict: 'CLEAN',
				reason: `delegates its whole body to ${childRel}, which was re-read and verified to render a scroll container itself.`,
			};
		}
		return {
			verdict: 'VIOLATION',
			reason: `DELEGATES_TO child ${childRel} no longer renders a scroll container — the delegation this screen relies on has broken.`,
		};
	}

	if (Object.prototype.hasOwnProperty.call(EXCLUSIONS, relPath)) {
		const exclusion = EXCLUSIONS[relPath];
		const absPath = path.join(repoRoot, relPath);
		if (!existsSync(absPath)) {
			return { verdict: 'VIOLATION', reason: 'EXCLUSIONS entry names a file that no longer exists on disk — stale entry.' };
		}
		if (exclusion.predicate(absPath)) {
			return {
				verdict: 'CLEAN',
				reason: `excluded — ${exclusion.reason} (predicate holds: ${exclusion.predicateDescription}).`,
			};
		}
		return {
			verdict: 'VIOLATION',
			reason: `EXCLUSIONS predicate no longer holds (${exclusion.predicateDescription}) — the exclusion has expired and the screen is re-armed. Original reason was: ${exclusion.reason}.`,
		};
	}

	return {
		verdict: 'VIOLATION',
		reason:
			'renders no reachable scroll container and has no DELEGATES_TO or EXCLUSIONS entry. Needs one of: (1) a ScrollView/FlatList/SectionList/KeyboardAwareScrollView/Animated.ScrollView at its render root, (2) a verified DELEGATES_TO entry naming a child component that itself scrolls, or (3) an EXCLUSIONS entry with a written reason and a mechanical predicate.',
	};
}

/**
 * @param {string} absPath
 * @param {string} relPath
 * @returns {Verdict}
 */
function classifyScreen(absPath, relPath) {
	return classifySource(readFileSync(absPath, 'utf8'), relPath);
}

// ---------------------------------------------------------------------------
// Walk a screens root for `*Screen.tsx` files. Node builtins only.
// ---------------------------------------------------------------------------

/** @param {string} dir @returns {string[]} */
function walkScreens(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkScreens(full));
		} else if (entry.isFile() && entry.name.endsWith('Screen.tsx')) {
			out.push(full);
		}
	}
	return out;
}

/** @param {string} absPath @returns {string} */
function relFromRoot(absPath) {
	return path.relative(repoRoot, absPath).split(path.sep).join('/');
}

const ROOTS = Object.freeze([
	{ dir: path.join(repoRoot, 'apps/VoteTorrentAuthority/src/screens'), label: 'apps/VoteTorrentAuthority/src/screens' },
	{ dir: path.join(repoRoot, 'apps/VoteTorrentVoter/src/screens'), label: 'apps/VoteTorrentVoter/src/screens' },
]);

// ---------------------------------------------------------------------------
// Mapping integrity — runs ONCE, before any root is scanned. A DELEGATES_TO
// or EXCLUSIONS entry that names a file no longer on disk must be loud, not
// silently skipped over during the per-screen scan below.
// ---------------------------------------------------------------------------
{
	/** @type {string[]} */
	const mappingProblems = [];
	for (const [screenRel, childRel] of Object.entries(DELEGATES_TO)) {
		if (!existsSync(path.join(repoRoot, screenRel))) {
			mappingProblems.push(`DELEGATES_TO key ${screenRel} does not exist on disk.`);
		}
		if (!existsSync(path.join(repoRoot, childRel))) {
			mappingProblems.push(`DELEGATES_TO target ${childRel} (for ${screenRel}) does not exist on disk.`);
		}
	}
	for (const screenRel of Object.keys(EXCLUSIONS)) {
		if (!existsSync(path.join(repoRoot, screenRel))) {
			mappingProblems.push(`EXCLUSIONS key ${screenRel} does not exist on disk.`);
		}
	}
	if (mappingProblems.length > 0) {
		for (const problem of mappingProblems) {
			process.stderr.write(`${PREFIX} FAIL: ${problem} A stale DELEGATES_TO/EXCLUSIONS entry must be loud, not inert.\n`);
		}
		process.exit(1);
	}
	ok(
		`mapping integrity — ${Object.keys(DELEGATES_TO).length} DELEGATES_TO entries and ` +
			`${Object.keys(EXCLUSIONS).length} EXCLUSIONS entry(ies) all resolve on disk.`,
	);
}

// ---------------------------------------------------------------------------
// Per-root controls, then the real scan. Every root gets its own existence
// check, reachability check, positive control, inertness control and clean
// control — replicated per root (not run once globally) per `lint-copy.mjs`'s
// own reasoning: a single global control proves the matcher FUNCTIONS, not
// that it was ever POINTED AT a given root.
// ---------------------------------------------------------------------------

/** @type {Array<{ relPath: string, reason: string }>} */
const allViolations = [];

for (const root of ROOTS) {
	// (a) existence
	if (!existsSync(root.dir)) {
		fail(`${root.label} does not exist — a root that is missing cannot be scanned (proves nothing about that root).`);
	}

	// (b) reachability — count printed, zero is a failure not a silent pass
	const screenFiles = walkScreens(root.dir);
	if (screenFiles.length === 0) {
		fail(`${root.label} walked to zero *Screen.tsx files — a root the walk cannot reach cannot be scanned (proves nothing about that root).`);
	}
	ok(`${root.label} — root exists, ${screenFiles.length} *Screen.tsx file(s) reachable.`);

	// (c) positive control — a synthetic source containing only <View> must
	// classify as VIOLATION.
	const positiveFixture = 'export function Screen() { return <View><Text>hi</Text></View>; }';
	const positiveVerdict = classifySource(positiveFixture, `${root.label}/__positive-control__.tsx`);
	if (positiveVerdict.verdict !== 'VIOLATION') {
		controlFailed(
			`${root.label} positive control (plain <View>, no scroll container) classified as ${positiveVerdict.verdict}, expected VIOLATION — this gate cannot detect a real regression in this root until the matcher is fixed.`,
		);
	}
	ok(`${root.label} — positive control (plain <View> source) correctly classified as VIOLATION.`);

	// (d) inertness control — the ONLY occurrences of the scroll-container
	// token are inside a `//` line comment, a block comment and a
	// double-quoted string. Must still classify as VIOLATION, proving the
	// comment/string stripping is live rather than claimed.
	const inertnessFixture = [
		'// this line mentions ScrollView but renders nothing',
		'/* this block comment also mentions ScrollView */',
		'const label = "ScrollView";',
		'export function Screen() { return <View><Text>{label}</Text></View>; }',
	].join('\n');
	const inertnessVerdict = classifySource(inertnessFixture, `${root.label}/__inertness-control__.tsx`);
	if (inertnessVerdict.verdict !== 'VIOLATION') {
		controlFailed(
			`${root.label} inertness control (scroll-container token only inside a line comment, a block comment and a string literal) classified as ${inertnessVerdict.verdict}, expected VIOLATION — the comment/string stripper is not actually live for this root, so a screen could satisfy this gate with a comment or a testID string alone.`,
		);
	}
	ok(`${root.label} — inertness control (token only in comments/string) correctly classified as VIOLATION — stripping is live.`);

	// (e) clean control — a real <ScrollView> opening tag must classify CLEAN,
	// so the matcher is not simply failing everything in this root.
	const cleanFixture = 'export function Screen() { return <ScrollView><Text>hi</Text></ScrollView>; }';
	const cleanVerdict = classifySource(cleanFixture, `${root.label}/__clean-control__.tsx`);
	if (cleanVerdict.verdict !== 'CLEAN') {
		controlFailed(
			`${root.label} clean control (real <ScrollView>) classified as ${cleanVerdict.verdict}, expected CLEAN — matcher is indiscriminate for this root, rejecting even a genuine scroll container.`,
		);
	}
	ok(`${root.label} — clean control (real <ScrollView>) correctly classified as CLEAN.`);

	// (5) real scan — accumulate, never stop at the first failing root.
	for (const absPath of screenFiles) {
		const relPath = relFromRoot(absPath);
		const verdict = classifyScreen(absPath, relPath);
		if (verdict.verdict === 'VIOLATION') {
			allViolations.push({ relPath, reason: verdict.reason });
		}
	}
	ok(`${root.label} — real scan complete over ${screenFiles.length} file(s).`);
}

if (allViolations.length > 0) {
	for (const violation of allViolations) {
		process.stderr.write(`${PREFIX} FAIL: ${violation.relPath} — no reachable scroll container. ${violation.reason}\n`);
	}
	process.exit(1);
}

ok('all screens in both roots render a reachable scroll container (directly, via a verified DELEGATES_TO entry, or a live-predicate EXCLUSIONS entry).');
process.exit(0);
