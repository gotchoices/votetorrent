/**
 * SendVoteCard (spike 102): the receipt's "Send your vote" card shows each ballot's pooling status
 * as the send flow reports it, says when everything is sent, maps every refusal to plain copy, and
 * never shows raw error text.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {Platform} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {NavigationContainer} from '@react-navigation/native';
jest.mock('../../../providers/VoterAppProvider');
jest.mock('@votetorrent/attestation-native', () => ({}));
jest.mock('../../../engines/vote-send-flow', () => ({runVoteSendFlow: jest.fn()}));
import {VoterAppProvider} from '../../../providers/VoterAppProvider';
import {runVoteSendFlow} from '../../../engines/vote-send-flow';
import {recordVoteSent} from '../../../engines/vote-sent-store';
import SendVoteCard from '../SendVoteCard';
import {lightTheme} from '../../../theme/themes';
import i18n from '../../../i18n';

let tr: renderer.ReactTestRenderer | null = null;
const onAllSent = jest.fn();

async function flush() {
	for (let i = 0; i < 6; i++) {
		await renderer.act(async () => { await new Promise<void>(r => setTimeout(r, 0)); });
	}
}
async function mount(ballotIds = ['b1', 'b2']) {
	await renderer.act(async () => {
		tr = renderer.create(
			<NavigationContainer theme={lightTheme}>
				<VoterAppProvider>
					<SendVoteCard electionId="e1" electionRevision={1} envelope={{} as never} ballotIds={ballotIds} onAllSentChange={onAllSent} />
				</VoterAppProvider>
			</NavigationContainer>,
		);
	});
	await flush();
}
const hosts = (id: string) => tr!.root.findAll(n => typeof n.type === 'string' && n.props.testID === id);
const textOf = (n: renderer.ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(c => textOf(c as renderer.ReactTestInstance)).join(''));
const text = (id: string) => textOf(hosts(id)[0]!);
async function press(id: string) {
	const node = tr!.root.findAllByProps({testID: id}).find(n => typeof n.props.onPress === 'function');
	await renderer.act(async () => { node!.props.onPress(); });
	await flush();
}

beforeEach(async () => {
	await AsyncStorage.clear();
	await i18n.changeLanguage('en');
	jest.clearAllMocks();
});
const realOS = Platform.OS;
const setOS = (os: 'ios' | 'android') => Object.defineProperty(Platform, 'OS', {value: os, configurable: true});
afterEach(() => { renderer.act(() => tr?.unmount()); tr = null; setOS(realOS as 'ios'); });
const allText = () => JSON.stringify(tr!.toJSON());

describe('SendVoteCard', () => {
	it('shows each ballot\'s status as the flow reports it, then "sent"', async () => {
		(runVoteSendFlow as jest.Mock).mockImplementation(async (deps: {onStatus: (b: string, s: unknown) => void}) => {
			deps.onStatus('b1', {phase: 'waiting', size: 2});
			deps.onStatus('b2', {phase: 'confirming'});
			return {kind: 'done', ballots: [{ballotId: 'b1', status: {phase: 'sent', cid: 'c1'}}, {ballotId: 'b2', status: {phase: 'sent', cid: 'c2'}}]};
		});
		await mount();
		expect(hosts('send-all-sent')).toHaveLength(0);
		await press('send-vote');
		expect(text('send-all-sent')).toBe('Your vote has been sent to the election.');
		expect(text('send-ballot-0')).toBe('Ballot 1: Sent to the election.');
		expect(hosts('send-vote')).toHaveLength(0);
		expect(onAllSent).toHaveBeenLastCalledWith(true);
	});

	it('a ballot whose pool never filled says so and offers a retry', async () => {
		(runVoteSendFlow as jest.Mock).mockResolvedValue({kind: 'done', ballots: [{ballotId: 'b1', status: {phase: 'not-sent', reason: 'voting-closed'}}]});
		await mount(['b1']);
		await press('send-vote');
		expect(text('send-ballot-0')).toContain('Not sent: voting closed before enough voters were ready');
		expect(textOf(tr!.root.findAllByProps({testID: 'send-vote'}).find(n => typeof n.type === 'string')!)).toBe('Try again');
		expect(onAllSent).toHaveBeenLastCalledWith(false);
	});

	it('maps refusals to plain copy, never raw text', async () => {
		for (const [kind, copy] of [
			['no-network', "This phone isn't connected to an election network yet"],
			['canceled', 'Sending was cancelled'],
			['failed', "We couldn't send your vote"],
			['rendezvous-unreachable', "We couldn't send your vote"],
		] as const) {
			(runVoteSendFlow as jest.Mock).mockResolvedValueOnce({kind});
			await mount(['b1']);
			await press('send-vote');
			expect(text('send-outcome')).toContain(copy);
			renderer.act(() => tr?.unmount());
		}
		(runVoteSendFlow as jest.Mock).mockRejectedValueOnce(new Error('StreamStateError: raw internals'));
		await mount(['b1']);
		await press('send-vote');
		expect(text('send-outcome')).not.toContain('StreamStateError');
	});

	it('already-sent ballots read as sent on open, without pressing anything', async () => {
		await recordVoteSent('e1', 1, 'b1', 'cid-1');
		await mount(['b1']);
		expect(text('send-all-sent')).toBe('Your vote has been sent to the election.');
		expect(runVoteSendFlow).not.toHaveBeenCalled();
	});

	describe.each([
		['ios', 'ios', "You'll be asked for Face ID to open your saved vote", 'Confirm with Face ID to send.', "Face ID can't be checked right now", 'Use Face ID to send your saved vote'],
		['android', 'android', "You'll be asked for your fingerprint to open your saved vote", 'Confirm with your fingerprint to send.', "Your fingerprint can't be checked right now", 'Use your fingerprint to send your saved vote'],
	] as const)('biometric copy on %s', (_n, os, hint, confirming, unavailable, recordSubtitle) => {
		beforeEach(() => { setOS(os); });

		it('the hint names the platform biometric', async () => {
			await mount(['b1']);
			expect(allText()).toContain(hint);
		});

		it('the confirming line follows the platform', async () => {
			(runVoteSendFlow as jest.Mock).mockImplementation(async (deps: {onStatus: (b: string, s: unknown) => void}) => {
				deps.onStatus('b1', {phase: 'confirming'});
				return {kind: 'canceled'};
			});
			await mount(['b1']);
			await press('send-vote');
			expect(text('send-ballot-0')).toBe(confirming);
		});

		it('the biometric-unavailable outcome follows the platform', async () => {
			(runVoteSendFlow as jest.Mock).mockResolvedValueOnce({kind: 'biometric-unavailable'});
			await mount(['b1']);
			await press('send-vote');
			expect(text('send-outcome')).toContain(unavailable);
		});

		it('the record prompt subtitle follows the platform, the consent prompt is unchanged', async () => {
			(runVoteSendFlow as jest.Mock).mockResolvedValueOnce({kind: 'canceled'});
			await mount(['b1']);
			await press('send-vote');
			const deps = (runVoteSendFlow as jest.Mock).mock.calls[0][0] as {recordPrompt: {subtitle: string}, consentPrompt: {subtitle: string}};
			expect(deps.recordPrompt.subtitle).toBe(recordSubtitle);
			expect(deps.consentPrompt.subtitle).toBe(i18n.t('send.consentPrompt.subtitle', {ns: 'ballot'}));
		});
	});
});
