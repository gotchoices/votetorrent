/**
 * Phase 59 plan 04 (D-16, T-59-04-04) — every `ElectionEvent` member has a
 * non-empty, locale-distinct EN and ES label.
 *
 * WHY THIS TEST EXISTS AND WHY THE OTHER GATES CANNOT SEE ITS GAP:
 * `ElectionTimelineList.tsx` resolves its row labels via a DYNAMIC `t(event)`
 * call, not a literal `t("key")`. The i18n parity suite's source scanner
 * (`__tests__/i18n-parity.test.ts`) only matches literal `t("...")` calls in
 * source text, so a missing `accruingVotes` (or any other) label would ship
 * with every existing gate green and render the raw enum member name —
 * `accruingVotes` — to an officer as if it were copy. This test closes that
 * blind spot by iterating `Object.values(ElectionEvent)` directly, rather
 * than scanning source for literal `t()` calls.
 *
 * Renderer-free: imports only the exported `resources` object and
 * `ElectionEvent` — no react-test-renderer needed, mirroring
 * `registration-policy-keys.test.ts`'s renderer-free style.
 */

import { resources } from '../index';
import { ElectionEvent } from '@votetorrent/vote-core';

const enTranslation = resources.en.translation as Record<string, string>;
const esTranslation = resources.es.translation as Record<string, string>;

describe('ElectionEvent -> i18n label coverage (D-16, T-59-04-04)', () => {
	test('Object.values(ElectionEvent) has length 10 (cross-check on 59-01)', () => {
		expect(Object.values(ElectionEvent)).toHaveLength(10);
	});

	test('every ElectionEvent member has a non-empty EN label', () => {
		for (const event of Object.values(ElectionEvent)) {
			expect(enTranslation[event]?.trim().length ?? 0).toBeGreaterThan(0);
		}
	});

	test('every ElectionEvent member has a non-empty ES label', () => {
		for (const event of Object.values(ElectionEvent)) {
			expect(esTranslation[event]?.trim().length ?? 0).toBeGreaterThan(0);
		}
	});

	test('every ElectionEvent member has a locale-distinct EN/ES label', () => {
		for (const event of Object.values(ElectionEvent)) {
			expect(esTranslation[event]).not.toBe(enTranslation[event]);
		}
	});

	test('no translated ElectionEvent label contains a digit-pair phase number', () => {
		// CLAUDE.md standing rule: no GSD phase numbers in user-facing UI copy.
		const phaseNumberRe = /\bphase\s*\d/i;
		for (const event of Object.values(ElectionEvent)) {
			expect(phaseNumberRe.test(enTranslation[event] ?? '')).toBe(false);
			expect(phaseNumberRe.test(esTranslation[event] ?? '')).toBe(false);
		}
	});

	// 59-04-PLAN.md acceptance criteria (task 2) specifies a Node one-liner
	// (`node -e "require('./apps/VoteTorrentAuthority/src/i18n')..."`) to prove
	// no translated VALUE anywhere in the whole bundle carries a phase number.
	// That module is TypeScript source with no compiled dist entry point, so a
	// bare `node -e` require fails with MODULE_NOT_FOUND — the plan's own
	// fallback clause applies: "run the equivalent assertion inside the new
	// i18n test instead and say so in the SUMMARY." This test is that
	// fallback, and is strictly wider than the plan's literal command since it
	// scans every key in the bundle, not only the ElectionEvent labels above.
	test('no value anywhere in the EN or ES bundle contains a digit-pair phase number (whole-bundle fallback)', () => {
		const phaseNumberRe = /\bphase\s*\d/i;
		for (const [key, value] of Object.entries(enTranslation)) {
			expect(phaseNumberRe.test(String(value))).toBe(false);
			if (phaseNumberRe.test(String(value))) {
				throw new Error(`en.${key} contains a phase number: ${value}`);
			}
		}
		for (const [key, value] of Object.entries(esTranslation)) {
			expect(phaseNumberRe.test(String(value))).toBe(false);
			if (phaseNumberRe.test(String(value))) {
				throw new Error(`es.${key} contains a phase number: ${value}`);
			}
		}
	});
});
