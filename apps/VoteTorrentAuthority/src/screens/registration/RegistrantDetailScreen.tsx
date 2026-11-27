import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { scopeLabel } from "../../utils/scopeLabel";
import type {
	DisclosedSelective,
	DisclosureAudience,
	IElectionsEngine,
	IRegistrationEngine,
	Registrant,
	RegistrantPrivate,
	RegistrantPublic,
	RegistrantSelective,
} from "@votetorrent/vote-core";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { DateField } from "../../components/DateField";
import { InlineError } from "../../components/InlineError";
import { KeyboardAvoidingScreen } from "../../components/KeyboardAvoidingScreen";
import { globalStyles } from "../../theme/styles";
import { useApp } from "../../providers/AppProvider";
import { createDeviceSigner } from "../../engines/device-signer";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import type { SignCallback } from "../../engines/device-signer";
import { getOrCreateDeviceUser } from "../../engines/device-user";
import { useCurrentOfficerScopes } from "../../hooks/useCurrentOfficerScopes";
import {
	REGISTRANT_STATUS_META,
	formatExpirationDate,
	registrantDisplayName,
	truncateId,
} from "./registrant-display";
import {
	LIFECYCLE_ACTIONS,
	availableLifecycleActions,
	flattenPrivateDetails,
	toPublicTierRows,
} from "./registrant-detail-model";
import type { LifecycleActionId } from "./registrant-detail-model";
import {
	privateTierReadState,
	PRIVATE_TIER_READ_STATE_COPY,
	selectiveTierReadState,
	SELECTIVE_TIER_READ_STATE_COPY,
} from "./registrant-detail-model";
import { useAccessTrailVisit } from "./useAccessTrailVisit";
import type { AccessTrailRecorder } from "./access-trail-visit";
import { pillStyles, tintPill } from "./components/pill";
import { PrivateFieldRow } from "./components/PrivateFieldRow";
import { SelectiveAudiencePreview } from "./components/SelectiveAudiencePreview";
import { LifecycleConfirmCard } from "./components/LifecycleConfirmCard";
import { AssociationsSection } from "./components/AssociationsSection";
import { AttestationChallengesSection } from "./components/AttestationChallengesSection";
import { AccessHistorySection } from "./components/AccessHistorySection";
import type { RootStackParamList } from "../../navigation/types";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { errorCopy } from "../../utils/errorCopy";

/**
 * RegistrantDetailScreen — the phase's integration seam, and the only
 * screen in the product that ever holds a decrypted `RegistrantPrivate`
 * value (an SSN, a date of birth, a phone number). No private value may
 * reach `console.*`, an `errorMessage` string, an i18n interpolation, or a
 * crash payload — the never-log rule this file structurally enforces.
 *
 * The D-13 private-tier gate and the D-13 scope banner are UI legibility
 * affordances, NOT enforcement boundaries (T-46-03 precedent, T-47-04): the
 * schema's `'vrg'` `AdminSignature` CHECK is the real and only control. The
 * access trail this screen feeds (D-14) records app-mediated reveals only,
 * exists for accountability, deterrence and regulatory posture, and is
 * not a security control.
 *
 * Composes, in `47-UI-SPEC.md:644-663`'s exact order: InlineError -> the
 * 'vrg' scope-gate banner -> the registrant header (status pill,
 * expiration, signor key, lifecycle actions) -> Public tier -> Selective
 * tier + SelectiveAudiencePreview -> Private tier -> Associations (47-15)
 * -> Attestation Challenges (47-16) -> Access History (47-14, last).
 */

// D-08: this screen previously carried a screen-local loosely-typed
// navigation widening (47-11's idiom) because RootStackParamList did not yet
// carry `RegistrantDetail` or `AttestationProvisioningStatus` keys. 47-21
// added the five Phase 47 routes (navigation/types.ts) and registered their
// Stack.Screens (navigation/index.tsx), so this screen now navigates through
// `NativeStackNavigationProp<RootStackParamList>`, which checks both the
// route name AND the param shape — restoring the checking the widening had
// disabled. Honest residual: the app's shared `NavigationProp` alias
// (navigation/types.ts) still types params as `any`; tightening it is a
// repo-wide refactor deliberately out of scope here.

// A stable no-op for the (non-optional) CustomButton.onPress prop when a
// gate is unmet — belt-and-suspenders alongside `disabled` so no callback
// can fire even from a direct programmatic invocation of the handler, not
// just from a blocked touch event.
const NOOP = () => {};

// D-12: the RegistrantDetail route carries only `{ registrantId, authorityId }`
// (47-UI-SPEC.md:162-166) and IRegistrationEngine exposes no reverse
// registrant->elections read, so the election context `getDisclosedSelective`
// needs has to be discovered by scanning elections. Capped so a registrant
// enrolled in many elections cannot turn one audience press into an unbounded
// scan; this is a policy-validation aid, not a disclosure record, so a
// bounded best-effort answer is an accepted, documented limit.
const PREVIEW_ELECTION_SCAN_LIMIT = 20;

export default function RegistrantDetailScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const insets = useSafeAreaInsets();
	const { getEngine } = useApp();
	const { registrantId, authorityId } = useRoute().params as {
		registrantId: string;
		authorityId: string;
	};
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const handleDeviceSigningError = useDeviceSigningErrorHandler();

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("registrantDetailScreenTitle") });
	}, [navigation, t]);

	const { scopes, loading: scopesLoading } = useCurrentOfficerScopes(authorityId);
	const canWrite = !scopesLoading && scopes?.includes("vrg") === true;
	// D-13: private-tier reads are gated on the SAME 'vrg' scope as the
	// writes — the accepted consequence (an officer who can change a
	// registrant's status can also read their SSN) is explicitly recorded
	// there; a dedicated read-only private-tier scope was considered and
	// rejected as expansion and is a Deferred Idea. One alias, never a
	// second derivation, so the tier and the writes can never drift.
	const canViewPrivate = canWrite;

	const [core, setCore] = useState<Registrant | undefined>(undefined);
	const [publicTier, setPublicTier] = useState<RegistrantPublic | undefined>(undefined);
	const [selectiveTier, setSelectiveTier] = useState<RegistrantSelective | undefined>(undefined);
	const [privateTier, setPrivateTier] = useState<RegistrantPrivate | undefined>(undefined);
	const [loading, setLoading] = useState(true);
	const [errorMessage, setErrorMessage] = useState("");
	const [pendingAction, setPendingAction] = useState<LifecycleActionId | undefined>(undefined);
	const [renewalExpiration, setRenewalExpiration] = useState("");
	const [selectedAudience, setSelectedAudience] = useState<DisclosureAudience | undefined>(
		undefined
	);
	const [disclosure, setDisclosure] = useState<DisclosedSelective | null | undefined>(undefined);
	const selectiveReadState = selectiveTierReadState(selectiveTier?.detailsAccess);
	const selectiveReadStateRef = useRef(selectiveReadState);
	selectiveReadStateRef.current = selectiveReadState;

	// CR-02 guard against a stale setState after unmount, copied from
	// RegistrationPolicyScreen.tsx:102-111. Reset on entry so a cleanup that
	// runs while the component stays mounted (StrictMode double-invoke, Fast
	// Refresh, remount-in-place) does not permanently latch every setState off.
	const unmountedRef = useRef(false);
	useEffect(() => {
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
		};
	}, []);

	const loadRegistrant = useCallback(async () => {
		setLoading(true);
		setErrorMessage("");
		try {
			const engine = await getEngine<IRegistrationEngine>("registration");
			// This is the D-13 gate's structural half: it must NOT read the
			// private tier here — that read is issued separately below, ONLY
			// when canViewPrivate is true, so an ungated officer's device never
			// issues it at all.
			const [fetchedCore, fetchedPublic, fetchedSelective] = await Promise.all([
				engine.getRegistrant(registrantId),
				engine.getRegistrantPublic(registrantId),
				engine.getRegistrantSelective(registrantId),
			]);
			if (!unmountedRef.current) {
				setCore(fetchedCore);
				setPublicTier(fetchedPublic);
				setSelectiveTier(fetchedSelective);
			}
		} catch (err) {
			// The caught message is engine-authored (a `rethrow`d
			// "RegistrationEngine.<method>: ..." string) — no field name, no
			// field value and no viewer id is ever interpolated into it.
			if (!unmountedRef.current) setErrorMessage(errorCopy(err, t, "read", { log: false }));
		} finally {
			if (!unmountedRef.current) setLoading(false);
		}
	}, [getEngine, registrantId]);

	useEffect(() => {
		loadRegistrant();
	}, [loadRegistrant]);

	// 47-REVIEW WR-02: checking canViewPrivate only at ENTRY is not enough.
	// The gate can close while the read is in flight — gate open ->
	// loadPrivateTier awaits the engine -> scopes are revised away -> the
	// effect below clears privateTier -> the still-pending promise resolves
	// and writes the decrypted tier straight back into state with the gate
	// closed. The render gate hides it, so the failure is invisible; only a
	// snapshot or a crash payload would show it, which is precisely what the
	// structural gate exists to prevent. This generation counter is bumped by
	// the load itself and by the gate closing, so a resolution that is no
	// longer the current load cannot write.
	const privateLoadGenerationRef = useRef(0);

	const loadPrivateTier = useCallback(async () => {
		if (!canViewPrivate) return;
		const generation = ++privateLoadGenerationRef.current;
		try {
			const engine = await getEngine<IRegistrationEngine>("registration");
			const fetched = await engine.getRegistrantPrivate(registrantId);
			// Discard if the gate closed (or another load started) while this
			// was in flight — see privateLoadGenerationRef above.
			if (!unmountedRef.current && generation === privateLoadGenerationRef.current) {
				setPrivateTier(fetched);
			}
		} catch (err) {
			// Set from the engine message only — never from the tier data itself.
			if (!unmountedRef.current) setErrorMessage(errorCopy(err, t, "read", { log: false }));
		}
	}, [canViewPrivate, getEngine, registrantId]);

	useEffect(() => {
		// 47-REVIEW IN-07: canViewPrivate is NOT constant for this screen's
		// lifetime — useCurrentOfficerScopes resolves asynchronously and
		// re-resolves, so the officer's scopes can be revised while the screen
		// stays open. On a true -> false transition the already-fetched tier
		// must be dropped from state, not merely hidden at render time,
		// otherwise the structural claim below is false in exactly the case it
		// matters most: a just-revoked officer.
		if (!canViewPrivate) {
			// Invalidates any read still in flight (WR-02) as well as dropping
			// what already arrived.
			privateLoadGenerationRef.current++;
			setPrivateTier(undefined);
			return;
		}
		loadPrivateTier();
		// This effect is the STRUCTURAL half of the D-13 divergence: an
		// ungated officer's device never issues this query, so there is no
		// decrypted private tier sitting in this component's state to leak
		// into a snapshot, a crash payload, or a future careless render.
		// Hiding it at render time alone would not achieve that.
	}, [canViewPrivate, loadPrivateTier]);

	// D-14 visit wiring. The device officer's own User.Id is the viewer this
	// screen's reveals are attributed to.
	const deviceUserIdRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		(async () => {
			try {
				const user = await getOrCreateDeviceUser("Device User");
				if (!unmountedRef.current) deviceUserIdRef.current = user.id;
			} catch {
				// Swallowed — the recorder below resolves without writing when
				// deviceUserIdRef.current stays undefined. No console call.
			}
		})();
	}, []);

	const recordVisit = useCallback<AccessTrailRecorder>(
		async (fieldNames) => {
			const viewerUserId = deviceUserIdRef.current;
			// 47-13's explicitly-assigned obligation on this plan: if the
			// officer's User.Id is unresolved at flush time, the recorder
			// resolves WITHOUT writing — the same accepted loss as a dropped
			// flush. No retry and no persistence is attempted here.
			if (viewerUserId === undefined) return;
			const engine = await getEngine<IRegistrationEngine>("registration");
			// D-02 made this table unsigned — no signature parameter.
			await engine.recordRegistrantAccessEvent(registrantId, viewerUserId, fieldNames);
			// No try/catch here: 47-13's flush() already swallows a rejection
			// from this call, and a second swallow here would be a place a
			// future edit could put a log line.
		},
		[getEngine, registrantId]
	);

	const visit = useAccessTrailVisit(recordVisit);
	// The hook owns both flush triggers (unmount and the AppState
	// active->background transition). A background flush followed by an
	// unmount flush produces two rows with DISJOINT names, never a
	// duplicate — the delta contract 47-13 froze.

	// D-12 preview wiring. `undefined` = not yet resolved; `null` = resolved
	// to "no election found".
	const previewElectionIdRef = useRef<string | null | undefined>(undefined);

	/**
	 * Resolves the election context `getDisclosedSelective` needs, memoised
	 * through `previewElectionIdRef`. Two documented limits: `getElections()`
	 * filters to `E.Date >= :now` (Phase 42), so a registrant enrolled only in
	 * a past election resolves to `undefined` here; and the first matching
	 * election wins when a registrant is enrolled in several — both are
	 * accepted limits of a policy-validation AID, not a disclosure record.
	 */
	async function resolvePreviewElectionId(): Promise<string | undefined> {
		if (previewElectionIdRef.current !== undefined) {
			return previewElectionIdRef.current === null ? undefined : previewElectionIdRef.current;
		}
		const electionsEngine = await getEngine<IElectionsEngine>("elections");
		const registrationEngine = await getEngine<IRegistrationEngine>("registration");
		const summaries = await electionsEngine.getElections();
		for (const summary of summaries.slice(0, PREVIEW_ELECTION_SCAN_LIMIT)) {
			const roster = await registrationEngine.getElectionRegistrants(summary.id);
			if (roster.some((row) => row.registrantId === registrantId)) {
				previewElectionIdRef.current = summary.id;
				return summary.id;
			}
		}
		previewElectionIdRef.current = null;
		return undefined;
	}

	const handleSelectAudience = useCallback(
		async (audience: DisclosureAudience) => {
			// D-52: defence in depth. The audience selector is not rendered for an unread
			// selective tier, and no disclosure is ever requested for one.
			if (selectiveReadStateRef.current !== "readable") return;
			setSelectedAudience(audience);
			// The in-flight state (47-12): raw rows, no annotations, while a
			// fetch (or the election-context resolution ahead of it) is pending.
			setDisclosure(undefined);
			try {
				const electionId = await resolvePreviewElectionId();
				if (!unmountedRef.current) {
					if (electionId === undefined) {
						// `null` is 47-12's "no selective row / no policy" state and
						// renders every row Not-disclosed — the truthful answer: a
						// registrant enrolled in no upcoming election has no election
						// disclosing anything to any audience. Deliberately NOT an
						// error state, and no copy key exists to describe one (47-02
						// pinned the phase at 117 keys).
						setDisclosure(null);
					} else {
						const engine = await getEngine<IRegistrationEngine>("registration");
						const result = await engine.getDisclosedSelective(electionId, registrantId, audience);
						// D-52: a disclosure this device could not open carries no leaves; show no
						// annotation rather than a false "not disclosed" on every row, and never
						// render its arrays.
						const unread = result != null && selectiveTierReadState(result.access) !== "readable";
						if (!unmountedRef.current) setDisclosure(unread ? undefined : (result ?? null));
					}
				}
			} catch (err) {
				// Leave disclosure at undefined — NEVER annotate off a failed
				// fetch, since annotating every row Not-disclosed after a failure
				// would be a false claim about the disclosure policy.
				if (!unmountedRef.current)
					setErrorMessage(errorCopy(err, t, "read", { log: false }));
			}
		},
		[getEngine, registrantId]
	);

	// D-10 lifecycle wiring.
	async function runLifecycleWrite(action: LifecycleActionId): Promise<void> {
		// device-signer.ts is consumed, never altered — WR-10's prehash
		// contract lives there and this screen must not touch it.
		const sign: SignCallback = await createDeviceSigner("Device User");
		const engine = await getEngine<IRegistrationEngine>("registration");
		if (action === "renew") {
			await engine.changeExpiration(registrantId, renewalExpiration, sign);
		} else {
			await engine.changeStatus(registrantId, LIFECYCLE_ACTIONS[action].targetStatus!, sign);
		}
	}

	async function handleConfirmLifecycle(action: LifecycleActionId): Promise<void> {
		try {
			await runLifecycleWrite(action);
			if (!unmountedRef.current) {
				setErrorMessage("");
				setPendingAction(undefined);
				setRenewalExpiration("");
			}
			await loadRegistrant();
		} catch (err) {
			const outcome = handleDeviceSigningError(err);
			if (!unmountedRef.current && !outcome.handled) {
				setErrorMessage(outcome.message ?? errorCopy(err, t, "write", { log: false }));
			}
			// Re-thrown so 47-10's LifecycleConfirmCard sees a REJECTED
			// onConfirm and returns to idle (its latch contract) — this is what
			// lets a stranded officer retry a failed signed write. Unmounting
			// the card on success (above) is what prevents a second one.
			// Neither behaviour is optional.
			throw err;
		}
	}

	function handleDismissLifecycle() {
		// A dismissed confirmation performs ZERO engine work.
		setPendingAction(undefined);
		if (pendingAction === "renew") setRenewalExpiration("");
	}

	const handleOpenProvisioningStatus = useCallback(() => {
		// 47-21 registers the AttestationProvisioningStatus route (undefined
		// params) — navigate() is now checked against the real route name.
		navigation.navigate("AttestationProvisioningStatus");
	}, [navigation]);

	const statusMeta = core ? REGISTRANT_STATUS_META[core.status] : undefined;
	const displayName = registrantDisplayName({
		registrantId,
		lastName: publicTier?.lastName,
		firstName: publicTier?.firstName,
	});

	function renderLifecycleCard() {
		if (!core || pendingAction === undefined) return null;
		const meta = LIFECYCLE_ACTIONS[pendingAction];
		const testIDPrefix = "registrant-detail-confirm-" + pendingAction;

		// Every branch below derives `variant` (and, where relevant, `tone`)
		// from `LIFECYCLE_ACTIONS[pendingAction]` rather than hardcoding a
		// literal — the model's table is the single source of truth for which
		// confirmation gate an action gets, so a change there (e.g. D-10's
		// suspend/revoke grouping) is observable here without a second edit.

		if (pendingAction === "renew") {
			const hasValidExpiration =
				renewalExpiration.length > 0 && !isNaN(new Date(renewalExpiration).getTime());
			if (!hasValidExpiration) return null;
			return (
				<LifecycleConfirmCard
					key={pendingAction}
					variant={meta.variant}
					tone={meta.tone}
					testIDPrefix={testIDPrefix}
					title={t(meta.titleKey)}
					body={t(meta.bodyKey, {
						name: displayName,
						newExpiration: formatExpirationDate(renewalExpiration),
					})}
					confirmLabel={t(meta.confirmLabelKey)}
					dismissLabel={t(meta.dismissLabelKey)}
					matchText={displayName}
					typedPlaceholder={t("registrantLifecycleTypedConfirmPlaceholder", { name: displayName })}
					onConfirm={() => handleConfirmLifecycle("renew")}
					onDismiss={handleDismissLifecycle}
				/>
			);
		}

		if (pendingAction === "reinstate") {
			return (
				<LifecycleConfirmCard
					key={pendingAction}
					variant={meta.variant}
					tone={meta.tone}
					testIDPrefix={testIDPrefix}
					title={t(meta.titleKey)}
					body={t(meta.bodyKey, {
						name: displayName,
						oldStatus: statusMeta ? t(statusMeta.labelKey) : "",
					})}
					confirmLabel={t(meta.confirmLabelKey)}
					dismissLabel={t(meta.dismissLabelKey)}
					matchText={displayName}
					typedPlaceholder={t("registrantLifecycleTypedConfirmPlaceholder", { name: displayName })}
					onConfirm={() => handleConfirmLifecycle("reinstate")}
					onDismiss={handleDismissLifecycle}
				/>
			);
		}

		// suspend / revoke — LIFECYCLE_ACTIONS binds both to variant: "typed".
		//
		// `key={pendingAction}` is load-bearing, not cosmetic. Both typed
		// actions render through THIS element at THIS position, so without a
		// key React reconciles suspend and revoke as the same component
		// instance and `LifecycleConfirmCard`'s internal `typedValue` survives
		// the action change. An officer who typed the registrant's name to arm
		// SUSPEND, then dismissed it, would land on REVOKE — permanent, no
		// undo — already armed, having typed nothing for that action. The
		// differing `testIDPrefix` changes the rendered testID but does NOT
		// force a remount. Found by on-device UAT (47-UAT.md test 12); the
		// card's own four fail-closed points were all intact, because every
		// one of them is scoped to a single instance.
		return (
			<LifecycleConfirmCard
				key={pendingAction}
				variant={meta.variant}
				tone={meta.tone}
				testIDPrefix={testIDPrefix}
				title={t(meta.titleKey, { name: displayName })}
				body={t(meta.bodyKey, { name: displayName })}
				confirmLabel={t(meta.confirmLabelKey)}
				dismissLabel={t(meta.dismissLabelKey)}
				matchText={displayName}
				typedPlaceholder={t("registrantLifecycleTypedConfirmPlaceholder", { name: displayName })}
				onConfirm={() => handleConfirmLifecycle(pendingAction)}
				onDismiss={handleDismissLifecycle}
			/>
		);
	}

	const publicRows = toPublicTierRows(publicTier);
	const privateReadState = privateTierReadState(privateTier?.detailsAccess);
	// Defence in depth: an unread record never yields a row, whatever the engine returned.
	const privateRows = flattenPrivateDetails(
		privateReadState === "readable" ? privateTier?.privateDetails : undefined
	);

	// The typed LifecycleConfirmCard holds a text input inside the ScrollView. Under forced
	// edge-to-edge (targetSdk 35) adjustResize is inert, so the shell pads by the IME height and
	// the ScrollView viewport ends at the top of the keyboard (same cause as the approval
	// screen's reject card, UAT 62 gap 3).
	return (
		<KeyboardAvoidingScreen testID="registrant-detail-screen">
		<ScrollView
			style={styles.container}
			contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
		>
			<View style={styles.section} testID="registrant-detail-error">
				<InlineError message={errorMessage} />
			</View>

			{/* D-13 default scope-gate pattern — two DISTINCT branches, never
			    collapsed: 'scopes === undefined' (no matching Officer row) is a
			    different fact from a real scopes array missing 'vrg'. Never
			    rendered while scopesLoading, so the not-an-officer copy never
			    flashes during load. */}
			{!scopesLoading &&
				!canWrite &&
				(scopes === undefined ? (
					<View testID="registrant-detail-scope-no-officer-banner" style={localStyles.banner}>
						<FontAwesome6 name="lock" size={14} color={colors.textSecondary} />
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrantScopeReadOnlyNoOfficerBanner")}
						</ThemedText>
					</View>
				) : (
					<View testID="registrant-detail-scope-banner" style={localStyles.banner}>
						<FontAwesome6 name="lock" size={14} color={colors.textSecondary} />
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrantScopeReadOnlyBanner", { scope: scopeLabel("vrg", t) })}
						</ThemedText>
					</View>
				))}

			{loading && core === undefined ? (
				<View testID="registrant-detail-loading">
					<ThemedText type="small" style={{ color: colors.textSecondary }}>
						{t("loading")}
					</ThemedText>
				</View>
			) : (
				core && (
					<View style={styles.section} testID="registrant-detail-header">
						<ThemedText type="title">{displayName}</ThemedText>
						{statusMeta ? (
							<>
								<View
									testID="registrant-detail-status-pill"
									style={[
										pillStyles.pill,
										{ backgroundColor: tintPill(colors[statusMeta.colorKey]) },
									]}
								>
									<ThemedText type="smallBold" style={{ color: colors[statusMeta.colorKey] }}>
										{t(statusMeta.labelKey)}
									</ThemedText>
								</View>
								<ThemedText type="small" testID="registrant-detail-expiration">
									{t("registrantDetailExpirationLabel") +
										": " +
										formatExpirationDate(String(core.expiration))}
								</ThemedText>
								<ThemedText type="small" testID="registrant-detail-signor-key">
									{t("registrantDetailSignorKeyLabel") + ": " + truncateId(core.signorKey)}
								</ThemedText>
								<View style={localStyles.lifecycleButtonRow}>
									{availableLifecycleActions(core.status).map((id) => {
										const meta = LIFECYCLE_ACTIONS[id];
										return (
											<View key={id} testID={"registrant-detail-lifecycle-" + id}>
												<CustomButton
													size="thin"
													title={t(meta.buttonLabelKey)}
													backgroundColor={
														meta.tone === "destructive" ? colors.error : colors.accent
													}
													disabled={!canWrite}
													onPress={canWrite ? () => setPendingAction(id) : NOOP}
												/>
											</View>
										);
									})}
								</View>
								{pendingAction === "renew" && (
									<View testID="registrant-detail-renew-picker">
										<DateField
											title={t("registrantDetailExpirationLabel")}
											value={renewalExpiration}
											onChange={setRenewalExpiration}
										/>
										<View testID="registrant-detail-renew-dismiss">
											<CustomButton
												size="thin"
												title={t("registrantLifecycleKeepCurrentExpiration")}
												backgroundColor={colors.accent}
												onPress={() => {
													setPendingAction(undefined);
													setRenewalExpiration("");
												}}
											/>
										</View>
									</View>
								)}
								{renderLifecycleCard()}
							</>
						) : (
							// An unknown status code from a future schema revision: never
							// crash, and never offer a transition off a status this build
							// does not understand.
							<ThemedText type="small" style={{ color: colors.textSecondary }}>
								{String(core.status)}
							</ThemedText>
						)}
					</View>
				)
			)}

			{/* Public tier — always visible, always unmasked, never gated. This
			    section is 4th precisely so the screen stays useful to an officer
			    whose private tier is hidden (47-UI-SPEC.md:639). */}
			<View style={styles.section} testID="registrant-detail-public-tier">
				<ThemedText type="title">{t("registrantDetailPublicTierTitle")}</ThemedText>
				{publicRows.length === 0 ? (
					<View testID="registrant-detail-public-empty">
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrantDetailNoPublicTier")}
						</ThemedText>
					</View>
				) : (
					publicRows.map((row) => (
						<View
							key={row.name}
							testID={"registrant-detail-public-row-" + row.name}
							style={localStyles.propertyRow}
						>
							<ThemedText type="defaultSemiBold" style={localStyles.propertyName}>
								{row.name + ": "}
							</ThemedText>
							<ThemedText type="default" style={localStyles.propertyValue}>
								{row.value}
							</ThemedText>
						</View>
					))
				)}
			</View>

			{/* Selective tier + D-12 audience preview. */}
			<View style={styles.section} testID="registrant-detail-selective-tier">
				<ThemedText type="title">{t("registrantDetailSelectiveTierTitle")}</ThemedText>
				{selectiveReadState !== "readable" ? (
					// D-52: sealed selective details this device cannot open are shown as unread,
					// never as an empty preview (which would read as "no selective details"). No
					// audience selector is offered. Nothing from the record is rendered.
					<>
						<View testID="registrant-detail-selective-unread" style={localStyles.sealedNotice}>
							<FontAwesome6 name="lock" size={14} color={colors.textSecondary} />
							<ThemedText
								type="small"
								testID="registrant-detail-selective-unread-text"
								style={[{ color: colors.textSecondary }, localStyles.sealedNoticeText]}
							>
								{t(SELECTIVE_TIER_READ_STATE_COPY[selectiveReadState])}
							</ThemedText>
						</View>
						{selectiveReadState === "not-a-recipient" ? (
							<ThemedText type="small" testID="registrant-detail-selective-late-officer" style={{ color: colors.textSecondary }}>
								{t("sealedBeforeOfficerExplanation")}
							</ThemedText>
						) : null}
					</>
				) : (
					<SelectiveAudiencePreview
						leaves={selectiveTier?.selectiveDetails ?? []}
						selectedAudience={selectedAudience}
						disclosure={disclosure}
						onSelectAudience={handleSelectAudience}
					/>
				)}
			</View>

			{/* Private tier — the D-13 divergence. */}
			<View style={styles.section} testID="registrant-detail-private-tier">
				<ThemedText type="title">{t("registrantDetailPrivateTierTitle")}</ThemedText>
				{!canViewPrivate ? (
					// Phase 46's gate hides only WRITE controls because election
					// policy has no confidentiality concern; here the underlying
					// data is SSN/DOB/phone, so an ungated officer must not even
					// learn which private fields exist. This is a deliberate,
					// documented DIVERGENCE for this ONE tier — not an
					// inconsistency to "fix" toward the visible-but-disabled
					// default — and it is a UI legibility posture, not an
					// enforcement boundary.
					<View testID="registrant-detail-private-gate">
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrantDetailPrivateGateHeading", { scope: scopeLabel("vrg", t) })}
						</ThemedText>
					</View>
				) : privateReadState !== "readable" ? (
					// D-49: a sealed tier this device cannot open is shown as unreadable, never as
					// "No private details recorded", which would be a false claim.
					// D-51: officers added after a registrant was written are not recipients, and no
					// re-wrap exists.
					// Not hidden: the section, its title, the lifecycle controls and Access History
					// all stay. Nothing from the record (values, ciphertext, failure detail) is
					// rendered or put in `errorMessage`.
					<>
						<View testID="registrant-detail-private-sealed" style={localStyles.sealedNotice}>
							<FontAwesome6 name="lock" size={14} color={colors.textSecondary} />
							<View testID={"registrant-detail-private-sealed-" + privateReadState} />
							<ThemedText
								type="small"
								testID="registrant-detail-private-sealed-text"
								style={[{ color: colors.textSecondary }, localStyles.sealedNoticeText]}
							>
								{t(PRIVATE_TIER_READ_STATE_COPY[privateReadState])}
							</ThemedText>
						</View>
						{privateReadState === "not-a-recipient" ? (
							<ThemedText type="small" testID="registrant-detail-private-late-officer" style={{ color: colors.textSecondary }}>
								{t("sealedBeforeOfficerExplanation")}
							</ThemedText>
						) : null}
					</>
				) : privateRows.length === 0 ? (
					<View testID="registrant-detail-private-empty">
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrantDetailNoPrivateTier")}
						</ThemedText>
					</View>
				) : (
					privateRows.map((row) => (
						<PrivateFieldRow
							key={row.name}
							name={row.name}
							value={row.value}
							onReveal={visit.noteRevealed}
							testIDPrefix="registrant-detail-private"
						/>
					))
				)}
			</View>

			<AssociationsSection
				registrantId={registrantId}
				authorityId={authorityId}
				registrantDisplayName={displayName}
			/>

			<AttestationChallengesSection
				registrantId={registrantId}
				canWrite={canWrite}
				onOpenProvisioningStatus={handleOpenProvisioningStatus}
			/>

			{/* Last, and default-collapsed by its own contract (the one section
			    on this screen that does not mirror Phase 46's default-open
			    posture). canView is the SAME derivation as the private tier
			    because the trail's rows are private field NAMES. */}
			<AccessHistorySection registrantId={registrantId} canView={canViewPrivate} />
		</ScrollView>
		</KeyboardAvoidingScreen>
	);
}

const localStyles = StyleSheet.create({
	propertyRow: {
		flexDirection: "row",
		alignItems: "flex-start",
		width: "100%",
	},
	propertyName: {
		marginRight: 4,
	},
	propertyValue: {
		flex: 1,
	},
	banner: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginBottom: 12,
	},
	sealedNotice: {
		flexDirection: "row",
		alignItems: "flex-start",
		gap: 8,
	},
	sealedNoticeText: {
		flexShrink: 1,
	},
	lifecycleButtonRow: {
		flexDirection: "row",
		gap: 8,
		flexWrap: "wrap",
	},
});

const styles = { ...globalStyles, ...localStyles };
