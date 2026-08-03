import React from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { ThemedText } from "./ThemedText";
import { globalStyles } from "../theme/styles";

interface StepperProps {
	label?: string;
	value: number;
	onChange: (next: number) => void;
	min?: number;
	max?: number;
	step?: number;
}

export function Stepper({ label, value, onChange, min = 0, max, step = 1 }: StepperProps) {
	const { colors } = useTheme() as ExtendedTheme;

	const handleDecrement = () => {
		const next = value - step;
		if (min !== undefined && next < min) return;
		onChange(next);
	};

	const handleIncrement = () => {
		const next = value + step;
		if (max !== undefined && next > max) return;
		onChange(next);
	};

	return (
		<View style={styles.wrapper}>
			{label ? (
				<ThemedText type="defaultSemiBold" style={styles.label}>
					{label}
				</ThemedText>
			) : null}
			<View
				style={[
					styles.controls,
					{ borderColor: colors.border, borderWidth: 1, borderRadius: 8 },
				]}
			>
				<TouchableOpacity
					onPress={handleDecrement}
					style={[styles.button, { backgroundColor: colors.card }]}
					disabled={min !== undefined && value <= min}
				>
					<ThemedText type="defaultSemiBold">{"−"}</ThemedText>
				</TouchableOpacity>
				<ThemedText type="defaultSemiBold" style={styles.valueText}>
					{value}
				</ThemedText>
				<TouchableOpacity
					onPress={handleIncrement}
					style={[styles.button, { backgroundColor: colors.card }]}
					disabled={max !== undefined && value >= max}
				>
					<ThemedText type="defaultSemiBold">{"+"}</ThemedText>
				</TouchableOpacity>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	wrapper: {
		marginBottom: 12,
	},
	label: {
		marginBottom: 6,
	},
	controls: {
		flexDirection: "row",
		alignItems: "center",
		alignSelf: "flex-start",
		overflow: "hidden",
	},
	button: {
		width: 40,
		height: 40,
		alignItems: "center",
		justifyContent: "center",
	},
	valueText: {
		minWidth: 40,
		textAlign: "center",
	},
});

const styles = { ...globalStyles, ...localStyles };

export default Stepper;
