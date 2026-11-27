/**
 * bootstrap-config.test.ts — conformance suite over the Voter app's OWN copy
 * of the D-14 bootstrap-config module.
 *
 * Purpose: without this file, a `yarn workspace votetorrent-voter jest`
 * run never exercises the Voter's `src/config/bootstrap-config.ts` at all —
 * the full fault-taxonomy table and the sibling-parity / sentinel-absence
 * anti-drift gates live in the Authority app's suite
 * (`apps/VoteTorrentAuthority/src/config/__tests__/bootstrap-config.test.ts`),
 * which reads BOTH copies from disk but only runs under the Authority
 * workspace. This suite exists so the Voter workspace's own test run proves
 * its own module works, independently of whether anyone ever runs the
 * Authority suite. Do not delete this as "redundant" with the Authority
 * suite — it is not redundant, it is the only coverage this workspace has.
 */

import { readBootstrapConfig } from '../bootstrap-config';

const VALID_ADDR = '/ip4/203.0.113.9/tcp/443/wss/p2p/12D3KooWExample';
const LEAK_PROBE = 'LEAKPROBE0123';

describe('readBootstrapConfig (Voter conformance)', () => {
  it('ok: accepts a valid address', () => {
    expect(readBootstrapConfig({ bootstrapNodes: [VALID_ADDR] })).toEqual({
      addrs: [VALID_ADDR],
      fault: null,
    });
  });

  it('missing: reports empty-address-list for the committed empty default', () => {
    expect(readBootstrapConfig({ bootstrapNodes: [] })).toEqual({
      addrs: [],
      fault: { kind: 'missing', reason: 'empty-address-list' },
    });
  });

  it('malformed: reports invalid-address for an entry with no /p2p/<peerId> tail', () => {
    expect(readBootstrapConfig({ bootstrapNodes: ['/ip4/203.0.113.9/tcp/443/wss'] })).toEqual({
      addrs: [],
      fault: { kind: 'malformed', reason: 'invalid-address' },
    });
  });

  it('no document echo: a malformed entry carrying a recognisable probe never reaches the fault result', () => {
    const result = readBootstrapConfig({ bootstrapNodes: [`/ip4/${LEAK_PROBE}/tcp/443/wss`] });
    expect(result.fault).not.toBeNull();
    expect(JSON.stringify(result.fault)).not.toContain(LEAK_PROBE);
  });
});
