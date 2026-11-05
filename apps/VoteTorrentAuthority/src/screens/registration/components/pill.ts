import { StyleSheet } from "react-native";

/**
 * pill.ts — shared pill geometry + status-tint helper for Phase 47's status
 * pills (`VerdictBadge` here, 47-11's `registrantStatus` pill downstream).
 * Extracted to a plain, React-free module so the two pill treatments cannot
 * drift apart.
 */

/** RN `#RRGGBBAA` suffix for a translucent pill background (~13% opacity). */
export const PILL_TINT_ALPHA = "22";

/**
 * Returns a translucent tint of `color` suitable for a pill background.
 *
 * Every `ExtendedTheme` palette token in `theme/themes.ts` is a 7-char
 * `#RRGGBB` literal in both the light and dark palettes, so suffixing with
 * `PILL_TINT_ALPHA` always yields a valid 9-char `#RRGGBBAA` string. If a
 * future token ever becomes an `rgba(...)` value or an 8-digit hex, this
 * helper must be revisited — the theme-shape test in `VerdictBadge.test.tsx`
 * is the tripwire that catches that drift.
 */
export function tintPill(color: string): string {
	return color + PILL_TINT_ALPHA;
}

/**
 * Shared pill geometry (`47-UI-SPEC.md:238`'s registrantStatus pill shape).
 * Both `VerdictBadge` and 47-11's `registrantStatus` pill compose
 * `pillStyles.pill` so the two treatments cannot visually drift.
 */
export const pillStyles = StyleSheet.create({
	pill: {
		paddingHorizontal: 8,
		paddingVertical: 2,
		borderRadius: 10,
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		alignSelf: "flex-start",
	},
});
