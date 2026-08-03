import React from "react";
import { StyleSheet, Switch, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { ThemedText } from "./ThemedText";
import { globalStyles } from "../theme/styles";

interface ToggleRowProps {
	label: string;
	value: boolean;
	onValueChange: (next: boolean) => void;
}

export function ToggleRow({ label, value, onValueChange }: ToggleRowProps) {
	const { colors } = useTheme() as ExtendedTheme;

	return (
		<View style={styles.row}>
			<ThemedText type="defaultSemiBold">{label}</ThemedText>
			<Switch
				value={value}
				onValueChange={onValueChange}
				trackColor={{ false: colors.border, true: colors.primary }}
				thumbColor={colors.card}
			/>
		</View>
	);
}

const localStyles = StyleSheet.create({
	row: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		marginBottom: 12,
	},
});

const styles = { ...globalStyles, ...localStyles };

export default ToggleRow;
