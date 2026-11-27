// Minimal Node.js 'crypto' shim for React Native.
// Provides createHash() using @noble/hashes (pure JS, no native deps).
// Used by multiformats/hashes/sha2 which does:
//   import crypto from 'crypto';
//   crypto.createHash('sha256').update(input).digest()

import { sha256 } from '@noble/hashes/sha2.js';
import { sha512 } from '@noble/hashes/sha2.js';

const hashFns = {
	'sha256': sha256,
	'sha-256': sha256,
	'sha512': sha512,
	'sha-512': sha512,
};

class Hash {
	constructor(fn) {
		this._fn = fn;
		this._chunks = [];
	}

	update(data) {
		if (typeof data === 'string') {
			data = new TextEncoder().encode(data);
		}
		this._chunks.push(data);
		return this;
	}

	digest(encoding) {
		let total = 0;
		for (const c of this._chunks) total += c.length;
		const buf = new Uint8Array(total);
		let off = 0;
		for (const c of this._chunks) {
			buf.set(c, off);
			off += c.length;
		}
		const result = this._fn(buf);
		if (!encoding) return result;
		// Honor string encoding — CR-01: polyfill previously ignored the encoding arg,
		// causing Digest() to return Uint8Array on device vs base64url string on Node.
		// This made A.Digest (TEXT, stored as Quereus-serialized Uint8Array) fail the
		// InsertValid check against Digest(context.Tid,...) (fresh Uint8Array in memory).
		if (encoding === 'base64url') {
			// Standard base64, then replace + with -, / with _, strip = padding
			let binary = '';
			for (let i = 0; i < result.length; i++) binary += String.fromCharCode(result[i]);
			return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
		}
		if (encoding === 'hex') {
			let hex = '';
			for (let i = 0; i < result.length; i++) hex += (result[i] < 16 ? '0' : '') + result[i].toString(16);
			return hex;
		}
		if (encoding === 'base64') {
			let binary = '';
			for (let i = 0; i < result.length; i++) binary += String.fromCharCode(result[i]);
			return btoa(binary);
		}
		return result;
	}
}

export function createHash(algorithm) {
	const fn = hashFns[algorithm.toLowerCase()];
	if (!fn) throw new Error(`Unsupported hash algorithm: ${algorithm}`);
	return new Hash(fn);
}

// randomUUID() — RFC 4122 v4 via the global getRandomValues polyfilled by
// react-native-get-random-values (imported in polyfills.bootstrap before any
// library). Several engine paths (e.g. NetworksEngine) do `import { randomUUID }
// from 'crypto'`, which Metro maps here.
const _hex = [];
for (let _i = 0; _i < 256; _i++) _hex.push((_i + 0x100).toString(16).slice(1));

export function randomUUID() {
	const b = new Uint8Array(16);
	globalThis.crypto.getRandomValues(b);
	b[6] = (b[6] & 0x0f) | 0x40; // version 4
	b[8] = (b[8] & 0x3f) | 0x80; // variant 10
	return (
		_hex[b[0]] + _hex[b[1]] + _hex[b[2]] + _hex[b[3]] + '-' +
		_hex[b[4]] + _hex[b[5]] + '-' +
		_hex[b[6]] + _hex[b[7]] + '-' +
		_hex[b[8]] + _hex[b[9]] + '-' +
		_hex[b[10]] + _hex[b[11]] + _hex[b[12]] + _hex[b[13]] + _hex[b[14]] + _hex[b[15]]
	);
}

/**
 * timingSafeEqual(a, b) — constant-time byte comparison.
 *
 * Added when Phase 51 wired the iOS verifier into engine-factory, but it was
 * ALREADY missing for Android: `verifiers/key-attestation.ts` (reached by the
 * shipping `PlayIntegrityVerifier`) imports it too, and a named import of an
 * export this module never had resolves to `undefined` — so the call site threw
 * `TypeError: timingSafeEqual is not a function` on device while every Node
 * test passed, because Node has the real thing. Both attestation halves depend
 * on it; adding it here fixes both.
 *
 * Node's version THROWS when the lengths differ. Both call sites length-check
 * first, so this matches that contract rather than silently returning false —
 * a shim that is more permissive than the thing it stands in for hides the bug
 * it is meant to reproduce.
 */
export function timingSafeEqual(a, b) {
	if (a.length !== b.length) {
		throw new RangeError('Input buffers must have the same byte length');
	}
	// Accumulate over EVERY byte — no early return. An early exit on the first
	// mismatch is what makes a naive comparison timing-attackable, which is the
	// entire reason these call sites do not just use a loop with `!==`.
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

export default { createHash, randomUUID, timingSafeEqual };
