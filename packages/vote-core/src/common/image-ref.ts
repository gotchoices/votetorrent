export interface ImageRef {
  url?: string
  /** Content id (CIDv1, raw, sha2-256, base32) of the bytes at `url` when it was made permanent —
   *  lets any reader verify the media has not been swapped since. */
  cid?: string
}

/**
 * Normalize a stored ImageRef column value (already JSON-parsed) into an ImageRef. Two stored forms
 * exist: `NetworksEngine.create`/`NetworkEngine.createAuthority` historically wrote a bare JSON
 * string (`"https://…"`), every other writer an object (`{ url, cid? }`). Readers must accept both,
 * or a bare-string row reads as having no image. Anything else (numbers, arrays, empty strings,
 * non-string fields) normalizes to `undefined`.
 */
export function toImageRef (value: unknown): ImageRef | undefined {
  if (typeof value === 'string') {
    return value.trim() !== '' ? { url: value } : undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { url, cid } = value as { url?: unknown, cid?: unknown }
  const ref: ImageRef = {
    ...(typeof url === 'string' && url.trim() !== '' ? { url } : {}),
    ...(typeof cid === 'string' && cid.trim() !== '' ? { cid } : {})
  }
  return ref.url !== undefined || ref.cid !== undefined ? ref : undefined
}
