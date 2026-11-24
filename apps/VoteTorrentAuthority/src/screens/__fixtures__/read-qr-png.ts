/**
 * read-qr-png.ts - JEST-ONLY. What a QR reader gets from a PNG the app draws: the PNG is decoded with
 * pngjs and read with jsQR (both Authority devDependencies). Returns null when nothing reads.
 * Pure: no React Native import.
 */

import jsQR from 'jsqr';
import { base64ToBytes } from '../../utils/qr/gray-png';

interface DecodedPng {
	width: number;
	height: number;
	data: Uint8Array;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PNG } = require('pngjs') as { PNG: { sync: { read(data: Uint8Array): DecodedPng } } };

export interface QrRead {
	/** The decoded text. */
	data: string;
	/** The raw bytes of the QR's data segments, for byte-for-byte comparisons. */
	bytes: number[];
	version: number;
}

export function readQrPngRaw(png: Uint8Array): QrRead | null {
	const img = PNG.sync.read(Buffer.from(png));
	const found = jsQR(new Uint8ClampedArray(img.data), img.width, img.height, { inversionAttempts: 'dontInvert' });
	return found === null ? null : { data: found.data, bytes: found.binaryData, version: found.version };
}

export function readQrPng(png: Uint8Array): string | null {
	return readQrPngRaw(png)?.data ?? null;
}

/** The same, from the base64 an Image `data:` uri carries. */
export function readQrPngBase64(base64: string): string | null {
	return readQrPng(base64ToBytes(base64));
}

/** Width and height of a PNG. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
	const img = PNG.sync.read(Buffer.from(png));
	return { width: img.width, height: img.height };
}
