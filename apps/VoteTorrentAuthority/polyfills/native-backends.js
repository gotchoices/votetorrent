/**
 * native-backends.js — react-native-quick-crypto (OpenSSL) behind three pure-JS crypto call sites
 * that bypass `crypto.subtle`, and so bypass polyfills/native-crypto.js's two older hooks:
 *
 *   1. `@optimystic/quereus-plugin-crypto`'s own backend slot (`setCryptoBackend`): sha256,
 *      sha512, Ed25519 sign and verify behind the schema's `digest(...)` and signature CHECKs.
 *      The plugin ships the slot and nothing in the stack fills it.
 *   2. `@votetorrent/vote-engine/crypto-backend`: the secp256k1 ECDH (x-coordinate) behind every
 *      envelope and block-cipher seal and open.
 *   3. `@noble/hashes/sha2.js` `sha256(bytes)`, imported directly by Optimystic (db-p2p's
 *      certified-claims memo key, about 2 KB of JSON per call), vote-engine and others. Metro
 *      sends those imports to polyfills/noble-sha2-native.js, which uses `makeNativeSha256`.
 *
 * Measured 2026-11-12 on the Pixel_8 AVD (Hermes), noble vs quick-crypto: sha256 54 us vs 10 us at
 * 32 B and 798 us vs 10 us at 1 KB; Ed25519 verify 26.7 ms vs 0.12 ms, sign 6.1 ms vs 0.09 ms;
 * secp256k1 ECDH 49 ms vs 0.5 ms. In an instrumented election these three were most of the
 * movable JS crypto time on every phone.
 *
 * Every native path is trusted only after it reproduces noble's answer (the plugin and the engine
 * run their own self-checks; `makeNativeSha256` runs its own here) and is otherwise left on noble.
 * Every returned array is a fresh copy, never a view of a native buffer.
 *
 * One known difference, accepted: OpenSSL's Ed25519 verify is strict RFC 8032, noble's default
 * is ZIP-215. They agree on every signature an honest signer produces; only a crafted
 * non-canonical signature can verify under one and not the other. libp2p's Ed25519 on these phones
 * has been OpenSSL since polyfills/native-ed25519.js, so this adds no new kind of disagreement.
 *
 * Pure: imports nothing, so jest can drive it with Node's crypto in place of quick-crypto's.
 * BYTE-IDENTICAL in both apps (polyfills/__tests__/native-crypto.test.js).
 */

// DER prefixes for raw Ed25519 keys (RFC 8410), the same bytes @chainsafe/libp2p-noise and
// @serfab/cadre-rn use for X25519 with the OID's last byte 0x70 (Ed25519) instead of 0x6e.
const ED25519_PKCS8_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
const ED25519_SPKI_PREFIX = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

function withPrefix(prefix, bytes) {
	const out = new Uint8Array(prefix.length + bytes.length);
	out.set(prefix, 0);
	out.set(bytes, prefix.length);
	return out;
}

/** The `CryptoBackend` for `@optimystic/quereus-plugin-crypto`'s `setCryptoBackend`. */
export function makePluginCryptoBackend(qc) {
	const { Buffer } = qc;
	return {
		sha256: data => new Uint8Array(qc.createHash('sha256').update(data).digest()),
		sha512: data => new Uint8Array(qc.createHash('sha512').update(data).digest()),
		ed25519Sign(message, secretKey) {
			const key = qc.createPrivateKey({ key: Buffer.from(withPrefix(ED25519_PKCS8_PREFIX, secretKey)), format: 'der', type: 'pkcs8' });
			return new Uint8Array(qc.sign(null, Buffer.from(message), key));
		},
		ed25519Verify(signature, message, publicKey) {
			const key = qc.createPublicKey({ key: Buffer.from(withPrefix(ED25519_SPKI_PREFIX, publicKey)), format: 'der', type: 'spki' });
			return qc.verify(null, Buffer.from(message), key, Buffer.from(signature)) === true;
		},
	};
}

/** The `CryptoBackend` for `@votetorrent/vote-engine/crypto-backend`'s `setCryptoBackend`. */
export function makeVoteEngineBackend(qc) {
	const { Buffer } = qc;
	return {
		secp256k1EcdhX(secretKey, publicKey) {
			const ecdh = qc.createECDH('secp256k1');
			ecdh.setPrivateKey(Buffer.from(secretKey));
			return new Uint8Array(ecdh.computeSecret(Buffer.from(publicKey)));
		},
	};
}

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function toHex(bytes) {
	let hex = '';
	for (let i = 0; i < bytes.length; i++) hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
	return hex;
}

function sha256KnownAnswer(native, noble) {
	if (toHex(native(new Uint8Array([0x61, 0x62, 0x63]))) !== ABC_SHA256) return false;
	// An offset view over a buffer with different bytes on both sides, at a length that is not a
	// multiple of the block size: catches a native side that hashes the whole backing buffer.
	const backing = new Uint8Array(1500);
	for (let i = 0; i < backing.length; i++) backing[i] = (i * 31 + 7) & 0xff;
	const view = backing.subarray(3, 1003);
	return toHex(native(view)) === toHex(noble(view)) && toHex(native(new Uint8Array(0))) === toHex(noble(new Uint8Array(0)));
}

/**
 * A drop-in for noble's `sha256` whose one-shot call `sha256(bytes)` runs natively. Everything
 * else is noble's own: `create()` (so `hmac(sha256, ...)`, `hkdf(sha256, ...)` and incremental
 * hashing stay pure JS and byte-identical), `outputLen`, `blockLen`, `oid`. A non-Uint8Array
 * argument, a second argument, or a native error goes to noble, which answers or throws as it
 * always has. Returns `{ sha256, status }`; status is 'native', or 'js' when the known-answer test
 * failed and `sha256` IS noble's.
 */
export function makeNativeSha256(nobleSha256, createHash) {
	const native = data => new Uint8Array(createHash('sha256').update(data).digest());
	let passed = false;
	try {
		passed = sha256KnownAnswer(native, nobleSha256);
	} catch {
		passed = false;
	}
	if (!passed) return { sha256: nobleSha256, status: 'js' };

	const sha256 = function sha256(data, opts) {
		if (opts !== undefined || !(data instanceof Uint8Array)) return nobleSha256(data, opts);
		try {
			return native(data);
		} catch {
			return nobleSha256(data);
		}
	};
	for (const key of Object.keys(nobleSha256)) sha256[key] = nobleSha256[key];
	return { sha256: Object.freeze(sha256), status: 'native' };
}
