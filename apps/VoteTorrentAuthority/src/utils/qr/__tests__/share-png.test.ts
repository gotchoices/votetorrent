/**
 * share-png.test.ts - Phase 64 Plan 10 (D-04, D-29, Addendum A5). The 1080 x 1240 share PNG: the QR
 * plus the fingerprint band and nothing else, the atlas provenance, the OFL licence text, the band
 * golden and the source hygiene of the hand-written QR modules.
 * Comparisons of code text are boolean: a failing matcher would print the credential.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { unzlibSync } from 'fflate';
import jsQR from 'jsqr';
import { JOIN_CODE_FIXTURES, type JoinCodeFixtureName } from '@votetorrent/vote-engine/test/fixtures/join-code-fixtures';
import { captureConsole, expectNoSecretInConsole } from '../../../engines/__fixtures__/console-leak';
import { FINGERPRINT_ATLAS } from '../fingerprint-atlas.generated';
import { base64ToBytes } from '../gray-png';
import { qrLayout } from '../qr-layout';
import { buildQrMatrix, QrOverflowError } from '../qr-matrix';
import {
	FINGERPRINT_BAND_PX,
	FingerprintGlyphError,
	SHARE_PNG_HEIGHT,
	SHARE_PNG_WIDTH,
	SHARE_QR_BLOCK_PX,
	buildShareQrPng,
} from '../share-png';

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
const GOLDEN_FINGERPRINT = '0123 4567 89ab cdef';
const GOLDEN_BAND_SHA256 = 'd9b3a68cd9431b74f63735555786c7f12b9dbfd0f90130caf9b18eb726d882dc';
const OFL_SHA256 = '30f0c136e3c88e422d0791acd97238870f9054a9729bc34cf2ff0d4ed8cac4ad';
const FONT_SHA256 = '5590990c82e097397517f275f430af4546e1c45cff408bde4255dad142479dcb';
const BIG = JOIN_CODE_FIXTURES['v2-6-members'].text.repeat(2).slice(0, 2954);

function decode(png: Uint8Array): DecodedPng {
	return PNG.sync.read(Buffer.from(png));
}

function chunkTypes(png: Uint8Array): string[] {
	const out: string[] = [];
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	let o = 8;
	while (o < png.length) {
		out.push(String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]));
		o += 12 + view.getUint32(o);
	}
	expect(o).toBe(png.length);
	return out;
}

function sha256(bytes: Uint8Array): string {
	return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function thrown(fn: () => unknown): unknown {
	try {
		fn();
	} catch (e) {
		return e;
	}
	return undefined;
}

function px(img: DecodedPng, x: number, y: number): number {
	return img.data[(y * img.width + x) * 4];
}

/** The band's gray bytes (R channel), 1080 x 160, row-major. */
function bandBytes(img: DecodedPng): Uint8Array {
	const out = new Uint8Array(SHARE_PNG_WIDTH * FINGERPRINT_BAND_PX);
	for (let y = 0; y < FINGERPRINT_BAND_PX; y++) {
		for (let x = 0; x < SHARE_PNG_WIDTH; x++) out[y * SHARE_PNG_WIDTH + x] = px(img, x, SHARE_QR_BLOCK_PX + y);
	}
	return out;
}

interface Ink {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
	darkest: number;
}

function inkBox(band: Uint8Array): Ink {
	const ink: Ink = { minX: SHARE_PNG_WIDTH, maxX: -1, minY: FINGERPRINT_BAND_PX, maxY: -1, darkest: 255 };
	for (let y = 0; y < FINGERPRINT_BAND_PX; y++) {
		for (let x = 0; x < SHARE_PNG_WIDTH; x++) {
			const v = band[y * SHARE_PNG_WIDTH + x];
			if (v === 255) continue;
			if (x < ink.minX) ink.minX = x;
			if (x > ink.maxX) ink.maxX = x;
			if (y < ink.minY) ink.minY = y;
			if (y > ink.maxY) ink.maxY = y;
			if (v < ink.darkest) ink.darkest = v;
		}
	}
	return ink;
}

/** Counts gray pixels (1..254) that break the edge-only rule: > 3 px from white, or enclosed by black. */
function badGrays(band: Uint8Array): { grays: number; farFromWhite: number; enclosed: number } {
	const W = SHARE_PNG_WIDTH;
	const H = FINGERPRINT_BAND_PX;
	let grays = 0;
	let farFromWhite = 0;
	let enclosed = 0;
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const v = band[y * W + x];
			if (v === 0 || v === 255) continue;
			grays++;
			let white = false;
			for (let dy = -3; dy <= 3 && !white; dy++) {
				for (let dx = -3; dx <= 3; dx++) {
					const yy = y + dy;
					const xx = x + dx;
					if (yy < 0 || yy >= H || xx < 0 || xx >= W) continue;
					if (band[yy * W + xx] === 255) {
						white = true;
						break;
					}
				}
			}
			if (!white) farFromWhite++;
			let notBlack = false;
			for (let dy = -1; dy <= 1 && !notBlack; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					if (dx === 0 && dy === 0) continue;
					const yy = y + dy;
					const xx = x + dx;
					if (yy < 0 || yy >= H || xx < 0 || xx >= W) {
						notBlack = true;
						break;
					}
					if (band[yy * W + xx] !== 0) {
						notBlack = true;
						break;
					}
				}
			}
			if (!notBlack) enclosed++;
		}
	}
	return { grays, farFromWhite, enclosed };
}

describe('fingerprint atlas', () => {
	const A = FINGERPRINT_ATLAS;
	const strip = unzlibSync(base64ToBytes(A.stripZlibBase64));
	const stripW = A.cellWidth * A.glyphs.length;

	it('carries the locked font and tool provenance', () => {
		expect(A.glyphs).toBe('0123456789abcdef ');
		expect(A.sizePx).toBe(56);
		expect(A.fontFamily).toBe('JetBrains Mono');
		expect(A.fontStyle).toBe('Bold');
		expect(A.fontVersion).toBe('2.304');
		expect(A.fontSha256).toBe(FONT_SHA256);
		expect(A.pillowVersion).toBe('12.3.0');
	});
	it('decodes to a strip whose sha256 matches and whose ink boxes match', () => {
		expect(strip.length).toBe(stripW * A.cellHeight);
		expect(sha256(strip)).toBe(A.stripSha256);
		for (let i = 0; i < A.glyphs.length; i++) {
			let l = A.cellWidth;
			let t = A.cellHeight;
			let r = -1;
			let b = -1;
			let darkest = 255;
			for (let y = 0; y < A.cellHeight; y++) {
				for (let x = 0; x < A.cellWidth; x++) {
					const v = strip[y * stripW + i * A.cellWidth + x];
					if (v === 255) continue;
					l = Math.min(l, x);
					r = Math.max(r, x);
					t = Math.min(t, y);
					b = Math.max(b, y);
					darkest = Math.min(darkest, v);
				}
			}
			if (A.glyphs.charAt(i) === ' ') {
				expect(A.ink[i]).toBeNull();
				expect(r).toBe(-1);
			} else {
				expect((A.ink[i] as readonly number[]).join(',')).toBe([l, t, r, b].join(','));
				expect(darkest).toBe(0);
			}
		}
	});
	it('ships the byte-identical OFL 1.1 licence beside it', () => {
		const file = path.join(__dirname, '..', 'FINGERPRINT-ATLAS-LICENSE.txt');
		const bytes = fs.readFileSync(file);
		expect(sha256(bytes)).toBe(OFL_SHA256);
		const text = bytes.toString('latin1');
		expect(text.includes('Copyright 2020 The JetBrains Mono Project Authors')).toBe(true);
		expect(text.includes('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007')).toBe(true);
	});
	it('the generated module has no import, require or console', () => {
		const src = fs.readFileSync(path.join(__dirname, '..', 'fingerprint-atlas.generated.ts'), 'utf8');
		expect(/^import /m.test(src)).toBe(false);
		expect(src.includes('require(')).toBe(false);
		expect(src.includes('console.')).toBe(false);
	});
});

describe('buildShareQrPng', () => {
	it('exports the locked constants', () => {
		expect(SHARE_PNG_WIDTH).toBe(1080);
		expect(SHARE_PNG_HEIGHT).toBe(1240);
		expect(FINGERPRINT_BAND_PX).toBe(160);
		expect(SHARE_QR_BLOCK_PX).toBe(1080);
	});

	describe.each(NAMES)('fixture %s', (name) => {
		const fx = JOIN_CODE_FIXTURES[name];
		const png = buildShareQrPng(fx.text, fx.fingerprint);
		const img = decode(png);
		const matrix = buildQrMatrix(fx.text);
		const { m } = qrLayout(matrix.n, SHARE_QR_BLOCK_PX);
		const off = Math.floor((SHARE_QR_BLOCK_PX - m * matrix.n) / 2);

		it('is a 1080 x 1240 gray8 PNG with IHDR/IDAT/IEND only', () => {
			expect(img.width).toBe(1080);
			expect(img.height).toBe(1240);
			expect(img.depth).toBe(8);
			expect(img.colorType).toBe(0);
			expect(img.alpha).toBe(false);
			expect(chunkTypes(png).join(',')).toBe('IHDR,IDAT,IEND');
		});

		it('carries the QR square and nothing else in rows 0..1079', () => {
			expect(off >= 4 * m).toBe(true);
			let wrong = 0;
			let nonWhiteOutside = 0;
			let dark = 0;
			for (let y = 0; y < SHARE_QR_BLOCK_PX; y++) {
				for (let x = 0; x < SHARE_PNG_WIDTH; x++) {
					const v = px(img, x, y);
					const inside = x >= off && x < off + m * matrix.n && y >= off && y < off + m * matrix.n;
					if (inside) {
						const want = matrix.isDark(Math.floor((y - off) / m), Math.floor((x - off) / m)) ? 0 : 255;
						if (v !== want) wrong++;
						if (v === 0) dark++;
					} else if (v !== 255) {
						nonWhiteOutside++;
					}
				}
			}
			expect(dark > 0).toBe(true);
			expect(wrong).toBe(0);
			expect(nonWhiteOutside).toBe(0);
		});

		it('meets Addendum A5 for the band', () => {
			const band = bandBytes(img);
			const ink = inkBox(band);
			expect(ink.maxX >= ink.minX).toBe(true);
			const left = ink.minX;
			const right = SHARE_PNG_WIDTH - 1 - ink.maxX;
			expect(Math.abs(left - right) <= 2).toBe(true);
			expect(Math.abs((ink.minY + ink.maxY) / 2 - 80) <= 4).toBe(true);
			const w = ink.maxX - ink.minX + 1;
			const h = ink.maxY - ink.minY + 1;
			expect(w >= 560 && w <= 720).toBe(true);
			expect(h >= 28 && h <= 56).toBe(true);
			expect(ink.darkest).toBe(0);
			const g = badGrays(band);
			expect(g.grays > 0).toBe(true);
			expect(g.farFromWhite).toBe(0);
			expect(g.enclosed).toBe(0);
		});

		it('is read back by jsQR as the exact text and version', () => {
			const found = jsQR(new Uint8ClampedArray(img.data), img.width, img.height, { inversionAttempts: 'dontInvert' });
			expect(found !== null).toBe(true);
			expect(found !== null && found.data === fx.text).toBe(true);
			expect(found !== null && found.version).toBe((matrix.n - 17) / 4);
		});
	});

	describe('golden band', () => {
		it('matches the committed digest and does not depend on the QR text', () => {
			const a = decode(buildShareQrPng(JOIN_CODE_FIXTURES['v2-1-member'].text, GOLDEN_FINGERPRINT));
			const b = decode(buildShareQrPng(JOIN_CODE_FIXTURES['v2-6-members'].text, GOLDEN_FINGERPRINT));
			const da = sha256(bandBytes(a));
			expect(da === sha256(bandBytes(b))).toBe(true);
			expect(da === GOLDEN_BAND_SHA256 ? 'golden' : 'DIGEST ' + da).toBe('golden');
		});
	});

	describe('refusals', () => {
		const text = JOIN_CODE_FIXTURES['v2-1-member'].text;
		function code(fp: unknown): string {
			const err = thrown(() => buildShareQrPng(text, fp as string));
			return err instanceof FingerprintGlyphError ? err.code : 'other';
		}
		it.each(['01g2', '01A2', '01-2', '01é2', '01\t2'])('outside-atlas for %j', (fp) => {
			expect(code(fp)).toBe('outside-atlas');
		});
		it('no-ink for empty and all-space', () => {
			expect(code('')).toBe('no-ink');
			expect(code('     ')).toBe('no-ink');
		});
		it('too-long past the band', () => {
			expect(code('0'.repeat(Math.floor(1080 / FINGERPRINT_ATLAS.cellWidth) + 1))).toBe('too-long');
		});
		it('not-string', () => {
			expect(code(5)).toBe('not-string');
			expect(code(undefined)).toBe('not-string');
		});
		it('checks the fingerprint before the QR work', () => {
			expect(thrown(() => buildShareQrPng(BIG, 'zz')) instanceof FingerprintGlyphError).toBe(true);
			expect(thrown(() => buildShareQrPng(BIG, GOLDEN_FINGERPRINT)) instanceof QrOverflowError).toBe(true);
		});
	});

	describe('determinism and console hygiene', () => {
		const fx = JOIN_CODE_FIXTURES['v2-2-members'];
		it('two builds are byte-identical', () => {
			expect(Buffer.from(buildShareQrPng(fx.text, fx.fingerprint)).equals(Buffer.from(buildShareQrPng(fx.text, fx.fingerprint)))).toBe(true);
		});
		it('logs nothing', () => {
			const c = captureConsole();
			try {
				buildShareQrPng(fx.text, fx.fingerprint);
				thrown(() => buildShareQrPng(fx.text, 'zz'));
				thrown(() => buildShareQrPng(BIG, fx.fingerprint));
				expect(c.calls().length).toBe(0);
				expectNoSecretInConsole(c, [fx.text, fx.fingerprint]);
			} finally {
				c.restore();
			}
		});
	});
});

describe('source hygiene of the hand-written QR modules', () => {
	const TOKENS = [
		'console.',
		'.message',
		'Buffer',
		'TextEncoder',
		'TextDecoder',
		'atob(',
		'btoa(',
		'crypto',
		'require(',
		'process.',
		'Date.now',
		'Math.random',
	];
	const FILES = ['qr-matrix.ts', 'qr-layout.ts', 'gray-png.ts', 'qr-panel.ts', 'share-png.ts'];

	function stripComments(src: string): string {
		return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
	}
	function flagged(src: string): string[] {
		const code = stripComments(src);
		return TOKENS.filter((t) => code.includes(t));
	}

	it('scans exactly five files and finds nothing', () => {
		expect(FILES.length).toBe(5);
		for (const f of FILES) {
			const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
			expect(src.length > 0).toBe(true);
			expect(flagged(src).join(',')).toBe('');
		}
	});
	it('the scanner flags a live call and ignores the same token in comments', () => {
		expect(flagged('const a = 1;\nconsole.log(a);\n').join(',')).toBe('console.');
		expect(flagged('// console.log(a)\n/* console.log(a) */\nconst a = 1;\n').join(',')).toBe('');
	});
});
