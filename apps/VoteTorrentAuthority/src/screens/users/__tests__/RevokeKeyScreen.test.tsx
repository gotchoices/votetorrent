/**
 * RevokeKeyScreen.test.tsx — UKEY-02 screen-layer per-key signing coverage.
 *
 * Backfills the automated coverage deferred in 21-15 (todo
 * sign01-ukey02-21-15-coverage / DEBT-03 D-10). The engine-side per-key binding
 * (context.UserKey = signature.signerKey) is already covered by user.spec.ts;
 * this file pins the SCREEN-layer behavior:
 *
 *   (1) handleSign previews the FIRST selected key's per-key payload
 *       (revokeKey:<firstKey>) — never a combined-keys payload.
 *   (2) handleRevoke signs EACH selected key over its own revokeKey:<key>
 *       payload and calls userEngine.revokeKey(key, perKeySignature) once per
 *       key, with a DISTINCT signature bound to that specific key — not one
 *       combined signature reused across keys. On success it navigates back.
 *
 * The signer is mocked to echo the signed payload into the signature string
 * (`sig(<utf8 payload>)`) so the test can prove each signature is bound to that
 * key's two-segment `revokeKey:<key>` payload. Uses react-test-renderer — same
 * pattern as the other screen tests in this workspace (no @testing-library).
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
const mockUserEngine = { revokeKey: mockRevokeKey };

// The device signer echoes the signed payload into the signature so the test can
// assert per-key binding: signer(utf8('revokeKey:K')) → { signature: 'sig(revokeKey:K)' }.
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

describe('RevokeKeyScreen — UKEY-02 per-key signing (screen layer)', () => {
  it('(1) handleSign previews the FIRST selected key over its own revokeKey:<key> payload', async () => {
    const tr = await render();
    await selectBothKeysAndSign(tr);

    // The preview signs exactly the first selected key's two-segment payload — once.
    expect(mockSigner).toHaveBeenCalledTimes(1);
    const signedPayload = Buffer.from(mockSigner.mock.calls[0][0]).toString('utf8');
    expect(signedPayload).toBe(`revokeKey:${KEY_A}`);

    // The "Signed: <signature>" row renders the first-key preview signature (not a combined payload).
    const rendered = JSON.stringify(tr.toJSON());
    expect(rendered).toContain(`sig(revokeKey:${KEY_A})`);
    expect(rendered).not.toContain(`${KEY_A},`); // never a combined-keys payload
  });

  it('(2) handleRevoke signs each selected key with its OWN signature and calls revokeKey once per key, then navigates back', async () => {
    const tr = await render();
    await selectBothKeysAndSign(tr);

    await renderer.act(async () => {
      await buttonByTitle(tr, 'revoke').props.onPress();
      await Promise.resolve();
    });

    // One revokeKey call per selected key.
    expect(mockRevokeKey).toHaveBeenCalledTimes(2);

    // Each call carries a signature bound to THAT key's revokeKey:<key> payload
    // (assert by key, not call order, to avoid Promise.all interleave flakiness).
    const byKey: Record<string, any> = {};
    for (const [key, sig] of mockRevokeKey.mock.calls as unknown as Array<[string, any]>) {
      byKey[key] = sig;
    }
    expect(Object.keys(byKey).sort()).toEqual([KEY_A, KEY_B].sort());
    expect(byKey[KEY_A].signature).toBe(`sig(revokeKey:${KEY_A})`);
    expect(byKey[KEY_B].signature).toBe(`sig(revokeKey:${KEY_B})`);

    // Distinct per-key signatures — not one combined signature reused across keys.
    expect(byKey[KEY_A].signature).not.toBe(byKey[KEY_B].signature);

    // Success path navigates back.
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });
});
