import type { RegistrantAccessEvent } from "@votetorrent/vote-core";
import { truncateId } from "./registrant-display";

/**
 * access-history-format.ts — pure, React-free, theme-free, engine-free
 * display vocabulary for the D-01 reviewer surface (`AccessHistorySection`).
 * These helpers format the authority-held record of app-mediated reads of a
 * registrant's private tier for display; the record exists for
 * accountability, deterrence and regulatory posture and is not a security control
 * — an officer holding the device can read the local Quereus/LevelDB file
 * directly and no row is written by that path. No function here receives,
 * formats or returns a private VALUE: the only registrant-derived strings
 * that pass through are attribute NAMES already filtered engine-side by
 * 47-07's `sanitizeAccessTrailFields`.
 */

/**
 * Formats a `RegistrantAccessEvent.timestamp` (Z-suffixed ISO) as
 * `"YYYY-MM-DD HH:MM UTC"`. Never throws and never renders `"Invalid Date"`
 * — an audit row must always render, so an unparseable input is returned
 * unchanged, mirroring `registrant-display.ts`'s `formatExpirationDate`
 * never-throw posture.
 *
 * Renders in UTC, not host-local time: `RegistrantAccessEvent.timestamp` is
 * stored Z-suffixed and re-stamped by 47-07's `reZuluDatetime`, and a
 * host-local render would be non-deterministic under `react-test-renderer`,
 * which this phase's D-16 bar requires every UI decision to be assertable
 * in. The literal `" UTC"` suffix is a unit marker, not copy — it is
 * identical in both locales and no i18n key may be added for it, because
 * 47-02's `registrant-keys.test.ts` pins `registrantAccessTrail*` at
 * exactly 5 keys and the phase at 117. `Intl.DateTimeFormat` is
 * deliberately not used (Hermes ICU availability is not a dependency this
 * phase takes on).
 */
export function formatAccessTimestamp(iso: string): string {
	const date = new Date(iso);
	if (isNaN(date.getTime())) return iso;
	return date.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/**
 * Joins the revealed field NAMES for one row with `", "`, keeping only
 * entries that are strings with a non-empty trim. Returns `""` for
 * `undefined`, a non-array input, or an all-empty list.
 *
 * 47-07 never writes an empty `fields` array (an empty sanitizer result
 * skips the insert entirely), so `""` is a defensive path for malformed
 * stored JSON rather than an expected state. The entries handed in here are
 * attribute NAMES — this function must never be repurposed to join values.
 */
export function joinFieldNames(fields: readonly string[] | undefined): string {
	if (!Array.isArray(fields)) return "";
	return fields
		.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
		.map((f) => f.trim())
		.join(", ");
}

/**
 * Resolves the label for a trail row's viewer: `resolvedName.trim()` when
 * `resolvedName` is a string with a non-empty trim, otherwise
 * `truncateId(viewerUserId)`.
 *
 * The fallback exists because the schema puts no foreign-key CHECK on
 * `ViewerUserId` (47-07) and because name resolution is a second,
 * non-blocking network-engine round trip — an unresolved viewer must never
 * block, delay or error the row (`47-UI-SPEC.md:350-352`). When
 * `viewerUserId` is itself empty or not a string, this returns
 * `truncateId("")`'s result (the empty string) rather than throwing.
 */
export function resolveViewerLabel(viewerUserId: string, resolvedName?: string): string {
	if (typeof resolvedName === "string" && resolvedName.trim().length > 0) {
		return resolvedName.trim();
	}
	if (typeof viewerUserId !== "string") return truncateId("");
	return truncateId(viewerUserId);
}
