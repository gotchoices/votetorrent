/**
 * JoinCodeScanner contract tests (Phase 64 plan 64-18; D-02, D-05, D-06).
 *
 * The scanner composes VisionCamera's Camera with useBarcodeScannerOutput. Both packages are Nitro
 * bindings that cannot load under jest, so the 64-01 manual mocks stand in; their `__` controls are
 * reached ONLY by require() of the mock FILE (the real .d.ts has no such names).
 *
 * Mock behaviour this file is written against (read back in preconditions item (e)):
 *  - `__setCameraPermissionStatus` only SEEDS a new mount (the hook keeps the status as React state);
 *    `requestPermission` then sets the state live. So every test sets the status BEFORE rendering.
 *  - the barcode mock records every options object and `__emitBarcodes` calls the latest
 *    `onBarcodeScanned`.
 *
 * Every test runs inside captureConsole(): each console call must be exactly one closed literal
 * token and no fixture text, name, fingerprint or rejected payload may appear (D-06). Code text is
 * never given to a matcher that prints its operands: comparisons are boolean.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {AppState, Dimensions, Modal, Text} from 'react-native';
import {ThemeProvider} from '@react-navigation/native';
import i18n from 'i18next';
import '../../../i18n';
import {JOIN_CODE_FIXTURES} from '@votetorrent/vote-engine/test/fixtures/join-code-fixtures';
import type {JoinCodeFixtureName} from '@votetorrent/vote-engine/test/fixtures/join-code-fixtures';
import {lightTheme} from '../../../theme/themes';
import {captureConsole, expectNoSecretInConsole} from '../../../engines/__fixtures__/console-leak';
import type {ConsoleCapture} from '../../../engines/__fixtures__/console-leak';

const mockJoinNetwork = jest.fn();
jest.mock('../../../providers/VoterAppProvider', () => ({
	useVoterApp: () => ({joinNetwork: (...args: unknown[]) => mockJoinNetwork(...args)}),
}));

import JoinCodeScanner, {
	JOIN_SCAN_BANNER_MS,
	JOIN_SCAN_BARCODE_FORMATS,
	JOIN_SCAN_REJECT_IGNORE_MS,
	JOIN_SCAN_SLOW_MS,
	joinScanAvailability,
} from '../JoinCodeScanner';
import type {JoinCodeScannerProps} from '../JoinCodeScanner';

interface VcMock {
	__setCameraDevice(d: unknown): void;
	__setCameraPermissionStatus(s: string): void;
	__setCameraPermissionRequestResult(r: unknown): void;
	__cameraPermissionRequestCount(): number;
	__resetVisionCameraMock(): void;
}
interface BsMock {
	__emitBarcodes(b: unknown[]): void;
	__emitBarcodeScannerError(e: Error): void;
	__barcodeScannerOutputs(): Array<{
		barcodeFormats: unknown;
		outputResolution: string;
		onBarcodeScanned(b: unknown[]): void;
		onError(e: Error): void;
	}>;
	__resetBarcodeScannerMock(): void;
}
const vc = require('../../../../__mocks__/react-native-vision-camera.js') as VcMock;
const bs = require('../../../../__mocks__/react-native-vision-camera-barcode-scanner.js') as BsMock;
const Clipboard = require('@react-native-clipboard/clipboard').default as {getString: () => Promise<string>};

const t = i18n.getFixedT('en', 'join');
const NAMES = Object.keys(JOIN_CODE_FIXTURES) as JoinCodeFixtureName[];
const sample = JOIN_CODE_FIXTURES['v2-1-member'];
const POSTER = 'https://example.org/poster/0123456789abcdef0123456789';

const CLOSED_TOKENS = [
	'[join] scan: accepted',
	'[join] scan: rejected-not-join-code',
	'[join] scan: permission-denied',
	'[join] scan: permission-blocked',
	'[join] scan: permission-request-failed',
	'[join] scan: no-camera',
	'[join] scan: camera-failed',
	'[join] scan: scanner-failed',
];

let capture: ConsoleCapture;
let secretsInPlay: string[];
let props: JoinCodeScannerProps;
let tr: renderer.ReactTestRenderer | undefined;
let clipSpy: jest.SpyInstance;

function makeProps(over: Partial<JoinCodeScannerProps> = {}): JoinCodeScannerProps {
	return {
		visible: true,
		onAccept: jest.fn(),
		onClose: jest.fn(),
		onPasteInstead: jest.fn(),
		onCameraState: jest.fn(),
		...over,
	};
}
const tree = (p: JoinCodeScannerProps) => (
	<ThemeProvider value={lightTheme}>
		<JoinCodeScanner {...p} />
	</ThemeProvider>
);
function mount(over: Partial<JoinCodeScannerProps> = {}) {
	props = makeProps(over);
	renderer.act(() => {
		tr = renderer.create(tree(props));
	});
	return tr as renderer.ReactTestRenderer;
}
async function update(over: Partial<JoinCodeScannerProps>) {
	props = {...props, ...over};
	await renderer.act(async () => {
		(tr as renderer.ReactTestRenderer).update(tree(props));
	});
}
async function advance(ms: number) {
	await renderer.act(async () => {
		await jest.advanceTimersByTimeAsync(ms);
	});
}
const cams = () => (tr as renderer.ReactTestRenderer).root.findAll(n => (n.type as unknown) === 'VisionCameraMock');
const byId = (id: string) => (tr as renderer.ReactTestRenderer).root.find(n => n.props.testID === id);
const hasId = (id: string) => (tr as renderer.ReactTestRenderer).root.findAll(n => n.props.testID === id).length > 0;
const textIn = (id: string) =>
	byId(id)
		.findAllByType(Text)
		.map(n => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children ?? '')))
		.join(' ');
const emit = (barcodes: unknown[]) =>
	renderer.act(() => {
		bs.__emitBarcodes(barcodes);
	});
const state = () => (props.onCameraState as jest.Mock).mock.calls.map(c => c[0] as string);

beforeEach(() => {
	jest.useFakeTimers({doNotFake: ['queueMicrotask']});
	vc.__resetVisionCameraMock();
	bs.__resetBarcodeScannerMock();
	mockJoinNetwork.mockReset();
	clipSpy = jest.spyOn(Clipboard, 'getString');
	secretsInPlay = [];
	tr = undefined;
	capture = captureConsole();
});

afterEach(() => {
	try {
		renderer.act(() => {
			tr?.unmount();
		});
		// Every console call is exactly one closed literal token, and nothing sensitive is in any of them.
		for (const args of capture.calls()) {
			expect(args.length).toBe(1);
			expect(CLOSED_TOKENS.includes(args[0] as string)).toBe(true);
		}
		expectNoSecretInConsole(capture, [sample.text, sample.name, sample.fingerprint, POSTER, ...secretsInPlay]);
		// the scanner never joins (D-02)
		expect(mockJoinNetwork).not.toHaveBeenCalled();
		expect(clipSpy).not.toHaveBeenCalled();
	} finally {
		capture.restore();
		jest.useRealTimers();
		jest.restoreAllMocks();
	}
});

describe('joinScanAvailability', () => {
	it.each([
		['denied', true, 'blocked'],
		['restricted', false, 'blocked'],
		['authorized', false, 'none'],
		['authorized', true, 'ready'],
		['not-determined', true, 'ready'],
		['not-determined', false, 'ready'],
	] as const)('(%s, device %s) is %s', (status, hasDevice, expected) => {
		expect(joinScanAvailability(status, hasDevice)).toBe(expected);
	});
});

describe('hidden scanner', () => {
	it('mounts no camera, never requests permission, and reports availability', () => {
		mount({visible: false});
		expect(hasId('join-network-scan-preview')).toBe(false);
		expect(cams().length).toBe(0);
		expect(vc.__cameraPermissionRequestCount()).toBe(0);
		expect(state()).toContain('ready');
	});

	it('reports none when authorized and there is no back camera', () => {
		vc.__setCameraDevice(undefined);
		mount({visible: false});
		expect(state()).toEqual(['none']);
	});

	it.each(['denied', 'restricted'])('reports blocked when the status is %s', status => {
		vc.__setCameraPermissionStatus(status);
		mount({visible: false});
		expect(state()).toEqual(['blocked']);
	});
});

describe('open while authorized', () => {
	it('mounts one preview-resolution QR-only camera inside the wrapping View, with no request', () => {
		mount();
		expect(textIn('join-network-scan-starting')).toContain(t('scanStarting'));
		expect(cams().length).toBe(1);
		const cam = cams()[0];
		expect(cam.props.isActive).toBe(true);
		expect(cam.props.device.id).toBe('mock-back-camera');
		expect(cam.props.outputs[0].outputResolution).toBe('preview');
		expect(cam.props.outputs[0].barcodeFormats).toEqual(['qr-code']);
		expect(cam.props.outputs[0].barcodeFormats === JOIN_SCAN_BARCODE_FORMATS).toBe(true);
		expect(cam.props.testID).toBeUndefined();
		let node = cam.parent;
		while (node && node.props.testID === undefined) node = node.parent;
		expect(node?.props.testID).toBe('join-network-scan-preview');
		expect(vc.__cameraPermissionRequestCount()).toBe(0);
	});

	it('swaps the starting line for the instruction on onStarted, then for scanSlow plus full at the slow timeout', async () => {
		mount();
		renderer.act(() => {
			cams()[0].props.onStarted();
		});
		expect(hasId('join-network-scan-starting')).toBe(false);
		expect(textIn('join-network-scan-instruction')).toContain(t('scanInstruction'));
		await advance(JOIN_SCAN_SLOW_MS - 1);
		expect(textIn('join-network-scan-instruction')).toContain(t('scanInstruction'));
		expect(cams()[0].props.outputs[0].outputResolution).toBe('preview');
		await advance(1);
		expect(textIn('join-network-scan-instruction')).toContain(t('scanSlow'));
		const outs = bs.__barcodeScannerOutputs();
		expect(outs[outs.length - 1].outputResolution).toBe('full');
		expect(cams().length).toBe(1);
		expect(cams()[0].props.outputs[0].outputResolution).toBe('full');
		expect(outs.every(o => o.barcodeFormats === JOIN_SCAN_BARCODE_FORMATS)).toBe(true);
	});

	it('the slow timer starts at onStarted, not at the press', async () => {
		mount();
		await advance(JOIN_SCAN_SLOW_MS + 100);
		expect(cams()[0].props.outputs[0].outputResolution).toBe('preview');
	});
});

describe('accepting a read', () => {
	it.each(NAMES)('%s: hands the exact text to onAccept once and deactivates the camera', name => {
		const text = JOIN_CODE_FIXTURES[name].text;
		secretsInPlay.push(text);
		mount();
		emit([{rawValue: text, rawBytes: new Uint8Array(8), cornerPoints: [], format: 'qr-code'}]);
		const accept = props.onAccept as jest.Mock;
		expect(accept).toHaveBeenCalledTimes(1);
		expect(accept.mock.calls[0][0] === text).toBe(true);
		expect(cams()[0].props.isActive).toBe(false);
		emit([{rawValue: text}]);
		emit([{rawValue: text}, {rawValue: JOIN_CODE_FIXTURES['v2-2-members'].text}]);
		expect(accept).toHaveBeenCalledTimes(1);
	});

	it('accepts a frame of two join codes once, and a newer-version code too', () => {
		const newer = 'vtjoin9.' + sample.text.slice(8, 28);
		secretsInPlay.push(newer);
		mount();
		emit([{rawValue: newer}, {rawValue: sample.text}]);
		const accept = props.onAccept as jest.Mock;
		expect(accept).toHaveBeenCalledTimes(1);
		expect(accept.mock.calls[0][0] === newer).toBe(true);
	});

	it('calls the NEWEST onAccept from the first recorded callback (no stale closure)', async () => {
		const first = jest.fn();
		const second = jest.fn();
		mount({onAccept: first});
		const firstOptions = bs.__barcodeScannerOutputs()[0];
		await update({onAccept: second});
		renderer.act(() => {
			firstOptions.onBarcodeScanned([{rawValue: sample.text}]);
		});
		expect(second).toHaveBeenCalledTimes(1);
		expect(first).not.toHaveBeenCalled();
	});

	it('stays paused after an accepted read when the app returns to the foreground', async () => {
		const addSpy = jest.spyOn(AppState, 'addEventListener');
		mount();
		const change = addSpy.mock.calls.filter(c => c[0] === 'change').pop()?.[1] as (s: string) => void;
		emit([{rawValue: sample.text}]);
		renderer.act(() => change('active'));
		expect(cams()[0].props.isActive).toBe(false);
	});
});

describe('rejecting a read', () => {
	it('shows the banner, keeps the scanner open and the camera active', () => {
		secretsInPlay.push(POSTER);
		mount();
		emit([{rawValue: POSTER}]);
		expect(textIn('join-network-scan-banner')).toContain(t('scanNotJoinCode'));
		expect(byId('join-network-scan-banner').props.accessibilityRole).toBe('alert');
		expect(props.onAccept).not.toHaveBeenCalled();
		expect(props.onClose).not.toHaveBeenCalled();
		expect(cams()[0].props.isActive).toBe(true);
	});

	it('does not restart the banner for a read inside the ignore window, and clears it after the banner time', async () => {
		mount();
		emit([{rawValue: POSTER}]);
		await advance(1000);
		emit([{rawValue: POSTER}]);
		await advance(JOIN_SCAN_BANNER_MS - 1000 - 1);
		expect(hasId('join-network-scan-banner')).toBe(true);
		await advance(1);
		expect(hasId('join-network-scan-banner')).toBe(false);
	});

	it('restarts the banner for a read after the ignore window', async () => {
		mount();
		emit([{rawValue: POSTER}]);
		await advance(JOIN_SCAN_REJECT_IGNORE_MS);
		emit([{rawValue: POSTER}]);
		await advance(JOIN_SCAN_BANNER_MS - 1);
		expect(hasId('join-network-scan-banner')).toBe(true);
		await advance(1);
		expect(hasId('join-network-scan-banner')).toBe(false);
	});

	it('still accepts a join code that arrives inside the ignore window', async () => {
		mount();
		emit([{rawValue: POSTER}]);
		await advance(500);
		emit([{rawValue: sample.text}]);
		expect(props.onAccept).toHaveBeenCalledTimes(1);
	});

	it('counts a barcode with no rawValue as not a join code', () => {
		mount();
		emit([{rawBytes: new Uint8Array(4), format: 'qr-code'}]);
		expect(hasId('join-network-scan-banner')).toBe(true);
		expect(props.onAccept).not.toHaveBeenCalled();
	});
});

describe('permission', () => {
	it('requests once on the press when not determined, then mounts the camera', async () => {
		vc.__setCameraPermissionStatus('not-determined');
		vc.__setCameraPermissionRequestResult('authorized');
		mount({visible: false});
		expect(vc.__cameraPermissionRequestCount()).toBe(0);
		await update({visible: true});
		expect(vc.__cameraPermissionRequestCount()).toBe(1);
		expect(cams().length).toBe(1);
	});

	it('reports denied when the request is refused but still requestable', async () => {
		vc.__setCameraPermissionStatus('not-determined');
		vc.__setCameraPermissionRequestResult('not-determined');
		mount({visible: false});
		await update({visible: true});
		expect(state()).toContain('denied');
		expect(cams().length).toBe(0);
	});

	it('reports blocked when the request resolves denied', async () => {
		vc.__setCameraPermissionStatus('not-determined');
		vc.__setCameraPermissionRequestResult('denied');
		mount({visible: false});
		await update({visible: true});
		expect(state()).toContain('blocked');
		expect(cams().length).toBe(0);
	});

	it('reports failed when the request throws', async () => {
		vc.__setCameraPermissionStatus('not-determined');
		vc.__setCameraPermissionRequestResult(new Error(sample.text));
		secretsInPlay.push(sample.text);
		mount({visible: false});
		await update({visible: true});
		expect(state()).toContain('failed');
	});

	it.each(['denied', 'restricted'])('reports blocked without a request when the status is %s', async status => {
		vc.__setCameraPermissionStatus(status);
		mount({visible: false});
		await update({visible: true});
		expect(state().includes('blocked')).toBe(true);
		expect(vc.__cameraPermissionRequestCount()).toBe(0);
		expect(cams().length).toBe(0);
	});

	it('reports none after a grant when there is no back camera', async () => {
		vc.__setCameraPermissionStatus('not-determined');
		vc.__setCameraDevice(undefined);
		mount({visible: false});
		expect(state()).toEqual(['ready']);
		await update({visible: true});
		expect(state()).toContain('none');
		expect(cams().length).toBe(0);
	});
});

describe('errors', () => {
	it('closes into failed on a camera onError that carries the code', () => {
		secretsInPlay.push(sample.text);
		mount();
		renderer.act(() => {
			cams()[0].props.onError(new Error(sample.text));
		});
		expect(state()).toContain('failed');
	});

	it('closes into failed on a scanner output onError that carries the code', () => {
		mount();
		renderer.act(() => {
			bs.__emitBarcodeScannerError(Object.assign(new Error(sample.text), {code: 'x'}));
		});
		expect(state()).toContain('failed');
	});
});

describe('app state', () => {
	it('pauses the camera in the background and resumes in the foreground', () => {
		const addSpy = jest.spyOn(AppState, 'addEventListener');
		mount();
		const change = addSpy.mock.calls.filter(c => c[0] === 'change').pop()?.[1] as (s: string) => void;
		renderer.act(() => change('background'));
		expect(cams()[0].props.isActive).toBe(false);
		renderer.act(() => change('active'));
		expect(cams()[0].props.isActive).toBe(true);
	});
});

describe('controls and chrome', () => {
	it('close and Android back call onClose; paste instead calls onPasteInstead and reads no clipboard', () => {
		mount();
		const close = byId('join-network-scan-close');
		expect(close.props.accessibilityRole).toBe('button');
		expect(close.props.accessibilityLabel).toBe(t('scanClose'));
		renderer.act(() => close.props.onPress());
		expect(props.onClose).toHaveBeenCalledTimes(1);
		renderer.act(() => (tr as renderer.ReactTestRenderer).root.findByType(Modal).props.onRequestClose());
		expect(props.onClose).toHaveBeenCalledTimes(2);
		renderer.act(() => byId('join-network-scan-paste').props.onPress());
		expect(props.onPasteInstead).toHaveBeenCalledTimes(1);
		expect(byId('join-network-scan-paste').props.accessibilityRole).toBe('button');
	});

	it('is a full-screen portrait Modal', () => {
		mount();
		const modal = (tr as renderer.ReactTestRenderer).root.findByType(Modal);
		expect(modal.props.presentationStyle).toBe('fullScreen');
		expect(modal.props.statusBarTranslucent).toBe(true);
		expect(modal.props.supportedOrientations).toEqual(['portrait']);
	});

	it('a re-open starts a fresh session', async () => {
		mount();
		emit([{rawValue: POSTER}]);
		emit([{rawValue: sample.text}]);
		expect(props.onAccept).toHaveBeenCalledTimes(1);
		await update({visible: false});
		expect(cams().length).toBe(0);
		await update({visible: true});
		expect(hasId('join-network-scan-banner')).toBe(false);
		expect(cams().length).toBe(1);
		expect(cams()[0].props.isActive).toBe(true);
		expect(cams()[0].props.outputs[0].outputResolution).toBe('preview');
		emit([{rawValue: sample.text}]);
		expect(props.onAccept).toHaveBeenCalledTimes(2);
	});

	it('draws a square viewfinder of the shorter window side minus 64, with unclipped text', () => {
		mount();
		const {width, height} = Dimensions.get('window');
		const side = Math.min(width, height) - 64;
		const flat = (s: unknown) => Object.assign({}, ...([] as unknown[]).concat(s).flat(3).filter(Boolean));
		const style = flat(byId('join-network-scan-viewfinder').props.style);
		expect(style.width).toBe(side);
		expect(style.height).toBe(side);
		const texts = (tr as renderer.ReactTestRenderer).root.findAllByType(Text);
		expect(texts.length).toBeGreaterThan(0);
		expect(texts.every(n => n.props.numberOfLines === undefined)).toBe(true);
		const title = flat(byId('join-network-scan-title').props.style);
		expect(title.fontSize).toBe(20);
		expect(title.color).toBe('#FFFFFF');
	});

	it('clears its timers on unmount without logging an error', async () => {
		mount();
		emit([{rawValue: POSTER}]);
		renderer.act(() => {
			(tr as renderer.ReactTestRenderer).unmount();
		});
		await advance(JOIN_SCAN_BANNER_MS + JOIN_SCAN_SLOW_MS);
		tr = undefined;
	});
});
