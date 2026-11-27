import { useTheme } from "@react-navigation/native";
import React from "react";
import { Image, ImageSourcePropType, StyleSheet, TouchableOpacity, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ThemedText } from "./ThemedText";
import { ExtendedTheme } from "@react-navigation/native";
import { globalStyles } from "../theme/styles";

interface InfoCardProps {
	image?: ImageSourcePropType;
	title?: string;
	subtitle?: string;
	additionalInfo?: Array<{
		label: string;
		value?: string;
	}>;
	icon?: string;
	/** Title weight. Entity cards keep the default `cardTitle`; plain navigation
	 *  rows (e.g. Settings) use `defaultSemiBold` so they don't outweigh the
	 *  section heading above them. */
	titleType?: "cardTitle" | "defaultSemiBold";
	onPress?: () => void;
	/** When set, the icon is its own 44pt button: pressing it calls this and NOT `onPress`
	 *  (a Find card opens on a body tap and pins only on the labelled thumbtack). */
	onIconPress?: () => void;
	iconAccessibilityLabel?: string;
}

export function InfoCard({ image, title, subtitle, additionalInfo, icon, titleType = "cardTitle", onPress, onIconPress, iconAccessibilityLabel }: InfoCardProps) {
	const { colors } = useTheme() as ExtendedTheme;

	return (
		<TouchableOpacity
			onPress={onPress}
			style={[styles.card, { backgroundColor: colors.card }]}
			// Explicit label so the trailing icon glyph doesn't add a stray ", " to what
			// screen readers announce.
			accessibilityRole={onPress ? "button" : undefined}
			accessibilityLabel={[title, subtitle].filter(Boolean).join(", ") || undefined}
		>
			{image && <Image source={image} style={styles.image} />}
			<View style={[styles.content, image ? styles.contentWithImage : null]}>
				{title && (
					<ThemedText type={titleType} numberOfLines={1}>
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
							<ThemedText type="smallBold" numberOfLines={1} style={styles.infoLabel}>
								{info.label}
							</ThemedText>
							{info.value ? (
								<ThemedText
									type="small"
									numberOfLines={1}
									ellipsizeMode="tail"
									style={styles.infoValue}
								>
									{": "}
									{info.value}
								</ThemedText>
							) : null}
						</View>
					))}
			</View>
			{icon && onIconPress ? (
				<TouchableOpacity
					onPress={onIconPress}
					accessibilityRole="button"
					accessibilityLabel={iconAccessibilityLabel}
					style={styles.iconButton}
				>
					<FontAwesome6 name={icon} size={20} color={colors.text} />
				</TouchableOpacity>
			) : icon ? (
				<FontAwesome6 name={icon} size={20} color={colors.text} style={styles.icon} />
			) : null}
		</TouchableOpacity>
	);
}

const styles = StyleSheet.create({
	card: {
		...globalStyles.cardSurface,
		flexDirection: "row",
		alignItems: "center",
	},
	image: {
		width: 56,
		height: 56,
		borderRadius: 4,
	},
	content: {
		flex: 1,
		// Base marginLeft is explicitly 0 (not omitted) so an image-less card
		// reclaims the gutter: globalStyles.cardSurface already supplies 16pt
		// of paddingHorizontal, so the old unconditional marginLeft: 16 was a
		// dead gutter stacked on top of it, reclaimed here and handed straight
		// to the value line that overflows. contentWithImage below restores
		// 16pt for cards that DO render an image, keeping their spacing
		// identical to today. minWidth: 0 is RN's own default; declared
		// explicitly as the intent marker the regression test pins (a flex:1
		// child otherwise measures at its content's intrinsic width before
		// shrinking).
		marginLeft: 0,
		minWidth: 0,
		marginRight: 8,
		paddingRight: 8,
	},
	// Applied only when `image` renders, so cards WITH an image keep the
	// identical spacing they have today.
	contentWithImage: {
		marginLeft: 16,
	},
	infoText: {
		flexDirection: "row",
		alignItems: "center",
		marginTop: 2,
	},
	// The label must never give up width to the value — all shrink pressure
	// lands on infoValue below.
	infoLabel: {
		flexShrink: 0,
	},
	// CORRECTION: numberOfLines alone does not ellipsize inside a
	// flexDirection:'row' sibling — Yoga defaults flexShrink:0 on flex
	// children (unlike the web's 1), so without this the value text measures
	// at its full intrinsic width and widens the row instead of truncating.
	// minWidth: 0 is RN's default, declared as the intent marker the
	// regression test pins.
	infoValue: {
		flexShrink: 1,
		minWidth: 0,
	},
	icon: {
		marginLeft: 8,
	},
	iconButton: {
		marginLeft: 8,
		minWidth: 44,
		minHeight: 44,
		alignItems: "center",
		justifyContent: "center",
	},
});
