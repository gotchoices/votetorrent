import { ExtendedTheme, useTheme } from "@react-navigation/native";
import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View, Switch } from "react-native";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { InfoCard } from "../../components/InfoCard";
import type { Authority, IAuthorityEngine, INetworkEngine, IUserEngine, Officer, OfficerSelection, Scope, ThresholdPolicy, User } from "@votetorrent/vote-core";
import { scopeDescriptions } from "@votetorrent/vote-core";
import { useRoute, useNavigation } from "@react-navigation/native";
import { useApp } from "../../providers/AppProvider";
import { useSettings } from "../../providers/SettingsProvider";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import type { RootStackParamList } from "../../navigation/types";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { CustomTextInput } from "../../components/CustomTextInput";
import { globalStyles } from "../../theme/styles";
import { createDeviceSigner } from "../../engines/device-signer";
import { getOrCreateDeviceUser } from "../../engines/device-user";

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
	const [errorMessage, setErrorMessage] = useState<string>("");

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

	// ADM-01 shared persist helper: rebuilds the proposed officer set and persists
	// it via proposeAdmin. Both handleSave and handleRemove funnel through here.
	// D-01: private key stays app-side (createDeviceSigner closes over it).
	// D-03: AdminDigest is computed ENGINE-SIDE inside proposeAdmin — the app no
	//       longer recomputes sha256(...) independently.
	// WR-10: secp256k1.sign v2 defaults (prehash:true) inside createDeviceSigner.
	const persistOfficerSet = useCallback(async (updatedOfficers: OfficerSelection[]) => {
		const networkEngine = await getEngine<INetworkEngine>("network");
		if (!networkEngine) throw new Error("Network not available");
		const authorityEngine = await networkEngine.openAuthority(authority.id) as IAuthorityEngine;
		const adminDetails = await authorityEngine.getAdminDetails();

		// Preserve existing thresholdPolicies + effectiveAt when a proposal exists;
		// fall back to admin thresholdPolicies (wrap with 'policy' field per ThresholdPolicy).
		const existingPolicies: ThresholdPolicy[] = adminDetails.proposed?.proposed.thresholdPolicies
			?? adminDetails.admin.thresholdPolicies;
		const effectiveAtMs = Date.now() + 365 * 24 * 60 * 60 * 1000;
		const effectiveAtStr = new Date(effectiveAtMs).toISOString().slice(0, 19);

		// Resolve the device user id for the signers array. The callback provides
		// the full Signature once the engine computes the canonical digest internally.
		const deviceUser = await getOrCreateDeviceUser(user?.name ?? "Authority Administrator");

		// D-03: engine computes digest; sign callback signs those exact bytes.
		const sign = await createDeviceSigner(user?.name ?? "Authority Administrator");

		const proposal = {
			proposed: {
				officers: updatedOfficers,
				effectiveAt: effectiveAtStr,
				thresholdPolicies: existingPolicies,
			},
			signers: [deviceUser.id],
		};
		await authorityEngine.proposeAdmin(proposal, sign);
	}, [authority.id, getEngine, user]);

	// ADM-01: REMOVE drops the officer from the proposed administration officer set.
	const handleRemove = useCallback(async () => {
		setErrorMessage("");
		try {
			const networkEngine = await getEngine<INetworkEngine>("network");
			if (!networkEngine) {
				setErrorMessage("Network not available");
				return;
			}
			const authorityEngine = await networkEngine.openAuthority(authority.id) as IAuthorityEngine;
			const adminDetails = await authorityEngine.getAdminDetails();

			// Build the current proposed officer set (or fall back to current admin officers).
			let currentSelections: OfficerSelection[];
			if (adminDetails.proposed?.proposed.officers?.length) {
				currentSelections = adminDetails.proposed.proposed.officers;
			} else {
				currentSelections = adminDetails.admin.officers.map(
					(o: Officer): OfficerSelection => ({ existing: o })
				);
			}

			// Drop the officer whose existing.userId matches officerId.
			const updatedOfficers = currentSelections.filter(
				(s) => s.existing?.userId !== officerId
			);

			await persistOfficerSet(updatedOfficers);
			navigation.goBack();
		} catch (err) {
			setErrorMessage(err instanceof Error ? err.message : String(err));
		}
	}, [authority.id, officerId, getEngine, navigation, persistOfficerSet]);

	useEffect(() => {
		navigation.setOptions({
			headerRight: isEditing
				? () => <ChipButton label={t("remove")} icon="trash" onPress={handleRemove} />
				: undefined,
		});
	}, [navigation, t, isEditing, handleRemove]);

	const handleScopeToggle = (scope: Scope) => {
		setScopes((prev) => {
			if (prev.includes(scope)) {
				return prev.filter((id) => id !== scope);
			} else {
				return [...prev, scope];
			}
		});
	};

	// ADM-01: SAVE persists the edited/added officer into the proposed administration.
	const handleSave = async () => {
		setErrorMessage("");
		try {
			const networkEngine = await getEngine<INetworkEngine>("network");
			if (!networkEngine) {
				setErrorMessage("Network not available");
				return;
			}
			const authorityEngine = await networkEngine.openAuthority(authority.id) as IAuthorityEngine;
			const adminDetails = await authorityEngine.getAdminDetails();

			// Build the current proposed officer set (or fall back to current admin officers).
			let currentSelections: OfficerSelection[];
			if (adminDetails.proposed?.proposed.officers?.length) {
				currentSelections = adminDetails.proposed.proposed.officers;
			} else {
				currentSelections = adminDetails.admin.officers.map(
					(o: Officer): OfficerSelection => ({ existing: o })
				);
			}

			let updatedOfficers: OfficerSelection[];
			if (isEditing && officerId) {
				// Update the matching existing officer's title and scopes.
				updatedOfficers = currentSelections.map((s) => {
					if (s.existing?.userId === officerId) {
						return {
							existing: {
								...s.existing,
								title,
								scopes,
							},
						};
					}
					return s;
				});
			} else {
				// Add a new officer via init shape (name/title/scopes).
				updatedOfficers = [
					...currentSelections,
					{ init: { name, title, scopes } },
				];
			}

			await persistOfficerSet(updatedOfficers);
			navigation.goBack();
		} catch (err) {
			setErrorMessage(err instanceof Error ? err.message : String(err));
		}
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

			{errorMessage ? (
				<ThemedText type="small" style={{ color: colors.error }}>
					{errorMessage}
				</ThemedText>
			) : null}
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
