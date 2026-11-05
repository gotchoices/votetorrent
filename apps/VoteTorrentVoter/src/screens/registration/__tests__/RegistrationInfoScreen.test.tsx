/**
 * RegistrationInfoScreen — the RegistrationInfo modal that replaced the PlaceholderModal. The two
 * reads (live registration status, election registration deadline) are stubbed at their module
 * boundaries; the screen's rendering of each outcome is real.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
jest.mock('../../../providers/VoterAppProvider');
jest.mock('../../../engines/registration-status', () => ({
	resolveRegistrationStatus: jest.fn(),
}));
jest.mock('../../../engines/info-read', () => ({
	readRegistrationDeadline: jest.fn(),
}));
jest.mock('../../../engines/attestation-producer', () => ({
	resolveAttestationProducer: () => ({provisionDeviceKey: async () => ({publicKey: 'pk'})}),
}));
import {VoterAppProvider} from '../../../providers/VoterAppProvider';
import {resolveRegistrationStatus} from '../../../engines/registration-status';
import {readRegistrationDeadline} from '../../../engines/info-read';
import RegistrationInfoScreen from '../RegistrationInfoScreen';
import {lightTheme} from '../../../theme/themes';
import '../../../i18n';

const mockStatus = resolveRegistrationStatus as jest.Mock;
const mockDeadline = readRegistrationDeadline as jest.Mock;

async function flush() {
	await renderer.act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

const Stack = createNativeStackNavigator();

function render() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<NavigationContainer theme={lightTheme}>
				<VoterAppProvider>
					<Stack.Navigator screenOptions={{headerShown: false}}>
						<Stack.Screen name="RegistrationInfo" component={RegistrationInfoScreen} />
					</Stack.Navigator>
				</VoterAppProvider>
			</NavigationContainer>,
		);
	});
	return tr;
}

describe('RegistrationInfoScreen', () => {
	beforeEach(() => {
		mockStatus.mockReset();
		mockDeadline.mockReset();
	});

	it('shows the live status sentence, network, election and future deadline', async () => {
		const future = Date.now() + 10 * 86_400_000;
		mockDeadline.mockResolvedValue({electionId: 'e-1', electionTitle: 'City Election', registrationEnds: future});
		mockStatus.mockResolvedValue({kind: 'pending', networkName: 'Utah Network'});
		const tr = render();
		await flush();

		expect(tr.root.findByProps({testID: 'registration-info-status'}).props.children).toBe(
			'Your registration in the Utah Network is awaiting a decision.',
		);
		expect(tr.root.findByProps({testID: 'registration-info-network'}).props.children).toBe('Utah Network');
		expect(tr.root.findByProps({testID: 'registration-info-election'}).props.children).toBe('City Election');
		expect(tr.root.findByProps({testID: 'registration-info-deadline'})).toBeTruthy();
		expect(JSON.stringify(tr.toJSON())).toContain('Registration closes');
		// The status read is scoped to the election the deadline read resolved.
		expect(mockStatus).toHaveBeenCalledWith(expect.objectContaining({electionId: 'e-1'}));
	});

	it('labels a passed deadline as closed', async () => {
		mockDeadline.mockResolvedValue({electionId: 'e-1', electionTitle: 'City Election', registrationEnds: Date.now() - 1000});
		mockStatus.mockResolvedValue({kind: 'registered', networkName: 'Utah Network'});
		const tr = render();
		await flush();

		expect(JSON.stringify(tr.toJSON())).toContain('Registration has closed');
	});

	it('never invents a deadline the timeline does not publish', async () => {
		mockDeadline.mockResolvedValue({electionId: 'e-1', electionTitle: 'City Election'});
		mockStatus.mockResolvedValue({kind: 'notRegistered', networkName: 'Utah Network'});
		const tr = render();
		await flush();

		expect(tr.root.findAllByProps({testID: 'registration-info-deadline'})).toHaveLength(0);
		expect(tr.root.findByProps({testID: 'registration-info-election'})).toBeTruthy();
	});

	it('falls back to the no-election notice and the indeterminate sentence when reads fail', async () => {
		mockDeadline.mockRejectedValue(new Error('no election'));
		mockStatus.mockRejectedValue(new Error('engine down'));
		const tr = render();
		await flush();

		expect(tr.root.findByProps({testID: 'registration-info-no-election'})).toBeTruthy();
		expect(tr.root.findByProps({testID: 'registration-info-status'}).props.children).toBe(
			"We couldn't check your registration status right now.",
		);
		// Status read is not scoped to an election it never resolved.
		expect(mockStatus.mock.calls[0][0]).not.toHaveProperty('electionId');
	});

	it('always explains the four registration steps', async () => {
		mockDeadline.mockRejectedValue(new Error('no election'));
		mockStatus.mockResolvedValue({kind: 'indeterminate'});
		const tr = render();
		await flush();

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain('How registration works');
		expect(json).toContain('The election authority reviews your request.');
	});
});
