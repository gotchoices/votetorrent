// Minimal Node.js 'crypto' shim for React Native.
// Provides createHash() using @noble/hashes (pure JS, no native deps).
// Used by multiformats/hashes/sha2 which does:
//   import crypto from 'crypto';
//   crypto.createHash('sha256').update(input).digest()

import { sha256 } from '@noble/hashes/sha2';
import { sha512 } from '@noble/hashes/sha2';

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

	digest() {
		let total = 0;
		for (const c of this._chunks) total += c.length;
		const buf = new Uint8Array(total);
		let off = 0;
		for (const c of this._chunks) {
			buf.set(c, off);
			off += c.length;
		}
		return this._fn(buf);
	}
}

export function createHash(algorithm) {
	const fn = hashFns[algorithm.toLowerCase()];
	if (!fn) throw new Error(`Unsupported hash algorithm: ${algorithm}`);
	return new Hash(fn);
}

export default { createHash };
