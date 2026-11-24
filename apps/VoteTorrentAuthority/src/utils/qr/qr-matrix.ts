/**
 * qr-matrix.ts - Phase 64 Plan 10 (D-03, notes 4.8). The QR module matrix for the join code, over
 * qrcode-generator 2.0.4 in Byte mode (auto version). Error correction is L unless the caller asks
 * for another level: the keyholder invitation QR uses M (see utils/qr/invite-qr.ts).
 *
 * The join code is a bearer credential (D-06): nothing here logs, reads a caught error's text or
 * keeps the input reachable. The result is a snapshot of the modules only. Error messages are fixed
 * text with no slice of the input.
 *
 * Input is restricted to printable ASCII (0x20..0x7e): the library's default Byte converter keeps
 * only the low byte of each char, so anything wider would be silently corrupted.
 */

import qrcode from 'qrcode-generator';

/** Byte-mode capacity of version 40 at error correction L. */
export const QR_MAX_TEXT_CHARS = 2953;

export type QrErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

/** Byte-mode capacity of version 40 at each error correction level (ISO/IEC 18004 table 7). */
export const QR_MAX_TEXT_CHARS_BY_LEVEL: Readonly<Record<QrErrorCorrectionLevel, number>> = {
	L: QR_MAX_TEXT_CHARS,
	M: 2331,
	Q: 1663,
	H: 1273,
};

export type QrInputErrorCode = 'not-string' | 'empty' | 'non-ascii';

const INPUT_MESSAGES: Record<QrInputErrorCode, string> = {
	'not-string': 'qr: input is not a string',
	empty: 'qr: input is empty',
	'non-ascii': 'qr: input has a character outside printable ASCII',
};

export class QrInputError extends Error {
	readonly code: QrInputErrorCode;
	constructor(code: QrInputErrorCode) {
		super(INPUT_MESSAGES[code]);
		this.name = 'QrInputError';
		this.code = code;
	}
}

export class QrOverflowError extends Error {
	readonly code: 'overflow';
	constructor() {
		super('qr: input exceeds the QR capacity at its error correction level');
		this.name = 'QrOverflowError';
		this.code = 'overflow';
	}
}

export interface QrMatrix {
	readonly n: number;
	isDark(r: number, c: number): boolean;
}

export function buildQrMatrix(text: string, level: QrErrorCorrectionLevel = 'L'): QrMatrix {
	if (typeof text !== 'string') throw new QrInputError('not-string');
	if (text.length === 0) throw new QrInputError('empty');
	const capacity = QR_MAX_TEXT_CHARS_BY_LEVEL[level];
	if (capacity === undefined) throw new QrOverflowError();
	if (text.length > capacity) throw new QrOverflowError();
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		if (ch < 0x20 || ch > 0x7e) throw new QrInputError('non-ascii');
	}

	let n = 0;
	let modules: Uint8Array;
	try {
		const qr = qrcode(0, level);
		qr.addData(text, 'Byte');
		qr.make();
		n = qr.getModuleCount();
		modules = new Uint8Array(n * n);
		for (let r = 0; r < n; r++) {
			for (let c = 0; c < n; c++) modules[r * n + c] = qr.isDark(r, c) ? 1 : 0;
		}
	} catch {
		throw new QrOverflowError();
	}

	const size = n;
	const snapshot = modules;
	return {
		n: size,
		isDark(r: number, c: number): boolean {
			if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= size || c >= size) {
				throw new RangeError('qr-matrix: module index out of range');
			}
			return snapshot[r * size + c] === 1;
		},
	};
}
