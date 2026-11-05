/**
 * JoinNetworkScreen (spike 100, Phase 64 plan 64-18): paste or scan a join code, check the network's
 * fingerprint, join.
 *
 * The provider is mocked (its `joinNetwork` is the seam). Every code is a REAL-encoder fixture from
 * 64-04 (1370+ chars, random keys, fake addresses), never a short canary (UI-SPEC test 1), and code
 * text is compared with boolean assertions only: a failing matcher prints both operands.
 *
 * VisionCamera is the 64-01 manual mock; its `__` controls are reached by require() of the mock FILE.
 * `__setCameraPermissionStatus` only seeds a new mount, so each test sets it before render().
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {isDeepStrictEqual} from 'util';
import {AccessibilityInfo, Keyboard, Linking, Platform, ScrollView, StyleSheet, Text} from 'react-native';
import {ThemeProvider} from '@react-navigation/native';
import i18n from 'i18next';
import '../../../i18n';
import {decodeNetworkJoinCode} from '@votetorrent/vote-engine/rn';
import type {NetworkJoinFailureReason, NetworkJoinResult} from '@votetorrent/vote-engine/rn';
import {JOIN_CODE_FIXTURES} from '@votetorrent/vote-engine/test/fixtures/join-code-fixtures';
import type {JoinCodeFixtureName} from '@votetorrent/vote-engine/test/fixtures/join-code-fixtures';
import {lightTheme} from '../../../theme/themes';

const mockJoinNetwork = jest.fn();
jest.mock('../../../providers/VoterAppProvider', () => ({
	useVoterApp: () => ({joinNetwork: (...args: unknown[]) => mockJoinNetwork(...args)}),
}));
const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
const mockSetParams = jest.fn();
const mockSetOptions = jest.fn();
jest.mock('@react-navigation/native', () => ({
	...jest.requireActual('@react-navigation/native'),
	useNavigation: () => ({goBack: mockGoBack, navigate: mockNavigate, setParams: mockSetParams, setOptions: mockSetOptions}),
}));

import JoinNetworkScreen, {joinDecodeErrorKey, joinFailureKey} from '../JoinNetworkScreen';

interface VcMock {
	__setCameraDevice(d: unknown): void;
	__setCameraPermissionStatus(s: string): void;
	__setCameraPermissionRequestResult(r: unknown): void;
	__cameraPermissionRequestCount(): number;
	__resetVisionCameraMock(): void;
}
interface BsMock {
	__emitBarcodes(b: unknown[]): void;
	__resetBarcodeScannerMock(): void;
}
const vc = require('../../../../__mocks__/react-native-vision-camera.js') as VcMock;
const bs = require('../../../../__mocks__/react-native-vision-camera-barcode-scanner.js') as BsMock;
const Clipboard = require('@react-native-clipboard/clipboard').default as {getString: () => Promise<string>};

const OK_NAMES: JoinCodeFixtureName[] = ['v2-1-member', 'v2-2-members', 'v2-6-members', 'v2-non-ascii-name', 'v1-legacy-1-member'];
const sample = JOIN_CODE_FIXTURES['v2-1-member'];
const t = i18n.getFixedT('en', 'join');
const netRef = (name: JoinCodeFixtureName) => ({
	hash: JOIN_CODE_FIXTURES[name].networkHash,
	relays: [],
	name: JOIN_CODE_FIXTURES[name].name,
	primaryAuthorityDomainName: 'example.org',
});

let tr: renderer.ReactTestRenderer;
function render() {
	renderer.act(() => {
		tr = renderer.create(
			<ThemeProvider value={lightTheme}>
				<JoinNetworkScreen />
			</ThemeProvider>,
			// A host instance for the Scan button's ref, so the focus-return call is assertable.
			{createNodeMock: () => ({})},
		);
	});
	return tr;
}
const byId = (id: string) => tr.root.find(node => node.props.testID === id);
const hasId = (id: string) => tr.root.findAll(node => node.props.testID === id).length > 0;
const joinText = (nodes: renderer.ReactTestInstance[]) =>
	nodes.map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children ?? ''))).join(' | ');
const textOf = () => joinText(tr.root.findAllByType(Text));
const textIn = (id: string) => joinText(byId(id).findAllByType(Text));
const cams = () => tr.root.findAll(n => (n.type as unknown) === 'VisionCameraMock');
function type(value: string) {
	renderer.act(() => {
		byId('join-network-code-input').props.onChangeText(value);
	});
}
async function pressJoin() {
	await renderer.act(async () => {
		await byId('join-network-submit').props.onPress();
	});
}
async function pressScan() {
	await renderer.act(async () => {
		byId('join-network-scan').props.onPress();
	});
}
function emitScan(rawValue: string) {
	renderer.act(() => {
		bs.__emitBarcodes([{rawValue}]);
	});
}
const flat = (s: unknown) => StyleSheet.flatten(s as never) as Record<string, unknown>;
const inputValue = () => byId('join-network-code-input').props.value as string;

let announce: jest.SpyInstance;
let sendEvent: jest.SpyInstance;

beforeEach(() => {
	mockJoinNetwork.mockReset();
	mockGoBack.mockReset();
	mockNavigate.mockReset();
	mockSetParams.mockReset();
	mockSetOptions.mockReset();
	vc.__resetVisionCameraMock();
	bs.__resetBarcodeScannerMock();
	announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
	sendEvent = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent').mockImplementation(() => {});
});

afterEach(() => {
	// the screen only ever goes back: no onward route, no param, no option (D-06)
	expect(mockNavigate).not.toHaveBeenCalled();
	expect(mockSetParams).not.toHaveBeenCalled();
	expect(mockSetOptions).not.toHaveBeenCalled();
	renderer.act(() => {
		tr?.unmount();
	});
	jest.restoreAllMocks();
});

describe('JoinNetworkScreen', () => {
	it('starts with the Join button disabled and no preview', () => {
		render();
		expect(byId('join-network-submit').props.disabled).toBe(true);
		expect(hasId('join-network-preview')).toBe(false);
	});

	describe.each(OK_NAMES)('with the %s code', name => {
		const fixture = JOIN_CODE_FIXTURES[name];

		it('a typed code fills the field exactly, shows the network name and fingerprint, and enables Join', () => {
			render();
			type(`  ${fixture.text}\n`);
			expect((inputValue() === `  ${fixture.text}\n`) as boolean).toBe(true);
			expect(byId('join-network-preview-name').props.children === fixture.name).toBe(true);
			expect(byId('join-network-preview-fingerprint').props.children === fixture.fingerprint).toBe(true);
			expect(byId('join-network-preview-name').props.numberOfLines).toBeUndefined();
			expect(byId('join-network-preview-fingerprint').props.numberOfLines).toBeUndefined();
			expect(textOf()).toContain('matches the one your election authority published');
			expect(byId('join-network-submit').props.disabled).toBe(false);
		});

		it('Join passes the decoded code to the provider, shows the joined state, and Done goes back', async () => {
			mockJoinNetwork.mockImplementation(async (_code: unknown, onStep: (s: string) => void): Promise<NetworkJoinResult> => {
				onStep('syncing');
				return {ok: true, outcome: 'joined', admittedVia: 'redeemed', networkRef: netRef(name), fingerprint: fixture.fingerprint};
			});
			render();
			type(fixture.text);
			await pressJoin();
			const expected = decodeNetworkJoinCode(fixture.text);
			expect(expected.ok).toBe(true);
			expect(mockJoinNetwork).toHaveBeenCalledTimes(1);
			const passed = mockJoinNetwork.mock.calls[0][0];
			expect(isDeepStrictEqual(passed, expected.ok ? expected.code : undefined)).toBe(true);
			expect(byId('join-network-joined').props.children === t('joinedTitle', {name: fixture.name})).toBe(true);
			renderer.act(() => {
				byId('join-network-done').props.onPress();
			});
			expect(mockGoBack).toHaveBeenCalled();
		});
	});

	describe('decode errors (D-07)', () => {
		const older = JOIN_CODE_FIXTURES['v1-114-no-prefix'].text;
		const cases: Array<[string, () => string, string]> = [
			['not a join code', () => 'hello world', 'notJoinCode'],
			['a newer version', () => 'vtjoin9.' + sample.text.slice(8, 28), 'newerCode'],
			['an older invitation', () => older, 'olderCode'],
			['a truncated v2 code', () => sample.text.slice(0, 600), 'invalidCode'],
			['a malformed v1 prefix', () => 'vtjoin1.not-really', 'invalidCode'],
		];
		it.each(cases)('%s shows its own sentence and keeps Join disabled', (_label, text, key) => {
			render();
			type(text());
			const shown = byId('join-network-code-error').props.children as string;
			expect(shown === t(key)).toBe(true);
			expect(byId('join-network-submit').props.disabled).toBe(true);
		});
	});

	describe('key maps (D-07)', () => {
		it('maps every decode reason by type', () => {
			expect(joinDecodeErrorKey('not-join-code')).toBe('notJoinCode');
			expect(joinDecodeErrorKey('unsupported-version')).toBe('newerCode');
			expect(joinDecodeErrorKey('invitation-older-version')).toBe('olderCode');
			expect(joinDecodeErrorKey('malformed')).toBe('invalidCode');
			expect(joinDecodeErrorKey('something-else' as never)).toBe('invalidCode');
		});

		it('maps every join failure reason to its own copy key', () => {
			expect(joinFailureKey('invitation-malformed')).toBe('invalidCode');
			expect(joinFailureKey('invitation-expired')).toBe('error.invitationExpired');
			expect(joinFailureKey('invitation-older-version')).toBe('olderCode');
			expect(joinFailureKey('invitation-used-up')).toBe('error.invitationUsedUp');
			expect(joinFailureKey('not-admitted')).toBe('error.notAdmitted');
			expect(joinFailureKey('no-peers')).toBe('error.noPeers');
			expect(joinFailureKey('not-synced')).toBe('error.notSynced');
			expect(joinFailureKey('digest-mismatch')).toBe('error.digestMismatch');
			expect(joinFailureKey('open-failed')).toBe('error.openFailed');
			expect(joinFailureKey('surprise' as NetworkJoinFailureReason)).toBe('error.generic');
		});

		it('a used-up code shows the neutral A4 sentence, never a hostile detail', async () => {
			mockJoinNetwork.mockResolvedValue({ok: false, reason: 'invitation-used-up', detail: sample.text});
			render();
			type(sample.text);
			await pressJoin();
			const shown = byId('join-network-error').props.children as string;
			expect(shown.includes('election office')).toBe(true);
			expect(shown.includes('too many')).toBe(false);
			expect(textOf().includes(sample.text.slice(0, 40))).toBe(false);
		});

		it('an older-version refusal shows the olderCode copy', async () => {
			mockJoinNetwork.mockResolvedValue({ok: false, reason: 'invitation-older-version', detail: 'x'});
			render();
			type(sample.text);
			await pressJoin();
			expect((byId('join-network-error').props.children as string) === t('olderCode')).toBe(true);
		});
	});

	it('shows the current step while joining', async () => {
		let release!: (r: NetworkJoinResult) => void;
		mockJoinNetwork.mockImplementation((_code: unknown, onStep: (s: string) => void) => {
			onStep('verifying');
			return new Promise(resolve => {
				release = resolve;
			});
		});
		render();
		type(sample.text);
		renderer.act(() => {
			void byId('join-network-submit').props.onPress();
		});
		expect(byId('join-network-step').props.children).toBe('Checking the network matches the code…');
		expect(byId('join-network-scan').props.accessibilityState).toEqual({disabled: true});
		await renderer.act(async () => {
			release({ok: false, reason: 'no-peers', detail: 'x'});
		});
		expect(byId('join-network-error').props.children).toContain("couldn't reach the election authority's network");
	});

	it('a refused join shows translated copy for its reason, never the engine detail', async () => {
		mockJoinNetwork.mockResolvedValue({ok: false, reason: 'digest-mismatch', detail: 'join: RAW ENGINE TEXT'});
		render();
		type(sample.text);
		await pressJoin();
		expect(byId('join-network-error').props.children).toContain("doesn't match the join code");
		expect(textOf()).not.toContain('RAW ENGINE TEXT');
	});

	it('a thrown join (identity failure) shows the generic copy', async () => {
		mockJoinNetwork.mockRejectedValue(new Error('IdentityLost: raw'));
		render();
		type(sample.text);
		await pressJoin();
		expect(byId('join-network-error').props.children).toBe('Something went wrong while joining. Try again.');
		expect(textOf()).not.toContain('IdentityLost');
	});
});

describe('scan entry (D-02, D-05)', () => {
	it('opens the scanner on the press; an accepted read fills the field and never joins', async () => {
		render();
		await pressScan();
		expect(cams().length).toBe(1);
		emitScan(sample.text);
		expect(cams().length).toBe(0);
		expect(inputValue() === sample.text).toBe(true);
		expect(byId('join-network-preview-name').props.children === sample.name).toBe(true);
		const status = byId('join-network-scan-status');
		expect(textIn('join-network-scan-status')).toContain(t('scannedNotice'));
		const noteText = status.findAll(n => n.props.accessibilityRole === 'text')[0];
		expect(noteText.props.accessibilityLiveRegion).toBe('polite');
		expect(mockJoinNetwork).not.toHaveBeenCalled();
		expect(byId('join-network-submit').props.disabled).toBe(false);
		expect(announce).toHaveBeenCalledTimes(1);
		expect(sendEvent).toHaveBeenCalledWith(expect.anything(), 'focus');
		mockJoinNetwork.mockResolvedValue({ok: true, outcome: 'joined', admittedVia: 'redeemed', networkRef: netRef('v2-1-member'), fingerprint: sample.fingerprint});
		await pressJoin();
		expect(mockJoinNetwork).toHaveBeenCalledTimes(1);
	});

	it('editing the text, or pasting, removes the scanned note', async () => {
		render();
		await pressScan();
		emitScan(sample.text);
		expect(hasId('join-network-scan-status')).toBe(true);
		type(sample.text + ' ');
		expect(hasId('join-network-scan-status')).toBe(false);

		await pressScan();
		emitScan(sample.text);
		expect(hasId('join-network-scan-status')).toBe(true);
		jest.spyOn(Clipboard, 'getString').mockResolvedValue(JOIN_CODE_FIXTURES['v2-2-members'].text);
		await renderer.act(async () => {
			await byId('join-network-paste').props.onPress();
		});
		expect(hasId('join-network-scan-status')).toBe(false);
	});

	it('a scanned older code shows its field error and no scanned note (R3)', async () => {
		render();
		await pressScan();
		emitScan(JOIN_CODE_FIXTURES['v1-114-no-prefix'].text);
		expect(inputValue() === JOIN_CODE_FIXTURES['v1-114-no-prefix'].text).toBe(true);
		expect((byId('join-network-code-error').props.children as string) === t('olderCode')).toBe(true);
		expect(hasId('join-network-scan-status')).toBe(false);
	});

	it('the Scan button is a labelled button with the primary border', () => {
		render();
		const scan = byId('join-network-scan');
		expect(scan.props.accessibilityRole).toBe('button');
		expect(scan.props.disabled).toBe(false);
		expect(textIn('join-network-scan')).toContain(t('scanButton'));
		expect(flat(scan.props.style).borderColor).toBe(lightTheme.colors.primary);
		expect(scan.findAll(n => n.props.name === 'qrcode').length).toBeGreaterThan(0);
	});

	it('paste instead and close return to the screen with the field unchanged', async () => {
		const getString = jest.spyOn(Clipboard, 'getString');
		render();
		type(sample.text);
		await pressScan();
		renderer.act(() => {
			byId('join-network-scan-paste').props.onPress();
		});
		expect(cams().length).toBe(0);
		expect(inputValue() === sample.text).toBe(true);
		expect(hasId('join-network-scan-status')).toBe(false);
		await pressScan();
		renderer.act(() => {
			byId('join-network-scan-close').props.onPress();
		});
		expect(cams().length).toBe(0);
		expect(inputValue() === sample.text).toBe(true);
		expect(getString).not.toHaveBeenCalled();
	});
});

describe('camera notices (D-05)', () => {
	const alertsIn = (id: string) => byId(id).findAll(n => n.props.accessibilityRole === 'alert', {deep: false});

	function expectPasteStillUsable() {
		expect(byId('join-network-paste').props.disabled).toBe(false);
		expect(byId('join-network-code-input').props.editable).toBe(true);
	}

	it('no back camera: cameraNone, Scan disabled', () => {
		vc.__setCameraDevice(undefined);
		render();
		expect(alertsIn('join-network-scan-status').length).toBe(1);
		expect(textIn('join-network-scan-status')).toContain(t('cameraNone'));
		const scan = byId('join-network-scan');
		expect(scan.props.disabled).toBe(true);
		expect(scan.props.accessibilityState).toEqual({disabled: true});
		expect(flat(scan.props.style).borderColor).toBe(lightTheme.colors.border);
		expectPasteStillUsable();
	});

	it.each(['denied', 'restricted'])('permission %s: cameraBlocked plus Open Settings, Scan disabled', status => {
		vc.__setCameraPermissionStatus(status);
		const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined as never);
		openSettings.mockClear(); // the preset's openSettings is a shared jest.fn that keeps earlier calls
		render();
		expect(alertsIn('join-network-scan-status').length).toBe(1);
		expect(textIn('join-network-scan-status')).toContain(t('cameraBlocked'));
		expect(byId('join-network-scan').props.disabled).toBe(true);
		expect(byId('join-network-scan-open-settings').props.accessibilityRole).toBe('button');
		renderer.act(() => {
			byId('join-network-scan-open-settings').props.onPress();
		});
		expect(openSettings).toHaveBeenCalledTimes(1);
		expectPasteStillUsable();
	});

	it('a refused request shows cameraDenied, keeps Scan enabled, and a second press asks again', async () => {
		vc.__setCameraPermissionStatus('not-determined');
		vc.__setCameraPermissionRequestResult('not-determined');
		render();
		await pressScan();
		expect(cams().length).toBe(0);
		expect(alertsIn('join-network-scan-status').length).toBe(1);
		expect(textIn('join-network-scan-status')).toContain(t('cameraDenied'));
		expect(byId('join-network-scan').props.disabled).toBe(false);
		expect(vc.__cameraPermissionRequestCount()).toBe(1);
		await pressScan();
		expect(vc.__cameraPermissionRequestCount()).toBe(2);
		expectPasteStillUsable();
	});

	it('a camera error closes the scanner and shows cameraFailed with Scan enabled', async () => {
		render();
		await pressScan();
		renderer.act(() => {
			cams()[0].props.onError(new Error('x'));
		});
		expect(cams().length).toBe(0);
		expect(alertsIn('join-network-scan-status').length).toBe(1);
		expect(textIn('join-network-scan-status')).toContain(t('cameraFailed'));
		expect(byId('join-network-scan').props.disabled).toBe(false);
		expectPasteStillUsable();
	});

	it('no notice, no numberOfLines anywhere in the status area', () => {
		render();
		expect(hasId('join-network-scan-status')).toBe(false);
		vc.__setCameraDevice(undefined);
		renderer.act(() => tr.unmount());
		render();
		expect(byId('join-network-scan-status').findAllByType(Text).every(n => n.props.numberOfLines === undefined)).toBe(true);
	});
});

describe('keyboard inset (Android edge-to-edge)', () => {
	const SHOW = Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow';
	const HIDE = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
	let handlers: Record<string, (e?: unknown) => void>;

	beforeEach(() => {
		handlers = {};
		jest.spyOn(Keyboard, 'addListener').mockImplementation(((e: string, cb: (x?: unknown) => void) => {
			handlers[e] = cb;
			return {remove: jest.fn()};
		}) as never);
		jest
			.spyOn(require('react-native-safe-area-context'), 'useSafeAreaInsets')
			.mockReturnValue({top: 0, right: 0, bottom: 34, left: 0});
	});

	const padding = () => flat(tr.root.findByType(ScrollView).props.contentContainerStyle).paddingBottom;

	it('pads the bottom by 16 + safe area, grows by the keyboard height, and restores on hide', () => {
		render();
		expect(padding()).toBe(16 + 34);
		renderer.act(() => handlers[SHOW]?.({endCoordinates: {height: 733}}));
		expect(padding()).toBe(16 + 34 + 733);
		renderer.act(() => handlers[HIDE]?.());
		expect(padding()).toBe(16 + 34);
	});
});

describe('locales', () => {
	afterEach(async () => {
		await renderer.act(async () => {
			await i18n.changeLanguage('en');
		});
	});

	it.each(['en', 'es'])('%s: the camera, scanned and older-code copy render translated', async lng => {
		await renderer.act(async () => {
			await i18n.changeLanguage(lng);
		});
		const tt = i18n.getFixedT(lng, 'join');
		for (const key of ['cameraNone', 'scannedNotice', 'olderCode']) {
			expect(tt(key) !== key).toBe(true);
		}

		vc.__setCameraDevice(undefined);
		render();
		expect(textIn('join-network-scan-status')).toContain(tt('cameraNone'));
		renderer.act(() => tr.unmount());

		vc.__resetVisionCameraMock();
		render();
		await pressScan();
		emitScan(sample.text);
		expect(textIn('join-network-scan-status')).toContain(tt('scannedNotice'));
		renderer.act(() => tr.unmount());

		render();
		type(JOIN_CODE_FIXTURES['v1-114-no-prefix'].text);
		expect((byId('join-network-code-error').props.children as string) === tt('olderCode')).toBe(true);
	});
});
