/**
 * registration-flow.test.tsx (REG-03/REG-05) — the repo's first multi-screen navigation-flow
 * test. Mounts a real `NavigationContainer` + real `VotingAppProvider` + real
 * `RegistrationDraftProvider` around a minimal native-stack harness (`RegistrationHome` +
 * `RegisterPersonal` + `RegisterAddressParty`, the real screen components) so navigation actually
 * pushes/pops between real screens sharing one draft instance — proving:
 *
 * 1. REG-03: typing into Step 1, Continue to Step 2, then Back to Step 1 shows the same typed
 *    value (draft preservation across Back/Continue).
 * 2. REG-05: from the registered card, "Update registration" navigates straight to
 *    `RegisterPersonal` (skipping `DeviceAttestation`, D-04) with the existing draft still
 *    populated — no separate pre-fill logic, same never-cleared draft instance.
 *
 * Follows 41-RESEARCH.md's "Testing the write-through + Back/Continue draft preservation" Code
 * Example (renderer.act + `tr.root.findByProps({testID}).props.onChangeText/onPress`) and
 * `__tests__/voting-app-provider.test.ts`'s Probe-component context-capture + `flushBoot`
 * convention — no `@testing-library/react-native` dependency (not installed).
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {NavigationContainer, createNavigationContainerRef} from '@react-navigation/native';
import type {ParamListBase} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {VotingAppProvider, useVotingApp} from '../../../providers/VotingAppProvider';
import {
	RegistrationDraftProvider,
	useRegistrationDraft,
} from '../../../providers/RegistrationDraftProvider';
import type {VotingAppContextType} from '../../../providers/types';
import type {RegistrationDraftContextType} from '../../../providers/RegistrationDraftProvider';
import RegistrationScreen from '../RegistrationScreen';
import RegisterPersonalScreen from '../RegisterPersonalScreen';
import RegisterAddressPartyScreen from '../RegisterAddressPartyScreen';
import {lightTheme} from '../../../theme/themes';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from

/** Flush VotingAppProvider's isInitialized boot effect (setIsInitialized(true) in useEffect). */
async function flushBoot() {
	await renderer.act(async () => {
		await Promise.resolve();
	});
}

// Dummy stand-ins for routes RegistrationScreen can navigate to but which neither REG-03 nor
// REG-05 actually visits in this harness (DeviceAttestation/RegistrationInfo) — kept as trivial
// no-op components purely so `navigation.navigate('DeviceAttestation' | 'RegistrationInfo')`
// resolves to a registered route without pulling in the real timed-interstitial/modal screens.
function DummyScreen() {
	return null;
}

const Stack = createNativeStackNavigator();

function renderFlow(initialRouteName: 'RegistrationHome' | 'RegisterPersonal') {
	const capturedApp: {value: VotingAppContextType | null} = {value: null};
	const capturedDraft: {value: RegistrationDraftContextType | null} = {value: null};
	const navRef = createNavigationContainerRef<ParamListBase>();

	function AppProbe() {
		capturedApp.value = useVotingApp();
		return null;
	}
	function DraftProbe() {
		capturedDraft.value = useRegistrationDraft();
		return null;
	}

	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<NavigationContainer ref={navRef} theme={lightTheme}>
				<VotingAppProvider>
					<AppProbe />
					<RegistrationDraftProvider>
						<DraftProbe />
						<Stack.Navigator
							initialRouteName={initialRouteName}
							screenOptions={{headerShown: false}}>
							<Stack.Screen name="RegistrationHome" component={RegistrationScreen} />
							<Stack.Screen name="DeviceAttestation" component={DummyScreen} />
							<Stack.Screen name="RegisterPersonal" component={RegisterPersonalScreen} />
							<Stack.Screen name="RegisterAddressParty" component={RegisterAddressPartyScreen} />
							<Stack.Screen name="RegistrationInfo" component={DummyScreen} />
						</Stack.Navigator>
					</RegistrationDraftProvider>
				</VotingAppProvider>
			</NavigationContainer>,
		);
	});
	return {tr, capturedApp, capturedDraft, navRef};
}

describe('registration navigation flow (REG-03/REG-05)', () => {
	it('preserves Step 1 input across Continue then Back (REG-03 core guarantee)', async () => {
		const {tr} = renderFlow('RegisterPersonal');
		await flushBoot();

		const firstNameInput = tr.root.findByProps({testID: 'register-first-name'});
		renderer.act(() => {
			firstNameInput.props.onChangeText('Jane');
		});

		const continueBtn = tr.root.findByProps({testID: 'register-continue'});
		renderer.act(() => {
			continueBtn.props.onPress();
		});
		// now on Step 2 (RegisterAddressParty) — press Back
		const backBtn = tr.root.findByProps({testID: 'register-back'});
		renderer.act(() => {
			backBtn.props.onPress();
		});

		// Step 1 re-rendered from the SAME draft instance — value must still read 'Jane'.
		const firstNameAgain = tr.root.findByProps({testID: 'register-first-name'});
		expect(firstNameAgain.props.value).toBe('Jane');
	});

	it('Update registration re-entry navigates to RegisterPersonal (skipping DeviceAttestation) with the draft still populated (REG-05, D-04)', async () => {
		const {tr, capturedApp, capturedDraft, navRef} = renderFlow('RegistrationHome');
		await flushBoot();

		// Populate the draft and flip isRegistered directly on the shared context instances
		// (mirrors having previously completed the form + confirmed) — D-04: no separate
		// pre-fill logic exists, so this is the only setup this test needs.
		renderer.act(() => {
			capturedDraft.value!.updateField('firstName', 'Existing');
			capturedDraft.value!.updateField('lastName', 'Voter');
			capturedApp.value!.setIsRegistered(true);
		});

		const updateBtn = tr.root.findByProps({testID: 'registration-card-update'});
		renderer.act(() => {
			updateBtn.props.onPress();
		});

		// Active route is RegisterPersonal, NOT DeviceAttestation (D-04).
		expect(navRef.getCurrentRoute()?.name).toBe('RegisterPersonal');

		// The draft is still populated in Step 1's fields — no pre-fill logic needed, same
		// never-cleared draft instance (RegistrationDraftProvider D-06).
		const firstNameField = tr.root.findByProps({testID: 'register-first-name'});
		expect(firstNameField.props.value).toBe('Existing');
		const lastNameField = tr.root.findByProps({testID: 'register-last-name'});
		expect(lastNameField.props.value).toBe('Voter');
	});
});
