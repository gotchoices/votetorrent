/**
 * @format
 *
 * Contract test for the four Voter native-module jest mocks (VisionCamera 5 stack, D-05). These
 * are the seams the scanner plans (64-17, 64-18) build on, so this file pins them. The `__`
 * controls are reached only through `require()` of the mock FILE, cast to a local interface:
 * the real packages' `.d.ts` files do not declare them.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

interface CameraMock {
	Camera: React.ComponentType<Record<string, unknown>>;
	useCameraDevice: (position: string) => {id: string; position: string} | undefined;
	useCameraPermission: () => {
		status: string;
		hasPermission: boolean;
		canRequestPermission: boolean;
		requestPermission: () => Promise<boolean>;
	};
	useMicrophonePermission: () => {requestPermission: () => Promise<boolean>};
	__setCameraDevice: (d: unknown) => void;
	__setCameraPermissionStatus: (s: string) => void;
	__setCameraPermissionRequestResult: (s: string | Error) => void;
	__cameraPermissionRequestCount: () => number;
	__resetVisionCameraMock: () => void;
}

interface ScannerMock {
	useBarcodeScannerOutput: (opts: Record<string, unknown>) => Record<string, unknown>;
	CodeScanner: React.ComponentType<Record<string, unknown>>;
	useBarcodeScanner: () => unknown;
	__emitBarcodes: (b: unknown[]) => void;
	__emitBarcodeScannerError: (e: unknown) => void;
	__barcodeScannerOutputs: () => Array<Record<string, unknown>>;
	__resetBarcodeScannerMock: () => void;
}

interface NitroModulesMock {
	NitroModules: {
		createHybridObject: (n: string) => unknown;
		hasHybridObject: (n: string) => boolean;
		getHybridObjectConstructor: (n: string) => unknown;
	};
}

interface NitroImageMock {
	NitroImage: unknown;
	useImage: () => {image: unknown; error: unknown};
	loadImage: () => Promise<unknown>;
}

/* eslint-disable @typescript-eslint/no-require-imports */
const cameraMock: CameraMock = require('../__mocks__/react-native-vision-camera.js');
const scannerMock: ScannerMock = require('../__mocks__/react-native-vision-camera-barcode-scanner.js');
const nitroModulesMock: NitroModulesMock = require('../__mocks__/react-native-nitro-modules.js');
const nitroImageMock: NitroImageMock = require('../__mocks__/react-native-nitro-image.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
const consoleSpies = CONSOLE_METHODS.map(m => jest.spyOn(console, m).mockImplementation(() => {}));

beforeEach(() => {
	cameraMock.__resetVisionCameraMock();
	scannerMock.__resetBarcodeScannerMock();
});

afterAll(() => {
	consoleSpies.forEach(s => s.mockRestore());
});

describe('jest loads the Voter native-module mocks', () => {
	test.each([
		'react-native-vision-camera',
		'react-native-vision-camera-barcode-scanner',
		'react-native-nitro-modules',
		'react-native-nitro-image',
	])('require(%s) is the __mocks__ stand-in', name => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const loaded = require(name);
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const mock = require(`../__mocks__/${name}.js`);
		expect(loaded).toBe(mock);
	});
});

interface ProbeState {
	status: string;
	device: unknown;
	request: () => Promise<boolean>;
	received: unknown[][];
}

function renderProbe(state: ProbeState) {
	function Probe() {
		const permission = cameraMock.useCameraPermission();
		const device = cameraMock.useCameraDevice('back');
		const output = scannerMock.useBarcodeScannerOutput({
			barcodeFormats: ['qr-code'],
			onBarcodeScanned: (barcodes: unknown[]) => {
				state.received.push(barcodes);
			},
			onError: () => {},
		});
		state.status = permission.status;
		state.device = device;
		state.request = permission.requestPermission;
		return React.createElement(cameraMock.Camera, {outputs: [output], isActive: true, device});
	}
	let tr!: ReactTestRenderer.ReactTestRenderer;
	ReactTestRenderer.act(() => {
		tr = ReactTestRenderer.create(React.createElement(Probe));
	});
	return tr;
}

describe('camera and scanner mock seams', () => {
	test('Camera renders one host node carrying the scanner output; permission flow is driveable', async () => {
		cameraMock.__setCameraPermissionStatus('not-determined');
		cameraMock.__setCameraPermissionRequestResult('authorized');
		const state: ProbeState = {status: '', device: undefined, request: async () => false, received: []};
		const tr = renderProbe(state);
		const nodes = tr.root.findAll(n => (n.type as unknown) === 'VisionCameraMock');
		expect(nodes).toHaveLength(1);
		const outputs = nodes[0].props.outputs as Array<{outputResolution: string}>;
		expect(outputs[0].outputResolution).toBe('preview');
		expect(state.status).toBe('not-determined');

		let granted: boolean | undefined;
		await ReactTestRenderer.act(async () => {
			granted = await state.request();
		});
		expect(granted).toBe(true);
		expect(state.status).toBe('authorized');
		expect(cameraMock.__cameraPermissionRequestCount()).toBe(1);
		ReactTestRenderer.act(() => {
			tr.unmount();
		});
	});

	test('emit seam, device control, CodeScanner and microphone refusals', async () => {
		const state: ProbeState = {status: '', device: undefined, request: async () => false, received: []};
		const tr = renderProbe(state);
		ReactTestRenderer.act(() => {
			scannerMock.__emitBarcodes([{rawValue: 'x'}]);
		});
		expect(state.received).toHaveLength(1);

		expect((state.device as {id: string}).id).toBe('mock-back-camera');
		ReactTestRenderer.act(() => {
			cameraMock.__setCameraDevice(undefined);
		});
		expect(cameraMock.useCameraDevice('back')).toBeUndefined();
		ReactTestRenderer.act(() => {
			tr.unmount();
		});

		expect(() => scannerMock.useBarcodeScanner()).toThrow(/CodeScanner is not used by VoteTorrent/);
		expect(() => React.createElement(scannerMock.CodeScanner, {})).not.toThrow();
		expect(() =>
			ReactTestRenderer.act(() => {
				ReactTestRenderer.create(React.createElement(scannerMock.CodeScanner, {}));
			}),
		).toThrow(/CodeScanner is not used by VoteTorrent/);

		await expect(cameraMock.useMicrophonePermission().requestPermission()).rejects.toThrow(
			/microphone permission must never be requested/,
		);
	});

	test('nitro modules are native-only and nitro-image is inert; nothing logged', async () => {
		expect(() => nitroModulesMock.NitroModules.createHybridObject('X')).toThrow(
			/native-only and unavailable under jest/,
		);
		expect(nitroModulesMock.NitroModules.hasHybridObject('X')).toBe(false);
		expect(() => nitroModulesMock.NitroModules.getHybridObjectConstructor('X')).toThrow(
			/native-only and unavailable under jest/,
		);
		expect(nitroImageMock.useImage()).toEqual({image: undefined, error: undefined});
		await expect(nitroImageMock.loadImage()).rejects.toBeInstanceOf(Error);
		consoleSpies.forEach(s => expect(s).not.toHaveBeenCalled());
	});
});
