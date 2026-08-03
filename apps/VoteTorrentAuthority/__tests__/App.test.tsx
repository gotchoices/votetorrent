/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

// Phase 39 plan 39-04 — the @react-navigation transformIgnorePatterns fix (jest.config.js)
// now lets Jest parse into App's real navigation tree, which imports
// react-native-vector-icons/FontAwesome6 (an ESM-only native icon-font package that is
// not resolvable under Jest). Mocked to a plain string, matching the convention already
// used across the app's screen jest tests (e.g. RevokeKeyScreen.test.tsx).
jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

// react-native-splash-view is a native TurboModule (AppProvider's hideSplash()) with no
// binary registered under the Jest RN environment — mock it inert, matching the
// FontAwesome6 native-module mock convention above.
jest.mock('react-native-splash-view', () => ({ hideSplash: jest.fn() }));

// AppProvider (real engines: Quereus-over-LevelDB via @quereus/plugin-react-native-leveldb)
// and CadreNodeProvider (real @serfab/cadre-core + @optimystic/db-p2p-storage-rn + libp2p
// transports) each pull in native-binary-backed packages this Jest RN environment cannot
// load. This "renders correctly" smoke test only needs the tree to mount without crashing —
// not a live engine/strand boot — so both providers are mocked to inert pass-throughs,
// mirroring the same convention already used by the app's screen jest tests (e.g.
// NetworksScreen.bootstrap.test.tsx mocks CadreNodeProvider/AppProvider directly).
jest.mock('../src/providers/AppProvider', () => ({
  useApp: () => ({}),
  AppProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../src/providers/CadreNodeProvider', () => ({
  useCadreNode: () => ({ node: null, syncState: 'offline', connectedPeers: () => 0 }),
  CadreNodeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import App from '../App';

test('renders correctly', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<App />);
  });
});
