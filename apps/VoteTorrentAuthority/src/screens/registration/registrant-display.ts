import type { RegistrantListRow, RegistrantStatus } from "@votetorrent/vote-core";

/**
 * registrant-display.ts — pure, React-free, theme-free, engine-free display
 * vocabulary for the whole `src/screens/registration/` tree (D-08). Every
 * export here is a plain function or a data map; this module imports nothing
 * from React, the theme, `@react-navigation`, or an engine.
 */

/**
 * The D-13/UI-SPEC status-color ladder (Active/success, Suspended/warning,
 * Revoked/error). `colorKey` is a KEY into `ExtendedTheme["colors"]`,
 * deliberately not a resolved color string, so this module stays theme-free
 * and the same ladder is reusable elsewhere (47-20's header pill) without
 * duplicating the map. This ladder must stay identical, tier-for-tier
 * (success/warning/error), to the verdict ladder `VerdictBadge` (47-10,
 * `screens/registration/components/VerdictBadge.tsx`) uses for its own
 * pass/fail/none states.
 */
export const REGISTRANT_STATUS_META: Record<
	RegistrantStatus,
	{ labelKey: string; colorKey: "success" | "warning" | "error" }
> = {
	a: { labelKey: "registrantStatusActive", colorKey: "success" },
	s: { labelKey: "registrantStatusSuspended", colorKey: "warning" },
	r: { labelKey: "registrantStatusRevoked", colorKey: "error" },
};

/**
 * Truncates `id` to its first `keep` characters plus an ellipsis, returning
 * `id` unchanged when it is no longer than `keep`. Generalizes
 * `HistoryEvent.tsx`'s `signer.slice(0,5)+"..."` truncated-key convention
 * into a reusable helper for the whole registration tree.
 */
export function truncateId(id: string, keep = 5): string {
	if (id.length <= keep) return id;
	return id.slice(0, keep) + "...";
}

/**
 * Resolves the roster's display name: `"Last, First"` when both are present
 * (trimmed, non-empty), whichever one is present alone, or a truncated
 * `Registrant.Id` when neither is present. `lastName`/`firstName` arrive from
 * the CURRENT `RegistrantPublic` row only. Both callers now guarantee that:
 * the roster via 47-05's `REGISTRANT_PUBLIC_CURRENCY_JOIN`, and the detail
 * screen via `getRegistrantPublic`'s point-read
 * `REGISTRANT_PUBLIC_POINT_CURRENCY_JOIN`. (Before 47-REVIEW WR-04 that claim
 * held on the roster only — the detail screen's point read carried no currency
 * predicate at all and could serve a superseded revision.) A registrant with
 * no public tier — `Registrant.PublicCid` is nullable — legitimately has
 * neither name, which is why the truncated-id fallback exists and is not an
 * error path.
 */
export function registrantDisplayName(
	row: Pick<RegistrantListRow, "registrantId" | "lastName" | "firstName">,
): string {
	const last = row.lastName?.trim();
	const first = row.firstName?.trim();
	if (last && first) return `${last}, ${first}`;
	if (last) return last;
	if (first) return first;
	return truncateId(row.registrantId);
}

/**
 * Formats an ISO-Z expiration string to `YYYY-MM-DD`, matching
 * `displayUtils.formatDate`'s output shape — that helper cannot be reused
 * directly since it takes an epoch **number** and `RegistrantListRow.expiration`
 * is an ISO-Z **string**. Never throws and never renders `"Invalid Date"`: a
 * roster row must always render, so an unparseable input is returned
 * unchanged.
 */
export function formatExpirationDate(iso: string): string {
	const d = new Date(iso);
	if (isNaN(d.getTime())) return iso;
	return d.toISOString().split("T")[0]!;
}
