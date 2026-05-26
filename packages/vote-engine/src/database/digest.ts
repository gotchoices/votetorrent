import { createHash } from 'crypto';

/**
 * Compute a SHA-256 digest over pipe-delimited arguments, returning a
 * base64url-encoded string.
 *
 * Mirrors the SQL Digest() scalar function registered in initialize.ts
 * exactly:
 *
 *   args.map(a => a === null || a === undefined ? '' : String(a)).join('|')
 *     -> sha256 -> base64url
 *
 * This is the single source of truth for engine-side digest computation
 * (per D-01). All engine code that needs a value matching a SQL Digest()
 * constraint must use this function rather than importing Digest from
 * the crypto plugin.
 */
export function digest(...args: (string | number | null | undefined)[]): string {
	const parts = args.map(a => a === null || a === undefined ? '' : String(a));
	const concat = parts.join('|');
	return createHash('sha256').update(concat).digest('base64url');
}
