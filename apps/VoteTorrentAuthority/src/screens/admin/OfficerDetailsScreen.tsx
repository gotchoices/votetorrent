import React, { useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { Image, ScrollView, StyleSheet, View } from "react-native";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import type { Officer } from "@votetorrent/vote-core";
import { useNavigation, useRoute } from "@react-navigation/native";
import { scopeDescriptions } from "@votetorrent/vote-core";
import { globalStyles } from "../../theme/styles";

export default function OfficerDetailsScreen() {
	const { t } = useTranslation();
	const navigation = useNavigation();
	// `Officer` from vote-core (authority/models.ts:90–102) has no `imageRef`
	// field; the prior cast to `Officer` left the value at runtime but produced
	// a TS error. Loosen the route-param type so Phase 8 mocks-only routes can
	// pass an optional image URI without forcing a vote-core schema change
	// (Phase 7 D-15: opportunistic fix on lines this task touches).
	const { officer } = useRoute().params as {
		officer: Officer & { imageRef?: { url: string } };
	};

	// D-05: user-facing header label is "Administrator", not "Officer".
	// D-07: render Accepted-state chip in headerRight. v1.1 mocks-only — render
	// unconditionally; real status comes from IInvitationEngine in a later phase.
	useLayoutEffect(() => {
		navigation.setOptions({
			title: t("administrator"),
			headerRight: () => (
				<ChipButton label={t("accepted")} icon="circle-check" onPress={() => {}} />
			),
		});
	}, [navigation, t]);

	if (!officer) {
		return null;
	}

	const officerDetails = [
		{ label: t("title"), value: officer.title },
		{ label: t("userId"), value: officer.userId },
	];

	return (
		<ScrollView style={styles.container}>
			<View style={styles.section}>
				<View style={styles.imageContainer}>
					{officer.imageRef && (
						<Image source={{ uri: officer.imageRef.url }} style={styles.administratorImage} />
					)}
				</View>
				{officerDetails.map((field) => (
					<View key={field.label} style={styles.field}>
						<ThemedText type="defaultSemiBold">{field.label}: </ThemedText>
						<ThemedText>{field.value}</ThemedText>
					</View>
				))}
				<View style={styles.scopesSection}>
					<ThemedText type="defaultSemiBold" style={styles.scopesTitle}>
						{t("scopes")}:
					</ThemedText>
					{officer.scopes.map((scope) => (
						<View key={scope} style={styles.scopeItem}>
							<ThemedText style={styles.bullet}>•</ThemedText>
							<ThemedText style={styles.scopeDescription}>
								{scopeDescriptions[scope] ?? t(`scope_${scope}`)}
							</ThemedText>
						</View>
					))}
				</View>
			</View>
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	imageContainer: {
		position: "relative",
		width: 200,
		height: 200,
		alignSelf: "center",
		marginVertical: 16,
	},
	administratorImage: {
		width: "100%",
		height: "100%",
		borderRadius: 8,
	},
	field: {
		flexDirection: "row",
	},
	scopesSection: {
		marginTop: 16,
	},
	scopesTitle: {
		marginBottom: 8,
	},
	scopeItem: {
		flexDirection: "row",
		marginBottom: 4,
	},
	bullet: {
		marginRight: 8,
	},
	scopeDescription: {
		flex: 1,
	},
});

const styles = { ...globalStyles, ...localStyles };
