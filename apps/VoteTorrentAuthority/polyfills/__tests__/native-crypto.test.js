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

/** Node's crypto shaped like react-native-quick-crypto's module: the same names, plus its Buffer. */
const nodeQuickCrypto = { ...nodeCrypto, subtle: nodeCrypto.webcrypto.subtle, Buffer };
const PLUGIN_BACKEND_KEY = Symbol.for('@optimystic/quereus-plugin-crypto/backend');
const ENGINE_BACKEND_KEY = Symbol.for('@votetorrent/vote-engine/crypto-backend');
const NOBLE_SHA256_STATUS = Symbol.for('votetorrent/noble-sha256');

describe('D. native-crypto.js end to end', () => {
  it('installs every hook and logs the summary', async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const subtle = bootstrapShapedSubtle();
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      Object.defineProperty(globalThis, 'crypto', { value: { subtle }, configurable: true, writable: true });
      jest.isolateModules(() => {
        jest.doMock('react-native-quick-crypto', () => nodeQuickCrypto);
        require('../native-crypto');
      });
      await subtle[Symbol.for('votetorrent/native-ed25519')];
      await new Promise(resolve => setImmediate(resolve));

      expect(subtle.digest[KIT_NATIVE_DIGEST_TAG]).toBe(true);
      await expect(subtle.generateKey(ED25519, true, ['sign', 'verify'])).resolves.toBeDefined();
      expect(globalThis[PLUGIN_BACKEND_KEY]).toEqual(
        expect.objectContaining({ sha256: expect.any(Function), ed25519Verify: expect.any(Function) }),
      );
      expect(globalThis[ENGINE_BACKEND_KEY]).toEqual({ secp256k1EcdhX: expect.any(Function) });
      expect(warn).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        '[native-crypto] subtle.digest=installed ed25519=installed:native ' +
          'plugin-crypto=installed ecdh=installed noble-sha256=native',
      );
    } finally {
      log.mockRestore();
      warn.mockRestore();
      delete globalThis[PLUGIN_BACKEND_KEY];
      delete globalThis[ENGINE_BACKEND_KEY];
      delete globalThis[NOBLE_SHA256_STATUS];
      if (saved) Object.defineProperty(globalThis, 'crypto', saved);
      else delete globalThis.crypto;
    }
  });

  it('a backend that fails its self-check is refused with a warning, and noble stays', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const subtle = bootstrapShapedSubtle();
    try {
      Object.defineProperty(globalThis, 'crypto', { value: { subtle }, configurable: true, writable: true });
      jest.isolateModules(() => {
        // A native ECDH and sha512 that are wrong: both self-checks must refuse them.
        const createECDH = () => ({ setPrivateKey() {}, computeSecret: () => Buffer.alloc(32) });
        const createHash = name => (name === 'sha512' ? nodeCrypto.createHash('sha256') : nodeCrypto.createHash(name));
        jest.doMock('react-native-quick-crypto', () => ({ ...nodeQuickCrypto, createECDH, createHash }));
        require('../native-crypto');
      });
      await subtle[Symbol.for('votetorrent/native-ed25519')];
      await new Promise(resolve => setImmediate(resolve));
      expect(globalThis[PLUGIN_BACKEND_KEY]).toBeUndefined();
      expect(globalThis[ENGINE_BACKEND_KEY]).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[native-crypto] plugin-crypto backend refused: setCryptoBackend: sha512'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[native-crypto] vote-engine ecdh backend refused'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('plugin-crypto=refused ecdh=refused noble-sha256=native'));
    } finally {
      log.mockRestore();
      warn.mockRestore();
      delete globalThis[NOBLE_SHA256_STATUS];
      if (saved) Object.defineProperty(globalThis, 'crypto', saved);
      else delete globalThis.crypto;
    }
  });
});

describe('F. native-backends.js', () => {
  const { ed25519 } = require('@noble/curves/ed25519.js');
  const { secp256k1 } = require('@noble/curves/secp256k1.js');
  const nobleSha2 = require('@noble/hashes/sha2.js');
  const { hmac } = require('@noble/hashes/hmac.js');
  const { hkdf } = require('@noble/hashes/hkdf.js');
  const { makeNativeSha256, makePluginCryptoBackend, makeVoteEngineBackend } = require('../native-backends');
  const plugin = require('@optimystic/quereus-plugin-crypto');
  const engine = require('@votetorrent/vote-engine/crypto-backend');

  afterEach(() => {
    plugin.setCryptoBackend(undefined);
    engine.setCryptoBackend(undefined);
  });

  it('the plugin backend passes the plugin self-check and matches noble on every member', () => {
    const backend = makePluginCryptoBackend(nodeQuickCrypto);
    expect(() => plugin.setCryptoBackend(backend)).not.toThrow();

    const seed = ed25519.utils.randomSecretKey();
    const pub = ed25519.getPublicKey(seed);
    for (const size of [0, 1, 64, 1000, 20000]) {
      const message = nodeCrypto.randomBytes(size + 3).subarray(3);
      const view = new Uint8Array(message.buffer, message.byteOffset, message.length);
      expect(Buffer.from(backend.sha256(view))).toEqual(Buffer.from(nobleSha2.sha256(view)));
      expect(Buffer.from(backend.sha512(view))).toEqual(Buffer.from(nobleSha2.sha512(view)));
      const signature = backend.ed25519Sign(view, seed);
      expect(signature).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(signature)).toEqual(Buffer.from(ed25519.sign(view, seed)));
      expect(backend.ed25519Verify(signature, view, pub)).toBe(true);
      const tampered = signature.slice();
      tampered[10] ^= 1;
      expect(backend.ed25519Verify(tampered, view, pub)).toBe(false);
    }
  });

  it('through the plugin, sign/verify/digest give the same strings with and without the backend', () => {
    const seed = plugin.generatePrivateKey('ed25519');
    const pub = plugin.getPublicKey(seed, 'ed25519');
    const data = Buffer.from('a schema CHECK payload').toString('base64url');
    const run = () => [
      plugin.sign(data, seed, 'ed25519'),
      plugin.digest([data, 42, null], 'sha256'),
      plugin.digest([data, 'x'.repeat(3000)], 'sha512'),
      plugin.hashMod(data, 40, 'sha256'),
    ];
    const before = run();
    plugin.setCryptoBackend(makePluginCryptoBackend(nodeQuickCrypto));
    const after = run();
    expect(after).toEqual(before);
    expect(plugin.verify(data, before[0], pub, 'ed25519')).toBe(true);
    expect(plugin.verify(Buffer.from('other').toString('base64url'), before[0], pub, 'ed25519')).toBe(false);
    // A malformed key or signature is `false`, as under noble.
    expect(plugin.verify(data, before[0], Buffer.alloc(31).toString('base64url'), 'ed25519')).toBe(false);
    expect(plugin.verify(data, Buffer.alloc(10).toString('base64url'), pub, 'ed25519')).toBe(false);
  });

  it('the vote-engine backend passes the engine self-check and matches noble', () => {
    const backend = makeVoteEngineBackend(nodeQuickCrypto);
    expect(() => engine.setCryptoBackend(backend)).not.toThrow();
    const a = secp256k1.utils.randomSecretKey();
    const pub = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true);
    expect(Buffer.from(backend.secp256k1EcdhX(a, pub))).toEqual(Buffer.from(secp256k1.getSharedSecret(a, pub, true).slice(1)));
  });

  describe('makeNativeSha256', () => {
    const { sha256, status } = makeNativeSha256(nobleSha2.sha256, nodeCrypto.createHash);

    it('passes its known-answer test and keeps noble\'s API surface', () => {
      expect(status).toBe('native');
      expect(sha256).not.toBe(nobleSha2.sha256);
      expect(Object.keys(sha256).sort()).toEqual(Object.keys(nobleSha2.sha256).sort());
      expect(sha256.create).toBe(nobleSha2.sha256.create);
      expect(sha256.outputLen).toBe(32);
      expect(sha256.blockLen).toBe(64);
      expect(Object.isFrozen(sha256)).toBe(true);
    });

    it('one-shot hashes match noble, as fresh plain Uint8Arrays, for offset views too', () => {
      for (const size of [0, 1, 55, 56, 64, 2048, 70000]) {
        const backing = nodeCrypto.randomBytes(size + 9);
        const view = new Uint8Array(backing.buffer, backing.byteOffset + 4, size);
        const out = sha256(view);
        expect(Object.getPrototypeOf(out)).toBe(Uint8Array.prototype);
        expect(Buffer.from(out)).toEqual(Buffer.from(nobleSha2.sha256(view)));
      }
      expect(sha256(new Uint8Array(1))).not.toBe(sha256(new Uint8Array(1)));
    });

    it('hmac, hkdf and incremental hashing over it stay byte-identical (they use create())', () => {
      const key = nodeCrypto.randomBytes(32);
      const msg = nodeCrypto.randomBytes(100);
      expect(Buffer.from(hmac(sha256, key, msg))).toEqual(Buffer.from(hmac(nobleSha2.sha256, key, msg)));
      expect(Buffer.from(hkdf(sha256, key, msg, msg, 42))).toEqual(Buffer.from(hkdf(nobleSha2.sha256, key, msg, msg, 42)));
      expect(Buffer.from(sha256.create().update(msg).digest())).toEqual(Buffer.from(nobleSha2.sha256(msg)));
    });

    it('a non-Uint8Array argument goes to noble and throws noble\'s error', () => {
      let nobleError;
      try {
        nobleSha2.sha256('abc');
      } catch (e) {
        nobleError = e.message;
      }
      expect(nobleError).toEqual(expect.any(String));
      expect(() => sha256('abc')).toThrow(nobleError);
    });

    it('a native side that fails the known-answer test is not used', () => {
      const wrongOffset = name => {
        const hash = nodeCrypto.createHash(name);
        return {
          update(data) {
            hash.update(new Uint8Array(data.buffer)); // ignores byteOffset/length
            return this;
          },
          digest: () => hash.digest(),
        };
      };
      const made = makeNativeSha256(nobleSha2.sha256, wrongOffset);
      expect(made.status).toBe('js');
      expect(made.sha256).toBe(nobleSha2.sha256);
      const throwing = makeNativeSha256(nobleSha2.sha256, () => {
        throw new Error('no native');
      });
      expect(throwing.status).toBe('js');
    });

    it('a native error at run time falls back to noble', () => {
      let fail = false;
      const flaky = name => {
        if (fail) throw new Error('native down');
        return nodeCrypto.createHash(name);
      };
      const made = makeNativeSha256(nobleSha2.sha256, flaky);
      expect(made.status).toBe('native');
      fail = true;
      const msg = nodeCrypto.randomBytes(40);
      expect(Buffer.from(made.sha256(msg))).toEqual(Buffer.from(nobleSha2.sha256(msg)));
    });
  });
});

describe('G. noble-sha2-native.js (what Metro serves for @noble/hashes/sha2.js)', () => {
  const nobleSha2 = require('@noble/hashes/sha2.js');
  const src = stripComments(fs.readFileSync(path.resolve(__dirname, '../noble-sha2-native.js'), 'utf8'));

  it('exports exactly the names the installed @noble/hashes/sha2.js exports', () => {
    const exported = [...src.matchAll(/^export const (\w+) =/gm)].map(m => m[1]).sort();
    expect(exported).toEqual(Object.keys(nobleSha2).filter(k => k !== 'default' && k !== '__esModule').sort());
  });

  it('serves a native sha256 and noble\'s everything else, and records its status', () => {
    let shim;
    try {
      jest.isolateModules(() => {
        jest.doMock('react-native-quick-crypto', () => nodeQuickCrypto);
        shim = require('../noble-sha2-native');
      });
      expect(globalThis[NOBLE_SHA256_STATUS]).toBe('native');
      expect(shim.sha256).not.toBe(nobleSha2.sha256);
      // isolateModules gives the shim its own noble instance, so compare answers, not identity.
      const msg = nodeCrypto.randomBytes(2000);
      expect(Buffer.from(shim.sha256(msg))).toEqual(Buffer.from(nobleSha2.sha256(msg)));
      expect(Buffer.from(shim.sha512(msg))).toEqual(Buffer.from(nobleSha2.sha512(msg)));
      expect(Buffer.from(shim.sha384(msg))).toEqual(Buffer.from(nobleSha2.sha384(msg)));
      expect(shim.sha512.name).toBe('hashC'); // noble's own function, not a wrapper
      expect(new shim._SHA256().update(msg).digest()).toEqual(nobleSha2.sha256(msg));
    } finally {
      delete globalThis[NOBLE_SHA256_STATUS];
    }
  });
});

describe('H. metro.noble-sha256.js (the resolver redirect)', () => {
  const os = require('os');
  const { createNobleSha256Redirect } = require('../../metro.noble-sha256');
  const APP = path.resolve(__dirname, '../..');
  const redirect = createNobleSha256Redirect(APP);
  const appSha2 = path.join(APP, 'node_modules/@noble/hashes/sha2.js');
  const engineSha2 = path.resolve(APP, '../../packages/vote-engine/node_modules/@noble/hashes/sha2.js');
  const file = filePath => ({ type: 'sourceFile', filePath });
  const shim = file(redirect.shimPath);

  it('sends a dependency\'s sha2 import to the shim, from the app copy or another same-version copy', () => {
    expect(redirect.appVersion).toMatch(/^2\./);
    const dbp2p = path.join(APP, 'node_modules/@optimystic/db-p2p/dist/src/cluster/certified-claims.js');
    expect(redirect(dbp2p, file(appSha2))).toEqual(shim);
    const engineFile = path.resolve(APP, '../../packages/vote-engine/dist/utils.js');
    expect(redirect(engineFile, file(engineSha2))).toEqual(shim);
  });

  it('leaves noble\'s own imports, quick-crypto\'s, the shim\'s and other modules alone', () => {
    const curves = path.join(APP, 'node_modules/@noble/curves/ed25519.js');
    const qc = path.join(APP, 'node_modules/react-native-quick-crypto/src/hash.ts');
    expect(redirect(curves, file(appSha2))).toEqual(file(appSha2));
    expect(redirect(qc, file(appSha2))).toEqual(file(appSha2));
    expect(redirect(redirect.shimPath, file(appSha2))).toEqual(file(appSha2));
    const hmacFile = file(path.join(APP, 'node_modules/@noble/hashes/hmac.js'));
    expect(redirect(path.join(APP, 'App.tsx'), hmacFile)).toBe(hmacFile);
    expect(redirect(path.join(APP, 'App.tsx'), { type: 'empty' })).toEqual({ type: 'empty' });
  });

  it('leaves a copy of a different version alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noble-other-'));
    try {
      const copy = path.join(dir, 'node_modules/@noble/hashes');
      fs.mkdirSync(copy, { recursive: true });
      fs.writeFileSync(path.join(copy, 'package.json'), JSON.stringify({ version: '1.8.0' }));
      const other = file(path.join(copy, 'sha2.js'));
      expect(redirect(path.join(dir, 'node_modules/old-dep/index.js'), other)).toBe(other);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(APP_ROOTS)('%s metro.config.js routes every resolution through it', (_label, root) => {
    const src = stripComments(fs.readFileSync(path.join(root, 'metro.config.js'), 'utf8'));
    expect(src).toContain('const { createNobleSha256Redirect } = require("./metro.noble-sha256");');
    expect(src).toContain('const resolved = nobleSha256Redirect(\n\t\tcontext.originModulePath,');
  });
});

describe('E. the Voter runs the same native crypto', () => {
  const VOTER = path.resolve(__dirname, '../../../VoteTorrentVoter');

  it.each([
    'polyfills/native-ed25519.js',
    'polyfills/native-crypto.js',
    'polyfills/native-backends.js',
    'polyfills/noble-sha2-native.js',
    'metro.noble-sha256.js',
  ])('%s is byte-identical in both apps', file => {
    const authority = fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
    const voter = fs.readFileSync(path.join(VOTER, file), 'utf8');
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
