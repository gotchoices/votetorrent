/**
 * qr-panel.test.ts - Phase 64 Plan 10 (D-03, notes 4.8). The gray8 PNG writer, base64, and the panel
 * builder, measured from DECODED PIXELS (not from the returned numbers) and re-decoded by jsQR.
 * Comparisons of code text are boolean: a failing matcher would print the credential.
 */

import * as fs from 'fs';
import * as path from 'path';
import jsQR from 'jsqr';
import { JOIN_CODE_FIXTURES, type JoinCodeFixtureName } from '@votetorrent/vote-engine/test/fixtures/join-code-fixtures';
import { captureConsole, expectNoSecretInConsole } from '../../../engines/__fixtures__/console-leak';
import { base64ToBytes, bytesToBase64, encodeGray8Png } from '../gray-png';
import { buildQrPanelPng, drawQrModules } from '../qr-panel';
import { buildQrMatrix, QrInputError, QrOverflowError } from '../qr-matrix';
import { QrLayoutError, qrLayout } from '../qr-layout';

interface DecodedPng {
	width: number;
	height: number;
	depth: number;
	colorType: number;
	alpha: boolean;
	data: Uint8Array;
}
interface PngjsModule {
	PNG: { sync: { read(data: Uint8Array): DecodedPng } };
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PNG } = require('pngjs') as PngjsModule;

const NAMES = Object.keys(JOIN_CODE_FIXTURES) as JoinCodeFixtureName[];
const V2_NAMES: JoinCodeFixtureName[] = ['v2-1-member', 'v2-2-members', 'v2-6-members'];
const CONTENT = V2_NAMES.map((n) => JOIN_CODE_FIXTURES[n].text).join('');
const ECC_L_BYTE_CAPACITY = [
	17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520, 586, 644, 718, 792, 858, 929, 1003, 1091,
	1171, 1273, 1367, 1465, 1528, 1628, 1732, 1840, 1952, 2068, 2188, 2303, 2431, 2563, 2699, 2809, 2953,
];
const TARGETS = [1080, 720, 411 * 2.625, 160 * 2.625];
const WINDOW = 16;

function decode(png: Uint8Array): DecodedPng {
	return PNG.sync.read(Buffer.from(png));
}

function windowHits(message: string, secret: string): number {
	let hits = 0;
	for (let o = 0; o + WINDOW <= secret.length; o++) {
		if (message.includes(secret.slice(o, o + WINDOW))) hits++;
	}
	return hits;
}

function thrown(fn: () => unknown): unknown {
	try {
		fn();
	} catch (e) {
		return e;
	}
	return undefined;
}

/** [length, type, data, crc] walk over the PNG bytes after the 8-byte signature. */
function chunks(png: Uint8Array): Array<{ type: string; data: Uint8Array }> {
	const out: Array<{ type: string; data: Uint8Array }> = [];
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	let o = 8;
	while (o < png.length) {
		const len = view.getUint32(o);
		const type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
		out.push({ type, data: png.subarray(o + 8, o + 8 + len) });
		o += 12 + len;
	}
	expect(o).toBe(png.length);
	return out;
}

interface Measured {
	pure: boolean;
	gray: boolean;
	dark: number;
	bbox: [number, number, number, number];
	quiet: [number, number, number, number];
}

function measure(img: DecodedPng): Measured {
	let pure = true;
	let gray = true;
	let dark = 0;
	let minX = img.width;
	let minY = img.height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < img.height; y++) {
		for (let x = 0; x < img.width; x++) {
			const i = (y * img.width + x) * 4;
			const r = img.data[i];
			if (r !== 0 && r !== 255) pure = false;
			if (img.data[i + 1] !== r || img.data[i + 2] !== r || img.data[i + 3] !== 255) gray = false;
			if (r === 0) {
				dark++;
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	return {
		pure,
		gray,
		dark,
		bbox: [minX, minY, maxX, maxY],
		quiet: [minX, minY, img.width - 1 - maxX, img.height - 1 - maxY],
	};
}

function px(img: DecodedPng, x: number, y: number): number {
	return img.data[(y * img.width + x) * 4];
}

function checkPanel(text: string, target: number): void {
	const matrix = buildQrMatrix(text);
	const layout = qrLayout(matrix.n, target);
	const panel = buildQrPanelPng(text, target);
	expect(panel.n).toBe(matrix.n);
	expect(panel.m).toBe(layout.m);
	expect(panel.panelPx).toBe(layout.panelPx);

	const img = decode(panel.png);
	expect(img.width).toBe(layout.panelPx);
	expect(img.height).toBe(layout.panelPx);
	expect(img.colorType).toBe(0);
	expect(img.depth).toBe(8);

	const me = measure(img);
	expect(me.dark > 0).toBe(true); // a vacuous probe is a failure
	expect(me.pure).toBe(true);
	expect(me.gray).toBe(true);
	expect(me.bbox[2] - me.bbox[0] + 1).toBe(layout.m * matrix.n);
	expect(me.bbox[3] - me.bbox[1] + 1).toBe(layout.m * matrix.n);
	expect(me.quiet.join(',')).toBe([4, 4, 4, 4].map((k) => k * layout.m).join(','));

	let badBlocks = 0;
	for (let r = 0; r < matrix.n; r++) {
		for (let c = 0; c < matrix.n; c++) {
			const want = matrix.isDark(r, c) ? 0 : 255;
			const x0 = layout.quietPx + c * layout.m;
			const y0 = layout.quietPx + r * layout.m;
			let uniform = true;
			for (let dy = 0; dy < layout.m && uniform; dy++) {
				for (let dx = 0; dx < layout.m; dx++) {
					if (px(img, x0 + dx, y0 + dy) !== want) {
						uniform = false;
						break;
					}
				}
			}
			if (!uniform) badBlocks++;
		}
	}
	expect(badBlocks).toBe(0);

	// the top-left finder's outer ring is exactly m pixels thick (run along the finder's middle row)
	const yMid = layout.quietPx + 3 * layout.m + Math.floor(layout.m / 2);
	let run = 0;
	while (px(img, layout.quietPx + run, yMid) === 0) run++;
	expect(run).toBe(layout.m);

	const found = jsQR(new Uint8ClampedArray(img.data), img.width, img.height, { inversionAttempts: 'dontInvert' });
	expect(found !== null).toBe(true);
	expect(found !== null && found.data === text).toBe(true);
	expect(found !== null && found.version).toBe((matrix.n - 17) / 4);
}

describe('encodeGray8Png', () => {
	it('round-trips a tiny image with exact IHDR and chunk order', () => {
		const pixels = Uint8Array.from([0, 128, 255, 7, 8, 9]);
		const png = encodeGray8Png(3, 2, pixels);
		expect(Array.from(png.subarray(0, 8)).map((b) => b.toString(16)).join(',')).toBe('89,50,4e,47,d,a,1a,a');
		const cs = chunks(png);
		expect(cs.map((c) => c.type).join(',')).toBe('IHDR,IDAT,IEND');
		expect(Array.from(cs[0].data.subarray(8)).join(',')).toBe('8,0,0,0,0');
		const view = new DataView(cs[0].data.buffer, cs[0].data.byteOffset, 13);
		expect(view.getUint32(0)).toBe(3);
		expect(view.getUint32(4)).toBe(2);
		const img = decode(png);
		expect(img.width).toBe(3);
		expect(img.height).toBe(2);
		expect(img.depth).toBe(8);
		expect(img.colorType).toBe(0);
		expect(img.alpha).toBe(false);
		for (let i = 0; i < 6; i++) {
			expect(img.data[i * 4]).toBe(pixels[i]);
			expect(img.data[i * 4 + 1]).toBe(pixels[i]);
			expect(img.data[i * 4 + 2]).toBe(pixels[i]);
			expect(img.data[i * 4 + 3]).toBe(255);
		}
	});
	it('is deterministic', () => {
		const pixels = new Uint8Array(100 * 100).map((_v, i) => (i * 7) & 0xff);
		expect(Buffer.from(encodeGray8Png(100, 100, pixels)).equals(Buffer.from(encodeGray8Png(100, 100, pixels)))).toBe(true);
	});
	it('is rejected by a CRC-checking decoder after one IDAT byte is flipped', () => {
		const pixels = new Uint8Array(40 * 40).map((_v, i) => (i * 13) & 0xff);
		const png = Uint8Array.from(encodeGray8Png(40, 40, pixels));
		let o = 8;
		const view = new DataView(png.buffer);
		o += 12 + view.getUint32(o); // past IHDR
		png[o + 8 + 2] ^= 0x55; // inside the IDAT data
		expect(() => decode(png)).toThrow();
	});
	it.each([
		[0, 1, 0],
		[1.5, 1, 1],
		[16385, 1, 16385],
		[Number.NaN, 1, 1],
		[2, 2, 3],
	])('throws RangeError for width %p height %p pixels %p', (w, h, len) => {
		expect(thrown(() => encodeGray8Png(w, h, new Uint8Array(len))) instanceof RangeError).toBe(true);
	});
});

describe('base64', () => {
	it('matches Node base64 for lengths 0..64 and inverts', () => {
		for (let len = 0; len <= 64; len++) {
			const bytes = new Uint8Array(len).map((_v, i) => (i * 37 + len) & 0xff);
			const want = Buffer.from(bytes).toString('base64');
			expect(bytesToBase64(bytes)).toBe(want);
			expect(Buffer.from(base64ToBytes(want)).equals(Buffer.from(bytes))).toBe(true);
		}
	});
	it('matches Node base64 for a panel PNG', () => {
		const p = buildQrPanelPng(JOIN_CODE_FIXTURES['v2-1-member'].text, 720);
		expect(p.base64 === Buffer.from(p.png).toString('base64')).toBe(true);
		expect(Buffer.from(base64ToBytes(p.base64)).equals(Buffer.from(p.png))).toBe(true);
	});
	it.each(['A', 'AB', 'ABC', 'AB=C', 'A===', 'AB!=', 'AAA=AAAA', '=AAA', 'AB==\n', 'AR==', 'AAF='])(
		'refuses %p',
		(bad) => {
			expect(thrown(() => base64ToBytes(bad)) instanceof RangeError).toBe(true);
		},
	);
});

describe('buildQrPanelPng', () => {
	describe.each(NAMES)('fixture %s', (name) => {
		const text = JOIN_CODE_FIXTURES[name].text;
		const full = name === 'v2-1-member' || name === 'v2-6-members';
		const targets = full ? TARGETS : [1080, 160 * 2.625];
		it.each(targets)('target %f: pixels measure to the layout and jsQR reads it', (t) => {
			checkPanel(text, t);
		});
	});

	describe('every module count 113..165', () => {
		const versions: number[] = [];
		for (let v = 24; v <= 37; v++) versions.push(v);
		it.each(versions)('version %i at 1080 and 720', (v) => {
			const text = CONTENT.slice(0, ECC_L_BYTE_CAPACITY[v - 1]);
			expect(buildQrMatrix(text).n).toBe(17 + 4 * v);
			checkPanel(text, 1080);
			checkPanel(text, 720);
		});
	});

	it('propagates typed errors unchanged', () => {
		const text = JOIN_CODE_FIXTURES['v2-1-member'].text;
		const bad = text.slice(0, 100) + 'é' + text.slice(100);
		expect(thrown(() => buildQrPanelPng(bad, 1080)) instanceof QrInputError).toBe(true);
		expect(thrown(() => buildQrPanelPng(CONTENT.slice(0, 2954), 1080)) instanceof QrOverflowError).toBe(true);
		const n = buildQrMatrix(text).n;
		expect(thrown(() => buildQrPanelPng(text, n + 7)) instanceof QrLayoutError).toBe(true);
	});

	it('result keys are exactly png, base64, n, m and panelPx and logs nothing', () => {
		const text = JOIN_CODE_FIXTURES['v2-1-member'].text;
		const c = captureConsole();
		try {
			const p = buildQrPanelPng(text, 720);
			expect(Object.keys(p).sort().join(',')).toBe('base64,m,n,panelPx,png');
			thrown(() => buildQrPanelPng('', 720));
			expect(c.calls().length).toBe(0);
			expectNoSecretInConsole(c, [text]);
		} finally {
			c.restore();
		}
		const err = thrown(() => buildQrPanelPng(CONTENT.slice(0, 2954), 720));
		expect(windowHits(String(err), CONTENT)).toBe(0);
	});
});

describe('drawQrModules', () => {
	it('throws RangeError when a block falls outside the canvas', () => {
		const q = buildQrMatrix(JOIN_CODE_FIXTURES['v2-1-member'].text);
		expect(thrown(() => drawQrModules(new Uint8Array(100 * 100), 100, q, 6, 0, 0)) instanceof RangeError).toBe(true);
		const side = q.n * 2;
		expect(thrown(() => drawQrModules(new Uint8Array(side * side), side, q, 2, 1, 0)) instanceof RangeError).toBe(true);
	});
});

const exportIt = process.env.VT64_QR_EXPORT_DIR ? it : it.skip;
exportIt('exports product screenshot composites for the geometry checker', () => {
	const dir = process.env.VT64_QR_EXPORT_DIR as string;
	fs.mkdirSync(dir, { recursive: true });
	const W = 1080;
	const H = 2400;
	const sidecar: Array<{ file: string; fixture: string; theme: string; n: number; m: number }> = [];
	for (const fixture of ['v2-1-member', 'v2-6-members'] as JoinCodeFixtureName[]) {
		const panel = buildQrPanelPng(JOIN_CODE_FIXTURES[fixture].text, 1080);
		const img = decode(panel.png);
		for (const theme of ['light', 'dark']) {
			const canvas = new Uint8Array(W * H).fill(0xff);
			if (theme === 'dark') {
				canvas.fill(0x12, 0, 84 * W);
				canvas.fill(0x12, 2316 * W, H * W);
			}
			const x0 = Math.floor((W - panel.panelPx) / 2);
			const y0 = 300;
			for (let y = 0; y < panel.panelPx; y++) {
				for (let x = 0; x < panel.panelPx; x++) canvas[(y0 + y) * W + x0 + x] = px(img, x, y);
			}
			const fy = y0 + panel.panelPx + 63;
			for (let y = 0; y < 42; y++) canvas.fill(0, (fy + y) * W + 220, (fy + y) * W + 220 + 640);
			const file = `qr-geometry-${fixture}-${theme}.png`;
			fs.writeFileSync(path.join(dir, file), encodeGray8Png(W, H, canvas));
			sidecar.push({ file, fixture, theme, n: panel.n, m: panel.m });
		}
	}
	fs.writeFileSync(path.join(dir, 'qr-geometry-exports.json'), JSON.stringify(sidecar));
});
