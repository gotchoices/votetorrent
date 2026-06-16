import React, { useEffect, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type {
	IAuthorityEngine,
	IDefaultUserEngine,
	IInvitationEngine,
	INetworksEngine,
	InviteStatus,
	Scope,
	SentAuthorityInvite,
} from "@votetorrent/vote-core";
import { INetworkEngine } from "@votetorrent/vote-core";
import Clipboard from "@react-native-clipboard/clipboard";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { CustomTextInput } from "../../components/CustomTextInput";
import { Footer } from "../../components/Footer";
import { InfoCard } from "../../components/InfoCard";
import { SignatureTaskFooter } from "../../components/SignatureTaskFooter";
import type { RootStackParamList } from "../../navigation/types";
import { useApp } from "../../providers/AppProvider";
import { createDeviceSigner } from "../../engines/device-signer";
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

	// D-05: share text shown after a successful send (authority invite material).
	const [shareText, setShareText] = useState<string>("");

	// D-06: paste field in accept mode.
	const [pastedInvite, setPastedInvite] = useState<string>("");

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

	// INV-02: onSend invites onto the network's EXISTING primary authority.
	// D-05: a Copy-to-clipboard share is added after a successful send.
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
				setErrorMessage("Networks engine not yet initialized — please wait and try again.");
				return;
			}
			const recentRefs = await (networksEngine as INetworksEngine).getRecentNetworks();
			if (!recentRefs || recentRefs.length === 0) {
				setErrorMessage("No network found — create a network first.");
				return;
			}
			const networkRef = recentRefs[0];
			// Re-open with the real user attached so ctx.user is non-null in the engine.
			const networkEngine = await (networksEngine as INetworksEngine).open(networkRef, user);

			// Resolve the network's EXISTING primary authority — do not create a second one.
			// Authority.InsertValid Branch 1 requires the authority to be the only one; creating
			// a second authority on a network that already has a primary would fail the CHECK.
			const details = await networkEngine.getDetails();
			const newAuthorityId = details.network.primaryAuthorityId;
			if (!newAuthorityId) {
				setErrorMessage("Could not resolve the network's authority — invite not created.");
				return;
			}
			const authorityEngine = await networkEngine.openAuthority(newAuthorityId);

			// createAuthorityInvite is synchronous and returns an AuthorityInviteShare
			// containing the ephemeral invitePrivate (one-time only — D-05/D-27).
			const authorityInvite = (authorityEngine as IAuthorityEngine).createAuthorityInvite(name);

			// D-01/D-03/D-04: device signer callback — the engine computes
			// Digest(InviteSlot.Cid) internally and passes the bytes to this callback
			// (engine-authoritative, D-03). The private key never crosses into
			// vote-engine (D-01). scope 'iad' for authority invites (saveInviteWithSigning).
			const signer = await createDeviceSigner(user.name);
			await (authorityEngine as IAuthorityEngine).saveInviteWithSigning(
				authorityInvite,
				"iad" as Scope,
				signer,
			);

			// D-05: render the one-time invite material as text for Copy-to-clipboard
			// share. Include invitePrivate so the invitee can paste and accept (D-06).
			const sharePayload = JSON.stringify({
				invitePrivate: authorityInvite.invitePrivate,
				inviteKey: authorityInvite.inviteKey,
				inviteSignature: authorityInvite.inviteSignature,
				expiration: authorityInvite.expiration,
				type: authorityInvite.type,
				name: authorityInvite.name,
			});
			setShareText(sharePayload);
			// D-08: do NOT navigate away immediately — keep screen so Copy affordance shows.
		} catch (error) {
			console.warn("AuthorityInvitationScreen send failed:", error);
			setErrorMessage(error instanceof Error ? error.message : String(error));
			return;
		}
	};

	// INV-02: accept/decline updated to 21-04 respondToInvite param shape.
	// D-06: invitee pastes the share text; screen reconstructs ephemeral invitePrivate.
	const onAccept = async () => {
		try {
			const engine = await getEngine<IInvitationEngine>("invitations");
			let invitePrivate: string | undefined;
			if (pastedInvite.trim()) {
				try {
					const parsed = JSON.parse(pastedInvite.trim());
					invitePrivate = parsed.invitePrivate as string | undefined;
				} catch {
					invitePrivate = pastedInvite.trim();
				}
			}
			await engine.respondToInvite(invitationId ?? "", true, invitePrivate);
			// GAP-2: navigate ONLY on success — the InviteResult is now written.
			navigation.goBack();
		} catch (error) {
			console.error("onAccept respondToInvite error:", error);
			setErrorMessage(error instanceof Error ? error.message : String(error));
		}
	};

	const onDecline = async () => {
		try {
			const engine = await getEngine<IInvitationEngine>("invitations");
			let invitePrivate: string | undefined;
			if (pastedInvite.trim()) {
				try {
					const parsed = JSON.parse(pastedInvite.trim());
					invitePrivate = parsed.invitePrivate as string | undefined;
				} catch {
					invitePrivate = pastedInvite.trim();
				}
			}
			// T-21-11-03: decline calls the SAME signed respondToInvite path (D-09).
			await engine.respondToInvite(invitationId ?? "", false, invitePrivate);
			// GAP-2: navigate ONLY on success — the InviteResult is now written.
			navigation.goBack();
		} catch (error) {
			console.error("onDecline respondToInvite error:", error);
			setErrorMessage(error instanceof Error ? error.message : String(error));
		}
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

						{/* D-05: share text + Copy button after a successful send */}
						{shareText ? (
							<>
								<ThemedText type="defaultSemiBold" style={styles.shareLabel}>
									{t("share")}
								</ThemedText>
								<ThemedText
									style={styles.shareText}
									selectable
									numberOfLines={4}
								>
									{shareText}
								</ThemedText>
								<CustomButton
									title={t("share")}
									icon="copy"
									onPress={() => Clipboard.setString(shareText)}
								/>
							</>
						) : null}
					</View>
				</ScrollView>
				{errorMessage ? (
					<ThemedText type="small" style={{ color: colors.error }}>
						{errorMessage}
					</ThemedText>
				) : null}
				{!shareText ? (
					<Footer>
						<CustomButton
							title={t("send")}
							icon="paper-plane"
							backgroundColor={colors.success}
							forceDarkText={true}
							onPress={onSend}
						/>
					</Footer>
				) : null}
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

					{/* D-06: paste field for the share text the sender copied */}
					<ThemedText type="defaultSemiBold" style={styles.shareLabel}>
						{t("invitationKey")}
					</ThemedText>
					<CustomTextInput
						title={t("invitationKey")}
						value={pastedInvite}
						onChangeText={setPastedInvite}
						placeholder="Paste the invite text from the sender"
					/>
				</View>
			</ScrollView>
			{/* GAP-2: surface respondToInvite failures inline in accept mode */}
			{errorMessage ? (
				<ThemedText type="small" style={{ color: colors.error }}>
					{errorMessage}
				</ThemedText>
			) : null}
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
	shareLabel: {
		marginTop: 12,
		marginBottom: 4,
	},
	shareText: {
		marginBottom: 8,
		fontFamily: "monospace",
	},
});

const styles = { ...globalStyles, ...localStyles };
