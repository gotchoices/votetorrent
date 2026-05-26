import React, { useEffect, useState } from "react";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { useTranslation } from "react-i18next";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { RootStackParamList } from "./types";
import AuthorityDetailsScreen from "../screens/authorities/AuthorityDetailsScreen";
import OfficerDetailsScreen from "../screens/admin/OfficerDetailsScreen";
import ElectionsScreen from "../screens/elections/ElectionsScreen";
import TasksScreen from "../screens/tasks/TasksScreen";
import AuthoritiesScreen from "../screens/authorities/AuthoritiesScreen";
import SettingsScreen from "../screens/settings/SettingsScreen";
import { ChipButton } from "../components/ChipButton";
import { Pressable, StyleSheet, Text } from "react-native";
import { ExtendedTheme, useNavigation } from "@react-navigation/native";
import { useTheme } from "@react-navigation/native";
import NetworksScreen from "../screens/networks/NetworksScreen";
import type { NavigationProp } from "./types";
import AddNetworkScreen from "../screens/networks/AddNetworkScreen";
import HostingScreen from "../screens/networks/HostingScreen";
import ReplaceAdminScreen from "../screens/admin/ReplaceAdminScreen";
import { useApp } from "../providers/AppProvider";
import EditOfficerScreen from "../screens/admin/EditOfficerScreen";
import { ThemedText } from "../components/ThemedText";
import { INetworkEngine } from "@votetorrent/vote-core";
import DefaultUserScreen from "../screens/users/DefaultUserScreen";
import UserDetailsScreen from "../screens/users/UserDetailsScreen";
import ReviseUserScreen from "../screens/users/ReviseUserScreen";
import AddKeyScreen from "../screens/users/AddKeyScreen";
import RevokeKeyScreen from "../screens/users/RevokeKeyScreen";
import AddDeviceScreen from "../screens/users/AddDeviceScreen";
import NetworkDetailsScreen from "../screens/networks/NetworkDetailsScreen";
import KeyTaskScreen from "../screens/tasks/KeyTaskScreen";
import SignatureTaskScreen from "../screens/tasks/SignatureTaskScreen";
import OnboardingFrame2Screen from "../screens/tasks/OnboardingFrame2Screen";
import OnboardingFrame7Screen from "../screens/tasks/OnboardingFrame7Screen";
import OnboardingFrame18Screen from "../screens/tasks/OnboardingFrame18Screen";
import OnboardingFrame19Screen from "../screens/tasks/OnboardingFrame19Screen";
import OnboardingFrame20Screen from "../screens/tasks/OnboardingFrame20Screen";
import OnboardingFrame21Screen from "../screens/tasks/OnboardingFrame21Screen";
import OnboardingDebugScreen from "../screens/tasks/OnboardingDebugScreen";
import ElectionDetailsScreen from "../screens/elections/ElectionDetailsScreen";
import EditBallotScreen from "../screens/ballots/EditBallotScreen";

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator();

function HeaderTitle() {
	const { hasNetwork, getEngine } = useApp();
	const { t } = useTranslation();
	const navigation = useNavigation<NavigationProp>();
	const [networkName, setNetworkName] = useState<string | null>(null);

	useEffect(() => {
		const fetchNetworkDetails = async () => {
			if (hasNetwork) {
				try {
					const engine = (await getEngine("network")) as INetworkEngine;
					if (engine) {
						const networkDetails = await engine.getDetails();
						setNetworkName(networkDetails.network.name);
					}
				} catch (error) {
					console.error("Error fetching network details:", error);
				}
			} else {
				setNetworkName(null);
			}
		};

		fetchNetworkDetails();
	}, [hasNetwork, getEngine]);

	return (
		<Pressable
			onPress={() => navigation.navigate("Networks")}
			style={[styles.networkTextContainer, styles.headerText]}
		>
			<ThemedText type="header">{networkName ? networkName : t("selectNetwork")}</ThemedText>
		</Pressable>
	);
}

function useTabHeaderOptions(tab?: string) {
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NavigationProp>();
	const { t } = useTranslation();

	const handleNetworkPress = () => {
		navigation.navigate("Networks");
	};

	return {
		headerLeft: () => (
			<Pressable onPress={handleNetworkPress} style={styles.headerButton}>
				<FontAwesome6 name="cloud-rain" size={24} color={colors.text} />
			</Pressable>
		),
		headerRight: () => (
			<Pressable style={styles.headerButton}>
				<FontAwesome6 name="circle-user" size={24} color={colors.text} />
			</Pressable>
		),
		headerTitle: () =>
			tab === "tasks" ? <ThemedText type="header">{t("allNetworks")}</ThemedText> : <HeaderTitle />,
		headerShadowVisible: true,
	};
}

const TabNavigator = () => {
	const { colors } = useTheme() as ExtendedTheme;

	return (
		<Tab.Navigator
			screenOptions={({ route }) => ({
				tabBarIcon: ({ focused, color }) => {
					if (route.name === "Settings") {
						return <FontAwesome6 name="gear" size={22} color={color} />;
					}
					const letterMap: Record<string, string> = {
						Elections: "E",
						Tasks: "T",
						Authorities: "A",
					};
					const letter = letterMap[route.name] ?? "?";
					return (
						<Text
							style={[
								styles.tabLetter,
								{ color, fontWeight: focused ? "900" : "700" },
							]}
						>
							{letter}
						</Text>
					);
				},
				tabBarActiveTintColor: colors.text,
				tabBarInactiveTintColor: "gray",
				tabBarLabelStyle: { fontWeight: "700" },
				tabBarBadgeStyle: {
					backgroundColor: colors.notification,
					color: colors.light,
					fontWeight: "700",
				},
			})}
		>
			<Tab.Screen
				name="Elections"
				component={ElectionsScreen}
				options={{ ...useTabHeaderOptions() }}
			/>
			<Tab.Screen
				name="Tasks"
				component={TasksScreen}
				options={{
					...useTabHeaderOptions("tasks"),
					tabBarBadge: 3,
				}}
			/>
			<Tab.Screen
				name="Authorities"
				component={AuthoritiesScreen}
				options={{ ...useTabHeaderOptions() }}
			/>
			<Tab.Screen
				name="Settings"
				component={SettingsScreen}
				options={{ ...useTabHeaderOptions() }}
			/>
		</Tab.Navigator>
	);
};

const styles = StyleSheet.create({
	splitHeaderContainer: {
		flex: 1,
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		paddingHorizontal: 2,
		width: "100%",
	},
	networkTextContainer: {
		flex: 1,
		marginRight: 8,
	},
	headerText: {
		justifyContent: "center",
	},
	usernameText: {
		flex: 1,
		textAlign: "right",
		opacity: 0.7,
	},
	headerButton: {
		padding: 8,
		marginHorizontal: 4,
		marginVertical: -2,
	},
	tabLetter: {
		fontSize: 22,
		lineHeight: 24,
	},
});

function CloseButton({ onPress }: { onPress: () => void }) {
	const { colors } = useTheme() as ExtendedTheme;
	return (
		<Pressable onPress={onPress} style={styles.headerButton} hitSlop={8}>
			<FontAwesome6 name="xmark" size={22} color={colors.text} />
		</Pressable>
	);
}

export const RootNavigator = () => {
	const { t } = useTranslation();

	return (
		<Stack.Navigator>
			<Stack.Screen name="Home" component={TabNavigator} options={{ headerShown: false }} />
			<Stack.Screen
				name="Networks"
				component={NetworksScreen}
				options={{
					title: "",
				}}
			/>
			<Stack.Screen
				name="AddNetwork"
				component={AddNetworkScreen}
				options={{ title: t("addNetwork") }}
			/>
			<Stack.Screen
				name="NetworkDetails"
				component={NetworkDetailsScreen}
				options={{ title: t("network") }}
			/>
			<Stack.Screen name="Hosting" component={HostingScreen} options={{ title: t("hosting") }} />
			<Stack.Screen
				name="AuthorityDetails"
				component={AuthorityDetailsScreen}
				options={({ navigation }) => ({
					title: t("authority"),
					presentation: "modal",
					headerBackVisible: false,
					headerLeft: () => <CloseButton onPress={() => navigation.goBack()} />,
					headerRight: () => <ChipButton label={t("unpin")} icon={"thumbtack-slash"} />,
				})}
			/>
			<Stack.Screen
				name="OfficerDetails"
				component={OfficerDetailsScreen}
				options={{
					title: t("officer"),
				}}
			/>
			<Stack.Screen
				name="ReplaceAdmin"
				component={ReplaceAdminScreen}
				options={{ title: t("proposeReplacement") }}
			/>
			<Stack.Screen
				name="EditOfficer"
				component={EditOfficerScreen}
				options={{
					title: t("officer"),
				}}
			/>
			<Stack.Screen
				name="DefaultUser"
				component={DefaultUserScreen}
				options={{ title: t("defaultUser") }}
			/>
			<Stack.Screen
				name="UserDetails"
				component={UserDetailsScreen}
				options={{ title: t("user") }}
			/>
			<Stack.Screen name="ReviseUser" component={ReviseUserScreen} options={{ title: t("user") }} />
			<Stack.Screen name="AddKey" component={AddKeyScreen} options={{ title: t("addKey") }} />
			<Stack.Screen
				name="RevokeKey"
				component={RevokeKeyScreen}
				options={{ title: t("revokeKey") }}
			/>
			<Stack.Screen
				name="AddDevice"
				component={AddDeviceScreen}
				options={{ title: t("addDevice") }}
			/>
			<Stack.Screen
				name="KeyTask"
				component={KeyTaskScreen}
				options={({ navigation }) => ({
					title: t("keyholderRelease"),
					presentation: "modal",
					headerBackVisible: false,
					headerLeft: () => <CloseButton onPress={() => navigation.goBack()} />,
				})}
			/>
			<Stack.Screen
				name="SignatureTask"
				component={SignatureTaskScreen}
				options={{ title: t("signature") }}
			/>
			<Stack.Screen
				name="OnboardingFrame2"
				component={OnboardingFrame2Screen}
				options={{ title: t("onboardingFrame2Title") }}
			/>
			<Stack.Screen
				name="OnboardingFrame7"
				component={OnboardingFrame7Screen}
				options={{ title: t("onboardingFrame7Title") }}
			/>
			<Stack.Screen
				name="OnboardingFrame18"
				component={OnboardingFrame18Screen}
				options={{ title: t("onboardingFrame18Title") }}
			/>
			<Stack.Screen
				name="OnboardingFrame19"
				component={OnboardingFrame19Screen}
				options={{ title: t("onboardingFrame19Title") }}
			/>
			<Stack.Screen
				name="OnboardingFrame20"
				component={OnboardingFrame20Screen}
				options={{ title: t("onboardingFrame20Title") }}
			/>
			<Stack.Screen
				name="OnboardingFrame21"
				component={OnboardingFrame21Screen}
				options={{ title: t("onboardingFrame21Title") }}
			/>
			<Stack.Screen
				name="OnboardingDebug"
				component={OnboardingDebugScreen}
				options={{ title: t("onboardingDebugTitle") }}
			/>
			<Stack.Screen
				name="ElectionDetails"
				component={ElectionDetailsScreen}
				options={({ navigation }) => ({
					title: t("election"),
					presentation: "modal",
					headerBackVisible: false,
					headerLeft: () => <CloseButton onPress={() => navigation.goBack()} />,
				})}
			/>
			<Stack.Screen
				name="EditBallot"
				component={EditBallotScreen}
				options={{ title: t("ballotTemplate") }}
			/>
		</Stack.Navigator>
	);
};
