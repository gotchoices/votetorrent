import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
import { ExtendedTheme, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { IReassociationEngine, ReassociationReview } from "@votetorrent/vote-core";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { InlineError } from "../../components/InlineError";
import { globalStyles } from "../../theme/styles";
import { useApp } from "../../providers/AppProvider";
import { createDeviceSigner } from "../../engines/device-signer";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import { useCurrentOfficerScopes } from "../../hooks/useCurrentOfficerScopes";
import { truncateId } from "./registrant-display";
import { truncateDeviceKey } from "./components/AssociationsSection";
import { LifecycleConfirmCard } from "./components/LifecycleConfirmCard";
import {
	classifyReassociationEvidence,
	isThresholdCoSignRefusal,
	openPeerReviewSession,
	readOnlyReviewSign,
	reassociationRegistrantLabel,
	type PeerReviewSession,
	type ReassociationEvidenceView,
} from "./continuity-review";
import type { RootStackParamList } from "../../navigation/types";

/**
 * AssociationRequestApprovalScreen — the officer review of one pending device-change request
 * (Phase 62 Plan 27; D-41, D-45, D-46; Surface 4).
 *
 * (1) Both devices render before any decision (D-41): the incoming new device AND every existing
 * device that approval retires, in one card, stacked, so an officer never approves blind.
 *
 * (2) The variants: the code-matched badge; the identity banner, which ALWAYS needs an officer
 * whatever D-46 says (D-45); and three reject-only banners (unmatched code, unverifiable code,
 * no evidence), each rendering its own honest copy with Approve disabled.
 *
 * (3) A destructive confirm precedes approval. Per 62-18, approval binds the registrant, and the
 * old device is retired when the new device completes attestation, not at the press.
 *
 * (4) Never-log rule: identity fields, registrant record values and names have exactly one
 * destination each (their own text node), and this file has no console calls. Engine messages are
 * never rendered: every failure maps to a 62-10 key.
 *
 * (5) The scope gate (`useCurrentOfficerScopes`) is UI legibility only. The 'vrg' AdminSigning
 * CHECK and `Association.DeleteValid` enforce; Approve and Reject are disabled, never hidden.
 *
 * The peer review session is opened read-only (its decision signer always rejects): the approve
 * and reject ceremonies sign through the engine call's own `signatureOrCallback`.
 */

type Notice = "none" | "load-error" | "decision-error" | "co-sign";

const NOTICE_KEY: Record<Exclude<Notice, "none">, string> = {
	"load-error": "associationApprovalLoadError",
	"decision-error": "associationApprovalDecisionError",
	"co-sign": "associationApprovalCoSignRequired",
};

const BANNER_KEY: Record<Exclude<ReassociationEvidenceView, "code-matched">, string> = {
	identity: "associationApprovalIdentityMatchedBanner",
	"code-unmatched": "associationApprovalCodeUnmatchedBanner",
	"code-unverifiable": "associationApprovalCodeUnverifiableBanner",
	"no-evidence": "associationApprovalNoEvidenceBanner",
};

export default function AssociationRequestApprovalScreen() {
	const { requestId, authorityId } = useRoute().params as { requestId: string; authorityId: string };
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { t } = useTranslation();
	const handleDeviceSigningError = useDeviceSigningErrorHandler();
	const { colors } = useTheme() as ExtendedTheme;
	const insets = useSafeAreaInsets();
	const { getEngine, createPeerStagingTransports } = useApp();
	const { scopes } = useCurrentOfficerScopes(authorityId);

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("associationApprovalScreenTitle") });
	}, [navigation, t]);

	const [review, setReview] = useState<ReassociationReview | undefined>(undefined);
	const [loadFailed, setLoadFailed] = useState(false);
	const [notice, setNotice] = useState<Notice>("none");
	const [refused, setRefused] = useState(false);
	const [showConfirm, setShowConfirm] = useState(false);
	const [selectedRegistrantId, setSelectedRegistrantId] = useState<string | undefined>(undefined);
	const [reloadNonce, setReloadNonce] = useState(0);
	const [submitting, setSubmitting] = useState(false);
	const submittingRef = useRef(false);

	const unmountedRef = useRef(false);
	const sessionPromiseRef = useRef<Promise<PeerReviewSession> | undefined>(undefined);
	// Incremented at the start of every load; a read that is no longer the latest never sets state,
	// so Approve (which reads `review.resolvedRegistrantId`) always acts on the request shown.
	const loadSeqRef = useRef(0);
	useEffect(() => {
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
			// Closes both transports exactly once (the session's close is idempotent and never throws).
			void sessionPromiseRef.current?.then(
				(session) => session.close(),
				() => undefined
			);
		};
	}, []);

	const canDecide = scopes?.includes("vrg") ?? false;

	useEffect(() => {
		async function load() {
			const seq = ++loadSeqRef.current;
			try {
				sessionPromiseRef.current ??= openPeerReviewSession({
					getEngine,
					createPeerStagingTransports,
					authorityId,
					sign: readOnlyReviewSign,
				});
				const session = await sessionPromiseRef.current;
				const engine = await getEngine<IReassociationEngine>("association");
				const next = await engine.getReassociationReview(
					requestId,
					session.association,
					session.opener,
					selectedRegistrantId ? { registrantId: selectedRegistrantId } : undefined
				);
				if (unmountedRef.current || seq !== loadSeqRef.current) return;
				if (next === undefined) {
					setLoadFailed(true);
					setNotice("load-error");
					return;
				}
				setReview(next);
				setLoadFailed(false);
				setNotice((n) => (n === "load-error" ? "none" : n));
			} catch {
				// Never the engine message: an unavailable session and a failed read share one key.
				// A rejected session must never be reused: Retry opens a fresh one. WR-R3-04: the session being
				// discarded may have opened (the later engine read failed), so close its two transports now;
				// nothing else references it, and the unmount cleanup only closes the current one.
				if (seq === loadSeqRef.current) {
					const stale = sessionPromiseRef.current;
					sessionPromiseRef.current = undefined;
					void stale?.then(
						(s) => s.close(),
						() => undefined
					);
				}
				if (unmountedRef.current || seq !== loadSeqRef.current) return;
				setLoadFailed(true);
				setNotice("load-error");
			}
		}
		void load();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [requestId, authorityId, selectedRegistrantId, reloadNonce, getEngine]);

	const evidenceView = review ? classifyReassociationEvidence(review) : undefined;
	const registrantId = review?.resolvedRegistrantId;
	const decidable = canDecide && !loadFailed && review?.status === "p" && !refused && !submitting;
	const approvable = evidenceView === "code-matched" || evidenceView === "identity";

	async function decide(kind: "approve" | "reject") {
		if (submittingRef.current) return;
		submittingRef.current = true;
		setSubmitting(true);
		setNotice("none");
		try {
			const session = await sessionPromiseRef.current!;
			const engine = await getEngine<IReassociationEngine>("association");
			const signer = await createDeviceSigner("Device User");
			if (kind === "approve") {
				if (!registrantId) throw new Error("AssociationRequestApprovalScreen: no registrant resolved");
				await engine.approveReassociation(requestId, { registrantId }, signer, session.association, session.opener);
			} else {
				await engine.rejectReassociation(requestId, signer, session.association);
			}
			navigation.goBack();
		} catch (err) {
			if (!unmountedRef.current) {
				if (isThresholdCoSignRefusal(err)) {
					// Never the engine message, and never "try again": retrying cannot succeed.
					setRefused(true);
					setNotice("co-sign");
					setShowConfirm(false);
				} else {
					const outcome = handleDeviceSigningError(err);
					if (!outcome.handled) {
						if ((err as { code?: unknown } | null)?.code === "not-pending") {
							setReloadNonce((n) => n + 1);
						}
						setNotice("decision-error");
					}
				}
			}
			// Re-thrown so LifecycleConfirmCard's submit latch returns to idle.
			throw err;
		} finally {
			submittingRef.current = false;
			if (!unmountedRef.current) setSubmitting(false);
		}
	}

	function handleApprove(): Promise<void> {
		return decide("approve");
	}

	async function handleReject(): Promise<void> {
		// Defence in depth: a press that bypasses `disabled` (a refused or undecidable state) is a no-op.
		if (!decidable) return;
		try {
			await decide("reject");
		} catch {
			// Reported through the notice; a reject has no confirm card to reset.
		}
	}

	const bannerKey = evidenceView && evidenceView !== "code-matched" ? BANNER_KEY[evidenceView] : undefined;
	const identityFields = review?.evidence.kind === "identity" ? review.evidence.fields : [];
	const showIdentityComparison = evidenceView === "identity" && registrantId !== undefined;

	return (
		<View testID="association-approval-screen" style={styles.content}>
			<ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
				{notice !== "none" ? (
					<View testID="association-approval-error">
						<InlineError message={t(NOTICE_KEY[notice])} />
					</View>
				) : null}
				{notice === "load-error" ? (
					<CustomButton
						testID="association-approval-retry"
						size="thin"
						title={t("loadRetryButton")}
						onPress={() => setReloadNonce((n) => n + 1)}
					/>
				) : null}

				{bannerKey ? (
					<View
						testID="association-approval-evidence-banner"
						style={[
							styles.cardSurface,
							{ backgroundColor: colors.card, borderLeftWidth: 4, borderLeftColor: colors.warning },
						]}
					>
						<View style={localStyles.row}>
							<FontAwesome6 name="triangle-exclamation" size={16} color={colors.warning} />
							<ThemedText type="default" style={localStyles.grow}>
								{t(bannerKey)}
							</ThemedText>
						</View>
					</View>
				) : null}

				{evidenceView === "identity" && review && review.candidates.length > 0 ? (
					<View testID="association-approval-candidates">
						<ThemedText type="defaultSemiBold">{t("associationApprovalCandidatesHeading")}</ThemedText>
						{review.candidates.map((candidate) => {
							const selected = registrantId === candidate.registrantId;
							return (
								<TouchableOpacity
									key={candidate.registrantId}
									testID={`association-approval-candidate-${candidate.registrantId}`}
									accessibilityRole="radio"
									accessibilityState={{ selected, disabled: !decidable }}
									disabled={!decidable}
									onPress={() => setSelectedRegistrantId(candidate.registrantId)}
									style={[
										styles.cardSurface,
										localStyles.candidateRow,
										{ backgroundColor: colors.card, borderColor: selected ? colors.accent : colors.border },
									]}
								>
									<FontAwesome6
										name={selected ? "circle-dot" : "circle"}
										size={18}
										color={selected ? colors.accent : colors.textSecondary}
									/>
									<View style={localStyles.grow}>
										<ThemedText type="default">
											{candidate.displayName ?? truncateId(candidate.registrantId)}
										</ThemedText>
										<ThemedText type="small" style={{ color: colors.textSecondary }}>
											{candidate.matchedFieldNames.join(", ")}
										</ThemedText>
									</View>
								</TouchableOpacity>
							);
						})}
					</View>
				) : null}

				{review ? (
					<View
						testID="association-approval-comparison"
						style={[styles.cardSurface, { backgroundColor: colors.card }]}
					>
						<View testID="association-approval-new-device" style={localStyles.block}>
							<ThemedText type="defaultSemiBold">{t("associationApprovalNewDeviceLabel")}</ThemedText>
							<ThemedText type="small" testID="association-approval-new-device-key">
								{truncateDeviceKey(review.newDeviceKey)}
							</ThemedText>
						</View>

						{evidenceView === "code-matched" ? (
							<View testID="association-approval-code-badge" style={localStyles.row}>
								<FontAwesome6 name="circle-check" size={16} color={colors.success} />
								<ThemedText type="small" style={[localStyles.grow, { color: colors.textSecondary }]}>
									{t("associationApprovalCodeMatchedBadge")}
								</ThemedText>
							</View>
						) : null}

						{review.existingDevices.length > 0 ? (
							<View testID="association-approval-existing-devices" style={localStyles.block}>
								<ThemedText type="defaultSemiBold">{t("associationApprovalExistingDeviceLabel")}</ThemedText>
								{review.existingDevices.map((device, index) => (
									<ThemedText
										key={`${device.deviceKey}-${index}`}
										type="small"
										testID={`association-approval-existing-device-${index}`}
									>
										{truncateDeviceKey(device.deviceKey)}
									</ThemedText>
								))}
							</View>
						) : null}

						{showIdentityComparison ? (
							<>
								<View testID="association-approval-entered-fields" style={localStyles.block}>
									<ThemedText type="defaultSemiBold">{t("associationApprovalEnteredFieldsHeading")}</ThemedText>
									{identityFields.map((field, index) => (
										<View key={`${field.name}-${index}`} style={localStyles.fieldRow}>
											<ThemedText type="small" style={{ color: colors.textSecondary }}>
												{field.name}
											</ThemedText>
											<ThemedText type="default">{field.value}</ThemedText>
										</View>
									))}
								</View>
								<View testID="association-approval-registrant-record" style={localStyles.block}>
									<ThemedText type="defaultSemiBold">
										{t("associationApprovalRegistrantRecordHeading")}
									</ThemedText>
									{(review.registrantRecord ?? []).map((field, index) => (
										<View key={`${field.name}-${index}`} style={localStyles.fieldRow}>
											<ThemedText type="small" style={{ color: colors.textSecondary }}>
												{field.name}
											</ThemedText>
											<ThemedText type="default">{field.value}</ThemedText>
										</View>
									))}
								</View>
							</>
						) : null}
					</View>
				) : null}

				{showConfirm && review ? (
					<LifecycleConfirmCard
						variant="ordinary"
						tone="destructive"
						title={t("associationApprovalApproveConfirmHeading")}
						body={t("associationApprovalApproveConfirmBody", {
							registrantName: reassociationRegistrantLabel(review),
						})}
						confirmLabel={t("associationApprovalApproveConfirmButton")}
						dismissLabel={t("associationApprovalKeepReviewingButton")}
						testIDPrefix="association-approval-confirm"
						onConfirm={handleApprove}
						onDismiss={() => setShowConfirm(false)}
					/>
				) : null}
			</ScrollView>

			{!showConfirm ? (
				<View testID="association-approval-footer">
					<Footer>
						<View testID="association-approval-approve" style={localStyles.footerSlot}>
							<CustomButton
								title={t("associationApprovalApproveButton")}
								icon="check"
								backgroundColor={colors.accent}
								size="thin"
								disabled={!decidable || !registrantId || !approvable}
								onPress={() => {
									if (decidable && registrantId && approvable) setShowConfirm(true);
								}}
							/>
						</View>
						<View testID="association-approval-reject" style={localStyles.footerSlot}>
							<CustomButton
								title={t("associationApprovalRejectButton")}
								icon="xmark"
								backgroundColor={colors.error}
								size="thin"
								disabled={!decidable}
								onPress={handleReject}
							/>
						</View>
					</Footer>
				</View>
			) : null}
		</View>
	);
}

const localStyles = StyleSheet.create({
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	grow: {
		flexShrink: 1,
	},
	block: {
		marginBottom: 12,
		gap: 4,
	},
	fieldRow: {
		marginBottom: 4,
	},
	// 44 pt minimum touch target, stretched, wraps (no fixed size).
	candidateRow: {
		flexDirection: "row",
		alignItems: "center",
		alignSelf: "stretch",
		minHeight: 44,
		gap: 8,
		borderWidth: 1,
	},
	// `alignSelf: "stretch"`, not `flex: 1` (a flex-basis of zero collapses the slot in a column Footer).
	footerSlot: {
		alignSelf: "stretch",
	},
});

const styles = { ...globalStyles, ...localStyles };
