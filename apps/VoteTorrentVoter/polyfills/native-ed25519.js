/**
 * native-ed25519.js — route WebCrypto Ed25519 calls to a native SubtleCrypto.
 *
 * `@libp2p/crypto`'s browser Ed25519 probes `crypto.subtle.generateKey({ name: 'Ed25519' })`
 * ONCE, while its module evaluates, and signs and verifies with pure-JS @noble/curves for the
 * rest of the process when that probe rejects. polyfills.bootstrap.js §2 installs a rejecting
 * stub for every SubtleCrypto method except `digest`, so every Ed25519 signature on this app
 * ran in JavaScript: Noise handshakes, peer records, and Optimystic's `privateKey.sign` /
 * `publicKey.verify`. sereus-chat measured 169 ms per verify on a Galaxy S7 against 0.72 ms
 * native, and sereus-health adopted the fix (`apps/mobile/src/polyfills/native-crypto.js`).
 *
 * Narrower than sereus-health's: only calls naming Ed25519 reach the native implementation.
 * Every other algorithm still gets the bootstrap's stub, so jose / @peculiar paths that see a
 * rejection today see the same rejection after this runs. Only methods that still carry the
 * bootstrap's stub tag are wrapped; a runtime with real WebCrypto is left alone.
 *
 * The native side is trusted only after an RFC 8032 known-answer test through the exact calls
 * libp2p makes (jwk import + sign, raw import + verify, a tampered signature). Until it
 * settles, Ed25519 calls wait for it; if it fails, they reject like the stub, so libp2p's probe
 * falls back to noble. A wrong signature would break every handshake; a slow one only costs
 * time.
 *
 * Pure: imports nothing native, so jest can drive it with Node's WebCrypto.
 */

const STUB_TAG = Symbol.for('votetorrent/subtle-stub');
const INSTALLED_TAG = Symbol.for('votetorrent/native-ed25519');
const METHODS = ['generateKey', 'importKey', 'exportKey', 'sign', 'verify'];

// RFC 8032 §7.1, TEST 1 (empty message).
const KAT = {
	d: 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A',
	x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
	publicKeyHex: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
	signatureHex:
		'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
};

function toHex(bytes) {
	let hex = '';
	for (let i = 0; i < bytes.length; i++) hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
	return hex;
}

function fromHex(hex) {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

function algorithmName(algorithm) {
	return typeof algorithm === 'string' ? algorithm : algorithm?.name;
}

/** Whether a SubtleCrypto call names Ed25519, by where each method carries its algorithm. */
function isEd25519Call(method, args) {
	switch (method) {
		case 'importKey':
			return algorithmName(args[2]) === 'Ed25519';
		case 'exportKey':
			return algorithmName(args[1]?.algorithm) === 'Ed25519';
		default: // generateKey, sign, verify
			return algorithmName(args[0]) === 'Ed25519';
	}
}

async function passesKnownAnswer(native) {
	const algorithm = { name: 'Ed25519' };
	const message = new Uint8Array(0);
	const privateKey = await native.importKey(
		'jwk',
		{ crv: 'Ed25519', kty: 'OKP', x: KAT.x, d: KAT.d, ext: true, key_ops: ['sign'] },
		algorithm,
		true,
		['sign'],
	);
	const signature = new Uint8Array(await native.sign(algorithm, privateKey, message));
	if (toHex(signature) !== KAT.signatureHex) return false;
	const publicKey = await native.importKey('raw', fromHex(KAT.publicKeyHex).buffer, algorithm, false, ['verify']);
	if ((await native.verify(algorithm, publicKey, signature, message)) !== true) return false;
	const tampered = signature.slice();
	tampered[0] ^= 1;
	return (await native.verify(algorithm, publicKey, tampered, message)) === false;
}

/**
 * Wrap `subtle`'s stubbed methods so Ed25519 calls reach `native` once it passes the
 * known-answer test. Returns `{ status, ready }`: status is 'installed', 'already',
 * 'not-stubbed' (nothing changed) or 'unavailable'; `ready` resolves to whether native
 * Ed25519 is in use.
 */
export function installNativeEd25519(native, subtle = globalThis.crypto?.subtle) {
	if (!native || !subtle) return { status: 'unavailable', ready: Promise.resolve(false) };
	if (subtle[INSTALLED_TAG]) return { status: 'already', ready: subtle[INSTALLED_TAG] };
	const replaceable = METHODS.every(
		method => typeof subtle[method] === 'function' && subtle[method][STUB_TAG] === true && typeof native[method] === 'function',
	);
	if (!replaceable) return { status: 'not-stubbed', ready: Promise.resolve(false) };

	const ready = passesKnownAnswer(native).catch(() => false);
	for (const method of METHODS) {
		const stub = subtle[method];
		subtle[method] = async function (...args) {
			if (isEd25519Call(method, args) && (await ready)) return native[method](...args);
			return stub.apply(this, args);
		};
	}
	subtle[INSTALLED_TAG] = ready;
	return { status: 'installed', ready };
}
