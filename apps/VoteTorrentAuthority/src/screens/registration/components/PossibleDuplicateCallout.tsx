import React from "react";
import { StyleSheet, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import type { LikelyDuplicateRequest } from "@votetorrent/vote-core";
import { ThemedText } from "../../../components/ThemedText";
import { ChipButton } from "../../../components/ChipButton";
import { globalStyles } from "../../../theme/styles";
import { registrationRequestDisplayName } from "../registration-request-display";

/**
 * PossibleDuplicateCallout — Surface 3 (D-44). Renders directly beneath `PriorRejectionsCallout`
 * on the approval screen, so an officer deciding a request sees that an earlier pending request
 * from what looks like the same person exists BEFORE deciding.
 *
 * It mirrors `PriorRejectionsCallout`: a card with a 4 px warning left border, a heading row, and
 * absence rendering silently (no candidate means no callout; an empty callout would be a false
 * signal on a request with no flagged duplicate).
 *
 * The body copy is what makes the closure explicit (D-44): deciding this request closes the
 * earlier one it names.
 *
 * Never-log rule: `{{name}}` is untrusted display data (a public-tier name from a replicated
 * row). It has exactly one destination, the body text node. No `console.*`, no error state, no
 * name in an accessibility label or test id.
 *
 * Geometry: the body wraps in full. There is no line limit and no fixed size on any node
 * here, so a 40+ character name is never clipped.
 */
export interface PossibleDuplicateCalloutProps {
	candidate: LikelyDuplicateRequest | undefined;
	onViewOther: (requestId: string) => void;
	testIDPrefix?: string;
}

export function PossibleDuplicateCallout({
	candidate,
	onViewOther,
	testIDPrefix = "possible-duplicate-callout",
}: PossibleDuplicateCalloutProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	if (candidate === undefined) return null;

	const name = registrationRequestDisplayName({
		requestId: candidate.requestId,
		lastName: candidate.lastName,
		firstName: candidate.firstName,
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
				<FontAwesome6 name="circle-exclamation" size={16} color={colors.warning} testID={`${testIDPrefix}-glyph`} />
				<ThemedText type="defaultSemiBold" testID={`${testIDPrefix}-heading`}>
					{t("possibleDuplicateHeading")}
				</ThemedText>
			</View>
			<ThemedText type="default" testID={`${testIDPrefix}-body`}>
				{t("possibleDuplicateBody", { name })}
			</ThemedText>
			<View style={localStyles.action}>
				<ChipButton
					fullWidth
					label={t("possibleDuplicateViewOtherButton")}
					onPress={() => onViewOther(candidate.requestId)}
				/>
			</View>
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
	action: {
		marginTop: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
