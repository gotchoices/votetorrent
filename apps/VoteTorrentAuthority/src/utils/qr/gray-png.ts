/**
 * gray-png.ts - Phase 64 Plan 10 (D-03, D-04, notes 4.8). A small, Hermes-safe 8-bit grayscale PNG
 * writer plus strict standard base64 in both directions.
 *
 * Hermes has no Buffer, TextEncoder, atob or btoa, so everything here is typed-array and index
 * arithmetic. Compression is fflate's pure-JS zlibSync. The output is signature + IHDR (depth 8,
 * colour type 0, no interlace) + ONE IDAT + IEND, with a CRC-32 on each chunk and no ancillary
 * chunks (no tRNS, gAMA, iCCP or tEXt), so there is no alpha channel and no embedded metadata.
 */

import { zlibSync } from 'fflate';

const MAX_SIDE = 16384;

let crcTable: Uint32Array | undefined;

function crc32(chunk: Uint8Array): number {
	if (!crcTable) {
		const t = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			t[n] = c >>> 0;
		}
		crcTable = t;
	}
	let crc = 0xffffffff;
	for (let i = 0; i < chunk.length; i++) crc = crcTable[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function writeChunk(out: Uint8Array, offset: number, type: string, data: Uint8Array): number {
	const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
	view.setUint32(offset, data.length);
	const body = out.subarray(offset + 4, offset + 8 + data.length);
	for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
	body.set(data, 4);
	view.setUint32(offset + 8 + data.length, crc32(body));
	return offset + 12 + data.length;
}

function validSide(v: number): boolean {
	return Number.isInteger(v) && v >= 1 && v <= MAX_SIDE;
}

export function encodeGray8Png(width: number, height: number, pixels: Uint8Array): Uint8Array {
	if (!validSide(width) || !validSide(height) || !pixels || pixels.length !== width * height) {
		throw new RangeError('gray-png: invalid image');
	}
	const raw = new Uint8Array((width + 1) * height);
	for (let y = 0; y < height; y++) {
		raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
	}
	const idat = zlibSync(raw, { level: 6 });

	const ihdr = new Uint8Array(13);
	const hv = new DataView(ihdr.buffer);
	hv.setUint32(0, width);
	hv.setUint32(4, height);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 0; // colour type: grayscale
	ihdr[10] = 0; // compression
	ihdr[11] = 0; // filter
	ihdr[12] = 0; // no interlace

	const out = new Uint8Array(8 + (12 + 13) + (12 + idat.length) + 12);
	out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	let o = 8;
	o = writeChunk(out, o, 'IHDR', ihdr);
	o = writeChunk(out, o, 'IDAT', idat);
	writeChunk(out, o, 'IEND', new Uint8Array(0));
	return out;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
	const parts: string[] = [];
	let chunk = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i];
		const has1 = i + 1 < bytes.length;
		const has2 = i + 2 < bytes.length;
		const b1 = has1 ? bytes[i + 1] : 0;
		const b2 = has2 ? bytes[i + 2] : 0;
		chunk += ALPHABET.charAt(b0 >> 2);
		chunk += ALPHABET.charAt(((b0 & 3) << 4) | (b1 >> 4));
		chunk += has1 ? ALPHABET.charAt(((b1 & 15) << 2) | (b2 >> 6)) : '=';
		chunk += has2 ? ALPHABET.charAt(b2 & 63) : '=';
		if (chunk.length >= 8192) {
			parts.push(chunk);
			chunk = '';
		}
	}
	parts.push(chunk);
	return parts.join('');
}

let decodeTable: Int16Array | undefined;

export function base64ToBytes(text: string): Uint8Array {
	if (typeof text !== 'string' || text.length % 4 !== 0) throw new RangeError('base64: invalid input');
	if (!decodeTable) {
		const t = new Int16Array(128).fill(-1);
		for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
		decodeTable = t;
	}
	const len = text.length;
	let pad = 0;
	if (len > 0 && text.charAt(len - 1) === '=') pad = text.charAt(len - 2) === '=' ? 2 : 1;
	const out = new Uint8Array((len / 4) * 3 - pad);
	let o = 0;
	for (let i = 0; i < len; i += 4) {
		const last = i + 4 === len;
		const vals = [0, 0, 0, 0];
		for (let k = 0; k < 4; k++) {
			const code = text.charCodeAt(i + k);
			if (last && k >= 4 - pad) {
				if (code !== 0x3d) throw new RangeError('base64: invalid input');
				continue;
			}
			const v = code < 128 ? decodeTable[code] : -1;
			if (v < 0) throw new RangeError('base64: invalid input');
			vals[k] = v;
		}
		if (last && ((pad === 2 && (vals[1] & 15) !== 0) || (pad === 1 && (vals[2] & 3) !== 0))) {
			throw new RangeError('base64: invalid input');
		}
		const triple = (vals[0] << 18) | (vals[1] << 12) | (vals[2] << 6) | vals[3];
		if (o < out.length) out[o++] = (triple >> 16) & 0xff;
		if (o < out.length) out[o++] = (triple >> 8) & 0xff;
		if (o < out.length) out[o++] = triple & 0xff;
	}
	return out;
}
