/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

// Phase 44-07 (D-02/D-04): CadreNodeProvider (real @serfab/cadre-core + @optimystic/db-p2p-
// storage-rn + libp2p transports) pulls in native-binary-backed packages this Jest RN
// environment cannot load — mocked to an inert pass-through, mirroring the authority app's
// App.test.tsx convention (39-04 precedent). VoterAppProvider uses the manual Jest mock at
// src/providers/__mocks__/VoterAppProvider.tsx (real, stateful lifecycleState/getElection/
// getBallot — RootNavigator's HomeScreen calls getElection() on mount) rather than a bare `{}`
// stand-in, since this smoke test mounts the FULL RootNavigator tree.
jest.mock('../src/providers/VoterAppProvider');
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
