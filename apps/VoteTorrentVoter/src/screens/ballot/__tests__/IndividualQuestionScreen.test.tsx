/**
 * IndividualQuestionScreen.test.tsx (VOTE-02, TDD RED->GREEN) — mounts a real NavigationContainer
 * + real VoterAppProvider + real BallotSelectionProvider around a minimal native-stack harness
 * (the real IndividualQuestionScreen plus DummyScreen stand-ins for CandidateInfo/ReviewSubmit) so
 * getBallot()'s real mockBallot offices resolve and navigation calls land on registered routes —
 * mirrors BallotScreen.test.tsx's real-provider harness. A Probe captures
 * BallotSelectionProvider's context (mirrors BallotSelectionProvider.test.tsx's Probe-capture
 * convention) so the test can jump `currentQuestionIndex` directly instead of walking Next N
 * times to reach a voteFor>1 office.
 *
 * Covers 42-RESEARCH.md's Pattern 5/6/7 for VOTE-02: dynamic "Vote for N" header, provider-bound
 * CandidateSelector writes, clamped Prev/Next, last-question Next -> replace('ReviewSubmit'),
 * and the "Learn about this candidate" link (VOTE-03).
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
import {VoterAppProvider} from '../../../providers/VoterAppProvider';
import {BallotSelectionProvider, useBallotSelection} from '../../../providers/BallotSelectionProvider';
import type {BallotSelectionContextType} from '../../../providers/BallotSelectionProvider';
import {mockBallot} from '../../../providers/mockData';
import IndividualQuestionScreen from '../IndividualQuestionScreen';
import {lightTheme} from '../../../theme/themes';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from

/** Flush VoterAppProvider's isInitialized boot effect + the screen's getBallot().then(setBallot). */
async function flushBoot() {
	await renderer.act(async () => {
		await Promise.resolve();
	});
}

// Trivial stand-ins for routes this screen can navigate to but this test asserts via
// navRef.getCurrentRoute() rather than rendering real content — mirrors
// registration-flow.test.tsx's DummyScreen approach.
function DummyScreen() {
	return null;
}

const Stack = createNativeStackNavigator();

function renderScreen() {
	const captured: {value: BallotSelectionContextType | null} = {value: null};
	const navRef = createNavigationContainerRef<ParamListBase>();

	function Probe() {
		captured.value = useBallotSelection();
		return null;
	}

	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<NavigationContainer ref={navRef} theme={lightTheme}>
				<VoterAppProvider>
					<BallotSelectionProvider>
						<Probe />
						<Stack.Navigator initialRouteName="IndividualQuestion" screenOptions={{headerShown: false}}>
							<Stack.Screen name="IndividualQuestion" component={IndividualQuestionScreen} />
							<Stack.Screen name="CandidateInfo" component={DummyScreen} />
							<Stack.Screen name="ReviewSubmit" component={DummyScreen} />
						</Stack.Navigator>
					</BallotSelectionProvider>
				</VoterAppProvider>
			</NavigationContainer>,
		);
	});
	return {tr, captured, navRef};
}

describe('IndividualQuestionScreen (VOTE-02)', () => {
	it('shows "Vote for N" for the office at currentQuestionIndex, and updates when the index changes', async () => {
		const {tr, captured} = renderScreen();
		await flushBoot();

		const firstOffice = mockBallot.offices[0];
		expect(JSON.stringify(tr.toJSON())).toContain(`Vote for ${firstOffice.voteFor}`);

		const boardIndex = mockBallot.offices.findIndex(o => o.id === 'office-state-board-education');
		renderer.act(() => {
			captured.value!.setCurrentQuestionIndex(boardIndex);
		});
		await flushBoot();

		const boardOffice = mockBallot.offices[boardIndex];
		expect(JSON.stringify(tr.toJSON())).toContain(`Vote for ${boardOffice.voteFor}`);
	});

	it('pressing a candidate row writes selectionMap via toggleCandidate', async () => {
		const {tr, captured} = renderScreen();
		await flushBoot();

		const firstOffice = mockBallot.offices[0];
		const firstCandidateId = firstOffice.candidates[0].id;
		const row = tr.root.findByProps({testID: `candidate-row-${firstCandidateId}`});
		renderer.act(() => {
			row.props.onPress();
		});

		expect(captured.value!.selectionMap[firstOffice.id]).toEqual([firstCandidateId]);
	});

	it('Previous is absent at index 0 (D-06, no wrap)', async () => {
		const {tr} = renderScreen();
		await flushBoot();

		expect(tr.root.findAllByProps({testID: 'question-previous'})).toHaveLength(0);
	});

	it('Next advances currentQuestionIndex', async () => {
		const {tr, captured} = renderScreen();
		await flushBoot();

		expect(captured.value!.currentQuestionIndex).toBe(0);
		const nextButton = tr.root.findByProps({testID: 'question-next'});
		renderer.act(() => {
			nextButton.props.onPress();
		});

		expect(captured.value!.currentQuestionIndex).toBe(1);
	});

	it('Previous appears after advancing past index 0 and returns to the prior index', async () => {
		const {tr, captured} = renderScreen();
		await flushBoot();

		renderer.act(() => {
			captured.value!.setCurrentQuestionIndex(1);
		});
		await flushBoot();

		const previousButton = tr.root.findByProps({testID: 'question-previous'});
		renderer.act(() => {
			previousButton.props.onPress();
		});

		expect(captured.value!.currentQuestionIndex).toBe(0);
	});

	it('on the last question, Next replaces the route with ReviewSubmit', async () => {
		const {tr, captured, navRef} = renderScreen();
		await flushBoot();

		const lastIndex = mockBallot.offices.length - 1;
		renderer.act(() => {
			captured.value!.setCurrentQuestionIndex(lastIndex);
		});
		await flushBoot();

		const nextButton = tr.root.findByProps({testID: 'question-next'});
		renderer.act(() => {
			nextButton.props.onPress();
		});

		expect(navRef.getCurrentRoute()?.name).toBe('ReviewSubmit');
	});

	it('"Learn about this candidate" (in-card) opens the Candidate Info dialog', async () => {
		const {tr} = renderScreen();
		await flushBoot();

		const firstCandidateId = mockBallot.offices[0].candidates[0].id;
		// Dialog is closed until the in-card link is tapped.
		expect(tr.root.findAllByProps({testID: 'info-dialog'})).toHaveLength(0);

		const learnLink = tr.root.findByProps({testID: `candidate-learn-${firstCandidateId}`});
		renderer.act(() => {
			learnLink.props.onPress();
		});

		expect(tr.root.findByProps({testID: 'info-dialog'})).toBeTruthy();
		expect(JSON.stringify(tr.toJSON())).toContain('Candidate Info');
	});
});
