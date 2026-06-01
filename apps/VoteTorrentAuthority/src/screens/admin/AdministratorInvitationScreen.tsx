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
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { CustomTextInput } from "../../components/CustomTextInput";
import { Footer } from "../../components/Footer";
import { InfoCard } from "../../components/InfoCard";
import { SignatureTaskFooter } from "../../components/SignatureTaskFooter";
import type { RootStackParamList } from "../../navigation/types";
import { useApp } from "../../providers/AppProvider";
import { INetworkEngine } from "@votetorrent/vote-core";
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
	const [networkName, setNetworkName] = useState("");

	useEffect(() => {
		// Network context for the invitation header (best-effort; real engine later).
		async function loadNetwork() {
			try {
				const engine = await getEngine<INetworkEngine>("network");
				const details = await engine?.getDetails();
				if (details?.network?.name) setNetworkName(details.network.name);
			} catch (error) {
				console.error("Error loading network for invitation:", error);
			}
		}
		loadNetwork();
	}, [getEngine]);

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

	// Accept mode (Figma frame 32)
	const seedInvite = invite?.invite;
	const permissions = (seedInvite?.scopes ?? [])
		.map((scope: Scope) => scopeDescriptions[scope] ?? t(`scope_${scope}`))
		.join(", ");
	return (
		<View style={styles.content}>
			<ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 24 }}>
				<View style={styles.section}>
					{seedInvite ? (
						<>
							{networkName ? (
								<View style={styles.detailRow}>
									<ThemedText type="defaultSemiBold">{t("network")}: </ThemedText>
									<ThemedText>{networkName}</ThemedText>
								</View>
							) : null}
							<View style={styles.detailRow}>
								<ThemedText type="defaultSemiBold">{t("name")}: </ThemedText>
								<ThemedText>{seedInvite.name}</ThemedText>
							</View>
							<View style={styles.detailRow}>
								<ThemedText type="defaultSemiBold">{t("title")}: </ThemedText>
								<ThemedText>{seedInvite.title}</ThemedText>
							</View>
							<View style={styles.detailRow}>
								<ThemedText type="defaultSemiBold">{t("permissions")}: </ThemedText>
								<ThemedText style={styles.permissionsText}>{permissions}</ThemedText>
							</View>

							{/* Create a new user, OR sign with the existing profile (Figma frame 32) */}
							<ChipButton
								label={t("createUser")}
								icon="circle-plus"
								fullWidth
								onPress={() => {}}
							/>
							<ThemedText type="defaultSemiBold" style={styles.orText}>
								{t("or")}
							</ThemedText>
							<InfoCard
								additionalInfo={[
									{ label: t("user"), value: seedInvite.name },
									{ label: t("sid"), value: (seedInvite as any).userId },
								]}
								icon="chevron-right"
								onPress={() => {}}
							/>
							<CustomButton
								title={t("sign")}
								icon="signature"
								backgroundColor={colors.important}
								forceDarkText={true}
								size="thin"
								onPress={() => {}}
							/>
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
				rejectLabel={t("reject")}
			/>
		</View>
	);
}

const localStyles = StyleSheet.create({
	detailRow: {
		flexDirection: "row",
		marginBottom: 8,
	},
	permissionsText: {
		flex: 1,
		flexWrap: "wrap",
	},
	orText: {
		textAlign: "center",
		marginVertical: 8,
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
