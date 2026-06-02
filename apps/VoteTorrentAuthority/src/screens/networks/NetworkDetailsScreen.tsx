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
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../../providers/AppProvider";
import NetworkDetailsComponent from "./components/NetworkDetailsComponent";
import { AuthorizationSection } from "../../components/AuthorizationSection";
import type { NavigationProp } from "../../navigation/types";
import {
	ProposedChange,
	ProposedChangesCard,
} from "./components/ProposedChangesCard";

export function NetworkDetailsScreen() {
	const { networkRef } = useRoute().params as { networkRef: NetworkReference };
	const [networkEngine, setNetworkEngine] = useState<INetworkEngine>();
	const [networkDetails, setNetworkDetails] = useState<NetworkDetails>();
	const [primaryAuthorityEngine, setPrimaryAuthorityEngine] = useState<IAuthorityEngine>();
	const [primaryAuthorityDetails, setPrimaryAuthorityDetails] = useState<AuthorityDetails>();
	const [primaryAuthorityAdmin, setPrimaryAuthorityAdmin] = useState<AdminDetails>();
	const { getEngine } = useApp();
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NavigationProp>();
	const insets = useSafeAreaInsets();

	useEffect(() => {
		const loadNetwork = async () => {
			try {
				const engine = await getEngine<INetworkEngine>("network", networkRef as NetworkReference);
				setNetworkEngine(engine);
				const details = await engine.getDetails();
				setNetworkDetails(details);
			} catch (error) {
				console.error("Failed to load network details:", error);
			}
		};
		loadNetwork();
	}, []);

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

	useEffect(() => {
		const loadPrimaryAuthority = async () => {
			if (!networkDetails) return;
			try {
				const authorityEngine = await getEngine<IAuthorityEngine>(
					"authority",
					networkDetails?.network.id
				);
				setPrimaryAuthorityEngine(authorityEngine);
				const details = await authorityEngine.getDetails();
				setPrimaryAuthorityDetails(details);
				const administration = await authorityEngine.getAdminDetails();
				console.log("administration", administration);
				setPrimaryAuthorityAdmin(administration);
			} catch (error) {
				console.error("Failed to load primary authority details:", error);
			}
		};
		loadPrimaryAuthority();
	}, [networkEngine, networkDetails]);

	return (
		<ScrollView
			style={styles.container}
			contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
		>
			<View style={styles.section}>
				<ThemedText type="header">{networkDetails?.network.name}</ThemedText>
				<CustomButton
					title={t("select")}
					icon="chevron-left"
					rightIcon="cloud-rain"
					backgroundColor={colors.success}
					onPress={() => {}}
				/>
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
					onPress={() =>
						console.log("share network stub", networkDetails?.network.name)
					}
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
						onAdjustProposal={() => {
							if (networkDetails) {
								navigation.navigate("NetworkRevision", {
									networkId: networkDetails.network.id,
								});
							}
						}}
					/>
				</View>
			)}
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({});

const styles = { ...globalStyles, ...localStyles };

export default NetworkDetailsScreen;
