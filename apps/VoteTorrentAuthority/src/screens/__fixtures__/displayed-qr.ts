/**
 * displayed-qr.ts - what a camera reads off the Authority's voter-invite QR, on the host.
 *
 * Builds the QR panel PNG exactly as the "Invite voters" card does (`buildQrPanelPng`, which
 * `tryBuildQrPanel` in VoterInviteQrView wraps), decodes the PNG's pixels back with pngjs, and reads
 * the QR with jsQR. The returned text is the payload a scanner hands to `onAccept`.
 *
 * Pure: it imports no React Native module, so the Voter's jest suite can import this file by a
 * relative path and prove its scanner accepts what the Authority shows. jsqr and pngjs resolve from
 * the Authority's own node_modules (the Authority's devDependencies).
 */

import jsQR from 'jsqr';
import { base64ToBytes } from '../../utils/qr/gray-png';
import { buildQrPanelPng } from '../../utils/qr/qr-panel';

interface DecodedPng {
	width: number;
	height: number;
	data: Uint8Array;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PNG } = require('pngjs') as { PNG: { sync: { read(data: Uint8Array): DecodedPng } } };

/** The card's thumbnail (160 dp at a 3x screen) and a full-screen QR view on a 1080 px wide phone. */
export const DISPLAYED_QR_TARGETS_PX = [160 * 3, 1080] as const;

/** The base64 PNG the card shows for `code` at `targetPx`. */
export function displayedQrBase64(code: string, targetPx: number): string {
	return buildQrPanelPng(code, targetPx).base64;
}

/** The text a QR reader gets from the PNG the card shows for `code`, or null when nothing reads. */
export function readDisplayedQr(code: string, targetPx: number): string | null {
	const png = base64ToBytes(displayedQrBase64(code, targetPx));
	const img = PNG.sync.read(Buffer.from(png));
	const found = jsQR(new Uint8ClampedArray(img.data), img.width, img.height, { inversionAttempts: 'dontInvert' });
	return found === null ? null : found.data;
}
