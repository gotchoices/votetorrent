import React, { useCallback, useState } from "react";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { useTranslation } from "react-i18next";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { RootStackParamList } from "./types";
import AuthorityDetailsScreen from "../screens/authorities/AuthorityDetailsScreen";
import ProposedAdministrationScreen from "../screens/authorities/ProposedAdministrationScreen";
import OfficerDetailsScreen from "../screens/admin/OfficerDetailsScreen";
import AcceptInvitationScreen from "../screens/invitations/AcceptInvitationScreen";
import AdministratorInvitationScreen from "../screens/admin/AdministratorInvitationScreen";
import AuthorityInvitationScreen from "../screens/authorities/AuthorityInvitationScreen";
import ElectionsScreen from "../screens/elections/ElectionsScreen";
import TasksScreen from "../screens/tasks/TasksScreen";
import AuthoritiesScreen from "../screens/authorities/AuthoritiesScreen";
import SettingsScreen from "../screens/settings/SettingsScreen";
import { ChipButton } from "../components/ChipButton";
import { SyncChip } from "../components/SyncChip";
import { Pressable, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, StackActions, useFocusEffect } from "@react-navigation/native";
import { useTheme } from "@react-navigation/native";
import NetworksScreen from "../screens/networks/NetworksScreen";
import type { NavigationProp } from "./types";
import AddNetworkScreen from "../screens/networks/AddNetworkScreen";
import HostingScreen from "../screens/networks/HostingScreen";
import ImportFoundingBundleScreen from "../screens/networks/ImportFoundingBundleScreen";
import JoinNetworkScreen from "../screens/networks/JoinNetworkScreen";
import { useApp } from "../providers/AppProvider";
import { useTaskCount } from "../hooks/useTaskCount";
import EditOfficerScreen from "../screens/admin/EditOfficerScreen";
import { ThemedText } from "../components/ThemedText";
import { INetworkEngine } from "@votetorrent/vote-core";
import DefaultUserScreen from "../screens/users/DefaultUserScreen";
import UserDetailsScreen from "../screens/users/UserDetailsScreen";
import ReviseUserScreen from "../screens/users/ReviseUserScreen";
import AddKeyScreen from "../screens/users/AddKeyScreen";
import RevokeKeyScreen from "../screens/users/RevokeKeyScreen";
import AddDeviceScreen from "../screens/users/AddDeviceScreen";
import AddedKeyScreen from "../screens/users/AddedKeyScreen";
import KeyholderScreen from "../screens/keyholder/KeyholderScreen";
import KeyholderInvitationScreen from "../screens/keyholder/KeyholderInvitationScreen";
import KeyReleaseScreen from "../screens/keyholder/KeyReleaseScreen";
import NetworkDetailsScreen from "../screens/networks/NetworkDetailsScreen";
import NetworkStatisticsScreen from "../screens/networks/NetworkStatisticsScreen";
import NetworkRevisionScreen from "../screens/networks/NetworkRevisionScreen";
import SignatureTaskScreen from "../screens/tasks/SignatureTaskScreen";
import EditElectionScreen from "../screens/tasks/EditElectionScreen";
import AuthorityDetailScreen from "../screens/tasks/AuthorityDetailScreen";
import EditElectionWithFilterScreen from "../screens/tasks/EditElectionWithFilterScreen";
import EditRevisionFormScreen from "../screens/tasks/EditRevisionFormScreen";
import ProposedElectionScreen from "../screens/tasks/ProposedElectionScreen";
import ProposedRevisionScreen from "../screens/tasks/ProposedRevisionScreen";
import ElectionDetailsScreen from "../screens/elections/ElectionDetailsScreen";
import RegistrationPolicyScreen from "../screens/elections/RegistrationPolicyScreen";
// Phase 48 plan 48-21 (D-12) — the three Phase 48 screen modules.
import RegistrationInboxScreen from "../screens/registration/RegistrationInboxScreen";
import RegistrationRequestApprovalScreen from "../screens/registration/RegistrationRequestApprovalScreen";
import AssociationRequestApprovalScreen from "../screens/registration/AssociationRequestApprovalScreen";
// BulkImportSyncScreen (48-20) is a named export, not a default export —
// imported accordingly (a Rule-1 fix: the plan's "default imports" language
// does not hold for this one file).
import { BulkImportSyncScreen } from "../screens/registration/BulkImportSyncScreen";
// Phase 51 plan 51-10 (D-06/D-19) — the read-only association-request status screen.
import AssociationRequestStatusScreen from "../screens/registration/AssociationRequestStatusScreen";
// Phase 47 plan 47-21 (D-08) — the five Phase 47 screen modules.
import RegistrantsListScreen from "../screens/registration/RegistrantsListScreen";
import ElectionResultsScreen from "../screens/elections/ElectionResultsScreen";
import RegistrantDetailScreen from "../screens/registration/RegistrantDetailScreen";
import AttestationProvisioningStatusScreen from "../screens/registration/AttestationProvisioningStatusScreen";
// Phase 49 plan 49-10 (D-14) — the officer-facing signing-key provisioning/recovery screen.
import ProvisionSigningKeyScreen from "../screens/users/ProvisionSigningKeyScreen";
import PairBrowserScreen from "../screens/dashboard/PairBrowserScreen";
import PairedBrowsersScreen from "../screens/dashboard/PairedBrowsersScreen";
import PollingDevicesScreen from "../screens/authorities/PollingDevicesScreen";
import AuthorityPeersScreen from "../screens/authorities/AuthorityPeersScreen";
import { CreateElectionScreen } from "../screens/elections/CreateElectionScreen";
// Phase 9 plan 09-13 (ELECUI-04) — Election Revision screen (Screen C, Figma #16/#17).
// Aliased to avoid name collision with task-flow EditElectionScreen (imported above on ~line 40).
import EditElectionRevisionScreen from "../screens/elections/EditElectionScreen";
import EditBallotScreen from "../screens/ballots/EditBallotScreen";
// Phase 9 plan 09-04 — Ballot flow screens + scoped draft provider (D-10, D-11)
import CreateBallotScreen from "../screens/ballots/CreateBallotScreen";
import EditQuestionScreen from "../screens/ballots/EditQuestionScreen";
import EditQuestionOption from "../screens/ballots/EditQuestionOption";

// Phase 57 (T-57-16-05) — debug-only scaffold route. Loaded through a
// __DEV__-guarded require rather than a static import so the module is not a
// static dependency of the release bundle, and registered below only in dev.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ScreenScaffoldsDebugScreen: React.ComponentType | undefined = __DEV__
	? require("../screens/tasks/ScreenScaffoldsDebugScreen").default
	: undefined;

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator();

function HeaderTitle() {
	const { hasNetwork, getEngine } = useApp();
	const { t } = useTranslation();
	const navigation = useNavigation<NavigationProp>();
	const [networkName, setNetworkName] = useState<string | null>(null);

	// Re-fetch the active network's name on every focus (not just mount), so selecting
	// a different network via NetworkDetails' Select button updates the persistent header
	// title on return. A one-shot useEffect keyed on [hasNetwork, getEngine] never re-ran
	// because neither dep changes on a network switch (currentNetworkHash is internal to
	// the factory). Mirrors the useFocusEffect reload pattern used by ElectionsScreen.
	useFocusEffect(
		useCallback(() => {
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
		}, [hasNetwork, getEngine])
	);

	return (
		<Pressable
			onPress={() => navigation.navigate("Networks")}
			style={[styles.networkTextContainer, styles.headerText]}
			accessibilityRole="button"
		>
			<ThemedText type="header">{networkName ? networkName : t("selectNetwork")}</ThemedText>
		</Pressable>
	);
}

// Tasks spans every network, so it's titled "All Networks" — but only once there IS a
// network. With none selected, show the same "Select Network" control as the other tabs,
// since the empty state below tells the officer to tap exactly that.
function TasksHeaderTitle() {
	const { hasNetwork } = useApp();
	const { t } = useTranslation();
	return hasNetwork ? <ThemedText type="header">{t("allNetworks")}</ThemedText> : <HeaderTitle />;
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
			<Pressable
				onPress={handleNetworkPress}
				style={styles.headerButton}
				accessibilityRole="button"
				accessibilityLabel={t("a11yChooseNetwork")}
			>
				<FontAwesome6 name="cloud-rain" size={24} color={colors.text} />
			</Pressable>
		),
		headerRight: () => (
			<View style={styles.headerRightContainer}>
				{/* Global event-driven sync chip — rendered under CadreNodeProvider
				    (header lives inside the navigator, which App.tsx nests inside
				    CadreNodeProvider), so useCadreNode() resolves. Single app-wide chip
				    in the persistent tab header chrome (P2P-07). */}
				<SyncChip />
				<Pressable
					style={styles.headerButton}
					onPress={() => navigation.navigate("Home", { screen: "Settings" })}
					accessibilityRole="button"
					accessibilityLabel={t("a11yOpenSettings")}
				>
					<FontAwesome6 name="circle-user" size={24} color={colors.text} />
				</Pressable>
			</View>
		),
		headerTitle: () =>
			tab === "tasks" ? <TasksHeaderTitle /> : <HeaderTitle />,
		headerShadowVisible: true,
	};
}

const TabNavigator = () => {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const taskCount = useTaskCount();

	return (
		<Tab.Navigator
			screenOptions={({ route }) => ({
				tabBarLabel: t(route.name.toLowerCase()),
				// Without this, Android joins the icon glyph's empty text to the label and
				// screen readers announce ", Elections".
				tabBarAccessibilityLabel: t(route.name.toLowerCase()),
				tabBarIcon: ({ color }) => {
					// One icon family for every tab (previously E/T/A letters beside a gear).
					const iconMap: Record<string, string> = {
						Elections: "check-to-slot",
						Tasks: "list-check",
						Authorities: "building-columns",
						Settings: "gear",
					};
					return <FontAwesome6 name={iconMap[route.name] ?? "circle"} size={22} color={color} />;
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
					tabBarBadge: taskCount > 0 ? taskCount : undefined,
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
		minWidth: 44,
		minHeight: 44,
		alignItems: "center",
		justifyContent: "center",
	},
	headerRightContainer: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
	},
});

export function CloseButton({ onPress }: { onPress: () => void }) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	return (
		<Pressable
			onPress={onPress}
			style={styles.headerButton}
			hitSlop={8}
			accessibilityRole="button"
			accessibilityLabel={t("close")}
		>
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
				name="ImportFoundingBundle"
				component={ImportFoundingBundleScreen}
				options={{ title: t("networkFoundingImportScreenTitle") }}
			/>
			<Stack.Screen
				name="JoinNetwork"
				component={JoinNetworkScreen}
				options={{ title: t("joinNetworkTitle") }}
			/>
			<Stack.Screen
				name="AssociationRequestApproval"
				component={AssociationRequestApprovalScreen}
				options={{ title: t("associationApprovalScreenTitle") }}
			/>
			<Stack.Screen
				name="KeyRelease"
				component={KeyReleaseScreen}
				options={({ navigation }) => ({
					title: t("keyholderReleaseScreenTitle"),
					presentation: "modal",
					headerBackVisible: false,
					headerLeft: () => <CloseButton onPress={() => navigation.goBack()} />,
				})}
			/>
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
				name="AcceptInvitation"
				component={AcceptInvitationScreen}
				options={{ title: t("invitationAcceptTitle") }}
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
				name="EditOfficer"
				component={EditOfficerScreen}
				options={{
					title: t("administrator"),
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
			{/* Phase 10 plan 10-01 (USRUI-05, USRUI-09; D-01) — confirmation routes */}
			<Stack.Screen
				name="AddedKey"
				component={AddedKeyScreen}
				options={{ title: t("addedKey") }}
			/>
			{/* Phase 10 plan 10-02 (KHUI-01/02; D-05) — keyholder routes */}
			<Stack.Screen
				name="Keyholder"
				component={KeyholderScreen}
				options={{ title: t("keyholder") }}
			/>
			<Stack.Screen
				name="KeyholderInvitation"
				component={KeyholderInvitationScreen}
				options={{ title: t("keyholderInvitation") }}
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
			{__DEV__ && ScreenScaffoldsDebugScreen ? (
				<Stack.Screen
					name="ScreenScaffoldsDebug"
					component={ScreenScaffoldsDebugScreen}
					options={{ title: t("screenScaffoldsDebugTitle") }}
				/>
			) : null}
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
			{/* Phase 9 plan 09-13 (ELECUI-04) — EditElectionRevision route (Screen C, Figma #16/#17).
			    Separate from the task-flow EditElection route — points at elections/EditElectionScreen. */}
			<Stack.Screen
				name="EditElectionRevision"
				component={EditElectionRevisionScreen}
				options={{ title: t("electionRevisionTitle") }}
			/>
			{/* Phase 46 (D-01) — RegistrationPolicy: a push from within the election
			    modal, not a new modal, so it uses the simple non-modal options={{ title }}
			    shape (the CreateBallot/EditBallot precedent), not ElectionDetails's
			    presentation:"modal" + CloseButton header shape. */}
			<Stack.Screen
				name="RegistrationPolicy"
				component={RegistrationPolicyScreen}
				options={{ title: t("registrationPolicyEntryTitle") }}
			/>
			{/* Phase 48 plan 48-21 (D-12) — the three Phase 48 routes. Pushes from
			    within Authority Details / the inbox itself, so they use the same
			    non-modal options={{ title }} shape as RegistrationPolicy and the
			    Phase 47 block below — never presentation:"modal", never a
			    CloseButton headerLeft (that shape is reserved for the
			    ElectionDetails screen family). RegistrationInbox and
			    RegistrationRequestApproval additionally set their own title via
			    setOptions (the static title here is the pre-effect frame);
			    BulkImportSync is bound ONLY here. No headerRight on any of the
			    three: the inbox sets ONLY its title via setOptions and renders
			    its Bulk Import / Sync control in the screen body instead (48-27,
			    closing 48-UAT.md gap 4 — a locale-dependent header chip left no
			    room for the title in Spanish), and a duplicate header chip is
			    exactly what 47-18 removed from AuthorityPeers. */}
			<Stack.Screen
				name="RegistrationInbox"
				component={RegistrationInboxScreen}
				options={{ title: t("registrationRequestScreenTitle") }}
			/>
			<Stack.Screen
				name="RegistrationRequestApproval"
				component={RegistrationRequestApprovalScreen}
				options={{ title: t("registrationRequestApprovalScreenTitle") }}
			/>
			<Stack.Screen
				name="BulkImportSync"
				component={BulkImportSyncScreen}
				options={{ title: t("bulkImportSyncScreenTitle") }}
			/>
			{/* Phase 51 plan 51-10 (D-06/D-19) — the read-only association-request status
			    screen, bound ONLY here, mirroring AttestationProvisioningStatus's own
			    binding-site convention. */}
			<Stack.Screen
				name="AssociationRequestStatus"
				component={AssociationRequestStatusScreen}
				options={{ title: t("associationRequestStatusScreenTitle") }}
			/>
			{/* Election results — a non-modal push from ElectionDetails. */}
			<Stack.Screen
				name="ElectionResults"
				component={ElectionResultsScreen}
				options={{ title: t("resultsScreenTitle") }}
			/>
			{/* Phase 47 plan 47-21 (D-07/D-08/D-09) — the five Phase 47 routes. These are
			    pushes from within existing modal screens, so they use the
			    RegistrationPolicy/CreateBallot non-modal options={{ title }} shape, never
			    presentation:"modal", never a CloseButton headerLeft. RegistrantsList,
			    RegistrantDetail and PollingDevices additionally set their own title via
			    setOptions (the static title here is the pre-effect frame, and for
			    PollingDevices is the identical key), while AuthorityPeers and
			    AttestationProvisioningStatus are bound ONLY here — 47-19 source-gates
			    attestationProvisioningScreenTitle at zero occurrences in its own file for
			    exactly this reason. */}
			<Stack.Screen
				name="RegistrantsList"
				component={RegistrantsListScreen}
				options={{ title: t("registrantListScreenTitle") }}
			/>
			<Stack.Screen
				name="RegistrantDetail"
				component={RegistrantDetailScreen}
				options={{ title: t("registrantDetailScreenTitle") }}
			/>
			<Stack.Screen
				name="AttestationProvisioningStatus"
				component={AttestationProvisioningStatusScreen}
				options={{ title: t("attestationProvisioningScreenTitle") }}
			/>
			<Stack.Screen
				name="ProvisionSigningKey"
				component={ProvisionSigningKeyScreen}
				options={{ title: t("signingKeyProvisioningScreenTitle") }}
			/>
			{/* Pair a browser: this officer pairs their own browser. Pushed from
			    Settings (and from the paired-browsers list), so it uses the same
			    non-modal options={{ title }} shape as ProvisionSigningKey above,
			    never presentation:"modal", never a CloseButton headerLeft. */}
			<Stack.Screen
				name="PairBrowser"
				component={PairBrowserScreen}
				options={{ title: t("dashboardPairingTitle") }}
			/>
			{/* The officer's own paired browsers (pushed from their user details). The "+"
			    header action is set by the screen itself, so the registration stays title-only. */}
			<Stack.Screen
				name="PairedBrowsers"
				component={PairedBrowsersScreen}
				options={{ title: t("pairedBrowsersTitle") }}
			/>
			<Stack.Screen
				name="PollingDevices"
				component={PollingDevicesScreen}
				options={{ title: t("pollingDeviceScreenTitle") }}
			/>
			<Stack.Screen
				name="AuthorityPeers"
				component={AuthorityPeersScreen}
				options={{ title: t("authorityPeerScreenTitle") }}
			/>
			{/* BallotDraftProvider is hoisted above the navigator (App.tsx) so all
			    ballot screens share ONE draft instance (screenLayout gave each
			    screen its own — D-11 root fix). Group retained only for grouping. */}
			<Stack.Group>
				<Stack.Screen
					name="CreateBallot"
					component={CreateBallotScreen}
					options={{ title: t("ballotTemplate") }}
				/>
				<Stack.Screen
					name="EditBallot"
					component={EditBallotScreen}
					options={{ title: t("ballotTemplate") }}
				/>
				<Stack.Screen
					name="EditQuestion"
					component={EditQuestionScreen}
					options={({ navigation, route }) => ({
						title: t("ballotQuestion"),
						headerRight: () => (
							<ChipButton
								label={t("remove")}
								icon="trash"
								onPress={() => {
									const questionCode = (route.params as { questionCode?: string })?.questionCode;
									if (!questionCode) {
										navigation.goBack();
										return;
									}
									// popTo whichever ballot-root is actually in the stack;
									// merge=true keeps the target's electionEngine/context params.
									const state = navigation.getState();
									const hasEditBallot = state.routes.some((r: { name: string }) => r.name === "EditBallot");
									navigation.dispatch(
										StackActions.popTo(
											hasEditBallot ? "EditBallot" : "CreateBallot",
											{ removeQuestionCode: questionCode },
											{ merge: true }
										)
									);
								}}
							/>
						),
					})}
				/>
				<Stack.Screen
					name="EditQuestionOption"
					component={EditQuestionOption}
					options={({ navigation, route }) => ({
						title: t("questionOption"),
						headerRight: () => (
							<ChipButton
								label={t("remove")}
								icon="trash"
								onPress={() => {
									const optionCode = (route.params as { optionCode?: string })?.optionCode;
									const questionCode = (route.params as { questionCode?: string })?.questionCode ?? "";
									if (!optionCode) {
										navigation.goBack();
										return;
									}
									navigation.dispatch(
										StackActions.popTo(
											"EditQuestion",
											{ questionCode, removeOptionCode: optionCode },
											{ merge: true }
										)
									);
								}}
							/>
						),
					})}
				/>
			</Stack.Group>
		</Stack.Navigator>
	);
};
