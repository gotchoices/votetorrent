/**
 * native-crypto.test.js — guards for polyfills/native-crypto.js and the two hooks it drives
 * (`@serfab/cadre-rn/native-digest` over the bootstrap's tagged digest, and
 * polyfills/native-ed25519.js).
 *
 * Node's own crypto stands in for react-native-quick-crypto: same `createHash` and WebCrypto
 * API, real implementations. That proves the WIRING and the fallbacks. Whether quick-crypto
 * itself agrees with these answers on Hermes is checked on the device by the known-answer
 * tests the hooks run at boot, and reported in the `[native-crypto]` logcat line.
 *
 * Group D swaps `globalThis.crypto` for a bootstrap-shaped object and restores it in `finally`;
 * nothing else here touches globals.
 *
 * Group E covers the Voter, which runs the same two files: it lives here, not in the Voter's suite,
 * for the reason polyfill-drift.test.js gives (a second copy of a guard needs its own drift guard).
 * The byte identity is what lets Groups A and D speak for the Voter's copies too.
 */

const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');

const STUB_TAG = Symbol.for('votetorrent/subtle-stub');
const KIT_JS_DIGEST_TAG = Symbol.for('@serfab/cadre-rn/js-digest');
const KIT_NATIVE_DIGEST_TAG = Symbol.for('@serfab/cadre-rn/native-digest');
const ED25519 = { name: 'Ed25519' };

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n');
}

/** A subtle shaped like polyfills.bootstrap.js §2: a tagged JS digest and tagged rejecting stubs. */
function bootstrapShapedSubtle() {
  const stub = name => {
    const fn = () => Promise.reject(new Error(`crypto.subtle.${name} is not polyfilled (digest-only shim)`));
    fn[STUB_TAG] = true;
    return fn;
  };
  const subtle = {
    digest: (algorithm, data) => {
      const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
      const node = name === 'SHA-256' ? 'sha256' : name === 'SHA-512' ? 'sha512' : null;
      if (!node) return Promise.reject(new Error('Unsupported digest: ' + name));
      const out = nodeCrypto.createHash(node).update(new Uint8Array(data)).digest();
      return Promise.resolve(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
    },
  };
  subtle.digest[KIT_JS_DIGEST_TAG] = true;
  for (const m of ['encrypt', 'decrypt', 'sign', 'verify', 'generateKey', 'deriveKey', 'deriveBits', 'importKey', 'exportKey', 'wrapKey', 'unwrapKey']) {
    subtle[m] = stub(m);
  }
  return subtle;
}

const nativeSubtle = nodeCrypto.webcrypto.subtle;

function loadEd25519() {
  let mod;
  jest.isolateModules(() => {
    mod = require('../native-ed25519');
  });
  return mod;
}

describe('A. native-ed25519', () => {
  it('installs over the bootstrap stubs and passes the RFC 8032 known-answer test', async () => {
    const { installNativeEd25519 } = loadEd25519();
    const subtle = bootstrapShapedSubtle();
    const result = installNativeEd25519(nativeSubtle, subtle);
    expect(result.status).toBe('installed');
    await expect(result.ready).resolves.toBe(true);
  });

  it('signs and verifies the way @libp2p/crypto calls it, interchangeably with noble', async () => {
    const { ed25519 } = require('@noble/curves/ed25519.js');
    const { installNativeEd25519 } = loadEd25519();
    const subtle = bootstrapShapedSubtle();
    await installNativeEd25519(nativeSubtle, subtle).ready;

    // libp2p's probe.
    const pair = await subtle.generateKey(ED25519, true, ['sign', 'verify']);
    expect(pair.privateKey.algorithm.name).toBe('Ed25519');

    const secret = ed25519.utils.randomSecretKey();
    const publicKey = ed25519.getPublicKey(secret);
    const message = new TextEncoder().encode('votetorrent p2p-11');

    // hashAndSignWebCrypto: jwk import, sign. Must verify under noble.
    const jwk = {
      crv: 'Ed25519',
      kty: 'OKP',
      x: Buffer.from(publicKey).toString('base64url'),
      d: Buffer.from(secret).toString('base64url'),
      ext: true,
      key_ops: ['sign'],
    };
    const privateKey = await subtle.importKey('jwk', jwk, ED25519, true, ['sign']);
    const signature = new Uint8Array(await subtle.sign(ED25519, privateKey, message));
    expect(Buffer.from(signature)).toEqual(Buffer.from(ed25519.sign(message, secret)));
    expect(ed25519.verify(signature, message, publicKey)).toBe(true);

    // hashAndVerifyWebCrypto: raw import of `publicKey.buffer`, verify a noble signature.
    const rawKey = await subtle.importKey('raw', publicKey.slice().buffer, ED25519, false, ['verify']);
    const nobleSignature = ed25519.sign(message, secret);
    await expect(subtle.verify(ED25519, rawKey, nobleSignature, message)).resolves.toBe(true);
    const tampered = nobleSignature.slice();
    tampered[5] ^= 0x40;
    await expect(subtle.verify(ED25519, rawKey, tampered, message)).resolves.toBe(false);
  });

  it('leaves every other algorithm on the stub', async () => {
    const { installNativeEd25519 } = loadEd25519();
    const subtle = bootstrapShapedSubtle();
    await installNativeEd25519(nativeSubtle, subtle).ready;

    await expect(subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])).rejects.toThrow(
      'crypto.subtle.generateKey is not polyfilled',
    );
    await expect(
      subtle.importKey('raw', new Uint8Array(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    ).rejects.toThrow('crypto.subtle.importKey is not polyfilled');
    await expect(subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, {}, new Uint8Array(1))).rejects.toThrow(
      'crypto.subtle.sign is not polyfilled',
    );
    await expect(subtle.exportKey('jwk', { algorithm: { name: 'RSASSA-PKCS1-v1_5' } })).rejects.toThrow(
      'crypto.subtle.exportKey is not polyfilled',
    );
    await expect(subtle.encrypt({ name: 'AES-GCM' }, {}, new Uint8Array(1))).rejects.toThrow(
      'crypto.subtle.encrypt is not polyfilled',
    );
  });

  it.each([
    ['returns a wrong signature', { sign: async () => new Uint8Array(64) }],
    ['throws on import', { importKey: async () => { throw new Error('boom'); } }],
    ['accepts a tampered signature', { verify: async () => true }],
  ])('falls back to the stub when the native side %s', async (_label, overrides) => {
    const { installNativeEd25519 } = loadEd25519();
    const subtle = bootstrapShapedSubtle();
    const broken = {
      generateKey: (...a) => nativeSubtle.generateKey(...a),
      importKey: (...a) => nativeSubtle.importKey(...a),
      exportKey: (...a) => nativeSubtle.exportKey(...a),
      sign: (...a) => nativeSubtle.sign(...a),
      verify: (...a) => nativeSubtle.verify(...a),
      ...overrides,
    };
    const result = installNativeEd25519(broken, subtle);
    expect(result.status).toBe('installed');
    await expect(result.ready).resolves.toBe(false);
    // So @libp2p/crypto's probe rejects and it keeps noble.
    await expect(subtle.generateKey(ED25519, true, ['sign', 'verify'])).rejects.toThrow(
      'crypto.subtle.generateKey is not polyfilled',
    );
  });

  it('does not touch a subtle whose methods are not the bootstrap stubs', () => {
    const { installNativeEd25519 } = loadEd25519();
    const real = { generateKey() {}, importKey() {}, exportKey() {}, sign() {}, verify() {} };
    const before = { ...real };
    expect(installNativeEd25519(nativeSubtle, real).status).toBe('not-stubbed');
    expect(real).toEqual(before);
  });

  it('is idempotent', async () => {
    const { installNativeEd25519 } = loadEd25519();
    const subtle = bootstrapShapedSubtle();
    const first = installNativeEd25519(nativeSubtle, subtle);
    const sign = subtle.sign;
    const second = installNativeEd25519(nativeSubtle, subtle);
    expect(second.status).toBe('already');
    expect(second.ready).toBe(first.ready);
    expect(subtle.sign).toBe(sign);
  });
});

describe('B. the bootstrap digest is the one the sereus kit replaces', () => {
  const kit = require('@serfab/cadre-rn/native-digest');

  it('tags its digest with the kit tag and its stubs with ours', () => {
    expect(kit.JS_DIGEST_TAG).toBe(KIT_JS_DIGEST_TAG);
    const src = stripComments(fs.readFileSync(path.resolve(__dirname, '../../polyfills.bootstrap.js'), 'utf8'));
    expect(src).toContain("globalThis.crypto.subtle.digest[Symbol.for('@serfab/cadre-rn/js-digest')] = true;");
    expect(src).toContain("stub[Symbol.for('votetorrent/subtle-stub')] = true;");
  });

  it('installNativeDigest replaces a tagged digest and hashes offset views correctly', async () => {
    const subtle = bootstrapShapedSubtle();
    expect(kit.installNativeDigest(nodeCrypto.createHash, subtle)).toBe('installed');
    expect(subtle.digest[KIT_NATIVE_DIGEST_TAG]).toBe(true);
    const backing = nodeCrypto.randomBytes(4096);
    const view = new Uint8Array(backing.buffer, backing.byteOffset + 17, 2048);
    const out = new Uint8Array(await subtle.digest('SHA-256', view));
    expect(Buffer.from(out)).toEqual(nodeCrypto.createHash('sha256').update(view).digest());
  });

  it('an untagged digest is left alone — the state before this fix', () => {
    const subtle = bootstrapShapedSubtle();
    delete subtle.digest[KIT_JS_DIGEST_TAG];
    expect(kit.installNativeDigest(nodeCrypto.createHash, subtle)).toBe('not-polyfilled');
  });
});

const APP_ROOTS = [
  ['Authority', path.resolve(__dirname, '../..')],
  ['Voter', path.resolve(__dirname, '../../../VoteTorrentVoter')],
];

describe('C. index.js wiring', () => {
  it.each(APP_ROOTS)('%s imports native-crypto right after the bootstrap and before App', (_label, root) => {
    const src = stripComments(fs.readFileSync(path.join(root, 'index.js'), 'utf8'));
    const bootstrap = src.indexOf("import './polyfills.bootstrap';");
    const native = src.indexOf("import './polyfills/native-crypto';");
    const app = src.indexOf("import App from './App';");
    expect(bootstrap).toBeGreaterThanOrEqual(0);
    expect(native).toBeGreaterThan(bootstrap);
    expect(app).toBeGreaterThan(native);
    expect(src.slice(0, native).match(/^import /gm)).toHaveLength(1);
  });
});

describe('D. native-crypto.js end to end', () => {
  it('installs both hooks and logs the summary', async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const subtle = bootstrapShapedSubtle();
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      Object.defineProperty(globalThis, 'crypto', { value: { subtle }, configurable: true, writable: true });
      jest.isolateModules(() => {
        jest.doMock('react-native-quick-crypto', () => ({
          createHash: nodeCrypto.createHash,
          subtle: nodeCrypto.webcrypto.subtle,
        }));
        require('../native-crypto');
      });
      await subtle[Symbol.for('votetorrent/native-ed25519')];
      await new Promise(resolve => setImmediate(resolve));

      expect(subtle.digest[KIT_NATIVE_DIGEST_TAG]).toBe(true);
      await expect(subtle.generateKey(ED25519, true, ['sign', 'verify'])).resolves.toBeDefined();
      expect(log).toHaveBeenCalledWith(
        '[native-crypto] subtle.digest=installed ed25519=installed:native',
      );
    } finally {
      log.mockRestore();
      if (saved) Object.defineProperty(globalThis, 'crypto', saved);
      else delete globalThis.crypto;
    }
  });
});

describe('E. the Voter runs the same native crypto', () => {
  const VOTER = path.resolve(__dirname, '../../../VoteTorrentVoter');

  it.each(['native-ed25519.js', 'native-crypto.js'])('polyfills/%s is byte-identical in both apps', file => {
    const authority = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    const voter = fs.readFileSync(path.join(VOTER, 'polyfills', file), 'utf8');
    expect(authority.length).toBeGreaterThan(500);
    expect(voter).toBe(authority);
  });

  it('its bootstrap tags the digest with the kit tag and the stubs with ours', () => {
    const src = stripComments(fs.readFileSync(path.join(VOTER, 'polyfills.bootstrap.js'), 'utf8'));
    expect(src).toContain("globalThis.crypto.subtle.digest[Symbol.for('@serfab/cadre-rn/js-digest')] = true;");
    expect(src).toContain("stub[Symbol.for('votetorrent/subtle-stub')] = true;");
  });

  it('lists the native modules as its OWN dependencies (React Native autolinks only those)', () => {
    const deps = JSON.parse(fs.readFileSync(path.join(VOTER, 'package.json'), 'utf8')).dependencies;
    for (const name of ['react-native-quick-crypto', 'react-native-quick-base64', 'react-native-nitro-modules', '@serfab/cadre-rn']) {
      expect(deps[name]).toEqual(expect.any(String));
    }
  });
});
