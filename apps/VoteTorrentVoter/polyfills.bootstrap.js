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
if (globalThis.crypto && !globalThis.crypto.subtle) {
  const {sha256, sha512} = require('@noble/hashes/sha2.js');
  const notPolyfilled = name =>
    function () {
      return Promise.reject(
        new Error(
          `crypto.subtle.${name} is not polyfilled (digest-only shim) — ` +
            'see polyfills.bootstrap.js section 2 (WR-13, 17-REVIEW). A dependency ' +
            'feature-detected WebCrypto and took the subtle branch; either extend ' +
            'this shim or force the pure-JS fallback in that dependency.',
        ),
      );
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
}

// 3. TextDecoder (UTF-8) — bare RN 0.78 Hermes lacks it (Expo provides it; that's why the
//    reference app's bare-RN fallback exists). uint8arrays does `new TextDecoder()` at module scope.
if (typeof globalThis.TextDecoder === 'undefined') {
  // IN-13 (17-REVIEW): malformed/truncated UTF-8 must NOT silently decode to
  // wrong characters. Per the WHATWG Encoding spec: invalid sequences emit
  // U+FFFD (or throw a TypeError when constructed with { fatal: true }), a
  // leading BOM is stripped unless { ignoreBOM: true }, and overlong/
  // surrogate/out-of-range encodings are rejected.
  globalThis.TextDecoder = class {
    constructor(label = 'utf-8', options = {}) {
      const enc = String(label).toLowerCase().replace('_', '-');
      if (enc !== 'utf-8' && enc !== 'utf8') {
        throw new RangeError(`TextDecoder polyfill is UTF-8 only (got "${label}")`);
      }
      this.encoding = 'utf-8';
      this.fatal = !!options.fatal;
      this.ignoreBOM = !!options.ignoreBOM;
    }
    decode(input) {
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input ?? []);
      let i = 0;
      // Strip a leading UTF-8 BOM unless ignoreBOM was requested (spec default).
      if (!this.ignoreBOM && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        i = 3;
      }
      let s = '';
      const fatal = this.fatal;
      const fail = reason => {
        if (fatal) throw new TypeError('TextDecoder.decode: invalid UTF-8 — ' + reason);
        s += '�';
      };
      while (i < bytes.length) {
        const b = bytes[i++];
        if (b < 0x80) {
          s += String.fromCharCode(b);
          continue;
        }
        let needed, cp, min;
        if (b >= 0xc2 && b < 0xe0) { needed = 1; cp = b & 0x1f; min = 0x80; }
        else if (b >= 0xe0 && b < 0xf0) { needed = 2; cp = b & 0x0f; min = 0x800; }
        else if (b >= 0xf0 && b < 0xf5) { needed = 3; cp = b & 0x07; min = 0x10000; }
        else { fail('invalid leading byte 0x' + b.toString(16)); continue; }
        let ok = true;
        for (let k = 0; k < needed; k++) {
          const c = bytes[i];
          if (c === undefined || (c & 0xc0) !== 0x80) { ok = false; break; }
          cp = (cp << 6) | (c & 0x3f);
          i++;
        }
        if (!ok) { fail('truncated or invalid continuation byte'); continue; }
        if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
          fail('overlong, surrogate, or out-of-range sequence');
          continue;
        }
        if (cp >= 0x10000) {
          const c = cp - 0x10000;
          s += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
        } else {
          s += String.fromCharCode(cp);
        }
      }
      return s;
    }
  };
}

// 4. structuredClone (Quereus B-tree uses it; Hermes lacks it)
if (typeof globalThis.structuredClone !== 'function') {
  const sc = require('@ungap/structured-clone').default;
  globalThis.structuredClone = v => sc(v);
}

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

// 7. AbortSignal.prototype.throwIfAborted
if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.prototype.throwIfAborted !== 'function') {
  AbortSignal.prototype.throwIfAborted = function () {
    if (this.aborted) throw this.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  };
}

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
