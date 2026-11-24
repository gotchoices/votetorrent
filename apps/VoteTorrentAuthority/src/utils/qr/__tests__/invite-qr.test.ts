/**
 * invite-qr.test.ts - the keyholder invitation QR: it fits, it uses error correction M, and what a
 * reader gets back from the on-screen panel and the shared PNG is the invitation text byte for byte.
 *
 * The invitations are built exactly as KeyholderInvitationScreen builds them (a fresh secp256k1
 * key pair, an ISO expiration from the presets, serializeInviteShare). Text comparisons are boolean
 * so a failing matcher never prints a private key.
 */
import qrcode from 'qrcode-generator';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { parseInviteShare, serializeInviteShare } from '../../../screens/invitations/invite-share';
import { keyholderInviteExpiration } from '../../../screens/keyholder/keyholder-invite-expiry';
import { pngSize, readQrPng, readQrPngBase64, readQrPngRaw } from '../../../screens/__fixtures__/read-qr-png';
import { buildInviteQrPanelPng, buildInviteSharePng, INVITE_QR_LEVEL, INVITE_SHARE_PNG_PX, tryBuildInvitationQr } from '../invite-qr';
import { QR_MAX_TEXT_CHARS_BY_LEVEL, QrOverflowError, buildQrMatrix } from '../qr-matrix';

function invitation(name: string, hours = 168): string {
	const priv = secp256k1.utils.randomSecretKey();
	return serializeInviteShare({
		invitePrivate: bytesToHex(priv),
		inviteKey: bytesToHex(secp256k1.getPublicKey(priv)),
		expiration: keyholderInviteExpiration(Date.UTC(2026, 10, 24, 9, 30, 0, 123), hours),
		type: 'k',
		name,
	});
}

/** QR version qrcode-generator picks for `text` at `level`. */
function versionAt(text: string, level: 'L' | 'M' | 'Q' | 'H'): number {
	const qr = qrcode(0, level);
	qr.addData(text, 'Byte');
	qr.make();
	return (qr.getModuleCount() - 17) / 4;
}

const asciiBytes = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0));

describe('the invitation text', () => {
	it('a realistic invitation is about 240 printable-ASCII characters', () => {
		const text = invitation('Ada Keyholder');
		expect(text.length).toBeGreaterThanOrEqual(230);
		expect(text.length).toBeLessThanOrEqual(260);
		expect(/^[\x20-\x7e]+$/.test(text)).toBe(true);
	});

	it('an ASCII name serialises exactly as JSON.stringify did before', () => {
		const text = invitation('Kay Holder');
		const obj = JSON.parse(text);
		expect(text === JSON.stringify(obj)).toBe(true);
		expect(Object.keys(obj)).toEqual(['invitePrivate', 'inviteKey', 'expiration', 'type', 'name']);
	});

	it('a non-ASCII name is escaped to ASCII and parses back to the same name and key', () => {
		const name = 'José Núñez 李雷 😀';
		const text = invitation(name);
		expect(/^[\x20-\x7e]+$/.test(text)).toBe(true);
		const parsed = parseInviteShare(text);
		expect(parsed?.name === name).toBe(true);
		expect(parsed?.type).toBe('k');
		expect(JSON.parse(text).invitePrivate === parsed?.invitePrivate).toBe(true);
	});
});

describe('capacity and error correction', () => {
	it('uses error correction M', () => {
		expect(INVITE_QR_LEVEL).toBe('M');
	});

	it('a realistic invitation is QR version 11 at M (61 modules), between L and Q', () => {
		const text = invitation('Ada Keyholder');
		expect(versionAt(text, 'M')).toBe(11);
		expect(buildQrMatrix(text, 'M').n).toBe(61);
		expect(versionAt(text, 'L')).toBeLessThan(versionAt(text, 'M'));
		expect(versionAt(text, 'Q')).toBeGreaterThan(versionAt(text, 'M'));
	});

	it('a long, fully escaped non-ASCII name still fits at M with room to spare', () => {
		const text = invitation('Ñ'.repeat(120));
		expect(text.length).toBeLessThan(QR_MAX_TEXT_CHARS_BY_LEVEL.M / 2);
		expect(() => buildQrMatrix(text, 'M')).not.toThrow();
	});

	it('text past the M capacity fails closed: a fixed error, and the panel reports not ok', () => {
		const over = 'x'.repeat(QR_MAX_TEXT_CHARS_BY_LEVEL.M + 1);
		expect(() => buildQrMatrix(over, 'M')).toThrow(QrOverflowError);
		expect(tryBuildInvitationQr(over, 1000).ok).toBe(false);
		// The L capacity is unchanged for join codes.
		expect(() => buildQrMatrix(over, 'L')).not.toThrow();
	});
});

describe('round trip: what a reader gets back', () => {
	const names = ['Ada Keyholder', 'José Núñez 李雷 😀', 'O\'Brien "Kay" \\ Holder'];

	it.each(names)('the on-screen panel for %j reads back byte for byte at phone sizes', (name) => {
		const text = invitation(name);
		// A 360 dp phone at 2x, 3x and 2.75x, minus the 32 dp gutter; and the 360 dp cap at 3x.
		for (const targetPx of [656, 984, 902, 1080]) {
			const panel = buildInviteQrPanelPng(text, targetPx);
			const read = readQrPngRaw(panel.png);
			expect(read !== null && read.data === text).toBe(true);
			expect(read !== null && JSON.stringify(read.bytes) === JSON.stringify(asciiBytes(text))).toBe(true);
			expect(read?.version).toBe(versionAt(text, 'M'));
			expect(panel.panelPx).toBeLessThanOrEqual(targetPx);
			// The screen's builder draws the same PNG.
			const attempt = tryBuildInvitationQr(text, targetPx);
			expect(attempt.ok && attempt.base64 === panel.base64).toBe(true);
			expect(attempt.ok && readQrPngBase64(attempt.base64) === text).toBe(true);
		}
	});

	it.each(names)('the shared PNG for %j is 1080 x 1080 and reads back byte for byte', (name) => {
		const text = invitation(name);
		const png = buildInviteSharePng(text);
		expect(pngSize(png)).toEqual({ width: INVITE_SHARE_PNG_PX, height: INVITE_SHARE_PNG_PX });
		const read = readQrPngRaw(png);
		expect(read !== null && read.data === text).toBe(true);
		expect(read !== null && JSON.stringify(read.bytes) === JSON.stringify(asciiBytes(text))).toBe(true);
		expect(parseInviteShare(readQrPng(png) ?? '')?.name === name).toBe(true);
	});
});
