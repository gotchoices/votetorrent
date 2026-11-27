import { publishSelfRecordAfterEnrol } from '../publish-self-record';
import type { SelfRegistrationOutcome } from '@serfab/cadre-core';

jest.mock('@serfab/cadre-core', () => ({}), { virtual: true });

// A fake node whose registerSelf() plays back a script of outcomes (an Error entry throws).
function scriptedNode(script: Array<SelfRegistrationOutcome | Error>) {
  let i = 0;
  const registerSelf = jest.fn(async (): Promise<SelfRegistrationOutcome> => {
    const step = script[Math.min(i++, script.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  });
  return { registerSelf };
}

describe('publishSelfRecordAfterEnrol', () => {
  it('returns on the first real write without retrying', async () => {
    const node = scriptedNode(['refreshed']);
    const r = await publishSelfRecordAfterEnrol(node, { intervalMs: 1, timeoutMs: 1000 });
    expect(r).toMatchObject({ published: true, outcome: 'refreshed', attempts: 1 });
    expect(node.registerSelf).toHaveBeenCalledTimes(1);
  });

  // The cadre-core gap itself: the owner's row has not replicated to the phone yet, so
  // registerSelf() skips — the helper must keep going until the row lands.
  it('retries through skipped until the owner row lands', async () => {
    const node = scriptedNode(['skipped', 'skipped', 'refreshed']);
    const r = await publishSelfRecordAfterEnrol(node, { intervalMs: 1, timeoutMs: 1000 });
    expect(r).toMatchObject({ published: true, outcome: 'refreshed', attempts: 3 });
  });

  it('treats inserted as published', async () => {
    const node = scriptedNode(['inserted']);
    const r = await publishSelfRecordAfterEnrol(node, { intervalMs: 1, timeoutMs: 1000 });
    expect(r).toMatchObject({ published: true, outcome: 'inserted' });
  });

  it('retries after a throw instead of giving up', async () => {
    const node = scriptedNode([new Error('control write not ready'), 'refreshed']);
    const r = await publishSelfRecordAfterEnrol(node, { intervalMs: 1, timeoutMs: 1000 });
    expect(r).toMatchObject({ published: true, outcome: 'refreshed', attempts: 2 });
    expect(r.lastError).toBeUndefined();
  });

  it('gives up at the budget, reporting the last outcome, and never throws', async () => {
    const node = scriptedNode(['skipped']);
    const r = await publishSelfRecordAfterEnrol(node, { intervalMs: 20, timeoutMs: 100 });
    expect(r.published).toBe(false);
    expect(r.outcome).toBe('skipped');
    expect(r.attempts).toBeGreaterThan(1);
    expect(r.elapsedMs).toBeLessThanOrEqual(150);
  });

  it('reports the error when the last attempt threw', async () => {
    const err = new Error('still failing');
    const node = scriptedNode([err]);
    const r = await publishSelfRecordAfterEnrol(node, { intervalMs: 20, timeoutMs: 60 });
    expect(r).toMatchObject({ published: false, outcome: 'error' });
    expect(r.lastError).toBe(err);
  });

  it('stops when aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const node = scriptedNode(['skipped']);
    const r = await publishSelfRecordAfterEnrol(node, { intervalMs: 1000, timeoutMs: 60_000, signal: ac.signal });
    expect(r).toMatchObject({ published: false, attempts: 1 });
  });
});
