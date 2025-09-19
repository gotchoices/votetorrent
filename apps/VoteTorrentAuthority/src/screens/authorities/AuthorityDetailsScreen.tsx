import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, ScrollView, StyleSheet, View } from "react-native";
import { ChipButton } from "../../components/ChipButton";
import { InfoCard } from "../../components/InfoCard";
import { ThemedText } from "../../components/ThemedText";
import type {
	Authority,
	Admin,
	IAuthorityEngine,
	INetworkEngine,
	AdminDetails,
	User,
	Officer,
} from "@votetorrent/vote-core";
import { ExtendedTheme, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import { CustomButton } from "../../components/CustomButton";
import type { RootStackParamList } from "../../navigation/types";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useApp } from "../../providers/AppProvider";
import { AuthorizationSection } from "../../components/AuthorizationSection";
import { globalStyles } from "../../theme/styles";
import { formatDate } from "../../utils/displayUtils";

export default function AuthorityDetailsScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const { authority } = useRoute().params as { authority: Authority };
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { getEngine } = useApp();
	const [networkEngine, setNetworkEngine] = useState<INetworkEngine | null>(null);
	const [authorityEngine, setAuthorityEngine] = useState<IAuthorityEngine | null>(null);
	const [pinned, setPinned] = useState(false);
	const [adminDetails, setAdminDetails] = useState<AdminDetails | null>(null);
	const [officerUsers, setOfficerUsers] = useState<Map<string, User>>(new Map());
	const [officers, setOfficers] = useState<Officer[]>([]);

	const handlePinToggle = async () => {
		try {
			if (pinned) {
				await networkEngine?.unpinAuthority(authority.sid);
			} else {
				await networkEngine?.pinAuthority(authority);
			}
			setPinned(!pinned);
		} catch (error) {
			console.error("Error toggling authority pin:", error);
		}
	};

	useEffect(() => {
		async function loadEngines() {
			try {
				const engine = await getEngine("network");
				setNetworkEngine(engine as INetworkEngine);
				if (engine) {
					const authorityEngine = await (engine as INetworkEngine).openAuthority(authority.sid);
					setAuthorityEngine(authorityEngine);
				}
			} catch (error) {
				console.error("Error loading engines:", error);
			}
		}
		loadEngines();
	}, [getEngine, authority.sid]);

	useEffect(() => {
		async function getAuthorityData() {
			if (!networkEngine || !authorityEngine) {
				setPinned(false);
				setAdminDetails(null);
				return;
			}
			try {
				const pinnedAuthorities = await networkEngine.getPinnedAuthorities();
				setPinned(pinnedAuthorities.some((a: Authority) => a.sid === authority.sid));
				const details = await authorityEngine.getAdminDetails();
				setAdminDetails(details);
			} catch (error) {
				console.error("Error checking pinned status:", error);
				setPinned(false);
				setAdminDetails(null);
			}
		}
		getAuthorityData();
	}, [networkEngine, authorityEngine, authority.sid]);

	useEffect(() => {
		async function getUsers() {
			if (!networkEngine || !adminDetails) {
				setOfficers([]);
				setOfficerUsers(new Map());
				return;
			}

			try {
				// Store the officers list
				setOfficers(adminDetails.admin.officers);

				// Create mapping of userSid to User object
				const userMap = new Map<string, User>();

				// Get all userSids we need to fetch (both current and proposed existing officers)
				const userSids = new Set<string>();

				// Add current officers
				adminDetails.admin.officers.forEach((admin) => {
					userSids.add(admin.userSid);
				});

				// Add proposed existing administrators
				if (adminDetails.proposed?.proposed.officers) {
					adminDetails.proposed.proposed.officers.forEach((officerSelection) => {
						if (officerSelection.existing) {
							userSids.add(officerSelection.existing.userSid);
						}
					});
				}

				// Fetch all users
				const userEnginePromises = Array.from(userSids).map(async (userSid) => {
					const userEngine = await networkEngine.getUser(userSid);
					if (userEngine) {
						const details = await userEngine.getSummary();
						if (details) {
							userMap.set(userSid, details);
						}
					}
				});
				await Promise.all(userEnginePromises);
				setOfficerUsers(userMap);
			} catch (error) {
				console.error("Error fetching users:", error);
				setOfficers([]);
				setOfficerUsers(new Map());
			}
		}
		getUsers();
	}, [networkEngine, adminDetails]);

	useEffect(() => {
		navigation.setOptions({
			headerRight: () => (
				<ChipButton
					label={pinned ? t("unpin") : t("pin")}
					icon={pinned ? "thumbtack-slash" : "thumbtack"}
					onPress={handlePinToggle}
				/>
			),
		});
	}, [pinned, navigation, t, handlePinToggle]);

	if (!authority || !networkEngine) {
		return null;
	}

	return (
		<ScrollView style={styles.container}>
			<View style={styles.section}>
				<View style={styles.imageContainer}>
					<Image source={{ uri: authority.imageRef?.url }} style={styles.authorityImage} />
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("name")}: </ThemedText>
					<ThemedText numberOfLines={1} ellipsizeMode="tail">
						{authority.name}
					</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("domainName")}: </ThemedText>
					<ThemedText numberOfLines={1} ellipsizeMode="tail">
						{authority.domainName}
					</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("sid")}: </ThemedText>
					<ThemedText numberOfLines={1} ellipsizeMode="tail">
						{authority.sid}
					</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("imageUrl")}: </ThemedText>
					<ThemedText numberOfLines={1} ellipsizeMode="tail">
						{authority.imageRef?.url}
					</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("address")}: </ThemedText>
					<ThemedText numberOfLines={1} ellipsizeMode="tail">
						{authority.domainName}
					</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("signature")}: </ThemedText>
					<ThemedText numberOfLines={1} ellipsizeMode="tail">
						{authority.signature.signature}
					</ThemedText>
				</View>
				<CustomButton
					title={t("reviseAuthority")}
					icon="pencil"
					size="thin"
					backgroundColor={colors.accent}
					onPress={() => {}}
				/>
			</View>

			<View style={styles.section}>
				<ThemedText type="title">{t("administration")}</ThemedText>

				{adminDetails?.admin.signatures && (
					<View>
						<View style={styles.detail}>
							<ThemedText type="defaultSemiBold">{t("handoffSignature")}: </ThemedText>
						</View>
						<View style={styles.subDetails}>
							{adminDetails.admin.signatures.map((signature) => (
								<View style={styles.detail}>
									<ThemedText type="default">{signature.signerKey}: </ThemedText>
									<ThemedText>{signature.signature}</ThemedText>
								</View>
							))}
						</View>
					</View>
				)}
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("expires")}: </ThemedText>
					<ThemedText>{formatDate(adminDetails?.admin.expiration)}</ThemedText>
				</View>

				{officers.map((officer) => {
					const user = officerUsers.get(officer.userSid);
					return (
						<InfoCard
							key={officer.userSid}
							image={{ uri: user?.image.url || "" }}
							title={user?.name || ""}
							additionalInfo={[
								{
									label: t("title"),
									value: officer.title,
								},
								{ label: t("sid"), value: officer.userSid },
							]}
							icon="chevron-right"
							onPress={() =>
								navigation.navigate("OfficerDetails", {
									officer: officer,
								})
							}
						/>
					);
				})}

				{!adminDetails?.proposed && (
					<CustomButton
						title={t("reviseAdministration")}
						icon="pencil"
						size="thin"
						onPress={() =>
							navigation.navigate("ReplaceAdmin", {
								authority: authority,
							})
						}
					/>
				)}
			</View>

			{adminDetails?.proposed && (
				<View>
					<View style={styles.section}>
						<ThemedText type="title">{t("proposedAdministration")}</ThemedText>
						{adminDetails.proposed.proposed.officers.map((officerSelection) => {
							const officer = officerSelection.existing || {
								userSid: "",
								title: officerSelection.init?.title || "",
								scopes: officerSelection.init?.scopes || [],
								signature: { signature: "", signerKey: "" },
							};
							const user = officer.userSid ? officerUsers.get(officer.userSid) : undefined;
							return (
								<InfoCard
									key={officer.userSid || officerSelection.init?.name}
									image={user?.image?.url ? { uri: user.image.url } : undefined}
									title={user?.name || officerSelection.init?.name || ""}
									additionalInfo={[
										{
											label: t("title"),
											value: officer.title,
										},
										{ label: t("sid"), value: officer.userSid || t("pending") },
									]}
									icon="chevron-right"
									onPress={() =>
										navigation.navigate("OfficerDetails", {
											officer: officer,
										})
									}
								/>
							);
						})}
					</View>

					<AuthorizationSection admin={adminDetails} />
				</View>
			)}
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	imageContainer: {
		position: "relative",
		width: 200,
		height: 200,
		alignSelf: "center",
		marginVertical: 16,
	},
	authorityImage: {
		width: "100%",
		height: "100%",
		borderRadius: 8,
	},
	detail: {
		flexDirection: "row",
	},
	subDetails: {
		marginLeft: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
