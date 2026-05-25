import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
import { ChipButton } from "../../components/ChipButton";
import { InfoCard } from "../../components/InfoCard";
import { ThemedText } from "../../components/ThemedText";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import type {
	Authority,
	Admin,
	IAuthorityEngine,
	INetworkEngine,
	AdminDetails,
	User,
	Officer,
} from "@votetorrent/vote-core";
import { scopeDescriptions } from "@votetorrent/vote-core";
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
				await networkEngine?.unpinAuthority(authority.id);
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
					const authorityEngine = await (engine as INetworkEngine).openAuthority(authority.id);
					setAuthorityEngine(authorityEngine);
				}
			} catch (error) {
				console.error("Error loading engines:", error);
			}
		}
		loadEngines();
	}, [getEngine, authority.id]);

	useEffect(() => {
		async function getAuthorityData() {
			if (!networkEngine || !authorityEngine) {
				setPinned(false);
				setAdminDetails(null);
				return;
			}
			try {
				const pinnedAuthorities = await networkEngine.getPinnedAuthorities();
				setPinned(pinnedAuthorities.some((a: Authority) => a.id === authority.id));
				const details = await authorityEngine.getAdminDetails();
				setAdminDetails(details);
			} catch (error) {
				console.error("Error checking pinned status:", error);
				setPinned(false);
				setAdminDetails(null);
			}
		}
		getAuthorityData();
	}, [networkEngine, authorityEngine, authority.id]);

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

				// Create mapping of userId to User object
				const userMap = new Map<string, User>();

				// Get all userIds we need to fetch (both current and proposed existing officers)
				const userIds = new Set<string>();

				// Add current officers
				adminDetails.admin.officers.forEach((admin) => {
					userIds.add(admin.userId);
				});

				// Add proposed existing administrators
				if (adminDetails.proposed?.proposed.officers) {
					adminDetails.proposed.proposed.officers.forEach((officerSelection) => {
						if (officerSelection.existing) {
							userIds.add(officerSelection.existing.userId);
						}
					});
				}

				// Fetch all users
				const userEnginePromises = Array.from(userIds).map(async (userId) => {
					const userEngine = await networkEngine.getUser(userId);
					if (userEngine) {
						const details = await userEngine.getSummary();
						if (details) {
							userMap.set(userId, details);
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
					<ThemedText type="defaultSemiBold">{t("domain")}: </ThemedText>
					<ThemedText numberOfLines={1} ellipsizeMode="tail">
						{authority.domainName}
					</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("cid")}: </ThemedText>
					<ThemedText numberOfLines={1} ellipsizeMode="tail">
						{authority.id}
					</ThemedText>
				</View>
				{authority.imageRef?.url ? (
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("imageUrl")}: </ThemedText>
						<ThemedText numberOfLines={1} ellipsizeMode="tail">
							{authority.imageRef.url}
						</ThemedText>
					</View>
				) : null}
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

				{(() => {
					const adminSignatures = (adminDetails?.admin as any)?.signatures as
						| Array<{ signerKey?: string; signature?: string }>
						| undefined;
					if (!adminSignatures || adminSignatures.length === 0) return null;
					return (
						<View>
							<View style={styles.detail}>
								<ThemedText type="defaultSemiBold">{t("handoffSignatures")}: </ThemedText>
							</View>
							<View style={styles.subDetails}>
								{adminSignatures.map((signature, idx) => (
									<View key={signature.signerKey ?? idx} style={styles.detail}>
										<ThemedText type="default" numberOfLines={1} ellipsizeMode="middle">
											{signature.signerKey}
										</ThemedText>
										<ThemedText> ({t("signature")})</ThemedText>
									</View>
								))}
							</View>
						</View>
					);
				})()}
				{adminDetails?.admin.id ? (
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("cid")}: </ThemedText>
						<ThemedText numberOfLines={1} ellipsizeMode="tail">
							{adminDetails.admin.id}
						</ThemedText>
					</View>
				) : null}
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("expires")}: </ThemedText>
					<ThemedText>{formatDate(adminDetails?.admin.effectiveAt)}</ThemedText>
				</View>

				{officers.map((officer) => {
					const user = officerUsers.get(officer.userId);
					return (
						<InfoCard
							key={officer.userId}
							image={user?.image?.url ? { uri: user.image.url } : undefined}
							title={user?.name || ""}
							subtitle={officer.title}
							additionalInfo={[
								{ label: t("cid"), value: officer.userId },
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
						{adminDetails.admin.id ? (
							<View style={styles.detail}>
								<ThemedText type="defaultSemiBold">{t("cid")}: </ThemedText>
								<ThemedText numberOfLines={1} ellipsizeMode="tail">
									{adminDetails.admin.id}
								</ThemedText>
							</View>
						) : null}
						<View style={styles.detail}>
							<ThemedText type="defaultSemiBold">{t("expires")}: </ThemedText>
							<ThemedText>{formatDate(adminDetails.proposed.proposed.effectiveAt)}</ThemedText>
						</View>
						<ThemedText type="defaultSemiBold" style={styles.administratorsHeading}>
							{t("administrators")}
						</ThemedText>
						{adminDetails.proposed.proposed.officers.map((officerSelection) => {
							const officer = officerSelection.existing || {
								userId: "",
								title: officerSelection.init?.title || "",
								scopes: officerSelection.init?.scopes || [],
								signature: { signature: "", signerKey: "" },
							};
							const user = officer.userId ? officerUsers.get(officer.userId) : undefined;
							const name = user?.name || officerSelection.init?.name || "";
							const isAccepted = !!officerSelection.existing;
							const statusText = isAccepted
								? `${t("accepted")} - CID: ${officer.userId}`
								: t("sent");

							return (
								<View key={officer.userId || officerSelection.init?.name} style={styles.officerCard}>
									<View style={styles.detail}>
										<ThemedText type="defaultSemiBold">{t("name")}: </ThemedText>
										<ThemedText>{name}</ThemedText>
									</View>
									<View style={styles.detail}>
										<ThemedText type="defaultSemiBold">{t("title")}: </ThemedText>
										<ThemedText style={styles.italicText}>{officer.title}</ThemedText>
									</View>
									<View style={styles.detail}>
										<ThemedText type="defaultSemiBold">{t("inviteId")}: </ThemedText>
										<ThemedText numberOfLines={1} ellipsizeMode="tail">
											{officer.userId || t("pending")}
										</ThemedText>
									</View>
									<ThemedText type="defaultSemiBold">{t("permissions")}:</ThemedText>
									<View style={styles.subDetails}>
										{officer.scopes.map((scope) => (
											<View key={scope} style={styles.bulletRow}>
												<ThemedText>{"• "}</ThemedText>
												<ThemedText>{scopeDescriptions[scope] || scope}</ThemedText>
											</View>
										))}
									</View>
									<View style={styles.officerStatusRow}>
										<ThemedText style={{ color: isAccepted ? colors.success : colors.warning }}>
											{statusText}
										</ThemedText>
										<View style={styles.officerActions}>
											<ChipButton label={t("invite")} icon="share-nodes" onPress={() => {}} />
											<TouchableOpacity
												style={[styles.removeButton, { borderColor: colors.error }]}
											>
												<FontAwesome6 name="xmark" size={12} color={colors.error} />
											</TouchableOpacity>
										</View>
									</View>
								</View>
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
	administratorsHeading: {
		marginTop: 12,
		marginBottom: 4,
	},
	officerCard: {
		marginTop: 12,
		paddingTop: 12,
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: "#D0D0D0",
		gap: 2,
	},
	italicText: {
		fontStyle: "italic",
	},
	bulletRow: {
		flexDirection: "row",
	},
	officerStatusRow: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		marginTop: 6,
	},
	officerActions: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	removeButton: {
		width: 28,
		height: 28,
		borderRadius: 14,
		borderWidth: 1.5,
		alignItems: "center",
		justifyContent: "center",
	},
});

const styles = { ...globalStyles, ...localStyles };
