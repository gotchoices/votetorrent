import { Text, type TextProps, StyleSheet } from "react-native";

import { useThemeColor } from "../hooks/useThemeColor";

export type ThemedTextProps = TextProps & {
	lightColor?: string;
	darkColor?: string;
	type?:
		| "default"
		| "title"
		| "defaultSemiBold"
		| "header"
		| "subtitle"
		| "link"
		| "small"
		| "smallBold"
		| "tiny"
		| "tinyBold";
};

export function ThemedText({
	style,
	lightColor,
	darkColor,
	type = "default",
	...rest
}: ThemedTextProps) {
	const color = useThemeColor({ light: lightColor, dark: darkColor }, "text");

	return (
		<Text
			style={[
				{ color },
				type === "default" ? styles.default : undefined,
				type === "title" ? styles.title : undefined,
				type === "defaultSemiBold" ? styles.defaultSemiBold : undefined,
				type === "header" ? styles.header : undefined,
				type === "subtitle" ? styles.subtitle : undefined,
				type === "link" ? styles.link : undefined,
				type === "small" ? { ...styles.small } : undefined,
				type === "smallBold" ? { ...styles.smallBold } : undefined,
				type === "tiny" ? { ...styles.tiny } : undefined,
				type === "tinyBold" ? { ...styles.tinyBold } : undefined,
				style,
			]}
			{...rest}
		/>
	);
}
const styles = StyleSheet.create({
	default: {
		fontSize: 16,
		lineHeight: 24,
	},
	defaultSemiBold: {
		fontSize: 16,
		lineHeight: 24,
		fontWeight: "600",
	},
	header: {
		fontSize: 19,
	},
	title: {
		fontSize: 24,
		fontWeight: "bold",
	},
	subtitle: {
		fontSize: 18,
		fontWeight: "400",
	},
	link: {
		lineHeight: 30,
		fontSize: 16,
		color: "#0a7ea4",
		textDecorationLine: "underline",
	},
	small: {
		fontSize: 14,
		fontWeight: "400",
	},
	smallBold: {
		fontSize: 14,
		fontWeight: "600",
	},
	tiny: {
		fontSize: 11,
		fontWeight: "400",
	},
	tinyBold: {
		fontSize: 11,
		fontWeight: "600",
	},
});
