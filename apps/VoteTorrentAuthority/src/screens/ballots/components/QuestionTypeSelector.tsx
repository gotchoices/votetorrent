import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTheme } from "@react-navigation/native";
import { globalStyles } from "../../../theme/styles";
import FontAwesome from "react-native-vector-icons/FontAwesome";

const QuestionTypeSelector = () => {
	const { colors } = useTheme();
	const [selectedType, setSelectedType] = useState<{ label: string; icon: string } | null>(null);

	const types = [
		{ label: "Select", icon: "check-circle" },
		{ label: "Rank", icon: "sort" },
		{ label: "Score", icon: "star" },
		{ label: "Text", icon: "font" },
	];

	const handleSelect = (type: { label: string; icon: string }) => {
		setSelectedType(type);
	};

	return (
		<View style={styles.gridContainer}>
			{types.map((type, index) => (
				<TouchableOpacity
					key={index}
					style={[
						styles.typeContainer,
						selectedType?.label === type.label && { backgroundColor: colors.primary },
					]}
					onPress={() => handleSelect(type)}
				>
					<Text style={styles.label}>{type.label}</Text>
					<FontAwesome name={type.icon} size={24} color={colors.text} />
				</TouchableOpacity>
			))}
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
		borderColor: "#ccc",
		borderRadius: 8,
	},
	label: {
		fontSize: 16,
	},
});

const styles = { ...globalStyles, ...localStyles };

export default QuestionTypeSelector;
