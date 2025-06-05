import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { ThemedText } from "./ThemedText";
import { CustomButton } from "./CustomButton";
import type { AdministrationDetails, INetworkEngine } from "@votetorrent/vote-core";
import { globalStyles } from "../theme/styles";
import { useApp } from "../providers/AppProvider";

interface DetailedAdmin {
	userSid: string;
	name: string;
	isSigned: boolean;
}

interface AuthorizationSectionProps {
	administration: AdministrationDetails | null;
	signedAdministratorSids?: string[];
}

export function AuthorizationSection({
	administration,
	signedAdministratorSids,
}: AuthorizationSectionProps) {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const { getEngine } = useApp();
	const [networkEngine, setNetworkEngine] = useState<INetworkEngine | null>(null);
	const [detailedAdministrators, setDetailedAdministrators] = useState<DetailedAdmin[]>([]);

	useEffect(() => {
		const loadData = async () => {
			try {
				const engine = await getEngine<INetworkEngine>("network");
				setNetworkEngine(engine);

				if (engine && administration && administration.administration) {
					const adminDetailsPromises = administration.administration.administrators.map(
						async (admin) => {
							const userEngine = await engine.getUser(admin.userSid);
							const user = await userEngine?.getSummary();
							return {
								userSid: admin.userSid,
								name: user?.name || t("unknownUser"),
								isSigned: signedAdministratorSids?.includes(admin.userSid) ?? false,
							};
						}
					);
					const resolvedAdminDetails = await Promise.all(adminDetailsPromises);
					setDetailedAdministrators(resolvedAdminDetails);
				} else {
					setDetailedAdministrators([]);
				}
			} catch (error) {
				console.error("Failed to load network or user details:", error);
				setDetailedAdministrators([]);
			}
		};
		loadData();
	}, [getEngine, administration, signedAdministratorSids, t]);

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
					{detailedAdministrators.map((adminDetail) => (
						<View key={adminDetail.userSid} style={styles.adminCheck}>
							<FontAwesome6
								name={adminDetail.isSigned ? "check-circle" : "circle"}
								size={24}
								color={colors.text}
							/>
							<ThemedText style={styles.adminCheckText}>{adminDetail.name}</ThemedText>
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
