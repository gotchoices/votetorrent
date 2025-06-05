import { useTheme } from "@react-navigation/native";
import React from "react";
import { Image, ImageSourcePropType, StyleSheet, TouchableOpacity, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ThemedText } from "./ThemedText";
import { ExtendedTheme } from "@react-navigation/native";

interface InfoCardProps {
	image?: ImageSourcePropType;
	title?: string;
	subtitle?: string;
	additionalInfo?: Array<{
		label: string;
		value?: string;
	}>;
	icon?: string;
	onPress?: () => void;
}

export function InfoCard({ image, title, subtitle, additionalInfo, icon, onPress }: InfoCardProps) {
	const { colors } = useTheme() as ExtendedTheme;

	return (
		<TouchableOpacity onPress={onPress} style={[styles.card, { backgroundColor: colors.card }]}>
			{image && <Image source={image} style={styles.image} />}
			<View style={styles.content}>
				{title && (
					<ThemedText type="subtitle" numberOfLines={1}>
						{title}
					</ThemedText>
				)}
				{subtitle && (
					<ThemedText type="default" numberOfLines={1}>
						{subtitle}
					</ThemedText>
				)}
				{additionalInfo &&
					additionalInfo.map((info) => (
						<View key={info.label} style={styles.infoText}>
							<ThemedText type="smallBold" numberOfLines={1}>
								{info.label}
							</ThemedText>
							{info.value ? (
								<ThemedText type="small" numberOfLines={1}>
									{": "}
									{info.value}
								</ThemedText>
							) : null}
						</View>
					))}
			</View>
			{icon && <FontAwesome6 name={icon} size={16} color={colors.text} style={styles.icon} />}
		</TouchableOpacity>
	);
}

const styles = StyleSheet.create({
	card: {
		flexDirection: "row",
		alignItems: "center",
		padding: 12,
		marginVertical: 8,
		marginHorizontal: 4,
		borderRadius: 12,
		shadowColor: "#000",
		shadowOffset: {
			width: 0,
			height: 2,
		},
		shadowOpacity: 0.1,
		shadowRadius: 4,
		elevation: 3,
	},
	image: {
		width: 50,
		height: 50,
	},
	content: {
		flex: 1,
		marginLeft: 16,
		marginRight: 8,
		paddingRight: 16,
	},
	infoText: {
		flexDirection: "row",
		alignItems: "center",
		marginRight: 28,
	},
	icon: {
		marginLeft: 16,
	},
});
