/**
 * qr-layout.ts - Phase 64 Plan 10 (D-03). Integer-module layout: the largest whole number of pixels
 * per module m such that the QR plus a 4-module quiet zone on every side fits the target square.
 * Pure arithmetic; it never sees the code text.
 */

export const QR_QUIET_MODULES = 4;

export type QrLayoutErrorCode = 'invalid-module-count' | 'invalid-target' | 'target-too-small';

const LAYOUT_MESSAGES: Record<QrLayoutErrorCode, string> = {
	'invalid-module-count': 'qr-layout: invalid module count',
	'invalid-target': 'qr-layout: invalid target size',
	'target-too-small': 'qr-layout: target smaller than one pixel per module',
};

export class QrLayoutError extends Error {
	readonly code: QrLayoutErrorCode;
	constructor(code: QrLayoutErrorCode) {
		super(LAYOUT_MESSAGES[code]);
		this.name = 'QrLayoutError';
		this.code = code;
	}
}

export interface QrLayout {
	readonly m: number;
	readonly qrPx: number;
	readonly quietPx: number;
	readonly panelPx: number;
}

export function qrLayout(n: number, targetPx: number): QrLayout {
	if (!Number.isInteger(n) || n < 21 || n > 177 || (n - 17) % 4 !== 0) {
		throw new QrLayoutError('invalid-module-count');
	}
	if (typeof targetPx !== 'number' || !Number.isFinite(targetPx) || targetPx <= 0) {
		throw new QrLayoutError('invalid-target');
	}
	const span = n + 2 * QR_QUIET_MODULES;
	const m = Math.floor(targetPx / span);
	if (m < 1) throw new QrLayoutError('target-too-small');
	return { m, qrPx: m * n, quietPx: QR_QUIET_MODULES * m, panelPx: m * span };
}
