/**
 * qr-share.ts - share the join-code QR, or a keyholder invitation's QR, as a PNG image (Phase 64 plan 17; notes 4.8).
 *
 * D-04: the PNG holds the QR and the network fingerprint only, so this module takes only those two
 * inputs. It is built with `buildShareQrPng`, written to the cache directory, shared and deleted.
 *
 * D-06: the PNG IS the credential in image form. It lives in the cache dir only, under a constant
 * file name that holds no fragment of the code, and is deleted on settle (here), on Modal close and
 * on view or card unmount (the callers). It is never a data URL, and logging is a closed token only.
 *
 * Why `file://` plus `useInternalStorage: true`: react-native-share's base64 branch writes its own
 * copy that nothing deletes (RESEARCH scope 4), and the external cache dir is not in the provider's
 * path map. `SaveToCameraRoll` is excluded on iOS so the app offers no gallery save. The Android
 * cleanup race (a target still reading when the file goes) is accepted in RESEARCH scope 4 and
 * pitfall 12, hence the delete on settle AND on close and unmount.
 */
import Share from 'react-native-share';
import { CachesDirectoryPath, exists, unlink, writeFile } from '@dr.pogodin/react-native-fs';
import { bytesToBase64 } from '../utils/qr/gray-png';
import { buildShareQrPng } from '../utils/qr/share-png';
import { buildInviteSharePng } from '../utils/qr/invite-qr';

/** The cache-dir file the share PNG is written to. Constant, with no code fragment in it. */
export const SHARED_QR_IMAGE_FILENAME = 'votetorrent-join-code.png';

/** The cache-dir file the invitation QR PNG is written to. Constant, with no fragment of the invitation. */
export const SHARED_INVITATION_QR_IMAGE_FILENAME = 'votetorrent-invitation.png';

export type QrShareErrorCode = 'build-failed' | 'write-failed' | 'share-failed';

const MESSAGES: Record<QrShareErrorCode, string> = {
	'build-failed': 'qr-share: the image could not be built',
	'write-failed': 'qr-share: the image could not be written',
	'share-failed': 'qr-share: the share sheet failed',
};

export class QrShareError extends Error {
	readonly code: QrShareErrorCode;
	constructor(code: QrShareErrorCode) {
		super(MESSAGES[code]);
		this.name = 'QrShareError';
		this.code = code;
	}
}

function sharedQrImagePath(): string {
	return CachesDirectoryPath + '/' + SHARED_QR_IMAGE_FILENAME;
}

function sharedInvitationQrImagePath(): string {
	return CachesDirectoryPath + '/' + SHARED_INVITATION_QR_IMAGE_FILENAME;
}

/** Delete `p` if it is there. True when the delete failed (a missing file is not a failure). Never rejects. */
async function deleteCacheFile(p: string): Promise<boolean> {
	try {
		if (await exists(p)) await unlink(p);
		return false;
	} catch (e) {
		return (e as { code?: unknown } | null)?.code !== 'ENOENT';
	}
}

// Each caller logs its own closed literal tag: a tag passed in as a variable is a non-literal console
// argument, which the console-leak rule refuses even when every value it can take is a fixed string.

/** Delete the cache PNG. Idempotent: a missing file is fine. Never rejects. */
export async function deleteSharedQrImage(): Promise<void> {
	if (await deleteCacheFile(sharedQrImagePath())) {
		// eslint-disable-next-line no-console -- closed token only, never a code, path or native text.
		console.info('[voter-invite] qr-share: failed');
	}
}

/** Delete the invitation's cache PNG. Idempotent: a missing file is fine. Never rejects. */
export async function deleteSharedInvitationQrImage(): Promise<void> {
	if (await deleteCacheFile(sharedInvitationQrImagePath())) {
		// eslint-disable-next-line no-console -- closed token only, never a code, path or native text.
		console.info('[invite] qr-share: failed');
	}
}

/** Write `png` to `path`, open the share sheet on it, and report how the sheet settled. */
async function sharePngFile(path: string, filename: string, build: () => Uint8Array): Promise<'shared' | 'dismissed'> {
	let png: Uint8Array;
	try {
		png = build();
	} catch {
		throw new QrShareError('build-failed');
	}
	try {
		await writeFile(path, bytesToBase64(png), 'base64');
	} catch {
		throw new QrShareError('write-failed');
	}
	let result: { success?: boolean } | undefined;
	try {
		result = await Share.open({
			url: 'file://' + path,
			type: 'image/png',
			filename,
			failOnCancel: false,
			useInternalStorage: true,
			excludedActivityTypes: ['com.apple.UIKit.activity.SaveToCameraRoll'],
		});
	} catch {
		throw new QrShareError('share-failed');
	}
	return result?.success === true ? 'shared' : 'dismissed';
}

/**
 * Build the share PNG, write it to the cache dir, open the share sheet on it and delete it once the
 * sheet settles. Any failure is a `QrShareError` with a fixed message; the caller logs the token.
 */
export async function shareJoinCodeQrImage(a: { code: string; fingerprint: string }): Promise<'shared' | 'dismissed'> {
	try {
		return await sharePngFile(sharedQrImagePath(), 'votetorrent-join-code', () => buildShareQrPng(a.code, a.fingerprint));
	} finally {
		await deleteSharedQrImage();
	}
}

/**
 * The same for an invitation: the PNG is the QR only (`buildInviteSharePng`), written under a fixed
 * name, shared, and deleted once the sheet settles. The image IS the invitation, so it is never saved
 * to the photo library from here (iOS excludes Save Image) and never outlives the share.
 */
export async function shareInvitationQrImage(text: string): Promise<'shared' | 'dismissed'> {
	try {
		return await sharePngFile(sharedInvitationQrImagePath(), 'votetorrent-invitation', () => buildInviteSharePng(text));
	} finally {
		await deleteSharedInvitationQrImage();
	}
}
