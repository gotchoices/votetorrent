/**
 * AcceptInvitationScreen - the paste-first entry to every invitation accept flow.
 *
 * Why this exists (UAT 62 test 10): no production route used to reach an accept screen. The only
 * entries were dev scaffolds that passed placeholder ids, so an invitee could not accept anything.
 * The invitee now pastes the share they were sent; this screen parses it and hands the SAME text (by one-shot token, never in route params) to
 * the role screen for the share's type, which resolves the invite slot itself. This screen makes no
 * engine call, so routing here is a convenience and the role screens re-check the type.
 *
 * QR: the invitee can also SCAN the invitation QR on the sender's screen (the camera scanner shared
 * with Join a network, in invitation mode) or CHOOSE AN IMAGE (a photo or screenshot of the QR, read
 * by `pickImageAndReadQrCodes`). Either one only fills the field, exactly as a paste would; the
 * invitee still taps Continue, and then Accept on the role screen. A join code is refused with a
 * sentence that points to Join a network. A build without the image picker shows that choosing an
 * image is not available instead of offering a button that would fail.
 *
 * Precondition: the role screens only find a slot whose row is present in this device's database.
 * Replication of an invite to a second device is a separate (P2P) concern.
 *
 * The pasted, scanned or decoded text holds a one-time secret, so nothing here logs it.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ExtendedTheme, useNavigation, useTheme } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { looksLikeJoinCode } from "@votetorrent/vote-engine/rn";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { InlineError } from "../../components/InlineError";
import { KeyboardAvoidingScreen } from "../../components/KeyboardAvoidingScreen";
import type { RootStackParamList } from "../../navigation/types";
import { globalStyles } from "../../theme/styles";
import { isQrImageDecodeAvailable, pickImageAndReadQrCodes } from "../../engines/qr-image-decode";
import JoinCodeScanner, { type JoinScanCameraState } from "../networks/JoinCodeScanner";
import { isInvitationQrText, parseInviteShare } from "./invite-share";
import { stashInviteShare } from "./invite-share-handoff";
import { InviteSharePasteField } from "./InviteSharePasteField";

const ROUTE_FOR_TYPE = {
	k: "KeyholderInvitation",
	of: "AdministratorInvitation",
	au: "AuthorityInvitation",
} as const;

type CameraAvailability = "ready" | "blocked" | "none";

/** One line under the Scan / Choose image buttons. */
type QrNotice =
	| "scanned"
	| "image-read"
	| "camera-denied"
	| "camera-failed"
	| "image-join-code"
	| "image-not-invitation"
	| "image-no-code"
	| "image-unreadable"
	| "image-unavailable";

type StatusKey = QrNotice | "camera-none" | "camera-blocked";

export const ACCEPT_INVITATION_NOTICE_KEYS: Readonly<Record<StatusKey, string>> = {
	scanned: "inviteScanScanned",
	"image-read": "inviteImageRead",
	"camera-denied": "inviteScanCameraDenied",
	"camera-failed": "inviteScanCameraFailed",
	"camera-none": "inviteScanCameraNone",
	"camera-blocked": "inviteScanCameraBlocked",
	"image-join-code": "inviteImageIsJoinCode",
	"image-not-invitation": "inviteImageNotInvitation",
	"image-no-code": "inviteImageNoCode",
	"image-unreadable": "inviteImageUnreadable",
	"image-unavailable": "inviteImageUnavailable",
};

/** Pick the invitation among the decoded QR values, or say why there is none. */
export function classifyDecodedQrValues(
	values: readonly string[]
): { kind: "invitation"; text: string } | { kind: "join-code" } | { kind: "other" } {
	const invitation = values.find((v) => isInvitationQrText(v));
	if (invitation !== undefined) return { kind: "invitation", text: invitation };
	if (values.some((v) => looksLikeJoinCode(v))) return { kind: "join-code" };
	return { kind: "other" };
}

export function AcceptInvitationScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const [pasted, setPasted] = useState("");
	const [errorMessage, setErrorMessage] = useState("");
	const [scannerOpen, setScannerOpen] = useState(false);
	const [camera, setCamera] = useState<CameraAvailability>("ready");
	const [notice, setNotice] = useState<QrNotice | null>(null);
	const [picking, setPicking] = useState(false);
	const pickingRef = useRef(false);
	const mountedRef = useRef(true);
	const imageAvailable = useMemo(() => isQrImageDecodeAvailable(), []);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("invitationAcceptTitle") });
	}, [navigation, t]);

	const onChangeText = (value: string) => {
		setPasted(value);
		setNotice(null);
	};

	const fillFromQr = (text: string, from: "scanned" | "image-read") => {
		setPasted(text);
		setErrorMessage("");
		setNotice(from);
	};

	const onScanPress = () => {
		if (camera !== "ready" || pickingRef.current) return;
		setNotice(null);
		setScannerOpen(true);
	};

	// A scan only fills the field. Continue stays a separate tap.
	const onScanAccept = (scanned: string) => {
		setScannerOpen(false);
		fillFromQr(scanned, "scanned");
	};

	const onCameraState = (state: JoinScanCameraState) => {
		if (state === "ready" || state === "blocked" || state === "none") setCamera(state);
		if (state === "denied") setNotice("camera-denied");
		if (state === "failed") setNotice("camera-failed");
		if (state !== "ready") setScannerOpen(false);
	};

	const onOpenSettings = () => {
		Linking.openSettings().catch(() => {
			// The rejection (it can carry anything) is never read.
			console.info("[invite] scan: open-settings-failed");
		});
	};

	const onChooseImage = async () => {
		if (pickingRef.current || !imageAvailable) return;
		pickingRef.current = true;
		setPicking(true);
		setNotice(null);
		try {
			const result = await pickImageAndReadQrCodes();
			if (!mountedRef.current) return;
			switch (result.kind) {
				case "decoded": {
					const found = classifyDecodedQrValues(result.values);
					if (found.kind === "invitation") fillFromQr(found.text, "image-read");
					else setNotice(found.kind === "join-code" ? "image-join-code" : "image-not-invitation");
					break;
				}
				case "no-code":
					setNotice("image-no-code");
					break;
				case "unreadable":
					setNotice("image-unreadable");
					break;
				case "unavailable":
					setNotice("image-unavailable");
					break;
				case "cancelled":
					break;
			}
		} finally {
			pickingRef.current = false;
			if (mountedRef.current) setPicking(false);
		}
	};

	const onContinue = () => {
		setErrorMessage("");
		const share = parseInviteShare(pasted);
		if (!share?.type) {
			setErrorMessage(t("invitationAcceptMalformed"));
			return;
		}
		const route = ROUTE_FOR_TYPE[share.type as keyof typeof ROUTE_FOR_TYPE];
		if (!route) {
			setErrorMessage(t("invitationAcceptWrongType"));
			return;
		}
		// The share holds the invite private key: only an opaque one-shot token travels in params.
		const shareToken = stashInviteShare(pasted);
		setPasted("");
		setNotice(null);
		navigation.replace(route, { mode: "accept", shareToken });
	};

	// The camera's availability outranks a one-off notice: Scan stays disabled while it holds.
	const statusKey: StatusKey | null = camera === "none" ? "camera-none" : camera === "blocked" ? "camera-blocked" : notice;
	const statusOk = statusKey === "scanned" || statusKey === "image-read";

	return (
		<KeyboardAvoidingScreen>
			<ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t("invitationAcceptTitle")}
					</ThemedText>
					<ThemedText>{t("invitationAcceptBody")}</ThemedText>
					<View style={styles.qrButtons}>
						<CustomButton
							testID="accept-invitation-scan"
							title={t("inviteScanButton")}
							icon="qrcode"
							disabled={camera !== "ready" || picking}
							onPress={onScanPress}
						/>
						<CustomButton
							testID="accept-invitation-choose-image"
							title={picking ? `${t("inviteImageButton")}…` : t("inviteImageButton")}
							icon="image"
							backgroundColor={colors.card}
							disabled={!imageAvailable || picking}
							onPress={() => void onChooseImage()}
						/>
						{!imageAvailable ? (
							<ThemedText type="small" testID="accept-invitation-image-unavailable" style={{ color: colors.textSecondary }}>
								{t("inviteImageUnavailable")}
							</ThemedText>
						) : null}
					</View>
					{statusKey ? (
						<View testID="accept-invitation-scan-status" style={styles.status}>
							<View style={styles.noticeRow} accessibilityRole={statusOk ? undefined : "alert"}>
								<FontAwesome6
									name={statusOk ? "circle-check" : "triangle-exclamation"}
									size={16}
									color={statusOk ? colors.text : colors.warning}
									style={styles.noticeIcon}
								/>
								<ThemedText accessibilityLiveRegion="polite" style={{ color: colors.text, flexShrink: 1 }}>
									{t(ACCEPT_INVITATION_NOTICE_KEYS[statusKey])}
								</ThemedText>
							</View>
							{statusKey === "camera-blocked" ? (
								<Pressable
									testID="accept-invitation-scan-open-settings"
									accessibilityRole="button"
									onPress={onOpenSettings}
									style={styles.openSettings}
								>
									<Text style={{ color: colors.primary, fontSize: 16, fontWeight: "400" }}>{t("joinScanOpenSettings")}</Text>
								</Pressable>
							) : null}
						</View>
					) : null}
					<InviteSharePasteField
						testIDPrefix="accept-invitation"
						value={pasted}
						onChangeText={onChangeText}
						placeholder={t("invitationAcceptPastePlaceholder")}
					/>
				</View>
			</ScrollView>
			<InlineError message={errorMessage} />
			<Footer>
				<CustomButton
					testID="accept-invitation-continue"
					title={t("invitationAcceptContinue")}
					icon="arrow-right"
					disabled={!pasted.trim()}
					onPress={onContinue}
				/>
			</Footer>
			<JoinCodeScanner
				kind="invitation"
				visible={scannerOpen}
				onAccept={onScanAccept}
				onClose={() => setScannerOpen(false)}
				onPasteInstead={() => setScannerOpen(false)}
				onCameraState={onCameraState}
			/>
		</KeyboardAvoidingScreen>
	);
}

const styles = {
	...globalStyles,
	...StyleSheet.create({
		qrButtons: {
			marginTop: 12,
			gap: 4,
		},
		status: {
			marginTop: 8,
			gap: 8,
		},
		noticeRow: {
			flexDirection: "row",
			alignItems: "flex-start",
		},
		noticeIcon: {
			marginTop: 3,
			marginRight: 8,
		},
		openSettings: {
			minHeight: 44,
			justifyContent: "center",
		},
	}),
};

export default AcceptInvitationScreen;
