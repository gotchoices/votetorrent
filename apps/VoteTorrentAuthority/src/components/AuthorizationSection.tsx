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
}

export function AuthorizationSection({ admin, signedOfficerIds }: AuthorizationSectionProps) {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const { getEngine } = useApp();
	const [networkEngine, setNetworkEngine] = useState<INetworkEngine | null>(null);
	const [detailedOfficers, setDetailedOfficers] = useState<DetailedOfficer[]>([]);

	useEffect(() => {
		const loadData = async () => {
			try {
				const engine = await getEngine<INetworkEngine>("network");
				setNetworkEngine(engine);

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
				onPress={() => {}}
			/>
			<View style={styles.authorizationBlock}>
				<View style={styles.adminChecks}>
					{detailedOfficers.map((officerDetail) => (
						<View key={officerDetail.userId} style={styles.adminCheck}>
							<FontAwesome6
								name={officerDetail.isSigned ? "check-circle" : "circle"}
								size={24}
								color={colors.text}
							/>
							<ThemedText style={styles.adminCheckText}>{officerDetail.name}</ThemedText>
						</View>
					))}
				</View>
				<View style={styles.signButtons}>
					<CustomButton
						title={t("sign")}
						icon="signature"
						backgroundColor={colors.important}
						forceDarkText={true}
						size="thin"
						onPress={() => {}}
					/>
					<CustomButton
						title={t("share")}
						icon="share-nodes"
						backgroundColor={colors.important}
						forceDarkText={true}
						size="thin"
						onPress={() => {}}
					/>
				</View>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	authorizationBlock: {
		flexDirection: "row",
		alignItems: "flex-start",
		justifyContent: "space-between",
	},
	adminChecks: {
		justifyContent: "space-between",
	},
	adminCheck: {
		flexDirection: "row",
		width: "100%",
		paddingRight: 8,
		marginTop: 16,
	},
	adminCheckText: {
		marginLeft: 32,
	},
	signButtons: {
		gap: 4,
	},
});
const styles = { ...globalStyles, ...localStyles };
