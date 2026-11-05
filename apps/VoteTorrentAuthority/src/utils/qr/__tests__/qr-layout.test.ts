/**
 * qr-layout.test.ts - Phase 64 Plan 10 (D-03). The integer-module layout over every module count in
 * range and the three surface targets plus the thumbnail target.
 */

import { QR_QUIET_MODULES, QrLayoutError, qrLayout } from '../qr-layout';

const SIZES: number[] = [];
for (let v = 24; v <= 37; v++) SIZES.push(17 + 4 * v);
const TARGETS = [1080, 720, 411 * 2.625, 160 * 2.625];

function code(fn: () => unknown): string | undefined {
	try {
		fn();
	} catch (e) {
		return e instanceof QrLayoutError ? e.code : 'other';
	}
	return undefined;
}

describe('qrLayout', () => {
	it('quiet zone is 4 modules', () => {
		expect(QR_QUIET_MODULES).toBe(4);
	});

	describe.each(SIZES)('n = %i', (n) => {
		it.each(TARGETS)('target %f is the largest integer fit', (t) => {
			const l = qrLayout(n, t);
			expect(l.m).toBe(Math.floor(t / (n + 8)));
			expect(Number.isInteger(l.m) && l.m >= 1).toBe(true);
			expect(l.qrPx).toBe(l.m * n);
			expect(l.quietPx).toBe(4 * l.m);
			expect(l.panelPx).toBe(l.m * (n + 8));
			expect(l.panelPx <= t).toBe(true);
			expect(l.panelPx > t - (n + 8)).toBe(true);
			expect((l.panelPx - l.qrPx) / 2).toBe(l.quietPx);
		});
		it('has at least 6 px per module at 1080', () => {
			expect(qrLayout(n, 1080).m >= 6).toBe(true);
		});
		it('refuses a target one pixel short and accepts one pixel per module', () => {
			expect(code(() => qrLayout(n, n + 7))).toBe('target-too-small');
			expect(qrLayout(n, n + 8).m).toBe(1);
		});
	});

	it.each([0, 20, 112, 114, 166, 181, 113.5, Number.NaN])('refuses module count %p', (n) => {
		expect(code(() => qrLayout(n, 1080))).toBe('invalid-module-count');
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses target %p', (t) => {
		expect(code(() => qrLayout(25, t))).toBe('invalid-target');
	});
});
