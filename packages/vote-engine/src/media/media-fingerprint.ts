import { cid } from '@optimystic/quereus-plugin-crypto'

/**
 * "Make permanent" for a media URL (network/authority image, option image/video): download the
 * bytes once and record their content id next to the URL, `{ url, cid }`. The URL stays the
 * locator; the cid makes the reference tamper-evident — any reader can re-download and check the
 * bytes still hash to it (`verifyMediaFingerprint`). Nothing is stored or served by the network
 * itself; content-addressed hosting would be a separate feature.
 *
 * The cid is the crypto plugin's own `cid()` (CIDv1, raw codec, sha2-256, base32) — byte-for-byte
 * the format of every other CID the schema mints.
 */

/** Upper bound on a fingerprinted file; protects the device from an unbounded download. */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024

export type MediaFingerprintFailure = 'invalid-url' | 'network' | 'http' | 'too-large' | 'empty'

export class MediaFingerprintError extends Error {
  constructor (readonly reason: MediaFingerprintFailure, message: string) {
    super(message)
    this.name = 'MediaFingerprintError'
  }
}

/** The subset of `fetch`'s Response this module reads. */
export interface MediaResponse {
  ok: boolean
  status: number
  headers?: { get: (name: string) => string | null }
  arrayBuffer: () => Promise<ArrayBuffer>
}

export type MediaFetch = (url: string) => Promise<MediaResponse>

export interface MediaFingerprintOptions {
  fetch?: MediaFetch
  maxBytes?: number
}

/**
 * Only absolute http(s) URLs are fetched — never file:, data:, content: or relative paths.
 * Deliberately NOT `new URL(...)`: React Native's built-in URL class throws "not implemented"
 * from `.protocol`/`.hostname`, which made every URL read as invalid on device.
 */
export function isFingerprintableUrl (url: string): boolean {
  return /^https?:\/\/[^\s/?#:@]+(:\d+)?([/?#]\S*)?$/i.test(url.trim())
}

function defaultFetch (): MediaFetch {
  const f = (globalThis as { fetch?: (url: string) => Promise<MediaResponse> }).fetch
  if (typeof f !== 'function') {
    throw new MediaFingerprintError('network', 'fetch is not available in this environment')
  }
  // Bound: an unbound `globalThis.fetch` throws "Illegal invocation" in browsers.
  return f.bind(globalThis)
}

async function downloadBytes (url: string, options: MediaFingerprintOptions): Promise<Uint8Array> {
  if (!isFingerprintableUrl(url)) {
    throw new MediaFingerprintError('invalid-url', `not an http(s) URL: ${url}`)
  }
  const maxBytes = options.maxBytes ?? MAX_MEDIA_BYTES
  const fetchMedia = options.fetch ?? defaultFetch()

  let response: MediaResponse
  try {
    // The scheme is case-insensitive (RFC 3986) but Android's networking refuses "Http://"
    // outright, and phone keyboards auto-capitalize the first letter — fetch the canonical form.
    response = await fetchMedia(url.trim().replace(/^https?:/i, (scheme) => scheme.toLowerCase()))
  } catch (err) {
    throw new MediaFingerprintError('network', `could not download ${url}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!response.ok) {
    throw new MediaFingerprintError('http', `download of ${url} failed with HTTP ${response.status}`)
  }
  const declared = Number(response.headers?.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new MediaFingerprintError('too-large', `${url} is ${declared} bytes (limit ${maxBytes})`)
  }

  let buffer: ArrayBuffer
  try {
    buffer = await response.arrayBuffer()
  } catch (err) {
    throw new MediaFingerprintError('network', `could not read ${url}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (buffer.byteLength > maxBytes) {
    throw new MediaFingerprintError('too-large', `${url} is ${buffer.byteLength} bytes (limit ${maxBytes})`)
  }
  if (buffer.byteLength === 0) {
    throw new MediaFingerprintError('empty', `${url} returned no content`)
  }
  return new Uint8Array(buffer)
}

/** Content id of `bytes` in the schema's CID format. */
export function mediaCid (bytes: Uint8Array): string {
  return cid(bytes)
}

/** Download `url` and return `{ url, cid }`. Throws `MediaFingerprintError` with a typed reason. */
export async function fingerprintMedia (
  url: string,
  options: MediaFingerprintOptions = {}
): Promise<{ url: string, cid: string }> {
  const bytes = await downloadBytes(url, options)
  return { url: url.trim(), cid: mediaCid(bytes) }
}

/**
 * Re-download `ref.url` and report whether its bytes still match `ref.cid`. A reference with no
 * cid was never made permanent and is reported `unpinned` rather than verified.
 */
export async function verifyMediaFingerprint (
  ref: { url?: string, cid?: string },
  options: MediaFingerprintOptions = {}
): Promise<'match' | 'mismatch' | 'unpinned'> {
  if (!ref.url || !ref.cid) return 'unpinned'
  const bytes = await downloadBytes(ref.url, options)
  return mediaCid(bytes) === ref.cid ? 'match' : 'mismatch'
}
