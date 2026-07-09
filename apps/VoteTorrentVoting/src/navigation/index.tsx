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
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {useTranslation} from 'react-i18next';
import {ExtendedTheme, useTheme} from '@react-navigation/native';
import {Pressable, StyleSheet} from 'react-native';
import type {
	RegistrationStackParamList,
	RootTabParamList,
	ScanStackParamList,
	SettingsStackParamList,
	VoteStackParamList,
} from './types';
import HomeScreen from '../screens/home/HomeScreen';
import ValidationDetailsScreen from '../screens/home/ValidationDetailsScreen';
import BallotScreen from '../screens/ballot/BallotScreen';
import RegistrationScreen from '../screens/registration/RegistrationScreen';
import ScanScreen from '../screens/scan/ScanScreen';
import SettingsScreen from '../screens/settings/SettingsScreen';
import PlaceholderModal from '../components/PlaceholderModal';

// CloseButton (D-16) — byte-identical mechanics to Authority's `navigation/index.tsx` CloseButton
// (lines 249-256): a Pressable with hitSlop=8 wrapping a FontAwesome6 "xmark" glyph, calling the
// caller-supplied onPress (always `navigation.goBack()` at each modal's options callsite below).
function CloseButton({onPress}: {onPress: () => void}) {
	const {colors} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('common');
	return (
		<Pressable
			onPress={onPress}
			style={styles.headerButton}
			hitSlop={8}
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
			<VoteStack.Screen
				name="Home"
				component={HomeScreen}
				options={{title: tHome('headerTitle')}}
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
				component={PlaceholderModal}
				options={({navigation}) => ({
					title: tBallot('individualQuestionTitle'),
					presentation: 'modal',
					headerBackVisible: false,
					headerLeft: () => <CloseButton onPress={() => navigation.goBack()} />,
				})}
			/>
			<VoteStack.Screen
				name="ElectionInfo"
				component={PlaceholderModal}
				options={({navigation}) => ({
					title: tHome('electionInfoTitle'),
					presentation: 'modal',
					headerBackVisible: false,
					headerLeft: () => <CloseButton onPress={() => navigation.goBack()} />,
				})}
			/>
			<VoteStack.Screen
				name="OfficeInfo"
				component={PlaceholderModal}
				options={({navigation}) => ({
					title: tBallot('officeInfoTitle'),
					presentation: 'modal',
					headerBackVisible: false,
					headerLeft: () => <CloseButton onPress={() => navigation.goBack()} />,
				})}
			/>
			<VoteStack.Screen
				name="CandidateInfo"
				component={PlaceholderModal}
				options={({navigation}) => ({
					title: tBallot('candidateInfoTitle'),
					presentation: 'modal',
					headerBackVisible: false,
					headerLeft: () => <CloseButton onPress={() => navigation.goBack()} />,
				})}
			/>
		</VoteStack.Navigator>
	);
}

// --- Registration stack (D-09): root + 2 modal routes ---
const RegistrationStack = createNativeStackNavigator<RegistrationStackParamList>();

function RegistrationStackNavigator() {
	const {t} = useTranslation('registration');

	return (
		<RegistrationStack.Navigator>
			<RegistrationStack.Screen
				name="RegistrationHome"
				component={RegistrationScreen}
				options={{title: t('headerTitle')}}
			/>
			<RegistrationStack.Screen
				name="DeviceAttestation"
				component={PlaceholderModal}
				options={({navigation}) => ({
					title: t('deviceAttestationTitle'),
					presentation: 'modal',
					headerBackVisible: false,
					headerLeft: () => <CloseButton onPress={() => navigation.goBack()} />,
				})}
			/>
			<RegistrationStack.Screen
				name="Confirmation"
				component={PlaceholderModal}
				options={({navigation}) => ({
					title: t('confirmationTitle'),
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

	return (
		<SettingsStack.Navigator>
			<SettingsStack.Screen
				name="SettingsHome"
				component={SettingsScreen}
				options={{title: t('headerTitle')}}
			/>
		</SettingsStack.Navigator>
	);
}

// --- RootNavigator: the bottom Tab.Navigator itself (D-08), 4 tabs in D-09 locked order ---
const Tab = createBottomTabNavigator<RootTabParamList>();

export function RootNavigator() {
	const {colors, fonts} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('common');

	return (
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
			<Tab.Screen
				name="Registration"
				component={RegistrationStackNavigator}
				options={{
					headerShown: false,
					tabBarLabel: t('tabRegistration'),
					tabBarIcon: ({color, size}) => (
						<FontAwesome6 name="user-plus" size={size} color={color} />
					),
				}}
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
	);
}

export default RootNavigator;

const styles = StyleSheet.create({
	headerButton: {
		padding: 8,
		marginHorizontal: 4,
		marginVertical: -2,
	},
});
