/**
 * ballot-flow.test.tsx (VOTE-01/02/03, Plan 42-07) — the Voting app's first multi-screen
 * ballot navigation-flow test. Mounts a real `NavigationContainer` + real `VoterAppProvider` +
 * real `BallotSelectionProvider` around a minimal native-stack harness wiring the real
 * `BallotScreen`, `IndividualQuestionScreen`, `ReviewSubmitScreen` plus `DummyScreen` stand-ins
 * for `Home`/`ElectionInfo`/`OfficeInfo`/`CandidateInfo` — mirrors
 * `registration-flow.test.tsx`'s real-provider harness + `tr.root.findByProps({testID})`
 * interaction style (no `@testing-library/react-native`), and captures `useBallotSelection()`
 * via a Probe (mirrors `BallotSelectionProvider.test.tsx`/`IndividualQuestionScreen.test.tsx`'s
 * Probe-capture convention), so navigation actually pushes/pops between real screens sharing one
 * `BallotSelectionProvider` instance — proving:
 *
 * 1. VOTE-02: tapping a candidate row on `IndividualQuestion` writes `selectionMap`,
 *    `question-next` advances `currentQuestionIndex`, and `question-previous` returns to the
 *    prior index with the earlier selection still present (persistence across Next/Previous).
 * 2. VOTE-02/D-06: `goToPreviousQuestion()` at index 0 leaves `currentQuestionIndex` at 0 (no
 *    wrap-around clamp).
 * 3. VOTE-01/D-07: pressing `ballot-save-exit` returns to `Home` and `selectionMap` still holds
 *    the selection made before Save & Exit (retained across the round trip — this is the
 *    integration-level proof that D-07's "re-entering the ballot resumes" claim actually holds,
 *    now that `VoteStackNavigator` is wrapped in `BallotSelectionProvider`, Plan 07 Task 1).
 * 4. VOTE-03: the office row's "Learn about this office" link navigates to `OfficeInfo`, and
 *    `IndividualQuestion`'s "Learn about this candidate" link navigates to `CandidateInfo`
 *    (info-modal reachability).
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {NavigationContainer, createNavigationContainerRef} from '@react-navigation/native';
import type {ParamListBase} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
// Phase 44-07 (D-02/D-04): VoterAppProvider is now a real composition root requiring a
// CadreNodeProvider ancestor — this ballot-flow test has no need to exercise that boot, so it
// uses the manual Jest mock at providers/__mocks__/VoterAppProvider.tsx.
jest.mock('../../../providers/VoterAppProvider');
import {VoterAppProvider, useVoterApp} from '../../../providers/VoterAppProvider';
import {BallotSelectionProvider, useBallotSelection} from '../../../providers/BallotSelectionProvider';
import type {BallotSelectionContextType} from '../../../providers/BallotSelectionProvider';
import type {VoterAppContextType} from '../../../providers/types';
import {mockBallot} from '../../../providers/mockData';
import BallotScreen from '../BallotScreen';
import IndividualQuestionScreen from '../IndividualQuestionScreen';
import ReviewSubmitScreen from '../ReviewSubmitScreen';
import {lightTheme} from '../../../theme/themes';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from

/** Flush VoterAppProvider's isInitialized boot effect + each screen's getBallot().then(setBallot). */
async function flushBoot() {
	await renderer.act(async () => {
		await Promise.resolve();
	});
}

// Trivial stand-ins for routes this harness needs registered but whose real content this test
// asserts via navRef.getCurrentRoute() rather than rendering (mirrors registration-flow.test.tsx
// / BallotScreen.test.tsx's DummyScreen approach). `Home` stands in for the Vote stack's actual
// root — Save & Exit's popToTop() target — since HomeScreen itself is out of scope here.
function DummyScreen() {
	return null;
}

const Stack = createNativeStackNavigator();

function renderFlow(initialRouteName: 'Home' | 'Ballot' | 'IndividualQuestion') {
	const capturedApp: {value: VoterAppContextType | null} = {value: null};
	const capturedSelection: {value: BallotSelectionContextType | null} = {value: null};
	const navRef = createNavigationContainerRef<ParamListBase>();

	function AppProbe() {
		capturedApp.value = useVoterApp();
		return null;
	}
	function SelectionProbe() {
		capturedSelection.value = useBallotSelection();
		return null;
	}

	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<NavigationContainer ref={navRef} theme={lightTheme}>
				<VoterAppProvider>
					<AppProbe />
					<BallotSelectionProvider>
						<SelectionProbe />
						<Stack.Navigator initialRouteName={initialRouteName} screenOptions={{headerShown: false}}>
							<Stack.Screen name="Home" component={DummyScreen} />
							<Stack.Screen name="Ballot" component={BallotScreen} />
							<Stack.Screen name="IndividualQuestion" component={IndividualQuestionScreen} />
							<Stack.Screen name="ReviewSubmit" component={ReviewSubmitScreen} />
							<Stack.Screen name="ElectionInfo" component={DummyScreen} />
							<Stack.Screen name="OfficeInfo" component={DummyScreen} />
							<Stack.Screen name="CandidateInfo" component={DummyScreen} />
						</Stack.Navigator>
					</BallotSelectionProvider>
				</VoterAppProvider>
			</NavigationContainer>,
		);
	});
	return {tr, capturedApp, capturedSelection, navRef};
}

describe('ballot navigation flow (VOTE-01/02/03)', () => {
	it('Next advances currentQuestionIndex and Previous returns with the earlier selection intact (VOTE-02)', async () => {
		const {tr, capturedSelection} = renderFlow('IndividualQuestion');
		await flushBoot();

		const firstOffice = mockBallot.offices[0];
		const firstCandidateId = firstOffice.candidates[0].id;

		const candidateRow = tr.root.findByProps({testID: `candidate-row-${firstCandidateId}`});
		renderer.act(() => {
			candidateRow.props.onPress();
		});
		expect(capturedSelection.value!.selectionMap[firstOffice.id]).toEqual([firstCandidateId]);

		const nextButton = tr.root.findByProps({testID: 'question-next'});
		renderer.act(() => {
			nextButton.props.onPress();
		});
		expect(capturedSelection.value!.currentQuestionIndex).toBe(1);

		// Previous returns to the prior index — the earlier selection must still read back intact
		// from the SAME BallotSelectionProvider instance (VOTE-02 persistence guarantee).
		const previousButton = tr.root.findByProps({testID: 'question-previous'});
		renderer.act(() => {
			previousButton.props.onPress();
		});
		expect(capturedSelection.value!.currentQuestionIndex).toBe(0);
		expect(capturedSelection.value!.selectionMap[firstOffice.id]).toEqual([firstCandidateId]);
	});

	it('Previous is clamped at index 0 — no wrap-around (VOTE-02/D-06)', async () => {
		const {capturedSelection} = renderFlow('IndividualQuestion');
		await flushBoot();

		expect(capturedSelection.value!.currentQuestionIndex).toBe(0);
		renderer.act(() => {
			capturedSelection.value!.goToPreviousQuestion();
		});
		expect(capturedSelection.value!.currentQuestionIndex).toBe(0);
	});

	it('Save & Exit returns to Home and retains selectionMap (VOTE-01/D-07)', async () => {
		const {tr, capturedSelection, navRef} = renderFlow('Home');
		await flushBoot();

		renderer.act(() => {
			navRef.navigate('Ballot');
		});
		await flushBoot();

		const firstOffice = mockBallot.offices[0];
		const firstCandidateId = firstOffice.candidates[0].id;
		renderer.act(() => {
			capturedSelection.value!.toggleCandidate(firstOffice.id, firstCandidateId, firstOffice.voteFor);
		});

		const saveExitButton = tr.root.findByProps({testID: 'ballot-save-exit'});
		renderer.act(() => {
			saveExitButton.props.onPress();
		});

		expect(navRef.getCurrentRoute()?.name).toBe('Home');
		// Save & Exit does NOT clear selections (D-07) — the same provider instance retains them
		// across the round trip, so re-entering the ballot would resume where the voter left off.
		expect(capturedSelection.value!.selectionMap[firstOffice.id]).toEqual([firstCandidateId]);
	});

	it('office row "Learn about this office" opens the Office Info dialog (VOTE-03)', async () => {
		const {tr} = renderFlow('Ballot');
		await flushBoot();

		expect(tr.root.findAllByProps({testID: 'info-dialog'})).toHaveLength(0);

		const learnLink = tr.root.findAllByProps({testID: 'office-row-learn'})[0];
		renderer.act(() => {
			learnLink.props.onPress();
		});

		expect(tr.root.findByProps({testID: 'info-dialog'})).toBeTruthy();
		expect(JSON.stringify(tr.toJSON())).toContain('Office Info');
	});

	it('"Learn about this candidate" (in-card) opens the Candidate Info dialog (VOTE-03)', async () => {
		const {tr} = renderFlow('IndividualQuestion');
		await flushBoot();

		const firstCandidateId = mockBallot.offices[0].candidates[0].id;
		expect(tr.root.findAllByProps({testID: 'info-dialog'})).toHaveLength(0);

		const learnLink = tr.root.findByProps({testID: `candidate-learn-${firstCandidateId}`});
		renderer.act(() => {
			learnLink.props.onPress();
		});

		expect(tr.root.findByProps({testID: 'info-dialog'})).toBeTruthy();
		expect(JSON.stringify(tr.toJSON())).toContain('Candidate Info');
	});
});
