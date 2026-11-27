/**
 * KeyholderScreen.dkgStatus.test.tsx — Phase 62 Plan 26 (D-19 UI). `driveKeyholderDkg` is mocked
 * (keeping the real `keyholderDkgRowState` via `jest.requireActual`), and `useFocusEffect` is
 * mocked to invoke its callback once (the `SettingsScreen` convention for this app's own
 * `useFocusEffect` screens).
 */

import React from 'react';
import renderer from 'react-test-renderer';

const mockDriveKeyholderDkg = jest.fn();
const focusCallbacks: Array<() => void | (() => void)> = [];
const focusCleanups: Array<void | (() => void)> = [];

jest.mock('../keyholder-dkg-driver', () => {
  const actual = jest.requireActual('../keyholder-dkg-driver');
  return {
    ...actual,
    driveKeyholderDkg: (...args: unknown[]) => mockDriveKeyholderDkg(...args),
  };
});

const mockGetElectionDetails = jest.fn(async () => ({ election: { id: 'election-1' } }));
const mockElectionEngine = { getElectionDetails: mockGetElectionDetails };

const mockGetEngine = jest.fn(async () => undefined);

jest.mock('../../../providers/AppProvider', () => ({
  useApp: () => ({ getEngine: mockGetEngine }),
}));

jest.mock('../../../engines/keyholder-vault', () => ({
  resolveKeyholderKeyVault: () => ({}),
}));

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let mockRouteParams: { keyholder: { invite: { name: string }; result?: { invokedId: string; isAccepted?: boolean } }; electionEngine: typeof mockElectionEngine };

const mockSetOptions = jest.fn();
const mockNavigate = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({
    colors: { accent: '#ACCENT0', textSecondary: '#888888', success: '#00FF00', warning: '#FFA500', error: '#FF0000' },
  }),
  useRoute: () => ({ params: mockRouteParams }),
  useNavigation: () => ({ navigate: mockNavigate, setOptions: mockSetOptions }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const React = require('react');
    React.useEffect(() => {
      focusCallbacks.push(callback);
      const c = callback();
      focusCleanups.push(c);
      return c;
    }, []);
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const KeyholderScreenModule = require('../KeyholderScreen');
const KeyholderScreen = KeyholderScreenModule.default ?? KeyholderScreenModule.KeyholderScreen;

async function render() {
  let tr!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tr = renderer.create(<KeyholderScreen />);
  });
  await renderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return tr;
}

function hasTestID(tr: renderer.ReactTestRenderer, testID: string): boolean {
  return tr.root.findAll((n) => n.props?.testID === testID).length > 0;
}

/** Walks up from `instance` to the nearest ancestor whose host type is `'View'`. */
function nearestViewAncestor(instance: renderer.ReactTestInstance): renderer.ReactTestInstance {
  let node: renderer.ReactTestInstance | null = instance.parent;
  while (node && (node.type as unknown) !== 'View') {
    node = node.parent;
  }
  if (!node) throw new Error('nearestViewAncestor: no View ancestor found');
  return node;
}

beforeEach(() => {
  jest.clearAllMocks();
  focusCallbacks.length = 0;
  focusCleanups.length = 0;
  mockGetElectionDetails.mockResolvedValue({ election: { id: 'election-1' } });
  mockRouteParams = {
    keyholder: { invite: { name: 'Alice' }, result: { invokedId: 'user-1' } },
    electionEngine: mockElectionEngine,
  };
});

describe('KeyholderScreen — DKG status wiring (62-26)', () => {
  it('K1 position: the complaint row shares its SECTION ancestor with the two detail rows, not with the Invite button', async () => {
    mockDriveKeyholderDkg.mockResolvedValue({ status: { phase: 'restarting', self: { isDisqualified: false } }, advanced: false, actions: [] });
    const tr = await render();

    const statusRow = tr.root.findByProps({ testID: 'keyholder-dkg-status-row' });
    const inviteButton = tr.root.findAll((n) => n.props?.title === 'invite')[0];
    expect(inviteButton).toBeTruthy();

    // The status detail row's grandparent is the first `section` View. The status row must live
    // in THAT SAME subtree, and that subtree must NOT contain the Invite button.
    const typeLabelText = tr.root.findAll(
      (n) => (n.type as unknown) === 'Text' && Array.isArray(n.props?.children) && n.props.children[0] === 'keyholderStatusLabel'
    )[0];
    expect(typeLabelText).toBeTruthy();
    const detailRow = nearestViewAncestor(typeLabelText); // the `styles.detail` row View
    const firstSection = nearestViewAncestor(detailRow); // the `styles.section` View

    expect(firstSection.findAll((n) => n === statusRow)).toHaveLength(1);
    expect(firstSection.findAll((n) => n.props?.title === 'invite')).toHaveLength(0);
  });

  it('K2 drive key: electionId comes from getElectionDetails, and invokedId from keyholder.result', async () => {
    mockDriveKeyholderDkg.mockResolvedValue({ status: { phase: 'in-progress', self: { isDisqualified: false } }, advanced: false, actions: [] });
    await render();

    expect(mockDriveKeyholderDkg).toHaveBeenCalledWith(expect.anything(), 'election-1', 'user-1');
  });

  it('K2b: a keyholder with no result passes undefined as the driver userId', async () => {
    mockRouteParams.keyholder = { invite: { name: 'Bob' } };
    mockDriveKeyholderDkg.mockResolvedValue({ status: { phase: 'not-started', self: undefined }, advanced: false, actions: [] });
    await render();

    expect(mockDriveKeyholderDkg).toHaveBeenCalledWith(expect.anything(), 'election-1', undefined);
  });

  it('K3a: an authDenied driver outcome renders deviceSigningErrorGeneric and keeps the status row', async () => {
    mockDriveKeyholderDkg.mockResolvedValue({
      status: { phase: 'in-progress', self: { isDisqualified: false } },
      advanced: false,
      actions: [],
      error: { code: 'auth-denied', authDenied: true },
    });
    const tr = await render();

    expect(JSON.stringify(tr.toJSON())).toContain('deviceSigningErrorGeneric');
    expect(hasTestID(tr, 'keyholder-dkg-status-inProgress')).toBe(true);
  });

  it('K3b: a non-auth driver error renders catalog copy, never engine or vault text', async () => {
    mockDriveKeyholderDkg.mockResolvedValue({
      status: null,
      advanced: false,
      actions: [],
      error: { code: 'x', authDenied: false, message: 'vault alias foo' },
    });
    const tr = await render();

    expect(JSON.stringify(tr.toJSON())).not.toContain('vault alias foo');
    expect(JSON.stringify(tr.toJSON())).toContain('keyholderDkgError');
    expect(hasTestID(tr, 'keyholder-dkg-status-row')).toBe(false);
  });

  it('K3c: a peer-unavailable code renders the peer write copy', async () => {
    mockDriveKeyholderDkg.mockResolvedValue({ status: null, advanced: false, actions: [], error: { code: 'peer-unavailable', authDenied: false } });
    const tr = await render();
    expect(JSON.stringify(tr.toJSON())).toContain('peerWriteUnavailable');
  });

  it('K6: a rejected election read leaves loading and shows keyholderDkgLoadError', async () => {
    mockGetElectionDetails.mockRejectedValue(new Error('vault alias foo'));
    const tr = await render();
    expect(hasTestID(tr, 'keyholder-dkg-status-row')).toBe(false);
    const json = JSON.stringify(tr.toJSON());
    expect(json).toContain('keyholderDkgLoadError');
    expect(json).not.toContain('vault alias foo');
  });

  it('K7: a drive result that completes after a blur and re-focus is applied', async () => {
    let resolveDriver!: (value: unknown) => void;
    mockDriveKeyholderDkg.mockImplementationOnce(() => new Promise((resolve) => { resolveDriver = resolve; }));
    const tr = await render();
    expect(hasTestID(tr, 'keyholder-dkg-status-loading')).toBe(true);
    // simulate blur (cleanup) + re-focus while the first drive is still in flight
    await renderer.act(async () => {
      focusCleanups.forEach((c) => c && c());
      focusCallbacks.forEach((cb) => cb());
    });
    await renderer.act(async () => {
      resolveDriver({ status: { phase: 'complete', self: { isDisqualified: false } }, advanced: false, actions: [] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hasTestID(tr, 'keyholder-dkg-status-complete')).toBe(true);
  });

  it('a keyholder with no name reads the catalog name, not a literal', async () => {
    mockRouteParams.keyholder = { invite: undefined } as never;
    mockDriveKeyholderDkg.mockResolvedValue({ status: { phase: 'blocked', self: undefined }, advanced: false, actions: [] });
    const tr = await render();
    expect(JSON.stringify(tr.toJSON())).toContain('keyholderUnnamed');
  });

  it('K4 unmount: unmounting before the driver settles produces no post-unmount state update', async () => {
    let resolveDriver!: (value: unknown) => void;
    mockDriveKeyholderDkg.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDriver = resolve;
        })
    );
    let tr!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tr = renderer.create(<KeyholderScreen />);
    });

    renderer.act(() => {
      tr.unmount();
    });

    // Resolving AFTER unmount must not throw or warn — the effect's `active` flag guards it.
    await renderer.act(async () => {
      resolveDriver({ status: { phase: 'complete', self: { isDisqualified: false } }, advanced: false, actions: [] });
      await Promise.resolve();
    });
  });

  it('K5 failed: a driver status with phase failed renders keyholder-dkg-status-failed, not complaint', async () => {
    mockDriveKeyholderDkg.mockResolvedValue({ status: { phase: 'failed', self: { isDisqualified: false } }, advanced: false, actions: [] });
    const tr = await render();

    expect(hasTestID(tr, 'keyholder-dkg-status-failed')).toBe(true);
    expect(hasTestID(tr, 'keyholder-dkg-status-complaint')).toBe(false);
  });
});

describe('KeyholderScreen — invite status line (UAT 62 M)', () => {
  function statusText(tr: renderer.ReactTestRenderer): string {
    return tr.root.findAll((n) => n.props?.testID === 'keyholder-invite-status' && typeof n.props?.children === 'string')[0].props.children;
  }

  beforeEach(() => {
    mockDriveKeyholderDkg.mockResolvedValue({ status: { phase: 'blocked', threshold: 2, self: undefined }, advanced: false, actions: [] });
  });

  it('labels the line Status (never Type) and reads accepted for a keyholder with an accepted result', async () => {
    mockRouteParams.keyholder = { invite: { name: 'Alice' }, result: { isAccepted: true, invokedId: 'user-1' } } as never;
    const tr = await render();
    const labels = tr.root.findAll((n) => (n.type as unknown) === 'Text' && Array.isArray(n.props?.children)).map((n) => n.props.children[0]);
    expect(labels).toContain('keyholderStatusLabel');
    expect(labels).not.toContain('type');
    expect(statusText(tr)).toBe('accepted');
  });

  it('a keyholder with no result reads not-sent', async () => {
    mockRouteParams.keyholder = { invite: { name: 'Bob' } };
    const tr = await render();
    expect(statusText(tr)).toBe('keyholderStatusNotSent');
  });

  it('on focus, swaps in the fresh engine keyholder: an accept since the card was tapped reads accepted and drives the DKG as that user', async () => {
    mockRouteParams.keyholder = { invite: { name: 'Bob' } };
    mockGetElectionDetails.mockResolvedValue({
      election: { id: 'election-1' },
      current: { keyholders: [{ invite: { name: 'Bob' }, result: { isAccepted: true, invokedId: 'user-bob' } }] },
    } as never);
    const tr = await render();
    expect(statusText(tr)).toBe('accepted');
    expect(mockDriveKeyholderDkg).toHaveBeenCalledWith(expect.anything(), 'election-1', 'user-bob');
  });

  it('a 1-of-1 policy shows the threshold-too-low DKG copy, not "waiting for other keyholders"', async () => {
    mockDriveKeyholderDkg.mockResolvedValue({ status: { phase: 'blocked', blockedReason: 'threshold-out-of-range', threshold: 1, self: undefined }, advanced: false, actions: [] });
    const tr = await render();
    expect(hasTestID(tr, 'keyholder-dkg-status-thresholdTooLow')).toBe(true);
    expect(hasTestID(tr, 'keyholder-dkg-status-pending')).toBe(false);
  });
});
