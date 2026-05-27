import React, { useEffect, useState } from "react";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { useTranslation } from "react-i18next";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { RootStackParamList } from "./types";
import AuthorityDetailsScreen from "../screens/authorities/AuthorityDetailsScreen";
import ProposedAdministrationScreen from "../screens/authorities/ProposedAdministrationScreen";
import OfficerDetailsScreen from "../screens/admin/OfficerDetailsScreen";
import AdministratorInvitationScreen from "../screens/admin/AdministratorInvitationScreen";
import AuthorityInvitationScreen from "../screens/authorities/AuthorityInvitationScreen";
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
import NetworkStatisticsScreen from "../screens/networks/NetworkStatisticsScreen";
import NetworkRevisionScreen from "../screens/networks/NetworkRevisionScreen";
import KeyTaskScreen from "../screens/tasks/KeyTaskScreen";
import SignatureTaskScreen from "../screens/tasks/SignatureTaskScreen";
import EditElectionScreen from "../screens/tasks/EditElectionScreen";
import AuthorityDetailScreen from "../screens/tasks/AuthorityDetailScreen";
import EditElectionWithFilterScreen from "../screens/tasks/EditElectionWithFilterScreen";
import EditRevisionFormScreen from "../screens/tasks/EditRevisionFormScreen";
import ProposedElectionScreen from "../screens/tasks/ProposedElectionScreen";
import ProposedRevisionScreen from "../screens/tasks/ProposedRevisionScreen";
import ScreenScaffoldsDebugScreen from "../screens/tasks/ScreenScaffoldsDebugScreen";
import ElectionDetailsScreen from "../screens/elections/ElectionDetailsScreen";
import { CreateElectionScreen } from "../screens/elections/CreateElectionScreen";
import EditBallotScreen from "../screens/ballots/EditBallotScreen";
// Phase 9 plan 09-04 — Ballot flow screens + scoped draft provider (D-10, D-11)
import CreateBallotScreen from "../screens/ballots/CreateBallotScreen";
import EditQuestionScreen from "../screens/ballots/EditQuestionScreen";
import EditQuestionOption from "../screens/ballots/EditQuestionOption";
import { BallotDraftProvider } from "../screens/ballots/providers/BallotDraftProvider";

/**
 * Ballot-flow scoping per D-11: each of the three ballot screens is registered
 * with a per-screen wrapper that mounts BallotDraftProvider. We use the
 * portable wrapper strategy (b) from the plan rather than `screenLayout` so
 * the wrap is local and obvious. All three screens share the SAME provider
 * instance only when navigated in sequence as part of the same nav stack —
 * which matches the "survives back-navigation within the flow" semantics in
 * D-11. The provider is NOT global (no AppProvider sibling).
 */
const CreateBallotScreenWrapped = (props: React.ComponentProps<typeof CreateBallotScreen>) => (
	<BallotDraftProvider>
		<CreateBallotScreen {...props} />
	</BallotDraftProvider>
);
const EditQuestionScreenWrapped = (props: React.ComponentProps<typeof EditQuestionScreen>) => (
	<BallotDraftProvider>
		<EditQuestionScreen {...props} />
	</BallotDraftProvider>
);
const EditQuestionOptionWrapped = (props: React.ComponentProps<typeof EditQuestionOption>) => (
	<BallotDraftProvider>
		<EditQuestionOption {...props} />
	</BallotDraftProvider>
);

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
				name="NetworkStatistics"
				component={NetworkStatisticsScreen}
				options={{ title: t("statistics") }}
			/>
			<Stack.Screen
				name="NetworkRevision"
				component={NetworkRevisionScreen}
				options={{ title: t("reviseNetwork") }}
			/>
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
				name="ProposedAdministration"
				component={ProposedAdministrationScreen}
				options={{ title: t("proposedAdministration") }}
			/>
			<Stack.Screen
				name="AdministratorInvitation"
				component={AdministratorInvitationScreen}
				options={{ title: t("administratorInvitation") }}
			/>
			<Stack.Screen
				name="AuthorityInvitation"
				component={AuthorityInvitationScreen}
				options={{ title: t("authorityInvitation") }}
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
				name="EditElection"
				component={EditElectionScreen}
				options={{ title: t("editElectionTitle") }}
			/>
			<Stack.Screen
				name="AuthorityDetail"
				component={AuthorityDetailScreen}
				options={{ title: t("authorityDetailTitle") }}
			/>
			<Stack.Screen
				name="EditElectionWithFilter"
				component={EditElectionWithFilterScreen}
				options={{ title: t("editElectionWithFilterTitle") }}
			/>
			<Stack.Screen
				name="EditRevisionForm"
				component={EditRevisionFormScreen}
				options={{ title: t("editRevisionFormTitle") }}
			/>
			<Stack.Screen
				name="ProposedElection"
				component={ProposedElectionScreen}
				options={{ title: t("proposedElectionTitle") }}
			/>
			<Stack.Screen
				name="ProposedRevision"
				component={ProposedRevisionScreen}
				options={{ title: t("proposedRevisionTitle") }}
			/>
			<Stack.Screen
				name="ScreenScaffoldsDebug"
				component={ScreenScaffoldsDebugScreen}
				options={{ title: t("screenScaffoldsDebugTitle") }}
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
			{/* Phase 9 plan 09-02 (ELECUI-03) — CreateElection wizard route. */}
			<Stack.Screen
				name="CreateElection"
				component={CreateElectionScreen}
				options={{ title: t("createElection") }}
			/>
			<Stack.Screen
				name="EditBallot"
				component={EditBallotScreen}
				options={{ title: t("ballotTemplate") }}
			/>
			{/* Phase 9 plan 09-04 (BALUI-01..04) — Ballot flow screen-stack.
			    Each screen mounts its own BallotDraftProvider (D-11 scoped).
			    Native-stack keeps pushed screens mounted, so the parent
			    CreateBallot provider survives across EditQuestion/Option
			    pushes and receives carry-back data via popTo route params. */}
			<Stack.Screen
				name="CreateBallot"
				component={CreateBallotScreenWrapped}
				options={{ title: t("createBallot") }}
			/>
			<Stack.Screen
				name="EditQuestion"
				component={EditQuestionScreenWrapped}
				options={{ title: t("question") }}
			/>
			<Stack.Screen
				name="EditQuestionOption"
				component={EditQuestionOptionWrapped}
				options={{ title: t("option") }}
			/>
		</Stack.Navigator>
	);
};
