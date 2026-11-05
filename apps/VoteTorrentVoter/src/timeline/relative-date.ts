/**
 * relative-date.ts -- Phase 59 plan 59-06, Task 2.
 *
 * Relative-date subtitle keys/params and the `MM/DD` rail-date format (UI-SPEC "Relative-date
 * subtitles" table). `status` (past/current/future) is a plain instant comparison and stays
 * timezone-free (`derive-timeline.ts`, Task 3) -- that property is load-bearing and this module
 * never touches it. `dayDiff`, `{{weekday}}` and `MM/DD` ARE presentation and use the caller's
 * `timeZone` (device-local by default): computing "Today" in UTC lies to a voter near midnight.
 *
 * Every function here is pure and takes `timeZone`/`language` as arguments -- no ambient clock
 * read, no `process.env.TZ` mutation, matching the "No ambient clock" contract Task 3 scans for.
 * `process.env.TZ` is process-global and order-dependent once any `Date` has been constructed by
 * a jest setup file; passing `timeZone` explicitly makes every case hermetic instead.
 */
import {TIMELINE_KEYS} from './stages';
import type {TimelineSubtitle, TimelineSubtitleParams} from './types';

const MS_PER_DAY = 86_400_000;

/** One formatted instant's numeric calendar parts, in the target timeZone. */
interface DateParts {
	year: number;
	month: number; // 1-indexed
	day: number;
}

/**
 * Format `ms` in `timeZone` and read back numeric year/month/day parts via `formatToParts` --
 * never by parsing a formatted string, and never via `toLocaleDateString` (locale-proof route,
 * per the UI-SPEC). Falls back to UTC `getUTC*` parts if `Intl.DateTimeFormat`/`formatToParts`
 * is missing or throws (D-20 Intl fallback).
 */
function dateParts(ms: number, language: string, timeZone: string): {parts: DateParts; usedIntl: boolean} {
	try {
		const fmt = new Intl.DateTimeFormat(language, {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		});
		const parts = fmt.formatToParts(new Date(ms));
		const get = (type: string): number => {
			const found = parts.find(p => p.type === type);
			if (!found) throw new Error(`formatToParts: missing '${type}' part`);
			return Number(found.value);
		};
		return {parts: {year: get('year'), month: get('month'), day: get('day')}, usedIntl: true};
	} catch {
		const d = new Date(ms);
		return {
			parts: {year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate()},
			usedIntl: false,
		};
	}
}

/**
 * Calendar-day difference between `instantMs` and `nowMs`, in `timeZone` -- positive when
 * `instantMs` is in the future. Computed by rebuilding each formatted date as `Date.UTC(y, m-1,
 * d)` and dividing by one day; never by parsing a formatted string.
 */
export function calendarDayDiff(instantMs: number, nowMs: number, timeZone: string, language = 'en'): number {
	const a = dateParts(instantMs, language, timeZone).parts;
	const b = dateParts(nowMs, language, timeZone).parts;
	const aUtc = Date.UTC(a.year, a.month - 1, a.day);
	const bUtc = Date.UTC(b.year, b.month - 1, b.day);
	return Math.round((aUtc - bUtc) / MS_PER_DAY);
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/**
 * `MM/DD`, zero-padded, month-first, byte-identical in every locale -- the rail is a fixed-width
 * numeric gutter (UI-SPEC), and the localized month NAME is a header concern (59-08), not this
 * module's job. Built from `formatToParts`'s numeric parts, never a formatted/localized string.
 */
export function formatRailDate(instantMs: number, timeZone: string, language = 'en'): string {
	const {parts} = dateParts(instantMs, language, timeZone);
	return `${pad2(parts.month)}/${pad2(parts.day)}`;
}

/**
 * The active-language weekday name via `Intl.DateTimeFormat(..., {weekday: 'long'})` -- never a
 * hand-maintained EN/ES table (UI-SPEC forbids it). Returns `null` if Intl is unavailable/throws,
 * so the caller can fall back to a date-shaped key instead of a weekday-shaped one (D-20).
 */
function weekdayName(instantMs: number, language: string, timeZone: string): string | null {
	try {
		const fmt = new Intl.DateTimeFormat(language, {timeZone, weekday: 'long'});
		return fmt.format(new Date(instantMs));
	} catch {
		return null;
	}
}

interface RelativeDateOptions {
	language?: string;
	timeZone?: string;
}

/**
 * Select the subtitle i18n key + params for `instantMs` relative to `nowMs`, per the UI-SPEC's
 * five-way table. Every returned key is a member of `TIMELINE_KEYS` (Task 1) and every returned
 * value is a key+params pair -- never resolved copy.
 */
export function relativeDateSubtitle(
	instantMs: number,
	nowMs: number,
	{language = 'en', timeZone = 'UTC'}: RelativeDateOptions = {},
): NonNullable<TimelineSubtitle> {
	const dayDiff = calendarDayDiff(instantMs, nowMs, timeZone, language);
	const weekday = weekdayName(instantMs, language, timeZone);

	// D-20 Intl fallback: when the weekday name is unavailable, degrade to the date-shaped key
	// for both `today`/`yesterday`/`futureWeekday` cases rather than guess a weekday. A date is
	// never wrong; a hand-maintained EN/ES weekday table is forbidden by the UI-SPEC.
	if (weekday === null) {
		const params: TimelineSubtitleParams = {date: formatRailDate(instantMs, timeZone, language)};
		const key = dayDiff < 0 ? 'subtitle.pastDate' : 'subtitle.futureDate';
		return assertKnownKey({key, params});
	}

	if (dayDiff === 0) {
		return assertKnownKey({key: 'subtitle.today', params: {weekday}});
	}
	if (dayDiff === -1) {
		return assertKnownKey({key: 'subtitle.yesterday', params: undefined});
	}
	if (dayDiff >= 1 && dayDiff <= 6) {
		return assertKnownKey({key: 'subtitle.futureWeekday', params: {weekday}});
	}
	if (dayDiff <= -2) {
		return assertKnownKey({key: 'subtitle.pastDate', params: {date: formatRailDate(instantMs, timeZone, language)}});
	}
	// dayDiff >= 7
	return assertKnownKey({key: 'subtitle.futureDate', params: {date: formatRailDate(instantMs, timeZone, language)}});
}

function assertKnownKey(subtitle: NonNullable<TimelineSubtitle>): NonNullable<TimelineSubtitle> {
	if (!TIMELINE_KEYS.includes(subtitle.key)) {
		throw new Error(`relative-date.ts: emitted key '${subtitle.key}' is not a member of TIMELINE_KEYS`);
	}
	return subtitle;
}
