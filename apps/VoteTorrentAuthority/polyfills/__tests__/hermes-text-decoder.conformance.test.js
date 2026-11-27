/**
 * WHATWG conformance suite for the extracted Hermes UTF-8 TextDecoder (58-02).
 *
 * This suite is D-06's evidence: it MUST be green against the UNMODIFIED decoder. It is written
 * and proven green BEFORE 58-03's chunked-ASCII rewrite, so a later red run means the rewrite
 * changed behaviour, not that the suite is broken.
 *
 * It is parameterised over BOTH apps' copies (`describe.each(COPIES)` below) so the Voter's
 * decoder is covered without a device run (D-13) — plus 58-01's byte-identity guard
 * (`polyfill-drift.test.js`), this suite is the only thing that exercises the Voter's file at all.
 *
 * It requires the extracted module directly, never `polyfills.bootstrap.js` (D-14): the bootstrap
 * installs the class behind `if (typeof globalThis.TextDecoder === 'undefined')`, and jest's Node
 * environment supplies a native TextDecoder, so that guard is permanently false under jest and the
 * polyfill class would never be reached that way.
 *
 * The Voter app's own `yarn test` does NOT run this file — jest's default `__tests__` discovery
 * only picks it up from the Authority workspace it lives in. That is intentional: D-13 requires the
 * Voter's copy be *covered*, not that the Voter's own runner be the one to cover it.
 */

const AuthorityDecoder = require('../hermes-text-decoder');
const VoterDecoder = require('../../../VoteTorrentVoter/polyfills/hermes-text-decoder');

const COPIES = [
  ['authority', AuthorityDecoder],
  ['voter', VoterDecoder],
];

function bytes(...values) {
  return new Uint8Array(values);
}

function countReplacements(s) {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0xfffd) count++;
  }
  return count;
}

function hasUnpairedSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const isHigh = c >= 0xd800 && c <= 0xdbff;
    const isLow = c >= 0xdc00 && c <= 0xdfff;
    if (isHigh) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++; // consume the paired low surrogate
    } else if (isLow) {
      // A lone low surrogate not already consumed by a preceding high surrogate.
      return true;
    }
  }
  return false;
}

describe.each(COPIES)('hermes-text-decoder conformance (%s)', (_label, Decoder) => {
  describe('CF-A — valid input, default options', () => {
    test('CF-A01 5-byte pure-ASCII input decodes verbatim', () => {
      const out = new Decoder().decode(bytes(0x48, 0x65, 0x6c, 0x6c, 0x6f));
      expect(out).toBe('Hello');
      expect(out.length).toBe(5);
    });

    test('CF-A02 2-byte sequence decodes to U+00E9', () => {
      const out = new Decoder().decode(bytes(0xc3, 0xa9));
      expect(out.length).toBe(1);
      expect(out.codePointAt(0)).toBe(0x00e9);
    });

    test('CF-A03 3-byte sequence decodes to U+20AC', () => {
      const out = new Decoder().decode(bytes(0xe2, 0x82, 0xac));
      expect(out.length).toBe(1);
      expect(out.codePointAt(0)).toBe(0x20ac);
    });

    test('CF-A04 4-byte sequence yields a surrogate pair', () => {
      const out = new Decoder().decode(bytes(0xf0, 0x9f, 0x98, 0x80));
      expect(out.length).toBe(2);
      expect(out.charCodeAt(0)).toBe(0xd83d);
      expect(out.charCodeAt(1)).toBe(0xde00);
      expect(out.codePointAt(0)).toBe(0x1f600);
    });

    test('CF-A05 mixed-script string round-trips against native TextEncoder bytes', () => {
      const source = 'Hello, é€😀 world — café naïve 123';
      const encoded = new TextEncoder().encode(source);
      const out = new Decoder().decode(encoded);
      expect(out).toBe(source);
    });

    test('CF-A06 empty Uint8Array decodes to the empty string', () => {
      const out = new Decoder().decode(new Uint8Array());
      expect(out).toBe('');
    });

    test('CF-A07 decode() with no argument returns the empty string', () => {
      const out = new Decoder().decode();
      expect(out).toBe('');
    });

    test('CF-A08 decode(null) returns the empty string', () => {
      const out = new Decoder().decode(null);
      expect(out).toBe('');
    });

    test('CF-A09 a plain ArrayBuffer input decodes correctly', () => {
      const buf = bytes(0x41, 0x42).buffer;
      const out = new Decoder().decode(buf);
      expect(out).toBe('AB');
    });

    test('CF-A10 a plain number array input decodes correctly', () => {
      const out = new Decoder().decode([0x41, 0x42]);
      expect(out).toBe('AB');
    });

    test.each([4095, 4096, 4097, 8191, 8192, 8193, 10000])(
      'CF-A11 a run of %i ASCII bytes decodes to a matching-length all-A string',
      n => {
        const input = new Uint8Array(n).fill(0x41);
        const out = new Decoder().decode(input);
        expect(out.length).toBe(n);
        expect(out).toMatch(/^A+$/);
      },
    );

    test.each([4095, 4096, 8191, 8192])(
      'CF-A12 %i ASCII bytes then a 3-byte sequence then one more ASCII byte decodes to length N+2 ending "A€B"',
      n => {
        const input = new Uint8Array(n + 4);
        input.fill(0x41, 0, n);
        input[n] = 0xe2;
        input[n + 1] = 0x82;
        input[n + 2] = 0xac;
        input[n + 3] = 0x42;
        const out = new Decoder().decode(input);
        expect(out.length).toBe(n + 2);
        expect(out.endsWith('A€B')).toBe(true);
      },
    );

    test('CF-A13 a 1MiB run of ASCII bytes decodes to matching length (structural only, no timing)', () => {
      const input = new Uint8Array(1048576).fill(0x41);
      const out = new Decoder().decode(input);
      expect(out.length).toBe(1048576);
    });
  });

  describe('CF-B — BOM, label, constructor surface', () => {
    test('CF-B01 a leading BOM followed by one byte is stripped by default', () => {
      const out = new Decoder().decode(bytes(0xef, 0xbb, 0xbf, 0x41));
      expect(out).toBe('A');
      expect(out.length).toBe(1);
    });

    test('CF-B02 a bare leading BOM decodes to the empty string by default', () => {
      const out = new Decoder().decode(bytes(0xef, 0xbb, 0xbf));
      expect(out).toBe('');
      expect(out.length).toBe(0);
    });

    test('CF-B03 ignoreBOM:true keeps the BOM as U+FEFF ahead of the following byte', () => {
      const out = new Decoder('utf-8', { ignoreBOM: true }).decode(bytes(0xef, 0xbb, 0xbf, 0x41));
      expect(out.length).toBe(2);
      expect(out.charCodeAt(0)).toBe(0xfeff);
      expect(out.charCodeAt(1)).toBe(0x41);
    });

    test('CF-B04 a BOM not at offset 0 is decoded as U+FEFF, not stripped', () => {
      const out = new Decoder().decode(bytes(0x41, 0xef, 0xbb, 0xbf));
      expect(out.length).toBe(2);
      expect(out.charCodeAt(1)).toBe(0xfeff);
    });

    test.each(['utf-8', 'utf8', 'UTF-8', 'utf_8', 'Utf8'])(
      'CF-B05 label %s constructs without throwing and normalises encoding to utf-8',
      label => {
        const decoder = new Decoder(label);
        expect(decoder.encoding).toBe('utf-8');
      },
    );

    test('CF-B05 no-argument constructor also normalises encoding to utf-8', () => {
      const decoder = new Decoder();
      expect(decoder.encoding).toBe('utf-8');
    });

    test.each(['utf-16le', 'latin1', 'windows-1252', ''])(
      'CF-B06 unsupported label %s throws RangeError',
      label => {
        expect(() => new Decoder(label)).toThrow(RangeError);
      },
    );

    test('CF-B07 a default-constructed instance reports fatal/ignoreBOM/encoding defaults', () => {
      const decoder = new Decoder();
      expect(decoder.fatal).toBe(false);
      expect(decoder.ignoreBOM).toBe(false);
      expect(decoder.encoding).toBe('utf-8');
    });

    test('CF-B08 the module export is a constructor function (58-01 CommonJS class-export contract)', () => {
      expect(typeof Decoder).toBe('function');
    });
  });

  describe('CF-C — malformed input, fatal: false (U+FFFD substitution)', () => {
    test('CF-C01 an invalid lead byte 0xFF yields exactly one replacement character', () => {
      const out = new Decoder().decode(bytes(0xff));
      expect(countReplacements(out)).toBe(1);
      expect(out).toBe('�');
    });

    test('CF-C02 a stray continuation byte 0x80 yields exactly one replacement character', () => {
      const out = new Decoder().decode(bytes(0x80));
      expect(countReplacements(out)).toBe(1);
      expect(out).toBe('�');
    });

    test('CF-C03 overlong-NUL C0 80 yields exactly two replacement characters (C0 fails as lead, then 80 fails as lead)', () => {
      const out = new Decoder().decode(bytes(0xc0, 0x80));
      expect(countReplacements(out)).toBe(2);
      expect(out).toBe('��');
    });

    test('CF-C04 overlong C1 BF yields exactly two replacement characters (same shape as CF-C03)', () => {
      const out = new Decoder().decode(bytes(0xc1, 0xbf));
      expect(countReplacements(out)).toBe(2);
      expect(out).toBe('��');
    });

    // PINNED BASELINE DIVERGENCE (CF-C05 … CF-C09): the current decoder emits ONE replacement
    // character for these five overlong/surrogate/out-of-range 3- and 4-byte sequences, where a
    // strictly WHATWG-conformant decoder emits three (for 3-byte inputs) or four (for the 4-byte
    // input). This is a recorded observation of the CURRENT implementation, not a spec quotation —
    // D-06 requires green against the unmodified decoder, D-04 forbids touching the multi-byte
    // branches, and this plan forbids any production edit, so the count is pinned as-is rather than
    // "corrected". 58-03's rewrite must preserve it, since D-04 leaves these branches untouched.
    // This is a spec-fidelity gap, not a security gap: CF-C15 below proves the malformed code point
    // is rejected in every one of these cases and never reaches the caller — only the substitution
    // COUNT differs from WHATWG.
    test('CF-C05 [PINNED DIVERGENCE] overlong E0 80 80 yields exactly one replacement character (WHATWG/native emit 3)', () => {
      const out = new Decoder().decode(bytes(0xe0, 0x80, 0x80));
      expect(countReplacements(out)).toBe(1);
      expect(out).toBe('�');
    });

    test('CF-C06 [PINNED DIVERGENCE] overlong F0 80 80 80 yields exactly one replacement character (WHATWG/native emit 4)', () => {
      const out = new Decoder().decode(bytes(0xf0, 0x80, 0x80, 0x80));
      expect(countReplacements(out)).toBe(1);
      expect(out).toBe('�');
    });

    test('CF-C07 [PINNED DIVERGENCE] surrogate ED A0 80 (U+D800) yields exactly one replacement character (WHATWG/native emit 3)', () => {
      const out = new Decoder().decode(bytes(0xed, 0xa0, 0x80));
      expect(countReplacements(out)).toBe(1);
      expect(out).toBe('�');
    });

    test('CF-C08 [PINNED DIVERGENCE] surrogate ED BF BF (U+DFFF) yields exactly one replacement character (WHATWG/native emit 3)', () => {
      const out = new Decoder().decode(bytes(0xed, 0xbf, 0xbf));
      expect(countReplacements(out)).toBe(1);
      expect(out).toBe('�');
    });

    test('CF-C09 [PINNED DIVERGENCE] out-of-range F4 90 80 80 (U+110000) yields exactly one replacement character (WHATWG/native emit 4)', () => {
      const out = new Decoder().decode(bytes(0xf4, 0x90, 0x80, 0x80));
      expect(countReplacements(out)).toBe(1);
      expect(out).toBe('�');
    });

    test('CF-C10 F5 80 80 80 yields exactly four replacement characters, matching native/WHATWG', () => {
      const out = new Decoder().decode(bytes(0xf5, 0x80, 0x80, 0x80));
      expect(countReplacements(out)).toBe(4);
      expect(out).toBe('����');
    });

    test('CF-C11 an EOF mid-sequence (E2 82) yields exactly one replacement character', () => {
      const out = new Decoder().decode(bytes(0xe2, 0x82));
      expect(countReplacements(out)).toBe(1);
      expect(out).toBe('�');
    });

    test('CF-C12 an EOF mid-sequence (C3) yields exactly one replacement character', () => {
      const out = new Decoder().decode(bytes(0xc3));
      expect(countReplacements(out)).toBe(1);
      expect(out).toBe('�');
    });

    test('CF-C13 E2 82 41 substitutes then re-scans the trailing ASCII byte, not consuming it', () => {
      const out = new Decoder().decode(bytes(0xe2, 0x82, 0x41));
      expect(out.length).toBe(2);
      expect(out).toBe('�A');
    });

    test('CF-C14 41 FF 42 substitutes only the invalid middle byte, preserving both ASCII bytes', () => {
      const out = new Decoder().decode(bytes(0x41, 0xff, 0x42));
      expect(out.length).toBe(3);
      expect(out).toBe('A�B');
    });

    test('CF-C15 [security invariant] no output across the CF-C corpus ever contains an unpaired surrogate code unit', () => {
      const corpus = [
        bytes(0xff),
        bytes(0x80),
        bytes(0xc0, 0x80),
        bytes(0xc1, 0xbf),
        bytes(0xe0, 0x80, 0x80),
        bytes(0xf0, 0x80, 0x80, 0x80),
        bytes(0xed, 0xa0, 0x80),
        bytes(0xed, 0xbf, 0xbf),
        bytes(0xf4, 0x90, 0x80, 0x80),
        bytes(0xf5, 0x80, 0x80, 0x80),
        bytes(0xe2, 0x82),
        bytes(0xc3),
        bytes(0xe2, 0x82, 0x41),
        bytes(0x41, 0xff, 0x42),
      ];
      const decoder = new Decoder();
      for (const input of corpus) {
        const out = decoder.decode(input);
        expect(hasUnpairedSurrogate(out)).toBe(false);
      }
    });
  });

  describe('CF-F — fatal: true', () => {
    test('CF-F01 invalid lead byte 0xFF throws TypeError', () => {
      const decoder = new Decoder('utf-8', { fatal: true });
      expect(() => decoder.decode(bytes(0xff))).toThrow(TypeError);
    });

    test('CF-F02 truncated E2 82 throws TypeError', () => {
      const decoder = new Decoder('utf-8', { fatal: true });
      expect(() => decoder.decode(bytes(0xe2, 0x82))).toThrow(TypeError);
    });

    test('CF-F03 surrogate ED A0 80 throws TypeError', () => {
      const decoder = new Decoder('utf-8', { fatal: true });
      expect(() => decoder.decode(bytes(0xed, 0xa0, 0x80))).toThrow(TypeError);
    });

    test('CF-F04 overlong E0 80 80 throws TypeError', () => {
      const decoder = new Decoder('utf-8', { fatal: true });
      expect(() => decoder.decode(bytes(0xe0, 0x80, 0x80))).toThrow(TypeError);
    });

    test('CF-F05 out-of-range F4 90 80 80 throws TypeError', () => {
      const decoder = new Decoder('utf-8', { fatal: true });
      expect(() => decoder.decode(bytes(0xf4, 0x90, 0x80, 0x80))).toThrow(TypeError);
    });

    test('CF-F06 the CF-A01…CF-A04 valid inputs do not throw under fatal:true and match fatal:false results', () => {
      const fatalDecoder = new Decoder('utf-8', { fatal: true });
      const nonFatalDecoder = new Decoder('utf-8', { fatal: false });
      const inputs = [
        bytes(0x48, 0x65, 0x6c, 0x6c, 0x6f),
        bytes(0xc3, 0xa9),
        bytes(0xe2, 0x82, 0xac),
        bytes(0xf0, 0x9f, 0x98, 0x80),
      ];
      for (const input of inputs) {
        const fatalOut = fatalDecoder.decode(input);
        const nonFatalOut = nonFatalDecoder.decode(input);
        expect(fatalOut).toBe(nonFatalOut);
      }
    });

    test('CF-F07 a leading BOM is still stripped under fatal:true', () => {
      const decoder = new Decoder('utf-8', { fatal: true });
      const out = decoder.decode(bytes(0xef, 0xbb, 0xbf, 0x41));
      expect(out).toBe('A');
    });
  });
});

describe('CF-X — cross-copy behavioural equivalence', () => {
  test('CF-X01 the authority and voter copies return strictly equal strings for every CF-A and CF-C input', () => {
    const corpus = [
      // CF-A
      bytes(0x48, 0x65, 0x6c, 0x6c, 0x6f),
      bytes(0xc3, 0xa9),
      bytes(0xe2, 0x82, 0xac),
      bytes(0xf0, 0x9f, 0x98, 0x80),
      new TextEncoder().encode('Hello, é€😀 world — café naïve 123'),
      new Uint8Array(),
      // CF-C
      bytes(0xff),
      bytes(0x80),
      bytes(0xc0, 0x80),
      bytes(0xc1, 0xbf),
      bytes(0xe0, 0x80, 0x80),
      bytes(0xf0, 0x80, 0x80, 0x80),
      bytes(0xed, 0xa0, 0x80),
      bytes(0xed, 0xbf, 0xbf),
      bytes(0xf4, 0x90, 0x80, 0x80),
      bytes(0xf5, 0x80, 0x80, 0x80),
      bytes(0xe2, 0x82),
      bytes(0xc3),
      bytes(0xe2, 0x82, 0x41),
      bytes(0x41, 0xff, 0x42),
    ];
    const authority = new AuthorityDecoder();
    const voter = new VoterDecoder();
    for (const input of corpus) {
      // Each decoder needs its own byte view since decode() reads by reference.
      const a = authority.decode(new Uint8Array(input));
      const v = voter.decode(new Uint8Array(input));
      expect(a).toBe(v);
    }
  });
});
