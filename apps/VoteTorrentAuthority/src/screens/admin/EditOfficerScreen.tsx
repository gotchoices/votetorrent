import { ExtendedTheme, useTheme } from "@react-navigation/native";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View, Switch } from "react-native";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { InfoCard } from "../../components/InfoCard";
import type { Authority, INetworkEngine, IUserEngine, Officer, Scope, User } from "@votetorrent/vote-core";
import { scopeDescriptions } from "@votetorrent/vote-core";
import { useRoute, useNavigation } from "@react-navigation/native";
import { useApp } from "../../providers/AppProvider";
import { useSettings } from "../../providers/SettingsProvider";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import type { RootStackParamList } from "../../navigation/types";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { CustomTextInput } from "../../components/CustomTextInput";
import { globalStyles } from "../../theme/styles";

export default function EditOfficerScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { showHelpIcons } = useSettings();
	const { authority, officerId } = useRoute().params as {
		authority: Authority;
		officerId?: string;
	};
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { getEngine } = useApp();
	const [name, setName] = useState("");
	const [title, setTitle] = useState("");
	const [scopes, setScopes] = useState<Scope[]>([]);
	const [officer, setOfficer] = useState<Officer | null>(null);
	const [user, setUser] = useState<User | null>(null);
	const [userEngine, setUserEngine] = useState<IUserEngine | null>(null);

	// Editing an existing administrator (vs. adding a new one). Drives the
	// frame-35 vs frame-12 layout: edit shows the User card + REMOVE; add shows
	// the Name input with the "name on invitation" placeholder.
	const isEditing = !!officerId;

	useEffect(() => {
		async function loadOfficer() {
			if (!officerId) return;
			try {
				const networkEngine = await getEngine<INetworkEngine>("network");
				const authorityEngine = await networkEngine.openAuthority(authority.id);
				const admin = await authorityEngine.getAdminDetails();
				const foundOfficer = admin.admin.officers.find((o) => o.userId === officerId);
				if (foundOfficer) {
					setOfficer(foundOfficer);
					// Officer has no `name` field (vote-core/authority/models.ts:90-102).
					// Source the display name from the User join via networkEngine.getUser()
					// (Phase 7 D-15 opportunistic fix; preferred Option A from 08-04 plan).
					try {
						const ue = await networkEngine.getUser(foundOfficer.userId);
						const u = await ue?.getSummary();
						setUserEngine(ue ?? null);
						setUser(u ?? null);
						setName(u?.name ?? "");
					} catch (userError) {
						console.error("Error loading user for officer:", userError);
						setName("");
					}
					setTitle(foundOfficer.title);
					setScopes(foundOfficer.scopes);
				}
			} catch (error) {
				console.error("Error loading officer:", error);
			}
		}
		loadOfficer();
	}, [getEngine, authority.id, officerId]);

	// REMOVE button (header) — only when editing an existing administrator
	// (frame 35). Removing from the proposed administration is engine-stubbed.
	const handleRemove = () => {
		console.log("editOfficer-remove stub", { officerId });
		navigation.goBack();
	};

	useEffect(() => {
		navigation.setOptions({
			headerRight: isEditing
				? () => <ChipButton label={t("remove")} icon="trash" onPress={handleRemove} />
				: undefined,
		});
	}, [navigation, t, isEditing]);

	const handleScopeToggle = (scope: Scope) => {
		setScopes((prev) => {
			if (prev.includes(scope)) {
				return prev.filter((id) => id !== scope);
			} else {
				return [...prev, scope];
			}
		});
	};

	const handleSave = () => {
		// UI-only stub: persisting the administrator (name/title/permissions) to the
		// proposed administration lands when the engine API is extended. Mirror the
		// ProposedAdministration propose/add stubs and return to the list.
		console.log("editOfficer-save stub", {
			officerId: officer?.userId,
			name,
			title,
			scopes,
		});
		navigation.goBack();
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					{isEditing ? (
						<InfoCard
							image={(user as any)?.image?.url ? { uri: (user as any).image.url } : undefined}
							additionalInfo={[
								{ label: t("user"), value: user?.name ?? officerId },
								{ label: t("sid"), value: officerId },
							]}
							icon="chevron-right"
							onPress={() =>
								user && userEngine && navigation.navigate("UserDetails", { user, userEngine })
							}
						/>
					) : (
						<CustomTextInput
							title={t("name")}
							placeholder={t("nameOnInvitation")}
							value={name}
							onChangeText={setName}
						/>
					)}
					<CustomTextInput
						title={t("title")}
						placeholder={t("officialTitle")}
						value={title}
						onChangeText={setTitle}
					/>
				</View>

				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t("permissions")}
					</ThemedText>
					{Object.entries(scopeDescriptions).map(([scope, description]) => (
						<View key={scope} style={styles.scopeRow}>
							<View style={styles.scopeDescriptionContainer}>
								<ThemedText>{description}</ThemedText>
								{showHelpIcons && (
									<FontAwesome6
										name="circle-info"
										size={16}
										color={colors.text}
										style={styles.scopeInfoIcon}
									/>
								)}
							</View>
							<Switch
								value={scopes.includes(scope as Scope)}
								onValueChange={() => handleScopeToggle(scope as Scope)}
								trackColor={{ false: colors.accent, true: colors.primary }}
								thumbColor={colors.card}
							/>
						</View>
					))}
				</View>
			</ScrollView>

			<Footer>
				<CustomButton
					title={t("save")}
					icon="floppy-disk"
					disabled={!name || !title}
					backgroundColor={colors.success}
					forceDarkText={true}
					onPress={handleSave}
				/>
			</Footer>
		</View>
	);
}

const localStyles = StyleSheet.create({
	detail: {
		marginBottom: 32,
	},
	scopeRow: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingVertical: 4,
	},
	scopeDescriptionContainer: {
		flexDirection: "row",
		alignItems: "center",
		flex: 1,
	},
	scopeInfoIcon: {
		marginLeft: 8,
	},
});
const styles = { ...globalStyles, ...localStyles };
