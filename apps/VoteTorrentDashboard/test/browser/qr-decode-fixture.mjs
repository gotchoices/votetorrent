/**
 * qr-decode-fixture.mjs -- the D-23 QR fixture for the live gate (Node ESM,
 * no browser import).
 *
 * The largest code the pairing screen accepts from a QR is
 * `PAIRING_QR_BYTE_BUDGET` bytes (2953, the byte capacity of a version 40,
 * level L QR: N = 177 modules). This module builds a deterministic printable
 * ASCII payload of exactly that size, shaped like a pairing code, encodes it
 * with the encoder the Authority app already ships (`qrcode-generator`,
 * loaded by absolute path from the Authority workspace: nothing is
 * installed), and renders 1280x720 frames from the module matrix:
 *   - `integer`: m = floor(720 / (N + 8)) px per module (3 at N = 177), a
 *     4-module white quiet zone, centred on mid-grey, #000000 / #FFFFFF only;
 *   - `resampled`: rendered at m = 5, bilinear-scaled to a 640 px side, with
 *     deterministic +/-6 % luminance noise (a camera-like frame);
 *   - `damaged`: `integer` with the top-left finder pattern painted white
 *     (must NOT decode: the round-trip control).
 * `writeY4m` writes a frame as YUV4MPEG2 (C420jpeg, 30 fps) for Chromium's
 * `--use-file-for-fake-video-capture`, so the REAL scanner can be fed it.
 *
 * The payload is synthetic. Nothing here prints it: callers log only its
 * length and a SHA-256 prefix.
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTHORITY_PACKAGE_JSON = path.resolve(__dirname, '..', '..', '..', 'VoteTorrentAuthority', 'package.json');

/** The byte budget, restated as a spec literal; `assertBudgetParity` checks it against vote-engine. */
export const FIXTURE_PAYLOAD_BYTES = 2953;
/** The module count of a version 40 QR. */
export const FIXTURE_MODULES = 177;
export const FRAME_WIDTH = 1280;
export const FRAME_HEIGHT = 720;

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const PAIRING_PREFIX = 'vtpair1.';
const JOIN_SEPARATOR = '.vtjoin2.';

/** @param {number} seed */
function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let x = a;
		x = Math.imul(x ^ (x >>> 15), x | 1);
		x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Fail unless the vote-engine browser entry's budget and prefix equal this
 * fixture's literals (the fixture must track the product, never redefine it).
 * @returns {Promise<{ budget: number, prefix: string }>}
 */
export async function assertBudgetParity() {
	const mod = await import('@votetorrent/vote-engine/browser');
	const budget = /** @type {any} */ (mod).PAIRING_QR_BYTE_BUDGET;
	const prefix = /** @type {any} */ (mod).PAIRING_CODE_PREFIX;
	if (budget !== FIXTURE_PAYLOAD_BYTES) {
		throw new Error(`qr-decode-fixture: PAIRING_QR_BYTE_BUDGET is ${budget}, the fixture assumes ${FIXTURE_PAYLOAD_BYTES}`);
	}
	if (prefix !== PAIRING_PREFIX) throw new Error('qr-decode-fixture: PAIRING_CODE_PREFIX differs from the fixture prefix');
	return { budget, prefix };
}

/**
 * `vtpair1.` + base64url body + `.vtjoin2.` + base64url body, exactly
 * FIXTURE_PAYLOAD_BYTES bytes of printable ASCII, deterministic per seed.
 * @param {number} [seed]
 * @returns {string}
 */
export function buildFixturePayload(seed = 0x6625) {
	const rand = mulberry32(seed);
	const bodyLength = FIXTURE_PAYLOAD_BYTES - PAIRING_PREFIX.length - JOIN_SEPARATOR.length;
	const firstLength = Math.floor(bodyLength * 0.12);
	let out = PAIRING_PREFIX;
	for (let i = 0; i < firstLength; i += 1) out += B64URL[Math.floor(rand() * 64)];
	out += JOIN_SEPARATOR;
	while (out.length < FIXTURE_PAYLOAD_BYTES) out += B64URL[Math.floor(rand() * 64)];
	if (Buffer.byteLength(out, 'utf8') !== FIXTURE_PAYLOAD_BYTES) throw new Error('qr-decode-fixture: payload size drifted');
	return out;
}

/** @param {string} text */
export function sha256Prefix(text) {
	return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** @returns {any} the qrcode-generator factory */
function loadEncoder() {
	const require = createRequire(AUTHORITY_PACKAGE_JSON);
	let mod;
	try {
		mod = require('qrcode-generator');
	} catch {
		throw new Error(
			'STOP: qrcode-generator is not installed in apps/VoteTorrentAuthority (nothing may be installed for this gate)',
		);
	}
	const factory = typeof mod === 'function' ? mod : mod?.default;
	if (typeof factory !== 'function') throw new Error('qr-decode-fixture: qrcode-generator exposes no factory');
	return factory;
}

/**
 * Type number 0 (automatic), level L, byte mode. Throws unless N = 177.
 * @param {string} payload
 * @returns {{ n: number, modules: string[] }} rows of '0'/'1'
 */
export function encodeQrMatrix(payload) {
	const qrcode = loadEncoder();
	const qr = qrcode(0, 'L');
	qr.addData(payload, 'Byte');
	qr.make();
	const n = qr.getModuleCount();
	if (n !== FIXTURE_MODULES) throw new Error(`qr-decode-fixture: the payload encoded to N=${n}, not ${FIXTURE_MODULES}`);
	/** @type {string[]} */
	const modules = [];
	for (let r = 0; r < n; r += 1) {
		let row = '';
		for (let c = 0; c < n; c += 1) row += qr.isDark(r, c) ? '1' : '0';
		modules.push(row);
	}
	return { n, modules };
}

/**
 * @param {Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} x0 @param {number} y0 @param {number} w @param {number} h
 * @param {number} value 0..255 grey
 */
function fillRect(rgba, width, x0, y0, w, h, value) {
	for (let y = y0; y < y0 + h; y += 1) {
		for (let x = x0; x < x0 + w; x += 1) {
			const i = (y * width + x) * 4;
			rgba[i] = value;
			rgba[i + 1] = value;
			rgba[i + 2] = value;
			rgba[i + 3] = 255;
		}
	}
}

/**
 * The matrix with its quiet zone as a square grey image at m px per module.
 * @param {string[]} modules @param {number} n @param {number} m
 */
function matrixImage(modules, n, m) {
	const side = (n + 8) * m;
	const grey = new Uint8ClampedArray(side * side).fill(255);
	for (let r = 0; r < n; r += 1) {
		for (let c = 0; c < n; c += 1) {
			if (modules[r][c] !== '1') continue;
			for (let y = (r + 4) * m; y < (r + 5) * m; y += 1) grey.fill(0, y * side + (c + 4) * m, y * side + (c + 5) * m);
		}
	}
	return { side, grey };
}

/**
 * A 1280x720 RGBA frame, the same geometry `live-gate.tsx`'s `decodeFrame` draws.
 * @param {{ modules: string[], n: number, variant: 'integer' | 'resampled' | 'damaged' }} options
 * @returns {{ width: number, height: number, rgba: Uint8ClampedArray, m: number }}
 */
export function renderFrame({ modules, n, variant }) {
	const W = FRAME_WIDTH;
	const H = FRAME_HEIGHT;
	const rgba = new Uint8ClampedArray(W * H * 4);
	fillRect(rgba, W, 0, 0, W, H, 128);
	if (variant === 'resampled') {
		const m = 5;
		const { side, grey } = matrixImage(modules, n, m);
		const target = 640;
		const x0 = Math.round((W - target) / 2);
		const y0 = Math.round((H - target) / 2);
		const scale = side / target;
		const rand = mulberry32(0x6625);
		for (let y = 0; y < target; y += 1) {
			const sy = Math.min(side - 1.001, Math.max(0, (y + 0.5) * scale - 0.5));
			const yA = Math.floor(sy);
			const fy = sy - yA;
			for (let x = 0; x < target; x += 1) {
				const sx = Math.min(side - 1.001, Math.max(0, (x + 0.5) * scale - 0.5));
				const xA = Math.floor(sx);
				const fx = sx - xA;
				const a = grey[yA * side + xA];
				const b = grey[yA * side + xA + 1];
				const c = grey[(yA + 1) * side + xA];
				const d = grey[(yA + 1) * side + xA + 1];
				const v = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
				const noisy = Math.max(0, Math.min(255, Math.round(v * (1 + (rand() * 2 - 1) * 0.06))));
				const i = ((y0 + y) * W + (x0 + x)) * 4;
				rgba[i] = noisy;
				rgba[i + 1] = noisy;
				rgba[i + 2] = noisy;
				rgba[i + 3] = 255;
			}
		}
		return { width: W, height: H, rgba, m };
	}
	const m = Math.floor(H / (n + 8));
	const { side, grey } = matrixImage(modules, n, m);
	const x0 = Math.floor((W - side) / 2);
	const y0 = Math.floor((H - side) / 2);
	for (let y = 0; y < side; y += 1) {
		for (let x = 0; x < side; x += 1) {
			const v = grey[y * side + x];
			const i = ((y0 + y) * W + (x0 + x)) * 4;
			rgba[i] = v;
			rgba[i + 1] = v;
			rgba[i + 2] = v;
			rgba[i + 3] = 255;
		}
	}
	if (variant === 'damaged') fillRect(rgba, W, x0 + 4 * m, y0 + 4 * m, 8 * m, 8 * m, 255);
	return { width: W, height: H, rgba, m };
}

/**
 * YUV4MPEG2, C420jpeg (full-range BT.601, 2x2 chroma averaging), 30 fps,
 * `frames` copies of the one frame.
 * @param {{ width: number, height: number, rgba: Uint8ClampedArray }} frame
 * @param {string} filePath
 * @param {{ frames?: number }} [options]
 * @returns {{ bytes: number }}
 */
export function writeY4m(frame, filePath, { frames = 3 } = {}) {
	const { width: W, height: H, rgba } = frame;
	if (W % 2 !== 0 || H % 2 !== 0) throw new Error('qr-decode-fixture: Y4M 4:2:0 needs even dimensions');
	const ySize = W * H;
	const cSize = (W / 2) * (H / 2);
	const planes = Buffer.alloc(ySize + 2 * cSize);
	for (let i = 0; i < ySize; i += 1) {
		const r = rgba[i * 4];
		const g = rgba[i * 4 + 1];
		const b = rgba[i * 4 + 2];
		planes[i] = Math.max(0, Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b)));
	}
	for (let y = 0; y < H / 2; y += 1) {
		for (let x = 0; x < W / 2; x += 1) {
			let r = 0;
			let g = 0;
			let b = 0;
			for (const [dx, dy] of [
				[0, 0],
				[1, 0],
				[0, 1],
				[1, 1],
			]) {
				const i = ((2 * y + dy) * W + (2 * x + dx)) * 4;
				r += rgba[i];
				g += rgba[i + 1];
				b += rgba[i + 2];
			}
			r /= 4;
			g /= 4;
			b /= 4;
			const ci = y * (W / 2) + x;
			planes[ySize + ci] = Math.max(0, Math.min(255, Math.round(128 - 0.168736 * r - 0.331264 * g + 0.5 * b)));
			planes[ySize + cSize + ci] = Math.max(0, Math.min(255, Math.round(128 + 0.5 * r - 0.418688 * g - 0.081312 * b)));
		}
	}
	const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`, 'ascii');
	const frameTag = Buffer.from('FRAME\n', 'ascii');
	const parts = [header];
	for (let f = 0; f < frames; f += 1) parts.push(frameTag, planes);
	const out = Buffer.concat(parts);
	writeFileSync(filePath, out);
	return { bytes: out.length };
}
