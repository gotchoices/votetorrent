/**
 * reader-instant.js — D-26's DISPLAY half, and the single sanctioned instant
 * formatter for this app.
 *
 * THE ASYMMETRY THAT MAKES D-26 SUBTLE, stated once so no later plan has to
 * re-derive it:
 *
 *   COMPARISON is UTC, on purpose.  DISPLAY is reader-local, on purpose.
 *
 * They pull in opposite directions and confusing them turns what looks like a
 * formatting preference into a correctness bug. The canonical 19-character
 * timeline values carry no zone suffix, so letting the engine guess how to
 * parse them makes the DERIVED PHASE depend on where the reader is sitting:
 * two people opening the same link at the same moment would be told different
 * things about the same election — one "Polls are open", the other "closed".
 * On a page whose only value is that its claims can be checked, that is a
 * false claim, not a formatting nit. `normalizeInstant`
 * (packages/ui-web/src/lifecycle/election-phase.js) therefore pins the
 * canonical form to UTC by appending an explicit `Z` before parsing, and every
 * boundary comparison runs on UTC-canonical strings.
 *
 * A DISPLAYED instant is the opposite case: a reader wants to know when
 * something happens where THEY are, so this function formats in the reader's
 * own resolved locale and zone — and RETURNS THE ZONE LABEL alongside the
 * text, because an unlabelled local time is exactly as ambiguous as the
 * unzoned canonical value it came from. It parses with the same explicit `Z`
 * the comparison half uses; the reader-local part is the FORMATTING, never
 * the parse.
 *
 * WHY THIS FUNCTION EXISTS HERE, AND WHY IT IS THE ONLY ONE. 54-12 owns D-26,
 * so both halves land together even though this half has no render site yet:
 * the first RENDERED instant is 54-13's. Every later plan (54-13's facts,
 * 54-14's roll, 54-15's live seam) routes a displayed instant through this
 * function rather than re-deriving one, so that the zone label and the
 * explicit-UTC parse cannot drift apart across four render plans. A drift
 * fence in `test/node/public-election-source.test.mjs` asserts that no other
 * file under `src/` reaches for a locale formatter, with a planted control
 * proving the fence fires.
 *
 * NEVER THROWS. Every unusable input yields `null` — an anonymous page has no
 * operator to surface a formatting failure to, and a thrown formatter on a
 * verifiability page blanks the very claims someone came to check.
 */

/**
 * The canonical VT instant: 19 characters, `T` separator, NO zone suffix.
 * Deliberately re-stated here rather than imported, because this module is
 * the app's own boundary and must not acquire a dependency on the lifecycle
 * package's internals to answer a formatting question.
 * @type {RegExp}
 */
const CANONICAL_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/**
 * @typedef {object} ReaderInstant
 * @property {string} text  the instant in the reader's own locale and zone
 * @property {string} zone  the IANA zone name that `text` is expressed in
 */

/**
 * Format one canonical 19-character instant for THIS reader, labelled with
 * the zone it is expressed in.
 *
 * @param {unknown} canonicalValue
 * @returns {Readonly<ReaderInstant> | null} null for anything unusable.
 */
export function formatReaderInstant(canonicalValue) {
	try {
		if (typeof canonicalValue !== 'string') return null;
		const trimmed = canonicalValue.trim();
		if (!CANONICAL_INSTANT_RE.test(trimmed)) return null;

		// The explicit `Z` is the whole point: without it the engine parses a
		// zoneless string in the reader's own zone, which would silently shift
		// the INSTANT rather than only its presentation.
		const ms = Date.parse(`${trimmed}Z`);
		if (!Number.isFinite(ms)) return null;

		const formatter = new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short',
		});
		const resolved = formatter.resolvedOptions();
		const zone = typeof resolved.timeZone === 'string' && resolved.timeZone !== '' ? resolved.timeZone : 'UTC';

		return Object.freeze({ text: formatter.format(new Date(ms)), zone });
	} catch {
		// A locale or zone the host cannot resolve is an environment fact, not
		// a defect in the value — it yields no text, and the caller renders
		// nothing rather than a guess.
		return null;
	}
}
