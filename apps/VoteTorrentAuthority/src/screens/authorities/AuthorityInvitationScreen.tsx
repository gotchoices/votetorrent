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
import { Footer } from "../../components/Footer";
import { InfoCard } from "../../components/InfoCard";
import { SignatureTaskFooter } from "../../components/SignatureTaskFooter";
import type { RootStackParamList } from "../../navigation/types";
import { useApp } from "../../providers/AppProvider";
import { INetworkEngine } from "@votetorrent/vote-core";
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
	// Accept-mode "New Authority" form (Figma frame 34).
	const [imageUrl, setImageUrl] = useState("");
	const [networkName, setNetworkName] = useState("");

	// Accept-mode fetched invite
	const [invite, setInvite] = useState<InviteStatus<SentAuthorityInvite> | undefined>(undefined);

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

	// Pre-fill the New Authority name from the invite once it loads.
	useEffect(() => {
		if (invite?.invite?.name) setName(invite.invite.name);
	}, [invite]);

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

	// Accept mode (Figma frame 34)
	const seedInvite = invite?.invite;
	const invitationKey = (seedInvite as any)?.key ?? (seedInvite as any)?.inviteKey ?? invitationId;
	return (
		<View style={styles.content}>
			<ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 24 }}>
				<View style={styles.section}>
					{/* Inviting context */}
					{networkName ? (
						<View style={styles.detailRow}>
							<ThemedText type="defaultSemiBold">{t("network")}: </ThemedText>
							<ThemedText style={styles.link}>{networkName}</ThemedText>
						</View>
					) : null}
					{(seedInvite as any)?.primaryAuthorityName ? (
						<View style={styles.detailRow}>
							<ThemedText type="defaultSemiBold">{t("primaryAuthority")}: </ThemedText>
							<ThemedText style={styles.link}>{(seedInvite as any).primaryAuthorityName}</ThemedText>
						</View>
					) : null}
					{(seedInvite as any)?.invitingAuthorityName ? (
						<View style={styles.detailRow}>
							<ThemedText type="defaultSemiBold">{t("invitingAuthority")}: </ThemedText>
							<ThemedText style={styles.link}>{(seedInvite as any).invitingAuthorityName}</ThemedText>
						</View>
					) : null}
					{(seedInvite as any)?.invitingAdministratorName ? (
						<View style={styles.detailRow}>
							<ThemedText type="defaultSemiBold">{t("invitingAdministrator")}: </ThemedText>
							<ThemedText style={styles.link}>{(seedInvite as any).invitingAdministratorName}</ThemedText>
						</View>
					) : null}

					<ThemedText type="title" style={styles.heading}>
						{t("newAuthority")}
					</ThemedText>
					<View style={styles.detailRow}>
						<ThemedText type="defaultSemiBold">{t("invitationName")}: </ThemedText>
						<ThemedText>{seedInvite?.name}</ThemedText>
					</View>
					{invitationKey ? (
						<View style={styles.detailRow}>
							<ThemedText type="defaultSemiBold">{t("invitationKey")}: </ThemedText>
							<ThemedText numberOfLines={1} ellipsizeMode="middle">{invitationKey}</ThemedText>
						</View>
					) : null}

					<CustomTextInput title={t("name")} value={name} onChangeText={setName} />
					<CustomTextInput
						title={t("imageUrl")}
						value={imageUrl}
						placeholder={t("optionalImageAddress")}
						onChangeText={setImageUrl}
						isImageUrlField={true}
						makePermanentPressed={() => console.log("makePermanent stub")}
					/>
					<CustomTextInput
						title={t("domainName")}
						value={domainName}
						placeholder={t("domainNameOptional")}
						onChangeText={setDomainName}
					/>

					{/* Create a new user, OR sign with the existing profile (Figma frame 34) */}
					<ThemedText style={styles.note}>{t("soleInitialAdministratorNote")}</ThemedText>
					<CustomButton
						title={t("createUser")}
						icon="circle-plus"
						backgroundColor={colors.accent}
						size="thin"
						onPress={() => {}}
					/>
					<ThemedText type="defaultSemiBold" style={styles.orText}>
						{t("or")}
					</ThemedText>
					<ThemedText style={styles.note}>{t("userIsSoleAdministratorNote")}</ThemedText>
					<InfoCard
						additionalInfo={[{ label: t("user"), value: seedInvite?.name }]}
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
	link: {
		textDecorationLine: "underline",
	},
	heading: {
		marginTop: 12,
		marginBottom: 8,
	},
	note: {
		marginTop: 12,
		marginBottom: 4,
	},
	orText: {
		textAlign: "center",
		marginVertical: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
