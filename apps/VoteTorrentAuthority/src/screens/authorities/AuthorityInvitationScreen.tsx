import React, { useEffect, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type {
	IInvitationEngine,
	InviteStatus,
	SentAuthorityInvite,
} from "@votetorrent/vote-core";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { CustomTextInput } from "../../components/CustomTextInput";
import { SignatureTaskFooter } from "../../components/SignatureTaskFooter";
import type { RootStackParamList } from "../../navigation/types";
import { useApp } from "../../providers/AppProvider";
import { globalStyles } from "../../theme/styles";

type AuthorityInvitationParams = {
	mode: "send" | "accept";
	invitationId?: string;
};

export default function AuthorityInvitationScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { mode, invitationId } = useRoute().params as AuthorityInvitationParams;
	const { getEngine } = useApp();

	// Send-mode form state — authority-level fields (mirror AddNetworkScreen
	// Primary Authority subsection: name + domainName).
	const [name, setName] = useState("");
	const [domainName, setDomainName] = useState("");

	// Accept-mode fetched invite
	const [invite, setInvite] = useState<InviteStatus<SentAuthorityInvite> | undefined>(undefined);

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
				const status = await engine.getAuthorityInvite(invitationId);
				setInvite(status);
			} catch (error) {
				console.error("Error loading authority invite:", error);
			}
		}
		loadInvite();
	}, [mode, invitationId, getEngine]);

	const onSend = () => {
		console.log("authorityInvitation-send stub");
		navigation.goBack();
	};

	const onAccept = async () => {
		console.log("authorityInvitation-accept stub");
		try {
			const engine = await getEngine<IInvitationEngine>("invitations");
			await engine.respondToInvite(invitationId ?? "", true);
		} catch (error) {
			console.error("Error responding to invite:", error);
		}
		navigation.goBack();
	};

	const onDecline = async () => {
		console.log("authorityInvitation-decline stub");
		try {
			const engine = await getEngine<IInvitationEngine>("invitations");
			await engine.respondToInvite(invitationId ?? "", false);
		} catch (error) {
			console.error("Error responding to invite:", error);
		}
		navigation.goBack();
	};

	if (mode === "send") {
		return (
			<View style={styles.content}>
				<ScrollView style={styles.container}>
					<View style={styles.section}>
						<ThemedText type="title" style={styles.sectionTitle}>
							{t("authorityInvitation")}
						</ThemedText>
						<CustomTextInput
							title={t("name")}
							value={name}
							onChangeText={setName}
							placeholder={t("authorityName")}
						/>
						<CustomTextInput
							title={t("domainName")}
							value={domainName}
							onChangeText={setDomainName}
							placeholder={t("domainNameOptional")}
						/>
					</View>
				</ScrollView>
				<View style={[styles.footer, { backgroundColor: colors.card }]}>
					<CustomButton
						title={t("send")}
						icon="paper-plane"
						backgroundColor={colors.success}
						forceDarkText={true}
						onPress={onSend}
					/>
				</View>
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
						{t("authorityInvitation")}
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
