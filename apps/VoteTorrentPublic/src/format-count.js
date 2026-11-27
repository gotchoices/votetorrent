/**
 * format-count.js -- the one count formatter for this page.
 *
 * Every count the page shows (ballots cast, vote blocks, per-option totals,
 * registrants per district) goes through `formatCount`, so "12345" reads as
 * "12,345". It formats in the PAGE's language, the `lang` on the document
 * root (index.html sets it), not the reader's own locale: the sentence around
 * the number is in the page's language, and a number grouped for a different
 * language inside it reads wrong. Outside a browser (the node tests) the
 * language falls back to `en`.
 *
 * NEVER THROWS. A value that is not a finite number or a bigint comes back as
 * `String(value)`, the same text the page showed before this formatter, and a
 * language the host cannot resolve falls back to `en`.
 */

/** @returns {string} */
export function pageLanguage() {
	try {
		const lang = globalThis.document?.documentElement?.lang;
		return typeof lang === 'string' && lang.trim() !== '' ? lang.trim() : 'en';
	} catch {
		return 'en';
	}
}

/**
 * @param {unknown} value
 * @param {string} [lang] defaults to the page's language
 * @returns {string}
 */
export function formatCount(value, lang = pageLanguage()) {
	if (typeof value !== 'bigint' && (typeof value !== 'number' || !Number.isFinite(value))) return String(value);
	try {
		return new Intl.NumberFormat(lang, { maximumFractionDigits: 0 }).format(value);
	} catch {
		try {
			return new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(value);
		} catch {
			return String(value);
		}
	}
}
