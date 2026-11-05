import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { CustomTextInput } from "../../components/CustomTextInput";
import { InfoCard } from "../../components/InfoCard";
import { InlineError } from "../../components/InlineError";
import { globalStyles } from "../../theme/styles";
import { useApp } from "../../providers/AppProvider";
import { useCurrentOfficerScopes } from "../../hooks/useCurrentOfficerScopes";
import { createDeviceSigner } from "../../engines/device-signer";
import type { SignCallback } from "../../engines/device-signer";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import { scopeLabel } from "../../utils/scopeLabel";
import type { IAuthorityConfigEngine, PollingDevice } from "@votetorrent/vote-core";
import type { NavigationProp, RootStackParamList } from "../../navigation/types";
import {
	formatDeviceTitle,
	isValidDeviceHash,
	normalizeDeviceHash,
} from "./polling-device-hash";
// LifecycleConfirmCard is owned by 47-10 and lives in the registration tree
// because that is where its other seven call sites are; this screen is the
// one authorities-tree consumer and imports it rather than forking a second
// confirmation card.
import { LifecycleConfirmCard } from "../registration/components/LifecycleConfirmCard";
import { useKeyboardInset } from "../../hooks/useKeyboardInset";
import { errorCopy } from "../../utils/errorCopy";

// A stable no-op for the (non-optional) CustomButton.onPress prop when a gate
// is unmet — belt-and-suspenders alongside `disabled`, mirroring
// AttestationPolicySection's NOOP idiom, so a direct programmatic invocation
// of the handler (bypassing a real touch event) still cannot fire a write.
const NOOP = () => {};

/**
 * PollingDevicesScreen — the `'vrg'`-scoped `PollingDevice` whitelist CRUD
 * surface (D-08, existing `src/screens/authorities/` tree; D-13 default
 * visible-but-disabled gating pattern).
 *
 * A whitelisted row waives device-uniqueness for the associate() ceremony
 * (Phase 42 D-06 — `association-engine.ts:287-300`), so the entry path for
 * `deviceHash` is a correctness surface, not a cosmetic one; see
 * `./polling-device-hash.ts` for the normalization/validation contract this
 * screen delegates to.
 *
 * `PollingDevices` IS a key of `RootStackParamList` (47-21 added
 * `{ authorityId: string }` and registered the `Stack.Screen`), so this screen
 * reads its param through `RouteProp<RootStackParamList, "PollingDevices">`
 * rather than the unconditional cast it used before that landed. It still uses
 * `useNavigation<NavigationProp>()` for `setOptions` ONLY — it navigates
 * nowhere (no detail screen this phase).
 */
export default function PollingDevicesScreen() {
	const { t } = useTranslation();
	const keyboardInset = useKeyboardInset();
	const { colors } = useTheme() as ExtendedTheme;
	const insets = useSafeAreaInsets();
	const { getEngine } = useApp();
	const navigation = useNavigation<NavigationProp>();
	// Typed, not cast: 47-21 registered "PollingDevices" on RootStackParamList,
	// so RouteProp gives the param checking the earlier cast could not.
	const { authorityId } = useRoute<RouteProp<RootStackParamList, "PollingDevices">>().params;

	const [devices, setDevices] = useState<PollingDevice[]>([]);
	const [loading, setLoading] = useState(true);
	const [errorMessage, setErrorMessage] = useState("");
	const [addFormOpen, setAddFormOpen] = useState(false);
	const [labelInput, setLabelInput] = useState("");
	const [hashInput, setHashInput] = useState("");
	const [addSubmitting, setAddSubmitting] = useState(false);
	const [confirmForHash, setConfirmForHash] = useState<string | undefined>(undefined);
	const handleDeviceSigningError = useDeviceSigningErrorHandler();

	const { scopes, loading: scopesLoading } = useCurrentOfficerScopes(authorityId);
	// 'vrg' (Validate Registrations), NOT 'cap' — AuthorityConfigEngine splits
	// its ceremonies by scope: 'cap' for AuthorityPeer, 'vrg' for
	// PollingDevice (47-18 is the 'cap' screen). This is a UI legibility
	// affordance, NOT the enforcement boundary — the schema's 'vrg'
	// AdminSignature InsertValid/DeleteValid CHECKs (votetorrent.qsql:1618-1639)
	// are the real and only control (T-46-03 precedent, T-47-04).
	const canWrite = !scopesLoading && scopes?.includes("vrg") === true;

	// CR-02-style guard against a stale setState: load() is invoked both from
	// the mount effect below AND from both write handlers, so a single
	// effect-scoped `cancelled` closure would only cover the mount call. A ref
	// shared across every caller generalizes the same never-setState-after-
	// unmount guarantee (RegistrationPolicyScreen.tsx:102-111 precedent).
	const unmountedRef = useRef(false);
	useEffect(() => {
		// WR-08: reset on entry so a cleanup that runs while the component
		// stays mounted (StrictMode double-invoke, Fast Refresh, remount-in-
		// place) does not permanently latch every setState in load() off.
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
		};
	}, []);

	const load = useCallback(async () => {
		try {
			const authorityConfigEngine = await getEngine<IAuthorityConfigEngine>("authorityConfig");
			const fetched = await authorityConfigEngine.getPollingDevices(authorityId);
			// Sort ascending by deviceHash with a plain comparison — NOT
			// localeCompare, which is host-locale dependent under Hermes.
			// Matches the real engine's (AuthorityId, DeviceHash) PK order and
			// keeps the screen test's row assertions stable.
			const sorted = [...fetched].sort((a, b) =>
				a.deviceHash < b.deviceHash ? -1 : a.deviceHash > b.deviceHash ? 1 : 0,
			);
			if (!unmountedRef.current) setDevices(sorted);
		} catch (err) {
			if (!unmountedRef.current) setErrorMessage(errorCopy(err, t, "read"));
		} finally {
			if (!unmountedRef.current) setLoading(false);
		}
	}, [getEngine, authorityId]);

	// Plain effect, deliberately NOT useFocusEffect: nothing else in the app
	// mutates PollingDevice rows during a session, and both write handlers
	// reload themselves, so a focus-triggered refetch buys nothing.
	// (NetworksScreen needs useFocusEffect because a DIFFERENT screen creates
	// its rows; this screen owns all of its own writes.)
	useEffect(() => {
		load();
	}, [load]);

	function renderAddToggle() {
		return (
			<View
				testID="polling-devices-add-toggle"
				pointerEvents={canWrite ? "auto" : "none"}
				style={canWrite ? undefined : localStyles.disabledControl}
			>
				<ChipButton
					label={t("pollingDeviceAddButton")}
					icon={addFormOpen ? "xmark" : "circle-plus"}
					onPress={canWrite ? () => setAddFormOpen((v) => !v) : undefined}
				/>
			</View>
		);
	}

	// Phase 7 D-14 idiom: headerRight via useLayoutEffect (avoids first-frame
	// flicker). The deps array must include canWrite/addFormOpen or the
	// header freezes at its first-render state.
	useLayoutEffect(() => {
		navigation.setOptions({
			title: t("pollingDeviceScreenTitle"),
			headerRight: () => renderAddToggle(),
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [navigation, t, canWrite, addFormOpen]);

	const normalizedHash = normalizeDeviceHash(hashInput);
	const hashIsValid = isValidDeviceHash(hashInput);
	// The duplicate check is what keeps this screen away from the real
	// engine's (AuthorityId, DeviceHash) PK violation, which
	// MockAuthorityConfigEngine's upsert (mock-authority-config-engine.ts:46-52)
	// cannot reproduce — a documented mock-vs-real blindness, the same class
	// Phase 46 documented for addElectionRegistrationField. PollingDevice also
	// carries `constraint NoUpdate check on update (false)`, so there is no
	// edit affordance on this screen (a changed label is a remove-then-add of
	// two separately-signed ceremonies, out of this phase's scope).
	const isDuplicate = hashIsValid && devices.some((d) => d.deviceHash === normalizedHash);
	const canSubmitAdd = canWrite && hashIsValid && !isDuplicate && !addSubmitting;

	async function handleAddSubmit() {
		// Belt-and-suspenders re-check as the first statement — a programmatic
		// onPress must not bypass the gate (AttestationPolicySection pattern).
		if (!canSubmitAdd) return;
		setAddSubmitting(true);
		setErrorMessage("");
		try {
			// Same literal bootstrap name AppProvider.tsx and
			// useCurrentOfficerScopes use, so a first-run identity cannot diverge.
			const sign: SignCallback = await createDeviceSigner("Device User");
			const authorityConfigEngine = await getEngine<IAuthorityConfigEngine>("authorityConfig");
			const trimmedLabel = labelInput.trim();
			// Pass undefined, never "", for an empty label — the digest binds
			// `label ?? null` (authority-config-engine.ts:135), so an empty
			// string and an absent label are two different signed values, and
			// only the undefined form round-trips as "no label" through
			// formatDeviceTitle.
			await authorityConfigEngine.addPollingDevice(authorityId, normalizedHash, trimmedLabel === "" ? undefined : trimmedLabel, sign);
			if (!unmountedRef.current) {
				setLabelInput("");
				setHashInput("");
				setAddFormOpen(false);
			}
		} catch (err) {
			// Leave the form open with the operator's input intact so a retry
			// costs no retyping.
			const outcome = handleDeviceSigningError(err);
			if (!unmountedRef.current && !outcome.handled) {
				setErrorMessage(outcome.message ?? errorCopy(err, t, "write"));
			}
		} finally {
			if (!unmountedRef.current) setAddSubmitting(false);
			await load();
		}
	}

	async function handleRemoveConfirm(deviceHash: string) {
		try {
			const sign: SignCallback = await createDeviceSigner("Device User");
			const authorityConfigEngine = await getEngine<IAuthorityConfigEngine>("authorityConfig");
			await authorityConfigEngine.removePollingDevice(authorityId, deviceHash, sign);
			if (!unmountedRef.current) setConfirmForHash(undefined);
		} catch (err) {
			const outcome = handleDeviceSigningError(err);
			if (!unmountedRef.current && !outcome.handled) {
				setErrorMessage(outcome.message ?? errorCopy(err, t, "write"));
			}
			// Re-throw: 47-10's downstream contract requires a REJECTED
			// onConfirm so the card re-enables for a retry; swallowing the
			// error would latch the card permanently disabled with no recourse.
			throw err;
		} finally {
			await load();
		}
	}

	// A dismissed confirmation fires ZERO engine calls (D-10;
	// RegistrationPolicyScreen.tsx:495-515 precedent).
	function handleRemoveDismiss() {
		setConfirmForHash(undefined);
	}

	return (
		<ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: insets.bottom + 24 + keyboardInset }}>
			<View style={styles.section}>
				<InlineError message={errorMessage} />
			</View>

			{/* D-13 scope-gate banner — persistent, non-collapsible, rendered
			    only once the hook has resolved. The two branches are
			    DELIBERATELY not collapsed: scopes === undefined (no matching
			    Officer row) vs. a real scopes array missing 'vrg' are two
			    distinct facts and bind to two distinct copies. This gate is a
			    UI affordance for legibility, NOT a security boundary. */}
			{!scopesLoading && !canWrite && (
				scopes === undefined ? (
					<View testID="polling-devices-readonly-no-officer-banner" style={localStyles.banner}>
						<FontAwesome6 name="lock" size={14} color={colors.textSecondary} />
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrantScopeReadOnlyNoOfficerBanner")}
						</ThemedText>
					</View>
				) : (
					<View testID="polling-devices-readonly-banner" style={localStyles.banner}>
						<FontAwesome6 name="lock" size={14} color={colors.textSecondary} />
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrantScopeReadOnlyBanner", { scope: scopeLabel("vrg", t) })}
						</ThemedText>
					</View>
				)
			)}

			{addFormOpen && (
				<View testID="polling-devices-add-form" style={styles.section}>
					<CustomTextInput
						testID="polling-devices-add-label-input"
						title={t("pollingDeviceLabelField")}
						placeholder={t("pollingDeviceLabelPlaceholder")}
						value={labelInput}
						onChangeText={setLabelInput}
					/>
					<CustomTextInput
						testID="polling-devices-add-hash-input"
						title={t("pollingDeviceHashLabel")}
						value={hashInput}
						onChangeText={setHashInput}
						autoCapitalize="none"
						autoCorrect={false}
						spellCheck={false}
						icon={hashInput.trim() === "" ? undefined : hashIsValid ? "circle-check" : "circle-xmark"}
					/>
					<View testID="polling-devices-add-submit">
						<CustomButton
							size="thin"
							title={addSubmitting ? `${t("pollingDeviceAddButton")}…` : t("pollingDeviceAddButton")}
							disabled={!canSubmitAdd}
							onPress={canSubmitAdd ? handleAddSubmit : NOOP}
						/>
					</View>
				</View>
			)}

			<View style={styles.section}>
				{!loading && devices.length === 0 && (
					<View testID="polling-devices-empty">
						<ThemedText type="defaultSemiBold">{t("pollingDeviceEmptyHeading")}</ThemedText>
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("pollingDeviceEmptyBody")}
						</ThemedText>
					</View>
				)}
				{!loading &&
					devices.map((device) => (
						<React.Fragment key={device.deviceHash}>
							<View testID={"polling-devices-row-" + device.deviceHash} style={localStyles.rowHeader}>
								<View style={localStyles.cardFlex}>
									<InfoCard
										title={formatDeviceTitle(device)}
										additionalInfo={[{ label: t("pollingDeviceHashLabel"), value: device.deviceHash }]}
									/>
								</View>
								{/* ChipButton cannot be tinted colors.error — it has no
								    style prop and hardcodes colors.accent. The
								    destructive signalling therefore lives entirely in
								    the confirmation card's tone="destructive" below,
								    which is where the irreversible moment actually is.
								    Do not fork or extend the shared ChipButton to add a
								    colour prop. */}
								<View
									testID={"polling-devices-remove-" + device.deviceHash}
									pointerEvents={canWrite ? "auto" : "none"}
									style={[localStyles.rowAction, canWrite ? null : localStyles.disabledControl]}
								>
									<ChipButton
										label={t("pollingDeviceRemoveButton")}
										onPress={canWrite ? () => setConfirmForHash(device.deviceHash) : undefined}
									/>
								</View>
							</View>
							{confirmForHash === device.deviceHash && (
								// Ordinary variant only: whitelist removal is
								// reversible (the device can be re-added) and alters
								// no Registrant.Status, so it does not meet D-10's
								// destructive bar (47-UI-SPEC.md:533-538) — but it is
								// still a delete and never a silent single-tap action.
								<LifecycleConfirmCard
									variant="ordinary"
									tone="destructive"
									title={t("pollingDeviceRemoveTitle")}
									body={t("pollingDeviceRemoveBody", { label: formatDeviceTitle(device) })}
									confirmLabel={t("pollingDeviceRemoveConfirm")}
									dismissLabel={t("pollingDeviceKeepDevice")}
									onConfirm={() => handleRemoveConfirm(device.deviceHash)}
									onDismiss={handleRemoveDismiss}
									testIDPrefix={"polling-device-remove-" + device.deviceHash}
								/>
							)}
						</React.Fragment>
					))}
			</View>
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	banner: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginBottom: 12,
	},
	disabledControl: {
		opacity: 0.5,
	},
	rowHeader: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	cardFlex: {
		flex: 1,
		minWidth: 0,
	},
	// flexShrink: 0 guarantees the REMOVE chip claims its intrinsic width
	// first and the card absorbs all remaining pressure, so REMOVE can never
	// be squeezed past the screen edge even if a future card grows.
	rowAction: {
		flexShrink: 0,
	},
});

const styles = { ...globalStyles, ...localStyles };
