/**
 * Behavioral tests for useCurrentOfficerScopes — D-10 / T-46-03.
 *
 * Pins these invariants:
 *   1. `loading` is true and `scopes` undefined before the walk resolves.
 *   2. A matching officer's scopes are returned IN FULL, and `loading` goes false.
 *   3. No matching officer yields `undefined`, NOT `[]` — this is a user-visible
 *      distinction bound to a different i18n banner key
 *      (`registrationPolicyReadOnlyNoOfficerBanner`) than the matching-officer,
 *      missing-scope case (`registrationPolicyReadOnlyBanner`). Tests 3 and 4
 *      must NOT be merged into one assertion.
 *   4. A matching officer with zero scopes yields `[]`, NOT `undefined`.
 *   5. The hook is scope-agnostic (D-10 / Phase 47 reuse contract): a matching
 *      officer whose scopes contain no `'mel'` at all still round-trips those
 *      scopes unfiltered.
 *   6. A failing walk resolves to `undefined` with `loading` false (fails closed
 *      to read-only, never hangs).
 *   7. Unmount before resolution does not setState (CR-02 guard).
 *
 * Approach mirrors useTaskCount.test.tsx:
 *   - Render a minimal host component that exposes both fields via testIDs on
 *     Text nodes so we can read them from the tree.
 *   - Mock AppProvider (useApp / getEngine) and engines/device-user
 *     (getOrCreateDeviceUser) at module scope.
 *   - Control async resolution via deferred Promises resolved inside act().
 *
 * Libraries used: react-test-renderer (present) + standard Jest mocks. Neither
 * of the react-hooks/react-native testing-library packages is installed in this
 * app, and neither is used here.
 * The hook uses a plain effect, not a focus-triggered re-fetch, so
 * @react-navigation/native is NOT mocked here — there is nothing from it to stub.
 */

import React from 'react';
import { Text } from 'react-native';
import renderer from 'react-test-renderer';
import type { Scope } from '@votetorrent/vote-core';

// ---------------------------------------------------------------------------
// Mocks — must be at module scope (jest hoists jest.mock calls).
// ---------------------------------------------------------------------------

const mockGetEngine = jest.fn();
const mockOpenAuthority = jest.fn();
const mockGetAdminDetails = jest.fn();
const mockGetOrCreateDeviceUser = jest.fn();

jest.mock('../../providers/AppProvider', () => ({
  useApp: () => ({ getEngine: mockGetEngine }),
}));

// Required, not optional (per plan): the real module reaches AsyncStorage,
// @noble/curves, and globalThis.crypto.randomUUID(), none of which should be
// exercised by this hook-level suite.
jest.mock('../../engines/device-user', () => ({
  getOrCreateDeviceUser: mockGetOrCreateDeviceUser,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useCurrentOfficerScopes } = require('../useCurrentOfficerScopes');

// ---------------------------------------------------------------------------
// Host component: renders both result fields as text so we can read them.
// ---------------------------------------------------------------------------

function scopesSentinel(scopes: Scope[] | undefined): string {
  if (scopes === undefined) return 'UNDEFINED';
  if (scopes.length === 0) return 'EMPTY';
  return scopes.join(',');
}

function ScopesDisplay({ authorityId }: { authorityId: string }) {
  const { scopes, loading } = useCurrentOfficerScopes(authorityId);
  return (
    <>
      <Text testID="scopes">{scopesSentinel(scopes)}</Text>
      <Text testID="loading">{String(loading)}</Text>
    </>
  );
}

function readScopes(tr: renderer.ReactTestRenderer): string {
  return tr.root.findByProps({ testID: 'scopes' }).props.children as string;
}

function readLoading(tr: renderer.ReactTestRenderer): string {
  return tr.root.findByProps({ testID: 'loading' }).props.children as string;
}

// ---------------------------------------------------------------------------
// Setup: reset all mocks and wire the default 3-hop chain before each test.
// ---------------------------------------------------------------------------
beforeEach(() => {
  jest.clearAllMocks();

  mockGetOrCreateDeviceUser.mockResolvedValue({ id: 'device-user-1', name: 'Device User' });

  mockGetEngine.mockImplementation(async (engineName: string) => {
    if (engineName === 'network') return { openAuthority: mockOpenAuthority };
    return undefined;
  });

  mockOpenAuthority.mockImplementation(async () => ({ getAdminDetails: mockGetAdminDetails }));

  // Default: no officers at all (overridden per-test).
  mockGetAdminDetails.mockResolvedValue({ admin: { officers: [] } });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useCurrentOfficerScopes — D-10 / T-46-03', () => {
  it('loading is true and scopes undefined before the walk resolves', async () => {
    // Hold getAdminDetails pending so the walk never settles during this test.
    let resolveAdminDetails!: (v: unknown) => void;
    mockGetAdminDetails.mockImplementation(
      () => new Promise((res) => { resolveAdminDetails = res; })
    );

    let tr!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tr = renderer.create(<ScopesDisplay authorityId="auth-1" />);
    });

    // This is the invariant 46-08 depends on to avoid flashing the
    // "not an officer" banner during load.
    expect(readLoading(tr)).toBe('true');
    expect(readScopes(tr)).toBe('UNDEFINED');

    // Avoid an unresolved-promise leak into the next test.
    await renderer.act(async () => {
      resolveAdminDetails({ admin: { officers: [] } });
      await Promise.resolve();
    });
  });

  it("a matching officer's scopes are returned in full, and loading goes false", async () => {
    mockGetAdminDetails.mockResolvedValue({
      admin: {
        officers: [
          { userId: 'device-user-1', authorityId: 'auth-1', title: 'Chair', scopes: ['mel', 'ceb'] },
        ],
      },
    });

    let tr!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tr = renderer.create(<ScopesDisplay authorityId="auth-1" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readScopes(tr)).toBe('mel,ceb');
    expect(readLoading(tr)).toBe('false');
  });

  it('no matching officer yields undefined, NOT [] (D-10 / UI-SPEC two-banner contract)', async () => {
    mockGetAdminDetails.mockResolvedValue({
      admin: {
        officers: [
          { userId: 'some-other-user', authorityId: 'auth-1', title: 'Chair', scopes: ['mel'] },
        ],
      },
    });

    let tr!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tr = renderer.create(<ScopesDisplay authorityId="auth-1" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    // No matching Officer row for this device -> undefined. This is what drives
    // registrationPolicyReadOnlyNoOfficerBanner rather than
    // registrationPolicyReadOnlyBanner (which needs a matching officer that
    // merely lacks the required scope).
    expect(readScopes(tr)).toBe('UNDEFINED');
  });

  it('a matching officer with zero scopes yields [], NOT undefined', async () => {
    mockGetAdminDetails.mockResolvedValue({
      admin: {
        officers: [
          { userId: 'device-user-1', authorityId: 'auth-1', title: 'Chair', scopes: [] },
        ],
      },
    });

    let tr!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tr = renderer.create(<ScopesDisplay authorityId="auth-1" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Together with the previous test, this forbids any future normalisation
    // that would collapse the missing-officer and zero-scope-officer cases.
    expect(readScopes(tr)).toBe('EMPTY');
  });

  it('is scope-agnostic: a matching officer holding only [\'vrg\'] round-trips unfiltered (Phase 47 reuse contract)', async () => {
    mockGetAdminDetails.mockResolvedValue({
      admin: {
        officers: [
          { userId: 'device-user-1', authorityId: 'auth-1', title: 'Registrar', scopes: ['vrg'] },
        ],
      },
    });

    let tr!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tr = renderer.create(<ScopesDisplay authorityId="auth-1" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    // The hook must report the array unfiltered — a 'mel'-specific implementation
    // would return [] or undefined here and fail. This is the D-10 guarantee that
    // Phase 47 needs for 'vrg'/'cap' without touching this hook's source.
    expect(readScopes(tr)).toBe('vrg');
  });

  describe('S1: officer standing survives key replacement (UAT 62 gap 5)', () => {
    async function scopesForPersistedDevice(options?: { userId?: string }) {
      const actual = jest.requireActual('../../engines/device-user') as {
        persistProvisionedDeviceUser: (n: string, k: string, o?: { userId?: string }) => Promise<{ id: string; name: string }>;
      };
      const persisted = await actual.persistProvisionedDeviceUser('Una', 'ab'.repeat(33), options);
      mockGetOrCreateDeviceUser.mockResolvedValue(persisted);
      mockGetAdminDetails.mockResolvedValue({
        admin: { officers: [{ userId: 'net-user-1', authorityId: 'auth-1', title: 'Registrar', scopes: ['vrg'] }] },
      });
      let tr!: renderer.ReactTestRenderer;
      await renderer.act(async () => {
        tr = renderer.create(<ScopesDisplay authorityId="auth-1" />);
        await Promise.resolve();
        await Promise.resolve();
      });
      return readScopes(tr);
    }

    it('a device user persisted with the kept network id finds the officer', async () => {
      expect(await scopesForPersistedDevice({ userId: 'net-user-1' })).toBe('vrg');
    });

    it('a device user persisted with a minted id does not (documents the old failure)', async () => {
      expect(await scopesForPersistedDevice()).toBe('UNDEFINED');
    });
  });

  it('a failing walk resolves to undefined with loading false', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetAdminDetails.mockRejectedValue(new Error('network not established'));

    let tr!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tr = renderer.create(<ScopesDisplay authorityId="auth-1" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Fails closed to read-only rather than hanging in a loading state.
    expect(readScopes(tr)).toBe('UNDEFINED');
    expect(readLoading(tr)).toBe('false');

    warnSpy.mockRestore();
  });

  it('does NOT setState after unmount (CR-02 guard)', async () => {
    let resolveAdminDetails!: (v: unknown) => void;
    const latePromise = new Promise((res) => { resolveAdminDetails = res; });
    mockGetAdminDetails.mockImplementation(() => latePromise);

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    let tr!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tr = renderer.create(<ScopesDisplay authorityId="auth-1" />);
    });

    expect(readLoading(tr)).toBe('true');

    // Unmount BEFORE the walk resolves.
    await renderer.act(async () => {
      tr.unmount();
    });

    // Now resolve — the cancelled flag should prevent setScopes/setLoading from firing.
    await renderer.act(async () => {
      resolveAdminDetails({
        admin: { officers: [{ userId: 'device-user-1', authorityId: 'auth-1', title: 'Chair', scopes: ['mel'] }] },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const unmountedWarning = errorSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === 'string' && a.toLowerCase().includes('unmounted'))
    );
    expect(unmountedWarning).toBe(false);

    errorSpy.mockRestore();
  });

  it('H1: refresh() re-runs the officer lookup', async () => {
    let refresh!: () => void;
    function Host() {
      refresh = useCurrentOfficerScopes('auth-1').refresh;
      return null;
    }
    await renderer.act(async () => {
      renderer.create(<Host />);
    });
    expect(mockGetAdminDetails).toHaveBeenCalledTimes(1);
    await renderer.act(async () => {
      refresh();
    });
    expect(mockGetAdminDetails).toHaveBeenCalledTimes(2);
  });
});
