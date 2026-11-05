import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ExtendedTheme, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type {
	IDefaultUserEngine,
	IElectionEngine,
	IInvitationEngine,
	IKeyholderDkgEngine,
	InviteStatus,
	KeyholderInvite,
	SentKeyholderInvite,
} from "@votetorrent/vote-core";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/curves/utils.js";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { InviteShareBlock } from "../invitations/InviteShareBlock";
import { InlineError } from "../../components/InlineError";
import { SignatureTaskFooter } from "../../components/SignatureTaskFooter";
import type { RootStackParamList } from "../../navigation/types";
import { useApp } from "../../providers/AppProvider";
import { createDeviceSigner } from "../../engines/device-signer";
import { resolveKeyholderKeyVault } from "../../engines/keyholder-vault";
import { acceptKeyholderInvitation } from "./keyholder-accept";
import {
	DEFAULT_KEYHOLDER_INVITE_EXPIRY_HOURS,
	KEYHOLDER_INVITE_EXPIRY_HOURS,
	keyholderInviteExpiration,
	keyholderInviteExpiryLabel,
} from "./keyholder-invite-expiry";
import { inviteAcceptErrorKey, inviteLoadErrorKey, isShareExpired, parseInviteExpirationMs, parseInviteShare, resolveInviteFromShare } from "../invitations/invite-share";
import { takeInviteShare } from "../invitations/invite-share-handoff";
import { InviteSharePasteField } from "../invitations/InviteSharePasteField";
import { globalStyles } from "../../theme/styles";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import { useUnsharedInviteGuard } from "../../hooks/useUnsharedInviteGuard";
import { KeyboardAvoidingScreen } from "../../components/KeyboardAvoidingScreen";

type KeyholderInvitationParams = {
	mode: "send" | "accept";
	shareToken?: string;
	electionEngine?: IElectionEngine;
	keyholder?: InviteStatus<SentKeyholderInvite>;
};

export function KeyholderInvitationScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { mode, shareToken, electionEngine, keyholder } = useRoute().params as KeyholderInvitationParams;
	const { getEngine } = useApp();

	// Send-mode form state. The invitation always goes to one of the election's invitees (REVIEW/IN-06): the
	// name is fixed when opened from a keyholder, otherwise picked from the invitees who have not accepted.
	const fixedName = keyholder?.invite?.name;
	const [pickedName, setPickedName] = useState<string | undefined>(undefined);
	const name = fixedName ?? pickedName ?? "";
	const [pendingNames, setPendingNames] = useState<string[] | undefined>(undefined);
	// O-11: the sending officer chooses how long the invitation stays valid (default 24 hours).
	const [expiryHours, setExpiryHours] = useState<number>(DEFAULT_KEYHOLDER_INVITE_EXPIRY_HOURS);
	const [sentExpiration, setSentExpiration] = useState<string>("");
	// Share text shown after a successful send (D-05)
	const [shareText, setShareText] = useState<string>("");
	// Protects the only copy of the minted invite until it is shared or copied; confirms before discarding it.
	const markInviteShared = useUnsharedInviteGuard(shareText);
	const [errorMessage, setErrorMessage] = useState<string>("");
	const [isSending, setIsSending] = useState(false);
	const [isAccepting, setIsAccepting] = useState(false);
	const handleDeviceSigningError = useDeviceSigningErrorHandler();

	// Accept-mode paste field (D-06); seeded by an entry route that already holds the share.
	const [pastedInvite, setPastedInvite] = useState<string>(() => takeInviteShare(shareToken) ?? "");
	const parsed = useMemo(() => parseInviteShare(pastedInvite), [pastedInvite]);
	// An expired share is shown as expired before any prompt or engine write; the engine refusal stays the authority.
	const expiredAt = useMemo(() => {
		if (!parsed || !isShareExpired(parsed, Date.now())) return undefined;
		const ms = parseInviteExpirationMs(parsed.expiration as string);
		return ms === undefined ? undefined : new Date(ms).toLocaleString();
	}, [parsed]);
	const expired = expiredAt !== undefined;
	// gap6/WR-06: the name shown is the one STORED on the invitation slot, read after the slot
	// resolves; the name inside the pasted JSON is unauthenticated and never displayed.
	const [resolved, setResolved] = useState<{ slotCid: string; storedName: string } | undefined>(undefined);

	useLayoutEffect(() => {
		navigation.setOptions({
			title: mode === "send" ? t("sendInvitation") : t("invitation"),
		});
	}, [navigation, t, mode]);

	// Send mode without a fixed invitee: list the invitees who have not accepted (read once).
	useEffect(() => {
		if (mode !== "send" || fixedName !== undefined || !electionEngine) return;
		let cancelled = false;
		(async () => {
			try {
				const details = await electionEngine.getElectionDetails();
				if (cancelled) return;
				const names = (details.current?.keyholders ?? [])
					.filter((k: InviteStatus<SentKeyholderInvite>) => !k.result && k.invite?.name)
					.map((k: InviteStatus<SentKeyholderInvite>) => k.invite.name);
				setPendingNames(names);
			} catch (error) {
				if (cancelled) return;
				console.warn("Error loading keyholder invitees:", error instanceof Error ? error.name : "unknown");
				setPendingNames([]);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [mode, fixedName, electionEngine]);

	// INV-03: real keyholder invite send via un-gated inviteKeyholder (21-05)
	// WR-R3-08: `isSending` disables Send only after a re-render, so two taps in one frame would each
	// mint an invitation slot. This ref latches synchronously, before any await.
	const sendingRef = useRef(false);
	const sendInvitation = async () => {
		// Pattern B: clear any prior error so a retry starts clean.
		setErrorMessage("");
		setIsSending(true);
		try {
			if (!electionEngine) {
				setErrorMessage(t("invitationNeedsElection"));
				return;
			}
			if (!name) return;

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
			const expiration = keyholderInviteExpiration(Date.now(), expiryHours);

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

			// second-keyholder-invite-unique fix: inviteKeyholder now writes a signed
			// InviteSlot (Type='k') and requires the admin's approval signature — same
			// D-01/D-03/D-04 device-signer pattern AuthorityInvitationScreen uses for
			// saveInviteWithSigning. The private key never crosses into vote-engine.
			const defaultUserEng = await getEngine<IDefaultUserEngine>("defaultUser");
			const defaultUser = await defaultUserEng.get();
			const signer = await createDeviceSigner(defaultUser?.name ?? "Device User");

			// Call the un-gated inviteKeyholder (21-05 removed the FeatureNotAvailableError gate).
			await electionEngine.inviteKeyholder(keyholderInvite, electionId, signer);

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
			setSentExpiration(expiration);
			// D-08: do NOT navigate away immediately — keep screen so Copy affordance shows.
		} catch (error) {
			console.warn("onSend error:", error instanceof Error ? error.name : "unknown");
			const outcome = handleDeviceSigningError(error);
			if (outcome.handled) return;
			const code = (error as { code?: unknown } | null | undefined)?.code;
			setErrorMessage(
				code === "invite-expiration-out-of-range"
					? t("keyholderInviteExpiryOutOfRange")
					: (outcome.message ?? t("keyholderInviteSendFailed")),
			);
		} finally {
			setIsSending(false);
		}
	};
	const onSend = async () => {
		if (sendingRef.current) return;
		sendingRef.current = true;
		try {
			await sendInvitation();
		} finally {
			sendingRef.current = false;
		}
	};

	// Map a failed accept/decline to user copy. Never render engine text or any Cid.
	const mapAcceptError = (error: unknown): string => {
		const key = inviteAcceptErrorKey(error);
		if (key) return t(key);
		const code = (error as { code?: unknown } | undefined)?.code;
		if (code === "auth-denied") return t("deviceSigningErrorGeneric");
		return t("invitationAcceptFailed");
	};

	// Resolve the slot from the paste and read its stored name (accept mode only).
	useEffect(() => {
		if (mode !== "accept") return;
		setResolved(undefined);
		// gap9/IN-08: a stale error never outlives the paste that caused it.
		setErrorMessage("");
		if (!pastedInvite.trim() || !parsed || expired) return;
		let cancelled = false;
		(async () => {
			try {
				const engine = await getEngine<IInvitationEngine>("invitations");
				const r = await resolveInviteFromShare(engine, pastedInvite, "k");
				if (cancelled) return;
				const stored = (r.status as { invite?: { name?: string } } | undefined)?.invite?.name;
				setResolved({ slotCid: r.slotCid, storedName: stored ?? "" });
			} catch (error) {
				if (cancelled) return;
				console.warn("Error loading keyholder invite:", error instanceof Error ? error.name : "unknown");
				setErrorMessage(t(inviteLoadErrorKey(error)));
			}
		})();
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mode, pastedInvite, getEngine, expired]);

	// D-06/D-21/D-26: accept - the invitee pastes the share text; acceptKeyholderInvitation resolves
	// the slot from the share alone (before any prompt), provisions a FRESH keyholder identity (D-21)
	// and passes its signed binding (D-26) to respondToInvite in one call. The officer's device key is
	// never used for a keyholder accept.
	const respondingRef = useRef(false);
	const onAccept = async () => {
		if (respondingRef.current || expired) return;
		respondingRef.current = true;
		setErrorMessage("");
		setIsAccepting(true);
		try {
			const engine = await getEngine<IInvitationEngine>("invitations");
			await acceptKeyholderInvitation(
				{
					invitationEngine: engine,
					vault: resolveKeyholderKeyVault(),
					// Positive proof that a held same-election identity is an earlier-revision seat (never prompts).
					readKeyholderSeatFacts: async (electionId) => {
						try {
							const s = await (await getEngine<IKeyholderDkgEngine>("keyholderDkg")).getDkgStatus(electionId);
							return { revision: s.revision, liveRoster: s.liveRoster, earlierRevisionUserIds: s.earlierRevisionUserIds };
						} catch {
							return undefined;
						}
					},
				},
				pastedInvite
			);
			// GAP-2: navigate ONLY on success - the InviteResult is now written.
			navigation.goBack();
		} catch (error) {
			console.warn("Error responding to invite:", error instanceof Error ? error.name : "unknown");
			setErrorMessage(mapAcceptError(error));
		} finally {
			respondingRef.current = false;
			setIsAccepting(false);
		}
	};

	const onDecline = async () => {
		// One in-flight answer at a time (shared latch with Accept).
		if (respondingRef.current) return;
		respondingRef.current = true;
		setIsAccepting(true);
		setErrorMessage("");
		try {
			const engine = await getEngine<IInvitationEngine>("invitations");
			const { slotCid, invitePrivate } = await resolveInviteFromShare(engine, pastedInvite, "k");
			// T-21-11-03: decline calls the SAME signed respondToInvite path (D-09).
			await engine.respondToInvite(slotCid, false, invitePrivate);
			// GAP-2: navigate ONLY on success - the InviteResult is now written.
			navigation.goBack();
		} catch (error) {
			console.warn("Error responding to invite:", error instanceof Error ? error.name : "unknown");
			setErrorMessage(mapAcceptError(error));
		} finally {
			respondingRef.current = false;
			setIsAccepting(false);
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
						{fixedName !== undefined ? (
							<View style={styles.detailRow}>
								<ThemedText type="defaultSemiBold">{t("name")}: </ThemedText>
								<ThemedText testID="keyholder-invitation-send-name">{fixedName}</ThemedText>
							</View>
						) : pendingNames === undefined ? null : pendingNames.length === 0 ? (
							<ThemedText testID="keyholder-invite-no-pending">{t("keyholderInviteNoPendingInvitees")}</ThemedText>
						) : (
							<View>
								<ThemedText type="defaultSemiBold">{t("keyholderInvitePickInvitee")}</ThemedText>
								{pendingNames.map((n) => (
									<RadioRow
										key={n}
										testID={`keyholder-invite-invitee-${n}`}
										label={n}
										selected={pickedName === n}
										disabled={isSending || !!shareText}
										onPress={() => setPickedName(n)}
									/>
								))}
							</View>
						)}

						{!shareText ? (
							<View>
								<ThemedText type="defaultSemiBold">{t("keyholderInviteExpiryLabel")}</ThemedText>
								{KEYHOLDER_INVITE_EXPIRY_HOURS.map((h) => (
									<RadioRow
										key={h}
										testID={`keyholder-invite-expiry-${h}`}
										label={keyholderInviteExpiryLabel(h, t)}
										selected={expiryHours === h}
										disabled={isSending}
										onPress={() => setExpiryHours(h)}
									/>
								))}
							</View>
						) : (
							<ThemedText testID="keyholder-invite-expires-at">
								{t("keyholderInviteExpiresAt", { when: new Date(sentExpiration).toLocaleString() })}
							</ThemedText>
						)}

						{/* D-05: render share text + Copy button after a successful send */}
						{shareText ? (
							<InviteShareBlock label={t("invitationKey")} shareText={shareText} testIDPrefix="keyholder-invitation-share" onShared={markInviteShared} />
						) : null}

						{/* Pattern B error display */}
						<InlineError message={errorMessage} />
					</View>
				</ScrollView>
				{!shareText && (fixedName !== undefined || (pendingNames !== undefined && pendingNames.length > 0)) ? (
					<Footer>
						<CustomButton
							title={isSending ? `${t("send")}…` : t("send")}
							icon="paper-plane"
							disabled={isSending || !name}
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
	return (
		<KeyboardAvoidingScreen>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t("keyholderInvitation")}
					</ThemedText>
					{expired ? (
						<ThemedText testID="invitation-expired-notice">{t("invitationAcceptExpired", { when: expiredAt })}</ThemedText>
					) : null}
					{resolved?.storedName ? (
						<View style={styles.detailRow}>
							<ThemedText type="defaultSemiBold">{t("name")}: </ThemedText>
							<ThemedText testID="keyholder-invitation-name">{resolved.storedName}</ThemedText>
						</View>
					) : (
						<ThemedText>{t("invitationAcceptPasteHint")}</ThemedText>
					)}
					<ThemedText testID="keyholder-reaccept-accept-note">{t("keyholderReacceptAcceptNote")}</ThemedText>

					{/* D-06: paste field for the share text the sender copied. CustomTextInput's `title` is
					    the field's only label (a separate heading here rendered it twice). */}
					<InviteSharePasteField
						testIDPrefix="keyholder-invitation-paste"
						title={t("invitationKey")}
						value={pastedInvite}
						onChangeText={setPastedInvite}
						placeholder={t("invitationAcceptPastePlaceholder")}
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
				disabled={isAccepting || !resolved || expired}
			/>
		</KeyboardAvoidingScreen>
	);
}

/** One radio option (the ReassociationReviewToggle pattern, >= 48 dp touch target). */
function RadioRow({
	testID,
	label,
	selected,
	disabled,
	onPress,
}: {
	testID: string;
	label: string;
	selected: boolean;
	disabled?: boolean;
	onPress: () => void;
}) {
	const { colors } = useTheme() as ExtendedTheme;
	return (
		<TouchableOpacity
			testID={testID}
			accessibilityRole="radio"
			accessibilityState={{ selected, disabled: !!disabled }}
			disabled={disabled}
			onPress={onPress}
			style={localStyles.option}
		>
			<FontAwesome6 name={selected ? "circle-dot" : "circle"} size={20} color={selected ? colors.accent : colors.textSecondary} />
			<ThemedText type="default" style={localStyles.optionLabel}>
				{label}
			</ThemedText>
		</TouchableOpacity>
	);
}

const localStyles = StyleSheet.create({
	option: {
		flexDirection: "row",
		alignItems: "center",
		alignSelf: "stretch",
		minHeight: 48,
		gap: 8,
	},
	optionLabel: {
		flexShrink: 1,
	},
	detailRow: {
		flexDirection: "row",
		marginBottom: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };

export default KeyholderInvitationScreen;
