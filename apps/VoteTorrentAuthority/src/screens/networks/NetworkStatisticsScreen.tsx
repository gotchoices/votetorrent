import {
	ExtendedTheme,
	useNavigation,
	useRoute,
	useTheme,
} from "@react-navigation/native";
import { useEffect, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { CustomButton } from "../../components/CustomButton";
import { ThemedText } from "../../components/ThemedText";
import { useApp } from "../../providers/AppProvider";
import { globalStyles } from "../../theme/styles";
import type { NavigationProp } from "../../navigation/types";
import type { INetworkEngine } from "@votetorrent/vote-core";

/**
 * NetworkStatisticsScreen (Phase 8 plan 08-06, NETUI-05, D-15).
 *
 * Figma frame `1425:1448`. Standalone screen reached from
 * `NetworkDetailsScreen`'s STATISTICS button (D-12). Renders two stat rows
 * (estimatedNodes, serverCount) sourced from `INetworkEngine.getStatistics()`
 * (static mock numbers per D-15) plus an ADD SERVERS stub.
 */
export default function NetworkStatisticsScreen() {
	const { networkId: _networkId } = useRoute().params as { networkId: string };
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const navigation = useNavigation<NavigationProp>();
	const { getEngine } = useApp();
	const [stats, setStats] = useState<{
		estimatedNodes: number;
		serverCount: number;
	} | null>(null);

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("statistics") });
	}, [navigation, t]);

	useEffect(() => {
		const load = async () => {
			try {
				const engine = await getEngine<INetworkEngine>("network");
				const s = await engine.getStatistics();
				setStats(s);
			} catch (error) {
				console.error("Failed to load network statistics:", error);
			}
		};
		load();
	}, [getEngine]);

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t("statistics")}
					</ThemedText>
					<View style={styles.statRow}>
						<ThemedText type="defaultSemiBold">{t("estimatedNodes")}</ThemedText>
						<ThemedText type="defaultSemiBold">
							{stats?.estimatedNodes ?? "-"}
						</ThemedText>
					</View>
					<View style={styles.statRow}>
						<ThemedText type="defaultSemiBold">
							{t("estimatedServers")}
						</ThemedText>
						<ThemedText type="defaultSemiBold">
							{stats?.serverCount ?? "-"}
						</ThemedText>
					</View>
				</View>

				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t("addServersToThisNetwork")}
					</ThemedText>
					<CustomButton
						title={t("addServers")}
						icon="circle-plus"
						backgroundColor={colors.accent}
						onPress={() => {
							console.log("addServers stub");
							navigation.goBack();
						}}
					/>
				</View>
			</ScrollView>
		</View>
	);
}

const localStyles = StyleSheet.create({
	statRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		marginBottom: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
