import React, { useEffect, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { IInvitationEngine, InviteStatus, SentKeyholderInvite } from "@votetorrent/vote-core";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { CustomTextInput } from "../../components/CustomTextInput";
import { SignatureTaskFooter } from "../../components/SignatureTaskFooter";
import type { RootStackParamList } from "../../navigation/types";
import { useApp } from "../../providers/AppProvider";
import { globalStyles } from "../../theme/styles";

type KeyholderInvitationParams = {
	mode: "send" | "accept";
	invitationId?: string;
};

export function KeyholderInvitationScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { mode, invitationId } = useRoute().params as KeyholderInvitationParams;
	const { getEngine } = useApp();

	// Send-mode form state
	const [name, setName] = useState("");

	// Accept-mode fetched invite
	const [invite, setInvite] = useState<InviteStatus<SentKeyholderInvite> | undefined>(undefined);

	useLayoutEffect(() => {
		navigation.setOptions({
			title: mode === "send" ? t("sendInvitation") : t("invitation"),
		});
	}, [navigation, t, mode]);

	useEffect(() => {
		async function loadInvite() {
			if (mode !== "accept" || !invitationId) return;
			try {
				const engine = await getEngine<IInvitationEngine>("invitations");
				const status = await engine.getOfficerInvite(invitationId);
				setInvite(status as unknown as InviteStatus<SentKeyholderInvite>);
			} catch (error) {
				console.error("Error loading keyholder invite:", error);
			}
		}
		loadInvite();
	}, [mode, invitationId, getEngine]);

	const onSend = () => {
		console.log("keyholderInvitation-send stub");
		navigation.goBack();
	};

	const onAccept = () => {
		console.log("keyholderInvitation-accept stub");
		navigation.goBack();
	};

	const onDecline = () => {
		console.log("keyholderInvitation-decline stub");
		navigation.goBack();
	};

	if (mode === "send") {
		return (
			<View style={styles.content}>
				<ScrollView style={styles.container}>
					<View style={styles.section}>
						<ThemedText type="title" style={styles.sectionTitle}>
							{t("keyholderInvitation")}
						</ThemedText>
						<CustomTextInput title={t("name")} value={name} onChangeText={setName} />
					</View>
				</ScrollView>
				<Footer>
					<CustomButton
						title={t("send")}
						icon="paper-plane"
						backgroundColor={colors.success}
						forceDarkText={true}
						onPress={onSend}
					/>
				</Footer>
			</View>
		);
	}

	// Accept mode
	const seedInvite = invite?.invite;
	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t("keyholderInvitation")}
					</ThemedText>
					{seedInvite ? (
						<View style={styles.detailRow}>
							<ThemedText type="defaultSemiBold">{t("name")}: </ThemedText>
							<ThemedText>{seedInvite.name}</ThemedText>
						</View>
					) : (
						<ThemedText>{t("loading")}</ThemedText>
					)}
				</View>
			</ScrollView>
			<SignatureTaskFooter
				onAccept={onAccept}
				onReject={onDecline}
				acceptLabel={t("accept")}
				rejectLabel={t("decline")}
			/>
		</View>
	);
}

const localStyles = StyleSheet.create({
	detailRow: {
		flexDirection: "row",
		marginBottom: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };

export default KeyholderInvitationScreen;
