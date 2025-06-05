import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, ScrollView, StyleSheet, View } from "react-native";
import { ChipButton } from "../../components/ChipButton";
import { InfoCard } from "../../components/InfoCard";
import { ThemedText } from "../../components/ThemedText";
import type {
	Authority,
	Administration,
	IAuthorityEngine,
	INetworkEngine,
	AdministrationDetails,
	User,
	Administrator,
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
	const [administrationDetails, setAdministrationDetails] = useState<AdministrationDetails | null>(
		null
	);
	const [administratorUsers, setAdministratorUsers] = useState<Map<string, User>>(new Map());
	const [administrators, setAdministrators] = useState<Administrator[]>([]);

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
				setAdministrationDetails(null);
				return;
			}
			try {
				const pinnedAuthorities = await networkEngine.getPinnedAuthorities();
				setPinned(pinnedAuthorities.some((a: Authority) => a.sid === authority.sid));
				const details = await authorityEngine.getAdministrationDetails();
				setAdministrationDetails(details);
			} catch (error) {
				console.error("Error checking pinned status:", error);
				setPinned(false);
				setAdministrationDetails(null);
			}
		}
		getAuthorityData();
	}, [networkEngine, authorityEngine, authority.sid]);

	useEffect(() => {
		async function getUsers() {
			if (!networkEngine || !administrationDetails) {
				setAdministrators([]);
				setAdministratorUsers(new Map());
				return;
			}

			try {
				// Store the administrators list
				setAdministrators(administrationDetails.administration.administrators);

				// Create mapping of userSid to User object
				const userMap = new Map<string, User>();

				// Get all userSids we need to fetch (both current and proposed existing administrators)
				const userSids = new Set<string>();

				// Add current administrators
				administrationDetails.administration.administrators.forEach((admin) => {
					userSids.add(admin.userSid);
				});

				// Add proposed existing administrators
				if (administrationDetails.proposed?.proposed.administrators) {
					administrationDetails.proposed.proposed.administrators.forEach((adminSelection) => {
						if (adminSelection.existing) {
							userSids.add(adminSelection.existing.userSid);
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
				setAdministratorUsers(userMap);
			} catch (error) {
				console.error("Error fetching users:", error);
				setAdministrators([]);
				setAdministratorUsers(new Map());
			}
		}
		getUsers();
	}, [networkEngine, administrationDetails]);

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

				{administrationDetails?.administration.signatures && (
					<View>
						<View style={styles.detail}>
							<ThemedText type="defaultSemiBold">{t("handoffSignature")}: </ThemedText>
						</View>
						<View style={styles.subDetails}>
							{administrationDetails.administration.signatures.map((signature) => (
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
					<ThemedText>{formatDate(administrationDetails?.administration.expiration)}</ThemedText>
				</View>

				{administrators.map((admin) => {
					const user = administratorUsers.get(admin.userSid);
					return (
						<InfoCard
							key={admin.userSid}
							image={{ uri: user?.image.url || "" }}
							title={user?.name || ""}
							additionalInfo={[
								{
									label: t("title"),
									value: admin.title,
								},
								{ label: t("sid"), value: admin.userSid },
							]}
							icon="chevron-right"
							onPress={() =>
								navigation.navigate("AdministratorDetails", {
									administrator: admin,
								})
							}
						/>
					);
				})}

				{!administrationDetails?.proposed && (
					<CustomButton
						title={t("reviseAdministration")}
						icon="pencil"
						size="thin"
						onPress={() =>
							navigation.navigate("ReplaceAdministration", {
								authority: authority,
							})
						}
					/>
				)}
			</View>

			{administrationDetails?.proposed && (
				<View>
					<View style={styles.section}>
						<ThemedText type="title">{t("proposedAdministration")}</ThemedText>
						{administrationDetails.proposed.proposed.administrators.map((adminSelection) => {
							const admin = adminSelection.existing || {
								userSid: "",
								title: adminSelection.init?.title || "",
								scopes: adminSelection.init?.scopes || [],
							};
							const user = admin.userSid ? administratorUsers.get(admin.userSid) : undefined;
							return (
								<InfoCard
									key={admin.userSid || adminSelection.init?.name}
									image={user?.image?.url ? { uri: user.image.url } : undefined}
									title={user?.name || adminSelection.init?.name || ""}
									additionalInfo={[
										{
											label: t("title"),
											value: admin.title,
										},
										{ label: t("sid"), value: admin.userSid || t("pending") },
									]}
									icon="chevron-right"
									onPress={() =>
										navigation.navigate("AdministratorDetails", {
											administrator: admin,
										})
									}
								/>
							);
						})}
					</View>

					<AuthorizationSection administration={administrationDetails} />
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
