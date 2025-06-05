import { StyleSheet, TouchableOpacity, View } from "react-native";
import { ThemedText } from "./ThemedText";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ExtendedTheme, useTheme } from "@react-navigation/native";

interface FullButtonProps {
	title: string;
	icon?: string;
	disabled?: boolean;
	backgroundColor?: string;
	forceDarkText?: boolean;
	size?: "tall" | "thin";
	flex?: boolean;
	onPress: () => void;
}

export function CustomButton({
	title,
	icon,
	disabled = false,
	backgroundColor,
	forceDarkText,
	size = "tall",
	flex = false,
	onPress,
}: FullButtonProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const buttonColor = backgroundColor ?? colors.accent;
	let textColor = forceDarkText ? colors.dark : colors.text;
	if (backgroundColor && (backgroundColor === colors.success || backgroundColor === colors.error)) {
		textColor = colors.light;
	}

	return (
		<TouchableOpacity
			style={[
				styles.button,
				{ backgroundColor: buttonColor },
				disabled && styles.disabled,
				size === "thin" ? styles.thin : styles.tall,
				flex && styles.flex,
			]}
			onPress={onPress}
			disabled={disabled}
		>
			<View style={styles.buttonContent}>
				{icon && <FontAwesome6 name={icon} size={20} color={textColor} />}
				<ThemedText style={[styles.text, { color: textColor }]}>{title.toUpperCase()}</ThemedText>
			</View>
		</TouchableOpacity>
	);
}

const styles = StyleSheet.create({
	button: {
		borderRadius: 32,
		marginVertical: 8,
		marginHorizontal: 4,
	},
	buttonContent: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		gap: 12,
	},
	disabled: {
		opacity: 0.5,
	},
	flex: {
		flex: 1,
	},
	text: {
		fontSize: 16,
		fontWeight: "600",
		textAlign: "center",
	},
	tall: {
		paddingVertical: 16,
	},
	thin: {
		paddingVertical: 6,
	},
});
