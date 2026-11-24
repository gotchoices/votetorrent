/**
 * qr-image-decode.ts - read the QR codes in a photo or screenshot the user picks from the gallery.
 *
 * Three native pieces, all lazily required so that jest and any build without them never load a
 * native module at import time (the same rule as pick-founding-bundle-file.ts and device-signer.ts):
 *  - react-native-image-picker opens the system photo picker (PHPicker on iOS, the Android photo
 *    picker). Neither asks for a photo-library permission: the user picks one image and the app
 *    gets a copy of that image only, in its own cache.
 *  - react-native-nitro-image loads the copied file into a native image (it is already in the app
 *    for VisionCamera 5).
 *  - react-native-vision-camera-barcode-scanner reads QR codes in that still image with ML Kit
 *    (`scanCodesInImageAsync`), the same scanner the camera uses.
 *
 * `isQrImageDecodeAvailable()` reports whether all three are in this build. A build made before the
 * image picker was added has no `ImagePicker` native module; the screen then shows "not available on
 * this build" instead of offering a button that would crash.
 *
 * The picked image may be a picture of an invitation, which holds a private key. So the copy in the
 * cache is deleted as soon as it is read, nothing here logs a uri, a file name or a decoded value,
 * and the only log lines are closed tokens. `pickImageAndReadQrCodes` never rejects.
 */

import type { Barcode, BarcodeScanner, BarcodeScannerOptions } from 'react-native-vision-camera-barcode-scanner';

export type QrImageReadResult =
	| { readonly kind: 'decoded'; readonly values: readonly string[] }
	| { readonly kind: 'no-code' }
	| { readonly kind: 'cancelled' }
	| { readonly kind: 'unavailable' }
	| { readonly kind: 'unreadable' };

/** The picked image as the picker reports it (only what this module reads). */
interface PickerAsset {
	uri?: string;
}
interface PickerResponse {
	didCancel?: boolean;
	errorCode?: string;
	assets?: PickerAsset[];
}

/** A loaded native image (react-native-nitro-image `Image`): only `dispose` is called here. */
interface LoadedImage {
	dispose(): void;
}

/** The still-image half of the ML Kit scanner (`BarcodeScanner`) that this module calls. */
export interface StillImageQrScanner {
	scanCodesInImageAsync(image: LoadedImage): Promise<Barcode[]>;
	dispose(): void;
}

export interface QrImageDecodeDeps {
	isAvailable?: () => boolean;
	pickImage?: () => Promise<PickerResponse>;
	loadImage?: (filePath: string) => Promise<LoadedImage>;
	createScanner?: (options: BarcodeScannerOptions) => StillImageQrScanner;
	deleteFile?: (filePath: string) => Promise<unknown>;
}

/**
 * Largest side, in pixels, of the copy the picker hands back. A QR that fills even a quarter of a
 * 2048 px picture still has several pixels per module, and the bound keeps a 48 MP photo from being
 * decoded at full size on a low-memory phone.
 */
export const QR_IMAGE_MAX_SIDE_PX = 2048;

function logToken(token: string): void {
	// eslint-disable-next-line no-console -- closed token only, never a uri, file name or decoded value.
	console.info(`[invite] image: ${token}`);
}

/** Strip a file:// prefix (the picker returns file URLs; the image loader and fs want paths). */
export function filePathFromUri(uri: string): string {
	if (!uri.startsWith('file://')) return uri;
	const rest = uri.slice('file://'.length);
	try {
		return decodeURIComponent(rest);
	} catch {
		return rest;
	}
}

function defaultIsAvailable(): boolean {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires -- lazy, see the module comment.
		const RN = require('react-native') as {
			TurboModuleRegistry?: { get?: (name: string) => unknown };
			NativeModules?: Record<string, unknown>;
		};
		const picker = RN.TurboModuleRegistry?.get?.('ImagePicker') ?? RN.NativeModules?.ImagePicker;
		if (picker === undefined || picker === null) return false;
		// eslint-disable-next-line @typescript-eslint/no-var-requires -- lazy, see the module comment.
		const { NitroModules } = require('react-native-nitro-modules') as { NitroModules: { hasHybridObject(name: string): boolean } };
		return NitroModules.hasHybridObject('ImageFactory') && NitroModules.hasHybridObject('BarcodeScannerFactory');
	} catch {
		return false;
	}
}

function defaultPickImage(): Promise<PickerResponse> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires -- lazy, see the module comment.
	const { launchImageLibrary } = require('react-native-image-picker') as {
		launchImageLibrary: (options: Record<string, unknown>) => Promise<PickerResponse>;
	};
	return launchImageLibrary({
		mediaType: 'photo',
		selectionLimit: 1,
		includeBase64: false,
		includeExtra: false,
		maxWidth: QR_IMAGE_MAX_SIDE_PX,
		maxHeight: QR_IMAGE_MAX_SIDE_PX,
		quality: 1,
	});
}

async function defaultLoadImage(filePath: string): Promise<LoadedImage> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires -- lazy, see the module comment.
	const { loadImage } = require('react-native-nitro-image') as { loadImage: (source: { filePath: string }) => Promise<LoadedImage> | LoadedImage };
	return await loadImage({ filePath });
}

function defaultCreateScanner(options: BarcodeScannerOptions): StillImageQrScanner {
	// eslint-disable-next-line @typescript-eslint/no-var-requires -- lazy, see the module comment.
	const { createBarcodeScanner } = require('react-native-vision-camera-barcode-scanner') as {
		createBarcodeScanner: (o: BarcodeScannerOptions) => BarcodeScanner;
	};
	return createBarcodeScanner(options) as unknown as StillImageQrScanner;
}

async function defaultDeleteFile(filePath: string): Promise<unknown> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires -- lazy, see the module comment.
	const fs = require('@dr.pogodin/react-native-fs') as { exists(p: string): Promise<boolean>; unlink(p: string): Promise<void> };
	if (await fs.exists(filePath)) await fs.unlink(filePath);
	return undefined;
}

/** True when this build has the photo picker, the image loader and the still-image QR scanner. */
export function isQrImageDecodeAvailable(deps?: Pick<QrImageDecodeDeps, 'isAvailable'>): boolean {
	return (deps?.isAvailable ?? defaultIsAvailable)();
}

/**
 * Open the photo picker, read every QR code in the chosen image, delete the picker's copy, and
 * return the decoded strings. Never rejects: every failure is a typed result.
 */
export async function pickImageAndReadQrCodes(deps?: QrImageDecodeDeps): Promise<QrImageReadResult> {
	if (!isQrImageDecodeAvailable(deps)) {
		logToken('unavailable');
		return { kind: 'unavailable' };
	}
	const pickImage = deps?.pickImage ?? defaultPickImage;
	const loadImage = deps?.loadImage ?? defaultLoadImage;
	const createScanner = deps?.createScanner ?? defaultCreateScanner;
	const deleteFile = deps?.deleteFile ?? defaultDeleteFile;

	let response: PickerResponse;
	try {
		response = await pickImage();
	} catch {
		logToken('picker-failed');
		return { kind: 'unreadable' };
	}
	if (response?.didCancel) return { kind: 'cancelled' };
	if (response?.errorCode !== undefined) {
		logToken('picker-failed');
		return { kind: 'unreadable' };
	}
	const uri = response?.assets?.[0]?.uri;
	if (typeof uri !== 'string' || uri.length === 0) {
		// Some pickers report a dismissal as an empty selection.
		return { kind: 'cancelled' };
	}
	const filePath = filePathFromUri(uri);

	let image: LoadedImage | undefined;
	let scanner: StillImageQrScanner | undefined;
	try {
		try {
			image = await loadImage(filePath);
		} catch {
			logToken('load-failed');
			return { kind: 'unreadable' };
		}
		let barcodes: Barcode[];
		try {
			scanner = createScanner({ barcodeFormats: ['qr-code'] });
			barcodes = await scanner.scanCodesInImageAsync(image);
		} catch {
			logToken('scan-failed');
			return { kind: 'unreadable' };
		}
		const values = (Array.isArray(barcodes) ? barcodes : [])
			.map((b) => b?.rawValue)
			.filter((v): v is string => typeof v === 'string' && v.length > 0);
		return values.length === 0 ? { kind: 'no-code' } : { kind: 'decoded', values };
	} finally {
		try {
			image?.dispose();
		} catch {
			// best effort
		}
		try {
			scanner?.dispose();
		} catch {
			// best effort
		}
		try {
			await deleteFile(filePath);
		} catch {
			logToken('delete-failed');
		}
	}
}
