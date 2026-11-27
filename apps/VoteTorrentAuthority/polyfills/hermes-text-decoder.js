// IN-13 (17-REVIEW): malformed/truncated UTF-8 must NOT silently decode to
// wrong characters. Per the WHATWG Encoding spec: invalid sequences emit
// U+FFFD (or throw a TypeError when constructed with { fatal: true }), a
// leading BOM is stripped unless { ignoreBOM: true }, and overlong/
// surrogate/out-of-range encodings are rejected.
//
// ASSUMPTION A-1 (58-03, D-04): ASCII_CHUNK bounds how many bytes are passed
// to String.fromCharCode.apply(...) at once. Hermes publishes no
// Function.prototype.apply argument ceiling. The only concretely documented
// cross-engine number is JavaScriptCore's hard-coded 65536-argument limit;
// 4096 is 16x below that, chosen for headroom rather than throughput — the
// ASCII runs on this path are typically far shorter than 4096 anyway, so a
// larger chunk buys nothing measurable while enlarging exposure to an
// unverified limit. This is NOT a verified Hermes constant.
const ASCII_CHUNK = 4096;

module.exports = class {
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
      const start = i;
      while (i < bytes.length && bytes[i] < 0x80) i++;
      if (i > start) {
        for (let c = start; c < i; c += ASCII_CHUNK) {
          s += String.fromCharCode.apply(null, bytes.subarray(c, Math.min(c + ASCII_CHUNK, i)));
        }
        continue;
      }
      const b = bytes[i++];
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
