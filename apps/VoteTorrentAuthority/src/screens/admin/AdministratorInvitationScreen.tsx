import React, { useEffect, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type {
	Authority,
	IAuthorityEngine,
	IInvitationEngine,
	INetworkEngine,
	InviteStatus,
	Scope,
	SentOfficerInvite,
} from "@votetorrent/vote-core";
import { scopeDescriptions } from "@votetorrent/vote-core";
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

type AdministratorInvitationParams = {
	mode: "send" | "accept";
	invitationId?: string;
	authority?: Authority;
};

export default function AdministratorInvitationScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { mode, invitationId, authority } = useRoute().params as AdministratorInvitationParams;
	const { getEngine } = useApp();

	// Send-mode form state
	const [name, setName] = useState("");
	const [title, setTitle] = useState("");
	// Share text shown after a successful send (D-05)
	const [shareText, setShareText] = useState<string>("");
	const [errorMessage, setErrorMessage] = useState<string>("");

	// Accept-mode paste field (D-06 — invitee pastes the share text here)
	const [pastedInvite, setPastedInvite] = useState<string>("");

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

	// INV-01: real officer invite send with device signature (D-01/D-03/D-04)
	const onSend = async () => {
		// Pattern B: clear any prior error so a retry starts clean.
		setErrorMessage("");
		try {
			if (!authority?.id) {
				setErrorMessage("Authority not available — navigate from an authority context.");
				return;
			}

			// Resolve device user for the signing identity (D-01).
			const deviceUser = await getOrCreateDeviceUser("Device User");

			// Open the authority engine for this authority.
			const authorityEngine = await getEngine<IAuthorityEngine>("authority", authority.id);

			// Mint the one-time officer invite (key material stays in engine scope).
			// createOfficerInvite is synchronous and returns an OfficerInviteShare
			// containing the ephemeral invitePrivate (one-time only — D-05/D-27).
			const officerInvite = authorityEngine.createOfficerInvite({
				name,
				title,
				scopes: ["rn", "rad", "iad", "uai", "mel", "ceb"] as Scope[],
			});

			// D-01/D-03/D-04: device signer callback — engine computes Digest(InviteSlot.Cid)
			// internally and passes the bytes to this callback (engine-authoritative, D-03).
			// The callback closes over the device private key; the key never crosses into
			// vote-engine (D-01). Never { prehash:false } (WR-10).
			const signer = await createDeviceSigner(deviceUser.name);

			// Save invite with signing — engine computes digest, calls signer, commits.
			await authorityEngine.saveInviteWithSigning(officerInvite, "rad" as Scope, signer);

			// D-05: render the one-time invite material as text for Copy-to-clipboard share.
			// Include all fields the invitee needs to reconstruct the ephemeral key (D-06).
			const sharePayload = JSON.stringify({
				invitePrivate: officerInvite.invitePrivate,
				inviteKey: officerInvite.inviteKey,
				inviteSignature: officerInvite.inviteSignature,
				expiration: officerInvite.expiration,
				type: officerInvite.type,
				name: officerInvite.name,
				title: officerInvite.title,
			});
			setShareText(sharePayload);
			// D-08: do NOT navigate away immediately — keep screen so Copy affordance shows.
		} catch (error) {
			console.error("onSend error:", error);
			setErrorMessage(error instanceof Error ? error.message : String(error));
		}
	};

	// D-06: accept — invitee pastes the share text; screen reconstructs ephemeral invitePrivate.
	const onAccept = async () => {
		try {
			const engine = await getEngine<IInvitationEngine>("invitations");
			// Reconstruct invitePrivate from pasted text (D-06).
			let invitePrivate: string | undefined;
			if (pastedInvite.trim()) {
				try {
					const parsed = JSON.parse(pastedInvite.trim());
					invitePrivate = parsed.invitePrivate as string | undefined;
				} catch {
					// Not valid JSON — treat as raw invitePrivate hex
					invitePrivate = pastedInvite.trim();
				}
			}
			// T-21-11-03: accept calls the SIGNED respondToInvite path (D-09).
			await engine.respondToInvite(
				invitationId ?? "",
				true,
				invitePrivate,
			);
		} catch (error) {
			console.error("Error responding to invite:", error);
		}
		navigation.goBack();
	};

	const onDecline = async () => {
		try {
			const engine = await getEngine<IInvitationEngine>("invitations");
			// T-21-11-03: decline calls the SAME signed respondToInvite path (D-09).
			let invitePrivate: string | undefined;
			if (pastedInvite.trim()) {
				try {
					const parsed = JSON.parse(pastedInvite.trim());
					invitePrivate = parsed.invitePrivate as string | undefined;
				} catch {
					invitePrivate = pastedInvite.trim();
				}
			}
			await engine.respondToInvite(
				invitationId ?? "",
				false,
				invitePrivate,
			);
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

						{/* D-05: render share text + Copy button after a successful send */}
						{shareText ? (
							<>
								<ThemedText type="defaultSemiBold" style={styles.shareLabel}>
									{t("invitationKey")}
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

						{/* Pattern B error display */}
						{errorMessage ? (
							<ThemedText type="small" style={{ color: colors.error }}>
								{errorMessage}
							</ThemedText>
						) : null}
					</View>
				</ScrollView>
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
	shareLabel: {
		marginTop: 12,
		marginBottom: 4,
	},
	shareText: {
		marginBottom: 8,
		fontFamily: "monospace",
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
