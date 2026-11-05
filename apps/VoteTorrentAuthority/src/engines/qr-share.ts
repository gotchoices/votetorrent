/**
 * qr-share.ts - share the join-code QR as a PNG image (Phase 64 plan 17; notes 4.8).
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

/** The cache-dir file the share PNG is written to. Constant, with no code fragment in it. */
export const SHARED_QR_IMAGE_FILENAME = 'votetorrent-join-code.png';

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

/** Delete the cache PNG. Idempotent: a missing file is fine. Never rejects. */
export async function deleteSharedQrImage(): Promise<void> {
	try {
		const p = sharedQrImagePath();
		if (await exists(p)) await unlink(p);
	} catch (e) {
		if ((e as { code?: unknown } | null)?.code === 'ENOENT') return;
		// eslint-disable-next-line no-console -- closed token only, never a code, path or native text.
		console.info('[voter-invite] qr-share: failed');
	}
}

/**
 * Build the share PNG, write it to the cache dir, open the share sheet on it and delete it once the
 * sheet settles. Any failure is a `QrShareError` with a fixed message; the caller logs the token.
 */
export async function shareJoinCodeQrImage(a: { code: string; fingerprint: string }): Promise<'shared' | 'dismissed'> {
	const path = sharedQrImagePath();
	try {
		let png: Uint8Array;
		try {
			png = buildShareQrPng(a.code, a.fingerprint);
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
				filename: 'votetorrent-join-code',
				failOnCancel: false,
				useInternalStorage: true,
				excludedActivityTypes: ['com.apple.UIKit.activity.SaveToCameraRoll'],
			});
		} catch {
			throw new QrShareError('share-failed');
		}
		return result?.success === true ? 'shared' : 'dismissed';
	} finally {
		await deleteSharedQrImage();
	}
}
