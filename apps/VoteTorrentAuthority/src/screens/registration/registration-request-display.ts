import type { RegistrationRequestListRow, RegistrationRequestStatus } from "@votetorrent/vote-core";
import { truncateId } from "./registrant-display";

/**
 * registration-request-display.ts — pure, React-free, theme-free,
 * engine-free display vocabulary for the registration-request inbox and
 * approval screens (D-03/D-06). Every export here is a plain function or a
 * data map; this module imports nothing from React, the theme,
 * `@react-navigation`, or an engine — same posture as
 * `registrant-display.ts`, which it reuses `truncateId` from rather than
 * re-implementing the truncated-key convention.
 */

/**
 * The status-color ladder (Pending=warning / Approved=success /
 * Rejected=error), matching `48-UI-SPEC.md`'s status vocabulary table.
 * `colorKey` is a KEY into `ExtendedTheme["colors"]`, deliberately not a
 * resolved color string, so this module stays theme-free and the same
 * ladder is reusable by the approval screen's header pill without
 * duplicating the map.
 *
 * Disambiguation rule this ladder participates in (UI-SPEC §Color): `warning`
 * HERE means *pending* — a lifecycle stage. The row's 4px left border means
 * *bridge-signed* — a provenance fact. The two never share a shape (pill vs.
 * border) or a position (top-right, same-row pill vs. full-height left edge),
 * so a bridge-signed pending request legitimately carries `colors.warning` in
 * two places at once without conflating them.
 */
export const REGISTRATION_REQUEST_STATUS_META: Record<
	RegistrationRequestStatus,
	{ labelKey: string; colorKey: "success" | "warning" | "error" }
> = {
	p: { labelKey: "registrationRequestStatusPending", colorKey: "warning" },
	a: { labelKey: "registrationRequestStatusApproved", colorKey: "success" },
	r: { labelKey: "registrationRequestStatusRejected", colorKey: "error" },
};

export type RequestRowPillColorKey = "success" | "warning" | "error" | "textSecondary";

/**
 * The inbox row's pill meta. D-44 duplicate closure deliberately leaves
 * `RegistrationRequest.Status = 'p'` (62-19) and surfaces closure only through
 * `row.duplicateClosure`, so a status-only lookup shows a closed request as Pending.
 * Both `'closed'` and `'closing'` render the closed pill, matching the approval
 * screen (`closedAsDuplicate = closure !== undefined`). `textSecondary` is neutral and
 * never collides with the warning=pending / bridge-border disambiguation rule.
 * Returns undefined for an unknown status code with no closure, so the row keeps its
 * raw-code fallback.
 */
export function resolveRequestRowStatusMeta(
	row: Pick<RegistrationRequestListRow, "status" | "duplicateClosure">,
): { labelKey: string; colorKey: RequestRowPillColorKey } | undefined {
	if (row.duplicateClosure === "closed" || row.duplicateClosure === "closing") {
		return { labelKey: "registrationRequestStatusClosedDuplicate", colorKey: "textSecondary" };
	}
	return REGISTRATION_REQUEST_STATUS_META[row.status];
}

/**
 * Structural source type for `registrationRequestDisplayName`. The list row
 * (`RegistrationRequestListRow`) and the point read (`RegistrationRequestRead`)
 * carry different fields — the list row has no `requesterKey`, the point read
 * does — so this type is structural rather than pinned to either concrete
 * type; both satisfy it. `requesterKey` is optional ONLY because
 * `RegistrationRequestListRow` does not carry one today: if the read surface
 * later adds it to the list row, this helper already consumes it with no
 * change.
 */
export type RegistrationRequestNameSource = {
	requestId: string;
	lastName?: string;
	firstName?: string;
	requesterKey?: string;
};

/**
 * Resolves the request's display name: `"Last, First"` when both are present
 * (trimmed, non-empty), whichever one is present alone, a truncated
 * `requesterKey` when present, or a truncated `requestId` as the final
 * fallback. Whitespace-only names are treated as absent, matching
 * `registrantDisplayName`'s rule.
 *
 * A request legitimately has no name — the registration policy may not
 * declare name fields — so the fallback chain is a normal path, not an error
 * path.
 */
export function registrationRequestDisplayName(source: RegistrationRequestNameSource): string {
	const last = source.lastName?.trim();
	const first = source.firstName?.trim();
	if (last && first) return `${last}, ${first}`;
	if (last) return last;
	if (first) return first;
	const requesterKey = source.requesterKey?.trim();
	if (requesterKey) return truncateId(requesterKey);
	return truncateId(source.requestId);
}

/**
 * Resolves the bridge's registered display label: the trimmed non-empty
 * `bridgeLabel` when present, else a truncated `bridgeId`, else `undefined`.
 *
 * `bridgeLabel` is authority-registered registry text
 * (`RegistrationBridgeKey.label`), never content lifted out of the request
 * payload — so a bridge cannot name itself something reassuring through the
 * submission body. A returned `undefined` means "no label resolvable"; callers
 * render the generic `bridgeSourceBadgeLabel` string in that case — it must
 * NEVER be treated as "not a bridge".
 */
export function resolveBridgeLabel(source: { bridgeLabel?: string; bridgeId?: string }): string | undefined {
	const label = source.bridgeLabel?.trim();
	if (label) return label;
	const id = source.bridgeId?.trim();
	if (id) return truncateId(id);
	return undefined;
}

/**
 * Formats an ISO-Z timestamp string to `YYYY-MM-DD`, mirroring
 * `formatExpirationDate`'s behavior verbatim: never throws, and returns the
 * input unchanged rather than rendering `"Invalid Date"` — a triage row must
 * always render.
 */
export function formatRequestTimestamp(iso: string): string {
	const d = new Date(iso);
	if (isNaN(d.getTime())) return iso;
	return d.toISOString().split("T")[0]!;
}

/**
 * The single, pure observed-vs-claimed timestamp rule the row and the
 * approval screen both consume, kept in ONE place so the two surfaces cannot
 * drift into two different readings of the same pair.
 *
 * - `submittedAt` is **submitter-chosen**: a *claim*, carried inside the
 *   request's own signature. It has to be submitter-chosen or an offline
 *   courier's pre-resolved signature could never verify against DG-1
 *   (48-05's L-3). It is therefore attacker-controlled input, bounded only
 *   by 48-07's skew guard (no more than 5 minutes after, or 30 days before,
 *   intake).
 * - `receivedAt` is the **authority's own observation**, written at INSERT,
 *   inside NO digest, and the key 48-08's triage queue sorts by — so the
 *   timestamp a row shows by default is the same clock that decided where
 *   that row sits in the queue.
 * - Therefore, when only one value is shown, the one shown is `received` —
 *   NEVER the claim. A lone timestamp on a registration-request row is
 *   always authority-observed.
 * - `claimed` is returned ONLY when the two differ at the rendered
 *   precision, so the row never prints two identical date strings (pure
 *   noise, and noise on this row competes with the D-03 marker for a
 *   hurried officer's attention) and ALWAYS prints two differing ones.
 *   Divergence is the visible case by construction — exactly the case
 *   T-48-05-09 / T-48-07-12 / T-48-08-11 accept the residual risk on the
 *   strength of.
 * - This function performs no masking and no logging, and it never swaps
 *   the two members.
 *
 * Comparison is on the FORMATTED strings, never the raw ISO values, so what
 * this function decides and what the officer sees can never disagree.
 */
export function resolveRowTimestamps(source: { submittedAt: string; receivedAt: string }): {
	received: string;
	claimed?: string;
} {
	const received = formatRequestTimestamp(source.receivedAt);
	const claimedFormatted = formatRequestTimestamp(source.submittedAt);
	if (claimedFormatted === received) {
		return { received };
	}
	return { received, claimed: claimedFormatted };
}

/**
 * i18n keys for the payload field names the Voter app actually submits (public `firstName`/
 * `lastName`, private `dob`/`email`/`phone`/`addressLine1..3`, selective `party`). Deliberately
 * no wider: every other name falls back to `humanizeFieldName`.
 */
export const KNOWN_REQUEST_FIELD_LABEL_KEYS: Readonly<Record<string, string>> = {
	firstName: "registrationRequestFieldFirstName",
	lastName: "registrationRequestFieldLastName",
	dob: "registrationRequestFieldDob",
	email: "registrationRequestFieldEmail",
	phone: "registrationRequestFieldPhone",
	addressLine1: "registrationRequestFieldAddressLine1",
	addressLine2: "registrationRequestFieldAddressLine2",
	addressLine3: "registrationRequestFieldAddressLine3",
	party: "registrationRequestFieldParty",
};

/**
 * Readable label for an unknown/custom payload field name: camelCase, snake_case and kebab-case
 * split into words, digits split off, first letter capitalized ("homeCounty_code2" -> "Home county
 * code 2"). A dotted nested name humanizes each segment and joins them with " / ".
 */
export function humanizeFieldName(name: string): string {
	return name
		.split(".")
		.map((segment) => {
			const words = segment
				.replace(/([a-z])([A-Z])/g, "$1 $2")
				.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
				.replace(/([A-Za-z])([0-9])/g, "$1 $2")
				.replace(/([0-9])([A-Za-z])/g, "$1 $2")
				.replace(/[_\-\s]+/g, " ")
				.trim()
				.toLowerCase();
			return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : segment;
		})
		.join(" / ");
}
