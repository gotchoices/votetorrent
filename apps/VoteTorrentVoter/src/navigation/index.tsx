/**
 * RootNavigator (D-08) — Voting's `RootNavigator` IS the bottom `Tab.Navigator` itself (unlike
 * Authority's flat single-root-stack + hoisted-modals shape, where the tab bar is nested INSIDE
 * one root stack). Each of the 4 tabs mounts its OWN `createNativeStackNavigator` instance owning
 * that tab's screens + modal-presentation routes — a deliberate, justified per-tab nested-stack
 * topology (D-08). Do NOT collapse this back into a single flat root stack.
 *
 * Modal mechanics (CloseButton, `presentation: 'modal'`, `headerBackVisible: false`) and tab-bar
 * mechanics are reused byte-identical to Authority's `navigation/index.tsx` (D-16), but tab order/
 * roots (D-09), FontAwesome6 glyphs (D-10), and tab-bar color tokens (Phase 38 tokens, Pitfall 5)
 * are Voting-specific.
 */
import React from 'react';
import type {PropsWithChildren} from 'react';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {useTranslation} from 'react-i18next';
import {ExtendedTheme, getFocusedRouteNameFromRoute, useTheme} from '@react-navigation/native';
import type {RouteProp} from '@react-navigation/native';
import {Pressable, StyleSheet} from 'react-native';
import type {
	RegistrationStackParamList,
	RootTabParamList,
	ScanStackParamList,
	SettingsStackParamList,
	TimelineStackParamList,
	VoteStackParamList,
} from './types';
import HomeScreen from '../screens/home/HomeScreen';
import ValidationDetailsScreen from '../screens/home/ValidationDetailsScreen';
import BallotScreen from '../screens/ballot/BallotScreen';
import IndividualQuestionScreen from '../screens/ballot/IndividualQuestionScreen';
import ReviewSubmitScreen from '../screens/ballot/ReviewSubmitScreen';
import VoteReceiptScreen from '../screens/ballot/VoteReceiptScreen';
import RegistrationScreen from '../screens/registration/RegistrationScreen';
import DeviceAttestationScreen from '../screens/registration/DeviceAttestationScreen';
import RegisterPersonalScreen from '../screens/registration/RegisterPersonalScreen';
import RegisterAddressPartyScreen from '../screens/registration/RegisterAddressPartyScreen';
import RegisterConfirmScreen from '../screens/registration/RegisterConfirmScreen';
import ConfirmationScreen from '../screens/registration/ConfirmationScreen';
import ContinueOnAnotherDeviceScreen from '../screens/registration/ContinueOnAnotherDeviceScreen';
import {DeviceRetiredNotice, useDeviceRetired} from '../screens/registration/DeviceRetiredNotice';
import ScanScreen from '../screens/scan/ScanScreen';
import SettingsScreen from '../screens/settings/SettingsScreen';
import JoinNetworkScreen from '../screens/settings/JoinNetworkScreen';
import TimelineScreen from '../screens/timeline/TimelineScreen';
import KeyholdersScreen from '../screens/timeline/KeyholdersScreen';
import ResultsScreen from '../screens/timeline/ResultsScreen';
import RegistrationInfoScreen from '../screens/registration/RegistrationInfoScreen';
import {RegistrationDraftProvider} from '../providers/RegistrationDraftProvider';
import {BallotSelectionProvider} from '../providers/BallotSelectionProvider';

// CloseButton (D-16) — byte-identical mechanics to Authority's `navigation/index.tsx` CloseButton
// (lines 249-256): a Pressable with hitSlop=8 wrapping a FontAwesome6 "xmark" glyph, calling the
// caller-supplied onPress (always `navigation.goBack()` at each modal's options callsite below).
export function CloseButton({onPress}: {onPress: () => void}) {
	const {colors} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('common');
	return (
		<Pressable
			onPress={onPress}
			style={styles.headerButton}
			hitSlop={8}
			accessibilityRole="button"
			accessibilityLabel={t('close')}>
			<FontAwesome6 name="xmark" size={22} color={colors.text} />
		</Pressable>
	);
}

// --- Vote stack (D-09): Home root, Ballot pushed, 4 modal routes (D-08 per-tab nested stack) ---
const VoteStack = createNativeStackNavigator<VoteStackParamList>();

function VoteStackNavigator() {
	const {t: tHome} = useTranslation('home');
	const {t: tBallot} = useTranslation('ballot');

	return (
		<VoteStack.Navigator>
			{/* headerShown:false — HomeScreen renders the branded blue NetworkHeader itself. */}
			<VoteStack.Screen
				name="Home"
				component={HomeScreen}
				options={{headerShown: false}}
			/>
			<VoteStack.Screen
				name="Ballot"
				component={BallotScreen}
				options={{title: tBallot('headerTitle')}}
			/>
			{/* HOME-03/D-11: plain push (default header, back chevron), matching Ballot's own
			    registration exactly — NOT a modal (RESEARCH Anti-Patterns: no breadcrumb component). */}
			<VoteStack.Screen
				name="ValidationDetails"
				component={ValidationDetailsScreen}
				options={{title: tHome('validationDetailsTitle')}}
			/>
			<VoteStack.Screen
				name="IndividualQuestion"
				component={IndividualQuestionScreen}
				options={({navigation}) => ({
					title: tBallot('individualQuestionTitle'),
					presentation: 'modal',
					headerBackVisible: false,
					headerLeft: () => <CloseButton onPress={() => navigation.goBack()} />,
				})}
			/>
			{/* VOTE-04/D-05: plain push (default header, back chevron) — mirrors ValidationDetails,
			    NOT a modal. Selection state lives on BallotSelectionProvider, not a route param. */}
			<VoteStack.Screen
				name="ReviewSubmit"
				component={ReviewSubmitScreen}
				options={{title: tBallot('reviewSubmitTitle')}}
			/>
			{/* D-10: plain push. Params carry only electionId and revealOnOpen, never a record field. */}
			<VoteStack.Screen
				name="VoteReceipt"
				component={VoteReceiptScreen}
				options={{title: tBallot('receipt.title')}}
			/>
		</VoteStack.Navigator>
	);
}

// --- Timeline stack (Phase 59, D-14/D-15/D-22): TimelineHome root, plus the full reachable
// route closure so a row action pushes WITHIN this stack and Back returns to the rail — the
// Timeline tab stays highlighted (D-14). Registers the SAME screen components the Vote and
// Registration stacks already import, with `options` copied verbatim from each screen's existing
// registration so header titles / headerShown / presentation:'modal' stay byte-identical across
// stacks. Neither BallotSelectionProvider nor RegistrationDraftProvider is mounted here — both
// are lifted to AppStateProviders above <Tab.Navigator> (D-22); mounting either inside this
// function would mint a second, unsynced instance and silently reset a draft started on another
// tab (see provider-scope.test.tsx's planted negative control).
const TimelineStack = createNativeStackNavigator<TimelineStackParamList>();

function TimelineStackNavigator() {
	const {t: tKeyholders} = useTranslation('timeline');
	const {t: tBallot} = useTranslation('ballot');
	const {t: tRegistration} = useTranslation('registration');
	const {t: tJoin} = useTranslation('join');

	return (
		<TimelineStack.Navigator>
			{/* headerShown:false — TimelineScreen renders its own election-title-over-date-range
			    header block per the UI-SPEC; no timeline.headerTitle key exists to feed a native
			    header. */}
			<TimelineStack.Screen
				name="TimelineHome"
				component={TimelineScreen}
				options={{headerShown: false}}
			/>
			<TimelineStack.Screen
				name="Ballot"
				component={BallotScreen}
				options={{title: tBallot('headerTitle')}}
			/>
			<TimelineStack.Screen
				name="IndividualQuestion"
				component={IndividualQuestionScreen}
				options={({navigation}) => ({
					title: tBallot('individualQuestionTitle'),
					presentation: 'modal',
					headerBackVisible: false,
					headerLeft: () => <CloseButton onPress={() => navigation.goBack()} />,
				})}
			/>
			<TimelineStack.Screen
				name="ReviewSubmit"
				component={ReviewSubmitScreen}
				options={{title: tBallot('reviewSubmitTitle')}}
			/>
			{/* D-10: plain push; registered on both stacks so a Timeline-initiated Submit does not
			    dead-end (route closure). Params carry only electionId and revealOnOpen. */}
			<TimelineStack.Screen
				name="VoteReceipt"
				component={VoteReceiptScreen}
				options={{title: tBallot('receipt.title')}}
			/>
			{/* headerShown:false — RegistrationScreen renders the branded blue NetworkHeader itself. */}
			<TimelineStack.Screen
				name="RegistrationHome"
				component={RegistrationScreen}
				options={{headerShown: false}}
			/>
			<TimelineStack.Screen
				name="RegistrationInfo"
				component={RegistrationInfoScreen}
				options={({navigation}) => ({
					title: tRegistration('headerTitle'),
					presentation: 'modal',
					headerBackVisible: false,
					headerLeft: () => <CloseButton onPress={() => navigation.goBack()} />,
				})}
			/>
			{/* 41-RESEARCH.md Pitfall 3: real screen, headerShown:false — NOT presentation:'modal'
			    + CloseButton (full-bleed timed interstitial, no swipe-dismiss). */}
			<TimelineStack.Screen
				name="DeviceAttestation"
				component={DeviceAttestationScreen}
				options={{headerShown: false}}
			/>
			{/* Form steps are full-bleed (headerShown:false) — each renders its own
			    RegisterFormHeader (back-arrow / close / title / subtitle / step dots). */}
			<TimelineStack.Screen
				name="RegisterPersonal"
				component={RegisterPersonalScreen}
				options={{headerShown: false}}
			/>
			<TimelineStack.Screen
				name="RegisterAddressParty"
				component={RegisterAddressPartyScreen}
				options={{headerShown: false}}
			/>
			<TimelineStack.Screen
				name="RegisterConfirm"
				component={RegisterConfirmScreen}
				options={{headerShown: false}}
			/>
			{/* Pitfall 3: real screen, headerShown:false — NOT presentation:'modal' + CloseButton. */}
			<TimelineStack.Screen
				name="Confirmation"
				component={ConfirmationScreen}
				options={{headerShown: false}}
			/>
			{/* Phase 62 Plan 28 (D-14 route-closure gate) — Surfaces 8/9, headerShown:false (the
			    screen renders its own close control). */}
			<TimelineStack.Screen
				name="ContinueOnAnotherDevice"
				component={ContinueOnAnotherDeviceScreen}
				options={{headerShown: false}}
			/>
			{/* Spike 100 (D-14 route closure) — RegistrationScreen's join entry link. */}
			<TimelineStack.Screen
				name="JoinNetwork"
				component={JoinNetworkScreen}
				options={{title: tJoin('headerTitle')}}
			/>
			{/* D-15: plain push (default header, back chevron) — mirrors ValidationDetails on the
			    Vote stack, never presentation:'modal'. */}
			<TimelineStack.Screen
				name="Keyholders"
				component={KeyholdersScreen}
				options={{title: tKeyholders('keyholders.screenTitle')}}
			/>
			<TimelineStack.Screen
				name="Results"
				component={ResultsScreen}
				options={{title: tKeyholders('results.screenTitle')}}
			/>
		</TimelineStack.Navigator>
	);
}

// --- Registration stack (D-09): root + form steps + DeviceAttestation/Confirmation (full-bleed,
// see Pitfall 3) + RegistrationInfo help modal. Wrapped in RegistrationDraftProvider (Pattern 2)
// so RegistrationHome's registered card and all form steps share one draft instance.
const RegistrationStack = createNativeStackNavigator<RegistrationStackParamList>();

function RegistrationStackNavigator() {
	const {t} = useTranslation('registration');
	const {t: tJoin} = useTranslation('join');

	return (
		<RegistrationStack.Navigator>
			{/* headerShown:false — RegistrationScreen renders the branded blue NetworkHeader itself. */}
			<RegistrationStack.Screen
				name="RegistrationHome"
				component={RegistrationScreen}
				options={{headerShown: false}}
			/>
			{/* 41-RESEARCH.md Pitfall 3: real screen, headerShown:false — NOT presentation:'modal'
			    + CloseButton (full-bleed timed interstitial, no swipe-dismiss). */}
			<RegistrationStack.Screen
				name="DeviceAttestation"
				component={DeviceAttestationScreen}
				options={{headerShown: false}}
			/>
			{/* Form steps are full-bleed (headerShown:false) — each renders its own
			    RegisterFormHeader (back-arrow / close / title / subtitle / step dots). */}
			<RegistrationStack.Screen
				name="RegisterPersonal"
				component={RegisterPersonalScreen}
				options={{headerShown: false}}
			/>
			<RegistrationStack.Screen
				name="RegisterAddressParty"
				component={RegisterAddressPartyScreen}
				options={{headerShown: false}}
			/>
			<RegistrationStack.Screen
				name="RegisterConfirm"
				component={RegisterConfirmScreen}
				options={{headerShown: false}}
			/>
			{/* Pitfall 3: real screen, headerShown:false — NOT presentation:'modal' + CloseButton. */}
			<RegistrationStack.Screen
				name="Confirmation"
				component={ConfirmationScreen}
				options={{headerShown: false}}
			/>
			{/* Phase 62 Plan 28 (D-40/D-43/D-45) — Surfaces 8/9, headerShown:false (the screen
			    renders its own close control). */}
			<RegistrationStack.Screen
				name="ContinueOnAnotherDevice"
				component={ContinueOnAnotherDeviceScreen}
				options={{headerShown: false}}
			/>
			{/* Spike 100: RegistrationHome's join entry link, shown while no network is open. */}
			<RegistrationStack.Screen
				name="JoinNetwork"
				component={JoinNetworkScreen}
				options={{title: tJoin('headerTitle')}}
			/>
			<RegistrationStack.Screen
				name="RegistrationInfo"
				component={RegistrationInfoScreen}
				options={({navigation}) => ({
					title: t('headerTitle'),
					presentation: 'modal',
					headerBackVisible: false,
					headerLeft: () => <CloseButton onPress={() => navigation.goBack()} />,
				})}
			/>
		</RegistrationStack.Navigator>
	);
}

// --- Scan stack (D-09): single root screen, no modals ---
const ScanStack = createNativeStackNavigator<ScanStackParamList>();

function ScanStackNavigator() {
	const {t} = useTranslation('scan');

	return (
		<ScanStack.Navigator>
			<ScanStack.Screen
				name="ScanHome"
				component={ScanScreen}
				options={{title: t('headerTitle')}}
			/>
		</ScanStack.Navigator>
	);
}

// --- Settings stack (D-09): single root screen, no modals ---
const SettingsStack = createNativeStackNavigator<SettingsStackParamList>();

function SettingsStackNavigator() {
	const {t} = useTranslation('settings');
	const {t: tJoin} = useTranslation('join');

	return (
		<SettingsStack.Navigator>
			<SettingsStack.Screen
				name="SettingsHome"
				component={SettingsScreen}
				options={{title: t('headerTitle')}}
			/>
			<SettingsStack.Screen
				name="JoinNetwork"
				component={JoinNetworkScreen}
				options={{title: tJoin('headerTitle')}}
			/>
		</SettingsStack.Navigator>
	);
}

// Registration-tab routes that HIDE the bottom tab bar: the register form is one continuous,
// un-interruptible process, so the user must not be able to tab away mid-flow and break it. The
// tab bar shows only on the RegistrationHome root (getFocusedRouteNameFromRoute → undefined on the
// tab's first focus, i.e. the root — treated as visible).
const REGISTRATION_FULLSCREEN_ROUTES = [
	'DeviceAttestation',
	'RegisterPersonal',
	'RegisterAddressParty',
	'RegisterConfirm',
	'Confirmation',
	// Phase 62 Plan 28 — Surfaces 8/9 are their own continuous, un-interruptible flow too.
	'ContinueOnAnotherDevice',
];

function registrationTabBarStyle(route: RouteProp<RootTabParamList, 'Registration'>) {
	const focused = getFocusedRouteNameFromRoute(route) ?? 'RegistrationHome';
	return REGISTRATION_FULLSCREEN_ROUTES.includes(focused)
		? ({display: 'none'} as const)
		: undefined;
}

// Timeline-tab routes that HIDE the bottom tab bar (Phase 59, D-13): the Timeline stack now owns
// the SAME DeviceAttestation/RegisterPersonal/RegisterAddressParty/RegisterConfirm/Confirmation
// routes the Registration tab already hides the tab bar for (D-14 reuses the same screen
// components) — the register form is one continuous, un-interruptible process, and that
// rationale does not change with the entry point. Reuses REGISTRATION_FULLSCREEN_ROUTES verbatim;
// the fallback is 'TimelineHome' (this stack's own root), not 'RegistrationHome'.
function timelineTabBarStyle(route: RouteProp<RootTabParamList, 'Timeline'>) {
	const focused = getFocusedRouteNameFromRoute(route) ?? 'TimelineHome';
	return REGISTRATION_FULLSCREEN_ROUTES.includes(focused)
		? ({display: 'none'} as const)
		: undefined;
}

// --- AppStateProviders (D-22) — app-scoped state lift ------------------------------------------
// BallotSelectionProvider and RegistrationDraftProvider used to be mounted PER-STACK
// (BallotSelectionProvider inside VoteStackNavigator, RegistrationDraftProvider inside
// RegistrationStackNavigator). 59-10 will add a Timeline stack with duplicate `Ballot` /
// `ReviewSubmit` / `RegistrationHome` route entries (D-14) — reusing the SAME screen
// components, but each per-stack provider wrap would mint a SECOND, unsynced provider
// instance for those duplicate routes, silently resetting a ballot selection or registration
// draft started from the Vote/Registration tab when the same screen is reached from Timeline.
//
// D-22 fixes this by lifting both providers to wrap RootNavigator's <Tab.Navigator> itself, so
// exactly ONE instance of each spans every tab entry point. Exported (named, not default) so
// __tests__/provider-scope.test.tsx can mount this exact production composition directly.
//
// Moving either provider back inside a per-tab stack navigator silently reintroduces the
// duplicate-instance defect 59-10 depends on this lift to avoid — see provider-scope.test.tsx's
// planted negative control, which proves the gate catches exactly that regression.
export function AppStateProviders({children}: PropsWithChildren) {
	return (
		<BallotSelectionProvider>
			<RegistrationDraftProvider>{children}</RegistrationDraftProvider>
		</BallotSelectionProvider>
	);
}

// --- RootNavigator: the bottom Tab.Navigator itself (D-08), 4 tabs in D-09 locked order ---
const Tab = createBottomTabNavigator<RootTabParamList>();

export function RootNavigator() {
	const {colors, fonts} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('common');
	// Phase 62 Plan 28 (D-41): a retired device's whole tab navigator is replaced by
	// DeviceRetiredNotice — see that hook's own header for the fail-open/latch contract. Called
	// after the existing hooks so it never changes their order.
	const isDeviceRetired = useDeviceRetired();

	if (isDeviceRetired) {
		return <DeviceRetiredNotice />;
	}

	return (
		<AppStateProviders>
			<Tab.Navigator
				screenOptions={{
					// Active: colors.primary (bold). Inactive: colors.textSecondary — a Phase 38 theme
					// token, deliberately NOT Authority's hardcoded `"gray"` string literal (RESEARCH
					// Pitfall 5 / D-07 token discipline).
					tabBarActiveTintColor: colors.primary,
					tabBarInactiveTintColor: colors.textSecondary,
					tabBarLabelStyle: {fontWeight: fonts.bold.fontWeight},
				}}>
				<Tab.Screen
					name="Vote"
					component={VoteStackNavigator}
					options={{
						// headerShown: false — the per-tab nested stack owns header rendering (D-08),
						// not the Tab.Navigator itself.
						headerShown: false,
						tabBarLabel: t('tabVote'),
						tabBarIcon: ({color, size}) => (
							<FontAwesome6 name="check-to-slot" size={size} color={color} />
						),
					}}
				/>
				{/* Phase 59, D-13: the fifth tab, second in the bar (election-centric, adjacent to
				    Vote) — locked order Vote · Timeline · Registration · Scan · Settings. The
				    installed FontAwesome6 Free glyphmap contains a literal `timeline` glyph,
				    classified `solid`-only exactly like the shipping `check-to-slot` glyph above —
				    the bare form (no iconStyle) already used by every other tab renders it; no
				    `chart-line` fallback is needed. */}
				<Tab.Screen
					name="Timeline"
					component={TimelineStackNavigator}
					options={({route}) => ({
						headerShown: false,
						tabBarLabel: t('tabTimeline'),
						tabBarIcon: ({color, size}) => (
							<FontAwesome6 name="timeline" size={size} color={color} />
						),
						// Hide the tab bar while inside the register form flow reached via Timeline
						// (D-14 duplicates the same routes the Registration tab already hides for).
						tabBarStyle: timelineTabBarStyle(route),
					})}
				/>
				<Tab.Screen
					name="Registration"
					component={RegistrationStackNavigator}
					options={({route}) => ({
						headerShown: false,
						tabBarLabel: t('tabRegistration'),
						tabBarIcon: ({color, size}) => (
							<FontAwesome6 name="user-plus" size={size} color={color} />
						),
						// Hide the tab bar while inside the register form flow (continuous process).
						tabBarStyle: registrationTabBarStyle(route),
					})}
				/>
				<Tab.Screen
					name="Scan"
					component={ScanStackNavigator}
					options={{
						headerShown: false,
						tabBarLabel: t('tabScan'),
						tabBarIcon: ({color, size}) => (
							<FontAwesome6 name="qrcode" size={size} color={color} />
						),
					}}
				/>
				<Tab.Screen
					name="Settings"
					component={SettingsStackNavigator}
					options={{
						headerShown: false,
						tabBarLabel: t('tabSettings'),
						tabBarIcon: ({color, size}) => (
							<FontAwesome6 name="gear" size={size} color={color} />
						),
					}}
				/>
			</Tab.Navigator>
		</AppStateProviders>
	);
}

export default RootNavigator;

const styles = StyleSheet.create({
	headerButton: {
		padding: 8,
		marginHorizontal: 4,
		marginVertical: -2,
		minWidth: 44,
		minHeight: 44,
		alignItems: 'center',
		justifyContent: 'center',
	},
});
