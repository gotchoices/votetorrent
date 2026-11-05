/**
 * qr-matrix.test.ts - Phase 64 Plan 10 (D-03, notes 4.8). buildQrMatrix against an independent ECC-L
 * capacity table for every real-encoder fixture and every version 24..37. Comparisons are boolean:
 * a failing matcher would print the join code (a bearer credential) into the jest log.
 */

import { JOIN_CODE_FIXTURES, type JoinCodeFixtureName } from '@votetorrent/vote-engine/test/fixtures/join-code-fixtures';
import { captureConsole, expectNoSecretInConsole } from '../../../engines/__fixtures__/console-leak';
import { buildQrMatrix, QR_MAX_TEXT_CHARS, QrInputError, QrOverflowError } from '../qr-matrix';

// ISO/IEC 18004 byte mode at error correction level L, versions 1..40; verified against
// qrcode-generator 2.0.4 at planning (each capacity fits its version, one more char moves up).
const ECC_L_BYTE_CAPACITY = [
	17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520, 586, 644, 718, 792, 858, 929, 1003, 1091,
	1171, 1273, 1367, 1465, 1528, 1628, 1732, 1840, 1952, 2068, 2188, 2303, 2431, 2563, 2699, 2809, 2953,
];

const NAMES = Object.keys(JOIN_CODE_FIXTURES) as JoinCodeFixtureName[];
const V2_NAMES: JoinCodeFixtureName[] = ['v2-1-member', 'v2-2-members', 'v2-6-members'];
const CONTENT = V2_NAMES.map((n) => JOIN_CODE_FIXTURES[n].text).join('');
const WINDOW = 16;

function smallestVersion(chars: number): number {
	return ECC_L_BYTE_CAPACITY.findIndex((cap) => cap >= chars) + 1;
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

function matrixKey(text: string): string {
	const q = buildQrMatrix(text);
	let s = '';
	for (let r = 0; r < q.n; r++) for (let c = 0; c < q.n; c++) s += q.isDark(r, c) ? '1' : '0';
	return s;
}

describe('buildQrMatrix', () => {
	it('the capacity table has 40 ascending entries ending at QR_MAX_TEXT_CHARS', () => {
		expect(ECC_L_BYTE_CAPACITY.length).toBe(40);
		expect(ECC_L_BYTE_CAPACITY[39]).toBe(QR_MAX_TEXT_CHARS);
		for (let i = 1; i < 40; i++) expect(ECC_L_BYTE_CAPACITY[i] > ECC_L_BYTE_CAPACITY[i - 1]).toBe(true);
	});

	describe.each(NAMES)('fixture %s', (name) => {
		const fx = JOIN_CODE_FIXTURES[name];
		it('has the smallest ECC-L version that fits, inside 113..165', () => {
			const q = buildQrMatrix(fx.text);
			expect((q.n - 17) % 4).toBe(0);
			expect(q.n >= 113 && q.n <= 165).toBe(true);
			expect((q.n - 17) / 4).toBe(smallestVersion(fx.text.length));
		});
		it('has exact finder patterns with light separators', () => {
			const q = buildQrMatrix(fx.text);
			for (const [r0, c0] of [
				[0, 0],
				[0, q.n - 7],
				[q.n - 7, 0],
			]) {
				for (let r = 0; r < 7; r++) {
					for (let c = 0; c < 7; c++) {
						const ring = r === 0 || r === 6 || c === 0 || c === 6;
						const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
						expect(q.isDark(r0 + r, c0 + c)).toBe(ring || core);
					}
				}
			}
			for (let i = 0; i < 8; i++) {
				expect(q.isDark(7, i)).toBe(false);
				expect(q.isDark(i, 7)).toBe(false);
				expect(q.isDark(7, q.n - 8 + i)).toBe(false);
				expect(q.isDark(i, q.n - 8)).toBe(false);
				expect(q.isDark(q.n - 8, i)).toBe(false);
				expect(q.isDark(q.n - 8 + i, 7)).toBe(false);
			}
		});
		it('is deterministic', () => {
			expect(matrixKey(fx.text) === matrixKey(fx.text)).toBe(true);
		});
	});

	describe('every version 24..37', () => {
		const versions: number[] = [];
		for (let v = 24; v <= 37; v++) versions.push(v);
		it.each(versions)('version %i: capacity gives 17 + 4v, one more char gives the next', (v) => {
			const cap = ECC_L_BYTE_CAPACITY[v - 1];
			expect(buildQrMatrix(CONTENT.slice(0, cap)).n).toBe(17 + 4 * v);
			expect(buildQrMatrix(CONTENT.slice(0, cap + 1)).n).toBe(17 + 4 * (v + 1));
		});
	});

	describe('limits', () => {
		it('accepts 2953 chars as the largest version', () => {
			expect(buildQrMatrix(CONTENT.slice(0, 2953)).n).toBe(17 + 4 * 40);
		});
		it('throws QrOverflowError past the capacity', () => {
			for (const len of [2954, 5000]) {
				const err = thrown(() => buildQrMatrix(CONTENT.repeat(2).slice(0, len)));
				expect(err instanceof QrOverflowError).toBe(true);
				expect((err as QrOverflowError).code).toBe('overflow');
				expect((err as QrOverflowError).name).toBe('QrOverflowError');
			}
		});
	});

	describe('input refusals', () => {
		const text = JOIN_CODE_FIXTURES['v2-1-member'].text;
		const mid = Math.floor(text.length / 2);
		it('empty', () => {
			const err = thrown(() => buildQrMatrix(''));
			expect(err instanceof QrInputError).toBe(true);
			expect((err as QrInputError).code).toBe('empty');
		});
		it.each([null, undefined, 5])('not-string for %p', (v) => {
			const err = thrown(() => buildQrMatrix(v as unknown as string));
			expect(err instanceof QrInputError).toBe(true);
			expect((err as QrInputError).code).toBe('not-string');
		});
		it.each([
			['e-acute', 'é'],
			['newline', '\n'],
			['NUL', '\u0000'],
			['lone surrogate', '\ud800'],
		])('non-ascii for %s', (_label, ch) => {
			const bad = text.slice(0, mid) + ch + text.slice(mid);
			const err = thrown(() => buildQrMatrix(bad));
			expect(err instanceof QrInputError).toBe(true);
			expect((err as QrInputError).code).toBe('non-ascii');
			expect(windowHits(String(err), text)).toBe(0);
		});
		it('overflow error text carries no input slice', () => {
			const err = thrown(() => buildQrMatrix(CONTENT.slice(0, 2954)));
			expect(windowHits(String(err), CONTENT)).toBe(0);
		});
	});

	describe('result object', () => {
		const text = JOIN_CODE_FIXTURES['v2-1-member'].text;
		it('exposes only n and isDark and holds no window of the text', () => {
			const q = buildQrMatrix(text);
			expect(Object.keys(q).sort().join(',')).toBe('isDark,n');
			expect(windowHits(JSON.stringify(q), text)).toBe(0);
		});
		it('isDark rejects bad indices with RangeError', () => {
			const q = buildQrMatrix(text);
			for (const [r, c] of [
				[-1, 0],
				[q.n, 0],
				[0, q.n],
				[1.5, 0],
				[0, Number.NaN],
			]) {
				expect(thrown(() => q.isDark(r, c)) instanceof RangeError).toBe(true);
			}
		});
	});

	describe('console hygiene', () => {
		it('logs nothing', () => {
			const c = captureConsole();
			try {
				for (const name of NAMES) buildQrMatrix(JOIN_CODE_FIXTURES[name].text);
				thrown(() => buildQrMatrix(''));
				thrown(() => buildQrMatrix(CONTENT.slice(0, 2954)));
				expect(c.calls().length).toBe(0);
				expectNoSecretInConsole(c, [CONTENT]);
			} finally {
				c.restore();
			}
		});
	});
});
