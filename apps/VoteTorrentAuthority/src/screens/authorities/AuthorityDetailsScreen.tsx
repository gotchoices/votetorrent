import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, ScrollView, StyleSheet, View } from "react-native";
import { ChipButton } from "../../components/ChipButton";
import { ThemedText } from "../../components/ThemedText";
import type {
	Authority,
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
import { InfoCard } from "../../components/InfoCard";
import { CustomTextInput } from "../../components/CustomTextInput";
import { globalStyles } from "../../theme/styles";
import { formatDate } from "../../utils/displayUtils";
import { OfficerCard } from "./components/OfficerCard";

/** Shape the (forthcoming) real authority engine will provide for invited authorities. */
type InvitedAuthority = { name: string; status: "sent" | "unsent" };

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
	const [inviteSearch, setInviteSearch] = useState("");
	const [invitedAuthorities, setInvitedAuthorities] = useState<InvitedAuthority[]>([]);

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
		// Invited authorities are supplied by the real authority engine (to be
		// implemented). Bind defensively so this UI is ready without adding mock
		// data — the section renders empty until the engine provides the list.
		async function loadInvited() {
			const fn = (authorityEngine as any)?.getInvitedAuthorities;
			if (typeof fn !== "function") return;
			try {
				setInvitedAuthorities((await fn.call(authorityEngine)) ?? []);
			} catch (error) {
				console.error("Error loading invited authorities:", error);
			}
		}
		loadInvited();
	}, [authorityEngine]);

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
		<ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 32 }}>
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
				{(authority as any).address ? (
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("address")}: </ThemedText>
						<ThemedText numberOfLines={1} ellipsizeMode="middle">
							{(authority as any).address}
						</ThemedText>
					</View>
				) : null}
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("signature")}: </ThemedText>
					<ThemedText>[{t("valid")}]</ThemedText>
				</View>
				<CustomButton
					title={t("reviseAuthority")}
					icon="pencil"
					size="thin"
					backgroundColor={colors.accent}
					onPress={() => navigation.navigate("NetworkRevision", { networkId: authority.id })}
				/>
			</View>

			<View style={styles.section}>
				<ThemedText type="title">{t("administration")}</ThemedText>

				{(adminDetails?.admin as any)?.priorId ? (
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("priorCid")}: </ThemedText>
						<ThemedText numberOfLines={1} ellipsizeMode="tail">
							{(adminDetails?.admin as any).priorId}
						</ThemedText>
					</View>
				) : null}

				{(() => {
					const adminSignatures = (adminDetails?.admin as any)?.signatures as
						| Array<{ name?: string; signerKey?: string; valid?: boolean }>
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
										<ThemedText numberOfLines={1} ellipsizeMode="middle">
											{signature.name ? `${signature.name} ` : ""}[{signature.signerKey}]
										</ThemedText>
										<ThemedText> ({t("valid")})</ThemedText>
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
					// Figma frame 7: compact card (image · name · role · CID) + chevron.
					return (
						<InfoCard
							key={officer.userId}
							image={(user as any)?.image?.url ? { uri: (user as any).image.url } : undefined}
							title={user?.name || officer.userId}
							subtitle={officer.title}
							additionalInfo={[{ label: t("cid"), value: officer.userId }]}
							icon="chevron-right"
							onPress={() =>
								navigation.navigate("OfficerDetails", {
									officer: officer,
									userName: user?.name,
									authority: authority,
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
							navigation.navigate("ProposedAdministration", {
								authorityId: authority.id,
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
							const officer: Officer = officerSelection.existing || {
								userId: "",
								authorityId: authority.id,
								title: officerSelection.init?.title || "",
								scopes: officerSelection.init?.scopes || [],
							};
							const user = officer.userId ? officerUsers.get(officer.userId) : undefined;
							const name = user?.name || officerSelection.init?.name || "";
							// Frame 14: accepted entries show "Accepted - CID: <cid>" in
							// green; pending invites show "Sent" in the warning tone.
							const status = officerSelection.existing
								? {
										label: `${t("accepted")} - ${t("cid")}: ${officer.userId}`,
										tone: "accepted" as const,
									}
								: { label: t("sent"), tone: "warning" as const };

							return (
								<OfficerCard
									key={officer.userId || officerSelection.init?.name}
									officer={officer}
									userName={name}
									image={user?.image?.url ? { uri: user.image.url } : undefined}
									inviteId={(officerSelection as any)?.inviteId}
									status={status}
									onInvite={() =>
										navigation.navigate("AdministratorInvitation", {
											mode: "send",
											authority,
										})
									}
									onRemove={() => {}}
								/>
							);
						})}
					</View>

					<AuthorizationSection
						admin={adminDetails}
						onAdjustProposal={() =>
							navigation.navigate("ProposedAdministration", {
								authorityId: authority.id,
							})
						}
					/>
				</View>
			)}

			<View style={styles.section}>
				<View style={styles.invitedHeader}>
					<ThemedText type="title">{t("invitedAuthorities")}</ThemedText>
					<View style={styles.invitedAction}>
						<ChipButton
							label={t("inviteAuthority")}
							icon="circle-plus"
							onPress={() => navigation.navigate("AuthorityInvitation", { mode: "send" })}
						/>
					</View>
				</View>
				<ThemedText type="defaultSemiBold" style={styles.invitedNameLabel}>
					{t("name")}
				</ThemedText>
				<CustomTextInput
					placeholder={t("name")}
					value={inviteSearch}
					onChangeText={setInviteSearch}
				/>
				{invitedAuthorities.map((invited) => (
					<InfoCard
						key={invited.name}
						title={invited.name}
						subtitle={invited.status === "sent" ? t("sent") : t("unsent")}
						icon="chevron-right"
						onPress={() => {}}
					/>
				))}
			</View>
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
	invitedHeader: {
		marginBottom: 8,
	},
	invitedAction: {
		// 24px title + "INVITE AUTHORITY" chip don't fit on one row on a phone,
		// so the chip drops below the heading, right-aligned — mirroring the
		// proposed-administration "ADD ADMINISTRATOR" chip placement.
		flexDirection: "row",
		justifyContent: "flex-end",
		marginTop: 8,
	},
	invitedNameLabel: {
		marginTop: 8,
		marginBottom: 4,
	},
});

const styles = { ...globalStyles, ...localStyles };
