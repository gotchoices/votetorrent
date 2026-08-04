/**
 * ReviewSubmitScreen.test.tsx (VOTE-04, TDD RED->GREEN) — mounts a real NavigationContainer + real
 * BallotSelectionProvider around a minimal native-stack harness (the real `BallotScreen` + real
 * `ReviewSubmitScreen`, reached by pressing Ballot's own "Review & Submit" button — mirrors
 * BallotScreen.test.tsx's real-provider harness, driving navigation through real UI rather than
 * pushing routes via a nav ref directly) so `getBallot()`'s real `mockBallot` offices resolve.
 *
 * Covers 42-RESEARCH.md's Pattern 2/7 for VOTE-04: per-office summary (notYetAnswered placeholder
 * / selected candidate name), Submit shows an inline mock confirmation, "Continue Voting" goes
 * back to the Ballot Page.
 *
 * Phase 44-07 (D-02/D-04): `VoterAppProvider` is now a real composition root requiring a
 * `CadreNodeProvider` ancestor, and the mock `hasVoted`/`setHasVoted` context fields this test
 * previously asserted are REMOVED (`ReviewSubmitScreen`'s own local `submitted` flag is now the
 * sole source of truth for its confirmation view — see `ReviewSubmitScreen.tsx`'s file header
 * comment). Uses the manual Jest mock at providers/__mocks__/VoterAppProvider.tsx for
 * `getBallot()`.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {NavigationContainer, createNavigationContainerRef} from '@react-navigation/native';
import type {ParamListBase} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
jest.mock('../../../providers/VoterAppProvider');
import {VoterAppProvider} from '../../../providers/VoterAppProvider';
import {BallotSelectionProvider, useBallotSelection} from '../../../providers/BallotSelectionProvider';
import type {BallotSelectionContextType} from '../../../providers/BallotSelectionProvider';
import {mockBallot} from '../../../providers/mockData';
import BallotScreen from '../BallotScreen';
import ReviewSubmitScreen from '../ReviewSubmitScreen';
import {lightTheme} from '../../../theme/themes';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from

/** Flush VoterAppProvider's isInitialized boot effect + each screen's getBallot().then(setBallot). */
async function flushBoot() {
	await renderer.act(async () => {
		await Promise.resolve();
	});
}

// Trivial stand-ins for routes BallotScreen can navigate to but this test never visits — mirrors
// BallotScreen.test.tsx's DummyScreen approach.
function DummyScreen() {
	return null;
}

const Stack = createNativeStackNavigator();

function renderScreen() {
	const capturedSelection: {value: BallotSelectionContextType | null} = {value: null};
	const navRef = createNavigationContainerRef<ParamListBase>();

	function SelectionProbe() {
		capturedSelection.value = useBallotSelection();
		return null;
	}

	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<NavigationContainer ref={navRef} theme={lightTheme}>
				<VoterAppProvider>
					<BallotSelectionProvider>
						<SelectionProbe />
						<Stack.Navigator initialRouteName="Ballot" screenOptions={{headerShown: false}}>
							<Stack.Screen name="Ballot" component={BallotScreen} />
							<Stack.Screen name="IndividualQuestion" component={DummyScreen} />
							<Stack.Screen name="OfficeInfo" component={DummyScreen} />
							<Stack.Screen name="ElectionInfo" component={DummyScreen} />
							<Stack.Screen name="ReviewSubmit" component={ReviewSubmitScreen} />
						</Stack.Navigator>
					</BallotSelectionProvider>
				</VoterAppProvider>
			</NavigationContainer>,
		);
	});
	return {tr, capturedSelection, navRef};
}

function openReviewSubmit(tr: renderer.ReactTestRenderer) {
	const reviewButton = tr.root.findByProps({testID: 'ballot-review-submit'});
	renderer.act(() => {
		reviewButton.props.onPress();
	});
}

describe('ReviewSubmitScreen (VOTE-04)', () => {
	it('summarizes each office (notYetAnswered placeholder, selected candidate name once answered)', async () => {
		const {tr, capturedSelection} = renderScreen();
		await flushBoot();

		openReviewSubmit(tr);
		await flushBoot();

		const beforeText = JSON.stringify(tr.toJSON());
		expect(beforeText).toContain('Not yet answered');

		const firstOffice = mockBallot.offices[0];
		const firstCandidate = firstOffice.candidates[0];
		renderer.act(() => {
			capturedSelection.value!.toggleCandidate(firstOffice.id, firstCandidate.id, firstOffice.voteFor);
		});
		await flushBoot();

		const afterText = JSON.stringify(tr.toJSON());
		expect(afterText).toContain('Diana Foster');
	});

	it('"Continue Voting" navigates back to the Ballot Page', async () => {
		const {tr, navRef} = renderScreen();
		await flushBoot();

		openReviewSubmit(tr);
		await flushBoot();
		expect(navRef.getCurrentRoute()?.name).toBe('ReviewSubmit');

		const continueButton = tr.root.findByProps({testID: 'review-continue'});
		renderer.act(() => {
			continueButton.props.onPress();
		});

		expect(navRef.getCurrentRoute()?.name).toBe('Ballot');
	});

	it('"Submit" shows the inline mock confirmation (local submitted state, D-02)', async () => {
		const {tr} = renderScreen();
		await flushBoot();

		openReviewSubmit(tr);
		await flushBoot();
		expect(tr.root.findAllByProps({testID: 'review-confirmation'})).toHaveLength(0);

		const submitButton = tr.root.findByProps({testID: 'review-submit'});
		renderer.act(() => {
			submitButton.props.onPress();
		});

		expect(tr.root.findByProps({testID: 'review-confirmation'})).toBeTruthy();
		expect(JSON.stringify(tr.toJSON())).toContain('Your ballot was submitted');
	});
});
