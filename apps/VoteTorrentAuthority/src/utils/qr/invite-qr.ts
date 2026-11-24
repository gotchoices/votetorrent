/**
 * invite-qr.ts - the keyholder invitation as a QR code: the on-screen panel and the shareable PNG.
 *
 * The QR carries the invitation text exactly as Share and Copy send it (the ASCII-only JSON from
 * `serializeInviteShare`), so a scan, a decoded image and a paste all hand the same characters to
 * the accept screen.
 *
 * Error correction M. A realistic invitation is about 240 characters (a 64-hex private key, a
 * 66-hex public key, an ISO expiration, the type and the invitee's name). At M that is QR version
 * 11 (61 modules); L would be version 10 (57), Q version 13 (69), H version 16 (81). M recovers
 * about 15% of damaged modules, which helps a photo of a screen with glare or a re-compressed
 * screenshot, while keeping the modules large enough to read at arm's length. Capacity at M is 2331
 * characters, so even a long, fully escaped non-ASCII name fits; anything longer fails closed and
 * the screen points to Share and Copy.
 *
 * The invitation holds its private key. Nothing here logs, caches or keeps the text; errors are the
 * fixed-message QR errors from qr-matrix and qr-layout.
 */

import { encodeGray8Png } from './gray-png';
import { buildQrMatrix, type QrErrorCorrectionLevel } from './qr-matrix';
import { buildQrPanelPng, drawQrModules, type QrPanelPng } from './qr-panel';
import { qrLayout } from './qr-layout';

export const INVITE_QR_LEVEL: QrErrorCorrectionLevel = 'M';

/** The shareable invitation PNG is a 1080 x 1080 grayscale square: the QR and its quiet zone only. */
export const INVITE_SHARE_PNG_PX = 1080;

/** The on-screen panel for an invitation: largest whole-pixel modules that fit `targetPx`. */
export function buildInviteQrPanelPng(text: string, targetPx: number): QrPanelPng {
	return buildQrPanelPng(text, targetPx, INVITE_QR_LEVEL);
}

/**
 * The PNG behind "Share QR image": the QR centred on white with at least a 4-module quiet zone.
 * No name, expiry or other text is drawn, so the image carries nothing beyond the invitation itself.
 */
export function buildInviteSharePng(text: string): Uint8Array {
	const matrix = buildQrMatrix(text, INVITE_QR_LEVEL);
	const { m } = qrLayout(matrix.n, INVITE_SHARE_PNG_PX);
	const off = Math.floor((INVITE_SHARE_PNG_PX - m * matrix.n) / 2);
	const canvas = new Uint8Array(INVITE_SHARE_PNG_PX * INVITE_SHARE_PNG_PX).fill(0xff);
	drawQrModules(canvas, INVITE_SHARE_PNG_PX, matrix, m, off, off);
	return encodeGray8Png(INVITE_SHARE_PNG_PX, INVITE_SHARE_PNG_PX, canvas);
}
