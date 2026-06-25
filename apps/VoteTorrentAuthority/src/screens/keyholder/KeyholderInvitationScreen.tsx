import React, { useEffect, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type {
	IElectionEngine,
	IInvitationEngine,
	InviteStatus,
	KeyholderInvite,
	SentKeyholderInvite,
} from "@votetorrent/vote-core";
import Clipboard from "@react-native-clipboard/clipboard";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/curves/utils.js";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { CustomTextInput } from "../../components/CustomTextInput";
import { InlineError } from "../../components/InlineError";
import { SignatureTaskFooter } from "../../components/SignatureTaskFooter";
import type { RootStackParamList } from "../../navigation/types";
import { useApp } from "../../providers/AppProvider";
import { globalStyles } from "../../theme/styles";

type KeyholderInvitationParams = {
	mode: "send" | "accept";
	invitationId?: string;
	electionEngine?: IElectionEngine;
	keyholder?: InviteStatus<SentKeyholderInvite>;
};

export function KeyholderInvitationScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { mode, invitationId, electionEngine, keyholder } = useRoute().params as KeyholderInvitationParams;
	const { getEngine } = useApp();

	// Send-mode form state
	const [name, setName] = useState(keyholder?.invite?.name ?? "");
	// Share text shown after a successful send (D-05)
	const [shareText, setShareText] = useState<string>("");
	const [errorMessage, setErrorMessage] = useState<string>("");

	// Accept-mode paste field (D-06)
	const [pastedInvite, setPastedInvite] = useState<string>("");

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
				const status = await engine.getKeyholderInvite(invitationId);
				setInvite(status);
			} catch (error) {
				console.warn("Error loading keyholder invite:", error);
				setErrorMessage(error instanceof Error ? error.message : String(error));
			}
		}
		loadInvite();
	}, [mode, invitationId, getEngine]);

	// INV-03: real keyholder invite send via un-gated inviteKeyholder (21-05)
	const onSend = async () => {
		// Pattern B: clear any prior error so a retry starts clean.
		setErrorMessage("");
		try {
			if (!electionEngine) {
				setErrorMessage("Election engine not available — navigate from an election context.");
				return;
			}

			// Build the ephemeral secp256k1 key material for this keyholder invite.
			// AUTH-01 (D-01): hex-encoded secp256k1 key material at the screen surface.
			// The screen only generates the ephemeral key pair and includes invitePrivate
			// in the share text (D-06).
			//
			// WR-04: there is NO real keyholder-invite signature yet. The current
			// inviteKeyholder engine impl uses InviteSignature = null SQL-side; a real
			// keyholder-invite signature is produced engine-side by the forthcoming
			// createKeyholderInvite engine method (the same boundary that already mints
			// authority/officer invite signatures). We therefore do NOT fabricate a
			// signature value here — no placeholder is stored or shared. The
			// KeyholderInvite type requires inviteSignature: string, so we pass an empty
			// string (the engine ignores it) rather than a fake 128-char zero string.
			const invitePrivateBytes = secp256k1.utils.randomSecretKey();
			const invitePrivate = bytesToHex(invitePrivateBytes);
			const inviteKey = bytesToHex(secp256k1.getPublicKey(invitePrivateBytes));
			const type = "k" as const;
			const expiration = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

			const keyholderInvite: KeyholderInvite = {
				type,
				expiration,
				inviteKey,
				// No fabricated signature — produced engine-side once createKeyholderInvite
				// lands; inviteKeyholder ignores this field (InviteSignature = null SQL-side).
				inviteSignature: "",
				name,
			};

			// Get the election ID from the engine.
			const electionDetails = await electionEngine.getElectionDetails();
			const electionId = electionDetails.election.id;

			// Call the un-gated inviteKeyholder (21-05 removed the FeatureNotAvailableError gate).
			await electionEngine.inviteKeyholder(keyholderInvite, electionId);

			// D-05: render the one-time invite material as text for Copy-to-clipboard share.
			// Include the invitePrivate so the invitee can paste and accept (D-06).
			// WR-04: no inviteSignature is shared — the invitee reconstructs from
			// invitePrivate; no placeholder signature is propagated.
			const sharePayload = JSON.stringify({
				invitePrivate,
				inviteKey,
				expiration,
				type,
				name,
			});
			setShareText(sharePayload);
			// D-08: do NOT navigate away immediately — keep screen so Copy affordance shows.
		} catch (error) {
			console.warn("onSend error:", error);
			setErrorMessage(error instanceof Error ? error.message : String(error));
		}
	};

	// D-06: accept — invitee pastes the share text; screen reconstructs ephemeral invitePrivate.
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
			// T-21-11-03: accept calls the SIGNED respondToInvite path (D-09).
			await engine.respondToInvite(invitationId ?? "", true, invitePrivate);
			// GAP-2: navigate ONLY on success — the InviteResult is now written.
			navigation.goBack();
		} catch (error) {
			console.warn("Error responding to invite:", error);
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
			console.warn("Error responding to invite:", error);
			setErrorMessage(error instanceof Error ? error.message : String(error));
		}
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
						<InlineError message={errorMessage} />
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
			<InlineError message={errorMessage} />
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

export default KeyholderInvitationScreen;
