import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { globalStyles } from "../../theme/styles";
import { ThemedText } from "../../components/ThemedText";
import { useTranslation } from "react-i18next";
import {
	ExtendedTheme,
	useNavigation,
	useRoute,
	useTheme,
} from "@react-navigation/native";
import {
	NetworkReference,
	AdminDetails,
	AuthorityDetails,
	IAuthorityEngine,
	INetworkEngine,
	NetworkDetails,
} from "@votetorrent/vote-core";
import { CustomButton } from "../../components/CustomButton";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "../../providers/AppProvider";
import NetworkDetailsComponent from "./components/NetworkDetailsComponent";
import { AuthorizationSection } from "../../components/AuthorizationSection";
import type { NavigationProp } from "../../navigation/types";
import { useRecoveryKeyRegistrationGate } from "../../hooks/useRecoveryKeyRegistrationGate";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import {
	ProposedChange,
	ProposedChangesCard,
} from "./components/ProposedChangesCard";
import { InlineError } from "../../components/InlineError";

export function NetworkDetailsScreen() {
	const { networkRef } = useRoute().params as { networkRef: NetworkReference };
	const [networkEngine, setNetworkEngine] = useState<INetworkEngine>();
	const [networkDetails, setNetworkDetails] = useState<NetworkDetails>();
	const [primaryAuthorityEngine, setPrimaryAuthorityEngine] = useState<IAuthorityEngine>();
	const [primaryAuthorityDetails, setPrimaryAuthorityDetails] = useState<AuthorityDetails>();
	const [primaryAuthorityAdmin, setPrimaryAuthorityAdmin] = useState<AdminDetails>();
	// WR-R3-09: each load owns its own error, so one load clearing its error can never erase the
	// other's, and each effect ignores a run superseded by a newer one (cancelled in cleanup).
	const [networkLoadError, setNetworkLoadError] = useState("");
	const [authorityLoadError, setAuthorityLoadError] = useState("");
	const loadError = networkLoadError || authorityLoadError;
	// Bumped by Try Again; both load effects depend on it so a retry re-runs the network load and
	// then (through the new details) the primary-authority load.
	const [reloadNonce, setReloadNonce] = useState(0);
	const [selectError, setSelectError] = useState("");
	const [currentUserId, setCurrentUserId] = useState<string>();
	const [applying, setApplying] = useState(false);
	const [applyError, setApplyError] = useState("");
	const { getEngine, selectNetwork, resolveDeviceSigner } = useApp();
	const handleDeviceSigningError = useDeviceSigningErrorHandler();
	const promptRecoveryKeyRegistrationIfNeeded = useRecoveryKeyRegistrationGate();
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NavigationProp>();
	const insets = useSafeAreaInsets();

	useEffect(() => {
		let cancelled = false;
		const loadNetwork = async () => {
			setNetworkLoadError("");
			try {
				const engine = await getEngine<INetworkEngine>("network", networkRef as NetworkReference);
				if (cancelled) return;
				setNetworkEngine(engine);
				const details = await engine.getDetails();
				if (cancelled) return;
				setNetworkDetails(details);
				// Which officer is looking — only their own SIGN button is live (AuthorizationSection).
				const currentUser = await engine.getCurrentUser();
				const currentUserSummaryId = (await currentUser?.getSummary())?.id;
				if (cancelled) return;
				setCurrentUserId(currentUserSummaryId);
			} catch (error) {
				if (cancelled) return;
				console.warn("Failed to load network details:", error instanceof Error ? error.name : typeof error);
				setNetworkLoadError(t("networkDetailsLoadFailed"));
			}
		};
		loadNetwork();
		return () => {
			cancelled = true;
		};
	}, [reloadNonce]);

	// Phase 8 plan 08-05 (D-14): compute a flat list of changed fields between
	// the current network and the proposed revision. Each entry is rendered as
	// one row in <ProposedChangesCard>. We compare normalized string forms so
	// numeric and array fields produce stable display values without
	// re-rendering the full NetworkDetailsComponent.
	const proposedChanges = useMemo<ProposedChange[]>(() => {
		const proposal = networkDetails?.proposed?.proposed;
		if (!proposal || !networkDetails) {
			return [];
		}
		const current = networkDetails.network;
		const out: ProposedChange[] = [];
		const push = (
			fieldLabel: string,
			oldVal: string | undefined,
			newVal: string | undefined,
		) => {
			const oldStr = oldVal ?? "";
			const newStr = newVal ?? "";
			if (oldStr !== newStr) {
				out.push({ field: fieldLabel, oldValue: oldStr, newValue: newStr });
			}
		};
		push(t("name"), current.name, proposal.name);
		push(t("imageUrl"), current.imageRef?.url, proposal.imageRef?.url);
		push(t("relays"), current.relays.join(", "), proposal.relays.join(", "));
		push(
			t("electionType"),
			String(current.policies.electionType),
			String(proposal.policies.electionType),
		);
		push(
			t("requiredTimestampAuthorities"),
			String(current.policies.numberRequiredTSAs),
			String(proposal.policies.numberRequiredTSAs),
		);
		return out;
	}, [networkDetails, t]);

	// Phase 16 plan 08 (item 1 / T-16-26): load the PRIMARY AUTHORITY by its own id.
	// EngineFactory.getEngine("authority", initParams) treats initParams as the AUTHORITY id
	// (networkEngine.openAuthority(initParams)). Passing the NETWORK id here produced
	// "Authority not found". Pass networkDetails.network.primaryAuthorityId, and short-circuit
	// when it is falsy so we never pass undefined into openAuthority.
	useEffect(() => {
		let cancelled = false;
		const loadPrimaryAuthority = async () => {
			if (!networkDetails) return;
			const primaryAuthorityId = networkDetails.network.primaryAuthorityId;
			if (!primaryAuthorityId) return;
			setAuthorityLoadError("");
			try {
				const authorityEngine = await getEngine<IAuthorityEngine>(
					"authority",
					primaryAuthorityId
				);
				if (cancelled) return;
				setPrimaryAuthorityEngine(authorityEngine);
				const details = await authorityEngine.getDetails();
				if (cancelled) return;
				setPrimaryAuthorityDetails(details);
				const administration = await authorityEngine.getAdminDetails();
				if (cancelled) return;
				if (__DEV__) console.info("[network-details] administration", administration);
				setPrimaryAuthorityAdmin(administration);
			} catch (error) {
				if (cancelled) return;
				console.warn("Failed to load primary authority details:", error instanceof Error ? error.name : typeof error);
				setAuthorityLoadError(t("networkDetailsLoadFailed"));
			}
		};
		loadPrimaryAuthority();
		return () => {
			cancelled = true;
		};
	}, [networkEngine, networkDetails, reloadNonce]);

	// Phase 16 plan 08 (item 2): make the tapped network the active/current network.
	// Re-resolving via getEngine("network", networkRef) re-points the EngineFactory's
	// currentNetworkHash to THIS ref's hash (item-3 fix in engine-factory.ts guarantees a
	// DIFFERENT ref re-binds rather than hitting the stale cache). NetworksEngine.open() also
	// writes the ref to the recentNetworks LocalStorage list, so no separate persistence is
	// needed. Then return to the network home; sibling screens (Elections/Authorities/Create)
	// resolve against the now-selected network.
	// "Sign" on the proposed revision = approve AND apply it: applyRevision signs the revision's
	// rn digest with this officer's device key and writes the new network row (servers, name,
	// image, TSA policy) under that signature in one transaction. Single-approver networks only;
	// the engine refuses (before writing) when the rn threshold needs more than one officer.
	const handleApplyRevision = useCallback(async () => {
		const proposal = networkDetails?.proposed?.proposed;
		const revision = networkDetails?.proposedRevision;
		if (!networkEngine || !proposal || revision === undefined) return;
		setApplyError("");
		setApplying(true);
		try {
			const sign = await resolveDeviceSigner();
			await networkEngine.applyRevision(proposal.name, revision, sign);
			setNetworkDetails(await networkEngine.getDetails());
		} catch (error) {
			const outcome = handleDeviceSigningError(error);
			if (outcome.handled) return;
			setApplyError(
				error instanceof Error && error.name === "FeatureNotAvailableError"
					? t("applyRevisionNeedsCoSigners")
					: outcome.message ?? t("applyRevisionFailed"),
			);
		} finally {
			setApplying(false);
		}
	}, [networkEngine, networkDetails, resolveDeviceSigner, handleDeviceSigningError, t]);

	const handleSelectNetwork = async () => {
		setSelectError("");
		try {
			// selectNetwork() binds the network AND flips AppProvider.hasNetwork so the
			// gated screens (Elections/Authorities) render immediately — previously this
			// only re-pointed the engine, leaving hasNetwork false until the next reboot.
			await selectNetwork(networkRef as NetworkReference);

			// 49-19 (recovery-key-registration gap): the join path reaches the same dead end the
			// create path does. ProvisionSigningKeyScreen's stage 2 registers the recovery key
			// only once a network `User` resolves, which cannot happen before this point, and
			// nothing previously brought the officer back to it -- leaving them one biometric
			// enrolment from a stranded device. The ceremony is idempotent and registers only
			// what is missing, so the gate below decides whether there is anything to do.
			// Checked BEFORE goBack() so the officer lands on the ceremony rather than having it
			// appear over the network home they just returned to. The ceremony replaces this
			// screen, so its `goBack()` exit lands where ours would have, not on these details.
			if (await promptRecoveryKeyRegistrationIfNeeded({ replaceCurrent: true })) return;
			navigation.goBack();
		} catch (error) {
			// A device with no signing key (`getOrCreateDeviceUser` rejects with code
			// NO_KEY_PROVISIONED) goes to the provisioning ceremony. Any other failure shows
			// translated copy, never the raw error text (it carried developer prose and an internal
			// decision id on a fresh second device).
			const outcome = handleDeviceSigningError(error);
			if (outcome.handled) return;
			console.warn("Failed to select network:", error instanceof Error ? error.name : typeof error);
			setSelectError(outcome.message ?? t("networkSelectFailed"));
		}
	};

	return (
		<ScrollView
			style={styles.container}
			contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
		>
			<InlineError message={loadError} />
			{!!loadError && (
				<CustomButton
					testID="network-details-retry"
					title={t("loadRetryButton")}
					icon="rotate"
					size="thin"
					onPress={() => setReloadNonce((n) => n + 1)}
				/>
			)}
			<View style={styles.section}>
				<ThemedText type="header">{networkDetails?.network.name}</ThemedText>
				<CustomButton
					title={t("select")}
					icon="chevron-left"
					rightIcon="cloud-rain"
					backgroundColor={colors.success}
					onPress={handleSelectNetwork}
				/>
				<InlineError message={selectError} />
				{networkDetails && primaryAuthorityDetails && (
					<NetworkDetailsComponent
						details={networkDetails}
						isProposed={false}
						primaryAuthorityDetails={primaryAuthorityDetails}
					/>
				)}

				<CustomButton
					title={t("reviseNetwork")}
					icon="pencil"
					backgroundColor={colors.accent}
					size="thin"
					onPress={() =>
						networkDetails &&
						navigation.navigate("NetworkRevision", {
							networkId: networkDetails.network.id,
						})
					}
				/>
				<CustomButton
					title={t("servers")}
					icon="database"
					backgroundColor={colors.accent}
					size="thin"
					onPress={() => navigation.navigate("Hosting")}
				/>
				<CustomButton
					title={t("share")}
					icon="share-nodes"
					backgroundColor={colors.accent}
					size="thin"
					disabled={true}
				/>
				{/* Phase 8 plan 08-06 (D-12): STATISTICS entry — navigates to the
				    standalone NetworkStatisticsScreen (NETUI-05, Figma frame 1425:1448). */}
				<CustomButton
					title={t("statistics")}
					icon="chart-column"
					backgroundColor={colors.accent}
					size="thin"
					onPress={() =>
						networkDetails &&
						navigation.navigate("NetworkStatistics", {
							networkId: networkDetails.network.id,
						})
					}
				/>
			</View>

			{networkDetails?.proposed && proposedChanges.length > 0 && (
				<View style={styles.section}>
					{/* D-14: flat InfoCard rendering of the diff between the current
					    network and the proposed revision. Replaces the prior heavyweight
					    full-re-render of NetworkDetailsComponent with isProposed=true. */}
					<ProposedChangesCard changes={proposedChanges} />
				</View>
			)}

			{networkDetails?.proposed && primaryAuthorityAdmin && (
				<View style={styles.section}>
					<AuthorizationSection
						admin={primaryAuthorityAdmin}
						currentUserId={currentUserId}
						onSign={handleApplyRevision}
						signing={applying}
						onAdjustProposal={() => {
							if (networkDetails) {
								navigation.navigate("NetworkRevision", {
									networkId: networkDetails.network.id,
								});
							}
						}}
					/>
					<InlineError message={applyError} />
				</View>
			)}
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({});

const styles = { ...globalStyles, ...localStyles };

export default NetworkDetailsScreen;
