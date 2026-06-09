import React, { useEffect, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type {
	AdminInit,
	IDefaultUserEngine,
	IInvitationEngine,
	INetworksEngine,
	InviteStatus,
	SentAuthorityInvite,
} from "@votetorrent/vote-core";
import { INetworkEngine } from "@votetorrent/vote-core";
import { NetworkCreateAuthorityBuilder } from "@votetorrent/vote-engine";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { CustomTextInput } from "../../components/CustomTextInput";
import { Footer } from "../../components/Footer";
import { InfoCard } from "../../components/InfoCard";
import { SignatureTaskFooter } from "../../components/SignatureTaskFooter";
import type { RootStackParamList } from "../../navigation/types";
import { useApp } from "../../providers/AppProvider";
import { getOrCreateDeviceUser } from "../../engines/device-user";
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
	const { getEngine, networksEngine } = useApp();

	// Send-mode form state — authority-level fields (mirror AddNetworkScreen
	// Primary Authority subsection: name + domainName).
	const [name, setName] = useState("");
	const [domainName, setDomainName] = useState("");
	// Accept-mode "New Authority" form (Figma frame 34).
	const [imageUrl, setImageUrl] = useState("");
	const [networkName, setNetworkName] = useState("");

	// Accept-mode fetched invite
	const [invite, setInvite] = useState<InviteStatus<SentAuthorityInvite> | undefined>(undefined);

	// 16-08 item 4: surface the ACTUAL send failure inline (send-mode only).
	const [errorMessage, setErrorMessage] = useState<string>("");

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

	const onSend = async () => {
		// 16-08 item 4: clear any prior error so a retry starts clean.
		setErrorMessage("");
		try {
			// Resolve device identity (D-02 / generate-on-first-run) — needed to
			// populate ctx.user so Officer.UserIdValid passes (Pitfall 2 / T-16-05).
			const defaultUserEng = await getEngine<IDefaultUserEngine>("defaultUser");
			const defaultUser = await defaultUserEng.get();
			const user = await getOrCreateDeviceUser(defaultUser?.name ?? "Device User");

			// Pitfall 2 mitigation: the EngineFactory's "network" cache entry was opened
			// with user=undefined (AppProvider.initialize calls open(ref, undefined)).
			// Officer.UserIdValid requires ctx.user?.id to be a valid User row — null userId
			// will fail the CHECK constraint even on the first-authority shoe-in path.
			// Re-open the network via networksEngine.open(ref, user) directly so the
			// returned NetworkEngine has ctx.user set (bypasses the factory cache).
			if (!networksEngine) {
				console.error("onSend: networksEngine not yet initialized");
				setErrorMessage("Networks engine not yet initialized — please wait and try again.");
				return;
			}
			const recentRefs = await (networksEngine as INetworksEngine).getRecentNetworks();
			if (!recentRefs || recentRefs.length === 0) {
				console.error("onSend: no recent network found — create a network first");
				setErrorMessage("No network found — create a network first.");
				return;
			}
			const networkRef = recentRefs[0];
			// Re-open with the real user attached so ctx.user is non-null in the engine.
			const networkEngine = await (networksEngine as INetworksEngine).open(networkRef, user);

			// Synthesize AdminInit: default admin/officers to the current device user
			// with a sensible threshold policy covering the 3 primary governance scopes (D-04).
			// Threshold of 1 is correct for a single-admin first-authority shoe-in (v1.2 scope).
			const admin: AdminInit = {
				officers: [
					{
						init: {
							name: user.name,
							title: "Chair",
							scopes: ["rn", "rad", "iad", "uai", "mel", "ceb"],
						},
					},
				],
				effectiveAt: Date.now(),
				thresholdPolicies: [
					{ policy: "rn", threshold: 1 },
					{ policy: "mel", threshold: 1 },
					{ policy: "ceb", threshold: 1 },
				],
			};

			// Route through v1.1 NetworkCreateAuthorityBuilder (D-03).
			// commit() with no options → first-authority shoe-in path (no inviteSlotCid).
			const builder = new NetworkCreateAuthorityBuilder(networkEngine)
				.setAuthority({ name, domainName })
				.setAdmin(admin);
			if (!builder.isValid()) {
				console.error("onSend: validation errors", builder.errors());
				setErrorMessage(
					builder.errors().map((e) => e.message).join("\n") || "Validation failed.",
				);
				return;
			}
			await builder.commit();
		} catch (error) {
			console.error("createAuthority error:", error);
			setErrorMessage(error instanceof Error ? error.message : String(error));
			return;
		}
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
				{errorMessage ? (
					<ThemedText type="small" style={{ color: colors.error }}>
						{errorMessage}
					</ThemedText>
				) : null}
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
					<ChipButton
						label={t("createUser")}
						icon="circle-plus"
						fullWidth
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
