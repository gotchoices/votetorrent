/**
 * hermes-structured-clone.test.js — guard for polyfills/hermes-structured-clone.js, the
 * structuredClone arm adopted verbatim from `@serfab/cadre-rn` 1.19.0 (gotchoices/sereus#51).
 *
 * Lives in the Authority suite only and checks the Voter's copy too, for the reason
 * polyfill-drift.test.js gives. Four things:
 *   1. both apps carry byte-identical copies;
 *   2. the body still matches the installed kit's arm, so a kit bump that changes the arm fails
 *      here until the file is re-copied (the copy is never patched locally);
 *   3. both bootstraps install it in place of the bare @ungap/structured-clone they used before;
 *   4. what it returns: Node's own structuredClone is the reference for every type the fast path
 *      copies, and ungap's result for a graph the fast path gives up on.
 *
 * Node has a native structuredClone, so the module is evaluated with the global removed and the
 * native one restored in `finally`.
 */

const fs = require('fs');
const path = require('path');

const AUTHORITY_MODULE = path.resolve(__dirname, '../hermes-structured-clone.js');
const VOTER_MODULE = path.resolve(__dirname, '../../../VoteTorrentVoter/polyfills/hermes-structured-clone.js');
const KIT_HERMES = path.resolve(__dirname, '../../node_modules/@serfab/cadre-rn/polyfills/hermes.js');
const BOOTSTRAPS = [
  ['Authority', path.resolve(__dirname, '../../polyfills.bootstrap.js')],
  ['Voter', path.resolve(__dirname, '../../../VoteTorrentVoter/polyfills.bootstrap.js')],
];

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n');
}

/** The kit's structuredClone arm as this repo adopts it: its registry call dropped. */
function kitArm() {
  // The kit publishes hermes.js with CRLF line endings; this repo's copy is LF.
  const kit = fs.readFileSync(KIT_HERMES, 'utf8').replace(/\r\n/g, '\n');
  const start = kit.indexOf('// ── structuredClone');
  const end = kit.indexOf('// ── Symbol.asyncIterator');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return kit.slice(start, end).trimEnd().replace("\tmarkPolyfilled('structuredClone');\n", '') + '\n';
}

const nativeClone = globalThis.structuredClone;

/** Evaluate the polyfill with no global structuredClone; return what it installed. */
function loadPolyfill() {
  let installed;
  try {
    delete globalThis.structuredClone;
    jest.isolateModules(() => {
      require('../hermes-structured-clone');
    });
    installed = globalThis.structuredClone;
  } finally {
    globalThis.structuredClone = nativeClone;
  }
  return installed;
}

describe('hermes-structured-clone (sereus#51)', () => {
  it('both apps carry byte-identical copies', () => {
    const authority = fs.readFileSync(AUTHORITY_MODULE, 'utf8');
    expect(authority.length).toBeGreaterThan(3000);
    expect(fs.readFileSync(VOTER_MODULE, 'utf8')).toBe(authority);
  });

  it("still matches the installed kit's arm (re-copy on a kit bump; never patch locally)", () => {
    const ours = fs.readFileSync(AUTHORITY_MODULE, 'utf8');
    const body = ours.slice(ours.indexOf('// ── structuredClone'));
    expect(body).toBe(kitArm());
  });

  it.each(BOOTSTRAPS)('%s polyfills.bootstrap.js installs it instead of a bare ungap', (_label, file) => {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    expect(src).toContain("require('./polyfills/hermes-structured-clone');");
    expect(src).not.toContain("require('@ungap/structured-clone')");
  });

  it('copies plain data exactly as the native structuredClone does', () => {
    const clone = loadPolyfill();
    expect(typeof clone).toBe('function');
    expect(clone).not.toBe(nativeClone);
    const backing = new Uint8Array([9, 1, 2, 3, 4, 9]);
    const block = {
      header: { id: 'blk-1', type: 'chain', collectionId: 'Election' },
      entries: [{ key: 'a', value: 1 }, { key: 'b', value: null }, { key: 'c', value: [true, 'x', 2.5] }],
      bytes: backing.subarray(1, 5),
      when: new Date(1761700000000),
      re: /ab+c/gi,
      sparse: [1, , 3], // eslint-disable-line no-sparse-arrays
    };
    const copy = clone(block);
    // Node's structuredClone builds its result in Node's realm, not jest's, so compare a
    // realm-free rendering of it.
    const reference = nativeClone(block);
    const render = v => JSON.stringify(v, (_k, x) => (ArrayBuffer.isView(x) ? Array.from(x) : Object.prototype.toString.call(x) === '[object RegExp]' ? String(x) : x));
    expect(render(copy)).toBe(render(reference));
    expect(copy).not.toBe(block);
    expect(copy.entries[2]).not.toBe(block.entries[2]);
    expect(copy.when.getTime()).toBe(block.when.getTime());
    expect(copy.re.source).toBe('ab+c');
    expect(copy.re.flags).toBe('gi');
    expect(copy.bytes.byteOffset).toBe(reference.bytes.byteOffset);
    expect(copy.bytes.buffer.byteLength).toBe(reference.bytes.buffer.byteLength);
    expect(1 in copy.sparse).toBe(false);
    backing[2] = 77;
    expect(Array.from(copy.bytes)).toEqual([1, 2, 3, 4]);
  });

  it('copies Map and Set entries, keys included', () => {
    const clone = loadPolyfill();
    const key = { k: 1 };
    const map = new Map([[key, { v: [1, 2] }], ['s', 'x']]);
    const set = new Set([key, 'two']);
    const copy = clone({ map, set });
    expect(copy.map).toBeInstanceOf(Map);
    expect(copy.set).toBeInstanceOf(Set);
    const [[k1, v1], [k2, v2]] = [...copy.map];
    expect(k1).toEqual({ k: 1 });
    expect(k1).not.toBe(key);
    expect(v1).toEqual({ v: [1, 2] });
    expect([k2, v2]).toEqual(['s', 'x']);
    // One source object, one copy, wherever it appears in the graph.
    expect([...copy.set][0]).toBe(k1);
  });

  it('keeps shared references shared and closes cycles', () => {
    const clone = loadPolyfill();
    const shared = { n: 1 };
    const graph = { a: shared, b: shared, list: [shared] };
    graph.self = graph;
    const copy = clone(graph);
    expect(copy.a).toBe(copy.b);
    expect(copy.list[0]).toBe(copy.a);
    expect(copy.self).toBe(copy);
    expect(copy.a).not.toBe(shared);
  });

  it('hands a graph it does not copy to ungap, whole, as before', () => {
    const clone = loadPolyfill();
    const ungap = require('@ungap/structured-clone').default;
    class Point { constructor() { this.x = 1; this.y = [2]; } }
    const value = { p: new Point(), err: new Error('boom') };
    expect(clone(value)).toEqual(ungap(value));
    expect(() => clone({ f() {} })).toThrow();
    // A call with options goes to ungap too.
    expect(clone({ a: 1 }, { transfer: [] })).toEqual({ a: 1 });
  });

  it('leaves an existing structuredClone alone', () => {
    const existing = () => 'native';
    try {
      globalThis.structuredClone = existing;
      jest.isolateModules(() => {
        require('../hermes-structured-clone');
      });
      expect(globalThis.structuredClone).toBe(existing);
    } finally {
      globalThis.structuredClone = nativeClone;
    }
  });
});
