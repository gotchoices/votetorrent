import React, { useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ExtendedTheme, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import type { Officer } from "@votetorrent/vote-core";
import { scopeDescriptions } from "@votetorrent/vote-core";
import { ThemedText } from "../../components/ThemedText";
import { InfoCard } from "../../components/InfoCard";
import { globalStyles } from "../../theme/styles";

export default function OfficerDetailsScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation();
	// `Officer` (vote-core authority/models.ts) has no name/imageRef; the route
	// optionally carries the resolved user name. SID = officer.userId.
	const { officer, userName } = useRoute().params as {
		officer: Officer & { imageRef?: { url: string } };
		userName?: string;
	};

	// D-05: header label is "Administrator", not "Officer".
	useLayoutEffect(() => {
		navigation.setOptions({ title: t("administrator") });
	}, [navigation, t]);

	if (!officer) {
		return null;
	}

	const displayName = userName ?? officer.userId;
	const permissions = officer.scopes
		.map((scope) => scopeDescriptions[scope] ?? t(`scope_${scope}`))
		.join(", ");

	return (
		<ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 24 }}>
			<View style={styles.section}>
				{/* Name / Title / Permissions — inline text block (Figma frame 13) */}
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("name")}: </ThemedText>
					<ThemedText>{displayName}</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("title")}: </ThemedText>
					<ThemedText>{officer.title}</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("permissions")}: </ThemedText>
					<ThemedText style={styles.permissions}>{permissions}</ThemedText>
				</View>

				{/* User card → user profile */}
				<InfoCard
					image={officer.imageRef?.url ? { uri: officer.imageRef.url } : undefined}
					additionalInfo={[
						{ label: t("user"), value: displayName },
						{ label: t("sid"), value: officer.userId },
					]}
					icon="chevron-right"
					onPress={() => {}}
				/>
			</View>

			{/* Invitation section */}
			<View style={styles.section}>
				<ThemedText type="title">{t("invitation")}</ThemedText>
				<TouchableOpacity style={[styles.invitationCard, { backgroundColor: colors.card }]}>
					<View style={styles.invitationContent}>
						<ThemedText type="cardTitle">{displayName}</ThemedText>
						<ThemedText type="defaultSemiBold" style={{ color: colors.success }}>
							{t("accepted")}
						</ThemedText>
					</View>
					<FontAwesome6 name="chevron-right" size={18} color={colors.text} />
				</TouchableOpacity>
			</View>
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	detail: {
		flexDirection: "row",
		marginVertical: 1,
	},
	permissions: {
		flex: 1,
		flexWrap: "wrap",
	},
	invitationCard: {
		// Match the InfoCard surface above (shadow/elevation) so the invitation
		// reads as a card per Figma frame 13 — the bare backgroundColor was
		// invisible against the light screen background.
		...globalStyles.cardSurface,
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
	},
	invitationContent: {
		flex: 1,
		gap: 4,
	},
});

const styles = { ...globalStyles, ...localStyles };
