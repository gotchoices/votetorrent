/**
 * file-share.ts — JS wrapper over the `writeShareFile` / `shareFile` TurboModule methods
 * (Phase 62 plan 75, D-36: hand a founding bundle off AS A FILE through the OS share sheet).
 *
 * Same lazy-native rule as `secret-wrap.ts`: `getNative()` requires the TurboModule inside each
 * call, never at module scope, because `TurboModuleRegistry.getEnforcing` throws under Node/jest.
 * Only a failure to reach the module, or a binary that predates these methods, surfaces as
 * `FileShareError('unavailable')` (from `resolveNative`) so callers can fall back instead of
 * crashing. A rejection from the native call itself is a real failure: a recognised native code
 * maps to its own code, and anything else (unknown or missing code) maps to the method's
 * fallback, `write-failed` or `share-failed` — never `unavailable`, which callers read as "old
 * binary" and answer with a text share.
 */
import { Platform } from 'react-native'
import type { Spec as NativeAttestationSpec } from './specs/NativeAttestation'

export type FileShareErrorCode = 'unavailable' | 'invalid-name' | 'write-failed' | 'share-failed' | 'unsupported'

export class FileShareError extends Error {
	readonly code: FileShareErrorCode

	constructor(code: FileShareErrorCode, message: string) {
		super(message)
		this.name = 'FileShareError'
		this.code = code
	}
}

/** Mirror of the native rule: `[A-Za-z0-9._-]{1,100}` and no `..`. */
const FILE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/

const NATIVE_CODE_MAP: Readonly<Record<string, FileShareErrorCode>> = {
	INVALID_NAME: 'invalid-name',
	WRITE_FAILED: 'write-failed',
	SHARE_FAILED: 'share-failed',
	UNSUPPORTED: 'unsupported',
}

function getNative(): NativeAttestationSpec {
	// eslint-disable-next-line @typescript-eslint/no-var-requires -- deliberate lazy require, mirrors secret-wrap.ts.
	return require('./specs/NativeAttestation').default as NativeAttestationSpec
}

function resolveNative(method: 'writeShareFile' | 'shareFile' | 'deleteCachedFile'): NativeAttestationSpec {
	let native: NativeAttestationSpec
	try {
		native = getNative()
	} catch (e) {
		throw new FileShareError('unavailable', `AttestationNative is not available: ${(e as Error).message}`)
	}
	if (!native || typeof native[method] !== 'function') {
		throw new FileShareError('unavailable', `this build does not include AttestationNative.${method}`)
	}
	return native
}

/**
 * Maps a rejection from a native file-share call. A FileShareError passes through; a recognised
 * native code wins; anything else becomes `fallback`. Never yields `unavailable` — that code is
 * reserved for `resolveNative` (module or method missing from the binary).
 */
function mapNativeError(e: unknown, fallback: 'write-failed' | 'share-failed'): FileShareError {
	if (e instanceof FileShareError) return e
	const code = (e as { code?: unknown } | null | undefined)?.code
	// Own-property check: a native code such as 'toString' must not resolve through the prototype.
	const mapped =
		typeof code === 'string' && Object.prototype.hasOwnProperty.call(NATIVE_CODE_MAP, code)
			? NATIVE_CODE_MAP[code]
			: undefined
	const message = (e as { message?: unknown } | null | undefined)?.message
	return new FileShareError(mapped ?? fallback, typeof message === 'string' ? message : 'file share failed')
}

/**
 * Writes `contents` to a per-app cache file and resolves its `file://` URI. `fileName` is refused
 * (`invalid-name`) before any native call if it has a path separator, `..`, or characters outside
 * `[A-Za-z0-9._-]`.
 */
export async function writeShareFile(fileName: string, contents: string): Promise<string> {
	if (!FILE_NAME_PATTERN.test(fileName) || fileName.includes('..')) {
		throw new FileShareError('invalid-name', 'file name must match [A-Za-z0-9._-]{1,100} and not contain ".."')
	}
	const native = resolveNative('writeShareFile')
	try {
		const result = (await native.writeShareFile(fileName, contents)) as { uri?: unknown }
		if (typeof result?.uri !== 'string' || result.uri.length === 0) {
			throw new FileShareError('write-failed', 'native writeShareFile resolved without a uri')
		}
		return result.uri
	} catch (e) {
		throw mapNativeError(e, 'write-failed')
	}
}

/** Android only: shares the cache file at `uri` as a file (ACTION_SEND + EXTRA_STREAM). */
export async function shareFileAndroid(
	uri: string,
	opts: { mimeType: string; subject: string; dialogTitle: string },
): Promise<void> {
	if (Platform.OS !== 'android') {
		throw new FileShareError('unsupported', 'shareFileAndroid is Android-only; use Share.share({ url }) on iOS')
	}
	const native = resolveNative('shareFile')
	try {
		await native.shareFile(uri, opts.mimeType, opts.subject, opts.dialogTitle)
	} catch (e) {
		throw mapNativeError(e, 'share-failed')
	}
}

/**
 * Deletes a file the app itself cached (e.g. a document-picker copy). Native refuses anything that
 * is not a regular file strictly inside the app cache directory. NEVER throws: resolves `true` only
 * when native reports the file deleted; a non-`file://` uri, a missing module or method, or any
 * native rejection resolves `false`.
 */
export async function deleteCachedFile(uri: string): Promise<boolean> {
	if (typeof uri !== 'string' || !uri.startsWith('file://')) return false
	try {
		const native = resolveNative('deleteCachedFile')
		const result = (await native.deleteCachedFile(uri)) as { deleted?: unknown } | null | undefined
		return result?.deleted === true
	} catch {
		return false
	}
}
