import React from "react";
import { StyleSheet, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { ThemedText } from "./ThemedText";

interface InlineErrorProps {
	message?: string;
}

export function InlineError({ message }: InlineErrorProps) {
	const { colors } = useTheme() as ExtendedTheme;
	if (!message) return null;
	return (
		<View style={styles.container}>
			<ThemedText type="small" style={{ color: colors.error }}>
				{message}
			</ThemedText>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		marginTop: 4,
		marginBottom: 4,
	},
});
