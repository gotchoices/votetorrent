/**
 * PROPOSED polyfill bootstrap for apps/VoteTorrentAuthority (bare RN 0.78 + Hermes).
 * Spike 002 artifact — import this at the VERY TOP of index.js, before any other import:
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
 * Required deps (add to apps/VoteTorrentAuthority/package.json):
 *   react-native-get-random-values, @noble/hashes@^2 (NOT ^1 — VoteTorrent currently has 1.8.0),
 *   @ungap/structured-clone, web-streams-polyfill, readable-stream, buffer, event-target-polyfill
 */

// 1. CSPRNG — MUST be first; without it libp2p key generation is insecure.
import 'react-native-get-random-values';

// 2. crypto.subtle.digest (SHA-256/512) via @noble/hashes
if (globalThis.crypto && !globalThis.crypto.subtle) {
  const {sha256, sha512} = require('@noble/hashes/sha2');
  globalThis.crypto.subtle = {
    digest(algorithm, data) {
      const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
      const fn = name === 'SHA-512' ? sha512 : name === 'SHA-256' ? sha256 : null;
      return fn
        ? Promise.resolve(fn(new Uint8Array(data)).buffer)
        : Promise.reject(new Error('Unsupported digest: ' + name));
    },
  };
}

// 3. TextDecoder (UTF-8) — bare RN 0.78 Hermes lacks it (Expo provides it; that's why the
//    reference app's bare-RN fallback exists). uint8arrays does `new TextDecoder()` at module scope.
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class {
    constructor(label = 'utf-8') {
      const enc = String(label).toLowerCase().replace('_', '-');
      if (enc !== 'utf-8' && enc !== 'utf8') {
        throw new RangeError(`TextDecoder polyfill is UTF-8 only (got "${label}")`);
      }
      this.encoding = 'utf-8';
    }
    decode(input) {
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input ?? []);
      let s = '';
      for (let i = 0; i < bytes.length; ) {
        const b = bytes[i++];
        if (b < 0x80) s += String.fromCharCode(b);
        else if (b < 0xe0) s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
        else if (b < 0xf0) s += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
        else {
          const cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
          const c = cp - 0x10000;
          s += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
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
