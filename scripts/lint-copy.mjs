#!/usr/bin/env node
/**
 * lint-copy.mjs — the D-06 three-root copy-discipline gate; the repo-root
 * `lint:copy` script (and the dashboard's own `lint` delegates to it).
 *
 * Relocated (53-10) from the dashboard workspace's own former single-root
 * script, at the file this replaced -- see this plan's SUMMARY for the exact
 * prior path, deliberately not restated here so this comment does not itself
 * become a dangling reference once that file is gone. That single-root
 * script proved only the dashboard's own `src/` clean; the
 * shared copy table (`packages/ui-web/src/copy.js`) now serves THREE roots —
 * `packages/ui-web/src`, `apps/VoteTorrentDashboard/src` and
 * `apps/VoteTorrentPublic/src` — and a lint that only ever looked at one of
 * them proves nothing about the other two. D-06's reasoning, in its own
 * words: a lint that cannot detect a violation in a root proves nothing
 * about that root. A single global positive control satisfies the letter of
 * "positive-control-first" and defeats its purpose — it proves the matcher
 * FUNCTIONS, not that the matcher was ever POINTED AT a given root. So the
 * positive control (and its inertness counterpart) below is replicated once
 * PER ROOT, rather than run once globally: `packages/ui-web/src`,
 * `apps/VoteTorrentDashboard/src` and `apps/VoteTorrentPublic/src` each get
 * their own existence check, their own reachability check, their own
 * positive control and their own inertness control, and each prints its own
 * `OK` line — a root that goes empty or silently drops off the list is
 * visible in stdout rather than inferred from an unchanged exit code.
 *
 * Enforces that every user-facing string lives in EXACTLY ONE table
 * (`packages/ui-web/src/copy.js`) and that the table itself obeys the
 * standing rules: frozen, non-empty string values, no GSD phase number or
 * decision ID, and no `read-only` panel-state string (contract C3 /
 * Phase 50's D-17 — a different rule from this phase's own D-17, which is
 * about test-only fixtures; qualified here so the two are never conflated).
 *
 * The copy table is imported by an absolute `file://` URL built from the
 * 53-01 resolver (`moduleUrl(uiWebSrc('copy.js'))`), never by the bare
 * `@votetorrent/ui-web` specifier: measured at HEAD, a bare `@votetorrent/*`
 * specifier does not resolve from the repo root (`ERR_MODULE_NOT_FOUND` —
 * `.yarnrc.yml` sets `nmHoistingLimits: workspaces` and the repo root
 * declares no `@votetorrent/*` dependency, so no root `node_modules/@votetorrent`
 * exists at all). Carrying a bare specifier here would make this gate's
 * verdict depend on the directory it was launched from, which is exactly
 * what the byte-identical-stdout property below rules out.
 *
 * The one relative import below, `./lib/source-paths.mjs`, is repo-local
 * tooling, not a package dependency — this script still has NO DEPENDENCIES
 * beyond `node:` builtins, a dynamic `import()` of `copy.js` itself, and that
 * one sibling module. It replaces every derivation this script used to make
 * from the process's own launch directory: `scripts/lib/source-paths.mjs`
 * exists specifically because a script that derives its own root cannot
 * relocate safely, and this file is the relocation `53-01` was landed ahead
 * of. Adding a fourth `@votetorrent/ui-web` consumer means adding its `src/`
 * to the `ROOTS` list below — see the repo-root dedupe-and-gate assertion
 * that enumerates consumers for the sibling half of that same rule.
 *
 * Runs its own positive controls FIRST — a lint that cannot detect a
 * violation proves nothing. Standalone Node script, NO DEPENDENCIES beyond
 * `node:` builtins and a dynamic `import()` of `copy.js` itself — no parser
 * package, no AST library. The JSX-prose scanner below is a REGEX-based
 * JSX-text-node scanner, deliberately: it catches the CLASS of violation (a
 * newly hard-coded English phrase in a JSX text node), not a fixed list of
 * sentinel strings, while staying dependency-free.
 *
 * THE MATCHER'S REAL BOUNDARY (a regex scanner is not total, and pretending
 * otherwise is worse than documenting the gap): it scans one SOURCE LINE at a
 * time, so it does not see a JSX text node that itself wraps onto a second
 * line. It looks only at text between `>` and `<` — so an ATTRIBUTE value
 * (`title={...}`, `aria-label="..."`) is never inspected, by construction,
 * because an attribute sits BEFORE the `>` that closes its tag. A template
 * literal INSIDE an expression container (`{`\`tier ${n}\`}`) is invisible
 * too — the container is stripped as a unit before the text is checked, the
 * same as `{t('key')}` is. None of these are a defect to "fix" by widening
 * the regex; each would reopen exactly the false-positive class (a TS
 * generic argument such as `useState<string | undefined>(undefined)` reading
 * as JSX text) that made a naive whole-file regex unusable before this
 * scanner was scoped to one line at a time.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { repoRoot, uiWebSrc, dashboardSrc, publicSrc, moduleUrl } from './lib/source-paths.mjs';
import { stripComments } from './lib/strip-comments.mjs';

/** @param {string} message */
function fail(message) {
	process.stderr.write(`[lint-copy] FAIL: ${message}\n`);
	process.exit(1);
}

/** @param {string} message */
function ok(message) {
	process.stdout.write(`[lint-copy] OK: ${message}\n`);
}

// ---------------------------------------------------------------------------
// 1. Positive control — run the sentinel matcher over a fixture BEFORE
//    scanning real files.
// ---------------------------------------------------------------------------
const SENTINEL_STRINGS = [
	'answered by the database',
	'simulated scope set',
	'Redeem Code',
	'Forget this network',
	'Reveal denied panels',
	'More options',
	'Refresh snapshot',
];

const POSITIVE_CONTROL_FIXTURE = 'const x = "simulated scope set";';
const sentinelHit = SENTINEL_STRINGS.some((s) => POSITIVE_CONTROL_FIXTURE.includes(s));
if (!sentinelHit) {
	fail(
		'matcher is inert — the "simulated scope set" positive-control fixture did not match. ' +
			'This gate cannot detect a real regression until the matcher is fixed.',
	);
}
ok('positive control matched the sentinel fixture — matcher is live.');

// ---------------------------------------------------------------------------
// 2. Import COPY by absolute file:// URL (never a bare specifier — see the
//    header) and assert its own discipline. Deliberately UNWRAPPED, with no
//    exception handler of any kind around it: a caught import failure that
//    lets the script continue would turn this whole section into a silent
//    no-op, which is this plan's headline threat. An unhandled rejection
//    here is the correct behaviour — the lint must die loudly instead.
// ---------------------------------------------------------------------------
const { COPY } = await import(moduleUrl(uiWebSrc('copy.js')));

// The barrel must still re-export the table every real consumer imports —
// checked by reading it as a string, never by importing it (the barrel also
// re-exports election-phase.js, which resolves @votetorrent/vote-engine/browser,
// and a tier-1 lint must not acquire a transitive module graph it does not need).
const indexBarrelSource = readFileSync(uiWebSrc('index.js'), 'utf8');
if (!indexBarrelSource.includes('./copy.js')) {
	fail(
		"packages/ui-web/src/index.js no longer re-exports './copy.js' — every consumer imports " +
			'the copy table through this barrel, so a barrel that stops re-exporting it breaks every ' +
			'consumer while this direct-file import keeps passing.',
	);
}

if (!Object.isFrozen(COPY)) {
	fail('packages/ui-web/src/copy.js exports a COPY object that is not frozen.');
}

const DECISION_ID_RE = /\bD-\d{2}\b/;
const PHASE_NUMBER_RE = /\bPhase\s+\d+\b/;
const READ_ONLY_RE = /read-only/i;

for (const [key, value] of Object.entries(COPY)) {
	if (typeof value !== 'string' || value.length === 0) {
		fail(`COPY.${key} must be a non-empty string, got: ${JSON.stringify(value)}`);
	}
	if (DECISION_ID_RE.test(value)) {
		fail(`COPY.${key} contains a GSD decision ID: "${value}"`);
	}
	if (PHASE_NUMBER_RE.test(value)) {
		fail(`COPY.${key} contains a GSD phase number: "${value}"`);
	}
	if (READ_ONLY_RE.test(value)) {
		fail(`COPY.${key} matches /read-only/i (contract C3 / Phase 50's D-17 forbids this): "${value}"`);
	}
}
ok(`COPY is frozen and every one of its ${Object.keys(COPY).length} values passes the discipline checks.`);

// ---------------------------------------------------------------------------
// Advisory scan sentinel resolution. `gate.advisoryDisclosure` (the pre-move
// script's hard-coded key) may no longer exist after 53-05's D-07 rename —
// resolve it by pattern instead of assuming the name. Zero matches or an
// ambiguous match both FAIL loudly; there is NO `??`/`?.` fallback anywhere
// in this resolution, on purpose (see the length guard just below for why).
// ---------------------------------------------------------------------------
const ADVISORY_KEY_PATTERN = /advisor/i;
const advisoryCandidates = Object.entries(COPY).filter(
	([key, value]) => ADVISORY_KEY_PATTERN.test(key) && typeof value === 'string',
);
if (advisoryCandidates.length === 0) {
	fail(
		`no COPY key matching ${ADVISORY_KEY_PATTERN} was found — the advisory scan sentinel this ` +
			`gate depends on has vanished. COPY keys: ${Object.keys(COPY).join(', ')}`,
	);
}
let advisoryEntry;
if (advisoryCandidates.length === 1) {
	advisoryEntry = advisoryCandidates[0];
} else {
	// More than one /advisor/i key: the authority voice is the sentinel: the
	// public voice is authored fresh and must be allowed to differ from it.
	const nonPublicCandidates = advisoryCandidates.filter(([key]) => !key.includes('public'));
	if (nonPublicCandidates.length !== 1) {
		fail(
			'advisory sentinel is ambiguous — expected exactly one non-public /advisor/i COPY key, found: ' +
				nonPublicCandidates.map(([key]) => key).join(', '),
		);
	}
	advisoryEntry = nonPublicCandidates[0];
}
// FORBIDDEN: a `??`/`?.` "fix" on the resolution above. A sentinel that
// degrades to an empty string makes every file's scan match (the lint fires
// on everything, and a lint that fires on everything gets disabled); a
// sentinel that degrades to `undefined` coerces to the literal text
// "undefined" and the scan goes silently inert. The length guard below is
// what catches either degradation before any real scanning happens.
const ADVISORY_DISCLOSURE_PREFIX = advisoryEntry[1].slice(0, 40);

const scanSentinels = [...SENTINEL_STRINGS, ADVISORY_DISCLOSURE_PREFIX];
for (const sentinel of scanSentinels) {
	if (typeof sentinel !== 'string' || sentinel.length < 8) {
		fail(
			`scan sentinel degraded to a string shorter than 8 characters (${JSON.stringify(sentinel)}) — ` +
				'a sentinel this short (including empty, or the literal "undefined" a nullish fallback would ' +
				'produce) would match every file, and a lint that fires on everything gets disabled.',
		);
	}
}
ok(
	`advisory scan sentinel resolved from COPY['${advisoryEntry[0]}'] — ${scanSentinels.length} total ` +
		'sentinels, each at least 8 characters.',
);

// ---------------------------------------------------------------------------
// 3. Walk a root and build { absPath, relPath, contents } entries, so the
//    same scanning functions can be fed either real files or a synthetic
//    fixture (the per-root controls below never touch disk).
// ---------------------------------------------------------------------------
/** @param {string} dir */
function walk(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name === 'dist') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walk(full));
		} else {
			out.push(full);
		}
	}
	return out;
}

/**
 * @param {string} dir
 * @param {ReadonlyArray<string>} excluded
 * @returns {Array<{ absPath: string, relPath: string, contents: string }>}
 */
function readEntries(dir, excluded) {
	return walk(dir)
		.filter((absPath) => !excluded.includes(absPath))
		.map((absPath) => ({
			absPath,
			relPath: path.relative(repoRoot, absPath).split(path.sep).join('/'),
			contents: readFileSync(absPath, 'utf8'),
		}));
}

/**
 * @param {ReadonlyArray<{ absPath: string, relPath: string, contents: string }>} entries
 * @param {ReadonlyArray<string>} sentinels
 * @returns {Array<{ relPath: string, detail: string }>}
 */
function sentinelViolations(entries, sentinels) {
	/** @type {Array<{ relPath: string, detail: string }>} */
	const violations = [];
	for (const entry of entries) {
		for (const sentinel of sentinels) {
			if (entry.contents.includes(sentinel)) {
				violations.push({
					relPath: entry.relPath,
					detail: `contains the copy-table sentinel string "${sentinel}" — copy must live only in packages/ui-web/src/copy.js.`,
				});
			}
		}
	}
	return violations;
}

/**
 * @param {ReadonlyArray<{ absPath: string, relPath: string, contents: string }>} entries
 * @returns {Array<{ relPath: string, detail: string }>}
 */
function jsxViolations(entries) {
	/** @type {Array<{ relPath: string, detail: string }>} */
	const violations = [];
	for (const entry of entries) {
		if (!entry.absPath.endsWith('.tsx')) continue;
		for (const text of jsxProseIn(entry.contents, entry.absPath)) {
			violations.push({
				relPath: entry.relPath,
				detail: `renders the authored text ${JSON.stringify(text)} as a JSX text node — every user-facing string must come from packages/ui-web/src/copy.js through t().`,
			});
		}
	}
	return violations;
}

// ---------------------------------------------------------------------------
// 4. Authored prose rendered as a JSX text node, anywhere under src/.
//
//    The sentinel scan above can only find the seven strings it was told
//    about. It could not see `tier {capability.tier}` or `{n} site{s}` in
//    PanelFrame.tsx, or the raw phase identifiers Bootstrap.tsx used to
//    render — all of them authored user-facing text living outside the one
//    file contract C2 says is the ONLY place a user-facing string may live.
//
//    REGEX-BASED, NOT AN AST PARSE (this script stays dependency-free): for
//    each .tsx file, strip comments via scripts/lib/strip-comments.mjs's
//    shared, character-level stripComments (54-23), then walk each
//    remaining LINE for runs of text between `>` and `<`. Scoping to one
//    line at a time is what
//    keeps this safe from the false-positive class that made a whole-file
//    regex unusable: a TS generic argument like
//    `useState<string | undefined>(undefined)` never has a SECOND `<` on the
//    same line, so it produces no candidate at all, and this codebase never
//    puts a generic type argument and real JSX markup on the same line (both
//    were verified true across every .tsx file under src/ before this
//    scanner was written this way).
// ---------------------------------------------------------------------------

/**
 * WHAT COUNTS AS AUTHORED PROSE IN A JSX TEXT NODE, and why it is not simply
 * "any word".
 *
 * The panels deliberately label rows with SCHEMA COLUMN NAMES -- `<dt>Hash</dt>`,
 * `<dt>PrimaryAuthorityId</dt>` -- because this dashboard's whole reporting
 * discipline is "table names, column names and integer counts only". Those are
 * identifiers, not translatable prose, and a rule that banned every word would
 * demand they be moved into the copy table, which is the wrong answer.
 *
 * So a candidate (the text between one `>` and the next `<` on the same
 * line, with any `{...}` expression container removed) is flagged when
 * EITHER:
 *
 *   1. what remains contains two letter-runs separated by non-letters
 *      (multi-word prose: "Enter your sign-in code"), or
 *   2. the candidate ORIGINALLY contained a `{...}` expression container
 *      AND what remains after removing it still contains a bare word --
 *      i.e. authored words interleaved with interpolation.
 *
 * (2) is what catches the defect this check was added for: `tier
 * {capability.tier}` is the single word "tier" beside an interpolation, and a
 * word-PAIR rule alone sails past it -- it would have passed the very code it
 * exists to catch, which is how a gate ends up proving nothing. Each shape
 * has its own positive control below.
 */
const JSX_MULTIWORD_RE = /[A-Za-z]{2,}[^A-Za-z]+[A-Za-z]{2,}/;
const JSX_WORD_RE = /[A-Za-z]{2,}/;
/** One run of text between a `>` and the next `<` on the SAME line -- an
 * approximation of "this line's JSX text node(s)", never spanning lines. */
const JSX_TEXT_RUN_RE = />([^<>]*)</g;
/** A `{...}` expression container, one level of nesting deep (the deepest
 * this codebase's JSX ever nests -- e.g. `{t('key', { a: 1 })}`). Applied
 * repeatedly, inside out, so nested containers are fully removed. */
const EXPRESSION_CONTAINER_RE = /\{[^{}]*\}/g;

/** @param {string} text @returns {string} */
function stripExpressionContainers(text) {
	let result = text;
	let previous;
	do {
		previous = result;
		result = result.replace(EXPRESSION_CONTAINER_RE, '');
	} while (result !== previous);
	return result;
}

/** @param {string} source @param {string} fileName @returns {string[]} */
function jsxProseIn(source, fileName) {
	void fileName; // kept for parity with a future per-file diagnostic, unused today
	/** @type {string[]} */
	const found = [];
	for (const line of stripComments(source).split('\n')) {
		let match;
		JSX_TEXT_RUN_RE.lastIndex = 0;
		while ((match = JSX_TEXT_RUN_RE.exec(line)) !== null) {
			const raw = match[1];
			const hadExpression = /\{[^{}]*\}/.test(raw);
			const stripped = stripExpressionContainers(raw).trim();
			if (stripped.length === 0) continue;
			if (JSX_MULTIWORD_RE.test(stripped) || (hadExpression && JSX_WORD_RE.test(stripped))) {
				found.push(stripped);
			}
		}
	}
	return found;
}

// Positive controls FIRST, as everywhere else in this script -- one per shape.
const JSX_CONTROL_FIXTURES = [
	['multi-word prose', '<span className="pill">tier {n} of them</span>'],
	['prose split by an interpolation', 'export const X = () => <span>tier {capability.tier}</span>;'],
	['pluralisation suffix beside two interpolations', "export const X = () => <span>{n} site{n === 1 ? '' : 's'}</span>;"],
];
for (const [label, fixture] of JSX_CONTROL_FIXTURES) {
	if (jsxProseIn(fixture, 'control.tsx').length === 0) {
		fail(
			`matcher is inert — the "${label}" JSX positive-control fixture did not match. ` +
				'This gate cannot detect a real regression until the matcher is fixed.',
		);
	}
}
// Negative / inertness controls in the other direction. A matcher that fires
// on everything gets disabled, which is worse than not having it.
const JSX_BENIGN_FIXTURES = [
	// The exact shape this whole gate is steering toward: a rendered copy KEY.
	"<span>{t('panelFrame.tierPill', { tier })}</span>",
	"export const X = () => <span>{t('panelFrame.tierPill', { tier: '2' })}</span>;",
	// A generic type argument is not JSX at all, and never shares a line with
	// real JSX markup in this codebase -- this is the false-positive class
	// that made a whole-file (rather than per-line) regex unusable.
	'const [v, setV] = useState<string | undefined>(undefined);',
	// A bare glyph.
	'export const X = () => <span aria-hidden="true">⋮</span>;',
	// A schema column name as a row label, alone in its element -- deliberate,
	// and not translatable prose.
	'export const X = () => <dt>PrimaryAuthorityId</dt>;',
];
for (const benign of JSX_BENIGN_FIXTURES) {
	const hits = jsxProseIn(benign, 'benign.tsx');
	if (hits.length > 0) {
		fail(`matcher is indiscriminate — it flagged ${JSON.stringify(hits)} in the benign fixture ${JSON.stringify(benign)}.`);
	}
}

ok(
	`JSX-prose matcher (regex-based, no AST library) matched all ${JSX_CONTROL_FIXTURES.length} positive controls and ` +
		`none of ${JSX_BENIGN_FIXTURES.length} benign fixtures.`,
);

// ---------------------------------------------------------------------------
// 4. The three roots, scanned independently. Each root gets its own
//    existence check, reachability check, positive control, inertness
//    control and real scan — a root that is missing, misspelled, or empty
//    proves nothing about that root (D-06), so none of these steps may be
//    skipped or run only once globally.
// ---------------------------------------------------------------------------

/** @param {string} dir @returns {string} */
function rootLabel(dir) {
	return path.relative(repoRoot, dir).split(path.sep).join('/');
}

const ROOTS = Object.freeze([
	{ dir: uiWebSrc(), label: rootLabel(uiWebSrc()), excluded: [uiWebSrc('copy.js')] },
	{ dir: dashboardSrc(), label: rootLabel(dashboardSrc()), excluded: [] },
	{ dir: publicSrc(), label: rootLabel(publicSrc()), excluded: [] },
]);

/** @type {Array<{ relPath: string, detail: string }>} */
const allViolations = [];

for (const root of ROOTS) {
	// (1) Existence — a missing root cannot be linted, and skipping it would
	// let the lint report success while proving nothing about it.
	if (!existsSync(root.dir)) {
		fail(`${root.label} does not exist — a root that is missing cannot be linted (proves nothing about that root).`);
	}

	// (2) Reachability — a walk that reaches zero files, or zero .tsx files,
	// cannot be linted either.
	const walked = walk(root.dir).filter((absPath) => !root.excluded.includes(absPath));
	if (walked.length === 0) {
		fail(`${root.label} walked to zero files — a root the walk cannot reach cannot be linted (proves nothing about that root).`);
	}
	const tsxCount = walked.filter((absPath) => absPath.endsWith('.tsx')).length;
	if (tsxCount === 0) {
		fail(`${root.label} walked to zero .tsx files — a root the walk cannot reach cannot be linted (proves nothing about that root).`);
	}

	// (3) Per-root positive control — a synthetic entry, never written to
	// disk, run through the SAME functions and THIS root's own sentinel
	// list, so a root whose configuration was quietly broken cannot report
	// a clean scan. Requires a violation from EACH matcher, and requires the
	// reported relPath to start with this root's own label.
	const controlRelPath = `${root.label}/__lint-copy-positive-control__.tsx`;
	const controlEntry = {
		absPath: controlRelPath,
		relPath: controlRelPath,
		contents: `${POSITIVE_CONTROL_FIXTURE}\n${JSX_CONTROL_FIXTURES[0][1]}\n`,
	};
	const controlSentinelHits = sentinelViolations([controlEntry], scanSentinels);
	const controlJsxHits = jsxViolations([controlEntry]);
	if (controlSentinelHits.length === 0 || controlJsxHits.length === 0) {
		fail(
			`matcher is inert for ${root.label} — the per-root positive control did not fire for both ` +
				'matchers. This gate cannot detect a real regression in this root until the matcher is fixed.',
		);
	}
	if (
		!controlSentinelHits.every((violation) => violation.relPath.startsWith(root.label)) ||
		!controlJsxHits.every((violation) => violation.relPath.startsWith(root.label))
	) {
		fail(`matcher is inert for ${root.label} — the per-root positive control's violation did not name this root.`);
	}

	// (4) Per-root inertness control — every benign fixture, run as an entry
	// inside THIS root, must produce zero violations.
	for (const benign of JSX_BENIGN_FIXTURES) {
		const benignRelPath = `${root.label}/__lint-copy-benign-control__.tsx`;
		const benignEntry = { absPath: benignRelPath, relPath: benignRelPath, contents: benign };
		const benignHits = jsxViolations([benignEntry]);
		if (benignHits.length > 0) {
			fail(
				`matcher is indiscriminate for ${root.label} — it flagged ${JSON.stringify(benignHits)} ` +
					`in the benign fixture ${JSON.stringify(benign)}.`,
			);
		}
	}

	// (5) Real scan — accumulate across all three roots and exit only after
	// every root has been scanned. A lint that stops at the first failing
	// root turns a three-root report into a one-root report exactly when
	// the report matters most.
	const entries = readEntries(root.dir, root.excluded);
	allViolations.push(...sentinelViolations(entries, scanSentinels), ...jsxViolations(entries));

	ok(
		`${root.label} — walked ${walked.length} file(s) (${tsxCount} .tsx) — ` +
			'positive control fired — benign fixtures clean',
	);
}

if (allViolations.length > 0) {
	for (const violation of allViolations) {
		process.stderr.write(`[lint-copy] FAIL: ${violation.relPath} ${violation.detail}\n`);
	}
	process.exit(1);
}

ok('all checks passed — copy discipline is intact across all three roots.');
process.exit(0);
