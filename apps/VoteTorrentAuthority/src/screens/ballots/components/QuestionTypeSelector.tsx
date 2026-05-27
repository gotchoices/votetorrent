import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { globalStyles } from "../../../theme/styles";
import FontAwesome from "react-native-vector-icons/FontAwesome";

type QuestionTypeValue = "select" | "rank" | "score" | "text";

interface QuestionTypeSelectorProps {
	value?: QuestionTypeValue;
	onChange?: (next: QuestionTypeValue) => void;
}

const TYPES: Array<{ value: QuestionTypeValue; labelKey: string; icon: string }> = [
	{ value: "select", labelKey: "select", icon: "check-circle" },
	{ value: "rank", labelKey: "rank", icon: "sort" },
	{ value: "score", labelKey: "score", icon: "star" },
	{ value: "text", labelKey: "text", icon: "font" },
];

const QuestionTypeSelector = ({ value, onChange }: QuestionTypeSelectorProps) => {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	const handleSelect = (next: QuestionTypeValue) => {
		onChange?.(next);
	};

	return (
		<View style={styles.gridContainer}>
			{TYPES.map((type) => {
				const selected = value === type.value;
				return (
					<TouchableOpacity
						key={type.value}
						style={[
							styles.typeContainer,
							{ borderColor: colors.border },
							selected && { backgroundColor: colors.primary },
						]}
						onPress={() => handleSelect(type.value)}
					>
						<Text style={[styles.label, { color: colors.text }]}>
							{t(type.labelKey)}
						</Text>
						<FontAwesome name={type.icon} size={24} color={colors.text} />
					</TouchableOpacity>
				);
			})}
		</View>
	);
};

const localStyles = StyleSheet.create({
	gridContainer: {
		flexDirection: "row",
		flexWrap: "wrap",
		justifyContent: "space-between",
		padding: 16,
	},
	typeContainer: {
		width: "48%",
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		padding: 16,
		marginBottom: 16,
		borderWidth: 1,
		borderRadius: 8,
	},
	label: {
		fontSize: 16,
	},
});

const styles = { ...globalStyles, ...localStyles };

export default QuestionTypeSelector;
