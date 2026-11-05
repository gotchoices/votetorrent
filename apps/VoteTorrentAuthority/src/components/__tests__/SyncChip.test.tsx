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
 *   - D-14 (56-10): a non-null configFault takes precedence over syncState —
 *     asserted below in the "configFault precedence" describe block.
 */

import React from 'react';
import renderer from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Mock useCadreNode.
//
// This mock was authored (Phase 22) when CadreNodeProvider did not yet exist, so
// it was declared `virtual`. The module exists now, which makes that flag stale —
// and load-bearing in a way it was never meant to be: if the mock is ever missed,
// the REAL provider loads and drags in @optimystic/db-p2p-storage-rn, an ESM-only
// package whose `exports` map has no `require` condition. Jest's CJS resolver then
// fails the whole suite with "Cannot find module", which reproduced only in
// full-suite runs (never when this file ran alone) and so read as flakiness.
//
// The provider mock below is kept, and the ESM-only leaf is ALSO stubbed, matching
// CadreNodeProvider.test.tsx's convention. Either one alone would do; both together
// mean this suite cannot fail that way regardless of which modules a given run has
// already loaded.
// ---------------------------------------------------------------------------

jest.mock('../../providers/CadreNodeProvider', () => ({
  useCadreNode: jest.fn(() => ({ syncState: 'connected', configFault: null, node: null, connectedPeers: jest.fn() })),
}));

// ESM-only ("type": "module", exports map exposes only an `import` condition) and
// native-backed respectively — neither can load under the react-native jest preset.
jest.mock(
  '@optimystic/db-p2p-storage-rn',
  () => ({
    openOptimysticRNDb: jest.fn(() => ({})),
    loadOrCreateRNPeerKey: jest.fn(async () => ({})),
    LevelDBRawStorage: class {},
  }),
  { virtual: true },
);
jest.mock(
  'rn-leveldb',
  () => ({ LevelDB: class {}, LevelDBWriteBatch: class {} }),
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

  it('renders a wifi icon (connected state) when syncState is "connected" (configFault: null, non-regression)', () => {
    (useCadreNode as jest.Mock).mockReturnValue({ syncState: 'connected', configFault: null, node: null, connectedPeers: jest.fn() });
    const tree = renderChip().toJSON();
    const treeStr = JSON.stringify(tree);
    // Icon name should be wifi (connected state)
    expect(treeStr).toMatch(/wifi/i);
    // Should NOT have link-slash (offline icon)
    expect(treeStr).not.toMatch(/link-slash/i);
  });

  it('renders an activity-indicator style icon when syncState is "syncing" (configFault: null, non-regression)', () => {
    (useCadreNode as jest.Mock).mockReturnValue({ syncState: 'syncing', configFault: null, node: null, connectedPeers: jest.fn() });
    const tree = renderChip().toJSON();
    const treeStr = JSON.stringify(tree);
    // In syncing state the icon name should reference rotation/activity (e.g. 'rotate' or 'sync' or 'spinner')
    expect(treeStr).toMatch(/sync|rotate|spinner|activity/i);
  });

  it('renders a link-slash icon (offline state) when syncState is "offline" (configFault: null, non-regression)', () => {
    (useCadreNode as jest.Mock).mockReturnValue({ syncState: 'offline', configFault: null, node: null, connectedPeers: jest.fn() });
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
    (useCadreNode as jest.Mock).mockReturnValue({ syncState: 'offline', configFault: null, node: null, connectedPeers: jest.fn() });
    renderChip();
    expect(useCadreNode).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// D-14 (56-10): configFault takes precedence over syncState.
// ---------------------------------------------------------------------------
describe('SyncChip — configFault precedence (D-14)', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the not-configured presentation when configFault is non-null, even when syncState is "connected"', () => {
    (useCadreNode as jest.Mock).mockReturnValue({
      syncState: 'connected',
      configFault: { kind: 'missing', reason: 'empty-address-list' },
      node: null,
      connectedPeers: jest.fn(),
    });
    const tree = renderChip().toJSON();
    const treeStr = JSON.stringify(tree);
    expect(treeStr).toMatch(/triangle-exclamation/i);
    // Fault beats sync state — the 'connected' presentation must NOT leak through.
    expect(treeStr).not.toMatch(/"wifi"/);
  });

  it('renders the not-configured presentation for every syncState value when configFault is non-null', () => {
    for (const syncState of ['connected', 'syncing', 'offline'] as const) {
      (useCadreNode as jest.Mock).mockReturnValue({
        syncState,
        configFault: { kind: 'malformed', reason: 'invalid-address' },
        node: null,
        connectedPeers: jest.fn(),
      });
      const tree = renderChip().toJSON();
      expect(JSON.stringify(tree)).toMatch(/triangle-exclamation/i);
    }
  });

  it('the rendered label contains no digits and no phase/decision markers', () => {
    (useCadreNode as jest.Mock).mockReturnValue({
      syncState: 'offline',
      configFault: { kind: 'missing', reason: 'no-config-document' },
      node: null,
      connectedPeers: jest.fn(),
    });
    const tree = renderChip().toJSON();
    // Extract the label TEXT NODE specifically, not the whole serialized tree
    // (which also carries numeric style values like fontSize/size — a whole-
    // tree digit scan would false-positive on those). The chip is [icon, Text];
    // the Text node's children is the array of rendered text content.
    const treeNode = tree as unknown as { children: Array<{ type: string; children: string[] }> };
    const textNode = treeNode.children.find((child) => child.type === 'Text');
    const label = textNode?.children?.join('') ?? '';
    // The mocked react-i18next `t` echoes the key verbatim (t('syncNotConfigured')
    // -> 'syncNotConfigured'), so this proves the CORRECT key is wired, and the
    // key name itself carries no digits or phase/decision markers.
    expect(label).toBe('syncNotConfigured');
    expect(label).not.toMatch(/\d/);
    expect(label).not.toMatch(/Phase|D-1|56/);
  });

  it('carries a redundant textual cue (the label text node), not colour alone', () => {
    (useCadreNode as jest.Mock).mockReturnValue({
      syncState: 'offline',
      configFault: { kind: 'missing', reason: 'no-address-list' },
      node: null,
      connectedPeers: jest.fn(),
    });
    const tree = renderChip().toJSON();
    // ThemedText renders as a native Text host node whose child is the label
    // string — this asserts the actual text node is present, not merely that
    // the icon glyph name shows up in the serialized tree.
    const treeStr = JSON.stringify(tree);
    expect(treeStr).toContain('syncNotConfigured');
  });
});
