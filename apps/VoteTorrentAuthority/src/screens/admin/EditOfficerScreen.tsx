import { ExtendedTheme, useTheme } from "@react-navigation/native";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View, Switch } from "react-native";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import type { Authority, Officer, Scope } from "@votetorrent/vote-core";
import { scopeDescriptions } from "@votetorrent/vote-core";
import { useRoute, useNavigation } from "@react-navigation/native";
import { useApp } from "../../providers/AppProvider";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import type { RootStackParamList } from "../../navigation/types";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { CustomTextInput } from "../../components/CustomTextInput";
import { globalStyles } from "../../theme/styles";

export default function EditOfficerScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { authority, officerId } = useRoute().params as {
		authority: Authority;
		officerId?: string;
	};
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { networkEngine } = useApp();
	const [name, setName] = useState("");
	const [title, setTitle] = useState("");
	const [scopes, setScopes] = useState<Scope[]>([]);
	const [officer, setOfficer] = useState<Officer | null>(null);

	useEffect(() => {
		async function loadOfficer() {
			if (!networkEngine || !officerId) return;
			try {
				const admin = await networkEngine.getAdmin(authority.id);
				const foundOfficer = admin.officers.find((a: Officer) => a.userId === officerId);
				if (foundOfficer) {
					setOfficer(foundOfficer);
					setName(foundOfficer.name);
					setTitle(foundOfficer.title);
					setScopes(foundOfficer.scopes);
				}
			} catch (error) {
				console.error("Error loading officer:", error);
			}
		}
		loadOfficer();
	}, [networkEngine, authority.id, officerId]);

	useEffect(() => {
		navigation.setOptions({
			headerRight: () => (
				<ChipButton
					label={t("remove")}
					icon="trash"
					onPress={() => {
						// If we're editing an existing officer, pass back the remove flag
						if (officer) {
							// Set the params on the previous screen and go back
							navigation.popTo("ReplaceAdmin", {
								authority,
								officer,
								removeOfficer: true,
							});
						} else {
							// For new officers, just go back without any changes
							navigation.goBack();
						}
					}}
				/>
			),
		});
	}, [navigation, t, officer, authority]);

	const handleScopeToggle = (scope: Scope) => {
		setScopes((prev) => {
			if (prev.includes(scope)) {
				return prev.filter((id) => id !== scope);
			} else {
				return [...prev, scope];
			}
		});
	};

	const handleAddOfficer = async () => {
		try {
			const newOfficer: Officer = {
				userId: officer?.userId || `admin-${Date.now()}`,
				title,
				scopes,
			};

			// Pass the officer back to ReplaceAdminScreen
			navigation.popTo("ReplaceAdmin", { authority, officer: newOfficer });
		} catch (error) {
			console.error("Error adding officer:", error);
		}
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t("officer")}
					</ThemedText>

					<CustomTextInput title={t("name")} value={name} onChangeText={setName} />
					<CustomTextInput title={t("title")} value={title} onChangeText={setTitle} />
				</View>

				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t("permissions")}
					</ThemedText>
					{Object.entries(scopeDescriptions).map(([scope, description]) => (
						<View key={scope} style={styles.scopeRow}>
							<View style={styles.scopeDescriptionContainer}>
								<ThemedText>{description}</ThemedText>
								<FontAwesome6
									name="circle-info"
									size={16}
									color={colors.text}
									style={styles.scopeInfoIcon}
								/>
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

			<View style={[styles.footer, { backgroundColor: colors.card }]}>
				<CustomButton
					title={t("save")}
					icon="save"
					disabled={!name || !title}
					backgroundColor={colors.success}
					forceDarkText={true}
					onPress={handleAddOfficer}
				/>
			</View>
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
