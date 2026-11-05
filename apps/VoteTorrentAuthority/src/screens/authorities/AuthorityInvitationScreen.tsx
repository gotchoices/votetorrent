import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { ThemedText } from "../../components/ThemedText";
import { InlineError } from "../../components/InlineError";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { CustomTextInput } from "../../components/CustomTextInput";
import { InviteShareBlock } from "../invitations/InviteShareBlock";
import { Footer } from "../../components/Footer";
import { InfoCard } from "../../components/InfoCard";
import { SignatureTaskFooter } from "../../components/SignatureTaskFooter";
import type { RootStackParamList } from "../../navigation/types";
import { useApp } from "../../providers/AppProvider";
import { createDeviceSigner } from "../../engines/device-signer";
import { getOrCreateDeviceUser } from "../../engines/device-user";
import { globalStyles } from "../../theme/styles";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import { useUnsharedInviteGuard } from "../../hooks/useUnsharedInviteGuard";
import { KeyboardAvoidingScreen } from "../../components/KeyboardAvoidingScreen";
import { inviteAcceptErrorKey, inviteLoadErrorKey, isShareExpired, parseInviteExpirationMs, parseInviteShare, resolveInviteFromShare } from "../invitations/invite-share";
import { takeInviteShare } from "../invitations/invite-share-handoff";
import { InviteSharePasteField } from "../invitations/InviteSharePasteField";

type AuthorityInvitationParams = {
	mode: "send" | "accept";
	shareToken?: string;
};

export default function AuthorityInvitationScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { mode, shareToken } = useRoute().params as AuthorityInvitationParams;
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
	const [isSending, setIsSending] = useState(false);
	const handleDeviceSigningError = useDeviceSigningErrorHandler();

	// D-05: share text shown after a successful send (authority invite material).
	const [shareText, setShareText] = useState<string>("");
	// Protects the only copy of the minted invite until it is shared or copied; confirms before discarding it.
	const markInviteShared = useUnsharedInviteGuard(shareText);

	// D-06: paste field in accept mode.
	const [pastedInvite, setPastedInvite] = useState<string>(() => takeInviteShare(shareToken) ?? "");
	const parsed = useMemo(() => parseInviteShare(pastedInvite), [pastedInvite]);
	// An expired share is shown as expired before any prompt or engine write; the engine refusal stays the authority.
	const expiredAt = useMemo(() => {
		if (!parsed || !isShareExpired(parsed, Date.now())) return undefined;
		const ms = parseInviteExpirationMs(parsed.expiration as string);
		return ms === undefined ? undefined : new Date(ms).toLocaleString();
	}, [parsed]);
	const expired = expiredAt !== undefined;
	// The slot resolved from the paste (by InviteKey + type); accept and decline sign against it.
	const [resolved, setResolved] = useState<{ slotCid: string; invitePrivate: string } | undefined>(undefined);

	useEffect(() => {
		// Network context for the invitation header (best-effort; real engine later).
		async function loadNetwork() {
			try {
				const engine = await getEngine<INetworkEngine>("network");
				const details = await engine?.getDetails();
				if (details?.network?.name) setNetworkName(details.network.name);
			} catch (error) {
				console.error("Error loading network for invitation:", error instanceof Error ? error.name : "unknown");
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

	// Map a failed resolve/accept/decline to user copy. Never render engine text or any Cid.
	const mapAcceptError = (error: unknown): string => {
		const key = inviteAcceptErrorKey(error);
		return t(key ?? "invitationAcceptFailed");
	};

	// Resolve the slot from the pasted share, then load the invite details from the resolved Cid.
	useEffect(() => {
		if (mode !== "accept") return;
		setResolved(undefined);
		setInvite(undefined);
		// gap9/IN-08: a stale error never outlives the paste that caused it.
		setErrorMessage("");
		if (!pastedInvite.trim()) return;
		if (!parsed) return; // still typing; the paste hint stays up
		if (expired) return; // expired share: no engine lookup; the notice explains
		let cancelled = false;
		(async () => {
			try {
				const engine = await getEngine<IInvitationEngine>("invitations");
				const r = await resolveInviteFromShare(engine, pastedInvite, "au");
				const status = r.status as InviteStatus<any> | undefined;
				if (cancelled) return;
				setErrorMessage("");
				setResolved({ slotCid: r.slotCid, invitePrivate: r.invitePrivate });
				setInvite(status);
			} catch (error) {
				if (cancelled) return;
				console.warn("Error loading authority invite:", error instanceof Error ? error.name : "unknown");
				setErrorMessage(t(inviteLoadErrorKey(error)));
			}
		})();
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mode, pastedInvite, getEngine, expired]);

	// INV-02: onSend invites onto the network's EXISTING primary authority.
	// D-05: a Copy-to-clipboard share is added after a successful send.
	// WR-R3-08: `isSending` disables Send only after a re-render, so two taps in one frame would each
	// mint an invitation slot. This ref latches synchronously, before any await.
	const sendingRef = useRef(false);
	const sendInvitation = async () => {
		// 16-08 item 4: clear any prior error so a retry starts clean.
		setErrorMessage("");
		// Required-field guard: an empty authority name would otherwise generate an
		// invite with a blank name and silently flip to the share state. Surface it
		// inline (same pattern as the engine guards below) instead of proceeding.
		if (!name.trim()) {
			setErrorMessage(t("errAuthorityNameRequired"));
			return;
		}
		setIsSending(true);
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
				setErrorMessage(t("invitationNetworkStarting"));
				return;
			}
			const recentRefs = await (networksEngine as INetworksEngine).getRecentNetworks();
			if (!recentRefs || recentRefs.length === 0) {
				setErrorMessage(t("invitationNoNetwork"));
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
				setErrorMessage(t("invitationAuthorityUnresolved"));
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
			console.warn("AuthorityInvitationScreen send failed:", error instanceof Error ? error.name : "unknown");
			const outcome = handleDeviceSigningError(error);
			if (outcome.handled) return;
			setErrorMessage(outcome.message ?? t("invitationSendFailed"));
			return;
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

	// D-06: accept - the slot is resolved from the pasted share, never from a route id.
	const respondingRef = useRef(false);
	const [isResponding, setIsResponding] = useState(false);
	const respond = async (accept: boolean) => {
		// gap6/IN-04: one in-flight answer at a time (the ref closes the window before state re-renders).
		if (respondingRef.current) return;
		respondingRef.current = true;
		setIsResponding(true);
		setErrorMessage("");
		try {
			const engine = await getEngine<IInvitationEngine>("invitations");
			// gap7/WR-01: always re-resolve at press time so a resend made while the screen was open is
			// answered on the live head, not the Cid captured at mount.
			const target = await resolveInviteFromShare(engine, pastedInvite, "au");
			// T-21-11-03: accept and decline both call the SIGNED respondToInvite path (D-09).
			await engine.respondToInvite(target.slotCid, accept, target.invitePrivate);
			// GAP-2: navigate ONLY on success - the InviteResult is now written.
			navigation.goBack();
		} catch (error) {
			console.warn("Error responding to invite:", error instanceof Error ? error.name : "unknown");
			setErrorMessage(mapAcceptError(error));
		} finally {
			respondingRef.current = false;
			setIsResponding(false);
		}
	};
	const onAccept = () => (expired ? undefined : respond(true));
	const onDecline = () => respond(false);

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
							<InviteShareBlock label={t("invitationKey")} shareText={shareText} testIDPrefix="authority-invitation-share" onShared={markInviteShared} />
						) : null}
					</View>
				</ScrollView>
				{/* Padded like the ScrollView content: refusal copy must not sit flush at x=0 (UAT 62 gap 4 item 6) */}
				<View testID="authority-invitation-error" style={{ paddingHorizontal: globalStyles.container.padding }}>
					<InlineError message={errorMessage} />
				</View>
				{!shareText ? (
					<Footer>
						<CustomButton
							title={isSending ? `${t("send")}…` : t("send")}
							icon="paper-plane"
							disabled={isSending}
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
	const invitationKey = (seedInvite as any)?.key ?? (seedInvite as any)?.inviteKey ?? parsed?.inviteKey;
	return (
		<KeyboardAvoidingScreen>
			<ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 24 }}>
				<View style={styles.section}>
					{!parsed ? <ThemedText>{t("invitationAcceptPasteHint")}</ThemedText> : null}
					{expired ? (
						<ThemedText testID="invitation-expired-notice">{t("invitationAcceptExpired", { when: expiredAt })}</ThemedText>
					) : null}
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
						makePermanentPressed={undefined}
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

					{/* D-06: paste field for the share text the sender copied. CustomTextInput's `title` is
					    the field's only label (a separate heading here rendered it twice). */}
					<InviteSharePasteField
						testIDPrefix="authority-invitation-paste"
						title={t("invitationKey")}
						value={pastedInvite}
						onChangeText={setPastedInvite}
						placeholder={t("invitationAcceptPastePlaceholder")}
					/>
				</View>
			</ScrollView>
			{/* GAP-2: surface respondToInvite failures inline in accept mode */}
			<View testID="authority-invitation-error" style={{ paddingHorizontal: globalStyles.container.padding }}>
				<InlineError message={errorMessage} />
			</View>
			<SignatureTaskFooter
				onAccept={onAccept}
				onReject={onDecline}
				acceptLabel={t("accept")}
				rejectLabel={t("reject")}
				disabled={!resolved || expired || isResponding}
			/>
		</KeyboardAvoidingScreen>
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
