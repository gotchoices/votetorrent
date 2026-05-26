import React from "react";
import { StyleSheet, View } from "react-native";
import Slider from "@react-native-community/slider";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import type { Scope } from "@votetorrent/vote-core";
import { ThemedText } from "../../../components/ThemedText";
import { globalStyles } from "../../../theme/styles";

export interface ThresholdPolicyRowProps {
	scope: Scope;
	label: string;
	value: number;
	min: number;
	max: number;
	onChange: (v: number) => void;
}

/**
 * ThresholdPolicyRow — slider row primitive for Proposed Administration
 * threshold-policy editing (Phase 8 D-01, D-02, D-03).
 *
 * Layout: label (flex 1.2) + slider (flex 2) + numeric badge (minWidth 32),
 * mirroring the EditOfficerScreen Switch-row idiom.
 *
 * Slider semantics (D-01):
 *   - integer count of officers required to authorize the scope
 *   - min = 1, max = current proposed-officer count, step = 1
 *
 * Style decision: slider commits live via onValueChange (planner discretion
 * per 08-CONTEXT line 54 — live update is simpler with controlled state).
 *
 * Theme tokens (D-13 inherited from Phase 7):
 *   - minimumTrackTintColor: colors.accent (filled track)
 *   - maximumTrackTintColor: colors.border (unfilled track)
 *   - thumbTintColor:        colors.primary
 * Zero hardcoded hex.
 */
export function ThresholdPolicyRow({
	scope,
	label,
	value,
	min,
	max,
	onChange,
}: ThresholdPolicyRowProps) {
	const { colors } = useTheme() as ExtendedTheme;
	return (
		<View style={styles.row} accessibilityLabel={`threshold-policy-${scope}`}>
			<ThemedText style={styles.label}>{label}</ThemedText>
			<Slider
				style={styles.slider}
				minimumValue={min}
				maximumValue={max}
				step={1}
				value={value}
				onValueChange={onChange}
				minimumTrackTintColor={colors.accent}
				maximumTrackTintColor={colors.border}
				thumbTintColor={colors.primary}
			/>
			<View style={styles.badge}>
				<ThemedText type="defaultSemiBold">{value}</ThemedText>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingVertical: 8,
	},
	label: {
		flex: 1.2,
	},
	slider: {
		flex: 2,
	},
	badge: {
		minWidth: 32,
		alignItems: "center",
	},
});

const styles = { ...globalStyles, ...localStyles };
