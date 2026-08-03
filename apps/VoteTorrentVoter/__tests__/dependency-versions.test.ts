/**
 * @format
 *
 * Phase 39 plan 39-01 (D-18) — version-parity guard.
 *
 * Asserts the navigation + vector-icon dependency delta installed in this app
 * resolves to the exact same versions installed in VoteTorrentAuthority, and
 * that react-native-screens honors the root `resolutions` pin (4.10.0).
 * Reads both apps' `node_modules/<pkg>/package.json` `version` fields at test
 * time so the guard stays correct across future lockstep version bumps.
 */

const path = require('path');

function resolvedVersion(appDir: string, pkg: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkgJson = require(path.join(appDir, 'node_modules', pkg, 'package.json'));
  return pkgJson.version;
}

const VOTING_APP_DIR = path.resolve(__dirname, '..');
const AUTHORITY_APP_DIR = path.resolve(__dirname, '..', '..', 'VoteTorrentAuthority');

const PARITY_PACKAGES = [
  '@react-navigation/native-stack',
  '@react-navigation/bottom-tabs',
  'react-native-safe-area-context',
  'react-native-vector-icons',
  '@types/react-native-vector-icons',
];

describe('dependency version parity (D-18)', () => {
  it('pins react-native-screens to 4.10.0 (root resolutions pin)', () => {
    expect(resolvedVersion(VOTING_APP_DIR, 'react-native-screens')).toBe('4.10.0');
  });

  it.each(PARITY_PACKAGES)(
    '%s resolves to the same version as VoteTorrentAuthority',
    (pkg) => {
      const votingVersion = resolvedVersion(VOTING_APP_DIR, pkg);
      const authorityVersion = resolvedVersion(AUTHORITY_APP_DIR, pkg);
      expect(votingVersion).toBe(authorityVersion);
    },
  );
});
