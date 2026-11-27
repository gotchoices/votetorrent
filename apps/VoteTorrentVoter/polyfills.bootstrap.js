/**
 * Polyfill bootstrap for apps/VoteTorrentVoter (bare RN 0.78 + Hermes).
 * Phase 44 (D-02/D-04): ported verbatim from apps/VoteTorrentAuthority/polyfills.bootstrap.js
 * (Spike 002 artifact, hardened across Phases 17/40) — import this at the VERY TOP of
 * index.js, before any other import:
 *
 *   // index.js
 *   import './polyfills.bootstrap';   // <-- first line
 *   import {AppRegistry} from 'react-native';
 *   ...
 *
 * Derived from Sereus reference-app-rn's polyfills/hermes.js. Because VoteTorrent is BARE RN
 * (not Expo), it needs MORE than the reference app: notably TextDecoder, which Expo SDK 52+
 * provides natively but bare RN 0.78 does not.
 *
 * Required deps (added to apps/VoteTorrentVoter/package.json):
 *   react-native-get-random-values, @noble/hashes@^2,
 *   @ungap/structured-clone, web-streams-polyfill, readable-stream, buffer, event-target-polyfill
 */

// 1. CSPRNG — MUST be first; without it libp2p key generation is insecure.
import 'react-native-get-random-values';

// 1b. crypto.randomUUID — Hermes' global crypto (after react-native-get-random-values)
//     exposes getRandomValues but NOT randomUUID. Several engines call the GLOBAL
//     crypto.randomUUID() (e.g. NetworksEngine/NetworkEngine/SigningEngine), which
//     works under Node 19+ but is undefined on Hermes. Polyfill it via getRandomValues.
if (globalThis.crypto && typeof globalThis.crypto.randomUUID !== 'function') {
  const _uuidHex = [];
  for (let i = 0; i < 256; i++) _uuidHex.push((i + 0x100).toString(16).slice(1));
  globalThis.crypto.randomUUID = function randomUUID() {
    const b = new Uint8Array(16);
    globalThis.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10
    return (
      _uuidHex[b[0]] + _uuidHex[b[1]] + _uuidHex[b[2]] + _uuidHex[b[3]] + '-' +
      _uuidHex[b[4]] + _uuidHex[b[5]] + '-' +
      _uuidHex[b[6]] + _uuidHex[b[7]] + '-' +
      _uuidHex[b[8]] + _uuidHex[b[9]] + '-' +
      _uuidHex[b[10]] + _uuidHex[b[11]] + _uuidHex[b[12]] + _uuidHex[b[13]] + _uuidHex[b[14]] + _uuidHex[b[15]]
    );
  };
}

// 2. crypto.subtle.digest (SHA-256/512) via @noble/hashes
//    WR-13 (17-REVIEW): this shim is DIGEST-ONLY. Libraries that feature-detect
//    WebCrypto via `if (crypto.subtle)` and then call importKey/sign/encrypt
//    (several @libp2p/* browser builds do this for AES/RSA/HMAC paths) would
//    otherwise crash with a bare "undefined is not a function". Every other
//    SubtleCrypto method is installed as a throwing stub that NAMES the gap so
//    such a failure is immediately diagnosable instead of latent.
//
//    Both are TAGGED so polyfills/native-crypto.js can swap in native code once
//    react-native-quick-crypto has loaded: the digest with the sereus kit's own tag, which
//    `@serfab/cadre-rn/native-digest` requires before it replaces anything (untagged, every
//    block hash stayed pure JS even with native Noise loaded), and the stubs with ours, so
//    only these placeholders are ever replaced.
if (globalThis.crypto && !globalThis.crypto.subtle) {
  const {sha256, sha512} = require('@noble/hashes/sha2.js');
  const notPolyfilled = name => {
    const stub = function () {
      return Promise.reject(
        new Error(
          `crypto.subtle.${name} is not polyfilled (digest-only shim) — ` +
            'see polyfills.bootstrap.js section 2 (WR-13, 17-REVIEW). A dependency ' +
            'feature-detected WebCrypto and took the subtle branch; either extend ' +
            'this shim or force the pure-JS fallback in that dependency.',
        ),
      );
    };
    stub[Symbol.for('votetorrent/subtle-stub')] = true;
    return stub;
  };
  globalThis.crypto.subtle = {
    digest(algorithm, data) {
      const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
      const fn = name === 'SHA-512' ? sha512 : name === 'SHA-256' ? sha256 : null;
      return fn
        ? Promise.resolve(fn(new Uint8Array(data)).buffer)
        : Promise.reject(new Error('Unsupported digest: ' + name));
    },
    encrypt: notPolyfilled('encrypt'),
    decrypt: notPolyfilled('decrypt'),
    sign: notPolyfilled('sign'),
    verify: notPolyfilled('verify'),
    generateKey: notPolyfilled('generateKey'),
    deriveKey: notPolyfilled('deriveKey'),
    deriveBits: notPolyfilled('deriveBits'),
    importKey: notPolyfilled('importKey'),
    exportKey: notPolyfilled('exportKey'),
    wrapKey: notPolyfilled('wrapKey'),
    unwrapKey: notPolyfilled('unwrapKey'),
  };
  globalThis.crypto.subtle.digest[Symbol.for('@serfab/cadre-rn/js-digest')] = true;
}

// 3. TextDecoder (UTF-8) — bare RN 0.78 Hermes lacks it (Expo provides it; that's why the
//    reference app's bare-RN fallback exists). uint8arrays does `new TextDecoder()` at module scope.
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = require('./polyfills/hermes-text-decoder');
}

// 4. structuredClone (Quereus B-tree and Optimystic's db-core use it; Hermes lacks it). The sereus
//    kit's arm, adopted verbatim (cadre-rn 1.19.0, sereus#51): plain data is copied directly and
//    anything else goes through @ungap/structured-clone, the bare ungap this used to install. It
//    checks for a native structuredClone itself. See polyfills/hermes-structured-clone.js.
require('./polyfills/hermes-structured-clone');

// 5. Web Streams
if (typeof globalThis.ReadableStream === 'undefined') {
  const ws = require('web-streams-polyfill');
  globalThis.ReadableStream = ws.ReadableStream;
  globalThis.WritableStream = ws.WritableStream;
  globalThis.TransformStream = ws.TransformStream;
}

// 6. Promise.withResolvers
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function () {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return {promise, resolve, reject};
  };
}

// 6b. DOMException — bare RN 0.78 Hermes has no DOMException global. The abort/timeout
//     polyfills below and libp2p's dial path (`signal.reason`, AbortError/TimeoutError)
//     construct DOMException; without this the timeout callback throws ReferenceError
//     and the noise upgrade surfaces as an empty-message EncryptionFailedError (P2P-01).
if (typeof globalThis.DOMException === 'undefined') {
  globalThis.DOMException = class DOMException extends Error {
    constructor(message = '', name = 'Error') {
      super(message);
      this.name = name;
    }
  };
}

// 6c. WebSocket.bufferedAmount — RN's WebSocket lacks bufferedAmount. @libp2p/websockets
//     backpressure logic does `canSendMore = ws.bufferedAmount < max` (undefined < N → false)
//     and waits for a drain that's gated on `ws.bufferedAmount === 0` (undefined === 0 → never),
//     so EVERY outbound libp2p WS write stalls after the first chunk (P2P-01 dial stall).
//     RN's bridge exposes no send buffer, so 0 ("flushed") is the honest constant.
if (typeof WebSocket !== 'undefined' && !('bufferedAmount' in WebSocket.prototype)) {
  Object.defineProperty(WebSocket.prototype, 'bufferedAmount', {
    get() { return 0; },
    configurable: true,
  });
}

// 6d. WebSocket send batching (ported from sereus-chat, polyfills/websocket-batching.js): the
//     binary sends libp2p makes in one turn reach native code as ONE message, in order. Each RN
//     binary send is a bridge crossing that base64-encodes on the JS thread first, and about half
//     of libp2p's are 16 bytes or fewer. Measured only on NativeScript (62% fewer native sends);
//     UNVERIFIED on React Native, so it needs a device measurement with this on and off.
//     Set WEBSOCKET_SEND_BATCHING to false to send every chunk as before.
const WEBSOCKET_SEND_BATCHING = true;
if (WEBSOCKET_SEND_BATCHING && typeof WebSocket !== 'undefined') {
  require('./polyfills/websocket-batching').batchWebSocketSends(WebSocket.prototype);
}

// 7. AbortSignal.prototype.throwIfAborted
if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.prototype.throwIfAborted !== 'function') {
  AbortSignal.prototype.throwIfAborted = function () {
    if (this.aborted) throw this.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  };
}

// 7a. AbortController `reason` + AbortSignal.any. RN's abort-controller@3.0.0 drops every abort
//     reason, so libp2p's raceSignal rejects with `undefined` and the upgrader's
//     `err.message` masks the real failure (spike 092, explaining spike 069). A `require`,
//     not an `import`, so it runs HERE, after the DOMException arm, and not hoisted above it.
require('./polyfills/hermes-abort-reason');

// 7b. AbortSignal.timeout — bare RN 0.78 Hermes lacks this static (Expo's Hermes has it, so the
//     reference app didn't need it). libp2p's dial path calls AbortSignal.timeout(ms); without it a
//     dial throws "AbortSignal.timeout is not a function". Confirmed needed on-device by spike 009.
if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
  AbortSignal.timeout = function timeout(ms) {
    const c = new AbortController();
    setTimeout(() => c.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
    return c.signal;
  };
}

// 8. Symbol.asyncIterator (for `for await…of` in Quereus/libp2p)
if (typeof Symbol !== 'undefined' && typeof Symbol.asyncIterator === 'undefined') {
  try {
    Object.defineProperty(Symbol, 'asyncIterator', {value: Symbol.for('Symbol.asyncIterator')});
  } catch {
    Symbol.asyncIterator = Symbol.for('Symbol.asyncIterator');
  }
}

// 8b. Intl.PluralRules (English-only) — spike 010/011: the newer optimystic line (0.13.6)
//     pulls `moat-maker`, which constructs `new Intl.PluralRules(...)` at module scope for
//     ordinal error formatting. Bare RN 0.78 Hermes's Intl build lacks PluralRules, so without
//     this the first import of the optimystic stack throws at module load. (Lifted from the
//     sereus-chat reference app, which added it for the same reason.)
if (typeof Intl !== 'undefined' && typeof Intl.PluralRules === 'undefined') {
  const ordinal = n => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return 'one';
    if (m10 === 2 && m100 !== 12) return 'two';
    if (m10 === 3 && m100 !== 13) return 'few';
    return 'other';
  };
  Intl.PluralRules = class PluralRules {
    constructor(_locale, options) { this._type = options?.type === 'ordinal' ? 'ordinal' : 'cardinal'; }
    select(n) { return this._type === 'ordinal' ? ordinal(n) : (n === 1 ? 'one' : 'other'); }
    resolvedOptions() { return {type: this._type, locale: 'en'}; }
  };
}

// 9. EventTarget / CustomEvent
import 'event-target-polyfill';
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, params) { super(type, params); this.detail = params?.detail ?? null; }
  };
}

// 10. Timer .ref()/.unref() — Node timers return objects with .ref()/.unref(); Hermes returns
//     numbers. Required by @optimystic/db-p2p (ClusterMember calls expirationInterval.unref()).
//     Confirmed needed on-device by spike 007 (`TypeError: this.expirationInterval.unref is not a
//     function`). clearTimeout/clearInterval are patched to unwrap, since RN's native clear expects
//     the raw numeric id. (Verbatim from reference-app-rn polyfills/hermes.js.)
{
  const _setTimeout = globalThis.setTimeout;
  const _setInterval = globalThis.setInterval;
  const _clearTimeout = globalThis.clearTimeout;
  const _clearInterval = globalThis.clearInterval;
  const unwrap = h => (h && typeof h === 'object' && '_id' in h ? h._id : h);
  const wrap = id => {
    if (typeof id === 'object' && id !== null) return id;
    return { _id: id, ref() { return this; }, unref() { return this; }, [Symbol.toPrimitive]() { return this._id; } };
  };
  globalThis.setTimeout = function (...a) { return wrap(_setTimeout.apply(this, a)); };
  Object.assign(globalThis.setTimeout, _setTimeout);
  globalThis.setInterval = function (...a) { return wrap(_setInterval.apply(this, a)); };
  Object.assign(globalThis.setInterval, _setInterval);
  globalThis.clearTimeout = function (h) { return _clearTimeout.call(this, unwrap(h)); };
  globalThis.clearInterval = function (h) { return _clearInterval.call(this, unwrap(h)); };
}

// NOTE: Do NOT add fast-text-encoding (double-encoding bugs; Hermes has native TextEncoder).
