import { peerUnavailableMessage } from "./peerUnavailableMessage";

/**
 * errorCopy: the one shared, translated fallback for any caught error that a screen would
 * otherwise render raw. The engine's text carries table names, ids, Quereus text and
 * English-only builder wording; none of that may reach an officer.
 *
 * Order: (1) the peer-unavailable copy when the cohort is unreachable; (2) translated lines for a
 * builder validation error, mapped by code; (3) otherwise a translated generic message for the
 * kind ('read' = a load, 'write' = an action), or the screen's own key via `fallbackKey`.
 *
 * Logging: by default one `console.warn('[ui-error]', kind, token)` line, where the token is an
 * own-property code or the class name only (never the error's message property, never an id).
 * Registration screens pass `{ log: false }` because they have a never-log rule that their
 * suites enforce with console spies.
 *
 * The signing-error hook's return contract is NOT changed: six hook callers pass a
 * screen-specific key after the hook's outcome message, and the hook's own test pins a
 * non-signing error to `{ handled: false, message: undefined }`. A hook that returned a generic
 * message would override all six. Callers use this function in place of the raw text instead.
 *
 * This file never reads the error's message property (the tree-wide guard scans it).
 */

type Translate = (key: string, opts?: Record<string, unknown>) => string;

type BuilderErrorLike = { path?: unknown; code?: unknown };
type BuilderValidationLike = { name: string; errors: BuilderErrorLike[] };

const TOKEN_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Duck-typed, like the election screens' check (the class lives in vote-core). */
export function isBuilderValidationError(err: unknown): err is BuilderValidationLike {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { name?: unknown }).name === "BuilderValidationError" &&
		Array.isArray((err as { errors?: unknown }).errors)
	);
}

/** One builder error to translated copy, by code only. */
export function builderErrorLineCopy(e: BuilderErrorLike, t: Translate): string {
	const code = typeof e?.code === "string" ? e.code : "";
	switch (code) {
		case "THRESHOLD_EXCEEDS_KEYHOLDERS":
			return t("errThresholdExceedsKeyholders");
		case "TIMELINE_ORDER":
			return t("errTimelineOrder");
		case "NO_RELAYS":
			return t("errRelayRequired");
		case "MISSING":
		case "EMPTY":
			return t("validationRequired");
		default:
			if (code === "INVALID" || code.startsWith("INVALID_")) return t("validationInvalid");
			return t("validationFailed");
	}
}

/** De-duplicated lines joined with a newline; an empty list gives the generic validation copy. */
export function builderErrorsCopy(errors: BuilderErrorLike[], t: Translate): string {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const e of errors) {
		const line = builderErrorLineCopy(e, t);
		if (!seen.has(line)) {
			seen.add(line);
			lines.push(line);
		}
	}
	return lines.length === 0 ? t("validationFailed") : lines.join("\n");
}

/** A short, log-safe token: an own string code, else the class name, else the typeof. */
export function errorToken(err: unknown): string {
	if (typeof err === "object" && err !== null) {
		if (Object.prototype.hasOwnProperty.call(err, "code")) {
			const code = (err as { code?: unknown }).code;
			if (typeof code === "string" && TOKEN_RE.test(code)) return code;
		}
		const name = (err as { name?: unknown }).name;
		if (typeof name === "string" && TOKEN_RE.test(name)) return name;
	}
	return typeof err;
}

export function errorCopy(
	err: unknown,
	t: Translate,
	kind: "read" | "write",
	opts?: { fallbackKey?: string; log?: boolean },
): string {
	const peer = peerUnavailableMessage(err, t, kind);
	if (peer !== undefined) return peer;
	if (isBuilderValidationError(err)) return builderErrorsCopy(err.errors, t);
	if (opts?.log !== false) {
		console.warn("[ui-error]", kind, errorToken(err));
	}
	return t(opts?.fallbackKey ?? (kind === "read" ? "errorLoadFailedGeneric" : "errorActionFailedGeneric"));
}
