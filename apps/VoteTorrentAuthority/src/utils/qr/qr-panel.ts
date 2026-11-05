/**
 * qr-panel.ts - Phase 64 Plan 10 (D-03, notes 4.8). The on-screen QR panel as a PNG: dark modules
 * are exactly 0x00, everything else exactly 0xFF, m whole pixels per module, a 4-module quiet zone
 * on every side, the largest square that fits the target. The same bytes feed the screen Image and
 * jest, so the geometry measured in jest is the geometry on the device.
 *
 * The join code is a bearer credential (D-06): no logging, no caching of text or PNG here.
 */

import { bytesToBase64, encodeGray8Png } from './gray-png';
import { buildQrMatrix, type QrMatrix } from './qr-matrix';
import { QR_QUIET_MODULES, qrLayout } from './qr-layout';

export interface QrPanelPng {
	readonly png: Uint8Array;
	readonly base64: string;
	readonly n: number;
	readonly m: number;
	readonly panelPx: number;
}

/** Writes 0x00 for each dark module as an m x m block at (x0 + c*m, y0 + r*m). */
export function drawQrModules(
	canvas: Uint8Array,
	stride: number,
	matrix: QrMatrix,
	m: number,
	x0: number,
	y0: number,
): void {
	const side = matrix.n * m;
	const rows = stride > 0 ? Math.floor(canvas.length / stride) : 0;
	if (
		!Number.isInteger(stride) ||
		!Number.isInteger(m) ||
		!Number.isInteger(x0) ||
		!Number.isInteger(y0) ||
		m < 1 ||
		x0 < 0 ||
		y0 < 0 ||
		x0 + side > stride ||
		y0 + side > rows
	) {
		throw new RangeError('qr-panel: modules fall outside the canvas');
	}
	for (let r = 0; r < matrix.n; r++) {
		for (let c = 0; c < matrix.n; c++) {
			if (!matrix.isDark(r, c)) continue;
			for (let dy = 0; dy < m; dy++) {
				const start = (y0 + r * m + dy) * stride + x0 + c * m;
				canvas.fill(0, start, start + m);
			}
		}
	}
}

export function buildQrPanelPng(text: string, targetPx: number): QrPanelPng {
	const matrix = buildQrMatrix(text);
	const layout = qrLayout(matrix.n, targetPx);
	const canvas = new Uint8Array(layout.panelPx * layout.panelPx).fill(0xff);
	const quiet = QR_QUIET_MODULES * layout.m;
	drawQrModules(canvas, layout.panelPx, matrix, layout.m, quiet, quiet);
	const png = encodeGray8Png(layout.panelPx, layout.panelPx, canvas);
	return { png, base64: bytesToBase64(png), n: matrix.n, m: layout.m, panelPx: layout.panelPx };
}
