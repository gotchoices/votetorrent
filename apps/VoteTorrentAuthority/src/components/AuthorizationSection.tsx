import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { ThemedText } from "./ThemedText";
import { CustomButton } from "./CustomButton";
import type { AdminDetails, INetworkEngine } from "@votetorrent/vote-core";
import { globalStyles } from "../theme/styles";
import { useApp } from "../providers/AppProvider";

interface DetailedOfficer {
	userId: string;
	name: string;
	isSigned: boolean;
}

interface AuthorizationSectionProps {
	admin: AdminDetails | null;
	signedOfficerIds?: string[];
	/** Invoked when ADJUST PROPOSAL is tapped. Callers wire this to their
	 *  revision flow (e.g. NetworkDetails → NetworkRevision). Defaults to no-op. */
	onAdjustProposal?: () => void;
}

export function AuthorizationSection({ admin, signedOfficerIds, onAdjustProposal }: AuthorizationSectionProps) {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const { getEngine } = useApp();
	const [detailedOfficers, setDetailedOfficers] = useState<DetailedOfficer[]>([]);

	useEffect(() => {
		const loadData = async () => {
			try {
				const engine = await getEngine<INetworkEngine>("network");

				if (engine && admin && admin.admin) {
					const officerDetailsPromises = admin.admin.officers.map(async (officer) => {
						const userEngine = await engine.getUser(officer.userId);
						const user = await userEngine?.getSummary();
						return {
							userId: officer.userId,
							name: user?.name || t("unknownUser"),
							isSigned: signedOfficerIds?.includes(officer.userId) ?? false,
						};
					});
					const resolvedAdminDetails = await Promise.all(officerDetailsPromises);
					setDetailedOfficers(resolvedAdminDetails);
				} else {
					setDetailedOfficers([]);
				}
			} catch (error) {
				console.error("Failed to load network or user details:", error);
				setDetailedOfficers([]);
			}
		};
		loadData();
	}, [getEngine, admin, signedOfficerIds, t]);

	return (
		<View style={styles.section}>
			<ThemedText type="title">{t("authorization")}</ThemedText>
			<CustomButton
				title={t("adjustProposal")}
				icon="pen"
				backgroundColor={colors.accent}
				size="thin"
				onPress={onAdjustProposal ?? (() => {})}
			/>
			{detailedOfficers.map((officerDetail) => (
				<View key={officerDetail.userId} style={styles.adminCheck}>
					<ThemedText style={styles.adminCheckName}>{officerDetail.name}</ThemedText>
					<FontAwesome6
						name={officerDetail.isSigned ? "square-check" : "square"}
						size={20}
						color={colors.text}
					/>
					<CustomButton
						title={officerDetail.isSigned ? t("share") : t("sign")}
						icon={officerDetail.isSigned ? "share-nodes" : "signature"}
						backgroundColor={colors.important}
						forceDarkText={true}
						size="thin"
						flex={true}
						onPress={() => {}}
					/>
				</View>
			))}
		</View>
	);
}

const localStyles = StyleSheet.create({
	adminCheck: {
		flexDirection: "row",
		alignItems: "center",
		marginTop: 12,
		gap: 12,
	},
	adminCheckName: {
		flex: 1,
	},
});
const styles = { ...globalStyles, ...localStyles };
