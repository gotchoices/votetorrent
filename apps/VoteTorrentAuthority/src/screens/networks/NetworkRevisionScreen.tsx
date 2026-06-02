import {
	ExtendedTheme,
	useNavigation,
	useRoute,
	useTheme,
} from "@react-navigation/native";
import { useEffect, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	Image,
	ScrollView,
	StyleSheet,
	TouchableOpacity,
	View,
} from "react-native";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { CustomTextInput } from "../../components/CustomTextInput";
import { ThemedText } from "../../components/ThemedText";
import { useApp } from "../../providers/AppProvider";
import { globalStyles } from "../../theme/styles";
import type { NavigationProp } from "../../navigation/types";
import { ElectionType, type INetworkEngine } from "@votetorrent/vote-core";

export default function NetworkRevisionScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const navigation = useNavigation<NavigationProp>();
	const { getEngine } = useApp();
	// networkId param reserved for when the engine is keyed per authority
	const { networkId: _networkId } = useRoute().params as { networkId: string };

	const [name, setName] = useState("");
	const [imageUrl, setImageUrl] = useState("");
	const [electionType, setElectionType] = useState<ElectionType>(ElectionType.adhoc);
	const [relayAddresses, setRelayAddresses] = useState<string[]>([""]);
	const [tsaUrls, setTsaUrls] = useState<string[]>([""]);
	const [numberRequiredTSAs, setNumberRequiredTSAs] = useState("1");

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
				setElectionType(details.network.policies.electionType);
				setNumberRequiredTSAs(
					String(details.network.policies.numberRequiredTSAs),
				);
				const tsas = details.network.policies.timestampAuthorities;
				setTsaUrls(tsas.length > 0 ? tsas.map(tsa => tsa.url) : [""]);
			} catch (error) {
				console.error("Failed to load network details for revision:", error);
			}
		};
		load();
	}, [getEngine]);

	const addRelayField = () => setRelayAddresses([...relayAddresses, ""]);
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

	const addTsaField = () => setTsaUrls([...tsaUrls, ""]);
	const updateTsaUrl = (index: number, value: string) => {
		const next = [...tsaUrls];
		next[index] = value;
		setTsaUrls(next);
	};
	const removeTsaField = (index: number) => {
		if (tsaUrls.length > 1) {
			setTsaUrls(tsaUrls.filter((_, i) => i !== index));
		}
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
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
						isImageUrlField
						makePermanentPressed={() => console.log("makePermanent stub")}
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
					<ThemedText type="defaultSemiBold" style={styles.fieldLabel}>
						{t("electionType")}
					</ThemedText>
					<View style={styles.radioRow}>
						<TouchableOpacity
							style={styles.radioOption}
							onPress={() => setElectionType(ElectionType.adhoc)}
						>
							<View style={[styles.radioOuter, { borderColor: electionType === ElectionType.adhoc ? colors.primary : colors.textSecondary }]}>
								{electionType === ElectionType.adhoc && (
									<View style={[styles.radioInner, { backgroundColor: colors.primary }]} />
								)}
							</View>
							<ThemedText style={styles.radioLabel}>{t("adhoc")}</ThemedText>
						</TouchableOpacity>
						<TouchableOpacity
							style={styles.radioOption}
							onPress={() => setElectionType(ElectionType.official)}
						>
							<View style={[styles.radioOuter, { borderColor: electionType === ElectionType.official ? colors.primary : colors.textSecondary }]}>
								{electionType === ElectionType.official && (
									<View style={[styles.radioInner, { backgroundColor: colors.primary }]} />
								)}
							</View>
							<ThemedText style={styles.radioLabel}>{t("official")}</ThemedText>
						</TouchableOpacity>
					</View>
				</View>

				<View style={styles.section}>
					<View style={styles.sectionHeader}>
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
							icon={relayAddresses.length > 1 ? "trash" : undefined}
							onIconPress={() => removeRelayField(index)}
						/>
					))}
					<View style={styles.addButtonRow}>
						<ChipButton
							label={t("addRelay")}
							icon="circle-plus"
							onPress={addRelayField}
						/>
					</View>
				</View>

				<View style={styles.section}>
					<ThemedText type="title">{t("timestampAuthorities")}</ThemedText>
					<View style={styles.importRow}>
						<ChipButton
							label={t("import")}
							icon="circle-plus"
							onPress={() => console.log("importTsas stub")}
						/>
					</View>
					{tsaUrls.map((url, index) => (
						<CustomTextInput
							key={index}
							placeholder="ts://timestamp.authority"
							value={url}
							onChangeText={(value) => updateTsaUrl(index, value)}
							icon={tsaUrls.length > 1 ? "trash" : undefined}
							onIconPress={() => removeTsaField(index)}
						/>
					))}
					<View style={styles.addButtonRow}>
						<ChipButton
							label={t("addTsa")}
							icon="circle-plus"
							onPress={addTsaField}
						/>
					</View>
					<CustomTextInput
						title={t("requiredTimestampAuthorities")}
						value={numberRequiredTSAs}
						keyboardType="numeric"
						onChangeText={setNumberRequiredTSAs}
					/>
				</View>
			</ScrollView>

			<Footer>
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
			</Footer>
		</View>
	);
}

const localStyles = StyleSheet.create({
	previewImage: {
		marginTop: 8,
		height: 200,
		borderRadius: 16,
	},
	fieldLabel: {
		marginBottom: 8,
	},
	radioRow: {
		flexDirection: "row",
		gap: 24,
	},
	radioOption: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		paddingVertical: 4,
	},
	radioOuter: {
		width: 20,
		height: 20,
		borderRadius: 10,
		borderWidth: 2,
		alignItems: "center",
		justifyContent: "center",
	},
	radioInner: {
		width: 10,
		height: 10,
		borderRadius: 5,
	},
	radioLabel: {
		fontSize: 15,
	},
	sectionHeader: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		marginBottom: 8,
	},
	importRow: {
		flexDirection: "row",
		justifyContent: "flex-end",
		marginBottom: 8,
	},
	addButtonRow: {
		flexDirection: "row",
		justifyContent: "flex-end",
		marginTop: 4,
		marginBottom: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
