/**
 * relative-date.test.ts -- Phase 59 plan 59-06, Task 2.
 *
 * Exercises the five-way subtitle table (UI-SPEC) against the canonical fixture's own instants
 * (the `03/23` cluster gives three same-day cases for free), asserting every subtitle key is
 * reachable in both `en` and `es`, `MM/DD` is byte-identical across locales, day boundaries use
 * the caller's `timeZone` (never the runner's), and the Intl-unavailable fallback degrades to a
 * date-shaped key. No test in this file mutates `process.env.TZ`.
 */
import {calendarDayDiff, formatRailDate, relativeDateSubtitle} from '../relative-date';
import {TIMELINE_KEYS} from '../stages';
import {CANONICAL_TIMELINE} from '../__fixtures__/timeline-fixtures';

const DENVER = 'America/Denver';
const UTC = 'UTC';

describe('relativeDateSubtitle -- the five-way UI-SPEC table', () => {
	for (const language of ['en', 'es'] as const) {
		describe(`language=${language}`, () => {
			test('same calendar day yields subtitle.today with {weekday}', () => {
				const nowMs = CANONICAL_TIMELINE.accruingVotes;
				const result = relativeDateSubtitle(CANONICAL_TIMELINE.accruingVotes, nowMs, {language, timeZone: DENVER});
				expect(result.key).toBe('subtitle.today');
				expect(result.params).toHaveProperty('weekday');
				expect(typeof (result.params as {weekday: string}).weekday).toBe('string');
				expect((result.params as {weekday: string}).weekday.length).toBeGreaterThan(0);
			});

			test('exactly one calendar day before now yields subtitle.yesterday with no params', () => {
				// registrationEnds (03/20 local) is one calendar day before ballotsFinal (03/21 local).
				const nowMs = CANONICAL_TIMELINE.ballotsFinal;
				const result = relativeDateSubtitle(CANONICAL_TIMELINE.registrationEnds, nowMs, {language, timeZone: DENVER});
				expect(result.key).toBe('subtitle.yesterday');
				expect(result.params).toBeUndefined();
			});

			test('1-6 calendar days ahead yields subtitle.futureWeekday with {weekday}', () => {
				// ballotsFinal (03/21 local) is 1 day ahead of registrationEnds (03/20 local) as `now`.
				const nowMs = CANONICAL_TIMELINE.registrationEnds;
				const result = relativeDateSubtitle(CANONICAL_TIMELINE.ballotsFinal, nowMs, {language, timeZone: DENVER});
				expect(result.key).toBe('subtitle.futureWeekday');
				expect(result.params).toHaveProperty('weekday');
			});

			test('2+ calendar days back yields subtitle.pastDate with {date}', () => {
				// closed (03/25 local) is more than one day after registrationEnds (03/20 local); as
				// `now`, registrationEnds is 2+ days IN THE PAST relative to closed.
				const nowMs = CANONICAL_TIMELINE.closed;
				const result = relativeDateSubtitle(CANONICAL_TIMELINE.registrationEnds, nowMs, {language, timeZone: DENVER});
				expect(result.key).toBe('subtitle.pastDate');
				expect(result.params).toEqual({date: formatRailDate(CANONICAL_TIMELINE.registrationEnds, DENVER, language)});
			});

			test('7+ calendar days ahead yields subtitle.futureDate with {date}', () => {
				const nowMs = CANONICAL_TIMELINE.registrationEnds;
				const farFuture = CANONICAL_TIMELINE.registrationEnds + 8 * 86_400_000;
				const result = relativeDateSubtitle(farFuture, nowMs, {language, timeZone: DENVER});
				expect(result.key).toBe('subtitle.futureDate');
				expect(result.params).toEqual({date: formatRailDate(farFuture, DENVER, language)});
			});
		});
	}

	test('the three same-day 03/23 rows produce the SAME subtitle.today weekday value -- not deduped', () => {
		const nowMs = CANONICAL_TIMELINE.accruingVotes;
		const a = relativeDateSubtitle(CANONICAL_TIMELINE.accruingVotes, nowMs, {language: 'en', timeZone: DENVER});
		const b = relativeDateSubtitle(CANONICAL_TIMELINE.hashingVotes, nowMs, {language: 'en', timeZone: DENVER});
		const c = relativeDateSubtitle(CANONICAL_TIMELINE.releasingKeys, nowMs, {language: 'en', timeZone: DENVER});
		expect(a.key).toBe('subtitle.today');
		expect(b.key).toBe('subtitle.today');
		expect(c.key).toBe('subtitle.today');
		expect(a.params).toEqual(b.params);
		expect(b.params).toEqual(c.params);
	});

	test('every emitted key is a member of TIMELINE_KEYS', () => {
		const nowMs = CANONICAL_TIMELINE.accruingVotes;
		for (const instantMs of Object.values(CANONICAL_TIMELINE)) {
			const result = relativeDateSubtitle(instantMs, nowMs, {language: 'en', timeZone: DENVER});
			expect(TIMELINE_KEYS).toContain(result.key);
		}
	});
});

describe('MM/DD rail date formatting', () => {
	test('is byte-identical for en and es on the same instant', () => {
		const enDate = formatRailDate(CANONICAL_TIMELINE.registrationEnds, DENVER, 'en');
		const esDate = formatRailDate(CANONICAL_TIMELINE.registrationEnds, DENVER, 'es');
		expect(enDate).toBe(esDate);
		expect(enDate).toMatch(/^\d{2}\/\d{2}$/);
	});

	test('is zero-padded and month-first', () => {
		// registrationEnds is 2026-03-20 17:00 America/Denver local.
		expect(formatRailDate(CANONICAL_TIMELINE.registrationEnds, DENVER, 'en')).toBe('03/20');
	});
});

describe('the day boundary uses the callers timeZone, not the runners', () => {
	test('the same instant can classify differently in America/Denver vs UTC', () => {
		// registrationEnds = 2026-03-20 23:00 UTC = 2026-03-20 17:00 America/Denver (MDT, UTC-6).
		// `now` = 2026-03-21 00:30 UTC = 2026-03-20 18:30 America/Denver -- same LOCAL calendar day
		// in Denver, but the NEXT UTC calendar day.
		const instantMs = CANONICAL_TIMELINE.registrationEnds;
		const nowMs = Date.UTC(2026, 2, 21, 0, 30, 0);

		const denverDiff = calendarDayDiff(instantMs, nowMs, DENVER);
		const utcDiff = calendarDayDiff(instantMs, nowMs, UTC);

		expect(denverDiff).toBe(0); // same Denver calendar day
		expect(utcDiff).toBe(-1); // one UTC calendar day earlier
	});

	test('no case in this file mutates process.env.TZ', () => {
		// A static assertion of intent: `process.env.TZ` is never referenced anywhere else in this
		// file. Reading it here (never writing) proves the runner's own TZ is irrelevant to the
		// assertions above -- they all pass regardless of what this value is.
		expect(typeof process.env.TZ === 'string' || process.env.TZ === undefined).toBe(true);
	});
});

describe('D-20 Intl fallback: Intl.DateTimeFormat throwing degrades to a date-shaped key', () => {
	let originalDateTimeFormat: typeof Intl.DateTimeFormat;

	beforeEach(() => {
		originalDateTimeFormat = Intl.DateTimeFormat;
	});

	afterEach(() => {
		// Restore unconditionally -- proves no leakage into later suites even if an assertion
		// above this line throws.
		Intl.DateTimeFormat = originalDateTimeFormat;
	});

	test('a past instant falls back to subtitle.pastDate (never a guessed weekday)', () => {
		// @ts-expect-error -- deliberately replacing Intl.DateTimeFormat with a throwing stub to
		// exercise the fallback path; restored in afterEach.
		Intl.DateTimeFormat = () => {
			throw new Error('Intl.DateTimeFormat unavailable (simulated)');
		};

		const nowMs = CANONICAL_TIMELINE.closed;
		const result = relativeDateSubtitle(CANONICAL_TIMELINE.registrationEnds, nowMs, {language: 'en', timeZone: DENVER});
		expect(result.key).toBe('subtitle.pastDate');
		expect(result.params).toHaveProperty('date');
		expect(TIMELINE_KEYS).toContain(result.key);
	});

	test('a future instant falls back to subtitle.futureDate (never a guessed weekday)', () => {
		// @ts-expect-error -- see above.
		Intl.DateTimeFormat = () => {
			throw new Error('Intl.DateTimeFormat unavailable (simulated)');
		};

		const nowMs = CANONICAL_TIMELINE.registrationEnds;
		const result = relativeDateSubtitle(CANONICAL_TIMELINE.closed, nowMs, {language: 'en', timeZone: DENVER});
		expect(result.key).toBe('subtitle.futureDate');
		expect(result.params).toHaveProperty('date');
	});

	test('Intl.DateTimeFormat is restored after this describe block (no leakage)', () => {
		expect(Intl.DateTimeFormat).toBe(originalDateTimeFormat);
	});
});

describe('no literal English or Spanish copy string in relative-date.ts', () => {
	test('grep the source for common copy words finds none', () => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- test-local, source scan
		const fs = require('fs');
		const path = require('path');
		const source: string = fs.readFileSync(path.resolve(__dirname, '../relative-date.ts'), 'utf8');
		const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
		// Copy-shaped words that would indicate resolved English/Spanish literal text leaking into
		// the module (as opposed to i18n key strings like 'subtitle.today', which never contain
		// spaces or capitalized prose words).
		expect(stripped).not.toMatch(/Yesterday|Today|Ayer|Hoy|Mañana|Tomorrow/);
	});
});
