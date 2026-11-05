import React from "react";
import { StyleSheet, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { ThemedText } from "../../../components/ThemedText";
import { globalStyles } from "../../../theme/styles";
import type { PriorRejection } from "@votetorrent/vote-core";

/**
 * PriorRejectionsCallout — the D-06 repudiation-risk mitigation. Renders
 * directly below the bridge callout and above the request summary on
 * 48-19's approval screen, so an officer reviewing a re-submitted request
 * sees a prior refusal BEFORE deciding — an officer who never scrolls must
 * still see it.
 *
 * Owns no state, makes no engine call, and takes no `canWrite` prop —
 * reading a rejection history is a read, not a write. Imports no navigation
 * hook and no officer-scope hook, and makes no claim that the `'vrg'` gate
 * is enforced.
 *
 * **Absence-is-the-signal rule (first statement in the component body):**
 * with zero prior rejections this component returns `null` — not a muted
 * variant, not an empty card, not a "no prior rejections" line. An empty
 * callout would be a false signal on a first-time applicant's request. This
 * is the same absence-is-default convention Phase 46's "Extra Field" badge
 * and Phase 47's status markers established, and 48-14's row applies it to
 * the bridge marker.
 *
 * **48-14 colour-reservation note.** `RegistrationRequestRow` (48-14)
 * reserves its own `borderLeftWidth: 4, borderLeftColor: colors.warning`
 * treatment EXCLUSIVELY for D-03 bridge provenance on that row component —
 * never for a lifecycle reason. This callout ALSO uses a 4px `colors.warning`
 * left border, and that is correct, not a collision: 48-UI-SPEC.md §Color
 * assigns `colors.warning` to four distinct treatments side by side,
 * including "(a) the D-03 bridge marker … (d) the `PriorRejectionsCallout`'s
 * left border". 48-14's exclusivity is scoped to that row component, where a
 * warning left border must mean "bridge" and nothing else; a different
 * component on a different screen carrying the same hue is disambiguated by
 * being a different component with its own heading and its own glyph. A
 * reader comparing this file with `RegistrationRequestRow.tsx` should see
 * both warning left borders are sanctioned, neither is a mistake.
 *
 * Never-log rule (D-06 / carried from Phase 47's `PrivateFieldRow`):
 * `rejectionReason` is officer-authored free text and may name a person or a
 * document. It has exactly ONE destination in this file — the interpolated
 * `ThemedText` row child. This file writes nothing to `console.*`, declares
 * no error state, and binds no rejection value into any error message or
 * crash payload.
 */

export interface PriorRejectionsCalloutProps {
	rejections: readonly PriorRejection[];
	/**
	 * Optional officer-name resolver. Defaults to the identity function.
	 * 48-14's `registration-request-display.ts` owns name resolution and is a
	 * PARALLEL wave-6 plan — importing it here would create a file-ordering
	 * dependency this plan does not have. 48-19 can pass that helper in once
	 * both have landed. Until then the raw officer id is rendered: an id is
	 * an honest, attributable value, and an unresolved id is strictly better
	 * than a blank.
	 */
	resolveOfficerName?: (decidingOfficerUserId: string) => string;
	testIDPrefix?: string;
}

/**
 * Formats an ISO-Z timestamp to `YYYY-MM-DD`, returning the input unchanged
 * on anything unparseable rather than throwing — `formatExpirationDate`'s
 * never-throw discipline. A malformed stored timestamp must never crash an
 * approval screen.
 */
function formatRejectedAt(iso: string): string {
	const d = new Date(iso);
	if (isNaN(d.getTime())) return iso;
	return d.toISOString().split("T")[0]!;
}

/**
 * Parses `iso` to an epoch number for sort comparison, or `undefined` when
 * unparseable — the sort comparator below treats an unparseable side as
 * equal so the sort stays stable and never throws.
 */
function parseTime(iso: string): number | undefined {
	const t = new Date(iso).getTime();
	return isNaN(t) ? undefined : t;
}

export function PriorRejectionsCallout({
	rejections,
	resolveOfficerName = (id: string) => id,
	testIDPrefix = "prior-rejections-callout",
}: PriorRejectionsCalloutProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	if (rejections.length === 0) return null;

	// Sort a COPY, never the prop array — 48-08's `getPriorRejections` already
	// returns newest-first, so this is defence in depth: a component that
	// depends on its caller's ordering for a correctness property is one
	// refactor away from silently showing the oldest rejection at the top of
	// a re-application review.
	const sorted = [...rejections].sort((a, b) => {
		const ta = parseTime(a.rejectedAt);
		const tb = parseTime(b.rejectedAt);
		if (ta === undefined || tb === undefined) return 0;
		return tb - ta;
	});

	return (
		<View
			testID={testIDPrefix}
			style={[
				styles.cardSurface,
				{ backgroundColor: colors.card, borderLeftWidth: 4, borderLeftColor: colors.warning },
			]}
		>
			<View style={localStyles.headingRow}>
				<FontAwesome6
					name="circle-exclamation"
					size={16}
					color={colors.warning}
					testID={`${testIDPrefix}-glyph`}
				/>
				<ThemedText type="defaultSemiBold" testID={`${testIDPrefix}-heading`}>
					{t("priorRejectionsCalloutHeading")}
				</ThemedText>
			</View>
			{sorted.map((rejection) => (
				<ThemedText
					key={rejection.requestId}
					type="small"
					style={{ color: colors.textSecondary }}
					testID={`${testIDPrefix}-row-${rejection.requestId}`}
				>
					{t("priorRejectionsCalloutRow", {
						date: formatRejectedAt(rejection.rejectedAt),
						officer: resolveOfficerName(rejection.decidingOfficerUserId),
						reason: rejection.rejectionReason,
					})}
				</ThemedText>
			))}
		</View>
	);
}

const localStyles = StyleSheet.create({
	headingRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginBottom: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
