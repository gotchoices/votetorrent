import { ExtendedTheme, useTheme, useNavigation } from "@react-navigation/native";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
import { InfoCard } from "../../components/InfoCard";
import { ThemedText } from "../../components/ThemedText";
import { useApp } from "../../providers/AppProvider";
import type { AdornedNetworkReference } from "@votetorrent/vote-core";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import type { NavigationProp } from "../../navigation/types";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { globalStyles } from "../../theme/styles";
import { CustomTextInput } from "../../components/CustomTextInput";

export default function NetworksScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { networksEngine } = useApp();
	const [recentNetworkRefs, setRecentNetworkRefs] = useState<AdornedNetworkReference[]>([]);
	const navigation = useNavigation<NavigationProp>();

	useEffect(() => {
		async function loadNetworks() {
			if (!networksEngine) {
				return;
			}
			const networkRefs = await networksEngine.getRecentNetworks();
			setRecentNetworkRefs(networkRefs);
		}
		loadNetworks();
	}, [networksEngine]);

	useEffect(() => {
		navigation.setOptions({
			headerRight: () => (
				<ChipButton
					label={t("addNetwork")}
					icon={"circle-plus"}
					onPress={() => navigation.navigate("AddNetwork")}
				/>
			),
		});
	}, []);

	return (
		<ScrollView style={styles.container}>
			<View style={styles.section}>
				<ThemedText type="defaultSemiBold" style={styles.section}>
					{t("useOneOfTheFollowingToGetConnected")}
				</ThemedText>
				<ThemedText type="title">{t("recentNetworks")}</ThemedText>
				{recentNetworkRefs.map((networkRef) => (
					<View key={networkRef.hash} style={styles.networkContainer}>
						<View style={styles.infoCardContainer}>
							<InfoCard
								image={{ uri: networkRef.imageUrl }}
								title={networkRef.name}
								additionalInfo={[
									{
										label: t("address"),
										value: networkRef.primaryAuthorityDomainName,
									},
								]}
								onPress={() => navigation.navigate("NetworkDetails", { networkRef })}
							/>
						</View>
						<View style={styles.iconContainer}>
							<TouchableOpacity
								style={styles.iconButton}
								onPress={() => console.log("Share network:", networkRef.name)}
							>
								<FontAwesome6 name="share-nodes" size={20} color={colors.text} />
							</TouchableOpacity>
							<TouchableOpacity
								style={styles.iconButton}
								onPress={() => navigation.navigate("Hosting", { networkRef })}
							>
								<FontAwesome6 name="database" size={20} color={colors.text} />
							</TouchableOpacity>
						</View>
					</View>
				))}
			</View>

			<View style={styles.section}>
				<ThemedText type="title">{t("find")}</ThemedText>
				<CustomTextInput placeholder={t("enterAddressOrLocation")} />
				<CustomButton
					title={t("useLocation")}
					backgroundColor={colors.important}
					forceDarkText={true}
					onPress={() => console.log("Use location")}
				/>
			</View>

			<View style={styles.section}>
				<ThemedText type="title">{t("scanQrCode")}</ThemedText>
				<CustomButton title={t("scan")} icon="qrcode" onPress={() => console.log("Scan QR code")} />
			</View>

			<View style={styles.section}>
				<ThemedText type="title">{t("enterBootstrap")}</ThemedText>
				<CustomTextInput placeholder={t("enterBootstrapPlaceholder")} />
				<CustomButton title={t("connect")} onPress={() => console.log("Use bootstrap")} />
			</View>
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	networkContainer: {
		flexDirection: "row",
		alignItems: "center",
		marginBottom: 8,
	},
	infoCardContainer: {
		flex: 1,
		marginRight: 8,
	},
	iconContainer: {
		justifyContent: "space-between",
		height: 80,
	},
	iconButton: {
		padding: 8,
	},
	input: {
		marginTop: 8,
		padding: 16,
		borderRadius: 32,
		fontSize: 16,
		borderWidth: 1,
	},
});

const styles = { ...globalStyles, ...localStyles };
