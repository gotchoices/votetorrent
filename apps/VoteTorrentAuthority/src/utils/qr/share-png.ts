/**
 * share-png.ts - Phase 64 Plan 10 (D-04, D-29, Addendum A5). The shareable PNG for the join code:
 * 1080 x 1240, 8-bit grayscale, no alpha. Rows 0..1079 carry the QR (largest whole-pixel module
 * size that keeps a 4-module quiet zone, centred); rows 1080..1239 carry the fingerprint band drawn
 * from the embedded 17-glyph atlas. Nothing else can reach the image: the only inputs are the code
 * and the fingerprint.
 *
 * The join code is a bearer credential (D-06): no logging here, fixed error text, no retained text.
 */

import { unzlibSync } from 'fflate';
import { FINGERPRINT_ATLAS } from './fingerprint-atlas.generated';
import { base64ToBytes, encodeGray8Png } from './gray-png';
import { drawQrModules } from './qr-panel';
import { qrLayout } from './qr-layout';
import { buildQrMatrix } from './qr-matrix';

export const SHARE_PNG_WIDTH = 1080;
export const SHARE_PNG_HEIGHT = 1240;
export const FINGERPRINT_BAND_PX = 160;
export const SHARE_QR_BLOCK_PX = 1080;

export type FingerprintGlyphErrorCode = 'not-string' | 'outside-atlas' | 'too-long' | 'no-ink';

const MESSAGES: Record<FingerprintGlyphErrorCode, string> = {
	'not-string': 'fingerprint: not a string',
	'outside-atlas': 'fingerprint: character outside the glyph atlas',
	'too-long': 'fingerprint: too long for the band',
	'no-ink': 'fingerprint: nothing to draw',
};

export class FingerprintGlyphError extends Error {
	readonly code: FingerprintGlyphErrorCode;
	constructor(code: FingerprintGlyphErrorCode) {
		super(MESSAGES[code]);
		this.name = 'FingerprintGlyphError';
		this.code = code;
	}
}

let atlasStrip: Uint8Array | undefined;

function strip(): Uint8Array {
	if (!atlasStrip) {
		const decoded = unzlibSync(base64ToBytes(FINGERPRINT_ATLAS.stripZlibBase64));
		if (decoded.length !== FINGERPRINT_ATLAS.cellWidth * FINGERPRINT_ATLAS.glyphs.length * FINGERPRINT_ATLAS.cellHeight) {
			throw new Error('fingerprint atlas: corrupt');
		}
		atlasStrip = decoded;
	}
	return atlasStrip;
}

function validateFingerprint(fingerprint: string): number[] {
	if (typeof fingerprint !== 'string') throw new FingerprintGlyphError('not-string');
	const indices: number[] = [];
	for (let i = 0; i < fingerprint.length; i++) {
		const g = FINGERPRINT_ATLAS.glyphs.indexOf(fingerprint.charAt(i));
		if (g < 0) throw new FingerprintGlyphError('outside-atlas');
		indices.push(g);
	}
	if (indices.length > Math.floor(SHARE_PNG_WIDTH / FINGERPRINT_ATLAS.cellWidth)) {
		throw new FingerprintGlyphError('too-long');
	}
	if (!indices.some((g) => FINGERPRINT_ATLAS.ink[g] !== null)) throw new FingerprintGlyphError('no-ink');
	return indices;
}

export function buildShareQrPng(text: string, fingerprint: string): Uint8Array {
	const glyphs = validateFingerprint(fingerprint);
	const matrix = buildQrMatrix(text);
	const { m } = qrLayout(matrix.n, SHARE_QR_BLOCK_PX);
	const off = Math.floor((SHARE_QR_BLOCK_PX - m * matrix.n) / 2);

	const canvas = new Uint8Array(SHARE_PNG_WIDTH * SHARE_PNG_HEIGHT).fill(0xff);
	drawQrModules(canvas, SHARE_PNG_WIDTH, matrix, m, off, off);

	const { cellWidth, cellHeight, ink } = FINGERPRINT_ATLAS;
	const stripW = cellWidth * FINGERPRINT_ATLAS.glyphs.length;
	const atlas = strip();

	// centre the INK box of the whole string, not its cells
	let minX = SHARE_PNG_WIDTH;
	let maxX = -1;
	let minY = cellHeight;
	let maxY = -1;
	glyphs.forEach((g, i) => {
		const box = ink[g];
		if (!box) return;
		minX = Math.min(minX, i * cellWidth + box[0]);
		maxX = Math.max(maxX, i * cellWidth + box[2]);
		minY = Math.min(minY, box[1]);
		maxY = Math.max(maxY, box[3]);
	});
	const x0 = Math.floor((SHARE_PNG_WIDTH - (maxX - minX + 1)) / 2) - minX;
	const y0 = SHARE_QR_BLOCK_PX + Math.floor((FINGERPRINT_BAND_PX - (maxY - minY + 1)) / 2) - minY;

	glyphs.forEach((g, i) => {
		if (!ink[g]) return;
		for (let cy = 0; cy < cellHeight; cy++) {
			for (let cx = 0; cx < cellWidth; cx++) {
				const v = atlas[cy * stripW + g * cellWidth + cx];
				if (v !== 0xff) canvas[(y0 + cy) * SHARE_PNG_WIDTH + x0 + i * cellWidth + cx] = v;
			}
		}
	});

	return encodeGray8Png(SHARE_PNG_WIDTH, SHARE_PNG_HEIGHT, canvas);
}
