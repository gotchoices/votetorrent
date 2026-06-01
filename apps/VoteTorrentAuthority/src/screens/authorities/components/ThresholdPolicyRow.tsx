import React from "react";
import { StyleSheet, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import type { Scope } from "@votetorrent/vote-core";
import { ThemedText } from "../../../components/ThemedText";
import { Stepper } from "../../../components/Stepper";
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
 * ThresholdPolicyRow — Figma frame 10 ("Proposed Administration") row primitive.
 *
 * Layout: label + info icon (left, flex) · Stepper (N) · "of {max}".
 * `max` is the proposed-officer count; the threshold is bounded [min, max].
 * Uses the shared Stepper (+/−) per design direction (replaced the earlier
 * slider so the value reads as "N of M" like the Figma).
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
	const { t } = useTranslation();
	return (
		<View style={styles.row} accessibilityLabel={`threshold-policy-${scope}`}>
			<View style={styles.labelGroup}>
				<ThemedText numberOfLines={1} style={styles.label}>
					{label}
				</ThemedText>
				<FontAwesome6
					name="circle-info"
					size={14}
					color={colors.text}
					style={styles.infoIcon}
				/>
			</View>
			<View style={styles.control}>
				<Stepper value={value} min={min} max={max} onChange={onChange} />
				<ThemedText type="defaultSemiBold" style={styles.ofText}>
					{`${t("of")} ${max}`}
				</ThemedText>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	row: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 12,
		paddingVertical: 8,
	},
	labelGroup: {
		flexDirection: "row",
		alignItems: "center",
		flexShrink: 1,
		gap: 6,
	},
	label: {
		flexShrink: 1,
	},
	infoIcon: {
		marginLeft: 2,
	},
	control: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	ofText: {
		minWidth: 36,
	},
});

const styles = { ...globalStyles, ...localStyles };
