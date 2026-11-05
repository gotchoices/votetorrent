/**
 * hermes-abort-reason.test.js — spike 092 guard for polyfills/hermes-abort-reason.js.
 *
 * Lives in the Authority app ONLY and also reads the Voter's copies, on the same
 * reasoning as polyfill-drift.test.js (a second copy of a drift guard needs its own guard).
 *
 * Behaviour is exercised against the REAL `abort-controller@3.0.0` that React Native 0.78
 * installs (Libraries/Core/setUpXHR.js), not against Node's native AbortController, which
 * already has `reason`. Under Node the module is correctly inert, so a test against the
 * native globals would pass whether or not the arm works.
 */

const fs = require('fs');
const path = require('path');

const AUTHORITY_MODULE = path.resolve(__dirname, '../hermes-abort-reason.js');
const VOTER_MODULE = path.resolve(__dirname, '../../../VoteTorrentVoter/polyfills/hermes-abort-reason.js');
const BOOTSTRAPS = [
  ['Authority', path.resolve(__dirname, '../../polyfills.bootstrap.js')],
  ['Voter', path.resolve(__dirname, '../../../VoteTorrentVoter/polyfills.bootstrap.js')],
];
const REQUIRE_LINE = "require('./polyfills/hermes-abort-reason')";

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n');
}

/**
 * Install RN's abort-controller as the globals, run `fn`, and restore Node's natives.
 * With `withModule`, the polyfill is evaluated against those globals first.
 */
function withRnAbortController(withModule, fn) {
  const saved = { AbortController: globalThis.AbortController, AbortSignal: globalThis.AbortSignal };
  try {
    jest.isolateModules(() => {
      const ac = require('abort-controller/dist/abort-controller');
      globalThis.AbortController = ac.AbortController;
      globalThis.AbortSignal = ac.AbortSignal;
      if (withModule) require('../hermes-abort-reason');
    });
    return fn();
  } finally {
    globalThis.AbortController = saved.AbortController;
    globalThis.AbortSignal = saved.AbortSignal;
  }
}

describe('hermes-abort-reason (spike 092)', () => {
  it('both apps carry byte-identical copies', () => {
    const a = fs.readFileSync(AUTHORITY_MODULE, 'utf8');
    expect(a.length).toBeGreaterThan(1500);
    expect(fs.readFileSync(VOTER_MODULE, 'utf8')).toBe(a);
  });

  it.each(BOOTSTRAPS)('%s bootstrap requires it after the DOMException arm and before AbortSignal.timeout', (_label, file) => {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const at = src.indexOf(REQUIRE_LINE);
    expect(at).toBeGreaterThan(-1);
    expect(src.indexOf("typeof globalThis.DOMException === 'undefined'")).toBeLessThan(at);
    expect(src.indexOf('AbortSignal.timeout = function')).toBeGreaterThan(at);
  });

  it('NEGATIVE CONTROL: RN abort-controller drops the reason without the module', () => {
    withRnAbortController(false, () => {
      const c = new AbortController();
      c.abort(new Error('cause'));
      expect(c.signal.aborted).toBe(true);
      expect(c.signal.reason).toBeUndefined(); // what libp2p's raceSignal rejects with
      expect(typeof AbortSignal.any).toBe('undefined');
    });
  });

  it('preserves an explicit reason, and defaults to an AbortError when none is given', () => {
    withRnAbortController(true, () => {
      const cause = new Error('upgrade aborted');
      const c = new AbortController();
      c.abort(cause);
      expect(c.signal.reason).toBe(cause);

      const d = new AbortController();
      d.abort();
      // Name, not instanceof: jest's Node realm supplies a native DOMException, which is not
      // `instanceof Error` there. Callers branch on `name`, so that is the contract.
      expect(d.signal.reason).toBeDefined();
      expect(d.signal.reason.name).toBe('AbortError');
    });
  });

  it('keeps the FIRST reason when abort is called twice', () => {
    withRnAbortController(true, () => {
      const first = new Error('first');
      const c = new AbortController();
      c.abort(first);
      c.abort(new Error('second'));
      expect(c.signal.reason).toBe(first);
    });
  });

  it('still fires abort listeners (delegates to the original abort)', () => {
    withRnAbortController(true, () => {
      const c = new AbortController();
      const seen = [];
      c.signal.addEventListener('abort', () => seen.push(c.signal.reason));
      const cause = new Error('x');
      c.abort(cause);
      expect(seen).toEqual([cause]);
    });
  });

  it('AbortSignal.any settles with the first input reason and detaches from the rest', () => {
    withRnAbortController(true, () => {
      const never = new AbortController();
      const soon = new AbortController();
      const combined = AbortSignal.any([never.signal, soon.signal]);
      expect(combined.aborted).toBe(false);
      const cause = new Error('soon');
      soon.abort(cause);
      expect(combined.aborted).toBe(true);
      expect(combined.reason).toBe(cause);

      // An input that is already aborted settles the result immediately.
      const pre = new AbortController();
      pre.abort(cause);
      expect(AbortSignal.any([never.signal, pre.signal]).reason).toBe(cause);
    });
  });
});
