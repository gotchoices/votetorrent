import { ScrollView, StyleSheet, View } from "react-native";
import { globalStyles } from "../../theme/styles";
import { ThemedText } from "../../components/ThemedText";
import { useTranslation } from "react-i18next";
import { ExtendedTheme, useRoute, useTheme } from "@react-navigation/native";
import {
	NetworkReference,
	AdminDetails,
	AuthorityDetails,
	IAuthorityEngine,
	INetworkEngine,
	NetworkDetails,
} from "@votetorrent/vote-core";
import { CustomButton } from "../../components/CustomButton";
import { useEffect, useState } from "react";
import { useApp } from "../../providers/AppProvider";
import NetworkDetailsComponent from "./components/NetworkDetailsComponent";
import { AuthorizationSection } from "../../components/AuthorizationSection";

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

	useEffect(() => {
		const loadPrimaryAuthority = async () => {
			if (!networkDetails) return;
			try {
				const authorityEngine = await getEngine<IAuthorityEngine>(
					"authority",
					networkDetails?.network.sid
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
		<ScrollView style={styles.container}>
			<View style={styles.section}>
				<ThemedText type="header">{networkDetails?.network.name}</ThemedText>
				<CustomButton
					title={t("select")}
					icon="chevron-left"
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
					onPress={() => {}}
				/>
				<CustomButton
					title={t("servers")}
					icon="database"
					backgroundColor={colors.accent}
					size="thin"
					onPress={() => {}}
				/>
				<CustomButton
					title={t("share")}
					icon="share-nodes"
					backgroundColor={colors.accent}
					size="thin"
					onPress={() => {}}
				/>
			</View>

			{networkDetails?.proposed && primaryAuthorityDetails && (
				<View style={styles.section}>
					<ThemedText type="title">{t("proposedChanges")}</ThemedText>
					<NetworkDetailsComponent
						details={networkDetails}
						isProposed={true}
						primaryAuthorityDetails={primaryAuthorityDetails}
					/>
				</View>
			)}

			{networkDetails?.proposed && primaryAuthorityAdmin && (
				<View style={styles.section}>
					<AuthorizationSection admin={primaryAuthorityAdmin} />
				</View>
			)}
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({});

const styles = { ...globalStyles, ...localStyles };

export default NetworkDetailsScreen;
