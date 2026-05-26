import React, { useEffect, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type {
	Authority,
	IInvitationEngine,
	InviteStatus,
	Scope,
	SentOfficerInvite,
} from "@votetorrent/vote-core";
import { scopeDescriptions } from "@votetorrent/vote-core";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { CustomTextInput } from "../../components/CustomTextInput";
import { SignatureTaskFooter } from "../../components/SignatureTaskFooter";
import type { RootStackParamList } from "../../navigation/types";
import { useApp } from "../../providers/AppProvider";
import { globalStyles } from "../../theme/styles";

type AdministratorInvitationParams = {
	mode: "send" | "accept";
	invitationId?: string;
	authority?: Authority;
};

export default function AdministratorInvitationScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { mode, invitationId } = useRoute().params as AdministratorInvitationParams;
	const { getEngine } = useApp();

	// Send-mode form state
	const [name, setName] = useState("");
	const [title, setTitle] = useState("");

	// Accept-mode fetched invite
	const [invite, setInvite] = useState<InviteStatus<SentOfficerInvite> | undefined>(undefined);

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
				setInvite(status);
			} catch (error) {
				console.error("Error loading officer invite:", error);
			}
		}
		loadInvite();
	}, [mode, invitationId, getEngine]);

	const onSend = () => {
		console.log("administratorInvitation-send stub");
		navigation.goBack();
	};

	const onAccept = async () => {
		console.log("administratorInvitation-accept stub");
		try {
			const engine = await getEngine<IInvitationEngine>("invitations");
			await engine.respondToInvite(invitationId ?? "", true);
		} catch (error) {
			console.error("Error responding to invite:", error);
		}
		navigation.goBack();
	};

	const onDecline = async () => {
		console.log("administratorInvitation-decline stub");
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
							{t("administratorInvitation")}
						</ThemedText>
						<CustomTextInput title={t("name")} value={name} onChangeText={setName} />
						<CustomTextInput title={t("title")} value={title} onChangeText={setTitle} />
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
						{t("administratorInvitation")}
					</ThemedText>
					{seedInvite ? (
						<>
							<View style={styles.detailRow}>
								<ThemedText type="defaultSemiBold">{t("name")}: </ThemedText>
								<ThemedText>{seedInvite.name}</ThemedText>
							</View>
							<View style={styles.detailRow}>
								<ThemedText type="defaultSemiBold">{t("title")}: </ThemedText>
								<ThemedText>{seedInvite.title}</ThemedText>
							</View>
							<View style={styles.scopesSection}>
								<ThemedText type="defaultSemiBold" style={styles.scopesTitle}>
									{t("scopes")}:
								</ThemedText>
								{seedInvite.scopes.map((scope: Scope) => (
									<View key={scope} style={styles.scopeItem}>
										<ThemedText style={styles.bullet}>•</ThemedText>
										<ThemedText style={styles.scopeDescription}>
											{scopeDescriptions[scope] ?? t(`scope_${scope}`)}
										</ThemedText>
									</View>
								))}
							</View>
						</>
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
