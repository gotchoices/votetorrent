/**
 * pick-founding-bundle-file.ts — the never-throwing D-36 picker seam.
 *
 * Purpose: `ImportFoundingBundleScreen.tsx` (D-35, D-36, D-37 — Authority only) needs a document
 * picker to let an officer choose the founding-bundle file a sibling device exported through the
 * OS share sheet. This module is the ONLY place `@react-native-documents/picker` is referenced —
 * every call into the native module is funneled through `pickFoundingBundleFile()`, which never
 * rejects: every failure mode (cancel, oversized file, a bad copy, an unreadable file) resolves a
 * typed `PickedFoundingBundleFile` instead.
 *
 * JEST SAFETY (mirrors `device-signer.ts`'s `getNative()` comment, same reasoning): the picker
 * package's module scope runs `TurboModuleRegistry.getEnforcing('RNDocumentPicker')`
 * (`src/spec/NativeDocumentPicker.ts`), which throws under Node/jest whenever the native module
 * is not registered. `App.test.tsx` and the navigation suites eagerly require every screen module
 * (`navigation/index.tsx`'s static imports), so if this file touched the picker package at MODULE
 * scope, every one of those suites would break the moment this file is imported transitively. The
 * fix is the same one `device-signer.ts` already uses: a lazy, in-function `require()` — never a
 * top-level `import` and never `import()` — so the native module factory only runs the first time
 * `pickFoundingBundleFile()` is actually called. Only an `import type` (erased at compile time) of
 * the picker's exported function/value SIGNATURES appears at module scope below.
 *
 * MAX_FOUNDING_BUNDLE_FILE_BYTES = 1048576 is 4 bytes per character of 62-16's
 * `MAX_FOUNDING_BUNDLE_CHARS` (262144) import ceiling. That engine constant is not importable
 * here — `packages/vote-engine/src/networks/founding-bundle.ts` is in no barrel — so this is a
 * conservative restatement at the file-size layer (T-62-23-02). It is checked BEFORE any read in
 * every case: against the picker's reported size before the copy, or, when the provider reports no
 * size, against the local copy's size (a native-backed blob, never loaded into the JS heap) before
 * the text is read. The text actually read is checked again as UTF-8 bytes. Residual: when the
 * provider reports no size the copy into the cache is itself unbounded (the picker's
 * `keepLocalCopy` has no limit); the copy is deleted when the pick ends.
 *
 * This file never logs a uri, file name or file content — only a closed failure-kind token
 * (T-62-23-04).
 */

import type {
	errorCodes as PickerErrorCodes,
	isErrorWithCode as PickerIsErrorWithCode,
	keepLocalCopy as PickerKeepLocalCopy,
	pick as PickerPick,
	types as PickerTypes,
} from '@react-native-documents/picker'

/** 4 bytes per character of 62-16's 262144-char `MAX_FOUNDING_BUNDLE_CHARS` ceiling. */
export const MAX_FOUNDING_BUNDLE_FILE_BYTES = 1048576

export type PickedFoundingBundleFile =
	| { readonly kind: 'picked'; readonly text: string }
	| { readonly kind: 'cancelled' }
	| { readonly kind: 'too-large' }
	| { readonly kind: 'unreadable'; readonly reason: 'picker-error' | 'copy-failed' | 'read-failed' }

/** The subset of the picker package's exports this seam actually uses, named for injection. */
export interface PickerModuleSubset {
	pick: typeof PickerPick
	keepLocalCopy: typeof PickerKeepLocalCopy
	types: typeof PickerTypes
	errorCodes: typeof PickerErrorCodes
	isErrorWithCode: typeof PickerIsErrorWithCode
}

export interface PickFoundingBundleFileDeps {
	picker?: PickerModuleSubset
	readText?: (uri: string) => Promise<string>
	/**
	 * Byte size of the local copy, read without loading its content into the JS heap. Used only
	 * when the provider reported no size. Default: `fetch(uri)` as a native-backed blob.
	 */
	sizeOfLocalCopy?: (uri: string) => Promise<number>
	/** Deletes the picker's cache copy. Default: attestation-native `deleteCachedFile`. */
	deleteLocalCopy?: (uri: string) => Promise<unknown>
}

const DEFAULT_FOUNDING_BUNDLE_FILE_NAME = 'founding-bundle.json'

/**
 * Lazily resolve the native picker module via a plain CommonJS `require()` — NOT a top-level
 * `import`. See this file's module doc comment for why. Called only from inside
 * `pickFoundingBundleFile()`, never at module-evaluation time.
 */
function getPicker(): PickerModuleSubset {
	// eslint-disable-next-line @typescript-eslint/no-var-requires -- deliberate lazy require, see module doc comment.
	return require('@react-native-documents/picker') as PickerModuleSubset
}

function defaultReadText(uri: string): Promise<string> {
	return fetch(uri).then((response) => response.text())
}

async function defaultSizeOfLocalCopy(uri: string): Promise<number> {
	const blob = (await (await fetch(uri)).blob()) as Blob & { close?: () => void }
	const size = blob.size
	// RN blobs hold native memory until closed; the size is all this check needs.
	blob.close?.()
	if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) throw new Error('size unavailable')
	return size
}

/** UTF-8 byte length of a JS string, without allocating an encoded copy. */
export function utf8ByteLength(text: string): number {
	let bytes = 0
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i)
		if (c < 0x80) bytes += 1
		else if (c < 0x800) bytes += 2
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1)
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4
				i++
			} else {
				bytes += 3
			}
		} else bytes += 3
	}
	return bytes
}

function defaultDeleteLocalCopy(uri: string): Promise<unknown> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires -- lazy, like the picker: keeps the native module out of module evaluation.
	const native = require('@votetorrent/attestation-native') as { deleteCachedFile: (uri: string) => Promise<boolean> }
	return native.deleteCachedFile(uri)
}

function logFailure(reason: string): void {
	// eslint-disable-next-line no-console -- closed token only, never a uri/name/content (T-62-23-04).
	console.info(`[founding-bundle] pick: ${reason}`)
}

/**
 * Picks a single file via the OS document picker, copies it into the caches directory
 * (`keepLocalCopy`), and reads its text from the LOCAL copy — never the picker's own
 * (possibly `content://`) uri, closing RESEARCH Pitfall 6's `fetch` flake. Never throws: every
 * failure resolves a typed result.
 */
export async function pickFoundingBundleFile(
	deps?: PickFoundingBundleFileDeps,
): Promise<PickedFoundingBundleFile> {
	const picker = deps?.picker ?? getPicker()
	const readText = deps?.readText ?? defaultReadText
	const sizeOfLocalCopy = deps?.sizeOfLocalCopy ?? defaultSizeOfLocalCopy
	const deleteLocalCopy = deps?.deleteLocalCopy ?? defaultDeleteLocalCopy

	let pickedUri: string
	let pickedName: string | null
	let pickedSize: number | null
	try {
		const results = await picker.pick({
			mode: 'import',
			type: [picker.types.allFiles],
			allowMultiSelection: false,
		})
		const first = results[0]
		if (!first) {
			logFailure('picker-error')
			return { kind: 'unreadable', reason: 'picker-error' }
		}
		pickedUri = first.uri
		pickedName = first.name
		pickedSize = first.size
	} catch (error) {
		if (picker.isErrorWithCode(error) && error.code === picker.errorCodes.OPERATION_CANCELED) {
			return { kind: 'cancelled' }
		}
		logFailure('picker-error')
		return { kind: 'unreadable', reason: 'picker-error' }
	}

	if (pickedSize !== null && pickedSize > MAX_FOUNDING_BUNDLE_FILE_BYTES) {
		logFailure('too-large')
		return { kind: 'too-large' }
	}

	const fileName = pickedName ?? DEFAULT_FOUNDING_BUNDLE_FILE_NAME
	let localUri: string
	try {
		const copyResults = await picker.keepLocalCopy({
			files: [{ uri: pickedUri, fileName }],
			destination: 'cachesDirectory',
		})
		const copyResult = copyResults[0]
		if (!copyResult || copyResult.status !== 'success') {
			logFailure('copy-failed')
			return { kind: 'unreadable', reason: 'copy-failed' }
		}
		localUri = copyResult.localUri
	} catch {
		logFailure('copy-failed')
		return { kind: 'unreadable', reason: 'copy-failed' }
	}

	try {
		// The provider reported no size: measure the local copy before reading a single character.
		if (pickedSize === null && (await sizeOfLocalCopy(localUri)) > MAX_FOUNDING_BUNDLE_FILE_BYTES) {
			logFailure('too-large')
			return { kind: 'too-large' }
		}
		const text = await readText(localUri)
		// A reported size can be wrong, so the cap is enforced again, in bytes, on what was read.
		if (utf8ByteLength(text) > MAX_FOUNDING_BUNDLE_FILE_BYTES) {
			logFailure('too-large')
			return { kind: 'too-large' }
		}
		return { kind: 'picked', text }
	} catch {
		logFailure('read-failed')
		return { kind: 'unreadable', reason: 'read-failed' }
	} finally {
		// The cache copy never outlives the import; a failed delete must not change the result.
		try {
			await deleteLocalCopy(localUri)
		} catch {
			// best effort
		}
	}
}
