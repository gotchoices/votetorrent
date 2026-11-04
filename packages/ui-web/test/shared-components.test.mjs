/**
 * shared-components.test.mjs — source and behaviour assertions for the
 * three shared components (`AdvisoryDisclosure`, `LifecyclePill`,
 * `DetailsToggle`) and the D-07 copy-key resolution, landed in 53-05
 * (D-01/D-02/D-07/D-12/D-16/D-19).
 *
 * `node --test` cannot import `.tsx`, so every `.tsx` source read below is
 * read as TEXT and comment-stripped where a behavior item says so — via
 * `scripts/lib/strip-comments.mjs`'s shared, character-level
 * `stripComments` (54-23), not a local line-opening filter. The prior local
 * filter dropped a line whose TRIMMED form starts with a comment opener,
 * which lets a JSX brace-wrapped block comment's un-prefixed continuation
 * lines survive as code; the shared stripper does not have that gap.
 * Measured over these four files (54-23's own receipt): the old and new
 * removed-line counts are IDENTICAL, so none of these four files were ever
 * exposed by that gap — see 54-23-SUMMARY.md.
 * Positive-control-first throughout: every matcher is shown firing on a
 * synthetic fixture before the real scan against production source is
 * trusted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COPY, t } from '../src/index.js';
import { stripComments } from '../../../scripts/lib/strip-comments.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(HERE, '..', 'src');
const COMPONENTS_DIR = path.join(SRC_DIR, 'components');

const ADVISORY_RAW = readFileSync(path.join(COMPONENTS_DIR, 'AdvisoryDisclosure.tsx'), 'utf8');
const ADVISORY_STRIPPED = stripComments(ADVISORY_RAW);
const LIFECYCLE_PILL_RAW = readFileSync(path.join(COMPONENTS_DIR, 'LifecyclePill.tsx'), 'utf8');
const LIFECYCLE_PILL_STRIPPED = stripComments(LIFECYCLE_PILL_RAW);
const DETAILS_TOGGLE_RAW = readFileSync(path.join(COMPONENTS_DIR, 'DetailsToggle.tsx'), 'utf8');
const DETAILS_TOGGLE_STRIPPED = stripComments(DETAILS_TOGGLE_RAW);
const INDEX_STRIPPED = stripComments(readFileSync(path.join(SRC_DIR, 'index.js'), 'utf8'));

// ===========================================================================
// (a) AdvisoryDisclosure.tsx: the template-literal resolution, and a
// no-fallback control extending the D-16 no-branch control.
// ===========================================================================

const TEMPLATE_CALL_RE = /t\(`advisory\.\$\{variant\}\.body`\)/g;

/** @type {Record<string, RegExp>} */
const FALLBACK_PATTERNS = {
	nullish: /\?\?/,
	or: /\|\|/,
	and: /&&/,
	ternary: /\?[^:{};]*:/,
	switchStatement: /\bswitch\s*\(/,
	defaultParam: /\w+\s*=\s*['"`][^'"`]*['"`]\s*[),]/,
	optionalProp: /\w+\?:\s*\w/,
};

test('AdvisoryDisclosure.tsx resolves advisory.${variant}.body by template literal exactly once, comment-stripped', () => {
	assert.equal((ADVISORY_STRIPPED.match(TEMPLATE_CALL_RE) ?? []).length, 1);
});

test('AdvisoryDisclosure.tsx, comment-stripped, contains no fallback or branch construct of any kind (D-16 extended to a no-fallback control)', () => {
	for (const [name, re] of Object.entries(FALLBACK_PATTERNS)) {
		assert.doesNotMatch(ADVISORY_STRIPPED, re, `AdvisoryDisclosure.tsx must not contain a "${name}" construct`);
	}
});

test("positive control: the fallback matcher fires on a synthetic t(MAP[variant] ?? 'advisory.authority.body') fixture", () => {
	const fixture = "return <p>{t(MAP[variant] ?? 'advisory.authority.body')}</p>;";
	assert.match(fixture, FALLBACK_PATTERNS.nullish, 'matcher is inert');
});

// ===========================================================================
// (b) AdvisoryDisclosure.tsx must never mention DetailsToggle (D-16): the
// advisory disclosure must never become collapsible/hideable.
// ===========================================================================

const DETAILS_TOGGLE_MENTION_RE = /DetailsToggle/;

test('AdvisoryDisclosure.tsx neither imports nor mentions DetailsToggle -- the advisory must never become collapsible (D-16)', () => {
	assert.doesNotMatch(ADVISORY_RAW, DETAILS_TOGGLE_MENTION_RE);
});

test('positive control: the DetailsToggle-mention matcher fires on a synthetic wrapping fixture', () => {
	const fixture = "import { DetailsToggle } from './DetailsToggle.js';\n<DetailsToggle summary={x}><AdvisoryDisclosure variant=\"authority\" /></DetailsToggle>";
	assert.match(fixture, DETAILS_TOGGLE_MENTION_RE, 'matcher is inert');
});

// ===========================================================================
// (c) t('advisory.authority.body') is the unchanged 207-character sentence.
// ===========================================================================

test("t('advisory.authority.body') is the unchanged 207-character sentence (sha256 1faaab62...a047b7)", () => {
	const value = t('advisory.authority.body');
	assert.equal(value.length, 207);
	assert.equal(
		createHash('sha256').update(value, 'utf8').digest('hex'),
		'1faaab624678b9ba965f0db7e17840750bc33f8da8e2c6933ebe25e5e8a047b7',
	);
});

// ===========================================================================
// (d) gate.advisoryDisclosure is gone -- no decoy alias survives the rename.
// ===========================================================================

test("gate.advisoryDisclosure no longer exists in COPY, and t('gate.advisoryDisclosure') throws naming that key", () => {
	assert.equal('gate.advisoryDisclosure' in COPY, false);
	assert.throws(
		() => t('gate.advisoryDisclosure'),
		(err) => err instanceof Error && err.message.includes('gate.advisoryDisclosure'),
	);
});

// ===========================================================================
// (e) D-07's mechanism proven directly: a missing voice throws by name.
// Deliberately a SYNTHETIC variant, not 'public' -- this stays valid after
// 53-07 adds advisory.public.body. This suite does NOT assert that
// advisory.public.body is absent; 53-07 would have to delete that case.
// ===========================================================================

test("t('advisory.nosuchvariant.body') throws naming the exact missing key -- D-07's mechanism, proven directly", () => {
	assert.throws(
		() => t('advisory.nosuchvariant.body'),
		(err) => err instanceof Error && err.message.includes('advisory.nosuchvariant.body'),
	);
});

// ===========================================================================
// (f) COPY still holds exactly 177 keys (73 + the ten public.*/advisory.public.body
// keys 53-07 added under D-08, +2 net from 54-02's lifecycle rename/expansion,
// +61 from 54-09's public election view fact/gap copy table, +2 from 54-12's
// D-02 addressed-but-not-held sentence, +6 from 56-12's Surface 1/3
// staleness and config-fault copy, +1 from 56-14's Surface 5 live-update
// badge word, +22 from 60-01's chart-visualization copy);
// spot-checked untouched keys unchanged.
//
// This file is not one 54-09 set out to touch. It carries a SECOND pin on
// the table's total, so the count lives in two places; updating only the
// one in copy.test.mjs would have left this suite red. The count is left in
// both deliberately rather than deleted here (66-05 moved both pins 177 -> 261: +84 from 66-05's live-dashboard copy; 66-22 moved both 261 -> 266: +5 from 66-22's pairing, scanner and forget gap keys) -- this suite's subject is the
// shared components' relationship to the table, and "the table did not
// silently change size under me" is part of that.
// ===========================================================================

test('COPY holds exactly 266 keys, and three spot-checked untouched keys still hold their exact values', () => {
	assert.equal(Object.keys(COPY).length, 266);
	// lifecycle.organizing was RENAMED to lifecycle.pre by 54-02 (D-06/I-12),
	// carrying its exact pre-move value across the rename -- see copy.test.mjs's
	// own dedicated value-carry test for the full rationale.
	assert.equal(COPY['lifecycle.pre'], 'Being organized');
	assert.equal(COPY['panelFrame.tierPill'], 'tier {{tier}}');
	assert.equal(COPY['bootstrap.heading'], 'Enter your sign-in code');
});

// ===========================================================================
// (g) D-01's boundary: no shared component may reach into authority-only
// concepts (PanelFrame, Capability, GateResult, SnapshotInstantContext) or
// import from an app workspace.
// ===========================================================================

const AUTHORITY_ONLY_RE = /PanelFrame|\bCapability\b|GateResult|SnapshotInstantContext|apps\/|VoteTorrentDashboard/;

test('no file under src/components/ mentions PanelFrame, Capability, GateResult, SnapshotInstantContext, or any apps/ / VoteTorrentDashboard specifier', () => {
	const files = readdirSync(COMPONENTS_DIR).filter((f) => f.endsWith('.tsx'));
	assert.ok(files.length >= 3, 'expected at least the three 53-05 components on disk');
	/** @type {string[]} */
	const offenders = [];
	for (const file of files) {
		const stripped = stripComments(readFileSync(path.join(COMPONENTS_DIR, file), 'utf8'));
		if (AUTHORITY_ONLY_RE.test(stripped)) {
			offenders.push(file);
		}
	}
	assert.deepEqual(offenders, [], `authority-only concept leaked into: ${offenders.join(', ')}`);
});

test('positive control: the authority-only-concept matcher fires on a synthetic GateResult-typed fixture', () => {
	const fixture = "import type { GateResult } from '../../../apps/VoteTorrentDashboard/src/auth/gate.js';";
	assert.match(fixture, AUTHORITY_ONLY_RE, 'matcher is inert');
});

// ===========================================================================
// (h) LifecyclePill.tsx's null-phase guard, re-homed from the dashboard's
// election-ops-panels.test.mjs alongside the component itself.
// ===========================================================================

test('LifecyclePill.tsx returns null for a null phase (re-homed alongside the component)', () => {
	assert.match(LIFECYCLE_PILL_STRIPPED, /if \(key === null\)/);
	assert.match(LIFECYCLE_PILL_STRIPPED, /return null/);
});

// ===========================================================================
// (i) DetailsToggle.tsx: the designated hook-calling component. This proves
// the source SHAPE only -- that aria-expanded is bound to live state, not a
// literal. The behavioural proof that a real click flips it, against a
// BUILT page and a single React, is 53-09's browser gate; this file's
// header says so rather than implying otherwise.
// ===========================================================================

const ARIA_EXPANDED_BOUND_RE = /aria-expanded=\{(?!true\}|false\})[A-Za-z_$][\w.]*\}/;

test('DetailsToggle.tsx calls useState and binds aria-expanded to live state, not a literal', () => {
	assert.match(DETAILS_TOGGLE_STRIPPED, /\buseState\(/);
	assert.match(DETAILS_TOGGLE_STRIPPED, ARIA_EXPANDED_BOUND_RE);
});

test('positive control: the aria-expanded-bound-to-state matcher rejects a constant fixture (aria-expanded={false})', () => {
	const fixture = '<button type="button" className="dt-toggle" aria-expanded={false}>';
	assert.doesNotMatch(fixture, ARIA_EXPANDED_BOUND_RE, 'matcher is inert -- it must reject a literal constant');
	const boundFixture = '<button type="button" className="dt-toggle" aria-expanded={open}>';
	assert.match(boundFixture, ARIA_EXPANDED_BOUND_RE, 'matcher must accept a genuinely bound identifier');
});

// ===========================================================================
// (j) The plain-JS `.` barrel stays engine-free: no vote-engine, no
// election-phase, so every tier-1 process importing COPY stays cheap.
// ===========================================================================

test('src/index.js, comment-stripped, contains neither "vote-engine" nor "election-phase" -- the `.` barrel stays engine-free', () => {
	assert.doesNotMatch(INDEX_STRIPPED, /vote-engine/);
	assert.doesNotMatch(INDEX_STRIPPED, /election-phase/);
});

test('positive control: the engine-free matcher fires on a synthetic re-export fixture', () => {
	const fixture = "export { derivePhase } from './lifecycle/election-phase.js';";
	assert.match(fixture, /election-phase/, 'matcher is inert');
});
