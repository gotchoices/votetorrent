/**
 * RED test scaffold for SyncChip
 *
 * P2P-07: UI shows event-driven sync state (connected/syncing/offline)
 *
 * These tests import from the not-yet-existing '../../components/SyncChip' module
 * and are intentionally RED until Plan 22-03 implements the production component.
 *
 * Design invariants asserted here:
 *   - 'connected'  → renders a green wifi icon
 *   - 'syncing'    → renders an orange activity indicator icon
 *   - 'offline'    → renders a red link-slash icon
 *   - Sync state is driven by mocked useCadreNode() hook (event-driven, D-10)
 *   - No setInterval / polling (D-10 hard requirement)
 */

import React from 'react';
import renderer from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Mock useCadreNode hook before it is implemented
// The CadreNodeProvider module is also not-yet-existing — mock it as a virtual
// module so jest can resolve the path independently of the real file.
// ---------------------------------------------------------------------------

jest.mock(
  '../../providers/CadreNodeProvider',
  () => ({
    useCadreNode: jest.fn(() => ({ syncState: 'connected', node: null, connectedPeers: jest.fn() })),
  }),
  { virtual: true },
);

// Mock react-native-vector-icons (not available in jest environment)
jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

// Mock react-i18next: no i18next instance is initialized in this isolated unit
// test, so the real useTranslation would throw. The label copy is incidental to
// these assertions (which verify the icon/state mapping), so t echoes the key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Mock @react-navigation/native theme hook
jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({
    colors: {
      primary: '#007AFF',
      success: '#34C759',
      warning: '#FF9500',
      error: '#FF3B30',
      dark: '#1C1C1E',
      light: '#FFFFFF',
      accent: '#5856D6',
    },
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useCadreNode } = require('../../providers/CadreNodeProvider');

// SyncChip does not exist yet — this import is intentionally RED.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const SyncChipModule = require('../../components/SyncChip');
const SyncChip = SyncChipModule?.SyncChip ?? SyncChipModule?.default;

// ---------------------------------------------------------------------------
// P2P-07: SyncChip event-driven state mapping
// ---------------------------------------------------------------------------

// React 19's react-test-renderer only flushes the initial render — and returns a
// non-null toJSON() — when create() runs inside act(). Without it, toJSON() is null
// for ANY component. This helper wraps create() so the assertions below inspect the
// real tree (behavioral expectations are unchanged).
function renderChip(): renderer.ReactTestRenderer {
  let tr!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tr = renderer.create(<SyncChip />);
  });
  return tr;
}

describe('SyncChip — P2P-07', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders a wifi icon (connected state) when syncState is "connected"', () => {
    (useCadreNode as jest.Mock).mockReturnValue({ syncState: 'connected', node: null, connectedPeers: jest.fn() });
    const tree = renderChip().toJSON();
    const treeStr = JSON.stringify(tree);
    // Icon name should be wifi (connected state)
    expect(treeStr).toMatch(/wifi/i);
    // Should NOT have link-slash (offline icon)
    expect(treeStr).not.toMatch(/link-slash/i);
  });

  it('renders an activity-indicator style icon when syncState is "syncing"', () => {
    (useCadreNode as jest.Mock).mockReturnValue({ syncState: 'syncing', node: null, connectedPeers: jest.fn() });
    const tree = renderChip().toJSON();
    const treeStr = JSON.stringify(tree);
    // In syncing state the icon name should reference rotation/activity (e.g. 'rotate' or 'sync' or 'spinner')
    expect(treeStr).toMatch(/sync|rotate|spinner|activity/i);
  });

  it('renders a link-slash icon (offline state) when syncState is "offline"', () => {
    (useCadreNode as jest.Mock).mockReturnValue({ syncState: 'offline', node: null, connectedPeers: jest.fn() });
    const tree = renderChip().toJSON();
    const treeStr = JSON.stringify(tree);
    // 'wifi-slash' is FontAwesome6 Pro-only (renders as tofu); offline uses the free 'link-slash'.
    expect(treeStr).toMatch(/link-slash/i);
  });

  it('does not call setInterval (no polling — D-10)', () => {
    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
    (useCadreNode as jest.Mock).mockReturnValue({ syncState: 'connected', node: null, connectedPeers: jest.fn() });
    renderChip();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('uses useCadreNode hook to read syncState (not props, not polling)', () => {
    (useCadreNode as jest.Mock).mockReturnValue({ syncState: 'offline', node: null, connectedPeers: jest.fn() });
    renderChip();
    expect(useCadreNode).toHaveBeenCalled();
  });
});
