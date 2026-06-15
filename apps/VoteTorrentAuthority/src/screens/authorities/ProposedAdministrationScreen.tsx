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
	ThresholdPolicy,
	User,
} from "@votetorrent/vote-core";
import { scopeDescriptions } from "@votetorrent/vote-core";
import { createDeviceSigner } from "../../engines/device-signer";
import { getOrCreateDeviceUser } from "../../engines/device-user";
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
	const [errorMessage, setErrorMessage] = useState<string>("");

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

	// ADM-02: PROPOSE calls proposeAdmin with a device-signer callback.
	// D-01: private key stays app-side (createDeviceSigner closes over it).
	// D-03: the admin digest is computed ENGINE-SIDE inside proposeAdmin —
	//       the app no longer recomputes sha256(...) independently.
	// WR-10: secp256k1.sign v2 defaults (prehash:true) inside createDeviceSigner.
	const handlePropose = async () => {
		setErrorMessage("");
		try {
			const networkEngine = await getEngine<INetworkEngine>("network");
			if (!networkEngine) {
				setErrorMessage("Network not available");
				return;
			}
			const authorityEngine = await networkEngine.openAuthority(authorityId) as IAuthorityEngine;

			// Build ThresholdPolicies from on-screen slider state.
			const thresholdPoliciesArr: ThresholdPolicy[] = SCOPE_ORDER.map(
				(scope) => ({ policy: scope, threshold: thresholds[scope] ?? 1 })
			);

			// Canonical effective-at: a future timestamp one year out.
			const effectiveAtMs = Date.now() + 365 * 24 * 60 * 60 * 1000;
			const effectiveAtStr = new Date(effectiveAtMs).toISOString().slice(0, 19);

			// Resolve the device user id for the signers array (proposeAdmin requires
			// a non-empty signers list at guard time). The callback provides the full
			// Signature (signerUserId, signerKey, signature) once the engine computes
			// the canonical digest and passes the bytes to the callback.
			const deviceUser = await getOrCreateDeviceUser(
				authority?.name ?? "Authority Administrator"
			);

			// D-03: engine computes digest; sign callback signs those exact bytes.
			const sign = await createDeviceSigner(
				authority?.name ?? "Authority Administrator"
			);

			// Build the Proposal<AdminInit>: officers from on-screen state, signers
			// initialised with the device user's id (required by proposeAdmin guard).
			const proposal = {
				proposed: {
					officers: proposedOfficers,
					effectiveAt: effectiveAtStr,
					thresholdPolicies: thresholdPoliciesArr,
				},
				signers: [deviceUser.id],
			};

			await authorityEngine.proposeAdmin(proposal, sign);
			navigation.goBack();
		} catch (err) {
			setErrorMessage(err instanceof Error ? err.message : String(err));
		}
	};

	const handleAddAdministrator = () => {
		if (!authority) return;
		// Frame 12 (EditOfficer) is the canonical administrator editor — it captures
		// name + title + permissions, unlike the invitation send-form (name/title
		// only). Adding a new administrator opens it with no officerId.
		navigation.navigate("EditOfficer", { authority });
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
								onPress={() =>
									authority &&
									navigation.navigate("OfficerDetails", { officer, userName, authority })
								}
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

			{/* ADM-02: PROPOSE footer — wired to real proposeAdmin with device-signer Signature */}
			{errorMessage ? (
				<ThemedText type="small" style={{ color: colors.error }}>
					{errorMessage}
				</ThemedText>
			) : null}
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
