/**
 * qr-image-decode.test.ts - reading the QR codes in a picked photo or screenshot.
 *
 * The native pieces are injected. The end-to-end case stands in for the device with real bytes: the
 * "picked" file is the PNG that Share QR image sends, the loader decodes it with pngjs and the
 * scanner reads it with jsQR, so the invitation the sender shared is what comes back. Every other
 * case checks one failure path, and that the picker's copy is deleted and the native objects are
 * disposed on every path. Text comparisons are boolean.
 */
import jsQR from 'jsqr';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { captureConsole, expectNoSecretInConsole } from '../__fixtures__/console-leak';
import { serializeInviteShare } from '../../screens/invitations/invite-share';
import { buildInviteSharePng } from '../../utils/qr/invite-qr';
import { encodeGray8Png } from '../../utils/qr/gray-png';
import {
	filePathFromUri,
	isQrImageDecodeAvailable,
	pickImageAndReadQrCodes,
	QR_IMAGE_MAX_SIDE_PX,
	type QrImageDecodeDeps,
} from '../qr-image-decode';

interface DecodedPng {
	width: number;
	height: number;
	data: Uint8Array;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PNG } = require('pngjs') as { PNG: { sync: { read(data: Uint8Array): DecodedPng } } };

function invitation(): string {
	const priv = secp256k1.utils.randomSecretKey();
	return serializeInviteShare({
		invitePrivate: bytesToHex(priv),
		inviteKey: bytesToHex(secp256k1.getPublicKey(priv)),
		expiration: '2026-11-25T09:30:00.000Z',
		type: 'k',
		name: 'Kay Holder',
	});
}

const URI = 'file:///data/user/0/app/cache/rn_image_picker_lib_temp_1.png';
const PATH = '/data/user/0/app/cache/rn_image_picker_lib_temp_1.png';

/** Deps whose picker returns URI, whose "files" are PNG bytes, and whose scanner is jsQR. */
function fakeDevice(files: Record<string, Uint8Array>) {
	const disposed = { image: 0, scanner: 0 };
	const deleted: string[] = [];
	const pickImage = jest.fn(async () => ({ assets: [{ uri: URI }] }));
	const deps: QrImageDecodeDeps = {
		isAvailable: () => true,
		pickImage,
		loadImage: async (filePath) => {
			const bytes = files[filePath];
			if (!bytes) throw new Error('no such file');
			const img = PNG.sync.read(Buffer.from(bytes));
			return Object.assign(img, { dispose: () => void (disposed.image += 1) });
		},
		createScanner: (options) => {
			expect(options.barcodeFormats).toEqual(['qr-code']);
			return {
				scanCodesInImageAsync: async (image) => {
					const img = image as unknown as DecodedPng;
					const found = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
					return found ? ([{ rawValue: found.data }] as never) : [];
				},
				dispose: () => void (disposed.scanner += 1),
			};
		},
		deleteFile: async (p) => {
			deleted.push(p);
		},
	};
	return { deps, disposed, deleted, pickImage };
}

describe('pickImageAndReadQrCodes', () => {
	it('D1: the PNG that Share QR image sends decodes back to the exact invitation; the copy is deleted', async () => {
		const text = invitation();
		const { deps, disposed, deleted } = fakeDevice({ [PATH]: buildInviteSharePng(text) });
		const capture = captureConsole();
		try {
			const result = await pickImageAndReadQrCodes(deps);
			expect(result.kind).toBe('decoded');
			expect(result.kind === 'decoded' && result.values.length === 1 && result.values[0] === text).toBe(true);
			expect(deleted).toEqual([PATH]);
			expect(disposed).toEqual({ image: 1, scanner: 1 });
			expectNoSecretInConsole(capture, [text]);
		} finally {
			capture.restore();
		}
	});

	it('D2: an image with no QR code is no-code, and is still deleted', async () => {
		const blank = encodeGray8Png(64, 64, new Uint8Array(64 * 64).fill(0xff));
		const { deps, deleted } = fakeDevice({ [PATH]: blank });
		expect(await pickImageAndReadQrCodes(deps)).toEqual({ kind: 'no-code' });
		expect(deleted).toEqual([PATH]);
	});

	it('D3: not available on this build -> unavailable, and the picker is never opened', async () => {
		const { deps, pickImage } = fakeDevice({});
		const result = await pickImageAndReadQrCodes({ ...deps, isAvailable: () => false });
		expect(result).toEqual({ kind: 'unavailable' });
		expect(pickImage).not.toHaveBeenCalled();
	});

	it('D4: a cancelled pick is cancelled, with nothing loaded or deleted', async () => {
		const { deps, deleted, disposed } = fakeDevice({});
		expect(await pickImageAndReadQrCodes({ ...deps, pickImage: async () => ({ didCancel: true }) })).toEqual({ kind: 'cancelled' });
		expect(await pickImageAndReadQrCodes({ ...deps, pickImage: async () => ({ assets: [] }) })).toEqual({ kind: 'cancelled' });
		expect(deleted).toEqual([]);
		expect(disposed).toEqual({ image: 0, scanner: 0 });
	});

	it('D5: a picker error code or a picker that throws is unreadable', async () => {
		const { deps } = fakeDevice({});
		expect(await pickImageAndReadQrCodes({ ...deps, pickImage: async () => ({ errorCode: 'others' }) })).toEqual({ kind: 'unreadable' });
		expect(await pickImageAndReadQrCodes({ ...deps, pickImage: async () => Promise.reject(new Error('native')) })).toEqual({
			kind: 'unreadable',
		});
	});

	it('D6: an image that will not load is unreadable, and the copy is still deleted', async () => {
		const { deps, deleted } = fakeDevice({});
		expect(await pickImageAndReadQrCodes(deps)).toEqual({ kind: 'unreadable' });
		expect(deleted).toEqual([PATH]);
	});

	it('D7: a scanner failure is unreadable; the image and scanner are disposed and the copy deleted', async () => {
		const text = invitation();
		const { deps, disposed, deleted } = fakeDevice({ [PATH]: buildInviteSharePng(text) });
		const result = await pickImageAndReadQrCodes({
			...deps,
			createScanner: () => ({
				scanCodesInImageAsync: async () => Promise.reject(new Error('mlkit')),
				dispose: () => void (disposed.scanner += 1),
			}),
		});
		expect(result).toEqual({ kind: 'unreadable' });
		expect(disposed).toEqual({ image: 1, scanner: 1 });
		expect(deleted).toEqual([PATH]);
	});

	it('D8: a failed delete does not change the result', async () => {
		const text = invitation();
		const { deps } = fakeDevice({ [PATH]: buildInviteSharePng(text) });
		const result = await pickImageAndReadQrCodes({ ...deps, deleteFile: async () => Promise.reject(new Error('fs')) });
		expect(result.kind === 'decoded' && result.values[0] === text).toBe(true);
	});

	it('D9: several codes in one image all come back, empty values dropped', async () => {
		const { deps } = fakeDevice({ [PATH]: buildInviteSharePng(invitation()) });
		const result = await pickImageAndReadQrCodes({
			...deps,
			createScanner: () => ({
				scanCodesInImageAsync: async () => [{ rawValue: 'a' }, { rawValue: '' }, { rawValue: undefined }, { rawValue: 'b' }] as never,
				dispose: () => undefined,
			}),
		});
		expect(result).toEqual({ kind: 'decoded', values: ['a', 'b'] });
	});
});

describe('availability and helpers', () => {
	it('A1: under jest (no ImagePicker native module) the default check says not available, and the default pick returns unavailable', async () => {
		expect(isQrImageDecodeAvailable()).toBe(false);
		expect(await pickImageAndReadQrCodes()).toEqual({ kind: 'unavailable' });
	});

	it('A2: filePathFromUri strips file:// and decodes; other uris pass through', () => {
		expect(filePathFromUri(URI)).toBe(PATH);
		expect(filePathFromUri('file:///tmp/a%20b.jpg')).toBe('/tmp/a b.jpg');
		expect(filePathFromUri('/tmp/x.png')).toBe('/tmp/x.png');
	});

	it('A3: the picker copy is bounded', () => {
		expect(QR_IMAGE_MAX_SIDE_PX).toBe(2048);
	});
});
