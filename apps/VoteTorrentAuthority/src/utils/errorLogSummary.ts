/**
 * errorLogSummary — one log-safe line that says WHY something failed: the error's class, its `code`
 * (and a native code, when a vault error carries one), and its message with every secret-shaped run
 * removed.
 *
 * Why a scrubbed message and not only the class: an engine failure crosses the vote-engine boundary
 * as a plain `Error` (rethrow keeps the code and the text, not the class), so a release-build log of
 * the class alone reads `Error` and says nothing (a Redmi accept failure, 24 Nov 2026).
 *
 * What is removed before the message is logged, in this order:
 *  - anything between the first `{` and the last `}` (an invitation share is a JSON object);
 *  - quoted text, single or double (names, aliases, SQL values);
 *  - hex runs of 16 or more characters (private keys, public keys, digests, signatures);
 *  - base32 CIDs (`ba…`) of 20 or more characters;
 *  - any other run of 20 or more id characters that holds a digit (peer ids, base58 or base64 ids,
 *    UUIDs, multiaddr parts).
 * The result is capped at MAX_MESSAGE_CHARS. Never throws.
 *
 * Only for logs. Never render this: the screens' raw-error rule still holds (fixed copy per class).
 */

const MAX_MESSAGE_CHARS = 240;
const TOKEN_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

function token(value: unknown): string | undefined {
	return typeof value === "string" && TOKEN_RE.test(value) ? value : undefined;
}

/** The message text with every secret-shaped run replaced by a placeholder. Exported for tests. */
export function scrubLogText(text: string): string {
	let s = text;
	const open = s.indexOf("{");
	const close = s.lastIndexOf("}");
	if (open >= 0 && close > open) s = s.slice(0, open) + "{…}" + s.slice(close + 1);
	else if (open >= 0) s = s.slice(0, open) + "{…";
	s = s.replace(/'[^'\n]*'/g, "'…'").replace(/"[^"\n]*"/g, '"…"').replace(/`[^`\n]*`/g, "`…`");
	s = s.replace(/[0-9a-fA-F]{16,}/g, "<hex>");
	s = s.replace(/\bba[a-z2-7]{18,}/g, "<cid>");
	s = s.replace(/[A-Za-z0-9+/=_-]{20,}/g, (run) => (/\d/.test(run) ? "<id>" : run));
	s = s.replace(/\s+/g, " ").trim();
	return s.length > MAX_MESSAGE_CHARS ? `${s.slice(0, MAX_MESSAGE_CHARS)}…` : s;
}

/** `class=<name> code=<code> native=<code> msg=<scrubbed>`; fields that are absent are left out. */
export function errorLogSummary(err: unknown): string {
	try {
		if (err === null || typeof err !== "object") return `type=${err === null ? "null" : typeof err}`;
		const e = err as { name?: unknown; code?: unknown; nativeCode?: unknown; message?: unknown };
		const parts = [`class=${token(e.name) ?? "unknown"}`];
		const code = token(e.code);
		if (code) parts.push(`code=${code}`);
		const nativeCode = token(e.nativeCode);
		if (nativeCode) parts.push(`native=${nativeCode}`);
		if (typeof e.message === "string" && e.message.length > 0) parts.push(`msg=${scrubLogText(e.message)}`);
		return parts.join(" ");
	} catch {
		return "class=unknown";
	}
}
