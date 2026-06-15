import React, { useLayoutEffect } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import type { IElectionEngine, InviteStatus, SentKeyholderInvite } from "@votetorrent/vote-core";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { globalStyles } from "../../theme/styles";
import type { NavigationProp } from "../../navigation/types";

type KeyholderParams = {
	keyholder: InviteStatus<SentKeyholderInvite>;
	electionEngine: IElectionEngine;
};

export function KeyholderScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NavigationProp>();
	const { keyholder, electionEngine } = useRoute().params as KeyholderParams;

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("keyholder") });
	}, [navigation, t]);

	// INV-03: navigate to KeyholderInvitation in send mode, passing the engine and keyholder
	// so the send screen can call electionEngine.inviteKeyholder (un-gated by 21-05).
	const onInvite = () => {
		navigation.navigate("KeyholderInvitation", {
			mode: "send",
			electionEngine,
			keyholder,
		});
	};

	const seedInvite = keyholder.invite;
	const isSent = Boolean(keyholder.result);

	return (
		<ScrollView style={styles.container}>
			<View style={styles.section}>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("name")}: </ThemedText>
					<ThemedText>{seedInvite?.name ?? "(unnamed)"}</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("type")}: </ThemedText>
					<ThemedText>{isSent ? t("sent") : t("unsent")}</ThemedText>
				</View>
			</View>
			<View style={styles.section}>
				<CustomButton
					title={t("invite")}
					icon="paper-plane"
					backgroundColor={colors.accent}
					size="thin"
					onPress={onInvite}
				/>
			</View>
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	detail: {
		flexDirection: "row",
		marginBottom: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };

export default KeyholderScreen;
