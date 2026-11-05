/**
 * RevokeKeyScreen.test.tsx — UKEY-02 / D-20 (49-05) screen-layer per-key signing coverage.
 *
 * Backfills the automated coverage deferred in 21-15 (todo
 * sign01-ukey02-21-15-coverage / DEBT-03 D-10). The engine-side per-key binding
 * (context.UserKey = signature.signerKey) is already covered by user.spec.ts;
 * this file pins the SCREEN-layer behavior:
 *
 *   (1) handleSign previews the FIRST selected key's canonical engine digest
 *       (via userEngine.getRevokeKeyDigest) — never a combined-keys payload,
 *       and never a screen-constructed payload (D-03/D-20, 49-05).
 *   (2) handleRevoke signs EACH selected key over its own engine-computed
 *       digest and calls userEngine.revokeKey(key, perKeySignature) once per
 *       key, with a DISTINCT signature bound to that specific key — not one
 *       combined signature reused across keys. On success it navigates back.
 *
 * The mock `getRevokeKeyDigest` returns a per-key deterministic digest
 * (`digest(<key>)` utf8-encoded) and the signer echoes the signed bytes into
 * the signature string (`sig(<utf8 digest>)`), so the test can prove each
 * signature is bound to that key's OWN engine-supplied digest — never a
 * screen-side `revokeKey:<key>` construction (that convention was retired in
 * 49-05). Uses react-test-renderer — same pattern as the other screen tests
 * in this workspace (no @testing-library).
 */

import React from 'react';
import { TouchableOpacity } from 'react-native';
import renderer from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Mutable module-level slots (prefixed `mock` so jest.mock factories may
// reference them — the jest babel transform allows `mock*` variable access).
// ---------------------------------------------------------------------------
const KEY_A = 'keyAAA000';
const KEY_B = 'keyBBB111';
let mockUser: any = null;
const mockRevokeKey = jest.fn(async () => {});
// 49-05 (D-20): deterministic per-key digest standing in for the engine's
// real Digest(UserId, PubKey) — distinct per key so distinct-signature
// assertions stay meaningful.
const mockGetRevokeKeyDigest = jest.fn(async (key: string) => Buffer.from(`digest(${key})`, 'utf8'));
const mockUserEngine = { revokeKey: mockRevokeKey, getRevokeKeyDigest: mockGetRevokeKeyDigest };

// The device signer echoes the signed digest bytes into the signature so the test can
// assert per-key binding: signer(utf8('digest(K)')) → { signature: 'sig(digest(K))' }.
const mockSigner = jest.fn(async (bytes: Uint8Array) => {
  const payload = Buffer.from(bytes).toString('utf8');
  return {
    signature: `sig(${payload})`,
    signerKey: 'device-pub-key',
    signerUserId: 'user-1',
  };
});

const mockGoBack = jest.fn();

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// CustomTextInput consumes useSettings(); SettingsProvider uses AsyncStorage
// (null native module under jest), so mock it out.
jest.mock('../../../providers/SettingsProvider', () => ({
  useSettings: () => ({ showHelpIcons: false }),
}));

// Device signer / device user — real implementations touch the native keystore.
jest.mock('../../../engines/device-signer', () => ({
  createDeviceSigner: jest.fn(async () => mockSigner),
}));
jest.mock('../../../engines/device-user', () => ({
  // Subject must equal the screen's user so the WR-02 self-revoke guard passes.
  getOrCreateDeviceUser: jest.fn(async () => ({ id: mockUser.id, name: mockUser.name })),
}));

jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({
    colors: {
      primary: '#007AFF',
      background: '#FFFFFF',
      card: '#F2F2F7',
      text: '#000000',
      border: '#C6C6C8',
      notification: '#FF3B30',
      error: '#FF3B30',
      textSecondary: '#888888',
      important: '#FF9500',
      success: '#34C759',
      accent: '#5856D6',
      warning: '#FF9500',
      light: '#FFFFFF',
      dark: '#000000',
    },
  }),
  useRoute: () => ({ params: { user: mockUser, userEngine: mockUserEngine } }),
  useNavigation: () => ({ goBack: mockGoBack, navigate: jest.fn(), setOptions: jest.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const RevokeKeyModule = require('../RevokeKeyScreen');
const RevokeKeyScreen = RevokeKeyModule.default ?? RevokeKeyModule.RevokeKeyScreen;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeUser() {
  return {
    id: 'user-1',
    name: 'Test User',
    activeKeys: [
      { key: KEY_A, type: undefined, expiration: 1893456000000 },
      { key: KEY_B, type: undefined, expiration: 1893456000000 },
    ],
  };
}

async function render() {
  let tr!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tr = renderer.create(<RevokeKeyScreen />);
  });
  return tr;
}

/** Key-row toggles are raw TouchableOpacity with onPress and NO `disabled` prop
 *  (CustomButton always passes an explicit `disabled`, so those are excluded). */
function keyToggles(tr: renderer.ReactTestRenderer) {
  return tr.root.findAll(
    (n) => n.type === TouchableOpacity && typeof n.props.onPress === 'function' && n.props.disabled === undefined,
  );
}

/** CustomButton is located by the (i18n-echoed) title it was given. */
function buttonByTitle(tr: renderer.ReactTestRenderer, title: string) {
  return tr.root.findAll((n) => n.props?.title === title && typeof n.props?.onPress === 'function')[0];
}

/** The single confirm CustomTextInput (title echoes the i18n key). */
function confirmInput(tr: renderer.ReactTestRenderer) {
  return tr.root.findAll(
    (n) => n.props?.title === 'typeIConfirm' && typeof n.props?.onChangeText === 'function',
  )[0];
}

async function selectBothKeysAndSign(tr: renderer.ReactTestRenderer) {
  // Select both keys (insertion order KEY_A, KEY_B → firstKey = KEY_A).
  const toggles = keyToggles(tr);
  expect(toggles).toHaveLength(2);
  for (const toggle of toggles) {
    await renderer.act(async () => {
      toggle.props.onPress();
    });
  }
  // Type the confirmation phrase (t('iConfirm') === 'iConfirm' under the echo mock).
  await renderer.act(async () => {
    confirmInput(tr).props.onChangeText('iConfirm');
  });
  // Sign.
  await renderer.act(async () => {
    await buttonByTitle(tr, 'sign').props.onPress();
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = makeUser();
});

describe('RevokeKeyScreen — UKEY-02 / D-20 (49-05) per-key signing (screen layer)', () => {
  it('(1) handleSign previews the FIRST selected key over its OWN engine-computed digest', async () => {
    const tr = await render();
    await selectBothKeysAndSign(tr);

    // The screen fetches the canonical digest from the engine — never constructs it itself.
    expect(mockGetRevokeKeyDigest).toHaveBeenCalledWith(KEY_A);

    // The preview signs exactly the first selected key's digest — once.
    expect(mockSigner).toHaveBeenCalledTimes(1);
    const signedPayload = Buffer.from(mockSigner.mock.calls[0][0]).toString('utf8');
    expect(signedPayload).toBe(`digest(${KEY_A})`);

    // The "Signed: <signature>" row renders the first-key preview signature (not a combined payload).
    const rendered = JSON.stringify(tr.toJSON());
    expect(rendered).toContain(`sig(digest(${KEY_A}))`);
    expect(rendered).not.toContain(`${KEY_A},`); // never a combined-keys payload
  });

  it('(2) handleRevoke signs each selected key with its OWN engine-computed digest and calls revokeKey once per key, then navigates back', async () => {
    const tr = await render();
    await selectBothKeysAndSign(tr);

    await renderer.act(async () => {
      await buttonByTitle(tr, 'revoke').props.onPress();
      await Promise.resolve();
    });

    // One revokeKey call per selected key, fed by one getRevokeKeyDigest call per key
    // (plus the earlier preview call for KEY_A during handleSign).
    expect(mockRevokeKey).toHaveBeenCalledTimes(2);
    expect(mockGetRevokeKeyDigest).toHaveBeenCalledWith(KEY_A);
    expect(mockGetRevokeKeyDigest).toHaveBeenCalledWith(KEY_B);

    // Each call carries a signature bound to THAT key's OWN engine digest
    // (assert by key, not call order, to avoid Promise.all interleave flakiness).
    const byKey: Record<string, any> = {};
    for (const [key, sig] of mockRevokeKey.mock.calls as unknown as Array<[string, any]>) {
      byKey[key] = sig;
    }
    expect(Object.keys(byKey).sort()).toEqual([KEY_A, KEY_B].sort());
    expect(byKey[KEY_A].signature).toBe(`sig(digest(${KEY_A}))`);
    expect(byKey[KEY_B].signature).toBe(`sig(digest(${KEY_B}))`);

    // Distinct per-key signatures — not one combined signature reused across keys.
    expect(byKey[KEY_A].signature).not.toBe(byKey[KEY_B].signature);

    // Success path navigates back.
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('(3) a DeleteValid CHECK rejection renders the revokeKeySignatureInvalid copy, not the raw engine error', async () => {
    mockRevokeKey.mockRejectedValueOnce(
      new Error('Quereus error (code 275): CHECK constraint failed: DeleteValid'),
    );
    const tr = await render();
    await selectBothKeysAndSign(tr);

    await renderer.act(async () => {
      await buttonByTitle(tr, 'revoke').props.onPress();
      await Promise.resolve();
    });

    const rendered = JSON.stringify(tr.toJSON());
    // `t` is mocked as the identity function, so the i18n KEY itself is what renders.
    expect(rendered).toContain('revokeKeySignatureInvalid');
    expect(rendered).not.toContain('CHECK constraint failed');
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('(4) every OTHER revokeKey failure renders translated generic copy, never the raw engine message', async () => {
    mockRevokeKey.mockRejectedValueOnce(new Error('UserEngine.revokeKey: no EngineContext bound'));
    const tr = await render();
    await selectBothKeysAndSign(tr);

    await renderer.act(async () => {
      await buttonByTitle(tr, 'revoke').props.onPress();
      await Promise.resolve();
    });

    const rendered = JSON.stringify(tr.toJSON());
    expect(rendered).toContain('errorActionFailedGeneric');
    expect(rendered).not.toContain('no EngineContext bound');
    expect(rendered).not.toContain('revokeKeySignatureInvalid');
  });
});
