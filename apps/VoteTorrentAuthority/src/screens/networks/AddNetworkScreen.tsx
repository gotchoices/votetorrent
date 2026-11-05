import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import React, { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, TouchableOpacity, View, Image, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewInstance } from "react-native";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { KeyboardAvoidingScreen } from "../../components/KeyboardAvoidingScreen";
import { globalStyles } from "../../theme/styles";
import { CustomTextInput } from "../../components/CustomTextInput";
import { useApp } from "../../providers/AppProvider";
import { getOrCreateDeviceUser } from "../../engines/device-user";
import type { IDefaultUserEngine, INetworksEngine, NetworkInit, NetworkReference } from "@votetorrent/vote-core";
import { ElectionType } from "@votetorrent/vote-core";
import type { RootStackParamList } from "../../navigation/types";
import { InlineError } from "../../components/InlineError";
import { builderErrorsCopy } from "../../utils/errorCopy";
import { FOUNDING_OFFICER_SCOPES } from "../../utils/foundingOfficerScopes";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import { useRecoveryKeyRegistrationGate } from "../../hooks/useRecoveryKeyRegistrationGate";
import { useMediaPin } from "../../hooks/useMediaPin";
import {
	RECONCILE_TIMEOUT_MS,
	LATE_COMMIT_BUDGET_MS,
	awaitLateCommit,
	createStepTimeoutError,
	timedOutStep,
	findLandedNetwork,
} from "./networkCreateOutcome";
import { normalizeRelayAddresses, findInvalidRelayAddress } from "../../utils/relayAddressValidation";

export default function AddNetworkScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { getEngine, networksEngine, selectNetwork, isNetworkSelected } = useApp();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const handleDeviceSigningError = useDeviceSigningErrorHandler();
	const promptRecoveryKeyRegistrationIfNeeded = useRecoveryKeyRegistrationGate();
	const [networkName, setNetworkName] = useState("");
	const [networkImageUrl, setNetworkImageUrl] = useState("");
	const [authorityName, setAuthorityName] = useState("");
	const [authorityImageUrl, setAuthorityImageUrl] = useState("");
	// "Make Permanent": records the content id of each image's bytes (useMediaPin).
	const networkImagePin = useMediaPin();
	const authorityImagePin = useMediaPin();
	const [domainName, setDomainName] = useState("");
	const [adminName, setAdminName] = useState("");
	const [adminTitle, setAdminTitle] = useState("");
	const [isSigned, setIsSigned] = useState(false);
	const [relayAddresses, setRelayAddresses] = useState([""]);
	// Election Characteristics (Figma "New Network" frame) — keyholder usage and
	// single-vs-multiple authority.
	const [useKeyholders, setUseKeyholders] = useState(true);
	// CR-01: single-vs-multiple authority is not yet representable in NetworkInit;
	// the network is always created single-authority, so no toggle state is kept.
	// 16-08 item 4: surface the ACTUAL submit failure inline (not just console.error).
	const [errorMessage, setErrorMessage] = useState<string>("");
	// network-create-release-hang: track the in-flight create so the CREATE button shows
	// progress + is disabled during the (potentially slow / device-stalling) commit. Without
	// this the screen looks frozen for the whole `builder.commit()` await — indistinguishable
	// from a hang.
	const [creating, setCreating] = useState(false);
	// Neutral status shown while a commit that missed its 45 s deadline is still being awaited.
	const [stillFinishing, setStillFinishing] = useState(false);
	// A late commit can land after the officer left this screen. When the session has NO selected
	// network it is selected then (and the recovery-key gate runs); when another network is already
	// selected it is left alone for the officer to pick from Networks. Either way nothing may
	// setState or goBack after unmount.
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	const scrollViewRef = useRef<ScrollViewInstance>(null);
	// When the inline error appears it grows the footer, which shrinks the scroll
	// viewport. Android keeps the old scroll offset, so if the user was at the bottom
	// the last controls (e.g. ADD RELAY) slide out of view behind the error. Track
	// whether we're pinned to the bottom and re-pin when the viewport shrinks.
	const nearBottomRef = useRef(false);
	const viewportHeightRef = useRef(0);

	const handleScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
		const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
		nearBottomRef.current = layoutMeasurement.height + contentOffset.y >= contentSize.height - 24;
	};

	const handleScrollLayout = (e: LayoutChangeEvent) => {
		const height = e.nativeEvent.layout.height;
		if (height < viewportHeightRef.current && nearBottomRef.current) {
			scrollViewRef.current?.scrollToEnd({ animated: false });
		}
		viewportHeightRef.current = height;
	};

	// Drop an error once the user has acted on it, so a fixed problem doesn't keep
	// reporting itself until the next CREATE press.
	const clearErrorIf = (...keys: string[]) => {
		if (keys.some((key) => errorMessage === t(key))) setErrorMessage("");
	};

	// Relays used to hide under a collapsed "Advanced" toggle even though CREATE requires one;
	// the section is now always shown. Its y-offset lets a relay error scroll it into view.
	const relaysYRef = useRef(0);
	const scrollToRelays = () =>
		setTimeout(() => scrollViewRef.current?.scrollTo({ y: relaysYRef.current, animated: true }), 100);

	// Everything CREATE needs before it may start the device-key ceremony, reported together
	// rather than one error per press. Keys index the `missing*` copy.
	const missingRequirements = (): string[] => {
		const missing: string[] = [];
		if (!networkName.trim()) missing.push("missingNetworkName");
		if (!authorityName.trim()) missing.push("missingAuthorityName");
		if (!adminName.trim()) missing.push("missingYourName");
		if (!adminTitle.trim()) missing.push("missingYourTitle");
		if (normalizeRelayAddresses(relayAddresses).length === 0) missing.push("missingRelay");
		// CR-01: the "Sign" affordance gates creation of a signed permanent record.
		if (!isSigned) missing.push("missingSignature");
		return missing;
	};
	const missingMessage = (missing: string[]): string => {
		// Single-cause cases keep their established, more specific copy.
		if (missing.length === 1 && missing[0] === "missingSignature") return t("mustSignBeforeCreating");
		if (missing.length === 1 && missing[0] === "missingRelay") return t("errRelayRequired");
		return t("createMissingFields", { fields: missing.map((key) => t(key)).join(", ") });
	};
	const readyToCreate = missingRequirements().length === 0;

	// While a "missing fields" error is showing, keep it in step with the form: shrink it as
	// fields are filled and clear it once nothing is missing.
	const [showingMissing, setShowingMissing] = useState(false);
	useEffect(() => {
		if (!showingMissing) return;
		const missing = missingRequirements();
		if (missing.length === 0) {
			setErrorMessage("");
			setShowingMissing(false);
		} else {
			setErrorMessage(missingMessage(missing));
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [showingMissing, networkName, authorityName, adminName, adminTitle, isSigned, relayAddresses]);

	const addRelayField = () => {
		setRelayAddresses([...relayAddresses, ""]);
		clearErrorIf("errRelayRequired", "errRelayInvalid");
	};

	const updateRelayAddress = (index: number, value: string) => {
		clearErrorIf("errRelayRequired", "errRelayInvalid");
		const newAddresses = [...relayAddresses];
		newAddresses[index] = value;
		setRelayAddresses(newAddresses);
	};

	const removeRelayField = (index: number) => {
		if (relayAddresses.length > 1) {
			const newAddresses = relayAddresses.filter((_, i) => i !== index);
			setRelayAddresses(newAddresses);
		}
	};

	// network-create-release-hang: on real devices `builder.commit()` (strand/cadre/libp2p
	// network creation) can stall indefinitely with no error, leaving the screen frozen.
	// Race every create step against a timeout so an indefinite hang surfaces an actionable
	// inline error instead of an infinite silent spinner. The underlying promise can't be
	// cancelled, but the UI recovers and the user can retry.
	const CREATE_TIMEOUT_MS = 45000;
	const withTimeout = async <T,>(p: Promise<T>, label: string, ms: number = CREATE_TIMEOUT_MS): Promise<T> => {
		// Clear the losing timer once the race settles. Without this, every call leaves a
		// live handle (and its closure) alive for the full `ms` -- and handleCreate races
		// four steps per create. Mirrors resolveNodeDispatch in AppProvider.tsx.
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				p,
				new Promise<T>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(createStepTimeoutError(label, t("networkCreateTimeout", { step: label }))),
						ms,
					);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	};

	// D-01/D-02 (58-04): when `builder.commit()` misses its deadline, `commit()` is still running
	// and may still land -- `withTimeout`'s underlying promise "can't be cancelled" (see the
	// comment above). Reconciling against `getRecentNetworks()` (a bare `localStorage.getItem`,
	// never `open()` -- see `networkCreateOutcome.ts`'s header comment for why) is the only way to
	// tell a genuine failure apart from a slow success before reporting anything to the officer.
	// Own deadline (RECONCILE_TIMEOUT_MS), deliberately shorter than CREATE_TIMEOUT_MS: this runs
	// after the officer has already waited one full commit budget.
	const reconcileLandedNetwork = async (
		eng: INetworksEngine,
		before: NetworkReference[] | undefined,
	): Promise<NetworkReference | undefined> => {
		if (before === undefined) return undefined;
		console.info("[network-create] reconcile() start");
		try {
			const after = await withTimeout(eng.getRecentNetworks(), "reconcile", RECONCILE_TIMEOUT_MS);
			const landed = findLandedNetwork(before, after, {
				name: networkName,
				primaryAuthorityDomainName: domainName,
			});
			console.info("[network-create] reconcile() outcome", { landed: Boolean(landed) });
			return landed;
		} catch {
			console.info("[network-create] reconcile() outcome", { landed: false, timedOut: true });
			return undefined;
		}
	};

	const handleCreate = async () => {
		// 16-08 item 4: clear any prior error so a retry starts clean.
		setErrorMessage("");
		setShowingMissing(false);
		// Report every missing requirement at once, before any engine or biometric work.
		const missing = missingRequirements();
		if (missing.length > 0) {
			setErrorMessage(missingMessage(missing));
			setShowingMissing(true);
			if (missing.length === 1 && missing[0] === "missingRelay") scrollToRelays();
			return;
		}
		setCreating(true);
		try {
			// Resolve NetworksEngine — available directly from AppProvider context (D-03).
			if (!networksEngine) {
				console.error("handleCreate: networksEngine not yet initialized");
				setErrorMessage("Networks engine not yet initialized — please wait and try again.");
				return;
			}
			const networksEng = networksEngine as INetworksEngine;

			// R4 (D-11): validate relay addresses BEFORE device identity is resolved, so a
			// malformed paste can never trigger a biometric/device-key ceremony. Mirrors
			// NetworksScreen.tsx:36's "parsed/validated BEFORE any use" rule (T-22-09 DoS
			// mitigation, Security V5) on the JOIN path, extended here to CREATE. The validated
			// address is still NOT threaded into the rn-db-factory bootstrap-dial call — see
			// relayAddressValidation.ts's header comment for why that boundary stays closed.
			const relays = normalizeRelayAddresses(relayAddresses);
			const invalidRelay = findInvalidRelayAddress(relays);
			if (invalidRelay !== undefined) {
				setErrorMessage(t("errRelayInvalid"));
				scrollToRelays();
				return;
			}

			// Resolve device identity (D-02 / generate-on-first-run).
			const defaultUserEng = await getEngine<IDefaultUserEngine>("defaultUser");
			const defaultUser = await defaultUserEng.get();
			const user = await getOrCreateDeviceUser(defaultUser?.name ?? "Device User");

			// Assemble NetworkInit from the 11 form-state fields (D-03).
			// ThresholdPolicy uses `policy` field (not `scope`) per vote-core interface.
			const networkInit: NetworkInit = {
				name: networkName,
				imageUrl: networkImageUrl || undefined,
				imageCid: networkImageUrl ? networkImagePin.cidFor(networkImageUrl) : undefined,
				// R4 (D-11, T-58-06-02): the SAME array that was just validated above — never
				// re-derive a second array from relayAddresses here, which would validate one
				// value and persist another.
				relays,
				primaryAuthority: {
					name: authorityName,
					domainName: domainName,
					imageUrl: authorityImageUrl || undefined,
					imageCid: authorityImageUrl ? authorityImagePin.cidFor(authorityImageUrl) : undefined,
				},
				admin: {
					officers: [
						{
							init: {
								name: adminName,
								title: adminTitle,
								scopes: [...FOUNDING_OFFICER_SCOPES],
							},
						},
					],
					effectiveAt: Date.now(),
					thresholdPolicies: [
						{ policy: "rn", threshold: 1 },
						{ policy: "mel", threshold: 1 },
						{ policy: "ceb", threshold: 1 },
					],
				},
				policies: {
					timestampAuthorities: [],
					numberRequiredTSAs: 0,
					electionType: useKeyholders ? ElectionType.official : ElectionType.adhoc,
				},
			};

			// Route through v1.1 NetworksCreateBuilder (D-03).
			// INetworksCreateBuilder.update() is the typed API for setting both fields
			// (setNetworkInit/setUser are on the concrete class, not the interface).
			const builder = networksEng.buildCreate().update({ networkInit, user });
			if (!builder.isValid()) {
				console.error("handleCreate: validation errors", builder.errors().map((e) => e.code));
				const relayMissing = builder.errors().some((e) => e.path === "networkInit.relays");
				setErrorMessage(
					// network-create-release-hang: replace the raw "networkInit.relays must not be
					// empty" engine string with discoverable guidance pointing at the Relays
					// section. Other validation errors fall through unchanged.
					relayMissing
						? t("errRelayRequired")
						: builderErrorsCopy([...builder.errors()], t),
				);
				if (relayMissing) scrollToRelays();
				return;
			}
			// D-01 (58-04): snapshot the recents list BEFORE commit() so a missed deadline can be
			// reconciled against it afterward. A failed snapshot must NOT degrade to an empty
			// array -- with before=[] every pre-existing network would look "new" and reconciliation
			// could select an unrelated one -- so on failure it stays `undefined`, which forces the
			// "could not confirm" outcome further down.
			let recentsSnapshot: NetworkReference[] | undefined;
			try {
				recentsSnapshot = await withTimeout(
					networksEng.getRecentNetworks(),
					"snapshot",
					RECONCILE_TIMEOUT_MS,
				);
			} catch (snapshotErr) {
				console.info(
					"[network-create] snapshot() failed",
					snapshotErr instanceof Error ? snapshotErr.name : typeof snapshotErr,
				);
				recentsSnapshot = undefined;
			}

			// network-create-release-hang: instrument each create step so on-device logcat
			// pinpoints where a real-device hang occurs (console.info is allowed by the VER-01
			// stub guard). Race against a timeout so an indefinite stall surfaces an error.
			console.info("[network-create] commit() start", { network: networkName });
			let networkRef: NetworkReference;
			// Held un-raced: after the 45 s deadline the SAME promise is handed to awaitLateCommit.
			const commitPromise = builder.commit();
			try {
				const networkEngine = await withTimeout(commitPromise, "commit");
				console.info("[network-create] commit() done");
				// Pitfall 4: re-establish currentNetworkHash in the factory by calling
				// getEngine("network", ref) with the full NetworkReference that the concrete
				// NetworkEngine exposes via its `init` property. INetworkEngine does not
				// declare `init` in the interface, so we access it via a cast.
				// This allows sibling engines (elections, signing, etc.) to resolve the
				// established ctx immediately after create without a separate open().
				networkRef = (networkEngine as unknown as { init: NetworkReference }).init;
			} catch (commitErr) {
				if (timedOutStep(commitErr) !== "commit") throw commitErr;
				// D-02: the commit deadline was missed. Reconcile before reporting anything -- a
				// timely commit and a reconciled-landed commit must produce the identical tail
				// (selectNetwork -> the recovery-key gate -> goBack), never a duplicated copy of it.
				const landed = await reconcileLandedNetwork(networksEng, recentsSnapshot);
				if (landed) {
					networkRef = landed;
				} else {
					// The commit is most likely still running (a low-end phone can block the JS
					// thread for minutes), so keep awaiting the ORIGINAL promise for a bounded
					// budget instead of reporting anything. Neutral status only -- not an error.
					if (mountedRef.current) setStillFinishing(true);
					console.info("[network-create] late commit: waiting");
					const late = await awaitLateCommit(commitPromise, LATE_COMMIT_BUDGET_MS);
					if (mountedRef.current) setStillFinishing(false);
					console.info(`[network-create] late commit: ${late.status}`);
					if (late.status === "landed") {
						networkRef = (late.value as unknown as { init: NetworkReference }).init;
					} else if (late.status === "failed") {
						throw late.error;
					} else {
						const second = await reconcileLandedNetwork(networksEng, recentsSnapshot);
						if (!second) {
							// D-03: never claim failure, never blame the connection -- only that
							// the outcome could not be confirmed.
							if (mountedRef.current) setErrorMessage(t("networkCreateUnconfirmed"));
							return;
						}
						networkRef = second;
					}
				}
			}
			// Auto-select the just-created network: bind it AND flip hasNetwork so the
			// app lands on the populated network home instead of "No network selected".
			// (selectNetwork re-establishes currentNetworkHash like the old getEngine call,
			// plus sets hasNetwork — Pitfall 4 still satisfied via its internal getEngine.)
			// WR-01 (62-88): a commit that lands after the officer left Add Network must NOT re-point
			// the session behind their back (up to LATE_COMMIT_BUDGET_MS later, they may already be
			// working in another network). The network is in recents; they select it from Networks.
			// The one exception: when the session has NO network selected, nothing is re-pointed, and
			// leaving the officer on "No network selected" with a network they just created would lose
			// it. An unknown answer (no accessor) counts as "selected": the safe default.
			if (!mountedRef.current) {
				if (isNetworkSelected?.() === false) {
					console.info("[network-create] late commit landed after leave; selecting (no network selected)");
					try {
						await selectNetwork(networkRef);
						// Same recovery-key path as the in-screen tail (49-19): skipping it here would leave
						// the founder's recovery key unregistered with no prompt. The gate navigates only
						// when registration is needed. No goBack: this screen is gone.
						await promptRecoveryKeyRegistrationIfNeeded();
					} catch (lateErr) {
						console.info(
							"[network-create] late recovery-key gate failed:",
							lateErr instanceof Error ? lateErr.name : typeof lateErr,
						);
					}
				} else {
					console.info("[network-create] late commit landed after leave; not auto-selecting");
				}
				return;
			}
			console.info("[network-create] selectNetwork() start");
			await withTimeout(selectNetwork(networkRef), "select");
			console.info("[network-create] selectNetwork() done");
			// selectNetwork itself can outlive an unmount (the officer leaves while it runs): the
			// session now has its user, but there is nothing to show and nowhere to navigate.
			if (!mountedRef.current) return;

			// 49-19 (recovery-key-registration gap): networks-engine.create() registers ONLY the
			// founding signing key -- its bootstrap branch writes user.activeKeys[0] and has no
			// analog for a second key -- so the officer's recovery key is still unregistered the
			// moment this network comes up. Registration lives in ProvisionSigningKeyScreen's
			// stage 2, which needs a resolvable network User and therefore CANNOT run before this
			// point; until now nothing brought the officer back to it, leaving them one biometric
			// enrolment away from a stranded device (addKey needs a valid signing key, and only
			// the recovery key can replace an invalidated one -- a closed loop whose only recorded
			// escape was a destructive `pm clear`). Measured unregistered on BOTH fleet devices.
			//
			// The ceremony is idempotent and reconciling (it registers only what is missing), so
			// routing into it here is safe; the gate keeps us from showing it when there is
			// nothing to do. Deliberately AFTER selectNetwork: the network is fully established
			// and stays selected, so declining leaves a usable network rather than a dead end.
			//
			// The `return` is load-bearing, and is why this mirrors NetworkDetailsScreen's join
			// path rather than calling the gate for its side effect: the `navigation.goBack()`
			// at the end of this function is UNCONDITIONAL, so without it the ceremony screen the
			// gate just pushed is popped straight back off and the officer lands on Add Network
			// again -- the gate's whole point undone one statement later. Measured on real
			// hardware (Pixel 7 Pro, 2026-08-24): the gate logged `needed: true` and navigated,
			// and the device still sat on Add Network. `finally` still runs on this path, so the
			// in-flight flag is cleared exactly as it is on every other exit.
			//
			// `replaceCurrent`: the ceremony replaces this screen instead of stacking on it. Its
			// own exit is `goBack()`, which otherwise returned the officer to this form with the
			// network already created (release APK, 2026-10-31); now it lands where this screen's
			// own `goBack()` would have.
			if (await promptRecoveryKeyRegistrationIfNeeded({ replaceCurrent: true })) return;
		} catch (err) {
			// WR-01 (62-88): a failure that arrives after the officer left neither routes nor sets
			// screen state. Log the error class name only.
			if (!mountedRef.current) {
				console.info(
					"[network-create] late commit failed after leave:",
					err instanceof Error ? err.name : typeof err,
				);
				return;
			}
			// 49-16 (Gap A): this screen never invokes the per-use device-signing factory
			// (device-signer.ts's exported creator) and is therefore outside the 20-file rollout
			// inventory — but getOrCreateDeviceUser above is the exact second-half-of-the-
			// onboarding-cycle site that produced the dead end 49-13 reproduced four times on
			// device. Route its NO_KEY_PROVISIONED rejection through the same shared hook every
			// migrated call site uses, rather than re-deriving the mapping here, so the officer
			// lands on the provisioning screen instead of a raw error string. Any other failure
			// (validation, commit, network) is "not mine" to the hook and falls through to this
			// screen's own raw-message handling unchanged.
			const outcome = handleDeviceSigningError(err);
			if (outcome.handled) {
				// The first Create on a fresh install lands here by design (no signing key yet), so it
				// is routing, not a failure: logged as info so a dev build shows no error toast for it.
				console.info("[network-create] routed to signing-key setup:", err instanceof Error ? err.name : typeof err);
				return;
			}
			console.error("handleCreate error:", err instanceof Error ? err.name : typeof err);
			// Engine text carries ids and table names: never rendered. 62-96's peer copy arrives
			// through outcome.message.
			setErrorMessage(outcome.message ?? t("networkCreateFailed"));
			return;
		} finally {
			// Always clear the in-flight flag so the button re-enables on error/timeout
			// (on success the screen unmounts via goBack, so this is a harmless no-op).
			if (mountedRef.current) {
				setCreating(false);
				setStillFinishing(false);
			}
		}
		navigation.goBack();
	};

	return (
		<KeyboardAvoidingScreen>
			<ScrollView
				ref={scrollViewRef}
				style={styles.container}
				onScroll={handleScroll}
				scrollEventThrottle={64}
				onLayout={handleScrollLayout}
			>
				<ThemedText type="title" style={styles.sectionTitle}>
					{t("network")}
				</ThemedText>

				<View style={styles.section}>
					<CustomTextInput title={t("name")} value={networkName} onChangeText={setNetworkName} />
					<CustomTextInput
						title={t("imageUrl")}
						value={networkImageUrl}
						placeholder={t("optionalImageAddress")}
						onChangeText={setNetworkImageUrl}
						isImageUrlField={true}
						makePermanentPressed={() => networkImagePin.pin(networkImageUrl)}
						makePermanentDisabled={!networkImageUrl.trim() || networkImagePin.isPinning}
						permanentStatus={networkImagePin.statusFor(networkImageUrl)}
					/>
					{networkImageUrl ? (
						<Image
							source={{ uri: networkImageUrl }}
							style={styles.previewImage}
							resizeMode="cover"
						/>
					) : null}
				</View>

				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t("electionCharacteristics")}
					</ThemedText>
					<View style={styles.characteristicsGrid}>
						<TouchableOpacity
							style={styles.radioOption}
							onPress={() => setUseKeyholders(true)}
						>
							<View style={[styles.radioOuter, { borderColor: useKeyholders ? colors.primary : colors.textSecondary }]}>
								{useKeyholders && <View style={[styles.radioInner, { backgroundColor: colors.primary }]} />}
							</View>
							<ThemedText style={styles.radioLabel}>{t("useKeyholders")}</ThemedText>
						</TouchableOpacity>
						<TouchableOpacity
							style={styles.radioOption}
							onPress={() => setUseKeyholders(false)}
						>
							<View style={[styles.radioOuter, { borderColor: !useKeyholders ? colors.primary : colors.textSecondary }]}>
								{!useKeyholders && <View style={[styles.radioInner, { backgroundColor: colors.primary }]} />}
							</View>
							<ThemedText style={styles.radioLabel}>{t("noKeyholders")}</ThemedText>
						</TouchableOpacity>
					</View>
					{/* CR-01: NetworkInit can only represent a single primary authority, so
					    the multi-authority option is disabled (rather than a live control
					    that silently drops the user's choice). Single authority is always used. */}
					<View style={styles.characteristicsGrid}>
						<View style={styles.radioOption}>
							<View style={[styles.radioOuter, { borderColor: colors.primary }]}>
								<View style={[styles.radioInner, { backgroundColor: colors.primary }]} />
							</View>
							<ThemedText style={styles.radioLabel}>{t("singleAuthority")}</ThemedText>
						</View>
						<View style={[styles.radioOption, { opacity: 0.4 }]}>
							<View style={[styles.radioOuter, { borderColor: colors.textSecondary }]} />
							<ThemedText style={styles.radioLabel}>{t("multiple")}</ThemedText>
						</View>
					</View>
					{/* The "not yet supported" note sits under the grid rather than in the
					    radio label, where it wrapped to two lines and knocked the rows out
					    of line with the keyholder row above. */}
					<ThemedText type="small" style={[styles.unsupportedNote, { color: colors.textSecondary }]}>
						{t("multipleAuthorityNotYetSupportedNote")}
					</ThemedText>
				</View>

				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t("primaryAuthority")}
					</ThemedText>
					<CustomTextInput
						title={t("name")}
						value={authorityName}
						onChangeText={setAuthorityName}
					/>
					<CustomTextInput
						title={t("imageUrl")}
						value={authorityImageUrl}
						placeholder={t("optionalImageAddress")}
						onChangeText={setAuthorityImageUrl}
						isImageUrlField={true}
						makePermanentPressed={() => authorityImagePin.pin(authorityImageUrl)}
						makePermanentDisabled={!authorityImageUrl.trim() || authorityImagePin.isPinning}
						permanentStatus={authorityImagePin.statusFor(authorityImageUrl)}
					/>
					{authorityImageUrl ? (
						<Image
							source={{ uri: authorityImageUrl }}
							style={styles.previewImage}
							resizeMode="cover"
						/>
					) : null}
					<CustomTextInput
						title={t("domainName")}
						value={domainName}
						onChangeText={setDomainName}
					/>
				</View>

				<View
					style={styles.section}
					onLayout={(e) => {
						relaysYRef.current = e.nativeEvent.layout.y;
					}}
				>
					<View style={[styles.buttonHeader, styles.relaysHeader]}>
						<ThemedText type="title">{t("relays")}</ThemedText>
						<ChipButton
							label={t("import")}
							icon="circle-plus"
							disabled={true}
							onPress={undefined}
						/>
					</View>
					<ThemedText type="small" style={[styles.relaysHint, { color: colors.textSecondary }]}>
						{t("relaysRequiredHint")}
					</ThemedText>
					{relayAddresses.map((address, index) => (
						<CustomTextInput
							key={index}
							placeholder={t("multiaddress")}
							value={address}
							onChangeText={(value) => updateRelayAddress(index, value)}
							icon={relayAddresses.length > 1 ? "circle-xmark" : undefined}
							onIconPress={() => removeRelayField(index)}
						/>
					))}
					<View style={styles.buttonHeader}>
						<View />
						<ChipButton label={t("addRelay")} icon="circle-plus" onPress={addRelayField} />
					</View>
				</View>

				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t("initialAdministrator")}
					</ThemedText>
					<CustomTextInput
						title={t("name")}
						value={adminName}
						placeholder={t("yourNameOnPermanentRecord")}
						onChangeText={setAdminName}
					/>
					<CustomTextInput
						title={t("title")}
						value={adminTitle}
						placeholder={t("yourTitleOnPermanentRecord")}
						onChangeText={setAdminTitle}
					/>
					<CustomButton
						title={t("sign")}
						icon={isSigned ? "square-check" : "square"}
						backgroundColor={colors.important}
						forceDarkText={true}
						onPress={() => {
							setIsSigned(!isSigned);
							clearErrorIf("mustSignBeforeCreating");
						}}
					/>
				</View>

			</ScrollView>

			<Footer>
				{/* Inside the Footer so it picks up the footer's horizontal padding
				    instead of running flush against the screen edge. */}
				<InlineError message={errorMessage} />
				{stillFinishing ? (
					<ThemedText
						type="small"
						testID="network-create-still-finishing"
						style={{ color: colors.textSecondary }}
					>
						{t("networkCreateStillFinishing")}
					</ThemedText>
				) : null}
				<CustomButton
					title={creating ? t("creating") : t("create")}
					icon={creating ? "spinner" : "floppy-disk"}
					// Neutral grey until every requirement is met, green once CREATE can succeed. Still
					// pressable while grey, so a press explains what's missing.
					backgroundColor={readyToCreate ? colors.success : colors.accent}
					forceDarkText={true}
					disabled={creating}
					onPress={handleCreate}
				/>
			</Footer>
		</KeyboardAvoidingScreen>
	);
}

const localStyles = StyleSheet.create({
	fieldLabel: {
		marginBottom: 8,
	},
	input: {
		padding: 16,
		borderRadius: 32,
		fontSize: 16,
		borderWidth: 1,
		marginTop: 8,
	},
	buttonHeader: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
	},
	permanentSection: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	previewImage: {
		marginTop: 8,
		height: 200,
		borderRadius: 16,
	},
	characteristicsGrid: {
		flexDirection: "row",
		marginTop: 12,
	},
	radioOption: {
		flexDirection: "row",
		alignItems: "center",
		flex: 1,
	},
	radioOuter: {
		width: 20,
		height: 20,
		borderRadius: 10,
		borderWidth: 2,
		alignItems: "center",
		justifyContent: "center",
		marginRight: 8,
	},
	radioInner: {
		width: 10,
		height: 10,
		borderRadius: 5,
	},
	radioLabel: {
		flex: 1,
	},
	unsupportedNote: {
		marginTop: 8,
	},
	signButton: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginTop: 16,
		padding: 16,
		borderRadius: 32,
		borderWidth: 1,
	},
	signText: {
		fontSize: 16,
		fontWeight: "600",
	},
	relaysHeader: {
		marginBottom: 8,
	},
	relaysHint: {
		marginBottom: 8,
	},
	relayFieldContainer: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginBottom: 8,
	},
	removeButtonContainer: {
		width: 40,
		alignItems: "center",
	},
	removeButton: {
		padding: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
