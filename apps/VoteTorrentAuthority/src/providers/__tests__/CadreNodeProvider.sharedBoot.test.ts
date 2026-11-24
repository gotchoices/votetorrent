// One option set and one boot sequence for both apps and the CLI (@votetorrent/workflows buildCadreNodeOptions /
// bootCadreNode); a second copy in this provider would drift as the lean rig's two copies did.
import * as fs from 'fs';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-var-requires */
const shared = require('@votetorrent/workflows') as Record<string, unknown>;
const recoveryBinding = require('../../engines/control-schema-recovery') as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

const PROVIDER_PATH = path.resolve(__dirname, '..', 'CadreNodeProvider.tsx');

/** Full-line comments removed (//, /*, *), so a rationale comment can never satisfy or trip a count. */
function strippedProviderSource(): string {
  return fs
    .readFileSync(PROVIDER_PATH, 'utf8')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'));
    })
    .join('\n');
}

const count = (src: string, needle: string): number => src.split(needle).length - 1;

describe('CadreNodeProvider shares the one node boot', () => {
  it('SB-A1: the engines/control-schema-recovery binding is the shared predicate by identity', () => {
    expect(typeof shared.isUnrestorableControlSchemaError).toBe('function');
    expect(recoveryBinding.isUnrestorableControlSchemaError).toBe(shared.isUnrestorableControlSchemaError);
  });

  it('SB-A2: the provider builds its options and boots only through the shared functions, with no option block or start of its own', () => {
    const src = strippedProviderSource();
    for (const needle of ['buildCadreNodeOptions(', 'bootCadreNode(', "role: 'authority'", 'partyId: PARTY_ID', 'shouldHost: () => isMounted']) {
      expect({ needle, present: src.includes(needle) }).toEqual({ needle, present: true });
    }
    for (const needle of [
      'network: {',
      'requireSignedSchemas',
      'strandFilter',
      'hibernation',
      'strandReactivity',
      'strandCohortRefusal:',
      'controlCohortRefusal:',
      'edgeReaderProtocol',
      'isUnrestorableControlSchemaError',
      'reanchorOwnKey(',
      'hostPoolRendezvous(',
      '.start()',
    ]) {
      expect({ needle, count: count(src, needle) }).toEqual({ needle, count: 0 });
    }
  });

  it('SB-A3: the app keeps its own party constant, exactly once', () => {
    expect(count(strippedProviderSource(), "const PARTY_ID = 'votetorrent';")).toBe(1);
  });
});
