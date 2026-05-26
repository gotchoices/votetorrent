import {
	ExtendedTheme,
	useNavigation,
	useRoute,
	useTheme,
} from "@react-navigation/native";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	Image,
	ScrollView,
	StyleSheet,
	TouchableOpacity,
	View,
} from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { CustomTextInput } from "../../components/CustomTextInput";
import { ThemedText } from "../../components/ThemedText";
import { useApp } from "../../providers/AppProvider";
import { globalStyles } from "../../theme/styles";
import type { NavigationProp } from "../../navigation/types";
import type { INetworkEngine } from "@votetorrent/vote-core";

/**
 * NetworkRevisionScreen (Phase 8 plan 08-06, NETUI-06, D-13).
 *
 * Figma frame `1885:1022`. Net-new screen distinct from `AddNetworkScreen`
 * (NO `mode` prop on AddNetworkScreen per D-13). Pre-populates the form
 * fields from `INetworkEngine.getDetails().network` and renders a PROPOSE
 * stub footer (D-15 stub pattern — `console.log` + `navigation.goBack()`).
 */
export default function NetworkRevisionScreen() {
	const { networkId: _networkId } = useRoute().params as { networkId: string };
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const navigation = useNavigation<NavigationProp>();
	const { getEngine } = useApp();
	const scrollViewRef = useRef<ScrollView>(null);

	const [name, setName] = useState("");
	const [imageUrl, setImageUrl] = useState("");
	const [relayAddresses, setRelayAddresses] = useState<string[]>([""]);
	const [electionType, setElectionType] = useState("");
	const [numberRequiredTSAs, setNumberRequiredTSAs] = useState("");
	const [showAdvanced, setShowAdvanced] = useState(false);

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("reviseNetwork") });
	}, [navigation, t]);

	useEffect(() => {
		const load = async () => {
			try {
				const engine = await getEngine<INetworkEngine>("network");
				const details = await engine.getDetails();
				setName(details.network.name);
				setImageUrl(details.network.imageRef?.url ?? "");
				setRelayAddresses(
					details.network.relays.length > 0 ? details.network.relays : [""],
				);
				setElectionType(String(details.network.policies.electionType));
				setNumberRequiredTSAs(
					String(details.network.policies.numberRequiredTSAs),
				);
			} catch (error) {
				console.error("Failed to load network details for revision:", error);
			}
		};
		load();
	}, [getEngine]);

	const toggleAdvanced = () => {
		if (!showAdvanced) {
			setTimeout(() => {
				scrollViewRef.current?.scrollToEnd({ animated: true });
			}, 100);
		}
		setShowAdvanced(!showAdvanced);
	};

	const addRelayField = () => {
		setRelayAddresses([...relayAddresses, ""]);
	};

	const updateRelayAddress = (index: number, value: string) => {
		const next = [...relayAddresses];
		next[index] = value;
		setRelayAddresses(next);
	};

	const removeRelayField = (index: number) => {
		if (relayAddresses.length > 1) {
			setRelayAddresses(relayAddresses.filter((_, i) => i !== index));
		}
	};

	return (
		<View style={styles.content}>
			<ScrollView ref={scrollViewRef} style={styles.container}>
				<ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
					{t("networkRevision")}
				</ThemedText>

				<View style={styles.section}>
					<CustomTextInput
						title={t("name")}
						value={name}
						onChangeText={setName}
					/>
					<CustomTextInput
						title={t("imageUrl")}
						value={imageUrl}
						placeholder={t("optionalImageAddress")}
						onChangeText={setImageUrl}
					/>
					{imageUrl ? (
						<Image
							source={{ uri: imageUrl }}
							style={styles.previewImage}
							resizeMode="cover"
						/>
					) : null}
				</View>

				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t("policies")}
					</ThemedText>
					<CustomTextInput
						title={t("electionType")}
						value={electionType}
						onChangeText={setElectionType}
					/>
					<CustomTextInput
						title={t("requiredTimestampAuthorities")}
						value={numberRequiredTSAs}
						onChangeText={setNumberRequiredTSAs}
					/>
				</View>

				<TouchableOpacity
					style={styles.advancedHeader}
					onPress={toggleAdvanced}
				>
					<FontAwesome6
						name={showAdvanced ? "chevron-down" : "chevron-right"}
						size={14}
						color={colors.text}
					/>
					<ThemedText type="default">{t("advanced")}</ThemedText>
				</TouchableOpacity>
				{showAdvanced ? (
					<View style={styles.section}>
						<View style={[styles.buttonHeader, styles.sectionTitle]}>
							<ThemedText type="title">{t("relays")}</ThemedText>
							<ChipButton
								label={t("import")}
								icon="circle-plus"
								onPress={() => console.log("importRelays stub")}
							/>
						</View>
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
							<ChipButton
								label={t("addRelay")}
								icon="circle-plus"
								onPress={addRelayField}
							/>
						</View>
					</View>
				) : null}
			</ScrollView>

			<View style={[styles.footer, { backgroundColor: colors.card }]}>
				<CustomButton
					title={t("propose")}
					icon="floppy-disk"
					backgroundColor={colors.success}
					forceDarkText={true}
					onPress={() => {
						console.log("networkRevision-propose stub");
						navigation.goBack();
					}}
				/>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	buttonHeader: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
	},
	previewImage: {
		marginTop: 8,
		height: 200,
		borderRadius: 16,
	},
	advancedHeader: {
		flexDirection: "row",
		alignItems: "center",
		gap: 16,
		marginBottom: 16,
	},
});

const styles = { ...globalStyles, ...localStyles };
