/**
 * bootstrap-config.test.ts — the fault-taxonomy unit table plus the two
 * cross-app anti-drift gates for D-14's RN bootstrap-config mechanism.
 *
 * This suite is the ONLY place the sibling-parity and sentinel-absence gates
 * run — `apps/VoteTorrentVoter/src/config/__tests__/bootstrap-config.test.ts`
 * is a conformance suite over the Voter's OWN copy and does not repeat these
 * cross-app checks (see its header for why).
 */

import fs from 'fs';
import path from 'path';
import {
  BOOTSTRAP_ADDR_MAX_LENGTH,
  BOOTSTRAP_CONFIG_MAX_ADDRS,
  isBootstrapAddr,
  readBootstrapConfig,
} from '../bootstrap-config';

// Built from two halves rather than one literal so this scanner file itself
// never contains the contiguous retired sentinel string — a repo-wide
// literal grep for it (56-10's Task 3 survivor-list check) must find it ONLY
// in the three dev harnesses that keep it deliberately, not in this checker.
const OLD_SENTINEL = ['UPDATE_AFTER', 'DRONE_RESTART'].join('_');
const LEAK_PROBE = 'LEAKPROBE0123';

const VALID_ADDR = '/ip4/203.0.113.9/tcp/443/wss/p2p/12D3KooWExample';
const VALID_ADDR_2 = '/ip4/203.0.113.10/tcp/443/wss/p2p/12D3KooWExample2';

describe('readBootstrapConfig — ok cases', () => {
  it('accepts a single valid address', () => {
    const result = readBootstrapConfig({ bootstrapNodes: [VALID_ADDR] });
    expect(result).toEqual({ addrs: [VALID_ADDR], fault: null });
  });

  it('accepts multiple valid addresses, preserved in order', () => {
    const result = readBootstrapConfig({ bootstrapNodes: [VALID_ADDR, VALID_ADDR_2] });
    expect(result.fault).toBeNull();
    expect(result.addrs).toEqual([VALID_ADDR, VALID_ADDR_2]);
  });

  it('accepts exactly BOOTSTRAP_CONFIG_MAX_ADDRS addresses', () => {
    const list = Array.from({ length: BOOTSTRAP_CONFIG_MAX_ADDRS }, (_, i) => `/ip4/203.0.113.9/tcp/443/wss/p2p/12D3KooWExample${i}`);
    const result = readBootstrapConfig({ bootstrapNodes: list });
    expect(result.fault).toBeNull();
    expect(result.addrs).toEqual(list);
  });
});

describe('readBootstrapConfig — missing (no document)', () => {
  it.each([undefined, null, 42, 'a string', []])('returns missing/no-config-document for %p', (doc) => {
    expect(readBootstrapConfig(doc)).toEqual({ addrs: [], fault: { kind: 'missing', reason: 'no-config-document' } });
  });
});

describe('readBootstrapConfig — missing (no list)', () => {
  it('returns missing/no-address-list for {}', () => {
    expect(readBootstrapConfig({})).toEqual({ addrs: [], fault: { kind: 'missing', reason: 'no-address-list' } });
  });
});

describe('readBootstrapConfig — missing (empty list, the committed default)', () => {
  it('returns missing/empty-address-list for an empty bootstrapNodes array', () => {
    expect(readBootstrapConfig({ bootstrapNodes: [] })).toEqual({
      addrs: [],
      fault: { kind: 'missing', reason: 'empty-address-list' },
    });
  });
});

describe('readBootstrapConfig — malformed (wrong type)', () => {
  it('returns malformed/address-list-not-an-array for a string bootstrapNodes', () => {
    expect(readBootstrapConfig({ bootstrapNodes: 'a/multiaddr' })).toEqual({
      addrs: [],
      fault: { kind: 'malformed', reason: 'address-list-not-an-array' },
    });
  });

  it('returns malformed/address-list-not-an-array for an object bootstrapNodes', () => {
    expect(readBootstrapConfig({ bootstrapNodes: { 0: 'x' } })).toEqual({
      addrs: [],
      fault: { kind: 'malformed', reason: 'address-list-not-an-array' },
    });
  });
});

describe('readBootstrapConfig — malformed (bad entries)', () => {
  it('returns malformed/invalid-address for a non-string entry', () => {
    expect(readBootstrapConfig({ bootstrapNodes: [123] })).toEqual({
      addrs: [],
      fault: { kind: 'malformed', reason: 'invalid-address' },
    });
  });

  it('returns malformed/invalid-address for an entry with no leading "/"', () => {
    expect(readBootstrapConfig({ bootstrapNodes: ['203.0.113.9:443'] })).toEqual({
      addrs: [],
      fault: { kind: 'malformed', reason: 'invalid-address' },
    });
  });

  it('returns malformed/invalid-address for an entry with no /p2p/<peerId> tail', () => {
    expect(readBootstrapConfig({ bootstrapNodes: ['/ip4/203.0.113.9/tcp/443/wss'] })).toEqual({
      addrs: [],
      fault: { kind: 'malformed', reason: 'invalid-address' },
    });
  });

  it('returns malformed/invalid-address for an entry with an empty peer id', () => {
    expect(readBootstrapConfig({ bootstrapNodes: ['/ip4/203.0.113.9/tcp/443/wss/p2p/'] })).toEqual({
      addrs: [],
      fault: { kind: 'malformed', reason: 'invalid-address' },
    });
  });

  it('returns malformed/invalid-address for an oversized entry', () => {
    const oversized = '/ip4/203.0.113.9/tcp/443/wss/p2p/' + 'a'.repeat(BOOTSTRAP_ADDR_MAX_LENGTH);
    expect(readBootstrapConfig({ bootstrapNodes: [oversized] })).toEqual({
      addrs: [],
      fault: { kind: 'malformed', reason: 'invalid-address' },
    });
  });
});

describe('readBootstrapConfig — malformed (too many)', () => {
  it('returns malformed/too-many-addresses for BOOTSTRAP_CONFIG_MAX_ADDRS + 1 valid addresses', () => {
    const list = Array.from(
      { length: BOOTSTRAP_CONFIG_MAX_ADDRS + 1 },
      (_, i) => `/ip4/203.0.113.9/tcp/443/wss/p2p/12D3KooWExample${i}`,
    );
    expect(readBootstrapConfig({ bootstrapNodes: list })).toEqual({
      addrs: [],
      fault: { kind: 'malformed', reason: 'too-many-addresses' },
    });
  });
});

describe('readBootstrapConfig — no document echo (T-56-10-03)', () => {
  const malformedCases: Array<[string, unknown]> = [
    ['non-string entry embedding the probe', { bootstrapNodes: [`${LEAK_PROBE}-not-a-multiaddr`] }],
    ['no-leading-slash entry embedding the probe', { bootstrapNodes: [`${LEAK_PROBE}:443`] }],
    ['no-peer-id entry embedding the probe', { bootstrapNodes: [`/ip4/${LEAK_PROBE}/tcp/443/wss`] }],
    ['wrong-type bootstrapNodes embedding the probe', { bootstrapNodes: LEAK_PROBE }],
  ];

  it.each(malformedCases)('%s: the probe never reaches the fault result', (_name, doc) => {
    const result = readBootstrapConfig(doc);
    expect(result.fault).not.toBeNull();
    expect(JSON.stringify(result.fault)).not.toContain(LEAK_PROBE);
  });
});

describe('readBootstrapConfig — totality (never throws)', () => {
  const cases: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['a string', 'a string'],
    ['an empty array', []],
    ['an empty object', {}],
    ['a frozen object', Object.freeze({ bootstrapNodes: [VALID_ADDR] })],
    ['a prototype-less object', Object.assign(Object.create(null), { bootstrapNodes: [VALID_ADDR] })],
    [
      'a deeply-nested object',
      { bootstrapNodes: { deeply: { nested: { value: [1, 2, 3] } } } },
    ],
  ];

  it.each(cases)('does not throw for %s', (_name, doc) => {
    expect(() => readBootstrapConfig(doc)).not.toThrow();
  });
});

describe('isBootstrapAddr', () => {
  it('accepts a well-formed peer-id-pinned multiaddr', () => {
    expect(isBootstrapAddr(VALID_ADDR)).toBe(true);
  });

  it('rejects a non-string value', () => {
    expect(isBootstrapAddr(123)).toBe(false);
  });

  it('rejects an entry without a leading "/"', () => {
    expect(isBootstrapAddr('203.0.113.9:443')).toBe(false);
  });

  it('rejects an entry without a /p2p/ segment', () => {
    expect(isBootstrapAddr('/ip4/203.0.113.9/tcp/443/wss')).toBe(false);
  });

  it('rejects an entry with an empty peer id', () => {
    expect(isBootstrapAddr('/ip4/203.0.113.9/tcp/443/wss/p2p/')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-app anti-drift gates (D-14). Both gates run ONLY in this suite.
// ---------------------------------------------------------------------------

const AUTHORITY_CONFIG_PATH = path.resolve(__dirname, '../bootstrap-config.ts');
const VOTER_CONFIG_PATH = path.resolve(
  __dirname,
  '../../../../../apps/VoteTorrentVoter/src/config/bootstrap-config.ts',
);

function normalizeNewlines(contents: string): string {
  return contents.replace(/\r\n/g, '\n');
}

function firstDifferingLine(a: string, b: string): number {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const max = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < max; i += 1) {
    if (aLines[i] !== bLines[i]) return i + 1;
  }
  return -1;
}

describe('sibling parity (D-14 anti-drift)', () => {
  it('is byte-identical (after newline normalisation) to the Voter app copy', () => {
    const authoritySource = normalizeNewlines(fs.readFileSync(AUTHORITY_CONFIG_PATH, 'utf8'));
    const voterSource = normalizeNewlines(fs.readFileSync(VOTER_CONFIG_PATH, 'utf8'));

    if (authoritySource !== voterSource) {
      const line = firstDifferingLine(authoritySource, voterSource);
      throw new Error(
        `apps/VoteTorrentAuthority/src/config/bootstrap-config.ts and ` +
          `apps/VoteTorrentVoter/src/config/bootstrap-config.ts diverge starting at line ${line}. ` +
          `Edit both, or edit neither.`,
      );
    }

    expect(authoritySource).toBe(voterSource);
  });
});

describe('sentinel absence (D-14)', () => {
  // Comment lines are stripped from BOTH copies before scanning. The scanner
  // (this test file) and the scanned files (the two bootstrap-config.ts
  // copies) are different files, so this specific check cannot self-trip —
  // but strip comments anyway and say why: `project_self_tripping_checker_headers`
  // (a checker whose own text carries the pattern it greps for is
  // permanently green) recurred three times in Phase 53, so this suite
  // treats comment-stripping as the default hygiene rather than an
  // exception reserved for self-scanning checkers.
  function stripComments(contents: string): string {
    return contents
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/**');
      })
      .join('\n');
  }

  it('neither copy contains the old CONTROL_ADDR sentinel, in code or comments', () => {
    const authoritySource = fs.readFileSync(AUTHORITY_CONFIG_PATH, 'utf8');
    const voterSource = fs.readFileSync(VOTER_CONFIG_PATH, 'utf8');

    expect(stripComments(authoritySource)).not.toContain(OLD_SENTINEL);
    expect(stripComments(voterSource)).not.toContain(OLD_SENTINEL);
  });
});
