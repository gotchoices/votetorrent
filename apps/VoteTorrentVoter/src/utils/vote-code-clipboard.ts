/**
 * @format
 *
 * vote-code-clipboard.ts: the app's ONLY reference to the clipboard package.
 *
 * D-17: a vote code is copied only on an explicit tap. The caller shows the warning beside the
 * button, and there is no share sheet.
 *
 * The require is lazy on purpose. The package calls `TurboModuleRegistry.getEnforcing("RNCClipboard")`
 * at module load, and the navigation tree eagerly imports every screen. A top-level import would
 * red-box app start on any binary without the native module (a debug APK built before it was
 * linked, or an iOS build before `pod install`). With the lazy require only the copy action
 * fails, and it fails gracefully.
 *
 * WR-03 (review): the copy goes through attestation-native's synchronous `copySensitiveText` first.
 * Android marks the clip EXTRA_IS_SENSITIVE (no overlay preview, kept out of keyboard clipboard
 * history) and clears it after 60 s if it is still ours and the app can still see the clipboard;
 * iOS writes a local-only pasteboard item that expires after 60 s. Only a binary WITHOUT that native
 * method ('unsupported': an older APK, or jest) falls back to the plain clipboard package, unmarked
 * and with no clear; reading the clipboard back to clear it would itself trigger Android 12+'s
 * "pasted from your clipboard" notice. A native attempt that fails reports 'unavailable' and never
 * falls back to the unmarked path.
 */
import {copySensitiveText} from '@votetorrent/attestation-native';

export type VoteCodeCopyResult = 'copied' | 'unavailable';

const VOTE_CODE_RE = /^[0-9a-f]{64}$/;

export function copyVoteCode(nonce: string): VoteCodeCopyResult {
	if (typeof nonce !== 'string' || !VOTE_CODE_RE.test(nonce)) {
		throw new TypeError('vote code must be 64 lowercase hex characters');
	}
	const sensitive = copySensitiveText(nonce);
	if (sensitive === 'copied') {
		return 'copied';
	}
	if (sensitive === 'failed') {
		return 'unavailable';
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const clipboard = require('@react-native-clipboard/clipboard') as {
			default: {setString(content: string): void};
		};
		clipboard.default.setString(nonce);
		return 'copied';
	} catch {
		return 'unavailable';
	}
}
