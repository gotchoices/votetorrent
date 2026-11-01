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

function sanitiseString(s: string): string {
	const cut = s.replace(OPAQUE_RUN, (run) => (/[0-9]/.test(run) || /^[0-9a-fA-F]+$/.test(run) ? run.slice(0, PREFIX_CHARS) + '…' : run));
	return cut.length > MAX_STRING ? cut.slice(0, MAX_STRING) + '…' : cut;
}

/** The log-safe copy of a detail object (exported for the tests). */
export function sanitiseDetail(detail: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(detail)) {
		const v = detail[key];
		if (v === undefined) continue;
		if (REDACTED_KEYS.has(key)) out[key] = '<redacted>';
		else if (v === null || typeof v === 'boolean' || typeof v === 'number') out[key] = v;
		else if (typeof v === 'string') out[key] = sanitiseString(v);
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
