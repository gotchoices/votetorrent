/**
 * Choose image inside the Voter's camera scanner (Settings > Join a network), and beside the camera
 * notice when the camera cannot be used.
 *
 * A picked image is read by `engines/qr-image-decode` (mocked here; its own suite covers the
 * pipeline) and its QR values go through the scanner's own check: a join code fills the field
 * exactly as a camera read does, anything else gets the camera's "not a join code" banner. The
 * camera pauses while the picker is open and resumes after a cancel. Codes are the real-encoder
 * fixtures, compared with boolean assertions only (a failing matcher would print a bearer
 * credential).
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {AccessibilityInfo, Text} from 'react-native';
import {ThemeProvider} from '@react-navigation/native';
import i18n from 'i18next';
import {resources} from '../../../i18n';
import {JOIN_CODE_FIXTURES} from '@votetorrent/vote-engine/test/fixtures/join-code-fixtures';
import {darkTheme} from '../../../theme/themes';
import {captureConsole, expectNoSecretInConsole} from '../../../engines/__fixtures__/console-leak';

const mockJoinNetwork = jest.fn();
jest.mock('../../../providers/VoterAppProvider', () => ({
	useVoterApp: () => ({joinNetwork: (...args: unknown[]) => mockJoinNetwork(...args)}),
}));
const mockNavigate = jest.fn();
const mockSetParams = jest.fn();
jest.mock('@react-navigation/native', () => {
	const actual = jest.requireActual('@react-navigation/native');
	return {...actual, useNavigation: () => ({navigate: mockNavigate, setParams: mockSetParams, goBack: jest.fn()})};
});
const mockAvailable = jest.fn(() => true);
const mockPick = jest.fn();
jest.mock('../../../engines/qr-image-decode', () => ({
	isQrImageDecodeAvailable: () => mockAvailable(),
	pickImageAndReadQrCodes: (deps: unknown) => mockPick(deps),
}));

import JoinNetworkScreen from '../JoinNetworkScreen';
import {judgeScannedValues, scanImageOutcome} from '../JoinCodeScanner';

interface VcMock {
	__setCameraDevice(d: unknown): void;
	__setCameraPermissionStatus(s: string): void;
	__setCameraPermissionRequestResult(r: unknown): void;
	__resetVisionCameraMock(): void;
}
interface BsMock {
	__emitBarcodes(b: unknown[]): void;
	__resetBarcodeScannerMock(): void;
}
const vc = require('../../../../__mocks__/react-native-vision-camera.js') as VcMock;
const bs = require('../../../../__mocks__/react-native-vision-camera-barcode-scanner.js') as BsMock;

const t = i18n.getFixedT('en', 'join');
const enJoin = (resources.en as Record<string, Record<string, string>>).join;
const esJoin = (resources.es as Record<string, Record<string, string>>).join;
const sample = JOIN_CODE_FIXTURES['v2-1-member'];
const POSTER = 'https://example.org/poster/0123456789abcdef0123456789';

type Inst = renderer.ReactTestInstance;
let tr: renderer.ReactTestRenderer | undefined;

async function mount() {
	await renderer.act(async () => {
		tr = renderer.create(
			<ThemeProvider value={darkTheme}>
				<JoinNetworkScreen />
			</ThemeProvider>,
			{createNodeMock: () => ({})},
		);
	});
	await settle();
}
const root = () => (tr as renderer.ReactTestRenderer).root;
const cams = () => root().findAll(n => (n.type as unknown) === 'VisionCameraMock');
const hostById = (id: string): Inst | undefined => root().findAll(n => typeof n.type === 'string' && n.props.testID === id)[0];
function elWith(id: string, prop: string): Inst {
	const found = root().findAll(n => n.props.testID === id && typeof n.props[prop] === 'function')[0];
	if (!found) throw new Error('no element ' + id + ' with ' + prop);
	return found;
}
/** The text a host node shows: its string children, depth first, with no separator. */
function textOf(n: Inst): string {
	return n.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
}
/** Icon glyphs (FontAwesome6 renders a private-use character) are not copy. */
const textIn = (id: string) => {
	const h = hostById(id);
	return h ? textOf(h).replace(/[\uE000-\uF8FF]/g, '') : '';
};
const inputValue = () => (hostById('join-network-code-input')?.props.value ?? '') as string;
async function settle() {
	await renderer.act(async () => {
		for (let i = 0; i < 8; i++) await Promise.resolve();
	});
}
async function press(id: string) {
	await renderer.act(async () => {
		await elWith(id, 'onPress').props.onPress();
	});
	await settle();
}
function isInside(childId: string, parentId: string): boolean {
	const parent = hostById(parentId);
	return parent !== undefined && parent.findAll(n => typeof n.type === 'string' && n.props.testID === childId).length > 0;
}

beforeEach(() => {
	vc.__resetVisionCameraMock();
	bs.__resetBarcodeScannerMock();
	for (const m of [mockJoinNetwork, mockNavigate, mockSetParams, mockPick]) m.mockReset();
	mockAvailable.mockReset();
	mockAvailable.mockReturnValue(true);
	jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
	jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent').mockImplementation(() => {});
});
afterEach(async () => {
	// A pick never joins by itself and nothing it reads reaches navigation.
	expect(mockJoinNetwork).not.toHaveBeenCalled();
	expect(mockNavigate).not.toHaveBeenCalled();
	expect(mockSetParams).not.toHaveBeenCalled();
	if (tr) {
		await renderer.act(async () => {
			tr!.unmount();
		});
		tr = undefined;
	}
	jest.restoreAllMocks();
});

describe('Choose image inside the scanner (Settings > Join a network)', () => {
	it('GI-1: the scanner shows Choose image inside it, next to Paste instead, with an accessible label', async () => {
		await mount();
		expect(hostById('join-network-scan-image')).toBeUndefined();
		await press('join-network-scan');
		expect(cams()).toHaveLength(1);
		expect(isInside('join-network-scan-image', 'join-network-scanner')).toBe(true);
		expect(isInside('join-network-scan-paste', 'join-network-scanner')).toBe(true);
		const button = elWith('join-network-scan-image', 'onPress');
		expect(button.props.accessibilityRole).toBe('button');
		expect(button.props.accessibilityLabel).toBe(t('scanImageLabel'));
		expect(button.props.disabled).toBe(false);
		expect(textIn('join-network-scan-image')).toBe(t('scanImageButton'));
		expect(hostById('join-network-scan-image-unavailable')).toBeUndefined();
	});

	it('GI-2: a picked join code fills the field through the camera path: preview, scanned note, Join ready, no join', async () => {
		mockPick.mockResolvedValue({kind: 'decoded', values: [POSTER, sample.text]});
		const capture = captureConsole();
		try {
			await mount();
			await press('join-network-scan');
			await press('join-network-scan-image');
			expect(mockPick).toHaveBeenCalledTimes(1);
			expect(mockPick.mock.calls[0][0]).toEqual({logTag: '[join]'});
			expect(cams()).toHaveLength(0);
			expect(inputValue() === sample.text).toBe(true);
			expect(textIn('join-network-preview-name') === sample.name).toBe(true);
			expect(textIn('join-network-scan-status')).toBe(t('scannedNotice'));
			expect(elWith('join-network-submit', 'onPress').props.disabled).toBe(false);
			expectNoSecretInConsole(capture, [sample.text]);
		} finally {
			capture.restore();
		}
	});

	it('GI-3: a QR that is not a join code gets the same banner as a camera read; the field stays empty, the camera resumes', async () => {
		mockPick.mockResolvedValue({kind: 'decoded', values: [POSTER]});
		await mount();
		await press('join-network-scan');
		await press('join-network-scan-image');
		expect(textIn('join-network-scan-banner')).toBe(t('scanNotJoinCode'));
		expect(inputValue()).toBe('');
		expect(cams()).toHaveLength(1);
		expect(cams()[0].props.isActive).toBe(true);
	});

	it('GI-4: the camera pauses while the picker is open; a cancel resumes it and says no image was chosen', async () => {
		let finish: (v: unknown) => void = () => undefined;
		mockPick.mockReturnValue(new Promise(resolve => (finish = resolve)));
		await mount();
		await press('join-network-scan');
		expect(cams()[0].props.isActive).toBe(true);
		await renderer.act(async () => {
			elWith('join-network-scan-image', 'onPress').props.onPress();
		});
		expect(cams()[0].props.isActive).toBe(false);
		expect(elWith('join-network-scan-image', 'onPress').props.disabled).toBe(true);
		expect(hostById('join-network-scan-image-busy')).toBeDefined();
		await renderer.act(async () => {
			bs.__emitBarcodes([{rawValue: sample.text}]);
		});
		expect(inputValue()).toBe('');
		await renderer.act(async () => {
			finish({kind: 'cancelled'});
		});
		await settle();
		expect(cams()[0].props.isActive).toBe(true);
		expect(textIn('join-network-scan-banner')).toBe(t('scanImageCancelled'));
		await renderer.act(async () => {
			bs.__emitBarcodes([{rawValue: sample.text}]);
		});
		expect(inputValue() === sample.text).toBe(true);
	});

	it('GI-5: a picture with no QR code and an unreadable picture each get their own banner', async () => {
		await mount();
		await press('join-network-scan');
		mockPick.mockResolvedValueOnce({kind: 'no-code'});
		await press('join-network-scan-image');
		expect(textIn('join-network-scan-banner')).toBe(t('scanImageNoCode'));
		mockPick.mockResolvedValueOnce({kind: 'unreadable'});
		await press('join-network-scan-image');
		expect(textIn('join-network-scan-banner')).toBe(t('scanImageUnreadable'));
		expect(new Set([t('scanImageCancelled'), t('scanImageNoCode'), t('scanImageUnreadable')]).size).toBe(3);
		expect(inputValue()).toBe('');
	});

	it('GI-6: a build without the image picker shows Choose image disabled with a sentence; scanning still works', async () => {
		mockAvailable.mockReturnValue(false);
		await mount();
		await press('join-network-scan');
		const button = elWith('join-network-scan-image', 'onPress');
		expect(button.props.disabled).toBe(true);
		expect(button.props.accessibilityState).toEqual(expect.objectContaining({disabled: true}));
		expect(textIn('join-network-scan-image-unavailable')).toBe(t('scanImageUnavailable'));
		expect(mockPick).not.toHaveBeenCalled();
		await renderer.act(async () => {
			bs.__emitBarcodes([{rawValue: sample.text}]);
		});
		expect(inputValue() === sample.text).toBe(true);
	});

	it('GI-7: a pick that comes back after the scanner closed fills nothing', async () => {
		let finish: (v: unknown) => void = () => undefined;
		mockPick.mockReturnValue(new Promise(resolve => (finish = resolve)));
		await mount();
		await press('join-network-scan');
		await renderer.act(async () => {
			elWith('join-network-scan-image', 'onPress').props.onPress();
		});
		await press('join-network-scan-close');
		await renderer.act(async () => {
			finish({kind: 'decoded', values: [sample.text]});
		});
		await settle();
		expect(inputValue()).toBe('');
	});
});

describe('Choose image when the camera cannot be used', () => {
	it('GC-1: a blocked camera keeps Scan disabled; the notice is followed by Choose image, which fills the field', async () => {
		vc.__setCameraPermissionStatus('denied');
		mockPick.mockResolvedValue({kind: 'decoded', values: [sample.text]});
		await mount();
		expect(elWith('join-network-scan', 'onPress').props.disabled).toBe(true);
		expect(textIn('join-network-scan-status')).toContain(t('cameraBlocked'));
		expect(elWith('join-network-scan-status-image', 'onPress').props.accessibilityLabel).toBe(t('scanImageLabel'));
		await press('join-network-scan-status-image');
		expect(cams()).toHaveLength(0);
		expect(inputValue() === sample.text).toBe(true);
		expect(textIn('join-network-preview-name') === sample.name).toBe(true);
	});

	it('GC-2: a refused permission request offers Choose image; another QR is refused with the scan sentence', async () => {
		vc.__setCameraPermissionStatus('not-determined');
		vc.__setCameraPermissionRequestResult('not-determined');
		mockPick.mockResolvedValue({kind: 'decoded', values: [POSTER]});
		await mount();
		await press('join-network-scan');
		expect(textIn('join-network-scan-status')).toBe(t('cameraDenied'));
		await press('join-network-scan-status-image');
		expect(textIn('join-network-image-notice')).toBe(t('scanNotJoinCode'));
		expect(inputValue()).toBe('');
	});

	it('GC-3: no camera offers Choose image; no QR, unreadable and cancelled each say so', async () => {
		vc.__setCameraDevice(undefined);
		await mount();
		expect(textIn('join-network-scan-status')).toBe(t('cameraNone'));
		for (const [result, key] of [
			[{kind: 'no-code'}, 'scanImageNoCode'],
			[{kind: 'unreadable'}, 'scanImageUnreadable'],
			[{kind: 'cancelled'}, 'scanImageCancelled'],
		] as const) {
			mockPick.mockResolvedValueOnce(result);
			await press('join-network-scan-status-image');
			expect(textIn('join-network-image-notice')).toBe(t(key));
		}
		expect(inputValue()).toBe('');
	});

	it('GC-4: a build without the image picker offers no Choose image beside the camera notice', async () => {
		vc.__setCameraPermissionStatus('denied');
		mockAvailable.mockReturnValue(false);
		await mount();
		expect(textIn('join-network-scan-status')).toContain(t('cameraBlocked'));
		expect(hostById('join-network-scan-status-image')).toBeUndefined();
	});
});

describe('one check for a camera frame and a picked image', () => {
	it('J-1: judgeScannedValues takes the first join code and refuses anything else', () => {
		expect(judgeScannedValues([undefined, POSTER, sample.text])).toEqual({type: 'accepted', value: sample.text});
		expect(judgeScannedValues([POSTER])).toEqual({type: 'not-join-code'});
		expect(judgeScannedValues([])).toEqual({type: 'not-join-code'});
	});

	it('J-2: scanImageOutcome maps every picker result to the join code or its own sentence', () => {
		expect(scanImageOutcome({kind: 'decoded', values: [sample.text]})).toEqual({type: 'accepted', value: sample.text});
		const keys = (['decoded', 'no-code', 'unreadable', 'cancelled', 'unavailable'] as const).map(
			kind => (scanImageOutcome(kind === 'decoded' ? {kind, values: [POSTER]} : {kind}) as {key: string}).key,
		);
		expect(keys).toEqual(['scanNotJoinCode', 'scanImageNoCode', 'scanImageUnreadable', 'scanImageCancelled', 'scanImageUnavailable']);
	});

	it('J-3: every new sentence exists in English and Spanish', () => {
		for (const key of ['scanImageButton', 'scanImageLabel', 'scanImageCancelled', 'scanImageNoCode', 'scanImageUnreadable', 'scanImageUnavailable']) {
			expect(typeof enJoin[key] === 'string' && enJoin[key].length > 0).toBe(true);
			expect(typeof esJoin[key] === 'string' && esJoin[key].length > 0 && esJoin[key] !== enJoin[key]).toBe(true);
		}
	});
});
