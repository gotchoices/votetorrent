import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
	ExtendedTheme,
	useFocusEffect,
	useNavigation,
	useRoute,
	useTheme,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTranslation } from "react-i18next";
import { adminChangeEffectiveAt } from "@votetorrent/vote-core";
import type {
	Admin,
	AdminDetails,
	Authority,
	IAuthorityEngine,
	INetworkEngine,
	Officer,
	OfficerSelection,
	PendingAdminChange,
	Scope,
	ThresholdPolicy,
	User,
} from "@votetorrent/vote-core";
import { scopeLabel } from "../../utils/scopeLabel";
import { createDeviceSigner } from "../../engines/device-signer";
import { getOrCreateDeviceUser } from "../../engines/device-user";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import { useApp } from "../../providers/AppProvider";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { InfoCard } from "../../components/InfoCard";
import { InlineError } from "../../components/InlineError";
import { ThresholdPolicyRow } from "./components/ThresholdPolicyRow";
import { globalStyles } from "../../theme/styles";
import type { RootStackParamList } from "../../navigation/types";
import { errorCopy } from "../../utils/errorCopy";
import { AdminChangeConfirmCard } from "../../components/AdminChangeConfirmCard";
import { PendingAdminChangeCard } from "../../components/PendingAdminChangeCard";
import { adminChangeErrorKey, promotionWasRefused } from "../../utils/adminChangeErrors";
import { isAdminChangeConfirmStale } from "../../utils/displayUtils";
import { useAdminChangeCancel } from "./useAdminChangeCancel";

/**
 * Canonical Scope ordering — declaration order from
 * packages/vote-core/src/authority/models.ts:134–143. Used to render the 9
 * Threshold Policies rows in a stable order (D-03).
 *
 * Corrected 2026-08-25: the list now mirrors the schema's `view Scope`
 * (votetorrent.qsql:56-69) exactly — `'rnp'` removed (never in the view, so
 * every ThresholdPolicy this screen wrote for it was unrepresentable) and the
 * missing `'ik'` added. NOTE this array is not cosmetic: it also drives the
 * ThresholdPolicies payload sent to proposeAdmin below.
 */
const SCOPE_ORDER: Scope[] = [
	"rn",
	"rad",
	"vrg",
	"iad",
	"uai",
	"ceb",
	"mel",
	"cap",
	"ik",
];

/**
 * D-04/D-06: the effective time of an administration change, from the one shared vote-core helper
 * (one hour after now). Called on the first Propose tap and when a stale confirm card is
 * refreshed; never at sign time, so the signed string is the one the card showed.
 */
function freshEffectiveAt(): string {
	return adminChangeEffectiveAt(Date.now());
}

/** Per-scope thresholds seeded from a policy list, clamped to the roster size. */
function seedThresholds(policies: ThresholdPolicy[], officerCount: number): Record<string, number> {
	const max = Math.max(1, officerCount);
	const next: Record<string, number> = {};
	for (const scope of SCOPE_ORDER) {
		const raw = policies.find((p) => p.policy === scope)?.threshold ?? 1;
		next[scope] = Math.min(max, Math.max(1, raw));
	}
	return next;
}

export default function ProposedAdministrationScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation =
		useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { authorityId } = useRoute().params as { authorityId: string };
	const { getEngine } = useApp();

	const [proposedOfficers, setProposedOfficers] = useState<OfficerSelection[]>(
		[]
	);
	const [officerUsers, setOfficerUsers] = useState<Map<string, User>>(
		new Map()
	);
	const [thresholds, setThresholds] = useState<Record<string, number>>({});
	const [isLoading, setIsLoading] = useState(true);
	const [authority, setAuthority] = useState<Authority | null>(null);
	const [errorMessage, setErrorMessage] = useState<string>("");
	const [isProposing, setIsProposing] = useState(false);
	// C2: a change signed but not yet in effect. While present the screen is read-only.
	const [pending, setPending] = useState<PendingAdminChange | undefined>(undefined);
	const [currentOfficers, setCurrentOfficers] = useState<Officer[] | undefined>(undefined);
	// D-04: the effective time computed on the first Propose tap, shown on the confirm card and
	// signed as-is. Undefined while no confirm card is open.
	const [confirmAt, setConfirmAt] = useState<string | undefined>(undefined);
	const [confirmNotice, setConfirmNotice] = useState("");
	const proposingRef = useRef(false);
	const loadSeqRef = useRef(0);
	const handleDeviceSigningError = useDeviceSigningErrorHandler();

	// Header title (Phase 7 D-14 inherited pattern)
	useLayoutEffect(() => {
		navigation.setOptions({ title: t("proposedAdministration") });
	}, [navigation, t]);

	// Every change is built from the CURRENT administration (C2, RESEARCH F4): its officers and
	// its threshold policies. A stale or refused proposal is never read here, so it can no longer
	// seed the next change. While a change is pending, its roster and policies are shown instead,
	// read-only. Only the latest read may write.
	// UAT 62: re-read on every focus, not once per mount. EditOfficer persists an
	// added/edited administrator and goes back here — a mount-only load never showed it.
	const loadDetails = useCallback(async () => {
		const seq = ++loadSeqRef.current;
		const isLatest = () => seq === loadSeqRef.current;
		try {
			const networkEngine = await getEngine<INetworkEngine>("network");
			if (!networkEngine) return;
			const authorityEngine = await networkEngine.openAuthority(
				authorityId
			);
			if (!authorityEngine) return;
			const details: AdminDetails = await (
				authorityEngine as IAuthorityEngine
			).getAdminDetails();

			// Lift the full Authority object for navigation params
			// (gap-closure 08-07 Task 1 — see 08-UAT.md test 6).
			const authorityDetails = await (
				authorityEngine as IAuthorityEngine
			).getDetails();
			if (isLatest()) {
				setAuthority(authorityDetails.authority);
			}

			const admin: Admin = details.admin;
			let selections: OfficerSelection[];
			let policies: ThresholdPolicy[];
			if (details.pending) {
				selections = details.pending.officers;
				policies = details.pending.thresholdPolicies ?? [];
			} else {
				selections = admin.officers.map(
					(o: Officer): OfficerSelection => ({ existing: o })
				);
				policies = admin.thresholdPolicies ?? [];
			}

			// Resolve user names for any "existing" officers (Officer has no
			// `name` field — vote-core/authority/models.ts:90–102).
			const userMap = new Map<string, User>();
			await Promise.all(
				selections
					.filter((s) => s.existing)
					.map(async (s) => {
						try {
							const userEngine = await networkEngine.getUser(
								s.existing!.userId
							);
							const summary = await userEngine?.getSummary();
							if (summary) {
								userMap.set(s.existing!.userId, summary);
							}
						} catch (e) {
							console.warn(
								"Error loading user for officer:",
								e
							);
						}
					})
			);

			if (isLatest()) {
				setCurrentOfficers(admin.officers);
				setPending(details.pending);
				setProposedOfficers(selections);
				setOfficerUsers(userMap);
				setThresholds(seedThresholds(policies, selections.length));
			}
		} catch (e) {
			console.warn("Error loading proposed administration:", e);
			if (isLatest()) setErrorMessage(errorCopy(e, t, "read"));
		} finally {
			if (isLatest()) setIsLoading(false);
		}
	}, [getEngine, authorityId]);

	useFocusEffect(
		useCallback(() => {
			void loadDetails();
			return () => {
				loadSeqRef.current++;
			};
		}, [loadDetails])
	);

	const openAuthorityEngine = async (): Promise<IAuthorityEngine | undefined> => {
		const networkEngine = await getEngine<INetworkEngine>("network");
		return networkEngine
			? ((await networkEngine.openAuthority(authorityId)) as IAuthorityEngine)
			: undefined;
	};

	// D-05: Cancel change, shared with Authority Details. Success re-reads this screen.
	const cancelState = useAdminChangeCancel({
		pending,
		currentOfficers,
		openEngine: openAuthorityEngine,
		signerName: authority?.name ?? "Authority Administrator",
		onSettled: () => loadDetails(),
	});

	const officerCount = proposedOfficers.length;
	const sliderMax = useMemo(() => Math.max(1, officerCount), [officerCount]);
	// What is shown must be what is signed: while the confirm card is open (or a change is
	// pending) the roster and thresholds cannot be edited.
	const locked = pending !== undefined || confirmAt !== undefined;

	// D-04: the first Propose tap signs nothing. It fixes the effective time and shows it.
	const handlePropose = () => {
		if (confirmAt !== undefined || pending !== undefined) return;
		setErrorMessage("");
		setConfirmNotice("");
		setConfirmAt(freshEffectiveAt());
	};

	// ADM-02: Confirm calls proposeAdmin with a device-signer callback.
	// The private key lives in Android Keystore and never enters JS; the signer
	// callback only relays the digest to Keystore's `SHA256withECDSA` and returns
	// the signature (see `device-signer.ts`'s own header for the current contract).
	// D-03: the admin digest is computed ENGINE-SIDE inside proposeAdmin —
	//       the app no longer recomputes sha256(...) independently.
	const handleConfirm = async () => {
		if (proposingRef.current || !confirmAt) return;
		// D-01/D-04: a card left open more than five minutes is never signed. The engine accepts
		// any time on purpose, so the app must not sign one whose pending hour has run down.
		if (isAdminChangeConfirmStale(confirmAt, Date.now())) {
			setConfirmAt(freshEffectiveAt());
			setConfirmNotice(t("adminChangeConfirmTimeUpdated"));
			return;
		}
		proposingRef.current = true;
		setErrorMessage("");
		setIsProposing(true);
		try {
			const networkEngine = await getEngine<INetworkEngine>("network");
			if (!networkEngine) {
				setErrorMessage("Network not available");
				return;
			}
			// One engine instance for propose AND the promotion probe: openAuthority returns a
			// fresh engine per call, so a second instance would never see the outcome.
			const authorityEngine = await networkEngine.openAuthority(authorityId) as IAuthorityEngine;

			// Build ThresholdPolicies from on-screen slider state.
			const thresholdPoliciesArr: ThresholdPolicy[] = SCOPE_ORDER.map(
				(scope) => ({ policy: scope, threshold: thresholds[scope] ?? 1 })
			);

			// Resolve the device user id for the signers array (proposeAdmin requires
			// a non-empty signers list at guard time). The callback provides the full
			// Signature (signerUserId, signerKey, signature) once the engine computes
			// the canonical digest and passes the bytes to the callback.
			const deviceUser = await getOrCreateDeviceUser(
				authority?.name ?? "Authority Administrator"
			);

			// D-03: engine computes digest; sign callback signs those exact bytes.
			const sign = await createDeviceSigner(
				authority?.name ?? "Authority Administrator"
			);

			// Build the Proposal<AdminInit>: officers from on-screen state, the effective time
			// the confirm card showed, signers initialised with the device user's id.
			const proposal = {
				proposed: {
					officers: proposedOfficers,
					effectiveAt: confirmAt,
					thresholdPolicies: thresholdPoliciesArr,
				},
				signers: [deviceUser.id],
			};

			await authorityEngine.proposeAdmin(proposal, sign);
			if (promotionWasRefused(authorityEngine)) {
				setErrorMessage(t("adminChangeNotApplied"));
			}
			// Re-read: the screen now shows the pending change.
			await loadDetails();
		} catch (err) {
			const outcome = handleDeviceSigningError(err);
			if (outcome.handled) return;
			const key = adminChangeErrorKey(err);
			setErrorMessage(key ? t(key) : outcome.message ?? errorCopy(err, t, "write"));
		} finally {
			proposingRef.current = false;
			setIsProposing(false);
			setConfirmAt(undefined);
			setConfirmNotice("");
		}
	};

	const handleConfirmBack = () => {
		setConfirmAt(undefined);
		setConfirmNotice("");
	};

	const handleAddAdministrator = () => {
		if (!authority || locked) return;
		// Frame 12 (EditOfficer) is the canonical administrator editor — it captures
		// name + title + permissions, unlike the invitation send-form (name/title
		// only). Adding a new administrator opens it with no officerId.
		navigation.navigate("EditOfficer", { authority });
	};

	if (isLoading) {
		return (
			<View style={styles.centerContainer}>
				<ThemedText>{t("loading")}</ThemedText>
			</View>
		);
	}

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				{pending ? (
					<PendingAdminChangeCard
						pending={pending}
						canCancel={cancelState.canCancel}
						onCancel={cancelState.cancel}
						busy={cancelState.cancelling}
						error={cancelState.cancelError}
					/>
				) : cancelState.cancelled ? (
					<ThemedText testID="admin-change-cancelled">{t("adminChangeCancelled")}</ThemedText>
				) : null}

				{/* Section 1 — Officer cards */}
				<View style={styles.section}>
					<ThemedText
						type="defaultSemiBold"
						style={styles.sectionTitle}
					>
						{t("proposedAdministration")}
					</ThemedText>
					{proposedOfficers.map((selection, idx) => {
						const officer: Officer =
							selection.existing ??
							({
								userId: "",
								authorityId,
								title: selection.init?.title ?? "",
								scopes: selection.init?.scopes ?? [],
							} as Officer);
						const userName = selection.existing
							? officerUsers.get(selection.existing.userId)?.name ??
								selection.existing.userId
							: selection.init?.name ?? "";
						const key =
							selection.existing?.userId ??
							`init-${selection.init?.name ?? idx}`;
						// Figma frame 10: compact card (name · role · CID) + chevron → Administrator detail.
						return (
							<InfoCard
								key={key}
								title={userName}
								subtitle={officer.title}
								additionalInfo={[{ label: t("cid"), value: officer.userId }]}
								icon="chevron-right"
								onPress={() => {
									if (confirmAt !== undefined || !authority) return;
									navigation.navigate("OfficerDetails", { officer, userName, authority });
								}}
							/>
						);
					})}
					{locked ? null : (
						<View style={styles.addButtonContainer}>
							<ChipButton
								label={t("addAdministrator")}
								icon="circle-plus"
								onPress={handleAddAdministrator}
							/>
						</View>
					)}
				</View>

				{/* Section 2 — Threshold Policies (D-01/D-03) */}
				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t("thresholdPolicies")}
					</ThemedText>
					{SCOPE_ORDER.map((scope) =>
						locked ? (
							<View
								key={scope}
								testID={"pending-threshold-" + scope}
								style={styles.readOnlyRow}
							>
								<ThemedText>{scopeLabel(scope, t)}</ThemedText>
								<ThemedText type="defaultSemiBold">{thresholds[scope] ?? 1}</ThemedText>
							</View>
						) : (
							<ThresholdPolicyRow
								key={scope}
								scope={scope}
								label={
									scopeLabel(scope, t)
								}
								value={thresholds[scope] ?? 1}
								min={1}
								max={sliderMax}
								onChange={(v) =>
									setThresholds((prev) => ({
										...prev,
										[scope]: v,
									}))
								}
							/>
						)
					)}
				</View>
			</ScrollView>

			{/* ADM-02: Propose opens the confirm card; Confirm signs with the device signer */}
			<InlineError message={errorMessage} />
			{pending ? null : (
				<Footer>
					{confirmAt ? (
						<AdminChangeConfirmCard
							effectiveAt={confirmAt}
							onConfirm={handleConfirm}
							onBack={handleConfirmBack}
							busy={isProposing}
							notice={confirmNotice}
						/>
					) : (
						<CustomButton
							title={t("propose")}
							icon="floppy-disk"
							disabled={isProposing}
							backgroundColor={colors.success}
							forceDarkText={true}
							onPress={handlePropose}
						/>
					)}
				</Footer>
			)}
		</View>
	);
}

const localStyles = StyleSheet.create({
	addButtonContainer: {
		flexDirection: "row",
		justifyContent: "flex-end",
		marginTop: 8,
	},
	readOnlyRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		paddingVertical: 8,
	},
	centerContainer: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
	},
});

const styles = { ...globalStyles, ...localStyles };
