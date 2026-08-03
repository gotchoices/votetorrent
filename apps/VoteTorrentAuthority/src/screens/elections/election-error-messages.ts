// Friendly, user-facing error mapping for the election create/revise forms.
// Engines surface raw failures — structured BuilderValidationError objects and
// SQL CHECK-constraint messages (e.g. "BallotDeadlineValid") — that are useless to
// an organizer. This maps them to plain-language copy, with special care for the
// deadline/timeline rules that are easy to trip.

/** Minimal translate signature — avoids importing i18next types into screens. */
export type Translate = (key: string, opts?: Record<string, unknown>) => string;

/** Shape of a single structured builder validation error (vote-core BuilderError). */
interface BuilderErrorLike {
	path: string;
	code: string;
	message: string;
}

/**
 * Duck-typed check for vote-core's BuilderValidationError. We avoid `instanceof`
 * because the error can cross bundle boundaries (RN/Metro) where identity breaks.
 */
function isBuilderValidationError(
	err: unknown
): err is { name: string; errors: BuilderErrorLike[] } {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { name?: unknown }).name === "BuilderValidationError" &&
		Array.isArray((err as { errors?: unknown }).errors)
	);
}

/** Map one structured builder error (by code, then path) to friendly copy. */
function friendlyBuilderError(e: BuilderErrorLike, t: Translate): string {
	switch (e.code) {
		case "THRESHOLD_EXCEEDS_KEYHOLDERS":
			return t("errThresholdExceedsKeyholders");
		case "TIMELINE_ORDER":
			return t("errTimelineOrder");
		case "EMPTY":
		case "MISSING":
		case "INVALID":
			if (e.path.includes("revisionDeadline")) return t("errRevisionDeadlineInvalid");
			if (e.path.includes("date")) return t("errElectionDateInvalid");
			if (e.path.includes("title")) return t("errTitleRequired");
			return e.message;
		default:
			return e.message;
	}
}

/**
 * Convert any error thrown while proposing/adjusting an election into a single
 * user-friendly string. Falls back to a generic save message — never leaks a raw
 * SQL constraint name or stack to the UI.
 */
export function mapElectionError(err: unknown, t: Translate): string {
	if (isBuilderValidationError(err)) {
		// De-dupe so repeated codes (e.g. two date paths) don't show twice.
		const seen = new Set<string>();
		const lines: string[] = [];
		for (const e of err.errors) {
			const msg = friendlyBuilderError(e, t);
			if (!seen.has(msg)) {
				seen.add(msg);
				lines.push(msg);
			}
		}
		return lines.join("\n");
	}

	const raw = err instanceof Error ? err.message : String(err);
	// Known DB CHECK constraints — especially the deadline ordering rules.
	if (/BallotDeadlineValid/i.test(raw)) return t("errBallotDeadlineAfterDate");
	if (/RevisionDeadline/i.test(raw) && /Date/i.test(raw)) {
		return t("errRevisionDeadlineAfterDate");
	}
	if (/timeline|votingStarts|tallyingStarts|certification/i.test(raw)) {
		return t("errTimelineOrder");
	}
	return t("errCouldNotSaveElection");
}
