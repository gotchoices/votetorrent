/**
 * qr-image-decode.test.ts - reading the QR codes in a picked photo or screenshot (the Voter's port
 * of the Authority's module).
 *
 * The native pieces are injected: a picker that returns a cache uri, a loader, a still-image scanner
 * and a file deleter. Each case checks one path, and that the picker's copy is deleted and the native
 * objects are disposed on every path. The availability check is read against stand-in native
 * registries, so a build without the picker or without the file module says not available. Text
 * comparisons are boolean, and no log line carries a value or a path.
 */
import {TurboModuleRegistry} from 'react-native';
import {NitroModules} from 'react-native-nitro-modules';
import {JOIN_CODE_FIXTURES} from '@votetorrent/vote-engine/test/fixtures/join-code-fixtures';
import {captureConsole, expectNoSecretInConsole} from '../__fixtures__/console-leak';
import {filePathFromUri, isQrImageDecodeAvailable, pickImageAndReadQrCodes, QR_IMAGE_MAX_SIDE_PX} from '../qr-image-decode';
import type {QrImageDecodeDeps} from '../qr-image-decode';

const CODE = JOIN_CODE_FIXTURES['v2-1-member'].text;
const URI = 'file:///data/user/0/app/cache/rn_image_picker_lib_temp_1.png';
const PATH = '/data/user/0/app/cache/rn_image_picker_lib_temp_1.png';

function fakeDevice(values: unknown[] = [CODE]) {
	const disposed = {image: 0, scanner: 0};
	const deleted: string[] = [];
	const loaded: string[] = [];
	const pickImage = jest.fn(async () => ({assets: [{uri: URI}]}));
	const deps: QrImageDecodeDeps = {
		isAvailable: () => true,
		pickImage,
		loadImage: async filePath => {
			loaded.push(filePath);
			return {dispose: () => void (disposed.image += 1)};
		},
		createScanner: options => {
			expect(options.barcodeFormats).toEqual(['qr-code']);
			return {
				scanCodesInImageAsync: async () => values.map(rawValue => ({rawValue})) as never,
				dispose: () => void (disposed.scanner += 1),
			};
		},
		deleteFile: async p => {
			deleted.push(p);
		},
	};
	return {deps, disposed, deleted, loaded, pickImage};
}

describe('pickImageAndReadQrCodes', () => {
	it('D1: a picked join code comes back exactly; the copy is loaded by path and then deleted; nothing secret is logged', async () => {
		const capture = captureConsole();
		try {
			const {deps, disposed, deleted, loaded} = fakeDevice();
			const result = await pickImageAndReadQrCodes(deps);
			expect(result.kind === 'decoded' && result.values.length === 1 && result.values[0] === CODE).toBe(true);
			expect(loaded).toEqual([PATH]);
			expect(deleted).toEqual([PATH]);
			expect(disposed).toEqual({image: 1, scanner: 1});
			expectNoSecretInConsole(capture, [CODE, PATH]);
		} finally {
			capture.restore();
		}
	});

	it('D2: an image with no QR code is no-code, and is still deleted', async () => {
		const {deps, deleted} = fakeDevice([]);
		expect(await pickImageAndReadQrCodes(deps)).toEqual({kind: 'no-code'});
		expect(deleted).toEqual([PATH]);
	});

	it('D3: not available on this build -> unavailable, and the picker is never opened', async () => {
		const {deps, pickImage} = fakeDevice();
		expect(await pickImageAndReadQrCodes({...deps, isAvailable: () => false})).toEqual({kind: 'unavailable'});
		expect(pickImage).not.toHaveBeenCalled();
	});

	it('D4: a cancelled pick (or an empty selection) is cancelled, with nothing loaded or deleted', async () => {
		const {deps, loaded, deleted} = fakeDevice();
		expect(await pickImageAndReadQrCodes({...deps, pickImage: async () => ({didCancel: true})})).toEqual({kind: 'cancelled'});
		expect(await pickImageAndReadQrCodes({...deps, pickImage: async () => ({assets: []})})).toEqual({kind: 'cancelled'});
		expect(loaded).toEqual([]);
		expect(deleted).toEqual([]);
	});

	it('D5: a picker error code or a picker that throws is unreadable', async () => {
		const {deps} = fakeDevice();
		expect(await pickImageAndReadQrCodes({...deps, pickImage: async () => ({errorCode: 'others'})})).toEqual({kind: 'unreadable'});
		expect(await pickImageAndReadQrCodes({...deps, pickImage: async () => Promise.reject(new Error('x'))})).toEqual({kind: 'unreadable'});
	});

	it('D6: an image that will not load is unreadable, and the copy is still deleted', async () => {
		const {deps, deleted} = fakeDevice();
		const result = await pickImageAndReadQrCodes({...deps, loadImage: async () => Promise.reject(new Error('bad'))});
		expect(result).toEqual({kind: 'unreadable'});
		expect(deleted).toEqual([PATH]);
	});

	it('D7: a scanner failure is unreadable; the image and scanner are disposed and the copy deleted', async () => {
		const {deps, disposed, deleted} = fakeDevice();
		const result = await pickImageAndReadQrCodes({
			...deps,
			createScanner: () => ({
				scanCodesInImageAsync: async () => Promise.reject(new Error('mlkit')),
				dispose: () => void (disposed.scanner += 1),
			}),
		});
		expect(result).toEqual({kind: 'unreadable'});
		expect(disposed).toEqual({image: 1, scanner: 1});
		expect(deleted).toEqual([PATH]);
	});

	it('D8: a failed delete does not change the result', async () => {
		const {deps} = fakeDevice();
		const result = await pickImageAndReadQrCodes({...deps, deleteFile: async () => Promise.reject(new Error('fs'))});
		expect(result.kind === 'decoded' && result.values[0] === CODE).toBe(true);
	});

	it('D9: several codes in one image all come back, empty values dropped', async () => {
		const {deps} = fakeDevice(['a', '', undefined, 'b']);
		expect(await pickImageAndReadQrCodes(deps)).toEqual({kind: 'decoded', values: ['a', 'b']});
	});

	it('D10: log lines are a closed [join] tag and token only', async () => {
		const capture = captureConsole();
		try {
			const {deps} = fakeDevice();
			await pickImageAndReadQrCodes({...deps, loadImage: async () => Promise.reject(new Error(PATH))});
			expect(capture.calls().map(c => c.join(' '))).toEqual(['[join] image: load-failed']);
		} finally {
			capture.restore();
		}
	});
});

describe('availability and helpers', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('A1: under jest (no ImagePicker native module) the default check says not available, and the default pick returns unavailable', async () => {
		expect(isQrImageDecodeAvailable()).toBe(false);
		expect(await pickImageAndReadQrCodes()).toEqual({kind: 'unavailable'});
	});

	it('A2: available only with the picker, the file module, the image loader and the QR scanner all in the build', () => {
		const modules = new Set<string>();
		jest.spyOn(TurboModuleRegistry, 'get').mockImplementation(((name: string) => (modules.has(name) ? {} : null)) as never);
		jest.spyOn(NitroModules, 'hasHybridObject').mockImplementation((name: string) => name === 'ImageFactory' || name === 'BarcodeScannerFactory');
		expect(isQrImageDecodeAvailable()).toBe(false);
		modules.add('ImagePicker');
		// An older build without the file module would leave the picked copy behind: not available.
		expect(isQrImageDecodeAvailable()).toBe(false);
		modules.add('ReactNativeFs');
		expect(isQrImageDecodeAvailable()).toBe(true);
		jest.spyOn(NitroModules, 'hasHybridObject').mockReturnValue(false);
		expect(isQrImageDecodeAvailable()).toBe(false);
	});

	it('A3: filePathFromUri strips file:// and decodes; other uris pass through', () => {
		expect(filePathFromUri(URI)).toBe(PATH);
		expect(filePathFromUri('file:///a%20b.png')).toBe('/a b.png');
		expect(filePathFromUri('content://x/y')).toBe('content://x/y');
	});

	it('A4: the picker copy is bounded', () => {
		expect(QR_IMAGE_MAX_SIDE_PX).toBe(2048);
	});
});
