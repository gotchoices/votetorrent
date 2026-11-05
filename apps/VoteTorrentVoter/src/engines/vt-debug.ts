/**
 * vt-debug.ts - privacy-safe debug logging for device runs ("easier to debug fast").
 *
 * `vtDebug(tag, event, detail)` writes `console.log('[vt-<tag>] <event>', detail)` ONLY in a __DEV__
 * build, and only when `VT_DEBUG_LOGS` (proof-flags.generated.ts, committed false) is on or the
 * runtime switch `globalThis.__VT_DEBUG__ === true` was set (over CDP, no rebuild). With both off it
 * does nothing, so every console-leak and never-logs gate (they run with the flag off) stays silent.
 *
 * What may be logged: state names, timings, counts, codes and class names. Never keys, signatures,
 * ciphertext, envelopes, join codes or error message text. The detail is sanitised as a second line of
 * defence, not as permission to pass secrets:
 *   - numbers, booleans and null are kept; undefined is left out;
 *   - a string run of 13+ base64/hex characters that contains a digit (or is all hex) is cut to its
 *     first 8 characters plus '…' (digests, cids, peer ids, signatures);
 *   - free text becomes "<text>" (IN-02: a remote former's reason reaches the pool log as `why`):
 *     under a free-text key (`reason`, `why`, `detail`, `error`) every string that is not a code
 *     token (`BIOMETRIC_ERROR`, `voting-closed`) or a short plain phrase (lowercase words, at most 24
 *     characters, no punctuation) does; under any other key a string with whitespace longer than 24
 *     characters (after the cut above) does;
 *   - a string is then capped at 48 characters;
 *   - objects, arrays, functions and every other type become "<dropped>";
 *   - a `message` or `stack` key becomes "<redacted>" (pool-agent's own log passes error messages).
 * It never throws.
 *
 * Read the output in Metro / a CDP console (filter `[vt-`), or on Android with
 * `adb logcat -s ReactNativeJS:I | grep '\[vt-'`.
 */
import * as proofFlags from './proof-flags.generated';

const MAX_STRING = 48;
const PREFIX_CHARS = 8;
const OPAQUE_RUN = /[A-Za-z0-9+/=_-]{13,}/g;
const REDACTED_KEYS = new Set(['message', 'stack']);
/** keys whose value may carry free text (a peer's or an error's words), scrubbed strictly */
const FREE_TEXT_KEYS = new Set(['reason', 'why', 'detail', 'error']);
const FREE_TEXT_MAX = 24;
/** a code or state token: one word of letters, digits, '_' and '-' */
const CODE_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
/** a short plain phrase from our own code ('handed over', 'coordinator went silent') */
const PLAIN_PHRASE = /^[a-z][a-z0-9 -]{0,23}$/;
const TEXT = '<text>';

/** True when vtDebug writes: a __DEV__ build with VT_DEBUG_LOGS on or `globalThis.__VT_DEBUG__ === true`. */
export function vtDebugEnabled(): boolean {
	try {
		if (typeof __DEV__ === 'undefined' || !__DEV__) return false;
		return (proofFlags as {VT_DEBUG_LOGS?: unknown}).VT_DEBUG_LOGS === true
			|| (globalThis as {__VT_DEBUG__?: unknown}).__VT_DEBUG__ === true;
	} catch {
		return false;
	}
}

/** The first 8 characters of an id, for correlating log lines without logging the id. */
export function idPrefix(id: unknown): string {
	return typeof id === 'string' ? id.slice(0, PREFIX_CHARS) : typeof id;
}

function cutOpaqueRuns(s: string): string {
	return s.replace(OPAQUE_RUN, (run) => (/[0-9]/.test(run) || /^[0-9a-fA-F]+$/.test(run) ? run.slice(0, PREFIX_CHARS) + '…' : run));
}

function sanitiseString(s: string): string {
	const cut = cutOpaqueRuns(s);
	return cut.length > MAX_STRING ? cut.slice(0, MAX_STRING) + '…' : cut;
}

/** True when a detail string is free text that is logged as "<text>" (IN-02). */
function isFreeText(key: string, v: string): boolean {
	if (FREE_TEXT_KEYS.has(key)) return !CODE_TOKEN.test(v) && !PLAIN_PHRASE.test(v);
	// judged after the opaque runs are cut, so an id inside a short line does not make it free text
	const cut = cutOpaqueRuns(v);
	return /\s/.test(cut) && cut.length > FREE_TEXT_MAX;
}

/** The log-safe copy of a detail object (exported for the tests). */
export function sanitiseDetail(detail: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(detail)) {
		const v = detail[key];
		if (v === undefined) continue;
		if (REDACTED_KEYS.has(key)) out[key] = '<redacted>';
		else if (v === null || typeof v === 'boolean' || typeof v === 'number') out[key] = v;
		else if (typeof v === 'string') out[key] = isFreeText(key, v) ? TEXT : sanitiseString(v);
		else out[key] = '<dropped>';
	}
	return out;
}

export function vtDebug(tag: string, event: string, detail?: Record<string, unknown>): void {
	try {
		if (!vtDebugEnabled()) return;
		const head = '[vt-' + sanitiseString(String(tag)) + '] ' + sanitiseString(String(event));
		if (detail !== null && typeof detail === 'object') console.log(head, sanitiseDetail(detail));
		else console.log(head);
	} catch {
		// a debug line must never break the flow it describes
	}
}
