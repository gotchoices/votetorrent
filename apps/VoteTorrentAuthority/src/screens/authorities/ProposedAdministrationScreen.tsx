import React, { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
	ExtendedTheme,
	useNavigation,
	useRoute,
	useTheme,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTranslation } from "react-i18next";
import type {
	AdminDetails,
	Authority,
	IAuthorityEngine,
	INetworkEngine,
	Officer,
	OfficerSelection,
	Scope,
	User,
} from "@votetorrent/vote-core";
import { scopeDescriptions } from "@votetorrent/vote-core";
import { useApp } from "../../providers/AppProvider";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { InfoCard } from "../../components/InfoCard";
import { ThresholdPolicyRow } from "./components/ThresholdPolicyRow";
import { globalStyles } from "../../theme/styles";
import type { RootStackParamList } from "../../navigation/types";

/**
 * Canonical Scope ordering — declaration order from
 * packages/vote-core/src/authority/models.ts:134–143. Used to render the 9
 * Threshold Policies rows in a stable order (D-03).
 *
 * Note: scopeDescriptions in vote-core defines 8/9 entries (rnp missing per
 * models.ts:145–154). The render below falls back to the t("scope_rnp")
 * i18n key when scopeDescriptions[scope] is undefined.
 */
const SCOPE_ORDER: Scope[] = [
	"rn",
	"rad",
	"vrg",
	"iad",
	"rnp",
	"uai",
	"ceb",
	"mel",
	"cap",
];

export default function ProposedAdministrationScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation =
		useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { authorityId } = useRoute().params as { authorityId: string };
	const { getEngine } = useApp();

	const [proposedOfficers, setProposedOfficers] = useState<OfficerSelection[]>(
		[]
	);
	const [officerUsers, setOfficerUsers] = useState<Map<string, User>>(
		new Map()
	);
	const [thresholds, setThresholds] = useState<Record<string, number>>({});
	const [isLoading, setIsLoading] = useState(true);
	const [authority, setAuthority] = useState<Authority | null>(null);

	// Header title (Phase 7 D-14 inherited pattern)
	useLayoutEffect(() => {
		navigation.setOptions({ title: t("proposedAdministration") });
	}, [navigation, t]);

	// Load proposed officers from AdminDetails (or fall back to current officers
	// as the starting candidate set when no proposal exists yet).
	useEffect(() => {
		let cancelled = false;
		async function load() {
			try {
				const networkEngine = await getEngine<INetworkEngine>("network");
				if (!networkEngine) return;
				const authorityEngine = await networkEngine.openAuthority(
					authorityId
				);
				if (!authorityEngine) return;
				const details: AdminDetails = await (
					authorityEngine as IAuthorityEngine
				).getAdminDetails();

				// Lift the full Authority object for navigation params
				// (gap-closure 08-07 Task 1 — see 08-UAT.md test 6).
				const authorityDetails = await (
					authorityEngine as IAuthorityEngine
				).getDetails();
				if (!cancelled) {
					setAuthority(authorityDetails.authority);
				}

				// Prefer a live proposal's officer selections; otherwise wrap each
				// current officer as { existing: officer } so the OfficerCard render
				// path stays unified.
				let selections: OfficerSelection[];
				if (details.proposed?.proposed.officers?.length) {
					selections = details.proposed.proposed.officers;
				} else {
					selections = details.admin.officers.map(
						(o: Officer): OfficerSelection => ({ existing: o })
					);
				}

				// Resolve user names for any "existing" officers (Officer has no
				// `name` field — vote-core/authority/models.ts:90–102).
				const userMap = new Map<string, User>();
				await Promise.all(
					selections
						.filter((s) => s.existing)
						.map(async (s) => {
							try {
								const userEngine = await networkEngine.getUser(
									s.existing!.userId
								);
								const summary = await userEngine?.getSummary();
								if (summary) {
									userMap.set(s.existing!.userId, summary);
								}
							} catch (e) {
								console.error(
									"Error loading user for officer:",
									e
								);
							}
						})
				);

				if (!cancelled) {
					setProposedOfficers(selections);
					setOfficerUsers(userMap);
				}
			} catch (e) {
				console.error("Error loading proposed administration:", e);
			} finally {
				if (!cancelled) setIsLoading(false);
			}
		}
		load();
		return () => {
			cancelled = true;
		};
	}, [getEngine, authorityId]);

	// Initialize per-scope thresholds to 1 once we know the officer count.
	useEffect(() => {
		if (proposedOfficers.length === 0) return;
		setThresholds((prev) => {
			const next: Record<string, number> = { ...prev };
			for (const s of SCOPE_ORDER) {
				if (next[s] === undefined) next[s] = 1;
			}
			return next;
		});
	}, [proposedOfficers.length]);

	const officerCount = proposedOfficers.length;
	const sliderMax = useMemo(() => Math.max(1, officerCount), [officerCount]);

	// Stub PROPOSE (D-04): no mock-state mutation.
	const handlePropose = () => {
		console.log("propose stub");
		navigation.goBack();
	};

	const handleAddAdministrator = () => {
		console.log("addAdministrator stub");
		if (!authority) return;
		navigation.navigate("AdministratorInvitation", {
			mode: "send",
			authority,
		});
	};

	if (isLoading) {
		return (
			<View style={styles.centerContainer}>
				<ThemedText>{t("loading")}</ThemedText>
			</View>
		);
	}

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				{/* Section 1 — Officer cards */}
				<View style={styles.section}>
					<ThemedText
						type="defaultSemiBold"
						style={styles.sectionTitle}
					>
						{t("proposedAdministration")}
					</ThemedText>
					{proposedOfficers.map((selection, idx) => {
						const officer: Officer =
							selection.existing ??
							({
								userId: "",
								authorityId,
								title: selection.init?.title ?? "",
								scopes: selection.init?.scopes ?? [],
							} as Officer);
						const userName = selection.existing
							? officerUsers.get(selection.existing.userId)?.name ??
								selection.existing.userId
							: selection.init?.name ?? "";
						const key =
							selection.existing?.userId ??
							`init-${selection.init?.name ?? idx}`;
						// Figma frame 10: compact card (name · role · CID) + chevron → Administrator detail.
						return (
							<InfoCard
								key={key}
								title={userName}
								subtitle={officer.title}
								additionalInfo={[{ label: t("cid"), value: officer.userId }]}
								icon="chevron-right"
								onPress={() => navigation.navigate("OfficerDetails", { officer, userName })}
							/>
						);
					})}
					<View style={styles.addButtonContainer}>
						<ChipButton
							label={t("addAdministrator")}
							icon="circle-plus"
							onPress={handleAddAdministrator}
						/>
					</View>
				</View>

				{/* Section 2 — Threshold Policies (D-01/D-03) */}
				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t("thresholdPolicies")}
					</ThemedText>
					{SCOPE_ORDER.map((scope) => (
						<ThresholdPolicyRow
							key={scope}
							scope={scope}
							label={
								scopeDescriptions[scope] ??
								t("scope_" + scope)
							}
							value={thresholds[scope] ?? 1}
							min={1}
							max={sliderMax}
							onChange={(v) =>
								setThresholds((prev) => ({
									...prev,
									[scope]: v,
								}))
							}
						/>
					))}
				</View>
			</ScrollView>

			{/* PROPOSE footer — stub per D-04 */}
			<Footer>
				<CustomButton
					title={t("propose")}
					icon="floppy-disk"
					backgroundColor={colors.success}
					forceDarkText={true}
					onPress={handlePropose}
				/>
			</Footer>
		</View>
	);
}

const localStyles = StyleSheet.create({
	addButtonContainer: {
		flexDirection: "row",
		justifyContent: "flex-end",
		marginTop: 8,
	},
	centerContainer: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
	},
});

const styles = { ...globalStyles, ...localStyles };
